#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_MAX_CHUNK_BYTES,
	HARD_MAX_CHUNK_BYTES,
	PROMPT_ARGV_TEST_CEILING_BYTES,
	adaptiveMaxChunkBytes,
	parseChunkLocationIndex,
	formatHunkHeader,
	partitionUnifiedDiff,
	splitOversizedSection,
	splitDiffFileSections,
	writeDiffChunks,
} from "./partition-pr-diff.mjs";

function fileDiff(path, bodyLines) {
	const body = bodyLines.map((line) => `+${line}`).join("\n");
	return [
		`diff --git a/${path} b/${path}`,
		`--- /dev/null`,
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

	// Cap just under the first file so packing cannot merge — may yield one
	// chunk per file (or more if a section is split under a tiny cap).
	const two = partitionUnifiedDiff(combined, { maxChunkBytes: Math.max(32, Buffer.byteLength(small, "utf8") - 1) });
	assert.ok(two.length >= 2);
	assert.ok(two.every((chunk) => chunk.bytes <= Math.max(32, Buffer.byteLength(small, "utf8") - 1) || chunk.paths.length >= 1));
	assert.ok(two.some((chunk) => chunk.paths.includes("a.ts")));
	assert.ok(two.some((chunk) => chunk.paths.includes("b.ts")));
});

