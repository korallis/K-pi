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
	const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
	if (!match) return null;
	return stripDiffPath(match[2] || match[1]);
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
	const match = /^\+\+\+ [ab]\/(.+)$/u.exec(line);
	return match ? match[1] : null;
}

/**
 * Split one oversized file section into argv-safe pieces on line boundaries.
 * Each piece repeats the leading `diff --git` / `---` / `+++` header so the
 * model still sees a valid unified-diff fragment. Never exceeds maxChunkBytes
 * unless a single line alone is larger (then that line is its own piece).
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
	/** @type {string[]} */
	const header = [];
	let bodyStart = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		header.push(line);
		bodyStart = i + 1;
		// Header ends after the first hunk start or after +++ line when no hunk yet.
		if (line.startsWith("@@ ")) break;
		if (line.startsWith("+++ ") && i + 1 < lines.length && !lines[i + 1].startsWith("@@ ")) {
			// binary or empty body — keep collecting until body-ish content
			continue;
		}
		if (line.startsWith("+++ ")) {
			// include +++ in header; next lines are body unless @@ follows
			if (i + 1 < lines.length && lines[i + 1].startsWith("@@ ")) continue;
			break;
		}
	}
	// Prefer: everything through first @@ line as header when present.
	const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
	if (firstHunk >= 0) {
		header.length = 0;
		header.push(...lines.slice(0, firstHunk)); // meta without first @@
		bodyStart = firstHunk;
	}

	const headerText = header.length ? `${header.join("\n")}\n` : "";
	const headerBytes = Buffer.byteLength(headerText, "utf8");
	const bodyBudget = Math.max(1, maxChunkBytes - headerBytes);

	/** @type {DiffFileSection[]} */
	const pieces = [];
	/** @type {string[]} */
	let body = [];
	let bodyBytes = 0;

	const flushBody = () => {
		if (body.length === 0 && pieces.length > 0) return;
		const text = `${headerText}${body.join("\n")}${body.length ? "\n" : ""}`;
		pieces.push({
			path: section.path,
			text,
			bytes: Buffer.byteLength(text, "utf8"),
		});
		body = [];
		bodyBytes = 0;
	};

	for (let i = bodyStart; i < lines.length; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
		if (body.length > 0 && bodyBytes + lineBytes > bodyBudget) {
			flushBody();
		}
		body.push(line);
		bodyBytes += lineBytes;
		if (lineBytes > bodyBudget && body.length === 1) {
			// Single line exceeds budget — emit alone (caller still sees fail-closed if > hard max).
			flushBody();
		}
	}
	flushBody();
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
