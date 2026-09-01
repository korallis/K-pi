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

/** Default soft floor per concurrent Grok prompt. */
export const DEFAULT_MAX_CHUNK_BYTES = 200_000;

/** Hard ceiling so one pathologically large file cannot explode a prompt. */
export const HARD_MAX_CHUNK_BYTES = 400_000;

/**
 * Choose a chunk byte cap so selected review input fits roughly one concurrent
 * wave (`ceil(selected / waveSlots)`), never below the floor or above hard max.
 * Provenance reduction owns *what* is reviewed; this only bounds latency.
 *
 * @param {number} selectedBytes
 * @param {{ floor?: number, hardMax?: number, waveSlots?: number }} [opts]
 */
export function adaptiveMaxChunkBytes(
	selectedBytes,
	{ floor = DEFAULT_MAX_CHUNK_BYTES, hardMax = HARD_MAX_CHUNK_BYTES, waveSlots = 8 } = {},
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
	if (!Number.isSafeInteger(hardMax) || hardMax < floor) {
		throw new Error("hardMax must be an integer >= floor");
	}
	const perSlot = Math.ceil(selectedBytes / waveSlots);
	return Math.min(hardMax, Math.max(floor, perSlot));
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
 * @param {string} diffText
 * @param {{ maxChunkBytes?: number }} [options]
 * @returns {DiffChunk[]}
 */
export function partitionUnifiedDiff(diffText, { maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES } = {}) {
	if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) {
		throw new Error("maxChunkBytes must be a positive integer");
	}

	const sections = splitDiffFileSections(diffText);
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
