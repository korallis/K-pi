#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unionGrokFindings } from "./validate-grok-review.mjs";
import {
	DEFAULT_CHUNK_TIMEOUT_SEC,
	DEFAULT_MAX_CHUNK_BYTES,
	DEFAULT_MAX_CONCURRENCY,
	PROMPT_ARGV_TEST_CEILING_BYTES,
	REQUIRED_EFFORT,
	copilotSpawnEnv,
	mapPool,
	runChunkedGrokReview,
	runGroupGrokReview,
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

test("any chunk timeout fails closed but still writes partial findings artifacts", async () => {
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
		assert.equal(meta.partialFindingCount, 1);
		assert.ok(meta.chunks.some((chunk) => chunk.reason === "timeout"));
		const partial = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
		assert.equal(partial.length, 1);
		assert.equal(partial[0].id, "grok-sample");
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

test("union overflow writes full validated findings then fails closed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-chunked-overflow-"));
	try {
		let call = 0;
		// Three files each larger than the pack cap → three chunks; 12 findings each.
		// Adaptive cap for 3 chunks is 30; 36 unique findings overflow with full artifact.
		const diff =
			fileDiff("a.ts", ["a".repeat(80)]) +
			fileDiff("b.ts", ["b".repeat(80)]) +
			fileDiff("c.ts", ["c".repeat(80)]);
		const diffPath = join(dir, "pr.diff");
		const pathsPath = join(dir, "changed");
		writeFileSync(diffPath, diff);
		writeFileSync(pathsPath, "a.ts\0b.ts\0c.ts\0");
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
						maxChunkBytes: 120,
						maxConcurrency: 3,
						chunkTimeoutSec: 30,
						maxAiCredits: 5,
						copilotBin: "copilot",
					},
					{
						runCommand: async (spec) => {
							call += 1;
							const path = spec.prompt.includes("a.ts")
								? "a.ts"
								: spec.prompt.includes("b.ts")
									? "b.ts"
									: "c.ts";
							const findings = Array.from({ length: 12 }, (_, index) =>
								finding({
									id: `grok-call${call}-f${index}`,
									path,
									line: 1,
									title: `Issue call${call} ${index}`,
									body: `Body call${call} ${index}`,
								}),
							);
							return {
								ok: true,
								reason: "success",
								stdout: JSON.stringify(findings),
								stderr: "",
								code: 0,
							};
						},
					},
				),
			/adaptive cap|union exceeds/,
		);
		const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
		const findings = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
		assert.equal(meta.overflow, true);
		assert.ok(meta.chunkCount >= 3);
		assert.equal(meta.adaptiveUnionCap, Math.min(200, Math.max(20, meta.chunkCount * 10)));
		assert.ok(findings.length > meta.adaptiveUnionCap);
		assert.equal(meta.findingCount, findings.length);
		assert.ok(findings.every((row) => row.id.startsWith("grok-")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});



test("budget defaults stay latency-bound under argv ceiling", () => {
	assert.equal(REQUIRED_EFFORT, "high");
	assert.equal(DEFAULT_MAX_CONCURRENCY, 16);
	assert.equal(DEFAULT_CHUNK_TIMEOUT_SEC, 720);
	assert.equal(DEFAULT_MAX_CHUNK_BYTES, 96_000);
	// Prompt argv element must stay under the conservative 100 KiB ceiling
	// (Linux MAX_ARG_STRLEN is ~128 KiB; preamble is a few KiB on top of the chunk).
	assert.ok(DEFAULT_MAX_CHUNK_BYTES < PROMPT_ARGV_TEST_CEILING_BYTES);
	assert.ok(PROMPT_ARGV_TEST_CEILING_BYTES < 128 * 1024);
	// Provenance-reduced PR3-scale selection (~1.43 MB) fits one concurrent wave.
	const provenanceReducedMax = 1_450_000;
	const chunksNeeded = Math.ceil(provenanceReducedMax / DEFAULT_MAX_CHUNK_BYTES);
	assert.ok(
		chunksNeeded <= DEFAULT_MAX_CONCURRENCY,
		`need ${chunksNeeded} chunks <= concurrency ${DEFAULT_MAX_CONCURRENCY}`,
	);
	// Spawn env must not forward the Actions GITHUB_TOKEN.
	const env = copilotSpawnEnv({ PATH: "/bin", HOME: "/tmp", COPILOT_GITHUB_TOKEN: "t", GITHUB_TOKEN: "nope", GH_TOKEN: "nope" });
	assert.equal(env.COPILOT_GITHUB_TOKEN, "t");
	assert.equal(env.GITHUB_TOKEN, "");
	assert.equal(env.GH_TOKEN, "");
	assert.equal(env.PATH, "/bin");
});


