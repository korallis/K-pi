import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
	OperatorStopError,
	validateGraphDefinition,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type {
	AgentGraphNode,
	GraphDefinition,
	GraphMutation,
	GraphNode,
	GraphRunState,
} from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";

const policy = {
	allowNonInteractive: false,
	allowNonInteractiveMutations: false,
	confirmProjectGraph: true,
	confirmMutatingNodes: true,
};
function agent(id: string, role: AgentGraphNode["role"] = "builder"): AgentGraphNode {
	return { id, type: "agent", role, prompt: id, context: { mode: "isolated" }, tools: ["read"], readOnly: true };
}
function graph(nodes: GraphNode[], edges: GraphDefinition["edges"]): GraphDefinition {
	return { schemaVersion: 2, id: "dynamic", entry: nodes[0].id, nodes, edges, limits: { maxConcurrency: 2 }, policy };
}
async function fixture(run: (projectRoot: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "kpi-mutation-"));
	try {
		await mkdir(join(root, ".kpi", "runs", "job"), { recursive: true });
		await writeFile(join(root, ".kpi", "runs", "job", "diagnostic.json"), '{"observed":"failure"}\n');
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
function mutation(operations: GraphMutation["operations"], tasks: string[], goals: string[] = []): GraphMutation {
	return {
		expectedRevision: 0,
		reason: "Replace the failing strategy using the recorded diagnostic",
		evidenceRefs: ["diagnostic.json"],
		affectedGoalIds: goals,
		affectedAssumptionIds: [],
		affectedTaskIds: tasks,
		operations,
	};
}

test("graph mutations bind goals, reject orphan/cycle/unknown/duplicate references, and enforce revision CAS", async () =>
	fixture(async (projectRoot) => {
		const work = { ...agent("work"), goalIds: ["goal-1"] };
		const definition = {
			...graph([agent("plan", "planner"), work], [{ from: "plan", to: "work" }]),
			intentHash: "intent-1",
			requiredGoalIds: ["goal-1"],
			repairNodeId: "plan",
		};
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job" });
		await assert.rejects(
			engine.applyMutation(
				mutation([{ type: "replace", taskId: "work", tasks: [agent("new")] }], ["work", "new"], ["goal-1"]),
				"plan",
			),
			/orphan required goal/,
		);
		await assert.rejects(
			engine.applyMutation(
				mutation([{ type: "dependencies", taskId: "work", dependencies: ["work"] }], ["work"], ["goal-1"]),
				"plan",
			),
			/dependency cycle/,
		);
		await assert.rejects(
			engine.applyMutation(
				mutation([{ type: "dependencies", taskId: "work", dependencies: ["missing"] }], ["work"], ["goal-1"]),
				"plan",
			),
			/unknown dependency/,
		);
		await assert.rejects(
			engine.applyMutation(
				mutation([{ type: "create", task: work, template: "work" }], ["work"], ["goal-1"]),
				"plan",
			),
			/duplicate graph node/,
		);
		await assert.rejects(
			engine.applyMutation(
				mutation(
					[{ type: "create", task: { ...agent("unreachable"), required: true }, template: "work" }],
					["unreachable"],
				),
				"plan",
			),
			/required unreachable/,
		);
		const request = mutation(
			[{ type: "replace", taskId: "work", tasks: [{ ...agent("new"), goalIds: ["goal-1"] }] }],
			["work", "new"],
			["goal-1"],
		);
		const revision = await engine.applyMutation(request, "plan");
		assert.equal(revision.revision, 1);
		assert.equal(revision.actorId, "job/plan");
		await assert.rejects(engine.applyMutation(request, "plan"), /revision conflict/);
		const changedNamedGraph = graph([{ id: "unrelated", type: "set", assignments: {} }], []);
		const restored = await GraphEngine.restore(changedNamedGraph, { projectRoot, jobId: "job" });
		assert.deepEqual(
			restored.definition.nodes.map((node) => node.id),
			["plan", "new"],
		);
		assert.deepEqual(restored.state.revisions?.[0].mutation.evidenceRefs, ["diagnostic.json"]);
		assert.deepEqual(restored.state.superseded?.work, ["new"]);
		engine.dispose();
		restored.dispose();
	}));

test("planner tools execute real mutations and builder/reviewer sessions cannot obtain that capability", async () =>
	fixture(async (projectRoot) => {
		const definition = graph(
			[agent("plan", "planner"), agent("work"), agent("review", "reviewer")],
			[
				{ from: "plan", to: "work" },
				{ from: "work", to: "review" },
			],
		);
		const observed: string[] = [];
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: options.sessionManager!.getSessionId(),
				getActiveToolNames: () => options.tools ?? [],
				dispose() {},
				async prompt(text) {
					const role = text.split("\n")[0];
					observed.push(role);
					const tool = options.customTools?.find((candidate) => candidate.name === "graph_mutate");
					if (role !== "plan") {
						assert.equal(tool, undefined);
						assert.equal(options.tools?.includes("graph_mutate"), false);
						return;
					}
					assert.ok(tool);
					assert.ok(options.tools?.includes("graph_mutate"));
					await tool.execute(
						"mutation",
						mutation(
							[{ type: "replace", taskId: "work", tasks: [agent("replacement")] }],
							["work", "replacement"],
						),
						undefined,
						undefined,
						{} as never,
					);
				},
			},
		});
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job", createAgentSession: factory });
		await engine.runUntilPause();
		assert.deepEqual(observed, ["plan", "replacement", "review"]);
		assert.equal(engine.state.revision, 1);
		await assert.rejects(engine.applyMutation(mutation([], []), "replacement"), /planning or diagnostic role/);
		engine.dispose();
	}));

