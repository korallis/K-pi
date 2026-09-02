#!/usr/bin/env node

/**
 * Trusted prepare step for multi-job Grok review.
 *
 * Assumes select-grok-review-input already wrote the selected diff + prompt inventory.
 * This script partitions the selected diff into argv-safe chunks, groups them into
 * a bounded one-wave matrix, and writes immutable prepare artifacts.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MAX_CHUNK_BYTES,
	HARD_MAX_CHUNK_BYTES,
	MIN_CHUNK_BYTES,
	PROMPT_ARGV_TEST_CEILING_BYTES,
	adaptiveMaxChunkBytes,
	partitionUnifiedDiff,
	writeDiffChunks,
} from "./partition-pr-diff.mjs";
import {
	DEFAULT_MAX_CHUNKS_PER_GROUP,
	DEFAULT_MAX_GROUPS,
	MATRIX_CAPACITY,
	writeGrokChunkGroups,
} from "./group-grok-chunks.mjs";
import {
	INVENTORY_PROMPT_MAX_BYTES,
	PROMPT_FRAMING_RESERVE_BYTES,
	buildPrompt,
	measurePromptFramingBytes,
} from "./run-chunked-grok-review.mjs";

export { DEFAULT_MAX_GROUPS, DEFAULT_MAX_CHUNKS_PER_GROUP, MATRIX_CAPACITY };

/**
 * @param {object} options
 */
