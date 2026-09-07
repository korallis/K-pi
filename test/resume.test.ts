import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { registeredBuses } from "../packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts";

import { restoreStopState, resumeLoop, writeState } from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
	OperatorStopError,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition, GraphRunState } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import {
	createStopState,
	recordVerifier,
	repeatedWitness,
} from "../packages/coding-agent/src/kpi/extensions/graph/stop.ts";
import type { Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

const policy = {
	allowNonInteractive: true,
	allowNonInteractiveMutations: false,
	confirmProjectGraph: false,
	confirmMutatingNodes: false,
};

async function cleanupFixture(root: string): Promise<void> {
	const runs = join(root, ".kpi", "runs");
	for (const bus of registeredBuses()) {
		if (bus.runDirectory.startsWith(`${runs}/`)) await bus.stopAll();
	}
	await rm(root, { recursive: true, force: true });
}

async function latestCheckpoint(projectRoot: string, jobId: string): Promise<GraphRunState> {
	const directory = join(projectRoot, ".kpi", "runs", jobId, "graph");
	const names = (await readdir(directory)).filter((name) => /^checkpoint-\d{6}\.json$/u.test(name)).sort();
	return JSON.parse(await readFile(join(directory, names.at(-1) as string), "utf8")) as GraphRunState;
}

async function writeCheckpoint(projectRoot: string, jobId: string, state: Record<string, unknown>): Promise<void> {
	const directory = join(projectRoot, ".kpi", "runs", jobId, "graph");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "checkpoint-000001.json"), `${JSON.stringify(state, null, 2)}\n`);
}

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
		limits: { maxConcurrency: 1 },
		policy,
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
		// A newer caller/template must not replace the execution definition frozen
		// with the completed work, even when its graph identity is unchanged.
		const replacement = graph.nodes.find((node) => node.id === "test");
		if (replacement?.type === "agent") replacement.prompt = "replacement test from a newer template";

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
		await cleanupFixture(directory);
	}
});

test("a terminal graph with unverified acceptance never publishes project completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-unverified-completion-"));
	const task: Task = {
		job_id: "unverified-job",
		mode: "gated",
		goal: "complete only after independent verification",
		nongoals: [],
		acceptance: [{ id: "AC-01", statement: "the user journey works", required: true }],
		constraints: [],
		quality_gates: ["npm test"],
		ac: { quality: "narrative" },
	};
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "unverified",
		entry: "empty",
		nodes: [{ id: "empty", type: "set", assignments: { "test.passed": false } }],
		edges: [{ from: "empty", to: "__end__" }],
		limits: { maxConcurrency: 1 },
		policy,
	};
	const engine = new GraphEngine(graph, { projectRoot: directory, jobId: task.job_id });
	try {
		await engine.runUntilPause();
		await writeState(directory, task, engine.state, createStopState());
		const published = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
		assert.equal(published.status, "RUNNING", "graph exhaustion must not make an unverified job DONE");
	} finally {
		engine.dispose();
		await cleanupFixture(directory);
	}
});

test("a forged DONE document without protected intent cannot publish completion on resume", async () => {
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
		assert.equal((await resumeLoop(jobId, context)).status, "NEEDS_HUMAN");
		assert.equal((await resumeLoop(jobId, context)).status, "NEEDS_HUMAN");
		const persisted = JSON.parse(await readFile(join(run, "state.json"), "utf8"));
		assert.equal(persisted.status, "NEEDS_HUMAN");
		assert.equal(persisted.recovery, "contract");
		const events = await readFile(join(run, "events.jsonl"), "utf8").catch(() => "");
		const terminals = events
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type: string })
			.filter((record) => record.type === "loop.terminal");
		assert.equal(terminals.length, 0, JSON.stringify(terminals));
	} finally {
		await cleanupFixture(directory);
	}
});

