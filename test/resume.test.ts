import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function latestCheckpoint(projectRoot: string, jobId: string) {
	const directory = join(projectRoot, ".kpi", "runs", jobId, "graph");
	const names = (await readdir(directory)).filter((name) => /^checkpoint-\d{6}\.json$/u.test(name)).sort();
	return JSON.parse(await readFile(join(directory, names.at(-1) as string), "utf8")) as {
		nodes: Record<string, { runs: number; transientRetries?: number; retryDelaysMs?: number[] }>;
		budget: { round: number };
	};
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

test("a kill during a transient backoff resumes with the allowance already spent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-retry-resume-"));
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
		limits: { maxSteps: 10, maxNodeRuns: 5, maxConcurrency: 1, maxCostUsd: 10, timeoutMs: 600_000 },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: false,
			confirmMutatingNodes: false,
		},
	};
	const alwaysTransient: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: "flaky",
			async prompt() {
				throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
			},
		getActiveToolNames: () => ["read"],
			dispose() {},
		},
	});

	try {
		// The kill lands during the first backoff: the sleeper never returns.
		const firstSlept: number[] = [];
		// A real kill stops the process mid-wait: nothing unwinds, so the last
		// checkpoint on disk is the one written before the backoff began.
		let backoffStarted = (): void => {};
		const reachedBackoff = new Promise<void>((resolve) => {
			backoffStarted = resolve;
		});
		const neverReturns = new Promise<void>(() => {});
		const killed = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "retry-resume-job",
			createAgentSession: alwaysTransient,
			retryBaseDelayMs: 100,
			sleep: async (ms) => {
				firstSlept.push(ms);
				backoffStarted();
				await neverReturns;
			},
		});
		void killed.runSuperstep().catch(() => undefined);
		await reachedBackoff;
		killed.dispose();
		assert.deepEqual(firstSlept, [100], "one backoff had begun");

		// The checkpoint written before the wait carries the spent allowance.
		const persisted = await latestCheckpoint(directory, "retry-resume-job");
		assert.equal(persisted.nodes.implement.transientRetries, 1, "the counter is durable, not in-memory");
		assert.deepEqual(persisted.nodes.implement.retryDelaysMs, [100]);
		assert.equal(persisted.nodes.implement.runs, 1, "the retry did not advance the run");
		assert.equal(persisted.budget.round, 1);

		// The resumed run has one retry left, not two, and spends it on the
		// doubled delay rather than restarting the backoff sequence.
		const secondSlept: number[] = [];
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "retry-resume-job",
			createAgentSession: alwaysTransient,
			retryBaseDelayMs: 100,
			sleep: async (ms) => {
				secondSlept.push(ms);
			},
		});
		assert.equal(restored.state.nodes.implement.transientRetries, 1, "the allowance survived the kill");

		const finished = await restored.runUntilPause();
		restored.dispose();

		assert.deepEqual(secondSlept, [200], "the resumed run continues the sequence and stops after one retry");
		assert.equal(
			finished.nodes.implement.runs,
			1,
			"a run resumed mid-flight is the same run, so neither runs nor the round moved again",
		);
		assert.equal(finished.status, "exhausted");
		assert.equal(finished.terminal?.limit, "maxTransientRetries");
		assert.equal(finished.nodes.implement.transientRetries, 2);
		assert.deepEqual(finished.nodes.implement.retryDelaysMs, [100, 200]);
		assert.deepEqual(finished.active, ["implement"], "the unresolved node is preserved");
	} finally {
		await rm(directory, { recursive: true, force: true });
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

/** Fails the first `failures` prompt attempts across every engine that shares it. */
function failsFirstAttempts(failures: number): GraphAgentSessionFactory {
	let attempts = 0;
	return async () => ({
		session: {
			sessionId: "shared",
			async prompt() {
				attempts += 1;
				if (attempts <= failures) {
					throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
				}
			},
			getActiveToolNames: () => ["read"],
			dispose() {},
		},
	});
}

function loopingGraph(id: string, limits?: Partial<GraphDefinition["limits"]>): GraphDefinition {
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
		limits: { maxSteps: 20, maxNodeRuns: 9, maxConcurrency: 1, maxCostUsd: 10, timeoutMs: 600_000, ...limits },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: false,
			confirmMutatingNodes: false,
		},
	};
}