export function prepareGrokReview(options) {
	const diffText = readFileSync(options.diffPath, "utf8");
	const selectedBytes = Buffer.byteLength(diffText, "utf8");
	let inventoryText = "";
	let inventoryBytes = 0;
	if (options.inventoryPath) {
		inventoryText = readFileSync(options.inventoryPath, "utf8");
		inventoryBytes = Buffer.byteLength(inventoryText, "utf8");
		if (inventoryBytes > INVENTORY_PROMPT_MAX_BYTES) {
			throw new Error(
				`prompt inventory exceeds ${INVENTORY_PROMPT_MAX_BYTES} bytes (got ${inventoryBytes}); fails closed`,
			);
		}
		if (!/^complete:1$/m.test(inventoryText)) {
			throw new Error("prompt inventory is not marked complete:1");
		}
		if (/^omitted:/m.test(inventoryText)) {
			throw new Error("prompt inventory claims omissions; fails closed");
		}
		// Reject only a false claim that every changed path is inline (allow "NOT every...").
		if (
			/scope:selected-plus-priority/m.test(inventoryText) &&
			/(^|[^\w])every changed path is listed/im.test(inventoryText) &&
			!/NOT every changed/i.test(inventoryText)
		) {
			throw new Error("scoped inventory must not claim every changed path is listed");
		}
	}

	const maxGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS;
	const maxChunksPerGroup = options.maxChunksPerGroup ?? DEFAULT_MAX_CHUNKS_PER_GROUP;
	const maxConcurrency = options.maxConcurrency ?? maxChunksPerGroup;
	const matrixSlots = maxGroups * maxChunksPerGroup;

	const framingBytes = measurePromptFramingBytes(inventoryText);
	const argvRoomForChunk = PROMPT_ARGV_TEST_CEILING_BYTES - framingBytes;
	if (argvRoomForChunk < 4_096) {
		throw new Error(
			`inventory+framing leave only ${argvRoomForChunk} bytes for diff chunks under argv ceiling ${PROMPT_ARGV_TEST_CEILING_BYTES}`,
		);
	}

	// --max-chunk-bytes is an optional hard ceiling (default argv-safe 96 KiB),
	// not a lock. Adaptive packing targets ceil(selected / matrixSlots) with slack.
	const hardMax = Math.min(
		options.maxChunkBytes ?? HARD_MAX_CHUNK_BYTES,
		argvRoomForChunk,
		HARD_MAX_CHUNK_BYTES,
	);
	let maxChunkBytes = adaptiveMaxChunkBytes(selectedBytes, {
		floor: Math.min(MIN_CHUNK_BYTES, hardMax),
		hardMax,
		waveSlots: matrixSlots,
	});

	let chunks = partitionUnifiedDiff(diffText, { maxChunkBytes });
	// If greedy packing still overshoots capacity, raise to the argv-safe hard
	// max once. Byte budget 128×96KiB > 8MiB select cap; remaining overflow is
	// a genuine fail-closed case (pathological section shapes).
	if (chunks.length > matrixSlots && maxChunkBytes < hardMax) {
		maxChunkBytes = hardMax;
		chunks = partitionUnifiedDiff(diffText, { maxChunkBytes });
	}

	mkdirSync(options.outDir, { recursive: true });
	const chunksDir = join(options.outDir, "chunks");
	writeDiffChunks(diffText, chunksDir, { maxChunkBytes });

	// Prove every chunk prompt stays under argv ceiling including inventory context.
	for (const chunk of chunks) {
		const promptBytes = Buffer.byteLength(buildPrompt(chunk.text, inventoryText), "utf8");
		if (promptBytes > PROMPT_ARGV_TEST_CEILING_BYTES) {
			throw new Error(
				`failed closed: chunk ${chunk.index} prompt is ${promptBytes} bytes above argv ceiling ${PROMPT_ARGV_TEST_CEILING_BYTES}`,
			);
		}
	}

	const chunkManifest = chunks.map((c) => ({
		index: c.index,
		paths: c.paths,
		bytes: c.bytes,
		text: c.text,
		file: `chunk-${String(c.index).padStart(3, "0")}.diff`,
	}));
	writeFileSync(join(chunksDir, "manifest.json"), `${JSON.stringify({ chunks: chunkManifest.map(({ text, ...rest }) => rest) }, null, 2)}\n`);

	const plan = writeGrokChunkGroups(chunkManifest, options.outDir, {
		maxGroups,
		maxChunksPerGroup,
	});

	const meta = {
		selectedDiffBytes: selectedBytes,
		inventoryBytes,
		maxChunkBytes,
		chunkCount: chunks.length,
		groupCount: plan.groupCount,
		maxGroups,
		maxChunksPerGroup,
		maxConcurrency,
		argvCeiling: PROMPT_ARGV_TEST_CEILING_BYTES,
		framingBytes,
		argvRoomForChunk,
		groups: plan.groups,
		matrix: plan.matrix,
	};
	writeFileSync(join(options.outDir, "prepare-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
	// GitHub Actions matrix JSON (may be empty include when no chunks).
	writeFileSync(join(options.outDir, "matrix.json"), `${JSON.stringify(plan.matrix, null, 2)}\n`);
	return meta;
}

function parseArgs(argv) {
	const opts = {
		maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
		maxGroups: DEFAULT_MAX_GROUPS,
		maxChunksPerGroup: DEFAULT_MAX_CHUNKS_PER_GROUP,
		maxConcurrency: DEFAULT_MAX_CHUNKS_PER_GROUP,
		inventoryPath: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--diff":
				opts.diffPath = next();
				break;
			case "--inventory":
				opts.inventoryPath = next();
				break;
			case "--out-dir":
				opts.outDir = next();
				break;
			case "--max-chunk-bytes":
				opts.maxChunkBytes = Number.parseInt(next(), 10);
				break;
			case "--max-groups":
				opts.maxGroups = Number.parseInt(next(), 10);
				break;
			case "--max-chunks-per-group":
				opts.maxChunksPerGroup = Number.parseInt(next(), 10);
				break;
			case "--max-concurrency":
				opts.maxConcurrency = Number.parseInt(next(), 10);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	for (const key of ["diffPath", "outDir"]) {
		if (!opts[key]) throw new Error(`missing required --${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`);
	}
	return opts;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const meta = prepareGrokReview(opts);
	console.log(
		`prepare grok review: chunks=${meta.chunkCount} groups=${meta.groupCount} maxChunkBytes=${meta.maxChunkBytes} selected=${meta.selectedDiffBytes}`,
	);
}

function invokedDirectly() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedDirectly()) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
