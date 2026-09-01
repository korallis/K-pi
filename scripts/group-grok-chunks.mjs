#!/usr/bin/env node

/**
 * Deterministic grouping of partitioned Grok diff chunks into one-wave matrix jobs.
 *
 * Capacity is finite and fail-closed: every chunk is assigned exactly once;
 * overflowing maxGroups × maxChunksPerGroup fails rather than sampling.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One-wave matrix hard ceiling: ≤8 groups (acceptance contract). */
export const DEFAULT_MAX_GROUPS = 8;
export const HARD_MAX_GROUPS = 8;
/** Concurrent chunks inside one hosted inference job (≤16 per group). */
export const DEFAULT_MAX_CHUNKS_PER_GROUP = 16;
export const HARD_MAX_CHUNKS_PER_GROUP = 16;
/** Finite matrix capacity — exceed fails closed; never sample. */
export const MATRIX_CAPACITY = HARD_MAX_GROUPS * HARD_MAX_CHUNKS_PER_GROUP;

/**
 * @typedef {{ index: number, paths: string[], text?: string, bytes: number }} ChunkLike
 * @typedef {{ group: number, chunkIndexes: number[], chunkCount: number, bytes: number }} ChunkGroup
 */

/**
 * Pack chunks sequentially into groups. Never duplicates or drops indexes.
 *
 * @param {ChunkLike[]} chunks
 * @param {{ maxGroups?: number, maxChunksPerGroup?: number }} [opts]
 * @returns {{ groups: ChunkGroup[], matrix: { include: Array<{ group: number }> } }}
 */
export function groupGrokChunks(chunks, opts = {}) {
	const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;
	const maxChunksPerGroup = opts.maxChunksPerGroup ?? DEFAULT_MAX_CHUNKS_PER_GROUP;
	if (!Number.isSafeInteger(maxGroups) || maxGroups < 1) {
		throw new Error("maxGroups must be a positive integer");
	}
	if (!Number.isSafeInteger(maxChunksPerGroup) || maxChunksPerGroup < 1) {
		throw new Error("maxChunksPerGroup must be a positive integer");
	}
	if (maxGroups > HARD_MAX_GROUPS) {
		throw new Error(`maxGroups ${maxGroups} exceeds hard ceiling ${HARD_MAX_GROUPS}`);
	}
	if (maxChunksPerGroup > HARD_MAX_CHUNKS_PER_GROUP) {
		throw new Error(
			`maxChunksPerGroup ${maxChunksPerGroup} exceeds hard ceiling ${HARD_MAX_CHUNKS_PER_GROUP}`,
		);
	}
	if (!Array.isArray(chunks)) throw new Error("chunks must be an array");

	const capacity = maxGroups * maxChunksPerGroup;
	if (chunks.length > capacity) {
		throw new Error(
			`chunk count ${chunks.length} exceeds matrix capacity ${capacity} (${maxGroups} groups × ${maxChunksPerGroup} chunks); fails closed`,
		);
	}

	/** @type {Set<number>} */
	const seen = new Set();
	for (const chunk of chunks) {
		if (!chunk || !Number.isSafeInteger(chunk.index) || chunk.index < 0) {
			throw new Error("each chunk requires a non-negative integer index");
		}
		if (seen.has(chunk.index)) {
			throw new Error(`duplicate chunk index ${chunk.index}`);
		}
		seen.add(chunk.index);
	}

	// Stable order by index so assignment is deterministic regardless of input order.
	const ordered = [...chunks].sort((a, b) => a.index - b.index);
	/** @type {ChunkGroup[]} */
	const groups = [];
	if (ordered.length === 0) {
		return { groups: [], matrix: { include: [] } };
	}

	for (let i = 0; i < ordered.length; i += maxChunksPerGroup) {
		const slice = ordered.slice(i, i + maxChunksPerGroup);
		const group = groups.length;
		if (group >= maxGroups) {
			throw new Error(
				`grouping overflowed maxGroups ${maxGroups} with ${ordered.length} chunks`,
			);
		}
		groups.push({
			group,
			chunkIndexes: slice.map((c) => c.index),
			chunkCount: slice.length,
			bytes: slice.reduce((sum, c) => sum + (Number.isFinite(c.bytes) ? c.bytes : 0), 0),
		});
	}

	// Prove covering bijection: every input index appears once across groups.
	const assigned = groups.flatMap((g) => g.chunkIndexes);
	if (assigned.length !== ordered.length) {
		throw new Error("group assignment lost or gained chunks");
	}
	const assignedSet = new Set(assigned);
	if (assignedSet.size !== assigned.length) {
		throw new Error("group assignment duplicated a chunk index");
	}
	for (const chunk of ordered) {
		if (!assignedSet.has(chunk.index)) {
			throw new Error(`chunk ${chunk.index} was not assigned to any group`);
		}
	}

	return {
		groups,
		matrix: { include: groups.map((g) => ({ group: g.group })) },
	};
}

