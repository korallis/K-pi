#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { unionGrokFindings } from "./validate-grok-review.mjs";
import {
	DEFAULT_CHUNK_TIMEOUT_SEC,
	DEFAULT_MAX_CHUNK_BYTES,
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_ZAI_MAX_RETRIES,
	ABSOLUTE_MAX_CHUNK_BYTES,
	computeZaiBackoffMs,
	createZaiRunCommand,
	isTransientZaiNetworkError,
	loadZaiProviderCatalog,
	mapPool,
	parseRetryAfterMs,
	resolveReviewRunCommand,
	resolveReviewChunkBudgetBytes,
	resolveZaiCatalogModel,
	resolveZaiCatalogPath,
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
				model: "glm-5.3-flash",
				outJson: join(dir, "out.json"),
				outMeta: join(dir, "meta.json"),
				workDir: join(dir, "work"),
				maxChunkBytes: 100,
				maxConcurrency: 2,
				chunkTimeoutSec: 30,
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
		assert.equal(meta.model, "glm-5.3-flash");
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
				model: "glm-5.3-flash",
				outJson: join(dir, "out.json"),
				outMeta: join(dir, "meta.json"),
				workDir: join(dir, "work"),
				maxChunkBytes: 120,
				maxConcurrency: 3,
				chunkTimeoutSec: 30,
			},
			{
				runCommand: async (spec) => {
					calls.push(spec.model);
					assert.equal(spec.model, "glm-5.3-flash");
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
		assert.equal(meta.model, "glm-5.3-flash");
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
						model: "glm-5.3-flash",
						outJson: join(dir, "out.json"),
						outMeta: join(dir, "meta.json"),
						workDir: join(dir, "work"),
						maxChunkBytes: 40,
						maxConcurrency: 2,
						chunkTimeoutSec: 30,
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
		assert.equal(meta.model, "glm-5.3-flash");
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
						model: "glm-5.3-flash",
						outJson: join(dir, "out.json"),
						outMeta: join(dir, "meta.json"),
						workDir: join(dir, "work"),
						maxChunkBytes: 1000,
						maxConcurrency: 1,
						chunkTimeoutSec: 30,
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
						model: "glm-5.3-flash",
						outJson: join(dir, "out.json"),
						outMeta: join(dir, "meta.json"),
						workDir: join(dir, "work"),
						maxChunkBytes: 120,
						maxConcurrency: 3,
						chunkTimeoutSec: 30,
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



test("budget defaults pair low concurrency with context-sized chunks", () => {
	assert.equal(DEFAULT_MAX_CONCURRENCY, 2);
	assert.equal(DEFAULT_CHUNK_TIMEOUT_SEC, 720);
	assert.equal(DEFAULT_MAX_CHUNK_BYTES, 160_000);
	assert.ok(DEFAULT_MAX_CHUNK_BYTES < ABSOLUTE_MAX_CHUNK_BYTES);
	const hard = resolveReviewChunkBudgetBytes("glm-5.3-flash", "");
	assert.ok(hard > 96_000, `context budget should exceed argv-era 96KiB, got ${hard}`);
	const est = Math.ceil(4_700_000 / hard);
	assert.ok(est >= 10 && est <= 40, `expected ~15–30 chunks for 4.7MB, est=${est} hard=${hard}`);
	const worstCaseMs = Math.ceil(est / DEFAULT_MAX_CONCURRENCY) * 30_000;
	assert.ok(worstCaseMs < DEFAULT_CHUNK_TIMEOUT_SEC * 1000);
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
				model: "glm-5.3-flash",
				outJson: join(dir, "out.json"),
				outMeta: join(dir, "meta.json"),
				workDir: join(dir, "work"),
				maxChunkBytes: 96_000,
				maxConcurrency: 2,
				chunkTimeoutSec: 30,
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
					assert.ok(Buffer.byteLength(spec.prompt, "utf8") <= ABSOLUTE_MAX_CHUNK_BYTES + 100_000);
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
				model: "glm-5.3-flash",
				maxConcurrency: 2,
				chunkTimeoutSec: 30,
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
				runGroupGrokReview(
					{
					groupManifestPath: join(groupDir, "manifest.json"),
					groupDir,
					model: "glm-5.3-flash",
					maxConcurrency: 2,
					chunkTimeoutSec: 30,
					outJson: join(dir, "out.json"),
					outMeta: join(dir, "meta.json"),
					workDir: join(dir, "work"),
					},
					{
						runCommand: async () => ({
							ok: true,
							reason: "success",
							stdout: "[]",
							stderr: "",
							code: 0,
						}),
					},
				),
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
				runGroupGrokReview(
					{
					groupManifestPath: join(groupDir, "manifest.json"),
					groupDir,
					model: "glm-5.3-flash",
					maxConcurrency: 2,
					chunkTimeoutSec: 30,
					outJson: join(dir, "out.json"),
					outMeta: join(dir, "meta.json"),
					workDir: join(dir, "work"),
					},
					{
						runCommand: async () => ({
							ok: true,
							reason: "success",
							stdout: "[]",
							stderr: "",
							code: 0,
						}),
					},
				),
			/confinement/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


function startLocalZaiStub(handler) {
	const server = createServer((req, res) => {
		void handler(req, res);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				server,
				baseUrl: `http://127.0.0.1:${port}/api/coding/paas/v4`,
				close: () =>
					new Promise((r, j) => {
						server.close((err) => (err ? j(err) : r()));
					}),
			});
		});
	});
}