test("mutations cannot widen tools, replace a verifier, or route around a safety node", async () =>
	fixture(async (projectRoot) => {
		const definition = graph(
			[agent("plan", "planner"), agent("work"), { id: "verify", type: "verify" }, agent("ship", "release")],
			[
				{ from: "plan", to: "work" },
				{ from: "work", to: "verify" },
				{ from: "verify", to: "ship" },
			],
		);
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job" });
		await assert.rejects(
			engine.applyMutation(
				mutation(
					[
						{
							type: "replace",
							taskId: "work",
							tasks: [{ ...agent("unsafe"), tools: ["read", "write"], readOnly: false }],
						},
					],
					["work", "unsafe"],
				),
				"plan",
			),
			/capabilities/,
		);
		await assert.rejects(
			engine.applyMutation(
				mutation([{ type: "replace", taskId: "verify", tasks: [agent("fake")] }], ["verify", "fake"]),
				"plan",
			),
			/safety node/,
		);
		await assert.rejects(
			engine.applyMutation(
				mutation([{ type: "route", from: "work", edges: [{ from: "work", to: "ship" }] }], ["work"]),
				"plan",
			),
			/safety bypass/,
		);
		const shared = graph(
			[
				{ ...agent("planner", "planner"), context: { mode: "thread", threadKey: "shared" } },
				{ ...agent("builder"), context: { mode: "thread", threadKey: "shared" } },
			],
			[],
		);
		assert.throws(() => validateGraphDefinition(shared), /independent role capabilities/);
		engine.dispose();
	}));

test("local failures preserve successful sibling descendants and replay only unresolved tasks", async () =>
	fixture(async (projectRoot) => {
		const root: GraphNode = { id: "root", type: "set", assignments: {} };
		const definition = graph(
			[root, agent("left"), agent("right"), agent("descendant")],
			[
				{ from: "root", to: "left" },
				{ from: "root", to: "right" },
				{ from: "left", to: "descendant" },
			],
		);
		let fail = true;
		const calls: string[] = [];
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: options.sessionManager!.getSessionId(),
				getActiveToolNames: () => options.tools ?? [],
				dispose() {},
				async prompt(text) {
					const id = text.split("\n")[0];
					calls.push(id);
					if (id === "right" && fail) throw new Error("engineering failure");
				},
			},
		});
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job", createAgentSession: factory });
		await engine.runUntilPause();
		assert.equal(engine.state.status, "paused");
		assert.equal(calls.filter((id) => id === "descendant").length, 1);
		fail = false;
		const restored = await GraphEngine.restore(definition, {
			projectRoot,
			jobId: "job",
			createAgentSession: factory,
		});
		await restored.runUntilPause();
		assert.equal(restored.state.status, "completed");
		assert.equal(calls.filter((id) => id === "left").length, 1);
		assert.equal(calls.filter((id) => id === "right").length, 2);
		assert.equal(calls.filter((id) => id === "descendant").length, 1);
		engine.dispose();
		restored.dispose();
	}));