test("a mid-superstep stop marks only the work that ran and never reruns it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-partial-"));
	const workerIds = ["w1", "w2", "w3", "w4"];
	const prompts: string[] = [];
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
		limits: { maxConcurrency: 2 },
		policy,
	};
	// The operator stops the run while the second bounded batch is prompting:
	// the first batch already finished, the second is mid-flight.
	const controller = new AbortController();
	const stopDuringSecondBatch: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: `partial-${prompts.length}`,
			async prompt(prompt: string) {
				prompts.push(prompt.split("\n", 1)[0]);
				if (prompts.length === 3) {
					controller.abort();
				}
			},
			getActiveToolNames() {
				return ["read"];
			},
			dispose() {},
		},
	});
	const plain: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: `partial-${prompts.length}`,
			async prompt(prompt: string) {
				prompts.push(prompt.split("\n", 1)[0]);
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
			createAgentSession: stopDuringSecondBatch,
			signal: controller.signal,
		});
		await engine.runSuperstep();
		await assert.rejects(engine.runSuperstep(), OperatorStopError);
		engine.dispose();
		const stopped = await latestCheckpoint(directory, "partial-job");

		// Exactly the first bounded batch is committed; the interrupted batch is
		// still running and its results were not committed.
		const ran = workerIds.filter((id) => stopped.nodes[id].status === "completed");
		const interrupted = workerIds.filter((id) => stopped.nodes[id].status === "running");
		assert.deepEqual(ran, ["w1", "w2"], "one batch of two finished");
		assert.deepEqual(interrupted, ["w3", "w4"], "the batch the stop landed in continues on resume");
		assert.equal(prompts.length, 3, "the stop landed before the sibling in the same batch was prompted");
		assert.equal(stopped.status, "running", "an operator stop is not a failure");
		assert.deepEqual([...stopped.active].sort(), interrupted.sort(), "only unresolved nodes stay active");

		// The resume runs the interrupted nodes only, as the same run.
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "partial-job",
			createAgentSession: plain,
		});
		const finished = await restored.runUntilPause();
		restored.dispose();

		assert.equal(finished.status, "completed");
		assert.equal(prompts.length, 5, "the batch that already finished was not repeated");
		assert.deepEqual(prompts.slice(3).sort(), interrupted.sort());
		for (const id of workerIds) {
			assert.equal(finished.nodes[id].runs, 1, `${id} ran exactly once across the stop`);
		}
	} finally {
		await cleanupFixture(directory);
	}
});

test("a resumed run restores every stop, retry, cost, and time field", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-resume-state-"));
	const jobId = "state-job";
	const run = join(directory, ".kpi", "runs", jobId);
	const witness = `sha256:${"a".repeat(64)}`;
	const persisted = {
		job_id: jobId,
		status: "RUNNING",
		round: 4,
		started_at_ms: 1_700_000_000_000,
		elapsed_ms: 42_000,
		cost_usd: 3.25,
		evidence_fingerprints: [`sha256:${"1".repeat(64)}`],
		output_fingerprints: [witness],
		failing_ac_sets: ["AC-1,AC-2"],
		repaired: [witness],
		plan_repair: {
			round: 3,
			reason: "no progress: review repeated its output",
			failing_ac: ["AC-1", "AC-2"],
			evidence_ref: "verdict.json",
			witness,
			decision: {
				kind: "engineering",
				action: "decompose",
				attempt: 3,
				witness,
				failure: { classification: "IMPLEMENTATION_ERROR", evidenceRefs: ["verdict.json"] },
				reason: "Split the failing implementation into independently verified tasks",
				evidenceRefs: ["verdict.json"],
				taskIds: ["implement"],
				goalIds: ["AC-1", "AC-2"],
			},
		},
		last_test_evidence: `sha256:${"e".repeat(64)}`,
	};
	try {
		await mkdir(run, { recursive: true });
		await writeFile(join(run, "state.json"), JSON.stringify(persisted));

		const restored = restoreStopState(persisted);
		assert.equal(restored.round, 4);
		assert.deepEqual(restored.failingAcSets, ["AC-1,AC-2"]);
		assert.deepEqual(restored.outputFingerprints, [witness]);
		assert.deepEqual(restored.evidenceFingerprints, [`sha256:${"1".repeat(64)}`]);
		assert.deepEqual(restored.repaired, [witness], "the re-plans already spent survive the kill");
		assert.deepEqual(restored.repair, persisted.plan_repair, "the planner's brief survives the kill");
		assert.equal(restored.lastTestEvidence, persisted.last_test_evidence);
		assert.equal("maxRounds" in restored, false, "no cap is restored, because none exists");
		assert.equal("retries" in restored, false, "retries live on the node's checkpoint, never here");

		// The restored failing set is still a witness, which is the point of
		// persisting it: the round after a kill is not a free round.
		assert.equal(
			repeatedWitness(restored, {
				type: "verifier",
				passed: false,
				evidenceFingerprint: `sha256:${"2".repeat(64)}`,
				outputFingerprint: `sha256:${"b".repeat(64)}`,
				failingAcIds: ["AC-2", "AC-1"],
			}),
			"AC-1,AC-2",
		);

		// A document missing its stop fields resolves to a safe empty state rather
		// than throwing past the resume.
		const bare = restoreStopState({ job_id: jobId });
		assert.equal(bare.round, 0);
		assert.deepEqual(bare.failingAcSets, []);
		assert.deepEqual(bare.repaired, []);

		// The engine half: a node mid-backoff keeps its retry record, and the
		// counters keep their clock and spend, across a checkpoint restore.
		const graph: GraphDefinition = {
			schemaVersion: 2,
			id: "state-graph",
			entry: "implement",
			nodes: [
				{
					id: "implement",
					type: "agent",
					prompt: "implement",
					context: { mode: "isolated" },
					tools: ["read"],
					readOnly: true,
				},
			],
			edges: [{ from: "implement", to: "__end__" }],
			limits: { maxConcurrency: 1 },
			policy,
		};
		await writeCheckpoint(directory, jobId, {
			definition: graph,
			graphId: "state-graph",
			jobId,
			status: "running",
			superstep: 0,
			active: ["implement"],
			values: {},
			nodes: {
				implement: {
					status: "running",
					runs: 1,
					transientRetries: 3,
					retryRun: 1,
					retryDelaysMs: [1_000, 2_000, 4_000],
					retryReason: "http",
					retryAtMs: 1_700_000_050_000,
					error: "transient http: 503",
				},
			},
			budget: {
				limits: { maxConcurrency: 1 },
				startedAtMs: 1_700_000_000_000,
				elapsedMs: 42_000,
				costUsd: 3.25,
				round: 1,
				batches: 1,
			},
		});
		const engine = await GraphEngine.restore(graph, { projectRoot: directory, jobId, now: () => 1_700_000_042_000 });
		assert.equal(engine.state.status, "running");
		assert.equal(engine.state.nodes.implement.status, "running", "a node a kill left mid-run continues");
		assert.equal(engine.state.nodes.implement.transientRetries, 3);
		assert.equal(engine.state.nodes.implement.retryReason, "http");
		assert.equal(engine.state.nodes.implement.retryAtMs, 1_700_000_050_000);
		assert.deepEqual(engine.state.nodes.implement.retryDelaysMs, [1_000, 2_000, 4_000]);
		assert.equal(engine.state.budget.startedAtMs, 1_700_000_000_000, "the original start time is kept, not reset");
		assert.equal(engine.state.budget.costUsd, 3.25, "the durable spend is kept without an injected meter");
		assert.equal(engine.state.budget.elapsedMs, 42_000);
		assert.equal(engine.state.budget.round, 1);
		assert.deepEqual(engine.retiredLimits, []);
	} finally {
		await cleanupFixture(directory);
	}
});