test("oversized single file splits under the byte cap", () => {
	const big = fileDiff("big.ts", ["z".repeat(200), "y".repeat(200)]);
	const cap = 180;
	const result = partitionUnifiedDiff(big, { maxChunkBytes: cap });
	assert.ok(result.length >= 2);
	for (const chunk of result) {
		assert.ok(chunk.paths.includes("big.ts"));
		assert.match(chunk.text, /^@@ /m);
		const maxLineBytes = Math.max(
			...chunk.text.split("\n").map((line) => Buffer.byteLength(`${line}\n`, "utf8")),
		);
		// Pieces fit the cap unless a single line (plus unavoidable headers) forces overflow.
		assert.ok(
			chunk.bytes <= cap || maxLineBytes + 64 > cap,
			`unexpected overflow bytes=${chunk.bytes} maxLine=${maxLineBytes}`,
		);
	}
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

test("chunk bytes stay under the Linux argv-safe ceiling", () => {
	assert.equal(DEFAULT_MAX_CHUNK_BYTES, 96_000);
	assert.equal(HARD_MAX_CHUNK_BYTES, 96_000);
	assert.ok(DEFAULT_MAX_CHUNK_BYTES <= PROMPT_ARGV_TEST_CEILING_BYTES);
	assert.ok(PROMPT_ARGV_TEST_CEILING_BYTES < 128 * 1024);
});

test("adaptive packing never inflates past the argv-safe hard max", () => {
	assert.equal(adaptiveMaxChunkBytes(1_600_000, { floor: 200_000, waveSlots: 8 }), 96_000);
	assert.equal(adaptiveMaxChunkBytes(100_000, { floor: 96_000, waveSlots: 16 }), 96_000);
	assert.equal(adaptiveMaxChunkBytes(50_000, { floor: 40_000, waveSlots: 16 }), 40_000);
});

test("oversized file sections split under the argv-safe cap", () => {
	const big = fileDiff("big.ts", ["z".repeat(50_000), "y".repeat(50_000), "x".repeat(50_000)]);
	assert.ok(Buffer.byteLength(big, "utf8") > 96_000);
	const pieces = splitOversizedSection(
		{ path: "big.ts", text: big, bytes: Buffer.byteLength(big, "utf8") },
		96_000,
	);
	assert.ok(pieces.length >= 2);
	for (const piece of pieces) {
		assert.ok(piece.bytes <= 96_000, `piece ${piece.bytes} exceeds cap`);
		assert.ok(piece.text.includes("diff --git"));
		assert.match(piece.text, /^diff --git /m);
		assert.match(piece.text, /^@@ /m);
	}
	const chunks = partitionUnifiedDiff(big, { maxChunkBytes: 96_000 });
	assert.ok(chunks.length >= 2);
	assert.ok(chunks.every((chunk) => chunk.bytes <= 96_000));
});

test("oversized split pieces are valid diffs and preserve new-side line union", () => {
	// Multi-hunk + one huge hunk that must sub-split.
	const rows = [];
	for (let i = 0; i < 80; i++) rows.push(`+L${i}-` + "x".repeat(400));
	const text = [
		"diff --git a/big.ts b/big.ts",
		"index 1111111..2222222 100644",
		"--- a/big.ts",
		"+++ b/big.ts",
		"@@ -1,3 +1,4 @@ helper",
		" keep-a",
		"-old-a",
		"+new-a",
		"+add-a",
		" trail-a",
		"@@ -10,2 +12,2 @@ other",
		" keep-b",
		"-old-b",
		"+new-b",
		`@@ -20,0 +22,${rows.length} @@ bulk`,
		...rows,
		"",
	].join("\n");
	const section = { path: "big.ts", text, bytes: Buffer.byteLength(text, "utf8") };
	const original = parseChunkLocationIndex(text);
	const originalLines = new Set(original.newSideLines.get("big.ts") ?? []);
	assert.ok(originalLines.size > 0);

	const cap = 8_000;
	assert.ok(section.bytes > cap);
	const pieces = splitOversizedSection(section, cap);
	assert.ok(pieces.length >= 2);

	const union = new Set();
	for (const piece of pieces) {
		assert.ok(piece.bytes <= cap, `piece ${piece.bytes} > ${cap}`);
		assert.match(piece.text, /^diff --git a\/big\.ts b\/big\.ts$/m);
		assert.match(piece.text, /^--- a\/big\.ts$/m);
		assert.match(piece.text, /^\+\+\+ b\/big\.ts$/m);
		// Every piece must contain at least one synthesized or original hunk header
		// before any body "+" lines (valid unified-diff fragment).
		const lines = piece.text.split("\n");
		const firstPlus = lines.findIndex((line) => line.startsWith("+") && !line.startsWith("+++"));
		const firstAt = lines.findIndex((line) => line.startsWith("@@ "));
		assert.ok(firstAt >= 0, "missing @@ hunk header");
		if (firstPlus >= 0) assert.ok(firstAt < firstPlus, "body before hunk header");

		const idx = parseChunkLocationIndex(piece.text);
		assert.deepEqual(idx.paths, ["big.ts"]);
		for (const line of idx.newSideLines.get("big.ts") ?? []) {
			assert.ok(originalLines.has(line), `fabricated line ${line}`);
			union.add(line);
		}
	}
	assert.deepEqual(
		[...union].sort((a, b) => a - b),
		[...originalLines].sort((a, b) => a - b),
		"union of piece new-side lines must equal the unsplit section",
	);
});

test("formatHunkHeader emits git-compatible counts", () => {
	assert.equal(formatHunkHeader(5, 1, 10, 3, "ctx"), "@@ -5 +10,3 @@ ctx");
	assert.equal(formatHunkHeader(5, 0, 10, 2), "@@ -5,0 +10,2 @@");
});

test("parseChunkLocationIndex indexes new-side lines only", () => {
	const diff = [
		"diff --git a/a.ts b/a.ts",
		"--- a/a.ts",
		"+++ b/a.ts",
		"@@ -1,3 +1,4 @@",
		" keep",
		"-old",
		"+new",
		"+added",
		" trail",
		"",
	].join("\n");
	const index = parseChunkLocationIndex(diff);
	assert.deepEqual(index.paths, ["a.ts"]);
	assert.deepEqual([...index.newSideLines.get("a.ts")].sort((a, b) => a - b), [2, 3]);
});

test("parseChunkLocationIndex leaves deletion-only paths with empty new-side sets", () => {
	const diff = [
		"diff --git a/gone.ts b/gone.ts",
		"--- a/gone.ts",
		"+++ /dev/null",
		"@@ -1,2 +0,0 @@",
		"-one",
		"-two",
		"",
	].join("\n");
	const index = parseChunkLocationIndex(diff);
	assert.ok(index.paths.includes("gone.ts"));
	assert.equal(index.newSideLines.get("gone.ts")?.size ?? 0, 0);
	assert.equal(index.deletionOnlyPaths, undefined);
});
