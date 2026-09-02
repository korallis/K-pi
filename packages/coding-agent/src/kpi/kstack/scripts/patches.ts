import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertNoSymlinkedParent, confinePath, findPatchDebris, TreeError } from "./tree.ts";

const exec = promisify(execFile);

/** How git is run. Injected so a test can prove git was never invoked. */
export type GitRunner = (args: readonly string[], options: { cwd: string }) => Promise<unknown>;

const realGit: GitRunner = (args, options) => exec("git", [...args], { cwd: options.cwd });

export class PatchError extends Error {
	/** Patch file the failure belongs to, so the report names it. */
	readonly patch: string;
	/** 1-based line of the offending header, when the failure has one. */
	readonly line?: number;

	constructor(patch: string, message: string, line?: number) {
		super(line === undefined ? `${patch}: ${message}` : `${patch}:${line}: ${message}`);
		this.name = "PatchError";
		this.patch = patch;
		this.line = line;
	}
}

/**
 * A path as it may appear in a patch header, and nothing else.
 *
 * Canonical means unquoted, no backslash, no whitespace, no control character,
 * relative, POSIX separators, and no `.`, `..` or empty segment. Everything git
 * additionally accepts - C-quoted names, octal escapes, embedded tabs - is
 * refused rather than decoded, because a name this parser cannot state exactly is
 * a name whose confinement it cannot prove, and git decodes it later regardless.
 */
const CANONICAL_SEGMENT = /^[^\s"\\/\u0000-\u001f\u007f]+$/u;

export function parseCanonicalPath(value: string): string {
	if (value.length === 0) {
		throw new TreeError("header names an empty path");
	}
	if (value.includes('"')) {
		throw new TreeError(`header names a quoted path, which is not canonical: ${value}`);
	}
	if (value.includes("\\")) {
		throw new TreeError(`header names an escaped or backslash path: ${value}`);
	}
	if (/[\s\u0000-\u001f\u007f]/u.test(value)) {
		throw new TreeError(`header names a path containing whitespace or a control character: ${value}`);
	}
	if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
		throw new TreeError(`header names an absolute path: ${value}`);
	}
	for (const segment of value.split("/")) {
		if (segment.length === 0 || segment === "." || segment === "..") {
			throw new TreeError(`header names a path with a traversal or empty segment: ${value}`);
		}
		if (!CANONICAL_SEGMENT.test(segment)) {
			throw new TreeError(`header names a path segment that is not canonical: ${value}`);
		}
	}
	return value;
}

/** Strips the `a/` or `b/` prefix git puts on both sides of a diff. */
function stripSide(value: string): string | undefined {
	if (value === "/dev/null") {
		return undefined;
	}
	// The quote check comes first so a C-quoted name is always reported as what it
	// is, rather than as a missing `a/` prefix.
	if (value.includes('"')) {
		throw new TreeError(`header names a quoted path, which is not canonical: ${value}`);
	}
	if (!/^[ab]\//u.test(value)) {
		throw new TreeError(`header side is not prefixed with a/ or b/: ${value}`);
	}
	return parseCanonicalPath(value.slice(2));
}

/** Headers that carry a path and must therefore be parsed, never skipped. */
const PATH_BEARING = ["diff --git ", "--- ", "+++ ", "rename from ", "rename to ", "copy from ", "copy to "] as const;

/** Shapes whose paths cannot be stated unambiguously, so they are refused. */
const REFUSED_HEADERS: readonly { readonly prefix: string; readonly why: string }[] = [
	{ prefix: "diff --cc ", why: "a combined diff names more than one parent and no single target" },
	{ prefix: "diff --combined ", why: "a combined diff names more than one parent and no single target" },
	{ prefix: "Binary files ", why: "a `Binary files ... differ` header cannot be split into two paths unambiguously" },
	{
		prefix: "GIT binary patch",
		why: "a binary patch carries no reviewable text; binary content comes from the pinned tree",
	},
	{ prefix: "diff ", why: "only `diff --git` headers are understood" },
];

interface HunkState {
	minus: number;
	plus: number;
}

/**
 * Every path a patch would touch, or a refusal.
 *
 * Total by construction. The scan is a state machine rather than a set of line
 * patterns, because `+++ b/x` is a header outside a hunk and an added line inside
 * one: without tracking hunks a parser either misses a real header or rejects a
 * legitimate body. Outside a hunk, any line beginning with a path-bearing prefix
 * must parse canonically or the whole patch is refused - so a quoted, escaped or
 * copy header cannot ride along beside one safe target and reach git unexamined.
 */
