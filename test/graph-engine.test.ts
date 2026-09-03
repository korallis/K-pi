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
import {
	type GraphAgentSessionFactory,
	GraphEngine,
	GraphNodeProviderError,
	loadNamedGraph,
	OperatorStopError,
	validateGraphDefinition,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";
import type {
	AgentGraphNode,
	GraphDefinition,
	GraphEdge,
	GraphNode,
	GraphRunState,
} from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { classifyTransientFailure } from "../packages/coding-agent/src/kpi/extensions/graph/stop.ts";
import { reviewerBusDependencies } from "./helpers/reviewer-bus.ts";

const limits = { maxConcurrency: 2 };

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

		const state = await engine.runSuperstep();
		assert.equal(prompted, false);
		assert.equal(state.status, "paused", "a contract defect parks the run rather than crashing it");
		assert.equal(state.pause?.recovery, "contract");
		assert.match(state.pause?.reason ?? "", /read-only agent node review registered forbidden tool write/u);
		assert.equal(state.nodes.review.status, "failed");
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

test("no counter or clock ends a run: cost, elapsed time, steps, and node runs only report", async () => {
	const projectRoot = await fixture();
	try {
		// Ten hours on the clock, 99 USD on the meter, and an implement<->test
		// loop that needs forty implement runs before the tests go green. Every
		// retired cap (maxSteps 24, maxNodeRuns 16, maxCostUsd 5, timeoutMs 30 min,
		// maxRounds 3) would have ended this run; none of them exists.
		let implementRuns = 0;
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: `implement-${implementRuns + 1}`,
				async prompt() {
					implementRuns += 1;
				},
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		});
		const definition = graph(
			"report-only",
			[
				{
					id: "implement",
					type: "agent",
					prompt: "implement",
					context: { mode: "isolated" },
					tools: ["read"],
					readOnly: true,
				},
				{ id: "test", type: "set", assignments: { "test.ran": true } },
			],
			[
				{ from: "implement", to: "test" },
				{ from: "test", to: "implement", when: { path: "test.passed", equals: false } },
				{ from: "test", to: "__end__", when: { path: "test.passed", equals: true } },
			],
		);
		const tenHours = 10 * 60 * 60 * 1_000;
		let readsOfTheMeter = 0;
		let started = false;
		const engine = new GraphEngine(definition, {
			projectRoot,
			jobId: "report-only-job",
			createAgentSession: factory,
			// The run starts at t=1000 and every later reading is ten hours on.
			now: () => {
				if (started) {
					return 1_000 + tenHours;
				}
				started = true;
				return 1_000;
			},
			accumulatedCostUsd: () => {
				readsOfTheMeter += 1;
				return 99;
			},
			resolveFacts: async () => ({ "test.passed": implementRuns >= 40 }),
		});

		const state = await engine.runUntilPause();

		assert.equal(state.status, "completed");
		assert.equal(state.pause, undefined, "nothing paused the run");
		assert.equal(state.nodes.implement.runs, 40);
		assert.equal(state.budget.round, 40, "forty rounds, no maximum");
		assert.ok(state.superstep > 24, `${state.superstep} supersteps, past the retired maxSteps`);
		assert.equal(state.budget.costUsd, 99, "the meter is reported as read");
		assert.ok(readsOfTheMeter > 0, "the engine read the meter");
		assert.equal(state.budget.elapsedMs, tenHours, "the clock is reported as read");
		assert.deepEqual(Object.keys(state.budget.limits), ["maxConcurrency"], "the only limit a run carries");
		const events = await allEvents(projectRoot, "report-only-job");
		assert.equal(events.filter((event) => event.type === "loop.terminal").length, 0, "zero loop.terminal events");

		// A graph file still declaring a cap is refused, not silently uncapped.
		for (const key of ["maxSteps", "maxCostUsd", "timeoutMs", "maxNodeRuns", "maxRounds", "maxTransientRetries"]) {
			assert.throws(
				() => validateGraphDefinition({ ...definition, limits: { maxConcurrency: 1, [key]: 5 } }),
				new RegExp(`graph limits\\.${key} was retired`, "u"),
				key,
			);
		}
		assert.throws(
			() => validateGraphDefinition({ ...definition, limits: {} }),
			/graph limits\.maxConcurrency must be a positive number/u,
		);
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

test("a pause node parks the run with its resume targets and a rearm continues there", async () => {
	const projectRoot = await fixture();
	const prompts: string[] = [];
	const factory: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: `s-${prompts.length}`,
			async prompt(prompt) {
				prompts.push(prompt.split("\n", 1)[0]);
			},
			getActiveToolNames: () => [...(options.tools ?? [])],
			dispose() {},
		},
	});
	const definition = graph(
		"pause-route",
		[
			{
				id: "implement",
				type: "agent",
				prompt: "implement",
				context: { mode: "isolated" },
				tools: ["read"],
				readOnly: true,
			},
			{ id: "test", type: "agent", prompt: "test", context: { mode: "isolated" }, tools: ["read"], readOnly: true },
			{
				id: "unsafe",
				type: "pause",
				recovery: "bounds",
				reason: "a write left the task's declared bounds",
				resume: ["test"],
			},
		],
		[
			{ from: "implement", to: "test" },
			{ from: "test", to: "unsafe", when: { path: "bounds.held", equals: false } },
			{ from: "test", to: "__end__", when: { path: "bounds.held", equals: true } },
		],
	);
	try {
		let held = false;
		const engine = new GraphEngine(definition, {
			projectRoot,
			jobId: "pause-job",
			createAgentSession: factory,
			resolveFacts: async () => ({ "bounds.held": held }),
		});

		const paused = await engine.runUntilPause();
		assert.equal(paused.status, "paused");
		assert.equal(paused.pause?.recovery, "bounds");
		assert.equal(paused.pause?.reason, "a write left the task's declared bounds");
		assert.deepEqual(paused.pause?.resume, ["test"]);
		assert.deepEqual(paused.pause?.nodes, ["unsafe"]);
		assert.equal(paused.pause?.round, 1);
		assert.deepEqual(prompts, ["implement", "test"]);

		const checkpoint = await latestCheckpoint(projectRoot, "pause-job");
		assert.equal(checkpoint.status, "paused");
		assert.deepEqual(checkpoint.pause?.resume, ["test"]);
		const terminals = await terminalEvents(projectRoot, "pause-job");
		assert.equal(terminals.length, 1, "exactly one terminal event");
		assert.equal(terminals[0].status, "NEEDS_HUMAN");
		assert.equal(terminals[0].recovery, "bounds");
		assert.equal(terminals[0].reason, "a write left the task's declared bounds");
		assert.equal(terminals[0].node, "unsafe");
		assert.deepEqual(validateJsonSchema(terminals[0], await eventSchema()), []);

		// A paused run stays paused: a further superstep does nothing and emits nothing.
		await engine.runSuperstep();
		assert.equal((await terminalEvents(projectRoot, "pause-job")).length, 1);

		// The operator fixed the bounds; keep going resumes at the pause's targets.
		held = true;
		engine.rearm();
		assert.equal(engine.state.status, "running");
		assert.deepEqual(engine.state.active, ["test"]);
		assert.equal(engine.state.nodes.test.status, "pending");
		assert.equal(engine.state.pause, undefined);

		const completed = await engine.runUntilPause();
		assert.equal(completed.status, "completed");
		assert.deepEqual(prompts, ["implement", "test", "test"], "only the resume target ran again");
		assert.equal(completed.nodes.implement.runs, 1);
		assert.equal(completed.nodes.test.runs, 2);
		assert.equal((await terminalEvents(projectRoot, "pause-job")).length, 1, "a resume emits no second terminal");

		// Pause nodes are validated like every other node.
		const [implement, testNode, unsafe] = definition.nodes;
		assert.throws(
			() =>
				validateGraphDefinition({ ...definition, nodes: [implement, testNode, { ...unsafe, recovery: "tired" }] }),
			/pause node unsafe\.recovery must be one of approval \| provider/u,
		);
		assert.throws(
			() => validateGraphDefinition({ ...definition, nodes: [implement, testNode, { ...unsafe, reason: "" }] }),
			/pause node unsafe\.reason must be a non-empty string/u,
		);
		assert.throws(
			() => validateGraphDefinition({ ...definition, nodes: [implement, testNode, { ...unsafe, resume: [] }] }),
			/pause node unsafe\.resume must name at least one node/u,
		);
		assert.throws(
			() =>
				validateGraphDefinition({
					...definition,
					nodes: [implement, testNode, { ...unsafe, resume: ["nowhere"] }],
				}),
			/pause node unsafe resumes at nowhere, which does not exist/u,
		);
		assert.throws(
			() =>
				validateGraphDefinition({
					...definition,
					nodes: [implement, testNode, unsafe, { ...unsafe, id: "other", resume: ["unsafe"] }],
				}),
			/pause node other cannot resume at pause node unsafe/u,
		);
		assert.throws(
			() => validateGraphDefinition({ ...definition, edges: [...definition.edges, { from: "unsafe", to: "test" }] }),
			/pause node unsafe cannot have outgoing edges/u,
		);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("a contract failure pauses with recovery contract instead of failing the run", async () => {
	const projectRoot = await fixture();
	let registered = ["read", "bash"];
	const createSession: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: "breach",
			async prompt() {},
			getActiveToolNames: () => registered,
			dispose() {},
		},
	});
	try {
		const engine = new GraphEngine(flakyGraph("contract-pause"), {
			projectRoot,
			jobId: "contract-pause-job",
			createAgentSession: createSession,
		});

		const paused = await engine.runSuperstep();
		assert.equal(paused.status, "paused");
		assert.equal(paused.pause?.recovery, "contract");
		assert.match(paused.pause?.reason ?? "", /read-only agent node implement registered forbidden tool bash/u);
		assert.equal(paused.nodes.implement.status, "failed");
		assert.match(paused.nodes.implement.error ?? "", /forbidden tool bash/u);
		assert.deepEqual(paused.pause?.resume, ["implement"]);
		assert.deepEqual(paused.pause?.nodes, ["implement"]);
		const terminals = await terminalEvents(projectRoot, "contract-pause-job");
		assert.equal(terminals.length, 1);
		assert.equal(terminals[0].status, "NEEDS_HUMAN");
		assert.equal(terminals[0].recovery, "contract");
		engine.dispose();

		// The operator fixed the session; a restore re-arms and reruns the node.
		registered = ["read"];
		const restored = await GraphEngine.restore(flakyGraph("contract-pause"), {
			projectRoot,
			jobId: "contract-pause-job",
			createAgentSession: createSession,
		});
		assert.equal(restored.state.status, "running");
		assert.deepEqual(restored.state.active, ["implement"]);
		assert.equal(restored.state.nodes.implement.status, "pending");
		assert.equal(restored.state.pause, undefined);
		assert.deepEqual(restored.retiredLimits, []);
		const completed = await restored.runUntilPause();
		assert.equal(completed.status, "completed");
		assert.equal(completed.nodes.implement.runs, 2);
		assert.equal((await terminalEvents(projectRoot, "contract-pause-job")).length, 1);
		restored.dispose();
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

test("transient failures retry for as long as it takes with a capped backoff and a node.retry event each time", async () => {
	const projectRoot = await fixture();
	try {
		const kinds = ["timeout", "transport", "http503"] as const;
		let failures = 0;
		const { factory, attempts } = flakyFactory(9, () => {
			const kind = kinds[failures % kinds.length];
			failures += 1;
			return kind === "http503"
				? Object.assign(new Error("Service Unavailable"), { status: 503 })
				: transientError(kind);
		});
		const slept: number[] = [];
		const retries: Array<{ attempt: number; reason: string; status?: number; delayMs: number; message: string }> = [];
		const checkpointsBeforeWait: Array<{ transientRetries?: number; retryAtMs?: number; retryReason?: string }> = [];
		let nowMs = 1_000_000;
		const engine = new GraphEngine(flakyGraph("retry-forever"), {
			projectRoot,
			jobId: "retry-forever-job",
			createAgentSession: factory,
			now: () => nowMs,
			retryBaseDelayMs: 10_000,
			onRetry: async (retry) => {
				retries.push({ ...retry });
			},
			sleep: async (ms) => {
				// The checkpoint on disk already carries the retry before the wait starts.
				const checkpoint = await latestCheckpoint(projectRoot, "retry-forever-job");
				const node = checkpoint.nodes.implement;
				checkpointsBeforeWait.push({
					transientRetries: node.transientRetries,
					retryAtMs: node.retryAtMs,
					retryReason: node.retryReason,
				});
				assert.equal(retries.length, slept.length + 1, "onRetry was told before the wait");
				slept.push(ms);
				nowMs += ms;
			},
		});

		const state = await engine.runUntilPause();

		assert.equal(state.status, "completed");
		assert.equal(attempts(), 10, "nine failures, then success");
		assert.deepEqual(slept, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
		assert.deepEqual(
			retries.map((retry) => retry.attempt),
			[1, 2, 3, 4, 5, 6, 7, 8, 9],
		);
		assert.deepEqual(
			retries.map((retry) => retry.delayMs),
			slept,
		);
		assert.deepEqual(
			retries.map((retry) => retry.reason),
			["timeout", "transport", "http", "timeout", "transport", "http", "timeout", "transport", "http"],
		);
		assert.deepEqual(
			retries.map((retry) => retry.status),
			[undefined, undefined, 503, undefined, undefined, 503, undefined, undefined, 503],
		);
		assert.equal(retries[2]?.message, "Service Unavailable");
		assert.deepEqual(
			checkpointsBeforeWait.map((checkpoint) => checkpoint.transientRetries),
			[1, 2, 3, 4, 5, 6, 7, 8, 9],
			"every checkpoint before a wait carries the count",
		);
		for (const [index, checkpoint] of checkpointsBeforeWait.entries()) {
			assert.equal(typeof checkpoint.retryAtMs, "number", `wait ${index + 1}: retryAtMs is checkpointed`);
			assert.equal(checkpoint.retryReason, retries[index]?.reason, `wait ${index + 1}: reason is checkpointed`);
		}
		assert.equal(state.nodes.implement.runs, 1, "retries never advanced the run");
		assert.equal(state.budget.round, 1, "retries never advanced the round");
		assert.equal(state.nodes.implement.transientRetries, 9);
		assert.equal(state.nodes.implement.retryAtMs, undefined, "no wait is pending once the node succeeded");
		assert.equal(state.pause, undefined);
		assert.equal((await terminalEvents(projectRoot, "retry-forever-job")).length, 0, "zero loop.terminal events");
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("a transient 429 retry does not increment the round", async () => {
	const projectRoot = await fixture();
	try {
		const { factory, attempts } = flakyFactory(1, () => transientError("http"));
		const retries: Array<{ attempt: number; reason: string; status?: number }> = [];
		const engine = new GraphEngine(flakyGraph("retry-429"), {
			projectRoot,
			jobId: "retry-429-job",
			createAgentSession: factory,
			retryBaseDelayMs: 5,
			sleep: async () => {},
			onRetry: async (retry) => {
				retries.push({ attempt: retry.attempt, reason: retry.reason, status: retry.status });
			},
		});

		const state = await engine.runUntilPause();

		assert.equal(state.status, "completed");
		assert.equal(attempts(), 2);
		assert.equal(state.budget.round, 1, "a retry is not a round");
		assert.equal(state.nodes.implement.runs, 1, "a retry is not a run");
		assert.equal(state.nodes.implement.transientRetries, 1);
		assert.deepEqual(retries, [{ attempt: 1, reason: "http", status: 429 }]);
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("an operator stop lands after the current backoff and leaves the node resumable", async () => {
	const projectRoot = await fixture();
	try {
		const slept: number[] = [];
		const { factory, attempts } = flakyFactory(1, () => transientError("transport"));
		let waits = 0;
		const engine = new GraphEngine(flakyGraph("stop-after-wait"), {
			projectRoot,
			jobId: "stop-after-wait-job",
			now: () => 1_000_000,
			createAgentSession: factory,
			retryBaseDelayMs: 100,
			sleep: async (ms) => {
				slept.push(ms);
				waits += 1;
			},
			// The marker appears while the first backoff is being waited.
			stopRequested: async () => waits > 0,
		});

		await assert.rejects(engine.runUntilPause(), OperatorStopError);
		assert.equal(attempts(), 1, "the stop landed before the second attempt");
		assert.deepEqual(slept, [100], "the current backoff was waited out");
		assert.equal(engine.state.status, "running", "the engine was not converted to a failure");
		assert.equal(engine.state.nodes.implement.status, "running", "the node is mid-run, not failed");
		assert.equal(engine.state.nodes.implement.transientRetries, 1);

		const checkpoint = await latestCheckpoint(projectRoot, "stop-after-wait-job");
		assert.equal(checkpoint.status, "running");
		assert.equal(checkpoint.nodes.implement.status, "running");
		assert.equal(checkpoint.nodes.implement.transientRetries, 1);
		assert.deepEqual(checkpoint.active, ["implement"]);
		assert.equal((await terminalEvents(projectRoot, "stop-after-wait-job")).length, 0, "the driver records STOPPED");
		engine.dispose();

		// `/kpi <job>` afterwards: the restore continues the same run and finishes.
		const secondSlept: number[] = [];
		const restored = await GraphEngine.restore(flakyGraph("stop-after-wait"), {
			projectRoot,
			jobId: "stop-after-wait-job",
			now: () => 1_000_000,
			createAgentSession: factory,
			retryBaseDelayMs: 100,
			sleep: async (ms) => {
				secondSlept.push(ms);
			},
			stopRequested: async () => false,
		});
		const finished = await restored.runUntilPause();
		assert.equal(finished.status, "completed");
		assert.equal(attempts(), 2, "the resume attempted once");
		assert.deepEqual(
			secondSlept,
			[100],
			"the interrupted wait is finished under the same deadline before the attempt",
		);
		assert.equal(finished.nodes.implement.runs, 1, "the same run, not a new one");
		restored.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("an aborted signal stops the engine at once and leaves the node resumable", async () => {
	// Abort during a prompt that never resolves on its own.
	const projectRoot = await fixture();
	try {
		let aborts = 0;
		let attempts = 0;
		const controller = new AbortController();
		const prompting = createGate();
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: "hanging",
				async prompt() {
					attempts += 1;
					prompting.open();
					if (attempts === 1) {
						const released = createGate();
						controller.signal.addEventListener("abort", () => released.open(), { once: true });
						await released.promise;
						throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
					}
				},
				abort() {
					aborts += 1;
				},
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		});
		const engine = new GraphEngine(flakyGraph("abort-prompt"), {
			projectRoot,
			jobId: "abort-prompt-job",
			createAgentSession: factory,
			signal: controller.signal,
		});

		const running = engine.runUntilPause();
		await prompting.promise;
		controller.abort();
		await assert.rejects(running, OperatorStopError);
		assert.equal(aborts, 1, "the in-flight session was told to abort");
		assert.equal(attempts, 1);
		assert.equal(engine.state.nodes.implement.status, "running");
		const checkpoint = await latestCheckpoint(projectRoot, "abort-prompt-job");
		assert.equal(checkpoint.status, "running");
		assert.equal(checkpoint.nodes.implement.status, "running");
		assert.equal(checkpoint.nodes.implement.runs, 1);
		const events = await allEvents(projectRoot, "abort-prompt-job");
		assert.equal(events.filter((event) => event.type === "node.finished").length, 0, "a stopped node did not finish");
		assert.equal(events.filter((event) => event.type === "loop.terminal").length, 0);
		engine.dispose();

		const restored = await GraphEngine.restore(flakyGraph("abort-prompt"), {
			projectRoot,
			jobId: "abort-prompt-job",
			createAgentSession: factory,
		});
		const finished = await restored.runUntilPause();
		assert.equal(finished.status, "completed");
		assert.equal(attempts, 2, "the restore ran the node again");
		assert.equal(finished.nodes.implement.runs, 1, "as the same run");
		restored.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}

	// Abort while the session is still being created: no prompt is ever issued.
	const creatingRoot = await fixture();
	try {
		const controller = new AbortController();
		let prompts = 0;
		const creating = createGate();
		const factory: GraphAgentSessionFactory = async (options) => {
			creating.open();
			const aborted = createGate();
			controller.signal.addEventListener("abort", () => aborted.open(), { once: true });
			await aborted.promise;
			return {
				session: {
					sessionId: "late",
					async prompt() {
						prompts += 1;
					},
					getActiveToolNames: () => [...(options.tools ?? [])],
					dispose() {},
				},
			};
		};
		const engine = new GraphEngine(flakyGraph("abort-creating"), {
			projectRoot: creatingRoot,
			jobId: "abort-creating-job",
			createAgentSession: factory,
			signal: controller.signal,
		});
		const running = engine.runUntilPause();
		await creating.promise;
		controller.abort();
		await assert.rejects(running, OperatorStopError);
		assert.equal(prompts, 0, "a session created after the stop is never prompted");
		const checkpoint = await latestCheckpoint(creatingRoot, "abort-creating-job");
		assert.equal(checkpoint.nodes.implement.status, "running");
		assert.equal(liveNodeSessions().length, 0, "the never-prompted session was released");
		engine.dispose();
	} finally {
		await rm(creatingRoot, { recursive: true, force: true });
	}

	// Abort between two response-validation attempts: the idle session has no
	// run to abort, so the next prompt is refused instead of issued.
	const betweenRoot = await fixture();
	try {
		const controller = new AbortController();
		let prompts = 0;
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: "between",
				async prompt() {
					prompts += 1;
				},
				getLastAssistantText: () => {
					controller.abort();
					return "not json";
				},
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		});
		const definition = graph(
			"abort-between",
			[
				{
					id: "plan",
					type: "agent",
					prompt: "plan",
					context: { mode: "isolated" },
					tools: ["read"],
					readOnly: true,
					response: { path: "plan.json", schema: "verdict.schema.json", retries: 2, state: {} },
				},
			],
			[{ from: "plan", to: "__end__" }],
		);
		const engine = new GraphEngine(definition, {
			projectRoot: betweenRoot,
			jobId: "abort-between-job",
			createAgentSession: factory,
			signal: controller.signal,
		});
		await assert.rejects(engine.runUntilPause(), OperatorStopError);
		assert.equal(prompts, 1, "no prompt was issued after the stop");
		assert.equal((await latestCheckpoint(betweenRoot, "abort-between-job")).nodes.plan.status, "running");
		engine.dispose();
	} finally {
		await rm(betweenRoot, { recursive: true, force: true });
	}

	// Abort during an injected backoff sleep that never returns.
	const sleepRoot = await fixture();
	try {
		const controller = new AbortController();
		const { factory, attempts } = flakyFactory(1, () => transientError("timeout"));
		const sleeping = createGate();
		const engine = new GraphEngine(flakyGraph("abort-sleep"), {
			projectRoot: sleepRoot,
			jobId: "abort-sleep-job",
			createAgentSession: factory,
			retryBaseDelayMs: 100,
			sleep: () => {
				sleeping.open();
				return new Promise<void>(() => {});
			},
			signal: controller.signal,
		});

		const running = engine.runUntilPause();
		await sleeping.promise;
		controller.abort();
		await assert.rejects(running, OperatorStopError);
		assert.equal(attempts(), 1);
		const checkpoint = await latestCheckpoint(sleepRoot, "abort-sleep-job");
		assert.equal(checkpoint.nodes.implement.status, "running");
		assert.equal(checkpoint.nodes.implement.transientRetries, 1);
		assert.equal(typeof checkpoint.nodes.implement.retryAtMs, "number", "the wait is still pending on disk");
		engine.dispose();

		// The resume finishes the remainder of that wait, then attempts again.
		const slept: number[] = [];
		const restored = await GraphEngine.restore(flakyGraph("abort-sleep"), {
			projectRoot: sleepRoot,
			jobId: "abort-sleep-job",
			createAgentSession: factory,
			now: () => (checkpoint.nodes.implement.retryAtMs as number) - 40,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		const finished = await restored.runUntilPause();
		assert.equal(finished.status, "completed");
		assert.deepEqual(slept, [40], "the remainder of the interrupted wait, not a fresh backoff");
		assert.equal(attempts(), 2);
		restored.dispose();
	} finally {
		await rm(sleepRoot, { recursive: true, force: true });
	}
});

test("an http 503 provider error is transient and a 401 is not", async () => {
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { status: 503 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { status: 500 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { status: 408 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { status: 401 })), undefined);
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { status: 403 })), undefined);

	// A provider refusal recorded on the assistant message, not thrown by prompt().
	const projectRoot = await fixture();
	try {
		let prompts = 0;
		const answers = ['503 {"type":"error","error":{"type":"overloaded_error"}}', undefined];
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: "provider",
				async prompt() {
					prompts += 1;
				},
				getLastAssistantError: () => answers[prompts - 1],
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		});
		const retries: Array<{ reason: string; status?: number }> = [];
		const engine = new GraphEngine(flakyGraph("provider-503"), {
			projectRoot,
			jobId: "provider-503-job",
			createAgentSession: factory,
			sleep: async () => {},
			retryBaseDelayMs: 1,
			onRetry: async (retry) => {
				retries.push({ reason: retry.reason, status: retry.status });
			},
		});
		const state = await engine.runUntilPause();
		assert.equal(state.status, "completed");
		assert.equal(prompts, 2, "the 503 was retried");
		assert.deepEqual(retries, [{ reason: "http", status: 503 }]);
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}

	// A 401 reaches the caller untouched: the driver's provider path decides.
	const refusedRoot = await fixture();
	try {
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: "refused",
				async prompt() {},
				getLastAssistantError: () => '401 {"type":"error","error":{"message":"invalid api key"}}',
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		});
		const slept: number[] = [];
		const engine = new GraphEngine(flakyGraph("provider-401"), {
			projectRoot: refusedRoot,
			jobId: "provider-401-job",
			createAgentSession: factory,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		await assert.rejects(engine.runSuperstep(), (error: unknown) => {
			assert.ok(error instanceof GraphNodeProviderError);
			assert.equal(error.status, 401);
			assert.match(error.message, /invalid api key/u);
			return true;
		});
		assert.deepEqual(slept, [], "never retried");
		assert.equal(engine.state.status, "running", "not converted into a contract pause");
		assert.equal(engine.state.pause, undefined);
		assert.equal(engine.state.nodes.implement.status, "failed");
		assert.match(engine.state.nodes.implement.error ?? "", /invalid api key/u);
		const checkpoint = await latestCheckpoint(refusedRoot, "provider-401-job");
		assert.equal(checkpoint.nodes.implement.status, "failed", "the refusal is on disk for the resume");
		assert.equal(
			(await terminalEvents(refusedRoot, "provider-401-job")).length,
			0,
			"the driver records the terminal",
		);
		engine.dispose();
	} finally {
		await rm(refusedRoot, { recursive: true, force: true });
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
		{ name: "http 401", error: () => Object.assign(new Error("Unauthorized"), { status: 401 }) },
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

			const state = await engine.runSuperstep();
			assert.equal(attempts(), 1, `${scenario.name}: no retry`);
			assert.deepEqual(slept, [], `${scenario.name}: no backoff`);
			assert.equal(state.status, "paused", `${scenario.name}: a defect parks the run for the operator`);
			assert.equal(state.pause?.recovery, "contract", scenario.name);
			assert.equal(
				state.pause?.reason,
				(scenario.error() as Error).message,
				`${scenario.name}: the reason is the error`,
			);
			assert.equal(state.nodes.implement.status, "failed", scenario.name);
			assert.equal(state.nodes.implement.transientRetries, 0, "no retry was spent");
			assert.equal((await terminalEvents(projectRoot, "no-retry-job")).length, 1, `${scenario.name}: one terminal`);
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

		const state = await engine.runSuperstep();
		assert.deepEqual(slept, [], "a contract defect is never retried");
		assert.equal(state.status, "paused");
		assert.equal(state.pause?.recovery, "contract");
		assert.match(state.pause?.reason ?? "", /registered forbidden tool write/u);
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

		const state = await engine.runSuperstep();
		assert.equal(state.status, "paused");
		assert.equal(state.pause?.recovery, "contract");
		assert.equal(state.pause?.reason, "prompt refused: bad input");
		const events = await allEvents(projectRoot, "lifecycle-fail-job");
		const finished = events.find((event) => event.type === "node.finished");
		assert.ok(finished);
		assert.equal(finished?.status, "failed");
		assert.match(String(finished?.error), /prompt refused: bad input/u);
		assert.equal("cost_usd" in (finished as object), false);
		const terminals = events.filter((event) => event.type === "loop.terminal");
		assert.equal(terminals.length, 1, "the pause is the run's one terminal event");
		assert.equal(terminals[0]?.status, "NEEDS_HUMAN");
		assert.equal(terminals[0]?.recovery, "contract");
		assert.ok(events.indexOf(finished!) < events.indexOf(terminals[0]!), "node.finished precedes the pause");
		const schema = await eventSchema();
		assert.deepEqual(validateJsonSchema(finished, schema), []);
		assert.deepEqual(validateJsonSchema(terminals[0], schema), []);
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
