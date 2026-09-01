#!/usr/bin/env node

/**
 * Split a unified git diff into deterministic, size-capped chunks on file
 * boundaries. Whole file sections stay intact; packing is greedy in the order
 * git emitted the sections. A single file larger than the cap becomes its own
 * chunk.
 *
 * Review-input *reduction* (byte-identical upstream, covered artifacts) lives in
 * `select-grok-review-input.mjs`. This module only bounds concurrent prompt size.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Linux `MAX_ARG_STRLEN` is ~128 KiB per argv element. Copilot takes the full
 * prompt as `--prompt <text>`, so each chunk must stay under that ceiling.
 * Provenance reduction owns *what* is reviewed; concurrency owns one-wave fit.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 96_000;

/** Hard ceiling — never raise a prompt past the argv-safe bound. */
export const HARD_MAX_CHUNK_BYTES = 96_000;

/**
 * Conservative test ceiling for prompt argv bytes (chunk + preamble margin).
 * Must stay below Linux MAX_ARG_STRLEN (~128 KiB).
 */
export const PROMPT_ARGV_TEST_CEILING_BYTES = 100_000;

/**
 * Resolve the pack cap: never above the argv-safe hard max, never above the
 * caller floor request. Adaptive growth past 96 KiB is forbidden (E2BIG).
 *
 * @param {number} selectedBytes
 * @param {{ floor?: number, hardMax?: number, waveSlots?: number }} [opts]
 */
export function adaptiveMaxChunkBytes(
	selectedBytes,
	{ floor = DEFAULT_MAX_CHUNK_BYTES, hardMax = HARD_MAX_CHUNK_BYTES, waveSlots = 16 } = {},
) {
	if (!Number.isSafeInteger(selectedBytes) || selectedBytes < 0) {
		throw new Error("selectedBytes must be a non-negative integer");
	}
	if (!Number.isSafeInteger(waveSlots) || waveSlots < 1) {
		throw new Error("waveSlots must be a positive integer");
	}
	if (!Number.isSafeInteger(floor) || floor < 1) {
		throw new Error("floor must be a positive integer");
	}
	if (!Number.isSafeInteger(hardMax) || hardMax < 1) {
		throw new Error("hardMax must be a positive integer");
	}
	// Cap only — never inflate past the argv-safe hard max to "fit" a wave.
	return Math.min(floor, hardMax, DEFAULT_MAX_CHUNK_BYTES);
}


/**
 * @typedef {{ path: string, text: string, bytes: number }} DiffFileSection
 * @typedef {{ index: number, paths: string[], text: string, bytes: number }} DiffChunk
 */

/**
 * @param {string} diffText
 * @returns {DiffFileSection[]}
 */
export function splitDiffFileSections(diffText) {
	if (!diffText) return [];
	const normalized = diffText.endsWith("\n") ? diffText : `${diffText}\n`;
	const lines = normalized.split("\n");
	/** @type {DiffFileSection[]} */
	const sections = [];
	/** @type {string[]} */
	let currentLines = [];
	/** @type {string | null} */
	let currentPath = null;

	const flush = () => {
		if (currentLines.length === 0) return;
		const text = currentLines.join("\n") + "\n";
		sections.push({
			path: currentPath ?? "unknown",
			text,
			bytes: Buffer.byteLength(text, "utf8"),
		});
		currentLines = [];
		currentPath = null;
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			flush();
			currentPath = pathFromDiffGitLine(line);
			currentLines.push(line);
			continue;
		}
		if (currentLines.length === 0) continue;
		if (line.startsWith("+++ ")) {
			const fromPlus = pathFromPlusPlusLine(line);
			if (fromPlus) currentPath = fromPlus;
		}
		currentLines.push(line);
	}
	flush();
	return sections;
}

function pathFromDiffGitLine(line) {
	// Unquoted: diff --git a/foo b/foo
	// Quoted:   diff --git "a/foo bar" "b/foo bar"
	const quoted = /^diff --git (?:"([^"]+)"|(\S+)) (?:"([^"]+)"|(\S+))$/u.exec(line);
	if (!quoted) return null;
	const right = quoted[3] ?? quoted[4];
	const left = quoted[1] ?? quoted[2];
	return stripDiffPath(right || left);
}

