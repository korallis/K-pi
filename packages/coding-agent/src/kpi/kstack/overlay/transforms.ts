import { parseFrontmatter } from "../frontmatter.ts";

/**
 * The K-stack overlay transform engine.
 *
 * Everything here is structured and located. A blind `replaceAll` cannot tell
 * `pstack` in `setup-pstack` from `pstack` in `upstack`, and a line filter that
 * deletes whatever mentions a banned word silently rewrites meaning. So renames
 * are tokens or path segments with explicit boundaries, drops name a path or a
 * scoped line and carry a reason, and anything the rules do not understand
 * becomes a diagnostic that names the file, line and column - never a quiet
 * pass-through and never a quiet deletion.
 */

export interface KStackDiagnostic {
	/** Generated-tree relative path. */
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly rule: string;
	readonly message: string;
	/** The offending text, bounded for a readable report. */
	readonly excerpt: string;
}

export class KStackTransformError extends Error {
	readonly diagnostics: readonly KStackDiagnostic[];

	constructor(diagnostics: readonly KStackDiagnostic[]) {
		super(
			`K-stack overlay refused ${diagnostics.length} residue${diagnostics.length === 1 ? "" : "s"}:\n${diagnostics
				.map(
					(entry) =>
						`  ${entry.path}:${entry.line}:${entry.column} [${entry.rule}] ${entry.message} — ${entry.excerpt}`,
				)
				.join("\n")}`,
		);
		this.name = "KStackTransformError";
		this.diagnostics = diagnostics;
	}
}

/** Where a rename may sit relative to surrounding identifier characters. */
export type RenameBoundary = "both" | "left" | "none";

export interface TokenRename {
	readonly from: string;
	readonly to: string;
	readonly boundary?: RenameBoundary;
}

export interface PathRename {
	readonly from: string;
	readonly to: string;
}

export interface DropPath {
	readonly pattern: string;
	readonly reason: string;
}

export interface DropLine {
	readonly pattern: string;
	readonly reason: string;
	readonly scope?: readonly string[];
}

export interface OperatorRule {
	readonly pattern: string;
	readonly replacement: string;
	readonly note?: string;
}

export interface SentinelRule {
	readonly pattern: string;
	readonly rule: string;
	readonly message: string;
}

export interface OverlayConfig {
	readonly pathRenames: readonly PathRename[];
	readonly tokenRenames: readonly TokenRename[];
	readonly dropPaths: readonly DropPath[];
	readonly dropLines: readonly DropLine[];
	readonly operators: readonly OperatorRule[];
	readonly unknownOperatorSentinels: readonly SentinelRule[];
	/** Plain strings that must not survive anywhere in the generated tree. */
	readonly forbidden: readonly string[];
	/** Paths whose only job is required third-party attribution. */
	readonly attributionPaths: readonly string[];
	readonly requiredSkills: readonly string[];
}

/**
 * Maintainer test collateral vendored beside upstream skill scripts. It is
 * development tooling for the upstream repository, not runtime skill content.
 */
export const MAINTAINER_TEST_FILE = /\.test(-helper)?\.ts$/u;

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_-]/u;
const EXCERPT_LIMIT = 120;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** A `**` glob over POSIX-style relative paths. No character classes needed. */
export function matchesGlob(path: string, pattern: string): boolean {
	const source = pattern
		.split("**")
		.map((part) =>
			part
				.split("*")
				.map((piece) => escapeRegExp(piece))
				.join("[^/]*"),
		)
		.join(".*");
	return new RegExp(`^${source}$`, "u").test(path);
}

/**
 * Compiles a rule pattern.
 *
 * `(?i)` at the head is honoured because a rule file is data, and JavaScript has
 * no inline flag syntax. Every pattern is global so a rule reports every hit in a
 * file rather than only the first.
 */
function compile(pattern: string, extraFlags = ""): RegExp {
	const insensitive = pattern.startsWith("(?i)");
	const body = insensitive ? pattern.slice(4) : pattern;
	return new RegExp(body, `gu${insensitive ? "i" : ""}${extraFlags}`);
}

function excerpt(line: string): string {
	const trimmed = line.trim();
	return trimmed.length <= EXCERPT_LIMIT ? trimmed : `${trimmed.slice(0, EXCERPT_LIMIT)}…`;
}

/** Every match of `pattern` in `source`, as located diagnostics. */
export function locate(
	source: string,
	pattern: string,
	path: string,
	rule: string,
	message: string,
): KStackDiagnostic[] {
	const found: KStackDiagnostic[] = [];
	const lines = source.split("\n");
	for (const [index, line] of lines.entries()) {
		const regex = compile(pattern);
		let match = regex.exec(line);
		while (match !== null) {
			found.push({
				path,
				line: index + 1,
				column: match.index + 1,
				rule,
				message,
				excerpt: excerpt(line),
			});
			if (match.index === regex.lastIndex) {
				regex.lastIndex += 1;
			}
			match = regex.exec(line);
		}
	}
	return found;
}