test("a kill during a transient backoff resumes by finishing the wait, not restarting the node", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-retry-resume-"));
	const jobId = "retry-resume-job";
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "retry-resume",
		entry: "implement",
		nodes: [
			{
				id: "implement",
				type: "agent" as const,
				prompt: "implement",
				context: { mode: "isolated" as const },
				tools: ["read"],
				readOnly: true,
			},
		],
		edges: [{ from: "implement", to: "__end__" }],
		limits: { maxConcurrency: 1 },
		policy,
	};
	let attempts = 0;
	const failsOnceMore: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: "flaky",
			async prompt() {
				attempts += 1;
				if (attempts === 1) {
					throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
				}
			},
			getActiveToolNames: () => ["read"],
			dispose() {},
		},
	});

	try {
		// The checkpoint a kill left behind: implement is mid-run, two retries
		// spent, and the third backoff ends 700 ms from now on the injected clock.
		const now = 5_000_000;
		await writeCheckpoint(directory, jobId, {
			definition: graph,
			graphId: "retry-resume",
			jobId,
			status: "running",
			superstep: 0,
			active: ["implement"],
			values: { policy: { onHumanDeny: "revise" } },
			nodes: {
				implement: {
					status: "running",
					runs: 1,
					transientRetries: 2,
					retryRun: 1,
					retryDelaysMs: [100, 200],
					retryReason: "transport",
					retryAtMs: now + 700,
					error: "transient transport: socket hang up",
				},
			},
			budget: {
				limits: { maxConcurrency: 1 },
				startedAtMs: now - 1_000,
				elapsedMs: 1_000,
				costUsd: 0,
				round: 1,
				batches: 0,
			},
		});

		const slept: number[] = [];
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId,
			createAgentSession: failsOnceMore,
			retryBaseDelayMs: 100,
			now: () => now,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		assert.equal(restored.state.nodes.implement.transientRetries, 2, "the count survived the kill");

		const finished = await restored.runUntilPause();
		restored.dispose();

		assert.deepEqual(slept, [700, 400], "the remaining 700 ms first; the next failure continues the sequence at 400");
		assert.equal(attempts, 2, "one attempt after the finished wait, one after the next backoff");
		assert.equal(finished.status, "completed");
		assert.equal(finished.nodes.implement.runs, 1, "a run resumed mid-flight is the same run");
		assert.equal(finished.nodes.implement.transientRetries, 3, "the next failure continued at three");
		assert.deepEqual(finished.nodes.implement.retryDelaysMs, [100, 200, 400]);
		assert.equal(finished.nodes.implement.retryAtMs, undefined);
		assert.equal(finished.budget.round, 1);
	} finally {
		await cleanupFixture(directory);
	}
});

