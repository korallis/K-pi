#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unionGrokFindings } from "./validate-grok-review.mjs";
import {
	DEFAULT_CHUNK_TIMEOUT_SEC,
	DEFAULT_MAX_CONCURRENCY,
	REQUIRED_EFFORT,
	mapPool,
	runChunkedGrokReview,
} from "./run-chunked-grok-review.mjs";

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

function finding(overrides = {}) {
	return {
		id: "grok-sample",
		severity: "P1",
		path: "a.ts",
		line: 1,
		title: "Broken contract",
		body: "Return the validated array before counting length.",
		...overrides,
	};
}

test("mapPool preserves order under concurrency", async () => {
	const seen = [];
	const results = await mapPool([10, 20, 30, 40], 2, async (value, index) => {
		seen.push(index);
		await new Promise((resolve) => setTimeout(resolve, 5 - index));
		return value * 2;
	});
	assert.deepEqual(results, [20, 40, 60, 80]);
	assert.equal(seen.length, 4);
});

test("union dedupes identical ids and sorts deterministically", () => {
	const a = finding({ id: "grok-b", severity: "P2", path: "b.ts" });
	const b = finding({ id: "grok-a", severity: "P0", path: "a.ts" });
	const dup = finding({ id: "grok-a", severity: "P0", path: "a.ts" });
	const merged = unionGrokFindings([[a], [b, dup]]);
	assert.deepEqual(
		merged.map((row) => row.id),
		["grok-a", "grok-b"],
	);
});

test("union fails closed on conflicting ids", () => {
	assert.throws(
		() =>
			unionGrokFindings([
				[finding({ id: "grok-x", title: "One" })],
				[finding({ id: "grok-x", title: "Two" })],
			]),
		/conflicting findings/,
	);
});