function stripDiffPath(raw) {
	let value = raw;
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
	return value.replace(/\\(.)/gu, "$1");
}

function pathFromPlusPlusLine(line) {
	if (line === "+++ /dev/null") return null;
	// +++ b/foo  OR  +++ "b/foo bar"
	const match = /^\+\+\+ (?:[ab]\/(.+)|"([ab]\/[^"]+)"|'([ab]\/[^']+)')$/u.exec(line);
	if (!match) return null;
	const raw = match[1] ?? match[2] ?? match[3];
	return stripDiffPath(raw);
}

/**
 * Parse a unified-diff chunk into the only locations a finding may cite:
 * repository-relative paths present in the chunk, and the set of **new-side**
 * changed line numbers per path (added `+` lines and the new side of
 * replacements). Context (` `) and deletion-only (`-`) lines are excluded.
 *
 * @param {string} diffText
 * @returns {{
 *   paths: string[],
 *   newSideLines: Map<string, Set<number>>,
 * }}
 */
export function parseChunkLocationIndex(diffText) {
	/** @type {Map<string, Set<number>>} */
	const newSideLines = new Map();
	/** @type {Set<string>} */
	const seenPaths = new Set();

	/** @type {string | null} */
	let currentPath = null;
	let newLine = 0;
	let inHunk = false;

	const ensurePath = (path) => {
		if (!path) return;
		seenPaths.add(path);
		if (!newSideLines.has(path)) newSideLines.set(path, new Set());
	};

	const normalized = diffText.endsWith("\n") ? diffText : `${diffText}\n`;
	for (const line of normalized.split("\n")) {
		if (line.startsWith("diff --git ")) {
			currentPath = pathFromDiffGitLine(line);
			ensurePath(currentPath);
			inHunk = false;
			newLine = 0;
			continue;
		}
		// File headers only apply outside a hunk. Inside a hunk, lines may
		// legitimately start with +++ / --- as added/deleted content.
		if (!inHunk && line.startsWith("--- ")) {
			continue;
		}
		if (!inHunk && line.startsWith("+++ ")) {
			if (line !== "+++ /dev/null") {
				const fromPlus = pathFromPlusPlusLine(line);
				if (fromPlus) {
					currentPath = fromPlus;
					ensurePath(currentPath);
				}
			}
			continue;
		}
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
		if (hunk) {
			inHunk = true;
			newLine = Number.parseInt(hunk[3], 10);
			ensurePath(currentPath);
			continue;
		}
		if (!inHunk || !currentPath) continue;

		if (line.startsWith("+")) {
			ensurePath(currentPath);
			newSideLines.get(currentPath).add(newLine);
			newLine += 1;
			continue;
		}
		if (line.startsWith("-")) {
			// old-side only — does not advance new-side line counter
			continue;
		}
		if (line.startsWith(" ") || line === "") {
			// context / empty: advances new side but is NOT a changed line
			if (line.startsWith(" ")) newLine += 1;
			continue;
		}
		if (line.startsWith("\\")) {
			// "\ No newline at end of file"
			continue;
		}
	}

	return {
		paths: [...seenPaths],
		newSideLines,
	};
}


/**
 * Classify a unified-diff body line for old/new side movement.
 * @param {string} line
 * @returns {{ old: number, new: number, kind: "context" | "delete" | "add" | "meta" }}
 */
function hunkBodyLineDelta(line) {
	// Inside a hunk every leading + is an addition and every leading - is a
	// deletion — including content that itself starts with ++ or --.
	if (line.startsWith("+")) return { old: 0, new: 1, kind: "add" };
	if (line.startsWith("-")) return { old: 1, new: 0, kind: "delete" };
	if (line.startsWith(" ")) return { old: 1, new: 1, kind: "context" };
	if (line.startsWith("\\")) return { old: 0, new: 0, kind: "meta" };
	// Treat bare empty lines inside a hunk as context-less meta (rare).
	return { old: 0, new: 0, kind: "meta" };
}

