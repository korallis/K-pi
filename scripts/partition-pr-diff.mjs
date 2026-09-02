#!/usr/bin/env node

/**
 * Split a unified git diff into deterministic, size-capped chunks on file
 * boundaries. Whole file sections stay intact; packing is greedy in the order
 * git emitted the sections. A single file larger than the cap becomes its own
 * chunk (split further when needed).
 *
 * Review-input *reduction* (byte-identical upstream, covered artifacts) lives in
 * `select-grok-review-input.mjs`. This module bounds HTTP prompt size for the
 * z.ai reviewer — the prompt travels in a JSON body, not argv.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Default pack cap when no model catalog is supplied (matches practical latency bound).
 * Real CI derives the cap from catalog contextWindow then clamps to PRACTICAL_MAX_CHUNK_BYTES.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 160_000;

/**
 * Absolute safety ceiling for one chunk's diff bytes in the HTTP JSON body.
 * Never raise a single request past this even if the model context is larger.
 */
export const ABSOLUTE_MAX_CHUNK_BYTES = 1_500_000;

/**
 * Practical per-request diff cap for flash-tier latency. Catalog contextWindow may
 * allow ~300–800 KiB of input; multi-hundred-KiB prompts routinely exceed the 15–30m
 * group wall clock at concurrency 2. Keep requests large vs the old 96 KiB argv era
 * (~10–30 chunks for multi-MB selections) without starving the job timeout.
 */
export const PRACTICAL_MAX_CHUNK_BYTES = 160_000;

/** @deprecated alias — same as ABSOLUTE_MAX_CHUNK_BYTES (HTTP body hard ceiling). */
export const HARD_MAX_CHUNK_BYTES = ABSOLUTE_MAX_CHUNK_BYTES;

/**
 * Sane packing floor. Adaptive sizing may grow above this toward the
 * context-derived hard max, but never below it (except when hardMax is tighter).
 */
export const MIN_CHUNK_BYTES = 4_096;

/** Approximate UTF-8 bytes per input token for code/diffs (conservative). */
export const DEFAULT_BYTES_PER_TOKEN = 3;

/**
 * Fraction of model `contextWindow` reserved for the review *input* (framing +
 * inventory + diff). The rest covers reasoning/output headroom on flash tiers.
 */
export const CONTEXT_INPUT_FRACTION = 0.25;

/**
 * Derive the max diff-chunk byte budget from a z.ai catalog model entry.
 * Leaves room for inventory/framing (caller passes framingBytes) and maxTokens.
 *
 * @param {{
 *   contextWindow: number,
 *   maxTokens?: number,
 *   framingBytes?: number,
 *   bytesPerToken?: number,
 *   inputFraction?: number,
 *   absoluteMax?: number,
 * }} opts
 * @returns {number}
 */
export function maxChunkBytesFromModelContext(opts) {
	const contextWindow = opts.contextWindow;
	const maxTokens = opts.maxTokens ?? 0;
	const framingBytes = opts.framingBytes ?? 0;
	const bytesPerToken = opts.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
	const inputFraction = opts.inputFraction ?? CONTEXT_INPUT_FRACTION;
	const absoluteMax = opts.absoluteMax ?? ABSOLUTE_MAX_CHUNK_BYTES;
	const practicalMax = opts.practicalMax ?? PRACTICAL_MAX_CHUNK_BYTES;
	if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) {
		throw new Error("contextWindow must be an integer >= 1024");
	}
	if (!Number.isSafeInteger(bytesPerToken) || bytesPerToken < 1) {
		throw new Error("bytesPerToken must be a positive integer");
	}
	if (!(inputFraction > 0 && inputFraction <= 1)) {
		throw new Error("inputFraction must be in (0, 1]");
	}
	if (!Number.isSafeInteger(absoluteMax) || absoluteMax < MIN_CHUNK_BYTES) {
		throw new Error("absoluteMax must be a positive integer");
	}
	if (!Number.isSafeInteger(framingBytes) || framingBytes < 0) {
		throw new Error("framingBytes must be a non-negative integer");
	}
	const framingTokens = Math.ceil(framingBytes / bytesPerToken);
	const reserveOut = Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 0;
	const usableTokens =
		Math.floor(contextWindow * inputFraction) - reserveOut - framingTokens - 1024;
	if (usableTokens < 2048) {
		throw new Error(
			`model context leaves only ${usableTokens} input tokens after reserves (contextWindow=${contextWindow}, maxTokens=${reserveOut}, framingBytes=${framingBytes}); fails closed`,
		);
	}
	const fromContext = usableTokens * bytesPerToken;
	return Math.min(absoluteMax, practicalMax, fromContext);
}

/**
 * Resolve the pack cap for HTTP-body review chunks.
 *
 * Prefer the context-derived `hardMax` so chunk count falls out of model budget
 * (tens of large requests), not matrix slot filling (dozens of tiny argv-era
 * requests). `waveSlots` is retained for API compatibility; capacity is enforced
 * after partition against the matrix, not by shrinking chunks toward slot fill.
 *
 * @param {number} selectedBytes
 * @param {{ floor?: number, hardMax?: number, waveSlots?: number }} [opts]
 */
export function adaptiveMaxChunkBytes(
	selectedBytes,
	{ floor = MIN_CHUNK_BYTES, hardMax = DEFAULT_MAX_CHUNK_BYTES, waveSlots = 128 } = {},
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
	const effectiveHard = Math.min(hardMax, ABSOLUTE_MAX_CHUNK_BYTES);
	const effectiveFloor = Math.min(Math.max(1, floor), effectiveHard);
	if (selectedBytes === 0) return effectiveFloor;
	return effectiveHard;
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
	// Quoted headers still include the git a/ or b/ prefix — strip once via stripDiffPath.
	const quoted = /^\+\+\+ "([ab]\/[^"]+)"$/u.exec(line) || /^\+\+\+ '([ab]\/[^']+)'$/u.exec(line);
	if (quoted) return stripDiffPath(quoted[1]);
	// Unquoted: +++ b/a/foo.ts → capture is already repo-relative (a/foo.ts).
	const unquoted = /^\+\+\+ [ab]\/(.+)$/u.exec(line);
	if (!unquoted) return null;
	return unquoted[1].replace(/\\(.)/gu, "$1");
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