test("interrupted replay routes committed sibling descendants before losing any work", async () =>
	fixture(async (projectRoot) => {
		const definition = graph(
			[{ id: "root", type: "set", assignments: {} }, agent("left"), agent("right"), agent("child")],
			[
				{ from: "root", to: "left" },
				{ from: "root", to: "right" },
				{ from: "left", to: "child" },
			],
		);
		let stopped = false;
		const calls: string[] = [];
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: options.sessionManager!.getSessionId(),
				getActiveToolNames: () => options.tools ?? [],
				dispose() {},
				async prompt(text) {
					const id = text.split("\n")[0];
					calls.push(id);
					if (id === "right" && !stopped) {
						stopped = true;
						throw new OperatorStopError();
					}
				},
			},
		});
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job", createAgentSession: factory });
		await assert.rejects(engine.runUntilPause(), OperatorStopError);
		const restored = await GraphEngine.restore(definition, {
			projectRoot,
			jobId: "job",
			createAgentSession: factory,
		});
		await restored.runUntilPause();
		assert.equal(restored.state.status, "completed");
		assert.equal(calls.filter((id) => id === "left").length, 1);
		assert.equal(calls.filter((id) => id === "child").length, 1);
		engine.dispose();
		restored.dispose();
	}));

test("unequal depth dependency joins wait for all prerequisites and run once", async () =>
	fixture(async (projectRoot) => {
		const set = (id: string, dependencies?: string[]): GraphNode => ({
			id,
			type: "set",
			assignments: { [id]: true },
			dependencies,
		});
		const definition = graph(
			[set("root"), set("a"), set("b"), set("c"), set("join", ["a", "c"])],
			[
				{ from: "root", to: "a" },
				{ from: "root", to: "b" },
				{ from: "a", to: "join" },
				{ from: "b", to: "c" },
				{ from: "c", to: "join" },
			],
		);
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job" });
		await engine.runSuperstep();
		await engine.runSuperstep();
		assert.equal(engine.state.nodes.join.runs, 0);
		await engine.runUntilPause();
		assert.equal(engine.state.nodes.join.runs, 1);
		assert.equal(engine.state.values.c, true);
		engine.dispose();
	}));

test("empty execution with unverified protected goals schedules repair, never completion", async () =>
	fixture(async (projectRoot) => {
		const definition = {
			...graph(
				[agent("plan", "planner"), { id: "work", type: "set" as const, assignments: {}, goalIds: ["goal"] }],
				[{ from: "plan", to: "work" }],
			),
			intentHash: "protected",
			requiredGoalIds: ["goal"],
			repairNodeId: "plan",
		};
		const seed = new GraphEngine(definition, { projectRoot, jobId: "job" });
		const initial: GraphRunState = structuredClone(seed.state);
		initial.active = ["work"];
		const engine = new GraphEngine(
			definition,
			{ projectRoot, jobId: "job", resolveVerifiedGoalIds: async () => [] },
			initial,
		);
		await engine.runSuperstep();
		assert.equal(engine.state.status, "running");
		assert.deepEqual(engine.state.active, ["plan"]);
		const repair = JSON.parse(
			await readFile(join(projectRoot, ".kpi", "runs", "job", "execution-repair.json"), "utf8"),
		);
		assert.deepEqual(repair.goalIds, ["goal"]);
		seed.dispose();
		engine.dispose();
	}));

test("split tasks join before verification and dependency edits remain a separate DAG from control retries", async () =>
	fixture(async (projectRoot) => {
		const definition = graph(
			[agent("plan", "planner"), agent("work"), { id: "verify", type: "verify" }],
			[
				{ from: "plan", to: "work" },
				{ from: "work", to: "verify" },
			],
		);
		let engine: GraphEngine;
		const calls: string[] = [];
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: options.sessionManager!.getSessionId(),
				getActiveToolNames: () => options.tools ?? [],
				dispose() {},
				async prompt(text) {
					calls.push(text.split("\n")[0]);
				},
			},
		});
		engine = new GraphEngine(definition, {
			projectRoot,
			jobId: "job",
			createAgentSession: factory,
			executeVerification: async () => {
				assert.equal(engine.state.nodes.one.status, "completed");
				assert.equal(engine.state.nodes.two.status, "completed");
				calls.push("verify");
				return {};
			},
		});
		await engine.applyMutation(
			mutation(
				[{ type: "split", taskId: "work", tasks: [agent("one"), { ...agent("two"), dependencies: ["one"] }] }],
				["work", "one", "two", "verify"],
			),
			"plan",
		);
		await engine.runUntilPause();
		assert.deepEqual(calls, ["plan", "one", "two", "verify"]);
		assert.equal(engine.state.nodes.verify.runs, 1);
		engine.dispose();
	}));