test("inventory makes lockfile replacement visible in every chunk prompt without file contents", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-inv-"));
	try {
		const { buildReviewInventory } = await import("./select-grok-review-input.mjs");
		const diff = fileDiff("a.ts", ["change"]);
		const diffPath = join(dir, "pr.diff");
		const pathsPath = join(dir, "changed");
		const invPath = join(dir, "inv.txt");
		writeFileSync(diffPath, diff);
		writeFileSync(pathsPath, "a.ts\0");
		const inv = buildReviewInventory({
			rows: [
				{ path: "package-lock.json", decision: "exclude", reason: "covered-artifact", check: "check" },
				{ path: "pnpm-lock.yaml", decision: "exclude", reason: "covered-artifact", check: "check" },
				{ path: "a.ts", decision: "include", reason: "first-party" },
			],
			statusByPath: new Map([
				["package-lock.json", "A"],
				["pnpm-lock.yaml", "D"],
				["a.ts", "M"],
			]),
		});
		writeFileSync(invPath, inv.text);
		let sawInventory = false;
		await runChunkedGrokReview(
			{
				diffPath,
				changedPathsPath: pathsPath,
				inventoryPath: invPath,
				model: "grok-4.6",
				effort: "high",
				outJson: join(dir, "out.json"),
				outMeta: join(dir, "meta.json"),
				workDir: join(dir, "work"),
				maxChunkBytes: 96_000,
				maxConcurrency: 2,
				chunkTimeoutSec: 30,
				maxAiCredits: 5,
				copilotBin: "copilot",
			},
			{
				runCommand: async (spec) => {
					assert.match(spec.prompt, /TRUSTED_PR_INVENTORY/);
					assert.match(spec.prompt, /^complete:1$/m);
					assert.match(spec.prompt, /package-lock\.json/);
					// Front-coded body may split "pnpm-lock.yaml" after shared "p" with package-lock.json.
					assert.match(spec.prompt, /npm-lock\.yaml|pnpm-lock\.yaml/);
					assert.match(spec.prompt, /covered-artifact:check/);
					assert.equal(/^omitted:/m.test(spec.prompt), false);
					assert.equal(spec.prompt.includes("node_modules"), false);
					assert.ok(Buffer.byteLength(spec.prompt, "utf8") <= PROMPT_ARGV_TEST_CEILING_BYTES);
					sawInventory = true;
					return { ok: true, reason: "success", stdout: "[]", stderr: "", code: 0 };
				},
			},
		);
		assert.equal(sawInventory, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("inventory sits outside the untrusted envelope with nonce delimiters", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-inv-delim-"));
	try {
		const { buildReviewInventory } = await import("./select-grok-review-input.mjs");
		const { buildPrompt, untrustedDiffDelimiters } = await import("./run-chunked-grok-review.mjs");
		const inv = buildReviewInventory({
			rows: [{ path: "a.ts", decision: "include", reason: "first-party" }],
			statusByPath: new Map([["a.ts", "M"]]),
		});
		const delim = untrustedDiffDelimiters("abc123");
		const prompt = buildPrompt("diff --git a/a.ts b/a.ts\n+hi\n", inv.text, delim);
		const invAt = prompt.indexOf("TRUSTED_PR_INVENTORY");
		const beginAt = prompt.indexOf(delim.begin);
		const endAt = prompt.indexOf(delim.end);
		const diffAt = prompt.indexOf("diff --git");
		assert.ok(invAt >= 0 && beginAt > invAt, "inventory before BEGIN");
		assert.ok(diffAt > beginAt && endAt > diffAt, "diff inside envelope");
		assert.match(prompt, /BEGIN UNTRUSTED DIFF abc123/);
		assert.match(prompt, /END UNTRUSTED DIFF abc123/);
		// Fixed delimiter without nonce must not be the only closer
		assert.equal(prompt.includes("\nEND UNTRUSTED DIFF\n"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("runGroupGrokReview reviews each assigned chunk once and never duplicates", async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-group-run-"));
	try {
		const groupDir = join(dir, "group");
		mkdirSync(groupDir, { recursive: true });
		const c0 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
		const c1 = "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n";
		writeFileSync(join(groupDir, "chunk-000.diff"), c0);
		writeFileSync(join(groupDir, "chunk-001.diff"), c1);
		const manifest = {
			group: 3,
			chunkCount: 2,
			chunks: [
				{ index: 0, paths: ["a.ts"], bytes: c0.length, file: "chunk-000.diff" },
				{ index: 1, paths: ["b.ts"], bytes: c1.length, file: "chunk-001.diff" },
			],
		};
		const manifestPath = join(groupDir, "manifest.json");
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const inv = [
			"TRUSTED_PR_INVENTORY",
			"v:1",
			"complete:1",
			"scope:selected-plus-priority",
			"rows:2",
			"BEGIN",
			"M0|a.ts\ti0",
			"M0|b.ts\ti0",
			"END",
			"",
		].join("\n");
		const invPath = join(dir, "inv.txt");
		writeFileSync(invPath, inv);
		const seen = [];
		const result = await runGroupGrokReview(
			{
				groupManifestPath: manifestPath,
				groupDir,
				inventoryPath: invPath,
				model: "grok-4.6",
				effort: "high",
				maxConcurrency: 2,
				chunkTimeoutSec: 30,
				maxAiCredits: 5,
				copilotBin: "copilot",
				outJson: join(dir, "out.json"),
				outMeta: join(dir, "meta.json"),
				workDir: join(dir, "work"),
			},
			{
				runCommand: async ({ prompt }) => {
					seen.push(prompt);
					return { ok: true, stdout: "[]", stderr: "", reason: "success" };
				},
			},
		);
		assert.equal(result.ok, true);
		assert.equal(result.group, 3);
		assert.equal(result.chunkCount, 2);
		assert.equal(seen.length, 2);
		assert.equal(new Set(seen).size, 2);
		assert.match(seen[0], /TRUSTED_PR_INVENTORY/);
		assert.match(seen[0], /BEGIN UNTRUSTED DIFF/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("runGroupGrokReview rejects chunkCount mismatch and path escape", async () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-group-bad-"));
	try {
		const groupDir = join(dir, "group");
		mkdirSync(groupDir, { recursive: true });
		const c0 = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
		writeFileSync(join(groupDir, "chunk-000.diff"), c0);
		writeFileSync(
			join(groupDir, "manifest.json"),
			JSON.stringify({
				group: 0,
				chunkCount: 2,
				chunks: [{ index: 0, paths: ["a.ts"], bytes: c0.length, file: "chunk-000.diff" }],
			}),
		);
		await assert.rejects(
			() =>
				runGroupGrokReview({
					groupManifestPath: join(groupDir, "manifest.json"),
					groupDir,
					model: "grok-4.6",
					effort: "high",
					maxConcurrency: 2,
					chunkTimeoutSec: 30,
					maxAiCredits: 5,
					copilotBin: "copilot",
					outJson: join(dir, "out.json"),
					outMeta: join(dir, "meta.json"),
					workDir: join(dir, "work"),
				}),
			/chunkCount/,
		);

		writeFileSync(
			join(groupDir, "manifest.json"),
			JSON.stringify({
				group: 0,
				chunkCount: 1,
				chunks: [{ index: 0, paths: ["a.ts"], bytes: c0.length, file: "../chunk-000.diff" }],
			}),
		);
		await assert.rejects(
			() =>
				runGroupGrokReview({
					groupManifestPath: join(groupDir, "manifest.json"),
					groupDir,
					model: "grok-4.6",
					effort: "high",
					maxConcurrency: 2,
					chunkTimeoutSec: 30,
					maxAiCredits: 5,
					copilotBin: "copilot",
					outJson: join(dir, "out.json"),
					outMeta: join(dir, "meta.json"),
					workDir: join(dir, "work"),
				}),
			/confinement/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