/** A prompt that fails transiently for a fixed set of run attempts. */
function transientForRuns(failuresPerRun: readonly number[]): {
	factory: GraphAgentSessionFactory;
	nextRun: () => void;
} {
	let run = 0;
	let attemptsThisRun = 0;
	const factory: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: "runs",
			async prompt() {
				attemptsThisRun += 1;
				if (attemptsThisRun <= (failuresPerRun[run] ?? 0)) {
					throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
				}
			},
			getActiveToolNames: () => ["read"],
			dispose() {},
		},
	});
	return {
		factory,
		nextRun: () => {
			run += 1;
			attemptsThisRun = 0;
		},
	};
}

function loopingGraph(id: string): GraphDefinition {
	return {
		schemaVersion: 2,
		id,
		entry: "implement",
		nodes: [
			{
				id: "implement",
				type: "agent" as const,
				prompt: "implement",
				context: { mode: "isolated" as const },
				tools: ["read"],
				readOnly: true,
			},
		],
		edges: [{ from: "implement", to: "implement" }],
		limits: { maxConcurrency: 1 },
		policy,
	};
}

test("a later run gets a fresh transient-retry allowance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-retry-rounds-"));
	try {
		const slept: number[] = [];
		// Two failures in the first run, two more in the second: the count is
		// keyed to the run, so the second run backs off from the start again
		// instead of continuing where the first run's sequence left off.
		const flaky = transientForRuns([2, 2]);
		const engine = new GraphEngine(loopingGraph("retry-rounds"), {
			projectRoot: directory,
			jobId: "retry-rounds-job",
			createAgentSession: flaky.factory,
			retryBaseDelayMs: 10,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});

		const first = await engine.runSuperstep();
		assert.equal(first.status, "running");
		assert.equal(first.nodes.implement.runs, 1);
		assert.equal(first.nodes.implement.transientRetries, 2);
		assert.equal(first.nodes.implement.retryRun, 1);
		assert.equal(first.nodes.implement.retryAtMs, undefined, "no wait is pending after the run finished");

		flaky.nextRun();
		const second = await engine.runSuperstep();

		assert.equal(second.nodes.implement.runs, 2, "a legitimate second run");
		assert.equal(second.nodes.implement.retryRun, 2, "the count is keyed to the run it belongs to");
		assert.equal(second.nodes.implement.transientRetries, 2, "and it started from zero, not four");
		assert.deepEqual(slept, [10, 20, 10, 20], "each run backs off from the start");
		assert.deepEqual(second.nodes.implement.retryDelaysMs, [10, 20]);
		assert.equal(second.status, "running", "no counter ended the loop");
		engine.dispose();
	} finally {
		await cleanupFixture(directory);
	}
});

test("a timeout delivered as an abort retries, a plain operator abort does not", async () => {
	const cases = [
		{
			name: "fetch deadline as AbortError",
			error: () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }),
			retried: true,
		},
		{
			name: "abort with a TimeoutError cause",
			error: () =>
				Object.assign(new Error("This operation was aborted"), {
					name: "AbortError",
					cause: Object.assign(new Error("deadline"), { name: "TimeoutError" }),
				}),
			retried: true,
		},
		{
			name: "operator abort",
			error: () => Object.assign(new Error("The user aborted a request"), { name: "AbortError" }),
			retried: false,
		},
	];

	for (const scenario of cases) {
		const directory = await mkdtemp(join(tmpdir(), "kpi-retry-abort-"));
		try {
			const slept: number[] = [];
			let attempts = 0;
			const factory: GraphAgentSessionFactory = async () => ({
				session: {
					sessionId: "abort",
					async prompt() {
						attempts += 1;
						if (attempts === 1) {
							throw scenario.error();
						}
					},
					getActiveToolNames: () => ["read"],
					dispose() {},
				},
			});
			// This regression concerns retry classification, not re-arming a loop's
			// next iteration: finish a single node to observe its successful result.
			const graph = loopingGraph("abort-case");
			graph.edges = [{ from: "implement", to: "__end__" }];
			const engine = new GraphEngine(graph, {
				projectRoot: directory,
				jobId: "abort-job",
				createAgentSession: factory,
				retryBaseDelayMs: 10,
				sleep: async (ms) => {
					slept.push(ms);
				},
			});

			const state = await engine.runSuperstep();
			if (scenario.retried) {
				assert.equal(attempts, 2, `${scenario.name}: the node was retried`);
				assert.deepEqual(slept, [10], `${scenario.name}: one backoff`);
				assert.equal(state.nodes.implement.status, "completed");
				assert.equal(state.status, "completed");
			} else {
				assert.equal(attempts, 1, `${scenario.name}: no retry`);
				assert.deepEqual(slept, [], `${scenario.name}: no backoff`);
				assert.equal(state.status, "paused", `${scenario.name}: a defect parks the run`);
				assert.equal(state.pause?.recovery, "contract");
			}
			engine.dispose();
		} finally {
			await cleanupFixture(directory);
		}
	}
});

