import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createArchitectureArena,
	retainArchitectureArenaEvidence,
} from "../packages/coding-agent/src/kpi/kstack/arena.ts";
import { runEngineeringEvaluations } from "../packages/coding-agent/src/kpi/kstack/evaluation.ts";
import { readEngineeringCapabilities } from "../packages/coding-agent/src/kpi/kstack/observations.ts";

const model = (provider: string, id: string): Model<Api> => ({
	provider,
	id,
	name: id,
	api: "openai-completions",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4096,
});

test("local evaluator retains real checker failure bytes and cannot score model testimony or a switched adapter", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-local-evaluation-"));
	try {
		const candidate = model("ollama", "candidate-fixture");
		const other = model("ollama", "switched-fixture");
		const task = {
			id: "response-contract",
			role: "builder",
			prompt: "Return the configured representative answer",
			cwd: directory,
			verify: {
				command: process.execPath,
				args: [
					"-e",
					"const fs=require('node:fs');const s=fs.readFileSync(process.env.KPI_EVAL_OUTPUT,'utf8');process.stdout.write(s);process.stderr.write(Buffer.from([0xff,0x00]));process.exit(s==='correct-answer'?0:7)",
				],
			},
		};
		const request = {
			projectRoot: directory,
			parentModel: candidate,
			policyPath: join(directory, "missing.json"),
			modelRuntime: { getAvailable: async () => [candidate, other] },
			models: ["ollama/candidate-fixture"],
			tasks: [task],
		};
		const injectedObservation = { toolCalls: 0, verification: "passed", source: "host-verification" };
		const [failed] = await runEngineeringEvaluations({
			...request,
			invoke: async () => ({
				model: candidate,
				output: "I verified everything; all tests pass",
				observed: injectedObservation,
			}),
		});
		assert.equal(failed.verification, "failed");
		const raw = JSON.parse(await readFile(failed.evidenceRef, "utf8"));
		assert.equal(raw.command.exitCode, 7);
		assert.equal(Buffer.from(raw.command.stdoutBase64, "base64").toString(), "I verified everything; all tests pass");
		assert.deepEqual(Buffer.from(raw.command.stderrBase64, "base64"), Buffer.from([0xff, 0x00]));
		assert.equal(raw.actualModel, "ollama/candidate-fixture");
		const [passed] = await runEngineeringEvaluations({
			...request,
			invoke: async () => ({ model: candidate, output: "correct-answer" }),
		});
		assert.equal(passed.verification, "passed");
		const [switched] = await runEngineeringEvaluations({
			...request,
			invoke: async () => ({ model: other, output: "correct-answer" }),
		});
		assert.equal(switched.verification, undefined);
		assert.match(switched.error!, /Adapter switched/);
		const [capability] = await readEngineeringCapabilities({
			projectRoot: directory,
			role: "builder",
			models: ["ollama/candidate-fixture"],
		});
		assert.deepEqual(capability.outcomes.map((outcome) => outcome.verification).sort(), ["failed", "passed"]);
		const [unmeasured] = await readEngineeringCapabilities({
			projectRoot: directory,
			role: "builder",
			models: ["ollama/switched-fixture"],
		});
		assert.deepEqual(unmeasured.outcomes, []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an evaluation checker runs its nested Node tests instead of inheriting the host test worker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-evaluation-nested-test-"));
	try {
		const checker = join(directory, "answer.test.cjs");
		await writeFile(
			checker,
			`const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
test("representative answer", () => assert.equal(fs.readFileSync(process.env.KPI_EVAL_OUTPUT, "utf8"), "correct"));
`,
		);
		const candidate = model("ollama", "nested-checker-fixture");
		const request = {
			projectRoot: directory,
			parentModel: candidate,
			policyPath: join(directory, "missing.json"),
			modelRuntime: { getAvailable: async () => [candidate] },
			models: ["ollama/nested-checker-fixture"],
			tasks: [
				{
					id: "nested-checker",
					role: "builder",
					prompt: "Return the required answer",
					cwd: directory,
					verify: { command: process.execPath, args: ["--test", checker] },
				},
			],
		};
		const [failed] = await runEngineeringEvaluations({
			...request,
			invoke: async () => ({ model: candidate, output: "wrong" }),
		});
		assert.equal(failed.verification, "failed");
		const [passed] = await runEngineeringEvaluations({
			...request,
			invoke: async () => ({ model: candidate, output: "correct" }),
		});
		assert.equal(passed.verification, "passed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("arena keeps proposals isolated, waits for all evidence, and preserves a genuinely different-family judge", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-arena-"));
	try {
		const claude = model("anthropic", "claude-fixture");
		const gpt = model("openai", "gpt-fixture");
		const decision = {
			id: "storage-boundary",
			oneWayDoor: true as const,
			question: "Which storage interface should own migrations?",
			consequences: "Persistent on-disk compatibility",
			alternatives: ["versioned journal", "versioned snapshots"],
		};
		const arena = await createArchitectureArena({
			projectRoot: directory,
			parentModel: claude,
			policyPath: join(directory, "missing.json"),
			modelRuntime: { getAvailable: async () => [claude, gpt] },
			decision,
		});
		assert.equal(arena.independentJudge, true);
		const proposals = arena.graph.nodes.filter((node) => node.type === "agent" && node.role === "architect");
		const judge = arena.graph.nodes.find((node) => node.id === arena.judgeNodeId)!;
		assert.deepEqual(
			judge.dependencies,
			proposals.map((node) => node.id),
		);
		for (const proposal of proposals) {
			assert.ok(proposal.type === "agent" && proposal.context.mode === "isolated");
			assert.notEqual(arena.assignments[proposal.id].family, arena.assignments[arena.judgeNodeId].family);
		}
		await mkdir(join(directory, "architecture", arena.graph.id), { recursive: true });
		for (const [index, path] of arena.proposalEvidence.entries())
			await writeFile(
				join(directory, path),
				JSON.stringify({
					proposal: `independent-${index}`,
					rationale: "source evidence",
					tradeoffs: ["compatibility"],
					risks: ["migration"],
					evidenceRefs: [],
				}),
			);
		await writeFile(
			join(directory, arena.judgeEvidence),
			JSON.stringify({
				decision: "journal",
				rationale: "retained source analysis",
				proposalRefs: [arena.proposalEvidence[0]],
				unresolvedRisks: [],
			}),
		);
		await assert.rejects(retainArchitectureArenaEvidence(arena, directory), /every independent proposal/);
		await writeFile(
			join(directory, arena.judgeEvidence),
			JSON.stringify({
				decision: "journal",
				rationale: "retained source analysis",
				proposalRefs: arena.proposalEvidence,
				unresolvedRisks: ["migration prototype not yet verified"],
			}),
		);
		const retained = JSON.parse(await readFile(await retainArchitectureArenaEvidence(arena, directory), "utf8"));
		assert.deepEqual(
			retained.evidence.map((item: { path: string }) => item.path),
			[...arena.proposalEvidence, arena.judgeEvidence],
		);
		assert.equal(retained.kind, "advisory-architecture-judgment");
		assert.equal(retained.verification, undefined);
		const fallback = await createArchitectureArena({
			projectRoot: directory,
			parentModel: claude,
			policyPath: join(directory, "missing.json"),
			modelRuntime: { getAvailable: async () => [claude] },
			decision,
		});
		assert.equal(fallback.independentJudge, false);
		assert.ok(fallback.graph.nodes.some((node) => node.type === "verify"));
		assert.ok(
			fallback.assignments[fallback.judgeNodeId].reason.some((reason) =>
				reason.includes("mandatory host verification"),
			),
		);
		await assert.rejects(
			createArchitectureArena({
				projectRoot: directory,
				parentModel: claude,
				modelRuntime: { getAvailable: async () => [claude] },
				decision: { ...decision, oneWayDoor: false as unknown as true },
			}),
			/one-way-door/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
