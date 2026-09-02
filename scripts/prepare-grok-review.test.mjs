import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	HARD_MAX_CHUNK_BYTES,
	MIN_CHUNK_BYTES,
	PROMPT_ARGV_TEST_CEILING_BYTES,
} from "./partition-pr-diff.mjs";
import { MATRIX_CAPACITY, prepareGrokReview } from "./prepare-grok-review.mjs";
import { buildPrompt } from "./run-chunked-grok-review.mjs";
import { MAX_SELECTED_DIFF_BYTES } from "./select-grok-review-input.mjs";

function makeDiff(fileCount, bodyBytes = 800) {
	const parts = [];
	for (let i = 0; i < fileCount; i++) {
		const path = `src/file-${String(i).padStart(3, "0")}.ts`;
		const body = `+${"x".repeat(bodyBytes)}\n`;
		parts.push(
			`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,1 @@\n${body}`,
		);
	}
	return parts.join("");
}

test("prepare partitions and groups without losing chunks; argv includes inventory", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-prep-"));
	try {
		const diffPath = join(dir, "pr.diff");
		const inventoryPath = join(dir, "inv.txt");
		const outDir = join(dir, "out");
		writeFileSync(diffPath, makeDiff(12, 1200));
		writeFileSync(
			inventoryPath,
			[
				"TRUSTED_PR_INVENTORY",
				"v:1",
				"complete:1",
				"scope:selected-plus-priority",
				"rows:1",
				"BEGIN",
				"A0|src/file-000.ts\ti0",
				"END",
				"",
				"TRUSTED_EXCLUSION_SUMMARY",
				"v:1",
				"totalExcluded:0",
				"BEGIN",
				"END",
				"",
			].join("\n"),
		);
		const meta = prepareGrokReview({
			diffPath,
			inventoryPath,
			outDir,
			maxChunkBytes: 4_000,
			maxGroups: 8,
			maxChunksPerGroup: 8,
			maxConcurrency: 8,
		});
		assert.ok(meta.chunkCount >= 1);
		assert.ok(meta.groupCount >= 1);
		assert.equal(
			meta.groups.reduce((n, g) => n + g.chunkCount, 0),
			meta.chunkCount,
		);
		const plan = JSON.parse(readFileSync(join(outDir, "group-plan.json"), "utf8"));
		const assigned = plan.groups.flatMap((g) => g.chunkIndexes);
		assert.equal(new Set(assigned).size, assigned.length);
		assert.equal(assigned.length, meta.chunkCount);

		const inv = readFileSync(inventoryPath, "utf8");
		// Every on-disk group chunk prompt must clear argv ceiling with inventory.
		for (const g of plan.groups) {
			const gdir = join(outDir, "groups", `group-${String(g.group).padStart(2, "0")}`);
			const manifest = JSON.parse(readFileSync(join(gdir, "manifest.json"), "utf8"));
			for (const c of manifest.chunks) {
				const text = readFileSync(join(gdir, c.file), "utf8");
				const promptBytes = Buffer.byteLength(buildPrompt(text, inv), "utf8");
				assert.ok(
					promptBytes <= PROMPT_ARGV_TEST_CEILING_BYTES,
					`chunk ${c.index} prompt ${promptBytes} exceeds argv`,
				);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("prepare fails closed when chunk count exceeds matrix capacity", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-prep-"));
	try {
		const diffPath = join(dir, "pr.diff");
		const outDir = join(dir, "out");
		// Many tiny files → many chunks; tiny matrix capacity.
		writeFileSync(diffPath, makeDiff(30, 40));
		assert.throws(
			() =>
				prepareGrokReview({
					diffPath,
					outDir,
					maxChunkBytes: 200,
					maxGroups: 1,
					maxChunksPerGroup: 2,
					maxConcurrency: 2,
				}),
			/exceeds matrix capacity|grouping overflowed/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("matrix byte capacity exceeds the selection byte cap (invariant)", () => {
	// 128 × 96 KiB = 12.2 MiB > 8 MiB select cap → once selection passes,
	// adaptive packing at hard max has enough room in the byte budget.
	assert.equal(MATRIX_CAPACITY, 128);
	assert.equal(HARD_MAX_CHUNK_BYTES, 96_000);
	assert.ok(
		MATRIX_CAPACITY * HARD_MAX_CHUNK_BYTES >= MAX_SELECTED_DIFF_BYTES,
		`matrix capacity bytes ${MATRIX_CAPACITY * HARD_MAX_CHUNK_BYTES} < select cap ${MAX_SELECTED_DIFF_BYTES}`,
	);
});

test("adaptive prepare packs a real-PR-sized selection into ≤128 chunks", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-prep-large-"));
	try {
		const diffPath = join(dir, "pr.diff");
		const outDir = join(dir, "out");
		// ~4.7 MiB multi-file selected-diff shape (mirrors current fork PR).
		writeFileSync(diffPath, makeDiff(520, 8_800));
		const selectedBytes = Buffer.byteLength(readFileSync(diffPath));
		assert.ok(selectedBytes > 4_000_000, `expected multi-MiB fixture, got ${selectedBytes}`);
		assert.ok(selectedBytes <= MAX_SELECTED_DIFF_BYTES, `fixture ${selectedBytes} exceeds select cap`);

		const meta = prepareGrokReview({
			diffPath,
			outDir,
			maxGroups: 8,
			maxChunksPerGroup: 16,
		});

		const target = Math.ceil(selectedBytes / MATRIX_CAPACITY);
		assert.ok(meta.maxChunkBytes >= Math.min(target, HARD_MAX_CHUNK_BYTES));
		assert.ok(meta.maxChunkBytes <= HARD_MAX_CHUNK_BYTES);
		assert.ok(meta.maxChunkBytes >= MIN_CHUNK_BYTES);
		assert.ok(
			meta.chunkCount <= MATRIX_CAPACITY,
			`chunkCount ${meta.chunkCount} exceeds capacity ${MATRIX_CAPACITY} at maxChunkBytes=${meta.maxChunkBytes}`,
		);
		assert.equal(
			meta.groups.reduce((n, g) => n + g.chunkCount, 0),
			meta.chunkCount,
		);
		const plan = JSON.parse(readFileSync(join(outDir, "group-plan.json"), "utf8"));
		const assigned = plan.groups.flatMap((g) => g.chunkIndexes);
		assert.equal(new Set(assigned).size, assigned.length);
		assert.equal(assigned.length, meta.chunkCount);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("adaptive prepare packs an 8 MiB boundary selection into ≤128 chunks", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-prep-8m-"));
	try {
		const diffPath = join(dir, "pr.diff");
		const outDir = join(dir, "out");
		// Build just under the select cap with many mid-size files.
		writeFileSync(diffPath, makeDiff(900, 9_000));
		const selectedBytes = Buffer.byteLength(readFileSync(diffPath));
		assert.ok(selectedBytes > 7_000_000);
		assert.ok(selectedBytes <= MAX_SELECTED_DIFF_BYTES);

		const meta = prepareGrokReview({
			diffPath,
			outDir,
			maxGroups: 8,
			maxChunksPerGroup: 16,
		});
		assert.ok(
			meta.chunkCount <= MATRIX_CAPACITY,
			`chunkCount ${meta.chunkCount} exceeds capacity at 8MiB boundary (selected=${selectedBytes}, maxChunk=${meta.maxChunkBytes})`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