test("a failed branch preserves an unexecuted sibling across restore, drains it, then pauses only the failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-pending-sibling-"));
	// A breach in the first batch cannot discard or block the independent
	// sibling. A kill between batches must preserve both its work and the blocker.
	const ran: string[] = [];
	let breaches = 0;
	const factory: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: "sibling",
			async prompt(prompt: string) {
				ran.push(prompt.split("\n", 1)[0]);
			},
			getActiveToolNames: () => {
				if (options.tools?.includes("grep") && breaches === 0) {
					breaches += 1;
					return ["read", "bash"];
				}
				return [...(options.tools ?? [])];
			},
			dispose() {},
		},
	});
	const agent = (id: string, tools: string[]) => ({
		id,
		type: "agent" as const,
		prompt: id,
		context: { mode: "isolated" as const },
		tools,
		readOnly: true,
	});
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "pending-sibling",
		entry: "fan",
		nodes: [
			{ id: "fan", type: "set" as const, assignments: { fanned: true } },
			agent("a", ["read"]),
			agent("b", ["read", "grep"]),
			agent("c", ["read"]),
		],
		edges: ["a", "b", "c"].map((id) => ({ from: "fan", to: id })),
		limits: { maxConcurrency: 2 },
		policy,
	};
	try {
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "pending-job",
			createAgentSession: factory,
		});
		await engine.runSuperstep();
		const interrupted = await engine.runSuperstep();
		engine.dispose();

		assert.equal(interrupted.status, "running", "independent work drains before an operator pause");
		assert.deepEqual(ran, ["a"], "the breach never prompted and c has not started");
		assert.equal(interrupted.nodes.a.status, "completed");
		assert.equal(interrupted.nodes.b.status, "failed");
		assert.equal(interrupted.nodes.c.status, "pending");
		assert.deepEqual(interrupted.active, ["c"]);
		assert.deepEqual(
			interrupted.blockers?.flatMap((blocker) => blocker.resume),
			["b"],
		);

		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "pending-job",
			createAgentSession: factory,
		});
		assert.deepEqual(restored.state.active, ["c"], "the kill did not lose the independent sibling");
		const paused = await restored.runUntilPause();
		restored.dispose();
		assert.deepEqual(ran, ["a", "c"], "unblocked work ran before human intervention");
		assert.equal(paused.status, "paused");
		assert.equal(paused.pause?.recovery, "contract");
		assert.deepEqual(paused.pause?.resume, ["b"], "only the failed branch needs recovery");

		const repaired = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "pending-job",
			createAgentSession: factory,
		});
		assert.deepEqual(repaired.state.active, ["b"]);
		const finished = await repaired.runUntilPause();
		repaired.dispose();
		assert.equal(finished.status, "completed");
		assert.deepEqual(ran.sort(), ["a", "b", "c"], "every scheduled node ran exactly once");
		assert.equal(finished.nodes.c.runs, 1);
		assert.equal(finished.nodes.a.runs, 1, "the committed sibling never reran");
	} finally {
		await cleanupFixture(directory);
	}
});

test("a sibling that finished is committed once and never reruns after a paused resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-sibling-"));
	// One node fails on a defect the first time, the other succeeds. The
	// counter is the side effect: a rerun would show up as a second call.
	const sideEffects: string[] = [];
	let stallAttempts = 0;
	const factory: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: "sibling",
			async prompt(prompt: string) {
				const node = prompt.split("\n", 1)[0];
				if (node === "stalls") {
					stallAttempts += 1;
					if (stallAttempts === 1) {
						throw new Error("agent node stalls produced an unusable answer");
					}
				}
				sideEffects.push(node);
			},
			getActiveToolNames: () => [...(options.tools ?? [])],
			dispose() {},
		},
	});
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "sibling-batch",
		entry: "fan",
		nodes: [
			{ id: "fan", type: "set" as const, assignments: { fanned: true } },
			{
				id: "stalls",
				type: "agent" as const,
				prompt: "stalls",
				context: { mode: "isolated" as const },
				tools: ["read"],
				readOnly: true,
			},
			{
				id: "succeeds",
				type: "agent" as const,
				prompt: "succeeds",
				context: { mode: "isolated" as const },
				tools: ["read"],
				readOnly: true,
			},
		],
		edges: [
			{ from: "fan", to: "stalls" },
			{ from: "fan", to: "succeeds" },
		],
		limits: { maxConcurrency: 2 },
		policy,
	};

	try {
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "sibling-job",
			createAgentSession: factory,
		});
		await engine.runSuperstep();
		const paused = await engine.runSuperstep();
		engine.dispose();

		assert.equal(paused.status, "paused");
		assert.equal(paused.pause?.recovery, "contract");
		assert.deepEqual(sideEffects, ["succeeds"], "the sibling ran exactly once");
		assert.equal(paused.nodes.succeeds.status, "completed", "a finished sibling is committed, not discarded");
		assert.equal(paused.nodes.stalls.status, "failed");
		assert.deepEqual(paused.pause?.resume, ["stalls"], "only the failed node is left to do");

		// The resume finishes the failed node and leaves the sibling alone, so
		// its side effect is still recorded exactly once.
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "sibling-job",
			createAgentSession: factory,
		});
		assert.deepEqual(restored.state.active, ["stalls"]);
		const finished = await restored.runUntilPause();
		restored.dispose();

		assert.equal(finished.status, "completed");
		assert.deepEqual(sideEffects, ["succeeds", "stalls"], "the sibling was never rerun");
		assert.equal(finished.nodes.succeeds.runs, 1, "and its run was counted exactly once");
		assert.equal(finished.nodes.stalls.runs, 2, "the failed node was run again");
	} finally {
		await cleanupFixture(directory);
	}
});