/**
 * @param {number} start
 * @param {number} count
 */
function formatSide(start, count) {
	return count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * @param {number} oldStart
 * @param {number} oldCount
 * @param {number} newStart
 * @param {number} newCount
 * @param {string} [suffix]
 */
export function formatHunkHeader(oldStart, oldCount, newStart, newCount, suffix = "") {
	const base = `@@ -${formatSide(oldStart, oldCount)} +${formatSide(newStart, newCount)} @@`;
	return suffix ? `${base} ${suffix}` : base;
}

/**
 * @param {string} headerLine
 */
function parseHunkHeaderLine(headerLine) {
	const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/u.exec(headerLine);
	if (!match) return null;
	return {
		oldStart: Number.parseInt(match[1], 10),
		oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
		newStart: Number.parseInt(match[3], 10),
		newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
		suffix: match[5] ?? "",
	};
}

/**
 * Split a file-level unified diff section into the file metadata header and
 * ordered hunks (header + body lines).
 * @param {string[]} lines
 */
function splitFileSectionIntoHunks(lines) {
	/** @type {string[]} */
	const fileHeader = [];
	/** @type {{ oldStart: number, oldCount: number, newStart: number, newCount: number, suffix: string, body: string[] }[]} */
	const hunks = [];
	/** @type {null | { oldStart: number, oldCount: number, newStart: number, newCount: number, suffix: string, body: string[] }} */
	let current = null;

	const flush = () => {
		if (!current) return;
		hunks.push(current);
		current = null;
	};

	for (const line of lines) {
		if (line.startsWith("@@ ")) {
			flush();
			const parsed = parseHunkHeaderLine(line);
			if (!parsed) {
				// Unparseable hunk header — keep as opaque single-body chunk later.
				current = {
					oldStart: 1,
					oldCount: 0,
					newStart: 1,
					newCount: 0,
					suffix: "",
					body: [],
					rawHeader: line,
				};
			} else {
				current = { ...parsed, body: [] };
			}
			continue;
		}
		if (!current) {
			fileHeader.push(line);
			continue;
		}
		current.body.push(line);
	}
	flush();
	// Trailing blank lines after the last real hunk row are section separators, not body.
	for (const hunk of hunks) {
		while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === "") {
			hunk.body.pop();
		}
	}
	return { fileHeader, hunks };
}

/**
 * Emit one valid hunk text (header + body) for a slice of an original hunk.
 * Counts are derived from body movement so split pieces stay honest.
 * @param {{ oldStart: number, newStart: number, suffix: string }} base
 * @param {string[]} body
 */
function materializeHunk(base, body) {
	let oldCount = 0;
	let newCount = 0;
	for (const line of body) {
		const delta = hunkBodyLineDelta(line);
		oldCount += delta.old;
		newCount += delta.new;
	}
	const header = formatHunkHeader(base.oldStart, oldCount, base.newStart, newCount, base.suffix);
	return `${header}\n${body.length ? `${body.join("\n")}\n` : ""}`;
}


/**
 * Split one hunk whose full text exceeds budget into valid sub-hunks with
 * synthesized @@ headers that continue old/new line numbering.
 * @param {{ oldStart: number, oldCount: number, newStart: number, newCount: number, suffix: string, body: string[], rawHeader?: string }} hunk
 * @param {number} budgetBytes max bytes for "@@…\n" + body (file header billed separately)
 * @returns {string[]}
 */
