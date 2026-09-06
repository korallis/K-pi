#!/usr/bin/env -S node --experimental-strip-types
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { buildProductFeatureMap, contentHash, rankRepositoryFiles, updateRepositoryMap } from "../packages/coding-agent/src/kpi/extensions/context/maps.ts";
import { ContextSerializer, decodeContextSerialization, type ContextModel } from "../packages/coding-agent/src/kpi/extensions/context/serialization.ts";
import { loadContextTokenizer } from "../packages/coding-agent/src/kpi/extensions/context/tokenizer.ts";

// node --experimental-strip-types scripts/context-benchmark.ts [--root DIR] [--query TEXT]
//   [--required relative/path ...] [--limit N] [--model 'provider/model-id' ...]
// Model tokenizers require explicit .kpi/context.json authorization. No credentials are guessed.
const { values } = parseArgs({ options: {
	root: { type: "string", default: process.cwd() }, query: { type: "string", default: "context serialization" },
	required: { type: "string", multiple: true }, limit: { type: "string", default: "12" }, model: { type: "string", multiple: true },
} });
const root = resolve(values.root!);
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
const requiredPaths = values.required ?? [
	"packages/coding-agent/src/kpi/extensions/context/index.ts",
	"packages/coding-agent/src/kpi/extensions/context/serialization.ts",
	"packages/coding-agent/src/kpi/extensions/context/maps.ts",
];
const models: Array<ContextModel | undefined> = values.model?.map((binding) => {
	const slash = binding.indexOf("/");
	if (slash < 1 || slash === binding.length - 1) throw new Error("--model requires provider/model-id");
	return { provider: binding.slice(0, slash), id: binding.slice(slash + 1) };
}) ?? [undefined];
const temporary = await mkdtemp(join(tmpdir(), "kpi-context-benchmark-"));
try {
	const started = performance.now();
	const repository = await updateRepositoryMap({ projectRoot: root, runDirectory: temporary });
	const indexingMilliseconds = performance.now() - started;
	const product = buildProductFeatureMap(root, "benchmark-local-not-run-intent", undefined, repository);
	for (const path of requiredPaths) assert.ok(repository.files.some((file) => file.path === path), `Required file is absent from eligible repository inventory: ${path}`);
	const ranked = rankRepositoryFiles(repository, product, undefined, values.query!);
	// Known authoritative paths are exact retrieval seeds, not inferred relevance labels.
	const targetPaths = new Set([...requiredPaths, ...ranked.slice(0, limit).map((file) => file.path)]);
	const retrieve = async (paths: string[]) => {
		const start = performance.now();
		const files = [];
		let bytesRead = 0;
		for (const path of paths) {
			const bytes = await readFile(join(root, path)); bytesRead += bytes.length;
			// Preserve arbitrary source bytes, not a lossy UTF-8 replacement. The base64 is raw evidence in this local workload.
			const content = bytes.toString("utf8");
			files.push({ path, hash: contentHash(bytes), bytes: bytes.length, encoding: Buffer.from(content, "utf8").equals(bytes) ? "utf8" : "base64", content: Buffer.from(content, "utf8").equals(bytes) ? content : bytes.toString("base64") });
		}
		return { files, reads: paths.length, bytesRead, milliseconds: performance.now() - start };
	};
	const broad = await retrieve(repository.files.map((file) => file.path));
	const targeted = await retrieve([...targetPaths]);
	for (const path of requiredPaths) assert.deepEqual(targeted.files.find((file) => file.path === path), broad.files.find((file) => file.path === path), `Required source was lost: ${path}`);
	const required = { goal: values.query, requiredPaths, constraints: ["Recover required source files byte-for-byte", "Retain authoritative raw files"], acceptance: requiredPaths.map((path) => ({ id: `source:${path}`, path, required: true })) };
	const intentHash = contentHash(JSON.stringify(required));
	const cases = [
		{ name: "naive-broad-source", document: { intent: required, intentHash, files: broad.files } },
		{ name: "targeted-source", document: { intent: required, intentHash, files: targeted.files } },
		{ name: "structured-repository-records", document: { intent: required, intentHash, records: repository.files.map((file) => ({ path: file.path, hash: file.hash, bytes: file.bytes, language: file.language })) } },
		{ name: "adversarial-structured-records", document: { intent: required, intentHash, records: [
			{ id: "row:1", text: 'comma, quote" slash\\ newline\n tab\t', flag: false, value: null, number: 0 },
			{ id: "row:2", text: "日本語\rtrue:null [] {}", flag: true, value: "null", number: 1e-7 },
		], irregular: [{ a: "must retain" }, { b: [false, null, ""] }] } },
	];
	const measurements = [];
	for (const model of models) {
		const loaded = await loadContextTokenizer(root, model);
		const serializer = new ContextSerializer(model, loaded.tokenizer, loaded.reason);
		for (const workload of cases) {
			const start = performance.now();
			const result = await serializer.serialize(workload.document, true);
			const decoded = decodeContextSerialization(result.text, result.encoding) as typeof workload.document;
			assert.deepEqual(decoded, workload.document, `${workload.name} round-trip changed canonical fields`);
			assert.deepEqual(decoded.intent, required, `${workload.name} lost required intent`);
			assert.equal(decoded.intentHash, intentHash, `${workload.name} changed protected-state hash`);
			measurements.push({ workload: workload.name, model: model ?? null, selected: result.encoding, tokenizer: result.tokenizer, variants: result.candidates, milliseconds: performance.now() - start, requiredRecovery: true });
		}
	}
	console.log(JSON.stringify({ version: 1, proof: "local-deterministic-retrieval-and-exact-decoder-recovery", liveInference: { performed: false, correctness: null, reason: "This benchmark does not run inference; decoder recovery is not model comprehension or live quality proof" },
		root, query: values.query, requiredPaths, repositoryHash: repository.hash,
		index: { files: repository.files.length, sourceBytes: repository.files.reduce((sum, file) => sum + file.bytes, 0), milliseconds: indexingMilliseconds, accounting: "Cold map construction reads all indexed source files. Language-server internal reads are unobserved and excluded; index cost is shared by both retrieval variants." },
		retrieval: { method: "explicit required-path seeds plus native ranked path/symbol retrieval", requiredFileRecovery: true,
			broad: { files: broad.files.length, reads: broad.reads, bytesRead: broad.bytesRead, milliseconds: broad.milliseconds },
			targeted: { files: targeted.files.length, reads: targeted.reads, bytesRead: targeted.bytesRead, milliseconds: targeted.milliseconds },
			readReduction: broad.reads - targeted.reads, byteReduction: broad.bytesRead - targeted.bytesRead }, measurements,
	}, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
