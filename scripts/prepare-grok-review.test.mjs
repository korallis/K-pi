import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ABSOLUTE_MAX_CHUNK_BYTES,
	HARD_MAX_CHUNK_BYTES,
	MIN_CHUNK_BYTES,
} from "./partition-pr-diff.mjs";
import { MATRIX_CAPACITY, prepareGrokReview } from "./prepare-grok-review.mjs";
import { buildPrompt, resolveZaiCatalogPath } from "./run-chunked-grok-review.mjs";
import { MAX_SELECTED_DIFF_BYTES } from "./select-grok-review-input.mjs";

function makeDiff(fileCount, bodyBytes = 800) {
	const parts = [];
	for (let i = 0; i < fileCount; i++) {
		const path = `src/file-${String(i).padStart(3, "0")}.ts`;
		const body = `+${"x".repeat(bodyBytes)}\n`;
		parts.push(
			`diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,1 @@\n${body}`,
		);
	}
	return parts.join("");
}

function writeInventory(dir) {
	const inv = [
		"TRUSTED_PR_INVENTORY",
		"complete:1",
		"scope:selected-plus-priority",
		"NOTE: NOT every changed path is listed when bulk provenance exclusions apply.",
		"paths:",
		"- src/file-000.ts",
		"",
	].join("\n");
	const path = join(dir, "inv.txt");
	writeFileSync(path, inv);
	return path;
}

const CATALOG = resolveZaiCatalogPath();
const MODEL = "glm-5.3-flash";

test("prepare partitions and groups without losing chunks; prompts stay in model budget", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-prep-"));
	try {
		const diffPath = join(dir, "pr.diff");
		writeFileSync(diffPath, makeDiff(12, 2000));
		const inventoryPath = writeInventory(dir);
		const outDir = join(dir, "out");
		const meta = prepareGrokReview({
			diffPath,
			inventoryPath,
			outDir,
			model: MODEL,
			catalogPath: CATALOG,
			maxGroups: 8,
			maxChunksPerGroup: 8,
			maxConcurrency: 2,
		});
		assert.ok(meta.chunkCount >= 1);
		assert.equal(
			meta.groups.reduce((n, g) => n + g.chunkCount, 0),
			meta.chunkCount,
		);
		assert.ok(meta.maxChunkBytes > 96_000, `expected context-sized chunks, got ${meta.maxChunkBytes}`);
		assert.ok(meta.maxChunkBytes <= ABSOLUTE_MAX_CHUNK_BYTES);
		const inv = readFileSync(inventoryPath, "utf8");
		for (const g of meta.groups) {
			const groupDir = join(outDir, "groups", `group-${String(g.group).padStart(2, "0")}`);
			const manifest = JSON.parse(readFileSync(join(groupDir, "manifest.json"), "utf8"));
			for (const c of manifest.chunks) {
				const text = readFileSync(join(groupDir, c.file), "utf8");
				const promptBytes = Buffer.byteLength(buildPrompt(text, inv), "utf8");
				assert.ok(
					promptBytes <= meta.promptBudget,
					`chunk ${c.index} prompt ${promptBytes} exceeds budget ${meta.promptBudget}`,
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
		// Many tiny files with a forced tiny max-chunk-bytes → too many chunks.
		writeFileSync(diffPath, makeDiff(80, 800));
		assert.throws(
			() =>
				prepareGrokReview({
					diffPath,
					inventoryPath: writeInventory(dir),
					outDir: join(dir, "out"),
					model: MODEL,
					catalogPath: CATALOG,
					maxChunkBytes: 4_096,
					maxGroups: 1,
					maxChunksPerGroup: 2,
					maxConcurrency: 2,
				}),
			/exceed matrix capacity/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("matrix byte capacity exceeds the selection byte cap (invariant)", () => {
	assert.equal(MATRIX_CAPACITY, 128);
	assert.equal(HARD_MAX_CHUNK_BYTES, ABSOLUTE_MAX_CHUNK_BYTES);
	assert.ok(
		MATRIX_CAPACITY * HARD_MAX_CHUNK_BYTES >= MAX_SELECTED_DIFF_BYTES,
		`matrix capacity bytes ${MATRIX_CAPACITY * HARD_MAX_CHUNK_BYTES} < select cap ${MAX_SELECTED_DIFF_BYTES}`,
	);
});

test("context-sized prepare packs a multi-MB selection into far fewer than 74 chunks", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-prep-big-"));
	try {
		// ~1.5 MiB of selected diff across many files.
		const diffPath = join(dir, "pr.diff");
		writeFileSync(diffPath, makeDiff(80, 18_000));
		const selectedBytes = Buffer.byteLength(readFileSync(diffPath));
		const meta = prepareGrokReview({
			diffPath,
			inventoryPath: writeInventory(dir),
			outDir: join(dir, "out"),
			model: MODEL,
			catalogPath: CATALOG,
			maxGroups: 8,
			maxChunksPerGroup: 16,
			maxConcurrency: 2,
		});
		assert.ok(meta.maxChunkBytes >= MIN_CHUNK_BYTES);
		assert.ok(meta.maxChunkBytes <= ABSOLUTE_MAX_CHUNK_BYTES);
		assert.ok(
			meta.chunkCount <= MATRIX_CAPACITY,
			`chunkCount ${meta.chunkCount} exceeds capacity ${MATRIX_CAPACITY}`,
		);
		assert.ok(
			meta.chunkCount <= 20,
			`expected ~10–15 context chunks for ${selectedBytes} bytes, got ${meta.chunkCount} at max=${meta.maxChunkBytes}`,
		);
		assert.equal(
			meta.groups.reduce((n, g) => n + g.chunkCount, 0),
			meta.chunkCount,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("adaptive prepare packs an 8 MiB boundary selection into ≤128 chunks", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-prep-8m-"));
	try {
		const target = MAX_SELECTED_DIFF_BYTES;
		// Spread across files so packing can form multiple chunks under context max.
		const perFile = 50_000;
		const files = Math.ceil(target / perFile);
		const diffPath = join(dir, "pr.diff");
		writeFileSync(diffPath, makeDiff(files, perFile));
		let selectedBytes = Buffer.byteLength(readFileSync(diffPath));
		// Trim if overshot slightly
		while (selectedBytes > target + 100_000) {
			// rare; leave as-is for capacity proof
			break;
		}
		const meta = prepareGrokReview({
			diffPath,
			inventoryPath: writeInventory(dir),
			outDir: join(dir, "out"),
			model: MODEL,
			catalogPath: CATALOG,
			maxGroups: 8,
			maxChunksPerGroup: 16,
			maxConcurrency: 2,
		});
		assert.ok(
			meta.chunkCount <= MATRIX_CAPACITY,
			`chunkCount ${meta.chunkCount} exceeds capacity at boundary (selected=${selectedBytes}, maxChunk=${meta.maxChunkBytes})`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