/**
 * Rewrites one token with an explicit boundary policy.
 *
 * `both` is a whole identifier. `left` allows a suffix but refuses a prefix,
 * which is what keeps `pstack` -> `K-stack` from touching `upstack`,
 * `open-pstack` or `pi-pstack`. `none` is a literal substring, for paths and
 * quoted JSON fragments where boundaries do not apply.
 */
export function renameToken(source: string, rename: TokenRename): string {
	const boundary = rename.boundary ?? "both";
	if (boundary === "none") {
		return source.split(rename.from).join(rename.to);
	}
	let result = "";
	let index = 0;
	while (index < source.length) {
		const next = source.indexOf(rename.from, index);
		if (next === -1) {
			result += source.slice(index);
			break;
		}
		const before = next === 0 ? "" : source[next - 1];
		const afterIndex = next + rename.from.length;
		const after = afterIndex >= source.length ? "" : source[afterIndex];
		const leftOk = before === "" || !IDENTIFIER_CHARACTER.test(before);
		const rightOk = boundary === "left" || after === "" || !IDENTIFIER_CHARACTER.test(after);
		result += source.slice(index, next);
		if (leftOk && rightOk) {
			result += rename.to;
		} else {
			result += rename.from;
		}
		index = afterIndex;
	}
	return result;
}

/** Path segments and file stems, never a substring inside a longer segment. */
export function renamePath(path: string, renames: readonly PathRename[]): string {
	return path
		.split("/")
		.map((segment) => {
			for (const rename of renames) {
				if (segment === rename.from) {
					return rename.to;
				}
				const dot = segment.indexOf(".");
				if (dot > 0 && segment.slice(0, dot) === rename.from) {
					return `${rename.to}${segment.slice(dot)}`;
				}
			}
			return segment;
		})
		.join("/");
}

export interface TransformOutcome {
	readonly text: string;
	readonly diagnostics: readonly KStackDiagnostic[];
	/** Lines removed, with the rule that removed them. */
	readonly dropped: readonly { readonly line: number; readonly reason: string }[];
}

/**
 * Applies renames, operator mappings and scoped line drops to one file, then
 * reports whatever the rules still do not understand.
 */
export function transformFile(path: string, source: string, config: OverlayConfig): TransformOutcome {
	let text = source;
	for (const rename of config.tokenRenames) {
		text = renameToken(text, rename);
	}
	for (const operator of config.operators) {
		text = text.replace(compile(operator.pattern), operator.replacement);
	}

	const dropped: { line: number; reason: string }[] = [];
	const applicable = config.dropLines.filter(
		(rule) => rule.scope === undefined || rule.scope.some((pattern) => matchesGlob(path, pattern)),
	);
	if (applicable.length > 0) {
		text = text
			.split("\n")
			.filter((line, index) => {
				const rule = applicable.find((candidate) => compile(candidate.pattern).test(line));
				if (rule === undefined) {
					return true;
				}
				dropped.push({ line: index + 1, reason: rule.reason });
				return false;
			})
			.join("\n");
	}

	const isAttribution = config.attributionPaths.some((entry) => path === entry || path.endsWith(`/${entry}`));
	const diagnostics = isAttribution
		? []
		: config.unknownOperatorSentinels.flatMap((sentinel) =>
				locate(text, sentinel.pattern, path, sentinel.rule, sentinel.message),
			);

	return { text, diagnostics, dropped };
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** Pi's own ceiling, mirrored so a generated skill cannot load with a warning. */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * References to files that must travel with a skill.
 *
 * A markdown link is always one. A backticked path counts only when it names a
 * directory, because a bare file name in prose is usually a run-directory
 * contract - `candidate.json`, `verdict.json` - and not a file beside the skill.
 * Treating those as support files would demand the skill ship a copy of a
 * contract it only reads at runtime.
 */
export function supportLinks(source: string): string[] {
	const found = new Set<string>();
	const patterns = [
		{ source: /\]\(([^)\s]+)\)/gu, requireDirectory: false },
		{ source: /`([A-Za-z0-9._\-/]+\.(?:md|ts|json|yaml|yml|txt))`/gu, requireDirectory: true },
	];
	for (const pattern of patterns) {
		const regex = new RegExp(pattern.source.source, "gu");
		let match = regex.exec(source);
		while (match !== null) {
			const target = match[1];
			const external =
				/^[a-z]+:/u.test(target) || target.startsWith("#") || target.startsWith("/") || target.startsWith("~");
			if (!external && (!pattern.requireDirectory || target.includes("/"))) {
				found.add(target.split("#")[0]);
			}
			match = regex.exec(source);
		}
	}
	return [...found];
}