function splitHunkToBudget(hunk, budgetBytes) {
	const whole = materializeHunk(hunk, hunk.body);
	if (Buffer.byteLength(whole, "utf8") <= budgetBytes) return [whole];

	/** @type {string[]} */
	const out = [];
	let oldPos = hunk.oldStart;
	let newPos = hunk.newStart;
	let index = 0;

	while (index < hunk.body.length) {
		/** @type {string[]} */
		const body = [];
		let oldCount = 0;
		let newCount = 0;

		while (index < hunk.body.length) {
			const line = hunk.body[index];
			const delta = hunkBodyLineDelta(line);
			const trialBody = [...body, line];
			const trial = materializeHunk(
				{ oldStart: oldPos, newStart: newPos, suffix: hunk.suffix },
				trialBody,
			);
			const trialBytes = Buffer.byteLength(trial, "utf8");
			if (body.length > 0 && trialBytes > budgetBytes) break;
			body.push(line);
			oldCount += delta.old;
			newCount += delta.new;
			index += 1;
			if (trialBytes > budgetBytes && body.length === 1) {
				// Single line exceeds budget — emit alone (argv fail-closed upstream).
				break;
			}
		}

		if (body.length === 0) {
			// Should not happen; advance one line to avoid infinite loop.
			const line = hunk.body[index++];
			const delta = hunkBodyLineDelta(line);
			out.push(
				materializeHunk({ oldStart: oldPos, newStart: newPos, suffix: hunk.suffix }, [line]),
			);
			oldPos += delta.old;
			newPos += delta.new;
			continue;
		}

		// Skip pure-meta slices (blank / "\ No newline") — they are not valid review fragments
		// and would poison location indexes with empty new-side sets.
		const hasContent = body.some((line) => {
			const kind = hunkBodyLineDelta(line).kind;
			return kind === "add" || kind === "delete" || kind === "context";
		});
		if (hasContent) {
			out.push(materializeHunk({ oldStart: oldPos, newStart: newPos, suffix: hunk.suffix }, body));
		}
		oldPos += oldCount;
		newPos += newCount;
	}

	return out;
}

/**
 * Split one oversized file section into argv-safe **valid unified-diff** pieces.
 * Prefer whole-hunk boundaries. When a single hunk must split, each piece gets a
 * synthesized `@@ -oldStart,oldCount +newStart,newCount @@` header that continues
 * old/new line numbering. File metadata (`diff --git` / `---` / `+++`) is repeated.
 * Never exceeds maxChunkBytes unless a single line alone is larger.
 *
 * @param {DiffFileSection} section
 * @param {number} maxChunkBytes
 * @returns {DiffFileSection[]}
 */
export function splitOversizedSection(section, maxChunkBytes) {
	if (section.bytes <= maxChunkBytes) return [section];
	const lines = section.text.endsWith("\n")
		? section.text.slice(0, -1).split("\n")
		: section.text.split("\n");

	const { fileHeader, hunks } = splitFileSectionIntoHunks(lines);
	const headerText = fileHeader.length ? `${fileHeader.join("\n")}\n` : "";
	const headerBytes = Buffer.byteLength(headerText, "utf8");
	const bodyBudget = Math.max(1, maxChunkBytes - headerBytes);

	// Expand into valid hunk fragments (whole hunks or synthesized sub-hunks).
	/** @type {string[]} */
	const fragments = [];
	if (hunks.length === 0) {
		// Binary / header-only / no hunks: fall back to raw line packing with header.
		const bodyLines = lines.slice(fileHeader.length);
		/** @type {string[]} */
		let body = [];
		let bodyBytes = 0;
		const flush = () => {
			if (body.length === 0 && fragments.length > 0) return;
			fragments.push(body.length ? `${body.join("\n")}\n` : "");
			body = [];
			bodyBytes = 0;
		};
		for (const line of bodyLines) {
			const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
			if (body.length > 0 && bodyBytes + lineBytes > bodyBudget) flush();
			body.push(line);
			bodyBytes += lineBytes;
			if (lineBytes > bodyBudget && body.length === 1) flush();
		}
		flush();
	} else {
		for (const hunk of hunks) {
			fragments.push(...splitHunkToBudget(hunk, bodyBudget));
		}
	}

	// Pack fragments greedily under the full piece budget (header + fragments).
	/** @type {DiffFileSection[]} */
	const pieces = [];
	/** @type {string[]} */
	let packed = [];
	let packedBytes = 0;

	const flushPacked = () => {
		if (packed.length === 0) return;
		const text = `${headerText}${packed.join("")}`;
		pieces.push({
			path: section.path,
			text,
			bytes: Buffer.byteLength(text, "utf8"),
		});
		packed = [];
		packedBytes = 0;
	};

	for (const fragment of fragments) {
		if (!fragment || !fragment.trim()) continue;
		const fragBytes = Buffer.byteLength(fragment, "utf8");
		if (packed.length > 0 && headerBytes + packedBytes + fragBytes > maxChunkBytes) {
			flushPacked();
		}
		packed.push(fragment);
		packedBytes += fragBytes;
		if (headerBytes + fragBytes > maxChunkBytes && packed.length === 1) {
			// Fragment alone exceeds cap (single-line blow-up).
			flushPacked();
		}
	}
	flushPacked();
	return pieces.length > 0 ? pieces : [section];
}


