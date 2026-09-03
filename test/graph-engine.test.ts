import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	appendEvent,
	buildReviewVerdictEventFields,
	EVENT_TYPES,
	verifyChain,
} from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import {
	liveNodeSessions,
	resetSessionsRegistry,
} from "../packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts";
import { resolveGraphBudgetLimits } from "../packages/coding-agent/src/kpi/extensions/graph/budget.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
	loadNamedGraph,
	validateGraphDefinition,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";
import type {
	AgentGraphNode,
	GraphBudgetOverrides,
	GraphDefinition,
	GraphEdge,
	GraphNode,
	GraphRunState,
} from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { reviewerBusDependencies } from "./helpers/reviewer-bus.ts";

const limits = {
	maxSteps: 12,
	maxNodeRuns: 16,
	maxConcurrency: 2,
	maxCostUsd: 5,
	timeoutMs: 1_800_000,
};

const policy = {
	allowNonInteractive: false,
	allowNonInteractiveMutations: false,
	confirmProjectGraph: true,
	confirmMutatingNodes: true,
};

function graph(
	id: string,
	nodes: GraphNode[],
	edges: GraphEdge[] = [],
	limitOverrides: Partial<typeof limits> = {},
): GraphDefinition {
	return {
		schemaVersion: 2,
		id,
		entry: nodes[0]?.id ?? "missing",
		nodes,
		edges,
		limits: { ...limits, ...limitOverrides },
		policy,
	};
}

async function fixture(): Promise<string> {
	return mkdtemp(join(tmpdir(), "k-pi-graph-"));
}

async function latestCheckpoint(projectRoot: string, jobId: string): Promise<GraphRunState> {
	const directory = join(projectRoot, ".kpi", "runs", jobId, "graph");
	const names = (await readdir(directory)).filter((name) => /^checkpoint-\d{6}\.json$/u.test(name)).sort();
	return JSON.parse(await readFile(join(directory, names.at(-1) as string), "utf8")) as GraphRunState;
}

async function terminalEvents(projectRoot: string, jobId: string): Promise<Record<string, unknown>[]> {
	const source = await readFile(join(projectRoot, ".kpi", "runs", jobId, "events.jsonl"), "utf8");
	return source
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => event.type === "loop.terminal");
}