/**
 * Write group manifests under outDir/groups and return the matrix payload.
 *
 * @param {ChunkLike[]} chunks
 * @param {string} outDir
 * @param {{ maxGroups?: number, maxChunksPerGroup?: number }} [opts]
 */
export function writeGrokChunkGroups(chunks, outDir, opts = {}) {
	const { groups, matrix } = groupGrokChunks(chunks, opts);
	mkdirSync(outDir, { recursive: true });
	const groupsDir = join(outDir, "groups");
	mkdirSync(groupsDir, { recursive: true });

	const byIndex = new Map(chunks.map((c) => [c.index, c]));
	for (const group of groups) {
		const dir = join(groupsDir, `group-${String(group.group).padStart(2, "0")}`);
		mkdirSync(dir, { recursive: true });
		/** @type {Array<{ index: number, paths: string[], bytes: number, file: string }>} */
		const entries = [];
		for (const index of group.chunkIndexes) {
			const chunk = byIndex.get(index);
			if (!chunk) throw new Error(`missing chunk body for index ${index}`);
			if (typeof chunk.text !== "string" || chunk.text.length === 0) {
				throw new Error(`chunk ${index} missing non-empty diff text; fails closed`);
			}
			const file = `chunk-${String(index).padStart(3, "0")}.diff`;
			// Confinement: only the deterministic basename under the group dir.
			writeFileSync(join(dir, file), chunk.text.endsWith("\n") ? chunk.text : `${chunk.text}\n`);
			entries.push({
				index,
				paths: Array.isArray(chunk.paths) ? [...chunk.paths] : [],
				bytes: chunk.bytes ?? Buffer.byteLength(chunk.text, "utf8"),
				file,
			});
		}
		if (entries.length !== group.chunkCount) {
			throw new Error(
				`group ${group.group} manifest chunkCount ${group.chunkCount} != entries ${entries.length}`,
			);
		}
		const manifest = {
			group: group.group,
			chunkCount: group.chunkCount,
			bytes: group.bytes,
			chunks: entries,
		};
		writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	}

	const plan = {
		maxGroups: opts.maxGroups ?? DEFAULT_MAX_GROUPS,
		maxChunksPerGroup: opts.maxChunksPerGroup ?? DEFAULT_MAX_CHUNKS_PER_GROUP,
		chunkCount: chunks.length,
		groupCount: groups.length,
		groups: groups.map((g) => ({
			group: g.group,
			chunkIndexes: g.chunkIndexes,
			chunkCount: g.chunkCount,
			bytes: g.bytes,
		})),
		matrix,
	};
	writeFileSync(join(outDir, "group-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
	writeFileSync(join(outDir, "matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
	return plan;
}

function parseArgs(argv) {
	const opts = {
		maxGroups: DEFAULT_MAX_GROUPS,
		maxChunksPerGroup: DEFAULT_MAX_CHUNKS_PER_GROUP,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--chunks-manifest":
				opts.chunksManifest = next();
				break;
			case "--out-dir":
				opts.outDir = next();
				break;
			case "--max-groups":
				opts.maxGroups = Number.parseInt(next(), 10);
				break;
			case "--max-chunks-per-group":
				opts.maxChunksPerGroup = Number.parseInt(next(), 10);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!opts.chunksManifest || !opts.outDir) {
		throw new Error("required: --chunks-manifest and --out-dir");
	}
	return opts;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const raw = JSON.parse(readFileSync(opts.chunksManifest, "utf8"));
	const chunks = Array.isArray(raw) ? raw : raw.chunks;
	if (!Array.isArray(chunks)) throw new Error("chunks-manifest must be an array or {chunks:[]}");
	const plan = writeGrokChunkGroups(chunks, opts.outDir, {
		maxGroups: opts.maxGroups,
		maxChunksPerGroup: opts.maxChunksPerGroup,
	});
	console.log(
		`grok groups: chunks=${plan.chunkCount} groups=${plan.groupCount} maxGroups=${plan.maxGroups} maxPerGroup=${plan.maxChunksPerGroup}`,
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