/**
 * @param {string} diffText
 * @param {{ maxChunkBytes?: number }} [options]
 * @returns {DiffChunk[]}
 */
export function partitionUnifiedDiff(diffText, { maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES } = {}) {
	if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
		throw new Error("maxChunkBytes must be a positive integer");
	}

	const sections = splitDiffFileSections(diffText).flatMap((section) =>
		splitOversizedSection(section, maxChunkBytes),
	);
	/** @type {DiffChunk[]} */
	const chunks = [];
	/** @type {{ paths: string[], parts: string[], bytes: number }} */
	let current = { paths: [], parts: [], bytes: 0 };

	const pushCurrent = () => {
		if (current.paths.length === 0) return;
		chunks.push({
			index: chunks.length,
			paths: [...current.paths],
			text: current.parts.join(""),
			bytes: current.bytes,
		});
		current = { paths: [], parts: [], bytes: 0 };
	};

	for (const section of sections) {
		if (section.bytes > maxChunkBytes) {
			// Still oversized after split (single-line blow-up) — own chunk; runner argv test guards.
			pushCurrent();
			chunks.push({
				index: chunks.length,
				paths: [section.path],
				text: section.text,
				bytes: section.bytes,
			});
			continue;
		}
		if (current.paths.length > 0 && current.bytes + section.bytes > maxChunkBytes) {
			pushCurrent();
		}
		current.paths.push(section.path);
		current.parts.push(section.text);
		current.bytes += section.bytes;
	}
	pushCurrent();
	return chunks;
}


/**
 * Write chunk files and a JSON manifest for the workflow.
 * @param {string} diffText
 * @param {string} outDir
 * @param {{ maxChunkBytes?: number }} [options]
 */
export function writeDiffChunks(diffText, outDir, options = {}) {
	const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
	const chunks = partitionUnifiedDiff(diffText, { maxChunkBytes });
	const manifest = {
		maxChunkBytes,
		chunkCount: chunks.length,
		chunks: chunks.map((chunk) => ({
			index: chunk.index,
			path: `chunk-${String(chunk.index).padStart(3, "0")}.diff`,
			bytes: chunk.bytes,
			paths: chunk.paths,
		})),
	};
	mkdirSync(outDir, { recursive: true });
	for (const chunk of chunks) {
		const name = `chunk-${String(chunk.index).padStart(3, "0")}.diff`;
		writeFileSync(`${outDir}/${name}`, chunk.text);
	}
	writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

function main() {
	const [diffPath, outDir, maxRaw] = process.argv.slice(2);
	if (!diffPath || !outDir) {
		console.error("usage: node scripts/partition-pr-diff.mjs <diff> <out-dir> [max-chunk-bytes]");
		process.exit(2);
	}
	const maxChunkBytes = maxRaw ? Number.parseInt(maxRaw, 10) : DEFAULT_MAX_CHUNK_BYTES;
	const text = readFileSync(diffPath, "utf8");
	const manifest = writeDiffChunks(text, outDir, { maxChunkBytes });
	console.log(JSON.stringify(manifest));
}

function invokedDirectly() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedDirectly()) main();