test("a later run gets a fresh transient-retry allowance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-retry-rounds-"));
	try {
		const slept: number[] = [];
		// Two failures in the first run, two more in the second: four in total,
		// which a lifetime allowance of two would have refused.
		const flaky = transientForRuns([2, 2]);
		const engine = new GraphEngine(loopingGraph("retry-rounds"), {
			projectRoot: directory,
			jobId: "retry-rounds-job",
			createAgentSession: flaky.factory,
			retryBaseDelayMs: 10,
			limits: { maxRounds: 2 },
			sleep: async (ms) => {
				slept.push(ms);
			},
		});

		const first = await engine.runSuperstep();
		assert.equal(first.status, "running");
		assert.equal(first.nodes.implement.runs, 1);
		assert.equal(first.nodes.implement.transientRetries, 2, "the first run spent its whole allowance");
		assert.equal(first.nodes.implement.retryRun, 1);

		flaky.nextRun();
		const second = await engine.runSuperstep();

		assert.equal(second.nodes.implement.runs, 2, "a legitimate second run");
		assert.equal(second.nodes.implement.retryRun, 2, "the allowance is keyed to the run it belongs to");
		assert.equal(second.nodes.implement.transientRetries, 2, "and it was fresh, not carried over");
		assert.deepEqual(slept, [10, 20, 10, 20], "each run backs off from the start");
		assert.equal(second.status, "running", "two runs were affordable");

		// The round cap, not the retry cap, is what finally ends it.
		const third = await engine.runSuperstep();
		assert.equal(third.status, "exhausted");
		assert.equal(third.terminal?.limit, "maxRounds");
		engine.dispose();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("retry exhaustion resumed at the same cap stays exhausted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-retry-same-cap-"));
	const alwaysFails = transientForRuns([99]);
	try {
		const first: number[] = [];
		const engine = new GraphEngine(loopingGraph("same-cap"), {
			projectRoot: directory,
			jobId: "same-cap-job",
			createAgentSession: alwaysFails.factory,
			retryBaseDelayMs: 10,
			sleep: async (ms) => {
				first.push(ms);
			},
		});
		const stopped = await engine.runUntilPause();
		engine.dispose();
		assert.equal(stopped.terminal?.limit, "maxTransientRetries");
		assert.deepEqual(first, [10, 20]);

		// Restoring at the unchanged cap must not hand the node more attempts.
		const second: number[] = [];
		const restored = await GraphEngine.restore(loopingGraph("same-cap"), {
			projectRoot: directory,
			jobId: "same-cap-job",
			createAgentSession: alwaysFails.factory,
			retryBaseDelayMs: 10,
			sleep: async (ms) => {
				second.push(ms);
			},
		});

		assert.equal(restored.state.status, "exhausted", "a resume at the same cap is not a fresh allowance");
		const finished = await restored.runUntilPause();
		restored.dispose();

		assert.equal(finished.status, "exhausted");
		assert.deepEqual(second, [], "no further backoff was spent");
		assert.equal(finished.nodes.implement.runs, 1, "and no further run was counted");
		assert.equal(finished.nodes.implement.transientRetries, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a raised transient-retry cap re-arms the same run with the spent count intact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-retry-raised-cap-"));
	// Four failures across both engines: two retries spent before the kill, the
	// third covered only by the raised cap, then the attempt that succeeds.
	const factory = failsFirstAttempts(4);
	try {
		const engine = new GraphEngine(loopingGraph("raised-cap"), {
			projectRoot: directory,
			jobId: "raised-cap-job",
			createAgentSession: factory,
			retryBaseDelayMs: 10,
			sleep: async () => {},
		});
		const stopped = await engine.runUntilPause();
		engine.dispose();
		assert.equal(stopped.terminal?.limit, "maxTransientRetries");
		assert.equal(stopped.nodes.implement.transientRetries, 2);

		const slept: number[] = [];
		const restored = await GraphEngine.restore(loopingGraph("raised-cap"), {
			projectRoot: directory,
			jobId: "raised-cap-job",
			createAgentSession: factory,
			retryBaseDelayMs: 10,
			limits: { maxTransientRetries: 3 },
			sleep: async (ms) => {
				slept.push(ms);
			},
		});

		assert.equal(restored.state.status, "running", "a raised cap re-arms the run");
		assert.equal(restored.state.nodes.implement.transientRetries, 2, "the spent count is intact");
		assert.equal(restored.state.nodes.implement.runs, 1);

		// One superstep: the self-loop would otherwise start a fresh run, and a
		// fresh run is exactly what gets a fresh allowance.
		const finished = await restored.runSuperstep();
		restored.dispose();

		assert.deepEqual(slept, [40], "the third retry continues the sequence rather than restarting it");
		assert.equal(finished.nodes.implement.transientRetries, 3);
		assert.equal(finished.nodes.implement.runs, 1, "the resumed run was still the same run");
		assert.equal(finished.budget.round, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
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
			const engine = new GraphEngine(loopingGraph("abort-case", { maxSteps: 1 }), {
				projectRoot: directory,
				jobId: "abort-job",
				createAgentSession: factory,
				retryBaseDelayMs: 10,
				sleep: async (ms) => {
					slept.push(ms);
				},
			});

			if (scenario.retried) {
				await engine.runSuperstep();
				assert.equal(attempts, 2, `${scenario.name}: the node was retried`);
				assert.deepEqual(slept, [10], `${scenario.name}: one backoff`);
				assert.equal(engine.state.nodes.implement.status, "completed");
			} else {
				await assert.rejects(engine.runSuperstep(), Error, scenario.name);
				assert.equal(attempts, 1, `${scenario.name}: no retry`);
				assert.deepEqual(slept, [], `${scenario.name}: no backoff`);
				assert.equal(engine.state.status, "failed");
			}
			engine.dispose();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("a sibling that finished is committed once and never reruns after a raised-cap resume", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-sibling-"));
	// One node stalls on transient failures, the other succeeds. The counter is
	// the side effect: a rerun would show up as a second call.
	const sideEffects: string[] = [];
	let stallAttempts = 0;
	const factory: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: "sibling",
			async prompt(prompt: string) {
				const node = prompt.split("\n", 1)[0];
				if (node === "stalls") {
					stallAttempts += 1;
					if (stallAttempts <= 4) {
						throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
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
		limits: { maxSteps: 20, maxNodeRuns: 9, maxConcurrency: 2, maxCostUsd: 10, timeoutMs: 600_000 },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: false,
			confirmMutatingNodes: false,
		},
	};

	try {
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "sibling-job",
			createAgentSession: factory,
			retryBaseDelayMs: 5,
			sleep: async () => {},
		});
		await engine.runSuperstep();
		const stopped = await engine.runSuperstep();
		engine.dispose();

		assert.equal(stopped.status, "exhausted");
		assert.equal(stopped.terminal?.limit, "maxTransientRetries");
		assert.deepEqual(sideEffects, ["succeeds"], "the sibling ran exactly once");
		assert.equal(stopped.nodes.succeeds.status, "completed", "a finished sibling is committed, not discarded");
		assert.equal(stopped.nodes.stalls.status, "exhausted");
		assert.deepEqual(stopped.active, ["stalls"], "only the stalled node is left to do");

		// Raised cap: the resume finishes the stalled node and leaves the sibling
		// alone, so its side effect is still recorded exactly once.
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "sibling-job",
			createAgentSession: factory,
			retryBaseDelayMs: 5,
			limits: { maxTransientRetries: 4 },
			sleep: async () => {},
		});
		const finished = await restored.runUntilPause();
		restored.dispose();

		assert.equal(finished.status, "completed");
		assert.deepEqual(sideEffects, ["succeeds", "stalls"], "the sibling was never rerun");
		assert.equal(finished.nodes.succeeds.runs, 1, "and its run was counted exactly once");
	} finally {
		await rm(directory, { recursive: true, force: true });
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
			const engine = new GraphEngine(loopingGraph("wrapped", { maxSteps: 1 }), {
				projectRoot: directory,
				jobId: "wrapped-job",
				createAgentSession: factory,
				retryBaseDelayMs: 5,
				sleep: async (ms) => {
					slept.push(ms);
				},
			});

			if (scenario.retried) {
				await engine.runSuperstep();
				assert.equal(attempts, 2, `${scenario.name}: retried`);
				assert.deepEqual(slept, [5], `${scenario.name}: one backoff`);
			} else {
				await assert.rejects(engine.runSuperstep(), Error, scenario.name);
				assert.equal(attempts, 1, `${scenario.name}: not retried`);
				assert.deepEqual(slept, [], `${scenario.name}: no backoff`);
				assert.equal(engine.state.status, "failed");
			}
			engine.dispose();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});
