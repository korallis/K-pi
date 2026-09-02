import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizeGrokReview } from "./finalize-grok-review.mjs";

function writeGroup(resultsDir, group, chunks) {
	const dir = join(resultsDir, `group-${String(group).padStart(2, "0")}`);
	mkdirSync(dir, { recursive: true });
	const payload = {
		ok: chunks.every((c) => c.ok !== false),
		group,
		reason: "success",
		chunkCount: chunks.length,
		findingCount: chunks.reduce((n, c) => n + (c.findings?.length ?? 0), 0),
		chunks,
	};
	writeFileSync(join(dir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

test("finalize empty plan writes empty findings", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-fin-"));
	try {
		const outJson = join(dir, "out.json");
		const outMeta = join(dir, "out.meta.json");
		const { findings, meta } = finalizeGrokReview({
			resultsDir: join(dir, "results"),
			plan: { chunkCount: 0, groups: [] },
			outJson,
			outMeta,
		});
		assert.deepEqual(findings, []);
		assert.equal(meta.chunkCount, 0);
		assert.equal(JSON.parse(readFileSync(outJson, "utf8")).length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("finalize fails closed on missing group and still writes artifacts", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-fin-"));
	try {
		const resultsDir = join(dir, "results");
		mkdirSync(resultsDir, { recursive: true });
		writeGroup(resultsDir, 0, [
			{
				index: 0,
				paths: ["a.ts"],
				bytes: 10,
				ok: true,
				reason: "success",
				findings: [],
				findingCount: 0,
			},
		]);
		const outJson = join(dir, "out.json");
		const outMeta = join(dir, "out.meta.json");
		assert.throws(
			() =>
				finalizeGrokReview({
					resultsDir,
					plan: {
						chunkCount: 2,
						groups: [
							{ group: 0, chunkIndexes: [0], chunkCount: 1 },
							{ group: 1, chunkIndexes: [1], chunkCount: 1 },
						],
					},
					outJson,
					outMeta,
				}),
			/missing result/,
		);
		// Artifacts written before fail
		assert.ok(readFileSync(outJson, "utf8").length >= 2);
		const meta = JSON.parse(readFileSync(outMeta, "utf8"));
		assert.ok(Array.isArray(meta.infraErrors));
		assert.ok(meta.infraErrors.some((e) => /group 1: missing/.test(e)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("finalize rejects duplicate chunk assignment across groups", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-fin-"));
	try {
		const resultsDir = join(dir, "results");
		mkdirSync(resultsDir, { recursive: true });
		const chunk = {
			index: 0,
			paths: ["a.ts"],
			bytes: 10,
			ok: true,
			reason: "success",
			findings: [],
			findingCount: 0,
		};
		writeGroup(resultsDir, 0, [chunk]);
		writeGroup(resultsDir, 1, [chunk]);
		const outJson = join(dir, "out.json");
		const outMeta = join(dir, "out.meta.json");
		// Plan-level duplicate assignment fails closed before artifact write.
		assert.throws(
			() =>
				finalizeGrokReview({
					resultsDir,
					plan: {
						chunkCount: 1,
						groups: [
							{ group: 0, chunkIndexes: [0], chunkCount: 1 },
							{ group: 1, chunkIndexes: [0], chunkCount: 1 },
						],
					},
					outJson,
					outMeta,
				}),
			/more than once|mismatch|more than one group/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("finalize unions findings from successful groups", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-fin-"));
	try {
		const resultsDir = join(dir, "results");
		mkdirSync(resultsDir, { recursive: true });
		const finding = {
			id: "grok-demo-bug",
			severity: "P1",
			path: "a.ts",
			line: null,
			title: "demo",
			body: "body text for finding",
			locationConfidence: "file",
		};
		writeGroup(resultsDir, 0, [
			{
				index: 0,
				paths: ["a.ts"],
				bytes: 10,
				ok: true,
				reason: "success",
				findings: [finding],
				findingCount: 1,
			},
		]);
		writeGroup(resultsDir, 1, [
			{
				index: 1,
				paths: ["b.ts"],
				bytes: 10,
				ok: true,
				reason: "success",
				findings: [],
				findingCount: 0,
			},
		]);
		const outJson = join(dir, "out.json");
		const outMeta = join(dir, "out.meta.json");
		const { findings, meta } = finalizeGrokReview({
			resultsDir,
			plan: {
				chunkCount: 2,
				groups: [
					{ group: 0, chunkIndexes: [0], chunkCount: 1 },
					{ group: 1, chunkIndexes: [1], chunkCount: 1 },
				],
			},
			outJson,
			outMeta,
		});
		assert.equal(findings.length, 1);
		assert.equal(findings[0].id, "grok-demo-bug");
		assert.equal(meta.failedChunkCount, 0);
		assert.equal(meta.chunkCount, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("ok:false group cannot finalize green", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-fin-"));
	try {
		const resultsDir = join(dir, "results");
		mkdirSync(resultsDir, { recursive: true });
		const gdir = join(resultsDir, "group-00");
		mkdirSync(gdir, { recursive: true });
		writeFileSync(
			join(gdir, "result.json"),
			JSON.stringify({
				ok: false,
				group: 0,
				reason: "chunk-failures",
				chunkCount: 1,
				chunks: [
					{
						index: 0,
						paths: ["a.ts"],
						bytes: 10,
						ok: false,
						reason: "timeout",
						findings: null,
					},
				],
			}) + "\n",
		);
		const outJson = join(dir, "out.json");
		const outMeta = join(dir, "out.meta.json");
		assert.throws(
			() =>
				finalizeGrokReview({
					resultsDir,
					plan: { chunkCount: 1, groups: [{ group: 0, chunkIndexes: [0], chunkCount: 1 }] },
					outJson,
					outMeta,
				}),
			/failed closed/,
		);
		const meta = JSON.parse(readFileSync(outMeta, "utf8"));
		assert.equal(meta.findingCount, null);
		assert.ok(meta.infraErrors.some((e) => /group 0: failed/.test(e)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("finalize rejects result.chunkCount mismatch and path escape", () => {
	const dir = mkdtempSync(join(tmpdir(), "grok-fin-"));
	try {
		const resultsDir = join(dir, "results");
		mkdirSync(resultsDir, { recursive: true });
		writeGroup(resultsDir, 0, [
			{
				index: 0,
				paths: ["a.ts"],
				bytes: 10,
				ok: true,
				reason: "success",
				findings: [
					{
						id: "grok-escape",
						severity: "P1",
						path: "other.ts",
						line: null,
						title: "x",
						body: "escaped path body text here",
						locationConfidence: "file",
					},
				],
				findingCount: 1,
			},
		]);
		// Corrupt chunkCount on disk
		const raw = JSON.parse(readFileSync(join(resultsDir, "group-00/result.json"), "utf8"));
		raw.chunkCount = 99;
		writeFileSync(join(resultsDir, "group-00/result.json"), JSON.stringify(raw) + "\n");
		const outJson = join(dir, "out.json");
		const outMeta = join(dir, "out.meta.json");
		assert.throws(
			() =>
				finalizeGrokReview({
					resultsDir,
					plan: { chunkCount: 1, groups: [{ group: 0, chunkIndexes: [0], chunkCount: 1 }] },
					outJson,
					outMeta,
				}),
			/failed closed/,
		);
		const meta = JSON.parse(readFileSync(outMeta, "utf8"));
		assert.ok(meta.infraErrors.some((e) => /chunkCount/.test(e)));
		assert.ok(meta.infraErrors.some((e) => /outside chunk paths/.test(e)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
