import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROMPT_ARGV_TEST_CEILING_BYTES } from "./partition-pr-diff.mjs";
import { prepareGrokReview } from "./prepare-grok-review.mjs";
import { buildPrompt } from "./run-chunked-grok-review.mjs";

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
