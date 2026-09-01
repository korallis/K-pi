#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_MAX_CHUNK_BYTES,
	partitionUnifiedDiff,
	splitDiffFileSections,
	writeDiffChunks,
} from "./partition-pr-diff.mjs";

function fileDiff(path, bodyLines) {
	const body = bodyLines.map((line) => `+${line}`).join("\n");
	return [
		`diff --git a/${path} b/${path}`,
		`index 1111111..2222222 100644`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -0,0 +1,${bodyLines.length} @@`,
		body,
		"",
	].join("\n");
}

test("empty diff yields no chunks", () => {
	assert.deepEqual(partitionUnifiedDiff(""), []);
});

test("splits on file boundaries and preserves paths", () => {
	const diff = fileDiff("a.ts", ["one"]) + fileDiff("b.ts", ["two"]);
	const sections = splitDiffFileSections(diff);
	assert.equal(sections.length, 2);
	assert.equal(sections[0].path, "a.ts");
	assert.equal(sections[1].path, "b.ts");
});

test("packs files greedily under the byte cap", () => {
	const small = fileDiff("a.ts", ["x"]);
	const another = fileDiff("b.ts", ["y"]);
	const combined = small + another;
	const one = partitionUnifiedDiff(combined, { maxChunkBytes: Buffer.byteLength(combined, "utf8") + 64 });
	assert.equal(one.length, 1);
	assert.deepEqual(one[0].paths, ["a.ts", "b.ts"]);

	const two = partitionUnifiedDiff(combined, { maxChunkBytes: Math.max(1, Buffer.byteLength(small, "utf8") - 1) });
	assert.equal(two.length, 2);
	assert.deepEqual(two[0].paths, ["a.ts"]);
	assert.deepEqual(two[1].paths, ["b.ts"]);
});


test("oversized single file becomes its own chunk", () => {
	const big = fileDiff("big.ts", ["z".repeat(200)]);
	const result = partitionUnifiedDiff(big, { maxChunkBytes: 50 });
	assert.equal(result.length, 1);
	assert.deepEqual(result[0].paths, ["big.ts"]);
	assert.ok(result[0].bytes > 50);
});

test("partition is deterministic for the same input", () => {
	const diff =
		fileDiff("c.ts", ["c"]) + fileDiff("a.ts", ["a".repeat(40)]) + fileDiff("b.ts", ["b".repeat(40)]);
	const left = partitionUnifiedDiff(diff, { maxChunkBytes: 120 });
	const right = partitionUnifiedDiff(diff, { maxChunkBytes: 120 });
	assert.deepEqual(left, right);
	assert.equal(left[0].index, 0);
});

test("writeDiffChunks emits stable names and a manifest", () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-diff-chunks-"));
	try {
		const diff = fileDiff("a.ts", ["one"]) + fileDiff("b.ts", ["two".repeat(30)]);
		const manifest = writeDiffChunks(diff, dir, { maxChunkBytes: 80 });
		assert.equal(manifest.maxChunkBytes, 80);
		assert.ok(manifest.chunkCount >= 1);
		assert.equal(manifest.chunks[0].path, "chunk-000.diff");
		const first = readFileSync(join(dir, "chunk-000.diff"), "utf8");
		assert.ok(first.includes("diff --git"));
		const diskManifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		assert.equal(diskManifest.chunkCount, manifest.chunkCount);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("default chunk cap stays latency-oriented", () => {
	assert.equal(DEFAULT_MAX_CHUNK_BYTES, 96_000);
});