test("a wrapped operator cancellation is not retried, a wrapped timeout is", async () => {
	const cases = [
		{
			name: "abort one level down",
			error: () =>
				Object.assign(new Error("fetch failed"), {
					cause: Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
				}),
			retried: false,
		},
		{
			name: "abort one level down with an outer transport code",
			error: () =>
				Object.assign(new Error("request failed"), {
					code: "ECONNRESET",
					cause: Object.assign(new Error("cancelled"), { name: "AbortError" }),
				}),
			retried: false,
		},
		{
			name: "wrapped abort that states a timeout",
			error: () =>
				Object.assign(new Error("fetch failed"), {
					cause: Object.assign(new Error("aborted"), { name: "AbortError", code: "UND_ERR_HEADERS_TIMEOUT" }),
				}),
			retried: true,
		},
	];

	for (const scenario of cases) {
		const directory = await mkdtemp(join(tmpdir(), "kpi-wrapped-abort-"));
		try {
			const slept: number[] = [];
			let attempts = 0;
			const factory: GraphAgentSessionFactory = async () => ({
				session: {
					sessionId: "wrapped",
					async prompt() {
						attempts += 1;
						if (attempts === 1) {
							throw scenario.error();
						}
					},
					getActiveToolNames: () => ["read"],
					dispose() {},
				},
			});
			const engine = new GraphEngine(loopingGraph("wrapped"), {
				projectRoot: directory,
				jobId: "wrapped-job",
				createAgentSession: factory,
				retryBaseDelayMs: 5,
				sleep: async (ms) => {
					slept.push(ms);
				},
			});

			const state = await engine.runSuperstep();
			if (scenario.retried) {
				assert.equal(attempts, 2, `${scenario.name}: retried`);
				assert.deepEqual(slept, [5], `${scenario.name}: one backoff`);
			} else {
				assert.equal(attempts, 1, `${scenario.name}: not retried`);
				assert.deepEqual(slept, [], `${scenario.name}: no backoff`);
				assert.equal(state.status, "paused", scenario.name);
				assert.equal(state.pause?.recovery, "contract");
			}
			engine.dispose();
		} finally {
			await cleanupFixture(directory);
		}
	}
});