/**
 * Validates the whole generated tree: frontmatter, identity, uniqueness, parent
 * alignment, support reachability, residue, and the skills that must exist.
 */
export function validateGeneratedTree(files: ReadonlyMap<string, string>, config: OverlayConfig): KStackDiagnostic[] {
	const diagnostics: KStackDiagnostic[] = [];
	const add = (path: string, rule: string, message: string, line = 1): void => {
		diagnostics.push({ path, line, column: 1, rule, message, excerpt: "" });
	};

	for (const [path, source] of files) {
		if (MAINTAINER_TEST_FILE.test(path)) {
			add(path, "maintainer-collateral", "upstream maintainer test collateral must not ship");
		}
		const isAttribution = config.attributionPaths.some((entry) => path === entry || path.endsWith(`/${entry}`));
		if (isAttribution) {
			continue;
		}
		for (const sentinel of config.unknownOperatorSentinels) {
			diagnostics.push(...locate(source, sentinel.pattern, path, sentinel.rule, sentinel.message));
		}
		// The plain net. Independent of whether any transform rule matched, so a
		// forbidden string cannot survive by not resembling a pattern.
		const lower = source.toLowerCase();
		for (const phrase of config.forbidden) {
			if (lower.includes(phrase.toLowerCase())) {
				diagnostics.push(
					...locate(
						source,
						`(?i)${escapeRegExp(phrase)}`,
						path,
						"forbidden-string",
						`forbidden string: ${phrase}`,
					),
				);
			}
		}
	}

	const byName = new Map<string, string[]>();
	for (const [path, source] of files) {
		if (!path.endsWith("SKILL.md")) {
			continue;
		}
		const parsed = parseFrontmatter(source);
		if (parsed === undefined) {
			add(path, "frontmatter", "skill has no parseable YAML frontmatter block");
			continue;
		}
		const name = parsed.fields.name;
		const description = parsed.fields.description;
		if (name === undefined || name.length === 0) {
			add(path, "frontmatter-name", "skill frontmatter has no name");
		} else {
			if (!SKILL_NAME.test(name)) {
				add(path, "skill-name", `name must be lowercase-hyphen: ${name}`);
			}
			if (name.length > MAX_NAME_LENGTH) {
				add(path, "skill-name", `name exceeds ${MAX_NAME_LENGTH} characters: ${name}`);
			}
			const parent = path.split("/").at(-2);
			if (parent !== undefined && parent !== name) {
				add(path, "skill-parent", `name ${name} does not match its parent directory ${parent}`);
			}
			byName.set(name, [...(byName.get(name) ?? []), path]);
		}
		if (description === undefined || description.trim().length === 0) {
			add(path, "frontmatter-description", "skill frontmatter has no description");
		} else if (description.length > MAX_DESCRIPTION_LENGTH) {
			add(path, "frontmatter-description", `description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
		}

		const directory = path.slice(0, path.lastIndexOf("/"));
		for (const link of supportLinks(source)) {
			const target = normalizeRelative(directory, link);
			if (target !== undefined && !files.has(target) && !hasDirectory(files, target)) {
				add(path, "support-link", `support file is unreachable: ${link}`);
			}
		}
	}

	for (const [name, paths] of byName) {
		if (paths.length > 1) {
			add(
				paths[1],
				"skill-uniqueness",
				`skill name ${name} is declared by ${paths.length} skills: ${paths.join(", ")}`,
			);
		}
	}
	for (const required of config.requiredSkills) {
		if (!byName.has(required)) {
			add("generated", "required-skill", `required skill is missing: ${required}`);
		}
	}
	return diagnostics;
}

function normalizeRelative(directory: string, link: string): string | undefined {
	const segments = `${directory}/${link}`.split("/");
	const stack: string[] = [];
	for (const segment of segments) {
		if (segment === "." || segment.length === 0) {
			continue;
		}
		if (segment === "..") {
			if (stack.pop() === undefined) {
				return undefined;
			}
			continue;
		}
		stack.push(segment);
	}
	return stack.join("/");
}

function hasDirectory(files: ReadonlyMap<string, string>, target: string): boolean {
	const prefix = `${target}/`;
	for (const path of files.keys()) {
		if (path.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

/** Throws unless the generated tree is clean. */
export function assertGeneratedTree(files: ReadonlyMap<string, string>, config: OverlayConfig): void {
	const diagnostics = validateGeneratedTree(files, config);
	if (diagnostics.length > 0) {
		throw new KStackTransformError(diagnostics);
	}
}