async function allEvents(projectRoot: string, jobId: string): Promise<Record<string, unknown>[]> {
	const source = await readFile(join(projectRoot, ".kpi", "runs", jobId, "events.jsonl"), "utf8");
	return source
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function eventSchema(): Promise<JsonSchema> {
	return JSON.parse(
		await readFile(new URL("../packages/coding-agent/src/kpi/schemas/event.schema.json", import.meta.url), "utf8"),
	) as JsonSchema;
}

test("set nodes write nested state and checkpoint the superstep", async () => {
	const projectRoot = await fixture();
	try {
		const engine = new GraphEngine(
			graph("set-test", [
				{
					id: "release",
					type: "set",
					assignments: { "release.approved": true },
				},
			]),
			{ projectRoot, jobId: "set-job" },
		);

		const state = await engine.runUntilPause();
		assert.equal(state.status, "completed");
		assert.deepEqual(state.values, { policy: { onHumanDeny: "revise" }, release: { approved: true } });
		assert.deepEqual(await readdir(join(projectRoot, ".kpi", "runs", "set-job", "graph")), [
			"checkpoint-000001.json",
		]);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("agent nodes inherit the operator session model instead of resolving a different paid provider", async () => {
	const projectRoot = await fixture();
	const inheritedModel = { provider: "openai-codex", id: "gpt-test" } as Model<any>;
	const received: Array<Model<any> | undefined> = [];
	const createSession: GraphAgentSessionFactory = async (options) => {
		received.push(options.model);
		return {
			session: {
				sessionId: "inherited-model",
				async prompt() {},
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		};
	};
	try {
		const engine = new GraphEngine(flakyGraph("inherit-model"), {
			projectRoot,
			jobId: "inherit-model-job",
			createAgentSession: createSession,
			model: inheritedModel,
		});

		assert.equal((await engine.runUntilPause()).status, "completed");
		assert.deepEqual(received, [inheritedModel]);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("human nodes pause and a restored true response continues", async () => {
	const projectRoot = await fixture();
	const definition = graph(
		"human-test",
		[
			{
				id: "approval",
				type: "human",
				title: "Approve",
				question: "Continue?",
				statePath: "release.approved",
			},
			{
				id: "continued",
				type: "set",
				assignments: { continued: true },
			},
		],
		[
			{
				from: "approval",
				to: "continued",
				when: { path: "release.approved", equals: true },
			},
			{
				from: "approval",
				to: "__end__",
				when: { path: "release.approved", equals: false },
			},
		],
	);

	try {
		const engine = new GraphEngine(definition, {
			projectRoot,
			jobId: "human-job",
		});
		const paused = await engine.runUntilPause();
		assert.equal(paused.status, "interrupted");
		assert.equal(paused.pendingHuman?.nodeId, "approval");

		const restored = await GraphEngine.restore(definition, {
			projectRoot,
			jobId: "human-job",
		});
		const completed = await restored.resume({ approved: true });
		assert.equal(completed.status, "completed");
		assert.deepEqual(completed.values, {
			// The graph's own configuration is seeded so edges can read it as data.
			policy: { onHumanDeny: "revise" },
			release: { approved: true },
			continued: true,
		});
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("reviewer sessions are persisted separately from the coder thread", async () => {
	const projectRoot = await fixture();
	const calls: Parameters<GraphAgentSessionFactory>[0][] = [];
	let sessionNumber = 0;
	const createSession: GraphAgentSessionFactory = async (options) => {
		calls.push(options);
		sessionNumber += 1;
		return {
			session: {
				sessionId: `session-${sessionNumber}`,
				async prompt() {},
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		};
	};
	const coder: AgentGraphNode = {
		id: "implement",
		type: "agent",
		prompt: "implement",
		context: { mode: "thread", threadKey: "coder" },
		tools: ["read", "write"],
		readOnly: false,
	};
	const reviewer: AgentGraphNode = {
		id: "review",
		type: "agent",
		prompt: "review",
		context: { mode: "isolated" },
		tools: ["read"],
		readOnly: true,
	};

	try {
		const engine = new GraphEngine(graph("session-test", [coder, reviewer], [{ from: "implement", to: "review" }]), {
			projectRoot,
			jobId: "session-job",
			createAgentSession: createSession,
		});
		const state = await engine.runUntilPause();

		assert.equal(state.status, "completed");
		assert.equal(calls.length, 2);
		assert.notEqual(calls[0]?.sessionManager, calls[1]?.sessionManager);
		assert.equal(calls[0]?.sessionManager?.isPersisted(), true);
		assert.equal(calls[1]?.sessionManager?.isPersisted(), true);
		assert.notEqual(state.nodes.implement.sessionId, state.nodes.review.sessionId);
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("read-only agents reject write tools registered by their session", async () => {
	const projectRoot = await fixture();
	let prompted = false;
	const createSession: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: "unsafe-session",
			async prompt() {
				prompted = true;
			},
			getActiveToolNames: () => ["read", "write"],
			dispose() {},
		},
	});

	try {
		const engine = new GraphEngine(
			graph("read-only-test", [
				{
					id: "review",
					type: "agent",
					prompt: "review",
					context: { mode: "isolated" },
					tools: ["read"],
					readOnly: true,
				},
			]),
			{
				projectRoot,
				jobId: "read-only-job",
				createAgentSession: createSession,
			},
		);

		await assert.rejects(engine.runSuperstep(), /read-only agent node review registered forbidden tool write/);
		assert.equal(prompted, false);
		assert.equal(engine.state.status, "failed");
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("the packaged gated graph loads as schema version 2", async () => {
	const projectRoot = await fixture();
	try {
		const definition = await loadNamedGraph(projectRoot, "coding-loop.gated");
		assert.equal(definition.schemaVersion, 2);
		assert.equal(definition.entry, "ac-compiler");
		assert.ok(definition.nodes.some((node) => node.id === "human"));
		assert.equal(definition.policy.allowNonInteractive, false);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("an injected cost source crosses maxCostUsd without sleeps", async () => {
	const projectRoot = await fixture();
	try {
		let reads = 0;
		const engine = new GraphEngine(
			graph("cost-cap", [{ id: "spend", type: "set", assignments: { spent: true } }], [], { maxCostUsd: 5 }),
			{
				projectRoot,
				jobId: "cost-job",
				accumulatedCostUsd: () => {
					reads += 1;
					return 7.5;
				},
			},
		);

		const state = await engine.runUntilPause();

		assert.equal(state.status, "exhausted");
		assert.equal(state.terminal?.status, "EXHAUSTED");
		assert.equal(state.terminal?.limit, "maxCostUsd");
		assert.equal(state.budget.costUsd, 7.5);
		assert.ok(reads > 0, "the engine never read the injected cost source");
		assert.deepEqual(
			state.values,
			{ policy: { onHumanDeny: "revise" } },
			"an exhausted superstep must not commit writes",
		);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("session getSessionStats cost crosses maxCostUsd without a fabricated floor", async () => {
	const projectRoot = await fixture();
	try {
		let prompts = 0;
		const session = {
			sessionId: "priced-session",
			prompt: async () => {
				prompts += 1;
			},
			getSessionStats: () => ({ cost: prompts * 0.04 }),
			getActiveToolNames: () => ["read"],
			dispose: () => undefined,
		};
		const engine = new GraphEngine(
			graph(
				"session-cost-cap",
				[
					{
						id: "agent",
						type: "agent",
						prompt: "spend",
						tools: ["read"],
						readOnly: true,
						context: { mode: "thread", threadKey: "priced" },
					},
				],
				[{ from: "agent", to: "agent" }],
				{ maxCostUsd: 0.05, maxSteps: 20, maxNodeRuns: 20 },
			),
			{
				projectRoot,
				jobId: "session-cost-job",
				createAgentSession: async () => ({ session }),
			},
		);

		const state = await engine.runUntilPause();

		assert.equal(state.status, "exhausted");
		assert.equal(state.terminal?.limit, "maxCostUsd");
		assert.ok(state.budget.costUsd >= 0.05, `expected real session cost, got ${state.budget.costUsd}`);
		assert.ok(prompts >= 2, "need at least two priced prompts to cross the cap via deltas");
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("an injected clock crosses timeoutMs without sleeps", async () => {
	const projectRoot = await fixture();
	try {
		let tick = 0;
		const engine = new GraphEngine(
			graph("clock-cap", [{ id: "wait", type: "set", assignments: { waited: true } }], [], { timeoutMs: 1_000 }),
			{
				projectRoot,
				jobId: "clock-job",
				now: () => {
					const value = tick;
					tick += 1_000;
					return value;
				},
			},
		);

		const state = await engine.runUntilPause();

		assert.equal(state.status, "exhausted");
		assert.equal(state.terminal?.limit, "timeoutMs");
		assert.equal(state.budget.startedAtMs, 0);
		assert.equal(state.budget.elapsedMs, 1_000);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

interface Gate {
	promise: Promise<void>;
	open(): void;
}

function createGate(): Gate {
	let open = (): void => {};
	// Executor form: the repository targets ES2022, without Promise.withResolvers.
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

interface BatchBarrier {
	/** Holds a node until every sibling in its bounded batch has arrived. */
	hold(): Promise<void>;
	readonly peak: number;
}

/**
 * Observes peak concurrency from the engine's own scheduling instead of a
 * wall-clock delay: a batch is released by its last arrival. The bounded
 * event-loop drain is an escape hatch, not a wait — if a sibling never
 * arrives the barrier falls through and `peak` fails the assertion rather
 * than parking the suite.
 */
function createBatchBarrier(expected: number): BatchBarrier {
	let inFlight = 0;
	let peak = 0;
	let gate = createGate();

	function open(): void {
		const current = gate;
		gate = createGate();
		current.open();
	}

	return {
		async hold() {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			const current = gate;
			if (inFlight >= expected) {
				open();
			} else {
				let turns = 0;
				const drain = (): void => {
					if (current !== gate) {
						return;
					}
					turns += 1;
					if (turns > 64) {
						open();
						return;
					}
					setImmediate(drain);
				};
				setImmediate(drain);
			}
			await current.promise;
			inFlight -= 1;
		},
		get peak() {
			return peak;
		},
	};
}

test("eight ready nodes at concurrency two execute in four batches at peak concurrency two", async () => {
	const projectRoot = await fixture();
	const workerIds = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"];
	const barrier = createBatchBarrier(2);
	let sessions = 0;
	const createSession: GraphAgentSessionFactory = async (options) => {
		sessions += 1;
		const sessionId = `wide-${sessions}`;
		return {
			session: {
				sessionId,
				async prompt() {
					await barrier.hold();
				},
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		};
	};
	const workers: AgentGraphNode[] = workerIds.map((id) => ({
		id,
		type: "agent",
		prompt: id,
		context: { mode: "isolated" },
		tools: ["read"],
		readOnly: true,
	}));

	try {
		const engine = new GraphEngine(
			graph(
				"wide-superstep",
				[{ id: "fan", type: "set", assignments: { fanned: true } }, ...workers],
				workerIds.map((id) => ({ from: "fan", to: id })),
				{ maxConcurrency: 2 },
			),
			{ projectRoot, jobId: "wide-job", createAgentSession: createSession },
		);

		const state = await engine.runUntilPause();

		assert.equal(state.status, "completed", "a wide ready set must be bounded, never rejected");
		assert.equal(barrier.peak, 2);
		// One batch for the entry set node, then four bounded batches of two.
		assert.equal(state.budget.batches, 5);
		for (const id of workerIds) {
			assert.equal(state.nodes[id].status, "completed");
			assert.equal(state.nodes[id].runs, 1);
		}
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("every configured cap persists EXHAUSTED and exactly one terminal event", async () => {
	const selfLoop: GraphNode[] = [{ id: "loop", type: "set", assignments: { looped: true } }];
	const chain: GraphNode[] = [
		{ id: "first", type: "set", assignments: { first: true } },
		{ id: "second", type: "set", assignments: { second: true } },
	];
	const cases: Array<{
		limit: string;
		jobId: string;
		definition: GraphDefinition;
		options: { now?: () => number; accumulatedCostUsd?: () => number };
		expectedRound: number;
	}> = [
		{
			limit: "maxSteps",
			jobId: "cap-max-steps",
			definition: graph("cap-max-steps", chain, [{ from: "first", to: "second" }], { maxSteps: 1 }),
			options: {},
			expectedRound: 1,
		},
		{
			limit: "timeoutMs",
			jobId: "cap-timeout",
			definition: graph("cap-timeout", selfLoop, [{ from: "loop", to: "loop" }], { timeoutMs: 5_000 }),
			options: {
				now: (() => {
					let tick = 0;
					return () => {
						const value = tick;
						tick += 5_000;
						return value;
					};
				})(),
			},
			expectedRound: 0,
		},
		{
			limit: "maxCostUsd",
			jobId: "cap-cost",
			definition: graph("cap-cost", selfLoop, [{ from: "loop", to: "loop" }], { maxCostUsd: 2 }),
			options: { accumulatedCostUsd: () => 2 },
			expectedRound: 0,
		},
		{
			limit: "maxNodeRuns",
			jobId: "cap-node-runs",
			definition: graph("cap-node-runs", selfLoop, [{ from: "loop", to: "loop" }], { maxNodeRuns: 1 }),
			options: {},
			expectedRound: 1,
		},
		{
			limit: "maxRounds",
			jobId: "cap-rounds",
			definition: graph("cap-rounds", selfLoop, [{ from: "loop", to: "loop" }], { maxNodeRuns: 9 }),
			options: {},
			expectedRound: 3,
		},
	];

	for (const scenario of cases) {
		const projectRoot = await fixture();
		try {
			const engine = new GraphEngine(scenario.definition, {
				projectRoot,
				jobId: scenario.jobId,
				// maxRounds is not a graph-file cap; only the contract raises it.
				limits: scenario.limit === "maxNodeRuns" ? { maxRounds: 9 } : undefined,
				...scenario.options,
			});

			const state = await engine.runUntilPause();

			assert.equal(state.status, "exhausted", `${scenario.limit} did not reach a durable exhausted state`);
			assert.equal(state.terminal?.limit, scenario.limit);
			assert.equal(state.terminal?.status, "EXHAUSTED");
			assert.equal(state.budget.round, scenario.expectedRound, `${scenario.limit} recorded the wrong round`);

			const checkpoint = await latestCheckpoint(projectRoot, scenario.jobId);
			assert.equal(checkpoint.status, "exhausted", `${scenario.limit} was not persisted`);
			assert.equal(checkpoint.terminal?.limit, scenario.limit);
			assert.ok(checkpoint.budget.limits.maxRounds > 0, "the checkpoint must carry the resolved caps");

			const events = await terminalEvents(projectRoot, scenario.jobId);
			assert.equal(events.length, 1, `${scenario.limit} emitted ${events.length} terminal events`);
			assert.equal(events[0].status, "EXHAUSTED");
			assert.equal(events[0].job_id, scenario.jobId);

			// A second call must stay terminal and must not emit a second event.
			await engine.runSuperstep();
			assert.equal((await terminalEvents(projectRoot, scenario.jobId)).length, 1);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	}
});

test("custom task limits override graph and default caps", async () => {
	const projectRoot = await fixture();
	const contractLimits: GraphBudgetOverrides = { maxRounds: 1, maxCostUsd: 50, timeoutMs: 60_000 };
	try {
		const resolved = resolveGraphBudgetLimits(limits, contractLimits);
		assert.equal(resolved.maxRounds, 1);
		assert.equal(resolved.maxCostUsd, 50);
		assert.equal(resolved.maxSteps, limits.maxSteps, "an absent cap must fall back to the graph file");
		assert.equal(resolveGraphBudgetLimits(limits).maxRounds, 3, "maxRounds must default to the spec value");

		const engine = new GraphEngine(
			graph(
				"contract-caps",
				[{ id: "loop", type: "set", assignments: { looped: true } }],
				[{ from: "loop", to: "loop" }],
			),
			{ projectRoot, jobId: "contract-job", limits: contractLimits },
		);
		assert.equal(engine.limits.maxRounds, 1);

		const state = await engine.runUntilPause();
		assert.equal(state.status, "exhausted");
		assert.equal(state.terminal?.limit, "maxRounds");
		assert.equal(state.nodes.loop.runs, 1, "a custom maxRounds must stop the loop after one run");
		assert.equal(state.budget.limits.maxCostUsd, 50);

		assert.throws(
			() => resolveGraphBudgetLimits(limits, { maxRounds: 0 }),
			/task limits\.maxRounds must be a positive number/u,
		);
		assert.throws(
			() => resolveGraphBudgetLimits(limits, { maxSteps: 2.5 }),
			/task limits\.maxSteps must be a positive integer/u,
		);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

/** A prompt that fails transiently a fixed number of times, then succeeds. */
function flakyFactory(
	failures: number,
	make: () => unknown,
): { factory: GraphAgentSessionFactory; attempts: () => number } {
	let attempts = 0;
	const factory: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: "flaky",
			async prompt() {
				attempts += 1;
				if (attempts <= failures) {
					throw make();
				}
			},
			getActiveToolNames: () => [...(options.tools ?? [])],
			dispose() {},
		},
	});
	return { factory, attempts: () => attempts };
}

function transientError(kind: "http" | "timeout" | "transport"): Error {
	if (kind === "http") {
		return Object.assign(new Error("Too Many Requests"), { status: 429 });
	}
	if (kind === "timeout") {
		return Object.assign(new Error("request timed out"), { code: "UND_ERR_HEADERS_TIMEOUT" });
	}
	return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

function flakyGraph(id: string): GraphDefinition {
	return graph(
		id,
		[
			{
				id: "implement",
				type: "agent",
				prompt: "implement",
				context: { mode: "isolated" },
				tools: ["read"],
				readOnly: true,
			},
		],
		[{ from: "implement", to: "__end__" }],
	);
}

/** A one-node reviewer-worker graph, the same shape as test/reviewer-session.test.ts's reviewGraph. */
function reviewGraphFixture(): GraphDefinition {
	return graph(
		"review-worker-lifecycle",
		[
			{
				id: "review",
				type: "agent",
				prompt: "Apply the isolated-review skill. Publish verdict via write_contract.",
				context: { mode: "isolated" },
				tools: ["read", "grep", "find", "ls"],
				readOnly: true,
				workerRole: "reviewer",
				response: {
					path: "verdict.json",
					schema: "verdict.schema.json",
					retries: 0,
					state: {
						"review.approved": "approved",
						"review.status": "status",
						"review.output_fingerprint": "output_fingerprint",
					},
				},
			},
		],
		[{ from: "review", to: "__end__" }],
	);
}

test("a transient prompt failure retries in place with exponential backoff", async () => {
	for (const kind of ["http", "timeout", "transport"] as const) {
		const projectRoot = await fixture();
		try {
			const slept: number[] = [];
			const { factory, attempts } = flakyFactory(1, () => transientError(kind));
			const engine = new GraphEngine(flakyGraph(`retry-${kind}`), {
				projectRoot,
				jobId: `retry-${kind}-job`,
				createAgentSession: factory,
				sleep: async (ms) => {
					slept.push(ms);
				},
				retryBaseDelayMs: 100,
			});

			const state = await engine.runUntilPause();

			assert.equal(state.status, "completed", kind);
			assert.equal(attempts(), 2, `${kind}: the node was retried exactly once`);
			assert.deepEqual(slept, [100], `${kind}: the first backoff step`);
			assert.equal(state.nodes.implement.runs, 1, `${kind}: a retry is not a run`);
			assert.equal(state.budget.round, 1, `${kind}: a retry is not a round`);
			assert.equal(state.nodes.implement.transientRetries, 1);
			assert.deepEqual(state.nodes.implement.retryDelaysMs, [100]);
			engine.dispose();
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	}
});

test("two transient failures retry twice with increasing delays and still finish", async () => {
	const projectRoot = await fixture();
	try {
		const slept: number[] = [];
		const { factory, attempts } = flakyFactory(2, () => transientError("timeout"));
		const engine = new GraphEngine(flakyGraph("retry-twice"), {
			projectRoot,
			jobId: "retry-twice-job",
			createAgentSession: factory,
			sleep: async (ms) => {
				slept.push(ms);
			},
			retryBaseDelayMs: 50,
		});

		const state = await engine.runUntilPause();

		assert.equal(state.status, "completed");
		assert.equal(attempts(), 3);
		assert.deepEqual(slept, [50, 100], "each retry waits twice as long as the last");
		assert.equal(state.nodes.implement.runs, 1);
		assert.equal(state.budget.round, 1);
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("a third transient failure ends the run as EXHAUSTED without a third sleep", async () => {
	const projectRoot = await fixture();
	try {
		const slept: number[] = [];
		const { factory, attempts } = flakyFactory(3, () => transientError("transport"));
		const engine = new GraphEngine(flakyGraph("retry-spent"), {
			projectRoot,
			jobId: "retry-spent-job",
			createAgentSession: factory,
			sleep: async (ms) => {
				slept.push(ms);
			},
			retryBaseDelayMs: 20,
		});

		const state = await engine.runUntilPause();

		assert.equal(state.status, "exhausted", "a spent retry allowance is a product outcome, not a crash");
		assert.equal(state.terminal?.status, "EXHAUSTED");
		assert.equal(state.terminal?.limit, "maxTransientRetries");
		assert.match(state.terminal?.reason ?? "", /exhausted maxTransientRetries 2 after a transport failure/u);
		assert.equal(attempts(), 3, "the third failure is not retried");
		assert.deepEqual(slept, [20, 40], "no third backoff was waited");
		assert.equal(state.nodes.implement.runs, 1, "retries never advanced the run");
		assert.deepEqual(state.active, ["implement"], "the stalled node stays unresolved");

		const events = await terminalEvents(projectRoot, "retry-spent-job");
		assert.equal(events.length, 1, "exactly one terminal event");
		assert.equal(events[0].status, "EXHAUSTED");
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("an assistant provider failure keeps its real reason instead of becoming missing response text", async () => {
	const projectRoot = await fixture();
	const providerFailure =
		'400 {"type":"error","error":{"message":"You\'re out of extra usage. Add more and keep going."}}';
	const createSession: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: "provider-failure",
			async prompt() {},
			getLastAssistantError: () => providerFailure,
			getActiveToolNames: () => [...(options.tools ?? [])],
			dispose() {},
		},
	});
	try {
		const engine = new GraphEngine(flakyGraph("provider-failure"), {
			projectRoot,
			jobId: "provider-failure-job",
			createAgentSession: createSession,
		});

		await assert.rejects(engine.runSuperstep(), /out of extra usage/u);
		assert.match(engine.state.nodes.implement.error ?? "", /out of extra usage/u);
		assert.doesNotMatch(engine.state.nodes.implement.error ?? "", /assistant response text is unavailable/u);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("a non-transient failure is never retried", async () => {
	const cases: Array<{ name: string; error: () => unknown }> = [
		{
			name: "operator abort",
			error: () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
		},
		{ name: "validation", error: () => new Error("agent node implement produced an unusable answer") },
		{ name: "http 500", error: () => Object.assign(new Error("Internal Server Error"), { status: 500 }) },
	];
	for (const scenario of cases) {
		const projectRoot = await fixture();
		try {
			const slept: number[] = [];
			const { factory, attempts } = flakyFactory(1, scenario.error);
			const engine = new GraphEngine(flakyGraph("no-retry"), {
				projectRoot,
				jobId: "no-retry-job",
				createAgentSession: factory,
				sleep: async (ms) => {
					slept.push(ms);
				},
			});

			await assert.rejects(engine.runSuperstep(), Error, scenario.name);
			assert.equal(attempts(), 1, `${scenario.name}: no retry`);
			assert.deepEqual(slept, [], `${scenario.name}: no backoff`);
			assert.equal(engine.state.status, "failed", `${scenario.name}: a defect is a failure, not a budget outcome`);
			assert.equal(engine.state.nodes.implement.transientRetries, 0, "the run's allowance was never spent");
			engine.dispose();
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	}
});

test("a read-only contract breach is a defect, not a transient failure", async () => {
	const projectRoot = await fixture();
	try {
		const slept: number[] = [];
		const createSession: GraphAgentSessionFactory = async () => ({
			session: {
				sessionId: "unsafe",
				async prompt() {},
				getActiveToolNames: () => ["read", "write"],
				dispose() {},
			},
		});
		const engine = new GraphEngine(flakyGraph("contract-breach"), {
			projectRoot,
			jobId: "contract-breach-job",
			createAgentSession: createSession,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});

		await assert.rejects(engine.runSuperstep(), /registered forbidden tool write/u);
		assert.deepEqual(slept, [], "a contract defect is never retried");
		assert.equal(engine.state.status, "failed");
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("review.verdict is a first-class event and fields stay concise", async () => {
	assert.ok(EVENT_TYPES.includes("review.verdict"));
	const fields = buildReviewVerdictEventFields({
		status: "PASS",
		approved: true,
		blockingIssues: [],
		nonBlockingIssues: ["nit"],
		evidence: ["evidence.json"],
		round: 1,
		output_fingerprint: `sha256:${"d".repeat(64)}`,
	});
	assert.equal(fields?.blocking_count, 0);
	assert.equal(fields?.approved, true);
	assert.equal("blockingIssues" in (fields as object), false);

	const projectRoot = await fixture();
	try {
		const path = join(projectRoot, ".kpi", "runs", "rv-job", "events.jsonl");
		await mkdir(join(projectRoot, ".kpi", "runs", "rv-job"), { recursive: true });
		await appendEvent(path, {
			ts: "2026-01-01T00:00:00.000Z",
			type: "review.verdict",
			job_id: "rv-job",
			round: 1,
			node: "review",
			...fields!,
		});
		const lines = (await readFile(path, "utf8")).trim().split("\n");
		const event = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
		assert.equal(event.type, "review.verdict");
		assert.equal(event.blocking_count, 0);
		assert.doesNotMatch(JSON.stringify(event), /blockingIssues|nit|evidence\.json/);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("a denied human node with a feedback path writes the feedback and the re-run node reads it in its prompt", async () => {
	const projectRoot = await fixture();
	const prompts: string[] = [];
	const factory: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: `draft-${prompts.length + 1}`,
			async prompt(prompt) {
				prompts.push(prompt);
			},
			getActiveToolNames: () => [...(options.tools ?? [])],
			dispose() {},
		},
	});
	const definition = graph(
		"feedback-loop",
		[
			{
				id: "draft",
				type: "agent",
				prompt: "Draft the plan",
				context: { mode: "isolated" },
				tools: ["read"],
				readOnly: true,
				feedbackPath: "draft.feedback",
			},
			{
				id: "check",
				type: "human",
				title: "Check the draft",
				question: "Keep it?",
				statePath: "draft.ok",
				feedbackPath: "draft.feedback",
			},
		],
		[
			{ from: "draft", to: "check" },
			{ from: "check", to: "draft", when: { path: "draft.ok", equals: false } },
			{ from: "check", to: "__end__", when: { path: "draft.ok", equals: true } },
		],
	);
	try {
		const engine = new GraphEngine(definition, { projectRoot, jobId: "feedback-job", createAgentSession: factory });
		const paused = await engine.runUntilPause();
		assert.equal(paused.status, "interrupted");
		assert.equal(prompts.length, 1);
		assert.doesNotMatch(prompts[0] ?? "", /Operator feedback/u);

		// A denial of a node that carries feedback must say what to change.
		await assert.rejects(engine.submitHuman({ approved: false }), /human node check was denied without feedback/u);
		await assert.rejects(engine.submitHuman({ approved: false, feedback: "   " }), /denied without feedback/u);
		assert.equal(engine.state.status, "interrupted", "a refused answer leaves the gate pending");

		const again = await engine.resume({ approved: false, feedback: "  tighter " });
		assert.equal(again.status, "interrupted", "the change request routed back to draft, which asked again");
		assert.equal((again.values.draft as { feedback?: string }).feedback, "tighter");
		assert.equal(prompts.length, 2);
		assert.ok(
			(prompts[1] ?? "").includes(
				"Operator feedback on your previous response (node run 2):\ntighter\nAddress every point, then return the corrected JSON only.",
			),
			prompts[1],
		);
		const completed = await engine.resume({ approved: true });
		assert.equal(completed.status, "completed");
		engine.dispose();

		// A gate without a feedback path takes no feedback at all.
		const plain = graph(
			"plain-gate",
			[{ id: "gate", type: "human", title: "Gate", question: "Go?", statePath: "gate.ok" }],
			[{ from: "gate", to: "__end__", when: { path: "gate.ok", equals: true } }],
		);
		const plainEngine = new GraphEngine(plain, { projectRoot, jobId: "plain-job" });
		await plainEngine.runUntilPause();
		await assert.rejects(
			plainEngine.submitHuman({ approved: true, feedback: "x" }),
			/human node gate accepts no feedback/u,
		);

		// The new fields are validated like every other node field.
		const [draft, check] = definition.nodes;
		assert.throws(
			() => validateGraphDefinition({ ...definition, nodes: [draft, { ...check, feedbackPath: "a..b" }] }),
			/human node check contains an invalid state path: a\.\.b/u,
		);
		assert.throws(
			() => validateGraphDefinition({ ...definition, nodes: [draft, { ...check, detail: "verdict.json" }] }),
			/human node check\.detail must be stack\.json/u,
		);
		assert.throws(
			() => validateGraphDefinition({ ...definition, nodes: [{ ...draft, feedbackPath: "" }, check] }),
			/agent node draft\.feedbackPath must be a non-empty string/u,
		);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("agent nodes append node.started and node.finished with run, elapsed and cost", async () => {
	const projectRoot = await fixture();
	try {
		let nowMs = 0;
		let prompts = 0;
		const session = {
			sessionId: "priced-session",
			prompt: async () => {
				prompts += 1;
				nowMs += 1500;
			},
			getSessionStats: () => ({ cost: prompts * 0.04 }),
			getActiveToolNames: () => ["read"],
			dispose: () => undefined,
		};
		const engine = new GraphEngine(flakyGraph("lifecycle"), {
			projectRoot,
			jobId: "lifecycle-job",
			createAgentSession: async () => ({ session }),
			model: { provider: "openai-codex", id: "gpt-test" } as Model<any>,
			now: () => nowMs,
		});

		const state = await engine.runUntilPause();
		assert.equal(state.status, "completed");

		const events = await allEvents(projectRoot, "lifecycle-job");
		const started = events.find((event) => event.type === "node.started");
		const finished = events.find((event) => event.type === "node.finished");
		assert.ok(started, "node.started was appended");
		assert.ok(finished, "node.finished was appended");
		assert.ok(events.indexOf(started!) < events.indexOf(finished!), "node.started precedes node.finished");
		assert.equal(started?.node, "implement");
		assert.equal(started?.run, 1);
		assert.equal(started?.model, "openai-codex/gpt-test");
		assert.equal(finished?.node, "implement");
		assert.equal(finished?.run, 1);
		assert.equal(finished?.status, "completed");
		assert.equal(finished?.elapsed_ms, 1500);
		assert.equal(finished?.cost_usd, 0.04);
		assert.equal(finished?.session, "priced-session");
		assert.equal("result" in (finished as object), false, "no response was declared");
		assert.equal(finished?.ts, new Date(1500).toISOString());

		const schema = await eventSchema();
		assert.deepEqual(validateJsonSchema(started, schema), []);
		assert.deepEqual(validateJsonSchema(finished, schema), []);
		assert.equal(
			await verifyChain(join(projectRoot, ".kpi", "runs", "lifecycle-job", "events.jsonl")),
			true,
			"the lifecycle records are hash-chained like every other event",
		);

		// A set node emits neither record — indeed a set-only run never appends
		// events.jsonl at all, since nothing else in it does either.
		const setProjectRoot = await fixture();
		try {
			const setEngine = new GraphEngine(graph("set-only", [{ id: "s", type: "set", assignments: { a: true } }]), {
				projectRoot: setProjectRoot,
				jobId: "set-only-job",
			});
			await setEngine.runUntilPause();
			const eventsPath = join(setProjectRoot, ".kpi", "runs", "set-only-job", "events.jsonl");
			await assert.rejects(readFile(eventsPath, "utf8"), /ENOENT/u, "a set-only run writes no event log");
		} finally {
			await rm(setProjectRoot, { recursive: true, force: true });
		}

		// A workerRole node emits both records too, but never a fabricated cost.
		const workerJobId = "lifecycle-worker";
		const workerDirectory = await mkdtemp(join(tmpdir(), "k-pi-graph-worker-"));
		try {
			const workerEngine = new GraphEngine(reviewGraphFixture(), {
				projectRoot: workerDirectory,
				jobId: workerJobId,
				busDependencies: reviewerBusDependencies(),
			});
			const workerState = await workerEngine.runUntilPause();
			assert.equal(workerState.status, "completed");
			const workerEvents = await allEvents(workerDirectory, workerJobId);
			const workerStarted = workerEvents.find((event) => event.type === "node.started" && event.node === "review");
			const workerFinished = workerEvents.find((event) => event.type === "node.finished" && event.node === "review");
			assert.ok(workerStarted);
			assert.ok(workerFinished);
			assert.equal(workerFinished?.status, "completed");
			assert.equal("cost_usd" in (workerFinished as object), false, "worker nodes never fabricate a session cost");
			assert.deepEqual(validateJsonSchema(workerStarted, schema), []);
			assert.deepEqual(validateJsonSchema(workerFinished, schema), []);
		} finally {
			await rm(workerDirectory, { recursive: true, force: true });
		}
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("a failed agent node records node.finished failed with its error and sums cost across retries", async () => {
	// A non-transient failure: node.finished failed, no cost_usd key without getSessionStats.
	const projectRoot = await fixture();
	try {
		const failingSession = {
			sessionId: "unpriced-session",
			prompt: async () => {
				throw new Error("prompt refused: bad input");
			},
			getActiveToolNames: () => ["read"],
			dispose: () => undefined,
		};
		const engine = new GraphEngine(flakyGraph("lifecycle-fail"), {
			projectRoot,
			jobId: "lifecycle-fail-job",
			createAgentSession: async () => ({ session: failingSession }),
		});

		await assert.rejects(engine.runSuperstep(), /prompt refused: bad input/u);
		const events = await allEvents(projectRoot, "lifecycle-fail-job");
		const finished = events.find((event) => event.type === "node.finished");
		assert.ok(finished);
		assert.equal(finished?.status, "failed");
		assert.match(String(finished?.error), /prompt refused: bad input/u);
		assert.equal("cost_usd" in (finished as object), false);
		const terminals = events.filter((event) => event.type === "loop.terminal");
		assert.equal(terminals.length, 0, "a failed superstep does not itself append the terminal event");
		const schema = await eventSchema();
		assert.deepEqual(validateJsonSchema(finished, schema), []);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}

	// A transient failure then a success: exactly one started/finished pair for
	// the run, cost summed across both isolated-mode attempts.
	const retryRoot = await fixture();
	try {
		let attempt = 0;
		const factory: GraphAgentSessionFactory = async (options) => {
			attempt += 1;
			const isFirstAttempt = attempt === 1;
			let localPrompts = 0;
			return {
				session: {
					sessionId: `retry-session-${attempt}`,
					async prompt() {
						localPrompts += 1;
						if (isFirstAttempt) {
							throw Object.assign(new Error("Too Many Requests"), { status: 429 });
						}
					},
					getSessionStats: () => ({ cost: localPrompts * 0.04 }),
					getActiveToolNames: () => [...(options.tools ?? [])],
					dispose() {},
				},
			};
		};
		const slept: number[] = [];
		const engine = new GraphEngine(flakyGraph("lifecycle-retry"), {
			projectRoot: retryRoot,
			jobId: "lifecycle-retry-job",
			createAgentSession: factory,
			sleep: async (ms) => {
				slept.push(ms);
			},
			retryBaseDelayMs: 0,
		});

		const state = await engine.runUntilPause();
		assert.equal(state.status, "completed");
		assert.deepEqual(slept, [0], "one backoff between the two attempts");
		const events = await allEvents(retryRoot, "lifecycle-retry-job");
		const started = events.filter((event) => event.type === "node.started");
		const finished = events.filter((event) => event.type === "node.finished");
		assert.equal(started.length, 1, "transient retries inside one run do not repeat node.started");
		assert.equal(finished.length, 1, "transient retries inside one run do not repeat node.finished");
		assert.equal(finished[0]?.status, "completed");
		assert.equal(finished[0]?.run, 1);
		assert.ok(
			Math.abs((finished[0]?.cost_usd as number) - 0.08) < 1e-9,
			`cost sums both attempts' deltas: got ${finished[0]?.cost_usd}`,
		);
		assert.ok(typeof finished[0]?.elapsed_ms === "number" && (finished[0]?.elapsed_ms as number) >= 0);
	} finally {
		await rm(retryRoot, { recursive: true, force: true });
	}
});

test("a running agent node is a live in-process session until it settles, and the engine says when it changes", async () => {
	const projectRoot = await fixture();
	resetSessionsRegistry();
	try {
		const entered = createGate();
		const release = createGate();
		let seenDuringRun: ReturnType<typeof liveNodeSessions> = [];
		const changes: number[] = [];
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: "live-session",
				async prompt() {
					seenDuringRun = liveNodeSessions();
					entered.open();
					await release.promise;
				},
				getSessionStats: () => ({ cost: 0.1, toolCalls: 3 }),
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		});
		const engine = new GraphEngine(flakyGraph("live-session"), {
			projectRoot,
			jobId: "live-session-job",
			createAgentSession: factory,
			model: { provider: "openai-codex", id: "gpt-test" } as Model<any>,
			onSessionsChange: () => {
				changes.push(liveNodeSessions().length);
			},
		});

		const running = engine.runUntilPause();
		await entered.promise;

		assert.equal(seenDuringRun.length, 1, "the node's session is live while prompt() is in flight");
		assert.equal(seenDuringRun[0]?.jobId, "live-session-job");
		assert.equal(seenDuringRun[0]?.nodeId, "implement");
		assert.equal(seenDuringRun[0]?.sessionId, "live-session");
		assert.equal(seenDuringRun[0]?.contextMode, "isolated");
		assert.equal(seenDuringRun[0]?.model, "openai-codex/gpt-test");
		assert.equal(seenDuringRun[0]?.stats?.()?.cost, 0.1);
		assert.equal(liveNodeSessions().length, 1);

		release.open();
		const state = await running;
		assert.equal(state.status, "completed");
		assert.equal(liveNodeSessions().length, 0, "the session is released once the node settles");
		assert.ok(changes.length >= 2, "onSessionsChange fired at least once on register and once on release");
	} finally {
		resetSessionsRegistry();
		await rm(projectRoot, { recursive: true, force: true });
	}
});