export function patchTargets(source: string, patchName = "patch"): string[] {
	const targets = new Set<string>();
	const lines = source.split("\n");
	let hunk: HunkState | undefined;
	/** Set by any parsed path-bearing header, so a hunk has an owner. */
	let sawPathHeader = false;

	const refuse = (message: string, index: number): never => {
		throw new PatchError(patchName, message, index + 1);
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];

		if (hunk !== undefined) {
			if (line.startsWith("\\")) {
				continue;
			}
			if (line.startsWith(" ") || line.length === 0) {
				hunk.minus -= 1;
				hunk.plus -= 1;
			} else if (line.startsWith("+")) {
				hunk.plus -= 1;
			} else if (line.startsWith("-")) {
				hunk.minus -= 1;
			} else {
				// The hunk ended early; re-read this line as a header.
				hunk = undefined;
				index -= 1;
				continue;
			}
			if (hunk.minus <= 0 && hunk.plus <= 0) {
				hunk = undefined;
			}
			continue;
		}

		if (line.startsWith("@@@")) {
			refuse("combined diff hunks are not understood", index);
		}
		const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
		if (hunkHeader !== null) {
			if (!sawPathHeader) {
				refuse("a hunk appears before any path-bearing header", index);
			}
			const minus = hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]);
			const plus = hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]);
			hunk = minus <= 0 && plus <= 0 ? undefined : { minus, plus };
			continue;
		}
		if (line.startsWith("@@")) {
			refuse(`malformed hunk header: ${line}`, index);
		}

		const bearing = PATH_BEARING.find((prefix) => line.startsWith(prefix));
		if (bearing === undefined) {
			const refused = REFUSED_HEADERS.find((entry) => line.startsWith(entry.prefix));
			if (refused !== undefined) {
				refuse(`${refused.why}: ${line}`, index);
			}
			// Pathless headers (`index`, `new file mode`, …) and free-form commentary
			// before the first diff carry nothing to confine.
			continue;
		}

		const rest = line.slice(bearing.length);
		try {
			if (bearing === "diff --git ") {
				const fields = rest.split(" ");
				if (fields.length !== 2) {
					throw new TreeError(`a diff header names exactly two unquoted paths; got ${fields.length}: ${rest}`);
				}
				for (const side of fields) {
					const target = stripSide(side);
					if (target !== undefined) {
						targets.add(target);
					}
				}
			} else if (bearing === "--- " || bearing === "+++ ") {
				// git appends a timestamp after a single tab; anything else is part of
				// the name and therefore not canonical.
				const fields = rest.split("\t");
				if (fields.length > 2) {
					throw new TreeError(`header has more than one tab-separated field: ${rest}`);
				}
				const target = stripSide(fields[0]);
				if (target !== undefined) {
					targets.add(target);
				}
			} else {
				targets.add(parseCanonicalPath(rest));
			}
			sawPathHeader = true;
		} catch (error) {
			refuse(error instanceof TreeError ? error.message : String(error), index);
		}
	}

	return [...targets].sort();
}

/**
 * Applies the recorded patches, in order, inside the staging tree.
 *
 * Four rules, each closing a way a patch can reach past its remit:
 *
 * - **Parsed in full, by us.** Every path-bearing header must be a canonical
 *   unquoted POSIX path. A quoted, escaped, whitespace-bearing, copy, combined or
 *   binary header is refused before git is started, so a patch cannot smuggle a
 *   target past confinement by writing it in a form this parser would skip.
 * - **Confined, by us.** Every parsed target is resolved against the staging root
 *   and refused if it is absolute, traverses, or passes through a symlink. `git
 *   apply` refuses much of that itself, but only by an exit code that
 *   `--unsafe-paths` turns into success.
 * - **Check, then apply.** `--check` proves the whole patch applies before any
 *   byte changes, so a patch never lands half-applied.
 * - **All or nothing.** No `--reject`, no `--3way`, no `--unsafe-paths`. A patch
 *   that does not apply cleanly stops the sync; it does not leave a `.rej` for
 *   someone to reconcile later.
 */
export async function applyPatches(
	stagingRoot: string,
	patchDirectory: string,
	ordered: readonly string[],
	git: GitRunner = realGit,
): Promise<void> {
	for (const name of ordered) {
		const path = join(patchDirectory, name);
		const source = await readFile(path, "utf8");
		const targets = patchTargets(source, name);
		if (targets.length === 0) {
			throw new PatchError(name, "names no files to change");
		}
		for (const target of targets) {
			try {
				confinePath(stagingRoot, target);
				await assertNoSymlinkedParent(stagingRoot, target);
			} catch (error) {
				throw new PatchError(name, error instanceof TreeError ? error.message : String(error));
			}
		}
		try {
			await git(["apply", "--check", "--whitespace=nowarn", path], { cwd: stagingRoot });
		} catch (error) {
			throw new PatchError(name, `does not apply cleanly: ${stderrOf(error)}`);
		}
		try {
			await git(["apply", "--whitespace=nowarn", path], { cwd: stagingRoot });
		} catch (error) {
			throw new PatchError(name, `failed while applying: ${stderrOf(error)}`);
		}
	}
	const debris = await findPatchDebris(stagingRoot);
	if (debris.length > 0) {
		throw new PatchError(ordered.at(-1) ?? "patches", `left partial-application debris: ${debris.join(", ")}`);
	}
}

function stderrOf(error: unknown): string {
	const stderr = (error as { stderr?: string }).stderr;
	return (typeof stderr === "string" && stderr.trim().length > 0 ? stderr : String(error)).trim().split("\n")[0];
}
