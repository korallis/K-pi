import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import {
	assembleAgentContext,
	ContextOverflowError,
	createAgentContextExtension,
} from "../packages/coding-agent/src/kpi/extensions/context/index.ts";
import { readLanguageServers, SemanticNavigation } from "../packages/coding-agent/src/kpi/extensions/context/lsp.ts";
import {
	buildProductFeatureMap,
	updateRepositoryMap,
} from "../packages/coding-agent/src/kpi/extensions/context/maps.ts";
import {
	ContextSerializer,
	decodeContextSerialization,
	decodeToonTable,
} from "../packages/coding-agent/src/kpi/extensions/context/serialization.ts";
import { loadContextTokenizer } from "../packages/coding-agent/src/kpi/extensions/context/tokenizer.ts";
import { KnowledgeGraphProposals } from "../packages/coding-agent/src/kpi/extensions/kg/store.ts";
import { createJob, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import type { DuneStack } from "../packages/coding-agent/src/kpi/extensions/stack.ts";

const task: Task = {
	job_id: "context-recovery",
	mode: "gated",
	goal: "Preserve account login after reset",
	nongoals: ["billing"],
	acceptance: [
		{
			id: "AC-login",
			statement: "Existing users retain login",
			required: true,
			check: { kind: "command", cmd: "python -m unittest", expect: { exit: 0 } },
			bounds: { write_allow: ["app/login.py", "tests/test_login.py"] },
		},
	],
	constraints: ["Do not change public authentication behavior"],
	quality_gates: ["python -m unittest"],
	ac: { quality: "executable" },
	current_module_id: "login",
};
const stack: DuneStack = {
	version: 1,
	shape: "dune",
	delivery: "vertical",
	root: ".",
	current_module_id: "login",
	modules: [
		{
			id: "login",
			purpose: "existing account login",
			folder: "app",
			interface: "app/login.py",
			allowed_paths: ["app/login.py", "tests/test_login.py"],
			depends_on: [],
		},
	],
};

test("reset reconstructs mandatory intent and addressed peers while raw evidence remains intact", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-context-"));
	try {
		const job = await createJob(root, task);
		await mkdir(join(root, "app"));
		await writeFile(join(root, "app/login.py"), "def login():\n    return True\n");
		await writeFile(join(job.directory, "stack.json"), JSON.stringify(stack));
		const evidence = JSON.stringify({ raw: "raw-output.log", excerpt: "diagnostic ".repeat(3000) });
		await writeFile(join(job.directory, "evidence.json"), evidence);
		await writeFile(
			job.eventsPath,
			JSON.stringify({ type: "node.finished", node: "verify", status: "failed", error: "Login assertion failed" }) +
				"\n",
		);
		await writeFile(
			join(job.directory, "decisions.json"),
			JSON.stringify({ decision: "Retain the public login interface" }),
		);
		const messages = [
			{
				sequence: 1,
				id: "addressed",
				sender: "planner",
				recipients: ["context-recovery/implement"],
				taskId: "implement",
				text: "Reuse existing login",
				createdAt: "2026-09-05T00:00:00.000Z",
			},
			{
				sequence: 2,
				id: "private",
				sender: "planner",
				recipients: ["another-worker"],
				text: "Different audience",
				createdAt: "2026-09-05T00:00:00.000Z",
			},
			{
				sequence: 3,
				id: "other-task",
				sender: "planner",
				recipients: ["context-recovery/implement"],
				taskId: "review",
				text: "Different task",
				createdAt: "2026-09-05T00:00:00.000Z",
			},
		];
		await writeFile(
			join(job.directory, "peer-events.jsonl"),
			`${messages.map((message) => JSON.stringify({ type: "message", message })).join("\n")}\n`,
		);
		const options = {
			projectRoot: root,
			runDirectory: job.directory,
			agentId: "context-recovery/implement",
			role: "implementer",
			taskId: "implement",
			modelContextWindow: 10_000,
			outputReserve: 1000,
		};
		await assembleAgentContext(options);
		const recovered = await assembleAgentContext(options);
		const document = JSON.parse(recovered.prompt);
		assert.deepEqual(document.sections[0].content.intent.task.acceptance, task.acceptance);
		assert.equal(document.sections[0].content.intent.task.goal, task.goal);
		assert.deepEqual(document.sections[0].content.intent.task.constraints, task.constraints);
		assert.ok(document.sections.some((section: { id: string }) => section.id === "peer:1"));
		assert.ok(!recovered.prompt.includes("Different audience"));
		assert.ok(!recovered.prompt.includes("Different task"));
		assert.ok(recovered.prompt.includes("Login assertion failed"));
		assert.ok(recovered.prompt.includes("Retain the public login interface"));
		assert.ok(recovered.manifest.omitted.includes("evidence.json"));
		const raw = recovered.manifest.references.find((entry) => entry.path.endsWith("evidence.json"));
		assert.equal(await readFile(raw!.path, "utf8"), evidence);
		assert.equal(recovered.manifest.budget.measuredTokens, null);
		assert.ok(recovered.manifest.budget.estimatedTokens <= recovered.manifest.budget.inputBudget);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("mandatory overflow and changed protected task fail rather than dropping criteria", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-context-overflow-"));
	try {
		const job = await createJob(root, task);
		const options = {
			projectRoot: root,
			runDirectory: job.directory,
			agentId: "worker",
			role: "reviewer",
			taskId: "review",
			modelContextWindow: 100,
			outputReserve: 0,
		};
		await assert.rejects(assembleAgentContext(options), ContextOverflowError);
		assert.deepEqual(
			JSON.parse(await readFile(join(job.directory, "task.json"), "utf8")).acceptance,
			task.acceptance,
		);
		await writeFile(join(job.directory, "task.json"), JSON.stringify({ ...task, acceptance: [] }));
		await assert.rejects(assembleAgentContext({ ...options, modelContextWindow: 10_000 }), {
			name: "ProtectedIntentError",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("native inference context refreshes canonical state and blocks protected drift without persisting duplicate packets", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-native-context-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const job = await createJob(root, task);
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				createAgentContextExtension({
					projectRoot: root,
					runDirectory: job.directory,
					agentId: "reader",
					role: "reviewer",
					taskId: "review",
					modelContextWindow: 100000,
				}),
			],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const model = modelRuntime.getModels().find((entry) => entry.contextWindow >= 100000);
		assert.ok(model, "the native catalog supplies a documented context capacity");
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			resourceLoader,
			settingsManager,
			modelRuntime,
			model,
			sessionManager: SessionManager.inMemory(root),
			tools: [],
		}));
		await session.bindExtensions({ mode: "rpc" });
		const first = await session.extensionRunner.emitContext([
			{ role: "user", content: "Review the current evidence", timestamp: 1 },
		]);
		await writeFile(
			join(job.directory, "decisions.json"),
			JSON.stringify({ decision: "Newly observed regression requires investigation" }),
		);
		const second = await session.extensionRunner.emitContext(first);
		assert.equal(
			second.filter((message) => message.role === "custom" && message.customType === "kpi-runtime-context").length,
			1,
		);
		assert.match(JSON.stringify(second), /Newly observed regression requires investigation/);
		assert.equal(
			session.messages.some((message) => message.role === "custom" && message.customType === "kpi-runtime-context"),
			false,
		);
		await writeFile(join(job.directory, "task.json"), JSON.stringify({ ...task, acceptance: [] }));
		await assert.rejects(session.extensionRunner.emitContext(second), /ProtectedIntentError/);
	} finally {
		session?.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("incremental structural map updates affected content without conflating feature ownership", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-map-"));
	try {
		const job = await createJob(root, task);
		await mkdir(join(root, "app"));
		await writeFile(join(root, "app/login.py"), "def login():\n    return True\n");
		await writeFile(join(root, "app/billing.py"), "def invoice():\n    return 42\n");
		const options = { projectRoot: root, runDirectory: job.directory };
		const before = await updateRepositoryMap(options);
		await writeFile(join(root, "app/login.py"), "def login():\n    return False\n");
		const after = await updateRepositoryMap({ ...options, affectedPaths: ["app/login.py"] });
		assert.notEqual(after.hash, before.hash);
		assert.notEqual(
			after.files.find((file) => file.path === "app/login.py")!.hash,
			before.files.find((file) => file.path === "app/login.py")!.hash,
		);
		assert.deepEqual(
			after.files.find((file) => file.path === "app/billing.py"),
			before.files.find((file) => file.path === "app/billing.py"),
		);
		const product = buildProductFeatureMap(root, "intent-hash", stack, after);
		assert.deepEqual(product.features[0].observedFiles, ["app/login.py"]);
		assert.equal(after.files.find((file) => file.path === "app/login.py")!.symbols.status, "unsupported");
		await rm(join(root, "app/login.py"));
		const removed = await updateRepositoryMap({ ...options, affectedPaths: ["app/login.py"] });
		assert.deepEqual(
			removed.files.map((file) => file.path),
			["app/billing.py"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("semantic retrieval reports unavailable tooling honestly and refuses path escape", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-semantic-"));
	const semantic = new SemanticNavigation(root, await readLanguageServers(root));
	try {
		const result = await semantic.retrieve("main.py", "references", 0, 0);
		assert.equal(result.status, "unsupported");
		assert.equal(result.result, undefined);
		await assert.rejects(semantic.retrieve("../outside.py", "symbols"));
	} finally {
		await semantic.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("knowledge retrieval ignores superseded revisions and invalidated source claims but retains raw history", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-context-kg-"));
	try {
		const store = new KnowledgeGraphProposals(root);
		await mkdir(store.paths.root, { recursive: true });
		const envelope = {
			kind: "decision",
			source_ids: ["source"],
			status: "verified",
			observed_at: "2026-09-05T00:00:00.000Z",
		};
		await writeFile(
			store.paths.sources,
			`${JSON.stringify({ ...envelope, source_ids: [], id: "source", rev: 1, uri: "app/login.py" })}\n`,
		);
		await writeFile(
			store.paths.nodes,
			`${[
				{ ...envelope, id: "login", rev: 1, decision: "old" },
				{ ...envelope, id: "login", rev: 2, decision: "current" },
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		assert.deepEqual(
			(await store.query("login")).map((claim) => claim.decision),
			["current"],
		);
		await writeFile(
			store.paths.sources,
			`${JSON.stringify({
				...envelope,
				source_ids: [],
				id: "source",
				rev: 2,
				status: "superseded",
				uri: "app/login.py",
			})}\n`,
		);
		assert.deepEqual(await store.query("login"), []);
		assert.equal((await store.read()).nodes.length, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("measured table selection round-trips typed cells and hostile paths without treating data as references", async () => {
	const records = [
		{ id: "a", text: 'false,null,"quoted"\nnext\tline\\', enabled: false, count: 0, empty: null },
		{ id: "b", text: "日本語\r#header", enabled: true, count: 1e-7, empty: "null" },
	];
	const canonical = JSON.parse(
		JSON.stringify({
			protected: { hash: "unchanged", acceptance: records },
			irregular: [{ a: 1 }, { b: [null, false] }],
			literal: { encoding: "json-toon-tables-v1", tables: [{ path: [], lines: 3 }], data: null },
		}),
	);
	Object.defineProperty(canonical, "__proto__", { value: records, enumerable: true });
	const model = { provider: "test-only", id: "controlled-counts" };
	// Controlled measurement responses exercise selection, not model-quality or empirical token claims.
	const serializer = new ContextSerializer(model, {
		id: "controlled-test-responses",
		supports: () => true,
		countTokens: async (text) =>
			text.includes('"encoding":"json-toon-tables-v1","tables"') && text.includes("\n[") ? 10 : 20,
	});
	const result = await serializer.serialize(canonical);
	assert.equal(result.encoding, "json-toon-tables");
	assert.deepEqual(decodeContextSerialization(result.text, result.encoding), canonical);
	assert.equal(Object.hasOwn(Object.prototype, "id"), false);
	assert.throws(() =>
		decodeContextSerialization(result.text.slice(0, result.text.lastIndexOf("\n")), result.encoding),
	);
	assert.throws(() => decodeContextSerialization(`${result.text}\n  extra`, result.encoding));
	assert.throws(() => decodeToonTable("[2]{id,id}:\n  1,2\n  3,4"));
	assert.throws(() => decodeToonTable('[2]{id,text}:\n  1,"x"\n  2'));
});

test("unsupported and less efficient measured tables retain compact JSON with exact irregular values", async () => {
	const canonical = {
		records: [{ veryLongRepeatedColumn: "a" }, { veryLongRepeatedColumn: "b" }],
		unsupported: [{ text: "\u0000" }, { text: "\ud800" }],
	};
	const unsupported = await new ContextSerializer().serialize(canonical);
	assert.equal(unsupported.encoding, "compact-json");
	assert.equal(unsupported.measuredTokens, null);
	assert.deepEqual(decodeContextSerialization(unsupported.text, unsupported.encoding), canonical);
	const measured = await new ContextSerializer(
		{ provider: "test-only", id: "controlled-counts" },
		{
			id: "controlled-test-responses",
			supports: () => true,
			countTokens: async (text) => (text.includes("\n[") ? 200 : 100),
		},
	).serialize(canonical);
	assert.equal(measured.encoding, "compact-json");
	assert.deepEqual(decodeContextSerialization(measured.text, measured.encoding), canonical);
	await assert.rejects(new ContextSerializer().serialize({ value: Number.NaN }), /cannot recover exactly/u);
	await assert.rejects(new ContextSerializer().serialize({ value: undefined }), /cannot recover exactly/u);
});

test("tokenizer loss rebudgets retained evidence rather than mixing measured tokens with bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-context-measurement-loss-"));
	try {
		const job = await createJob(root, task);
		const evidence = JSON.stringify({ output: "retain raw evidence ".repeat(700) });
		await writeFile(join(job.directory, "evidence.json"), evidence);
		await writeFile(join(job.directory, "verdict.json"), JSON.stringify({ triggerTokenizerLoss: true }));
		const recovered = await assembleAgentContext({
			projectRoot: root,
			runDirectory: job.directory,
			agentId: "worker",
			role: "reviewer",
			taskId: "review",
			modelContextWindow: 7000,
			outputReserve: 0,
			model: { provider: "test-only", id: "controlled-counts" },
			tokenizer: {
				id: "controlled-test-responses",
				supports: () => true,
				countTokens: async (text) => (text.includes("triggerTokenizerLoss") ? null : 500),
			},
		});
		assert.equal(recovered.manifest.budget.measuredTokens, null);
		assert.ok(Buffer.byteLength(recovered.prompt) <= 7000);
		assert.ok(recovered.manifest.omitted.includes("evidence.json"));
		assert.deepEqual(JSON.parse(recovered.prompt).sections[0].content.intent.task.acceptance, task.acceptance);
		assert.equal(await readFile(join(job.directory, "evidence.json"), "utf8"), evidence);
		assert.equal(recovered.manifest.tokenizer.status, "unsupported");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("authorized tokenizer configuration cannot silently select a different model or ambiguous binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-context-binding-"));
	try {
		await mkdir(join(root, ".kpi"));
		const binding = {
			kind: "llama.cpp",
			provider: "llama.cpp",
			model: "bound-model",
			id: "pinned-vocabulary",
			serverUrl: "http://127.0.0.1:8080",
		};
		await writeFile(join(root, ".kpi/context.json"), JSON.stringify({ version: 1, tokenizers: [binding] }));
		const wrong = await loadContextTokenizer(root, { provider: "llama.cpp", id: "different-model" });
		assert.equal(wrong.tokenizer, undefined);
		const right = await loadContextTokenizer(root, { provider: "llama.cpp", id: "bound-model" });
		assert.equal(right.tokenizer!.supports({ provider: "other-provider", id: "bound-model" }), false);
		await writeFile(join(root, ".kpi/context.json"), JSON.stringify({ version: 1, tokenizers: [binding, binding] }));
		assert.equal(
			(await loadContextTokenizer(root, { provider: "llama.cpp", id: "bound-model" })).tokenizer,
			undefined,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
