import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import { restoreStopState, resumeLoop } from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { transitionStopState } from "../packages/coding-agent/src/kpi/extensions/graph/stop.ts";
import type { Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

function factory(executed: string[]): GraphAgentSessionFactory {
	let sessionId = 0;
	return async () => ({
		session: {
			sessionId: `resume-${sessionId++}`,
			async prompt(prompt: string) {
				executed.push(prompt.split("\n", 1)[0]);
			},
			getActiveToolNames() {
				return ["read"];
			},
			dispose() {},
		},
	});
}

test("restored checkpoint does not rerun completed plan and implement nodes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-resume-"));
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "resume-check",
		entry: "plan",
		nodes: ["plan", "implement", "test"].map((id) => ({
			id,
			type: "agent" as const,
			prompt: id,
			context: { mode: "isolated" as const },
			tools: ["read"],
			readOnly: true,
		})),
		edges: [
			{ from: "plan", to: "implement" },
			{ from: "implement", to: "test" },
			{ from: "test", to: "__end__" },
		],
		limits: { maxSteps: 10, maxNodeRuns: 5, maxConcurrency: 1, maxCostUsd: 1, timeoutMs: 10_000 },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: false,
			confirmMutatingNodes: false,
		},
	};
	try {
		const before: string[] = [];
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "resume-job",
			createAgentSession: factory(before),
		});
		await engine.runSuperstep();
		await engine.runSuperstep();
		engine.dispose();
		assert.deepEqual(before, ["plan", "implement"]);

		const after: string[] = [];
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "resume-job",
			createAgentSession: factory(after),
		});
		const result = await restored.runUntilPause();
		assert.equal(result.status, "completed");
		assert.deepEqual(after, ["test"]);
		restored.dispose();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("resuming an already-DONE job is idempotent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-ship-twice-"));
	const jobId = "done-job";
	const run = join(directory, ".kpi", "runs", jobId);
	const task: Task = {
		job_id: jobId,
		mode: "gated",
		goal: "done",
		nongoals: [],
		acceptance: [],
		constraints: ["Never push"],
		quality_gates: [],
		ac: { quality: "executable" },
	};
	try {
		await mkdir(run, { recursive: true });
		await writeFile(join(run, "task.json"), JSON.stringify(task));
		await writeFile(join(run, "state.json"), JSON.stringify({ status: "DONE" }));
		const context = { cwd: directory } as ExtensionCommandContext;
		assert.equal((await resumeLoop(jobId, context)).status, "DONE");
		assert.equal((await resumeLoop(jobId, context)).status, "DONE");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a mid-superstep stop marks only the work that ran and never reruns it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-partial-"));
	const workerIds = ["w1", "w2", "w3", "w4"];
	const prompts: string[] = [];
	let cost = 0;
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "partial-superstep",
		entry: "fan",
		nodes: [
			{ id: "fan", type: "set" as const, assignments: { fanned: true } },
			...workerIds.map((id) => ({
				id,
				type: "agent" as const,
				prompt: id,
				context: { mode: "isolated" as const },
				tools: ["read"],
				readOnly: true,
			})),
		],
		edges: workerIds.map((id) => ({ from: "fan", to: id })),
		limits: { maxSteps: 10, maxNodeRuns: 5, maxConcurrency: 2, maxCostUsd: 10, timeoutMs: 600_000 },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: false,
			confirmMutatingNodes: false,
		},
	};
	const factory: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: `partial-${prompts.length}`,
			async prompt(prompt: string) {
				prompts.push(prompt.split("\n", 1)[0]);
				// The first bounded batch is affordable; the next one is not.
				cost += 6;
			},
			getActiveToolNames() {
				return ["read"];
			},
			dispose() {},
		},
	});

	try {
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "partial-job",
			createAgentSession: factory,
			accumulatedCostUsd: () => cost,
		});
		await engine.runSuperstep();
		const stopped = await engine.runSuperstep();
		engine.dispose();

		assert.equal(stopped.status, "exhausted");
		assert.equal(stopped.terminal?.limit, "maxCostUsd");

		// Exactly the first bounded batch ran, and only those nodes are marked.
		const ran = workerIds.filter((id) => stopped.nodes[id].runs === 1);
		const untouched = workerIds.filter((id) => stopped.nodes[id].runs === 0);
		assert.equal(ran.length, 2, "one batch of two ran");
		assert.equal(untouched.length, 2);
		assert.deepEqual(prompts.length, 2, "no node ran that was not counted");
		for (const id of ran) {
			assert.equal(stopped.nodes[id].status, "completed", `${id} ran, so the checkpoint must say so`);
		}
		for (const id of untouched) {
			assert.equal(stopped.nodes[id].status, "exhausted", `${id} never started`);
		}
		assert.deepEqual([...stopped.active].sort(), untouched.sort(), "only unresolved nodes stay active");

		// A resume under a raised cap runs the unresolved nodes only.
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "partial-job",
			createAgentSession: factory,
			accumulatedCostUsd: () => 0,
			limits: { maxCostUsd: 100 },
		});
		const finished = await restored.runUntilPause();
		restored.dispose();

		assert.equal(finished.status, "completed");
		assert.deepEqual(prompts.length, 4, "the batch that already ran was not repeated");
		assert.deepEqual(prompts.slice(2).sort(), untouched.sort());
		for (const id of workerIds) {
			assert.equal(finished.nodes[id].runs, 1, `${id} ran exactly once across the kill`);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a resumed run restores every stop, retry, cost, and time field", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-resume-state-"));
	const jobId = "state-job";
	const run = join(directory, ".kpi", "runs", jobId);
	const persisted = {
		job_id: jobId,
		status: "RUNNING",
		round: 4,
		maxRounds: 7,
		started_at_ms: 1_700_000_000_000,
		elapsed_ms: 42_000,
		cost_usd: 3.25,
		retries: 1,
		retry_delays_ms: [1_000],
		evidence_fingerprints: [`sha256:${"1".repeat(64)}`],
		output_fingerprints: [`sha256:${"a".repeat(64)}`],
		failing_ac_sets: ["AC-1,AC-2"],
	};
	try {
		await mkdir(run, { recursive: true });
		await writeFile(join(run, "state.json"), JSON.stringify(persisted));

		const restored = restoreStopState(persisted, 7);
		assert.equal(restored.round, 4);
		assert.equal(restored.maxRounds, 7, "a non-default maxRounds survives resume");
		assert.equal(restored.retries, 1);
		assert.deepEqual(restored.retryDelaysMs, [1_000]);
		assert.deepEqual(restored.failingAcSets, ["AC-1,AC-2"]);
		assert.deepEqual(restored.outputFingerprints, [`sha256:${"a".repeat(64)}`]);

		// The restored failing set still stops the loop, which is the point of
		// persisting it: the round after a kill is not a free round.
		const repeated = transitionStopState(restored, {
			type: "verifier",
			passed: false,
			evidenceFingerprint: `sha256:${"2".repeat(64)}`,
			outputFingerprint: `sha256:${"b".repeat(64)}`,
			failingAcIds: ["AC-2", "AC-1"],
		});
		assert.equal(repeated.status, "NO_PROGRESS");

		// A document missing its stop fields resolves to a safe empty state rather
		// than throwing past the resume.
		const bare = restoreStopState({ job_id: jobId }, 3);
		assert.equal(bare.round, 0);
		assert.equal(bare.retries, 0);
		assert.deepEqual(bare.failingAcSets, []);

		// A corrupt retry counter cannot grant extra retries.
		assert.equal(restoreStopState({ retries: 99 }, 3).retries, 2);
		assert.equal(restoreStopState({ retries: -4 }, 3).retries, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a non-default maxRounds and the budget counters survive an engine restore", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-resume-budget-"));
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "budget-resume",
		entry: "first",
		nodes: [
			{ id: "first", type: "set" as const, assignments: { first: true } },
			{ id: "second", type: "set" as const, assignments: { second: true } },
		],
		edges: [
			{ from: "first", to: "second" },
			{ from: "second", to: "__end__" },
		],
		limits: { maxSteps: 10, maxNodeRuns: 5, maxConcurrency: 1, maxCostUsd: 9, timeoutMs: 600_000 },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: false,
			confirmMutatingNodes: false,
		},
	};
	try {
		let clock = 5_000;
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "budget-job",
			limits: { maxRounds: 9 },
			now: () => clock,
			accumulatedCostUsd: () => 2.5,
		});
		assert.equal(engine.limits.maxRounds, 9);
		clock = 11_000;
		await engine.runSuperstep();

		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "budget-job",
			now: () => clock,
			accumulatedCostUsd: () => 2.5,
		});

		assert.equal(restored.limits.maxRounds, 9, "the cap the run started under survives without being re-passed");
		assert.equal(restored.state.budget.startedAtMs, 5_000, "the original start time is kept, not reset");
		assert.equal(restored.state.budget.costUsd, 2.5);
		assert.equal(restored.state.budget.round, 1);
		assert.equal(restored.state.nodes.first.status, "completed");
		assert.deepEqual(restored.state.active, ["second"]);

		const finished = await restored.runUntilPause();
		assert.equal(finished.status, "completed");
		assert.equal(finished.nodes.first.runs, 1, "a completed node does not rerun");
		assert.equal(finished.nodes.second.runs, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