test("creation and supersession preserve runnable topology and the superseded task record", async () =>
	fixture(async (projectRoot) => {
		const definition = graph([agent("plan", "planner"), agent("work")], [{ from: "plan", to: "work" }]);
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job" });
		await engine.applyMutation(
			mutation(
				[
					{ type: "create", template: "work", task: { ...agent("alternative"), required: true } },
					{
						type: "route",
						from: "plan",
						edges: [
							{ from: "plan", to: "work" },
							{ from: "plan", to: "alternative" },
						],
					},
				],
				["plan", "alternative"],
			),
			"plan",
		);
		const supersede = mutation(
			[{ type: "supersede", taskId: "work", replacementIds: ["alternative"] }],
			["work", "alternative"],
		);
		supersede.expectedRevision = 1;
		await engine.applyMutation(supersede, "plan");
		const dependencies = mutation(
			[{ type: "dependencies", taskId: "alternative", dependencies: ["plan"] }],
			["alternative"],
		);
		dependencies.expectedRevision = 2;
		await engine.applyMutation(dependencies, "plan");
		assert.deepEqual(
			engine.definition.nodes.map((node) => node.id),
			["plan", "alternative"],
		);
		assert.deepEqual(engine.state.superseded?.work, ["alternative"]);
		assert.equal(engine.state.nodes.work.runs, 0);
		assert.equal(engine.state.revision, 3);
		engine.dispose();
	}));

test("topology blockers park only their dependent branch while sibling descendants drain", async () =>
	fixture(async (projectRoot) => {
		const definition = graph(
			[
				{ id: "root", type: "set", assignments: {} },
				{ id: "blocked", type: "set", assignments: {} },
				{ id: "free", type: "set", assignments: {} },
				{ id: "child", type: "set", assignments: { independentWork: true }, dependencies: ["free"] },
				{
					id: "approval-needed",
					type: "pause",
					recovery: "contract",
					reason: "external dependency is unavailable",
					resume: ["blocked"],
				},
			],
			[
				{ from: "root", to: "blocked" },
				{ from: "root", to: "free" },
				{ from: "blocked", to: "approval-needed" },
				{ from: "free", to: "child" },
			],
		);
		const engine = new GraphEngine(definition, { projectRoot, jobId: "job" });
		await engine.runUntilPause();
		assert.equal(engine.state.values.independentWork, true);
		assert.equal(engine.state.status, "paused");
		assert.deepEqual(engine.state.pause?.resume, ["blocked"]);
		engine.dispose();
	}));

test("completed checkpoint with stale required goal receipts restores into repair", async () =>
	fixture(async (projectRoot) => {
		const definition = {
			...graph(
				[agent("plan", "planner"), { id: "work", type: "set" as const, assignments: {}, goalIds: ["goal"] }],
				[{ from: "plan", to: "work" }],
			),
			intentHash: "protected",
			requiredGoalIds: ["goal"],
			repairNodeId: "plan",
		};
		const seed = new GraphEngine(definition, { projectRoot, jobId: "job" });
		const initial: GraphRunState = structuredClone(seed.state);
		initial.active = ["work"];
		const engine = new GraphEngine(
			definition,
			{ projectRoot, jobId: "job", resolveVerifiedGoalIds: async () => ["goal"] },
			initial,
		);
		await engine.runSuperstep();
		assert.equal(engine.state.status, "completed");
		const restored = await GraphEngine.restore(definition, {
			projectRoot,
			jobId: "job",
			resolveVerifiedGoalIds: async () => [],
		});
		assert.equal(restored.state.status, "running");
		assert.deepEqual(restored.state.active, ["plan"]);
		seed.dispose();
		engine.dispose();
		restored.dispose();
	}));