test("empty diff skips inference and records zero chunks", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-chunked-empty-"));
	try {
		const diffPath = join(dir, "pr.diff");
		const pathsPath = join(dir, "changed");
		writeFileSync(diffPath, "");
		writeFileSync(pathsPath, "");
		let calls = 0;
		const { findings, meta } = await runChunkedGrokReview(
			{
				diffPath,
				changedPathsPath: pathsPath,
				model: "grok-4.6",
				effort: REQUIRED_EFFORT,
				outJson: join(dir, "out.json"),
				outMeta: join(dir, "meta.json"),
				workDir: join(dir, "work"),
				maxChunkBytes: 100,
				maxConcurrency: 2,
				chunkTimeoutSec: 30,
				maxAiCredits: 1,
				copilotBin: "copilot",
			},
			{
				runCommand: async () => {
					calls += 1;
					return { ok: true, reason: "success", stdout: "[]", stderr: "", code: 0 };
				},
			},
		);
		assert.equal(calls, 0);
		assert.deepEqual(findings, []);
		assert.equal(meta.chunkCount, 0);
		assert.equal(meta.model, "grok-4.6");
		assert.equal(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runs concurrent chunks, validates each, unions findings, records model and chunk count", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-chunked-ok-"));
	try {
		const diff =
			fileDiff("a.ts", ["a".repeat(40)]) + fileDiff("b.ts", ["b".repeat(40)]) + fileDiff("c.ts", ["c".repeat(40)]);
		const diffPath = join(dir, "pr.diff");
		const pathsPath = join(dir, "changed");
		writeFileSync(diffPath, diff);
		writeFileSync(pathsPath, "a.ts\0b.ts\0c.ts\0");

		const calls = [];
		const { findings, meta } = await runChunkedGrokReview(
			{
				diffPath,
				changedPathsPath: pathsPath,
				model: "grok-4.6",
				effort: "high",
				outJson: join(dir, "out.json"),
				outMeta: join(dir, "meta.json"),
				workDir: join(dir, "work"),
				maxChunkBytes: 120,
				maxConcurrency: 3,
				chunkTimeoutSec: 30,
				maxAiCredits: 5,
				copilotBin: "copilot",
			},
			{
				runCommand: async (spec) => {
					calls.push(spec.model);
					assert.equal(spec.effort, "high");
					assert.equal(spec.model, "grok-4.6");
					const path = spec.prompt.includes("a.ts")
						? "a.ts"
						: spec.prompt.includes("b.ts")
							? "b.ts"
							: "c.ts";
					return {
						ok: true,
						reason: "success",
						stdout: JSON.stringify([
							finding({
								id: `grok-${path.replace(".", "")}`,
								path,
								title: `Issue in ${path}`,
							}),
						]),
						stderr: "",
						code: 0,
					};
				},
			},
		);

		assert.ok(calls.length >= 2);
		assert.equal(meta.model, "grok-4.6");
		assert.equal(meta.chunkCount, calls.length);
		assert.equal(meta.findingCount, findings.length);
		assert.ok(findings.length >= 2);
		assert.ok(findings.every((row) => row.id.startsWith("grok-")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("any chunk timeout fails closed without publishing partial findings", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-chunked-fail-"));
	try {
		const diff = fileDiff("a.ts", ["aaaa"]) + fileDiff("b.ts", ["bbbb"]);
		const diffPath = join(dir, "pr.diff");
		const pathsPath = join(dir, "changed");
		writeFileSync(diffPath, diff);
		writeFileSync(pathsPath, "a.ts\0b.ts\0");
		let call = 0;
		await assert.rejects(
			() =>
				runChunkedGrokReview(
					{
						diffPath,
						changedPathsPath: pathsPath,
						model: "grok-4.6",
						effort: "high",
						outJson: join(dir, "out.json"),
						outMeta: join(dir, "meta.json"),
						workDir: join(dir, "work"),
						maxChunkBytes: 40,
						maxConcurrency: 2,
						chunkTimeoutSec: 30,
						maxAiCredits: 1,
						copilotBin: "copilot",
					},
					{
						runCommand: async () => {
							call += 1;
							if (call === 1) {
								return {
									ok: true,
									reason: "success",
									stdout: JSON.stringify([finding()]),
									stderr: "",
									code: 0,
								};
							}
							return { ok: false, reason: "timeout", stdout: "", stderr: "timed out", code: null };
						},
					},
				),
			/failed closed/,
		);
		const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
		assert.equal(meta.model, "grok-4.6");
		assert.ok(meta.chunkCount >= 1);
		assert.equal(meta.findingCount, null);
		assert.ok(meta.chunks.some((chunk) => chunk.reason === "timeout"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("invalid chunk schema fails closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-chunked-schema-"));
	try {
		const diff = fileDiff("a.ts", ["hello"]);
		const diffPath = join(dir, "pr.diff");
		const pathsPath = join(dir, "changed");
		writeFileSync(diffPath, diff);
		writeFileSync(pathsPath, "a.ts\0");
		await assert.rejects(
			() =>
				runChunkedGrokReview(
					{
						diffPath,
						changedPathsPath: pathsPath,
						model: "grok-4.6",
						effort: "high",
						outJson: join(dir, "out.json"),
						outMeta: join(dir, "meta.json"),
						workDir: join(dir, "work"),
						maxChunkBytes: 1000,
						maxConcurrency: 1,
						chunkTimeoutSec: 30,
						maxAiCredits: 1,
						copilotBin: "copilot",
					},
					{
						runCommand: async () => ({
							ok: true,
							reason: "success",
							stdout: "not-json",
							stderr: "",
							code: 0,
						}),
					},
				),
			/invalid-schema|failed closed/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("budget defaults stay latency-bound", () => {
	assert.equal(REQUIRED_EFFORT, "high");
	assert.equal(DEFAULT_MAX_CONCURRENCY, 4);
	assert.equal(DEFAULT_CHUNK_TIMEOUT_SEC, 600);
});