async function readRequestBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

function writeTempZaiCatalog(dir, models) {
	const path = join(dir, "zai.json");
	const normalized = {};
	for (const [id, entry] of Object.entries(models)) {
		normalized[id] = {
			...entry,
			name: entry.name ?? id,
			baseUrl: entry.baseUrl,
			contextWindow: entry.contextWindow ?? 100_000,
			maxTokens: entry.maxTokens ?? 4096,
		};
	}
	const body = { "openai-completions": normalized };
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
	return path;
}

test("repo zai catalog lists official ids including glm-5.3 and glm-5.3-flash", () => {
	const catalog = loadZaiProviderCatalog(resolveZaiCatalogPath());
	const ids = Object.keys(catalog.models).sort();
	assert.ok(ids.includes("glm-5.3"), `expected glm-5.3 in ${ids.join(", ")}`);
	assert.ok(ids.includes("glm-5.3-flash"), `expected glm-5.3-flash in ${ids.join(", ")}`);
	assert.equal(typeof catalog.models["glm-5.3"].baseUrl, "string");
	assert.ok(catalog.models["glm-5.3"].baseUrl.length > 0);
	// baseUrl must come from the file, not a frozen constant in this module.
	assert.match(catalog.models["glm-5.3"].baseUrl, /^https?:\/\//u);
});

test("resolveZaiCatalogModel fails closed listing real catalog ids", () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-cat-"));
	try {
		const path = writeTempZaiCatalog(dir, {
			"glm-5.3": { name: "GLM-5.3", baseUrl: "http://127.0.0.1:9/v4" },
			"glm-5.3-flash": { name: "Flash", baseUrl: "http://127.0.0.1:9/v4" },
		});
		const catalog = loadZaiProviderCatalog(path);
		assert.equal(resolveZaiCatalogModel(catalog, "glm-5.3").id, "glm-5.3");
		assert.throws(
			() => resolveZaiCatalogModel(catalog, "not-a-real-model"),
			/Known ids: glm-5\.3, glm-5\.3-flash/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand posts to catalog baseUrl and returns assistant content", async () => {
	const findingsDoc = JSON.stringify([
		{
			id: "grok-local",
			severity: "P1",
			path: "a.ts",
			line: 1,
			title: "ok",
			body: "body",
		},
	]);
	let sawAuth = "";
	let sawBody = null;
	let sawUrl = "";
	const stub = await startLocalZaiStub(async (req, res) => {
		sawUrl = req.url ?? "";
		assert.equal(req.method, "POST");
		assert.equal(req.url, "/api/coding/paas/v4/chat/completions");
		sawAuth = req.headers.authorization ?? "";
		const raw = await readRequestBody(req);
		sawBody = JSON.parse(raw);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				choices: [{ message: { role: "assistant", content: findingsDoc } }],
			}),
		);
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-run-"));
	try {
		const catalogPath = writeTempZaiCatalog(dir, {
			"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
		});
		const catalog = loadZaiProviderCatalog(catalogPath);
		const run = createZaiRunCommand({
			apiKey: "test-key-not-real",
			catalog,
			fetchImpl: fetch,
		});
		const result = await run({
			prompt: "review this",
			model: "glm-5.3",
			timeoutSec: 5,
		});
		assert.equal(result.ok, true);
		assert.equal(result.reason, "success");
		assert.equal(result.stdout, findingsDoc);
		assert.equal(sawAuth, "Bearer test-key-not-real");
		assert.equal(sawBody.model, "glm-5.3");
		assert.equal(sawBody.messages[0].content, "review this");
		assert.equal(sawUrl, "/api/coding/paas/v4/chat/completions");
		// Prompt rides in HTTP body — sized from catalog contextWindow.
		assert.ok(ABSOLUTE_MAX_CHUNK_BYTES > 96_000);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand fails closed on unknown model without calling network", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-unknown-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: "http://127.0.0.1:1/nope" },
			}),
		);
		const run = createZaiRunCommand({ apiKey: "k", catalog, fetchImpl: fetch });
		const result = await run({ prompt: "p", model: "missing-model", timeoutSec: 1 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "invalid-model");
		assert.match(result.stderr, /Known ids: glm-5\.3/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseRetryAfterMs reads seconds, HTTP-date, and body hints", () => {
	assert.equal(parseRetryAfterMs({ "retry-after": "2" }, "", 0), 2000);
	assert.equal(parseRetryAfterMs({ "Retry-After": "1.5" }, "", 0), 1500);
	const now = Date.UTC(2026, 0, 1, 0, 0, 0);
	// HTTP-date has second resolution; use a whole-second delta.
	const httpDate = new Date(now + 4000).toUTCString();
	assert.equal(parseRetryAfterMs({ "retry-after": httpDate }, "", now), 4000);
	assert.equal(
		parseRetryAfterMs({}, JSON.stringify({ error: { retry_after: 1.25 } }), now),
		1250,
	);
	assert.equal(parseRetryAfterMs({}, "", now), null);
});

test("computeZaiBackoffMs floors on Retry-After and stays under cap", () => {
	const ms = computeZaiBackoffMs(0, {
		baseMs: 1000,
		capMs: 5000,
		retryAfterMs: 2500,
		random: () => 0,
	});
	assert.equal(ms, 2500);
	const capped = computeZaiBackoffMs(10, {
		baseMs: 1000,
		capMs: 5000,
		retryAfterMs: 99999,
		random: () => 0.999,
	});
	assert.equal(capped, 5000);
});

test("isTransientZaiNetworkError treats fetch failed as retryable", () => {
	assert.equal(isTransientZaiNetworkError(new TypeError("fetch failed"), false), true);
	assert.equal(isTransientZaiNetworkError(new Error("ECONNRESET"), false), true);
	assert.equal(isTransientZaiNetworkError(new Error("fetch failed"), true), false);
	assert.equal(isTransientZaiNetworkError(new Error("invalid schema"), false), false);
});

test("createZaiRunCommand retries 429 then succeeds", async () => {
	let hits = 0;
	const sleeps = [];
	const stub = await startLocalZaiStub(async (_req, res) => {
		hits += 1;
		if (hits === 1) {
			res.writeHead(429, {
				"content-type": "application/json",
				"retry-after": "1",
			});
			res.end(JSON.stringify({ error: { code: "1302", message: "Rate limit reached for requests" } }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-429-ok-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		const run = createZaiRunCommand({
			apiKey: "k",
			catalog,
			fetchImpl: fetch,
			maxRetries: 3,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			random: () => 0,
		});
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 30 });
		assert.equal(result.ok, true);
		assert.equal(result.reason, "success");
		assert.equal(hits, 2);
		assert.equal(sleeps.length, 1);
		assert.ok(sleeps[0] >= 1000, `expected Retry-After floor, got ${sleeps[0]}`);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand exhausts repeated 429 and fails closed as rate-limit", async () => {
	let hits = 0;
	const stub = await startLocalZaiStub(async (_req, res) => {
		hits += 1;
		res.writeHead(429, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "rate limited" } }));
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-429-fail-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		const run = createZaiRunCommand({
			apiKey: "k",
			catalog,
			fetchImpl: fetch,
			maxRetries: 2,
			sleep: async () => {},
			random: () => 0,
		});
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 30 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "rate-limit");
		assert.equal(result.code, 429);
		assert.match(result.stderr, /HTTP 429/);
		assert.equal(hits, 3); // initial + 2 retries
		assert.ok(DEFAULT_ZAI_MAX_RETRIES >= 1);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand honours Retry-After when computing backoff", async () => {
	const sleeps = [];
	const stub = await startLocalZaiStub(async (_req, res) => {
		res.writeHead(429, {
			"content-type": "application/json",
			"retry-after": "3",
		});
		res.end(JSON.stringify({ error: { message: "slow down" } }));
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-ra-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		const run = createZaiRunCommand({
			apiKey: "k",
			catalog,
			fetchImpl: fetch,
			maxRetries: 1,
			backoffBaseMs: 100,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			random: () => 0, // jittered floor = 0 without Retry-After
		});
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 30 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "rate-limit");
		assert.equal(sleeps.length, 1);
		assert.equal(sleeps[0], 3000);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand retries transient network errors then succeeds", async () => {
	let hits = 0;
	const stub = await startLocalZaiStub(async (_req, res) => {
		hits += 1;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-net-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		let fetchCalls = 0;
		const run = createZaiRunCommand({
			apiKey: "k",
			catalog,
			fetchImpl: async (url, init) => {
				fetchCalls += 1;
				if (fetchCalls === 1) {
					throw new TypeError("fetch failed");
				}
				return fetch(url, init);
			},
			maxRetries: 2,
			sleep: async () => {},
			random: () => 0,
		});
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 30 });
		assert.equal(result.ok, true);
		assert.equal(result.reason, "success");
		assert.equal(fetchCalls, 2);
		assert.equal(hits, 1);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand fails closed on non-429 HTTP error without retry", async () => {
	let hits = 0;
	const stub = await startLocalZaiStub(async (_req, res) => {
		hits += 1;
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "boom" } }));
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-http-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		const run = createZaiRunCommand({
			apiKey: "k",
			catalog,
			fetchImpl: fetch,
			maxRetries: 5,
			sleep: async () => {
				assert.fail("should not sleep on non-429 HTTP errors");
			},
		});
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 5 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "exit-nonzero");
		assert.match(result.stderr, /HTTP 500/);
		assert.equal(hits, 1);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});


