#!/usr/bin/env node

/**
 * Split a unified git diff into deterministic, size-capped chunks on file
 * boundaries. Whole file sections stay intact; packing is greedy in the order
 * git emitted the sections. A single file larger than the cap becomes its own
 * chunk (still subject to the workflow's overall diff ceiling).
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Default soft cap per concurrent Grok prompt (~two chunks for a ~63 KiB PR). */
export const DEFAULT_MAX_CHUNK_BYTES = 32_000;

/**
 * @typedef {{ path: string, text: string, bytes: number }} DiffFileSection
 * @typedef {{ index: number, paths: string[], text: string, bytes: number }} DiffChunk
 */

/**
 * @param {string} diffText
 * @returns {DiffFileSection[]}
 */
export function splitDiffFileSections(diffText) {
	if (typeof diffText !== "string") throw new Error("diff text must be a string");
	if (diffText.length === 0) return [];

	const lines = diffText.split("\n");
	/** @type {DiffFileSection[]} */
	const sections = [];
	let currentLines = [];
	let currentPath = null;

	const flush = () => {
		if (currentLines.length === 0) return;
		let text = currentLines.join("\n");
		if (text.length > 0 && !text.endsWith("\n")) text += "\n";
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
		if (currentLines.length === 0) {
			currentPath = "preamble";
		}
		if (line.startsWith("+++ ") && currentPath) {
			const plusPath = pathFromPlusPlusLine(line);
			if (plusPath) currentPath = plusPath;
		}
		currentLines.push(line);
	}
	flush();
	return sections;
}

function pathFromDiffGitLine(line) {
	const match = /^diff --git (.+) (.+)$/u.exec(line);
	if (!match) return "unknown";
	return stripDiffPath(match[2]) || stripDiffPath(match[1]) || "unknown";
}

function stripDiffPath(raw) {
	let value = raw.trim();
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
	if (sections.length === 0) return [];

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
	const chunks = partitionUnifiedDiff(diffText, options);
	const manifest = {
		maxChunkBytes: options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES,
		chunkCount: chunks.length,
		totalBytes: Buffer.byteLength(diffText, "utf8"),
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
		console.error("usage: partition-pr-diff.mjs <pr.diff> <out-dir> [max-chunk-bytes]");
		process.exit(2);
	}
	const maxChunkBytes = maxRaw ? Number.parseInt(maxRaw, 10) : DEFAULT_MAX_CHUNK_BYTES;
	const diffText = readFileSync(diffPath, "utf8");
	const manifest = writeDiffChunks(diffText, outDir, { maxChunkBytes });
	console.log(`partitioned ${manifest.totalBytes} byte diff into ${manifest.chunkCount} chunk(s)`);
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