test("every stop-safety field survives a state document round trip", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-stop-parity-"));
	try {
		// A state a long job would really reach: several rounds, two witnessed
		// fingerprints, a recorded failing set, and a failed test round on record.
		let stopState = createStopState();
		stopState = recordVerifier(stopState, {
			type: "verifier",
			passed: false,
			evidenceFingerprint: `sha256:${"1".repeat(64)}`,
			outputFingerprint: `sha256:${"a".repeat(64)}`,
			failingAcIds: ["AC-02", "AC-01"],
		});
		stopState = recordVerifier(stopState, {
			type: "verifier",
			passed: false,
			evidenceFingerprint: `sha256:${"2".repeat(64)}`,
			outputFingerprint: `sha256:${"b".repeat(64)}`,
			failingAcIds: ["AC-03"],
		});
		stopState = recordVerifier(stopState, {
			type: "verifier",
			source: "test",
			passed: false,
			evidenceFingerprint: `sha256:${"3".repeat(64)}`,
		});
		assert.equal(stopState.round, 3);
		assert.equal(stopState.lastTestEvidence, `sha256:${"3".repeat(64)}`);

		const task: Task = {
			job_id: "stop-parity",
			mode: "gated",
			goal: "Persist every stop field",
			nongoals: [],
			acceptance: [{ id: "AC-01", statement: "round trips", required: true }],
			constraints: [],
			quality_gates: ["pnpm test"],
			ac: { quality: "executable" },
		};
		const engine = new GraphEngine(loopingGraph("parity"), {
			projectRoot: directory,
			jobId: "stop-parity",
			createAgentSession: async () => ({
				session: {
					sessionId: "parity",
					async prompt() {},
					getActiveToolNames: () => ["read"],
					dispose() {},
				},
			}),
		});
		await engine.runSuperstep();
		engine.dispose();

		await writeState(directory, task, engine.state, stopState);
		const document = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as Record<string, unknown>;
		const restored = restoreStopState(document);

		assert.equal(restored.round, stopState.round, "round");
		assert.deepEqual(restored.evidenceFingerprints, stopState.evidenceFingerprints, "evidence fingerprints");
		assert.deepEqual(restored.outputFingerprints, stopState.outputFingerprints, "output fingerprints");
		assert.deepEqual(restored.failingAcSets, stopState.failingAcSets, "failing acceptance sets");
		assert.deepEqual(restored.repaired, stopState.repaired, "re-plans spent");
		assert.deepEqual(restored.repair, stopState.repair, "planner's brief");
		assert.equal(restored.lastTestEvidence, stopState.lastTestEvidence, "the failed test round on record");
		for (const retired of ["maxRounds", "exhausted_limit", "retries", "retry_delays_ms"]) {
			assert.equal(retired in document, false, `${retired} is not written, because no cap exists`);
		}

		// The restored state must still recognize a repeat of what already failed.
		assert.equal(
			repeatedWitness(restored, {
				type: "verifier",
				passed: false,
				evidenceFingerprint: `sha256:${"4".repeat(64)}`,
				outputFingerprint: `sha256:${"b".repeat(64)}`,
			}),
			`sha256:${"b".repeat(64)}`,
			"a repeated output after resume is still a witness",
		);
		assert.equal(
			repeatedWitness(restored, {
				type: "verifier",
				passed: false,
				evidenceFingerprint: `sha256:${"5".repeat(64)}`,
				outputFingerprint: `sha256:${"c".repeat(64)}`,
				failingAcIds: ["AC-01", "AC-02"],
			}),
			"AC-01,AC-02",
			"a repeated failing set after resume is still a witness",
		);
	} finally {
		await cleanupFixture(directory);
	}
});

test("a paused job resumes at its pause node's resume targets and a legacy checkpoint re-arms its active nodes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-paused-resume-"));
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "paused-resume",
		entry: "implement",
		nodes: [
			...["implement", "test"].map((id) => ({
				id,
				type: "agent" as const,
				prompt: id,
				context: { mode: "isolated" as const },
				tools: ["read"],
				readOnly: true,
			})),
			{ id: "unsafe", type: "pause" as const, recovery: "bounds" as const, reason: "bounds", resume: ["test"] },
		],
		edges: [
			{ from: "implement", to: "test" },
			{ from: "test", to: "unsafe", when: { path: "bounds.held", equals: false } },
			{ from: "test", to: "__end__", when: { path: "bounds.held", equals: true } },
		],
		limits: { maxConcurrency: 1 },
		policy,
	};
	const nodeStates = (statuses: Record<string, string>): Record<string, unknown> =>
		Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, runs: 1 }]));
	const budget = { startedAtMs: 1, elapsedMs: 2, costUsd: 0.5, round: 1, batches: 2 };
	try {
		// A run parked at the unsafe pause node.
		await writeCheckpoint(directory, "paused-job", {
			definition: graph,
			graphId: "paused-resume",
			jobId: "paused-job",
			status: "paused",
			superstep: 3,
			active: ["test"],
			values: { policy: { onHumanDeny: "revise" }, bounds: { held: false } },
			nodes: nodeStates({ implement: "completed", test: "completed", unsafe: "pending" }),
			budget: { limits: { maxConcurrency: 1 }, ...budget },
			pause: { recovery: "bounds", reason: "bounds", round: 1, superstep: 2, nodes: ["unsafe"], resume: ["test"] },
		});
		const paused = await GraphEngine.restore(graph, { projectRoot: directory, jobId: "paused-job" });
		assert.equal(paused.state.status, "running");
		assert.deepEqual(paused.state.active, ["test"]);
		assert.equal(paused.state.nodes.test.status, "pending");
		assert.equal(paused.state.nodes.implement.status, "completed", "nodes off the resume path are untouched");
		assert.equal(paused.state.pause, undefined);
		assert.deepEqual(paused.retiredLimits, []);

		// A legacy `failed` checkpoint, no pause record, active nodes marked failed.
		await writeCheckpoint(directory, "failed-job", {
			definition: graph,
			graphId: "paused-resume",
			jobId: "failed-job",
			status: "failed",
			superstep: 2,
			active: ["implement"],
			values: {},
			nodes: nodeStates({ implement: "failed", test: "pending", unsafe: "pending" }),
			budget: {
				limits: { maxSteps: 24, maxNodeRuns: 16, maxConcurrency: 1, maxCostUsd: 5, timeoutMs: 1 },
				...budget,
			},
		});
		const failed = await GraphEngine.restore(graph, { projectRoot: directory, jobId: "failed-job" });
		assert.equal(failed.state.status, "running");
		assert.deepEqual(failed.state.active, ["implement"]);
		assert.equal(failed.state.nodes.implement.status, "pending");
		assert.deepEqual(
			failed.retiredLimits,
			["maxSteps", "maxNodeRuns", "maxCostUsd", "timeoutMs"],
			"checkpoint order",
		);
		assert.deepEqual(failed.state.budget.limits, { maxConcurrency: 1 });
		assert.equal(failed.state.budget.costUsd, 0.5, "the recorded spend is kept");

		// A legacy `terminated` checkpoint with a UNSAFE terminal record.
		await writeCheckpoint(directory, "terminated-job", {
			definition: graph,
			graphId: "paused-resume",
			jobId: "terminated-job",
			status: "terminated",
			superstep: 4,
			active: ["test"],
			values: {},
			nodes: nodeStates({ implement: "completed", test: "exhausted", unsafe: "completed" }),
			budget: { limits: { maxConcurrency: 1, maxRounds: 3, maxTransientRetries: 2 }, ...budget },
			terminal: { status: "UNSAFE", reason: "a write left the bounds", round: 1, superstep: 3, nodes: ["unsafe"] },
		});
		const terminated = await GraphEngine.restore(graph, { projectRoot: directory, jobId: "terminated-job" });
		assert.equal(terminated.state.status, "running");
		assert.deepEqual(terminated.state.active, ["test"]);
		assert.equal(terminated.state.nodes.test.status, "pending", "a legacy exhausted node is re-armed");
		assert.equal("terminal" in terminated.state, false, "the legacy terminal record goes with the status");
		assert.deepEqual(terminated.retiredLimits, ["maxRounds", "maxTransientRetries"]);

		// A checkpoint written before a node existed still schedules it.
		await writeCheckpoint(directory, "older-job", {
			definition: graph,
			graphId: "paused-resume",
			jobId: "older-job",
			status: "exhausted",
			superstep: 2,
			active: ["implement"],
			values: {},
			nodes: nodeStates({ implement: "exhausted" }),
			budget: { limits: { maxConcurrency: 1, maxCostUsd: 5 }, ...budget },
		});
		const older = await GraphEngine.restore(graph, { projectRoot: directory, jobId: "older-job" });
		assert.equal(older.state.status, "running");
		assert.equal(older.state.nodes.implement.status, "pending");
		assert.equal(older.state.nodes.test.status, "pending");
		assert.equal(older.state.nodes.test.runs, 0);
		assert.equal(older.state.nodes.unsafe.status, "pending");
		assert.equal(older.state.nodes.unsafe.runs, 0);
		assert.deepEqual(older.retiredLimits, ["maxCostUsd"]);
	} finally {
		await cleanupFixture(directory);
	}
});

