import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_MAX_CHUNKS_PER_GROUP,
	DEFAULT_MAX_GROUPS,
	HARD_MAX_CHUNKS_PER_GROUP,
	HARD_MAX_GROUPS,
	MATRIX_CAPACITY,
	groupGrokChunks,
	writeGrokChunkGroups,
} from "./group-grok-chunks.mjs";

function chunks(n) {
	return Array.from({ length: n }, (_, i) => ({
		index: i,
		paths: [`f${i}.ts`],
		bytes: 100 + i,
		text: `diff --git a/f${i}.ts b/f${i}.ts\n+x${i}\n`,
	}));
}

test("groupGrokChunks assigns every chunk exactly once", () => {
	const input = chunks(25);
	const { groups, matrix } = groupGrokChunks(input, {
		maxGroups: 4,
		maxChunksPerGroup: 10,
	});
	assert.equal(groups.length, 3);
	assert.equal(matrix.include.length, 3);
	const assigned = groups.flatMap((g) => g.chunkIndexes);
	assert.deepEqual(assigned.sort((a, b) => a - b), input.map((c) => c.index));
	assert.equal(new Set(assigned).size, assigned.length);
});

test("groupGrokChunks fails closed above matrix capacity", () => {
	assert.throws(
		() =>
			groupGrokChunks(chunks(DEFAULT_MAX_GROUPS * DEFAULT_MAX_CHUNKS_PER_GROUP + 1), {
				maxGroups: DEFAULT_MAX_GROUPS,
				maxChunksPerGroup: DEFAULT_MAX_CHUNKS_PER_GROUP,
			}),
		/exceeds matrix capacity/,
	);
});

test("groupGrokChunks rejects duplicate chunk indexes", () => {
	assert.throws(
		() =>
			groupGrokChunks([
				{ index: 0, paths: ["a"], bytes: 1 },
				{ index: 0, paths: ["b"], bytes: 1 },
			]),
		/duplicate chunk index/,
	);
});

test("writeGrokChunkGroups materializes per-group manifests without loss", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-groups-"));
	try {
		const input = chunks(7);
		const plan = writeGrokChunkGroups(input, dir, { maxGroups: 3, maxChunksPerGroup: 3 });
		assert.equal(plan.chunkCount, 7);
		assert.equal(plan.groupCount, 3);
		const matrix = JSON.parse(readFileSync(join(dir, "matrix.json"), "utf8"));
		assert.equal(matrix.include.length, 3);
		const g0 = JSON.parse(readFileSync(join(dir, "groups/group-00/manifest.json"), "utf8"));
		assert.equal(g0.chunks.length, 3);
		assert.equal(g0.chunks[0].index, 0);
		const body = readFileSync(join(dir, "groups/group-00", g0.chunks[0].file), "utf8");
		assert.match(body, /f0\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("defaults and hard ceilings are the acceptance 8×16 contract", () => {
	assert.equal(DEFAULT_MAX_GROUPS, 8);
	assert.equal(DEFAULT_MAX_CHUNKS_PER_GROUP, 16);
	assert.equal(HARD_MAX_GROUPS, 8);
	assert.equal(HARD_MAX_CHUNKS_PER_GROUP, 16);
	assert.equal(MATRIX_CAPACITY, 128);
});

test("groupGrokChunks rejects requests above hard ceilings", () => {
	assert.throws(() => groupGrokChunks(chunks(1), { maxGroups: 9, maxChunksPerGroup: 16 }), /hard ceiling/);
	assert.throws(() => groupGrokChunks(chunks(1), { maxGroups: 8, maxChunksPerGroup: 17 }), /hard ceiling/);
});

test("groupGrokChunks packs 87 chunks into 6 groups under 8×16", () => {
	const { groups } = groupGrokChunks(chunks(87), { maxGroups: 8, maxChunksPerGroup: 16 });
	assert.equal(groups.length, 6);
	assert.equal(groups[0].chunkCount, 16);
	assert.equal(groups[5].chunkCount, 7);
	assert.equal(groups.reduce((n, g) => n + g.chunkCount, 0), 87);
});