test("createZaiRunCommand fails closed on non-JSON body", async () => {
	const stub = await startLocalZaiStub(async (_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("not-json");
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-nj-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		const run = createZaiRunCommand({ apiKey: "k", catalog, fetchImpl: fetch });
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 5 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "invalid-response");
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand fails closed when content is missing", async () => {
	const stub = await startLocalZaiStub(async (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: {} }] }));
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-nc-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		const run = createZaiRunCommand({ apiKey: "k", catalog, fetchImpl: fetch });
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 5 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "invalid-response");
		assert.match(result.stderr, /missing choices/);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createZaiRunCommand times out via AbortSignal", async () => {
	const stub = await startLocalZaiStub(async (_req, res) => {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		res.writeHead(200);
		res.end("{}");
	});
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-to-"));
	try {
		const catalog = loadZaiProviderCatalog(
			writeTempZaiCatalog(dir, {
				"glm-5.3": { name: "GLM-5.3", baseUrl: stub.baseUrl },
			}),
		);
		const run = createZaiRunCommand({ apiKey: "k", catalog, fetchImpl: fetch });
		const started = Date.now();
		const result = await run({ prompt: "p", model: "glm-5.3", timeoutSec: 1 });
		assert.equal(result.ok, false);
		assert.equal(result.reason, "timeout");
		assert.ok(Date.now() - started < 4000);
	} finally {
		await stub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveReviewRunCommand requires ZAI_API_KEY and builds z.ai runner", () => {
	assert.throws(
		() => resolveReviewRunCommand({}),
		/ZAI_API_KEY/,
	);
	const dir = mkdtempSync(join(tmpdir(), "kpi-zai-res-"));
	try {
		const catalogPath = writeTempZaiCatalog(dir, {
			"glm-5.3": { name: "GLM-5.3", baseUrl: "http://127.0.0.1:9/v4" },
		});
		const run = resolveReviewRunCommand({
			ZAI_API_KEY: "secret",
			ZAI_CATALOG_PATH: catalogPath,
		});
		assert.equal(typeof run, "function");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