test("a legacy capped driver checkpoint without execution provenance pauses durably instead of restarting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-retired-cap-"));
	const jobId = "20260903-fix-claude-model-requests-failin-42986cfa";
	const run = join(directory, ".kpi", "runs", jobId);
	const fixture = fileURLToPath(new URL("./fixtures/retired-cap-resume/", import.meta.url));
	const prompted: string[] = [];
	let confirmations = 0;
	try {
		await cp(fixture, run, { recursive: true });
		const before = await latestCheckpoint(directory, jobId);
		const context = {
			cwd: directory,
			hasUI: true,
			mode: "tui",
			ui: {
				async confirm() {
					confirmations += 1;
					return true;
				},
				notify() {},
				setWidget() {},
			},
		} as unknown as ExtensionCommandContext;
		const outcome = await resumeLoop(jobId, context, { createAgentSession: factory(prompted) });
		assert.equal(outcome.status, "NEEDS_HUMAN");
		assert.equal(outcome.recovery, "contract");
		assert.match(outcome.reason ?? "", /execution topology/u);
		assert.match(outcome.reason ?? "", /trusted backup/u);
		assert.match(outcome.reason ?? "", /start a new \/kpi job/u);
		assert.equal(confirmations, 1, "legacy intent was explicitly confirmed, not silently adopted");
		const persisted = JSON.parse(await readFile(join(run, "state.json"), "utf8"));
		assert.equal(persisted.status, "NEEDS_HUMAN");
		assert.equal(persisted.reason, outcome.reason);
		assert.equal(persisted.cost_usd, 7.691661999999999, "refusal preserves recorded spend");
		const second = await resumeLoop(jobId, context, { createAgentSession: factory(prompted) });
		assert.equal(second.reason, outcome.reason);
		assert.equal(confirmations, 1, "confirmed intent does not reopen on the next resume");
		assert.deepEqual(prompted, [], "no node is replayed under an invented current topology");
		assert.deepEqual(await latestCheckpoint(directory, jobId), before, "the original checkpoint remains recoverable");
	} finally {
		await cleanupFixture(directory);
	}
});
