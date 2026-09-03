import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	GraphEngine,
	loadNamedGraph,
	validateGraphDefinition,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type {
	GraphDefinition,
	GraphEdge,
	JsonObject,
} from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";

const projectRoot = new URL("..", import.meta.url).pathname;

async function graph(name: string): Promise<GraphDefinition> {
	return loadNamedGraph(projectRoot, name);
}

/** Every state path an edge in this graph reads. */
function conditionPaths(definition: GraphDefinition): Set<string> {
	const paths = new Set<string>();
	for (const edge of definition.edges) {
		for (const condition of edge.when === undefined ? [] : Array.isArray(edge.when) ? edge.when : [edge.when]) {
			paths.add(condition.path);
		}
	}
	return paths;
}

function setPath(values: JsonObject, path: string, value: unknown): void {
	const parts = path.split(".");
	let current = values;
	for (const part of parts.slice(0, -1)) {
		if (typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) {
			current[part] = {};
		}
		current = current[part] as JsonObject;
	}
	current[parts.at(-1) as string] = value as never;
}

/**
 * Resolves the edges a node takes for a given state, mirroring the engine: a
 * list of conditions is a conjunction, and a pause target parks the run.
 */
function fired(definition: GraphDefinition, from: string, values: JsonObject): string[] {
	const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
	const targets: string[] = [];
	for (const edge of definition.edges.filter((candidate: GraphEdge) => candidate.from === from)) {
		const conditions = edge.when === undefined ? [] : Array.isArray(edge.when) ? edge.when : [edge.when];
		const matches = conditions.every((condition) => {
			const parts = condition.path.split(".");
			let current: unknown = values;
			for (const part of parts) {
				if (typeof current !== "object" || current === null) return false;
				current = (current as Record<string, unknown>)[part];
			}
			return current === condition.equals;
		});
		if (matches) {
			targets.push(nodes.get(edge.to)?.type === "pause" ? `${edge.to}!` : edge.to);
		}
	}
	return targets;
}

function state(facts: Record<string, unknown>): JsonObject {
	const values: JsonObject = { policy: { onHumanDeny: "revise" } };
	for (const [path, value] of Object.entries(facts)) {
		setPath(values, path, value);
	}
	return values;
}

interface RoutingCase {
	name: string;
	from: string;
	facts: Record<string, unknown>;
	expect: string[];
}

const gatedCases: RoutingCase[] = [
	{
		name: "no frozen plan specifies first",
		from: "ac-compiler",
		facts: { "plan.provided": false },
		expect: ["specify"],
	},
	{
		name: "a frozen plan skips specify and checks the plan",
		from: "ac-compiler",
		facts: { "plan.provided": true },
		expect: ["plan-check"],
	},
	{
		name: "a written plan waits for the operator before anything is implemented",
		from: "plan",
		facts: {},
		expect: ["plan-approval"],
	},
	{
		name: "an approved plan implements",
		from: "plan-approval",
		facts: { "plan.approved": true },
		expect: ["implement"],
	},
	{
		name: "a change request re-plans",
		from: "plan-approval",
		facts: { "plan.approved": false },
		expect: ["plan"],
	},
	{
		name: "an operator-authored plan that checks out implements without a second approval",
		from: "plan-check",
		facts: {},
		expect: ["implement"],
	},
	{
		name: "red tests with fresh evidence go back to implement",
		from: "test",
		facts: { "bounds.held": true, "test.passed": false, "progress.repeated": false },
		expect: ["implement"],
	},
	{
		name: "red tests over repeated evidence re-plan while a re-plan is still allowed",
		from: "test",
		facts: {
			"bounds.held": true,
			"test.passed": false,
			"progress.repeated": true,
			"plan.repair_tried": false,
			"plan.provided": false,
		},
		expect: ["plan"],
	},
	{
		name: "red tests over repeated evidence after the re-plans pause for the operator",
		from: "test",
		facts: { "bounds.held": true, "test.passed": false, "progress.repeated": true, "plan.repair_tried": true },
		expect: ["no-progress!"],
	},
	{
		name: "red tests over repeated evidence never re-plan an operator-provided plan",
		from: "test",
		facts: {
			"bounds.held": true,
			"test.passed": false,
			"progress.repeated": true,
			"plan.repair_tried": false,
			"plan.provided": true,
		},
		expect: ["no-progress!"],
	},
	{
		name: "green tests inside bounds reach review",
		from: "test",
		facts: { "bounds.held": true, "test.passed": true },
		expect: ["review"],
	},
	{
		name: "a write outside bounds pauses for the operator, whatever the tests said",
		from: "test",
		facts: { "bounds.held": false, "test.passed": true },
		expect: ["unsafe!"],
	},
	{
		name: "an approved review over green, fresh receipts asks the human",
		from: "review",
		facts: { "bounds.held": true, "review.approved": true, "test.passed": true, "fingerprints.fresh": true },
		expect: ["human"],
	},
	{
		name: "an approved review over red receipts never reaches the human",
		from: "review",
		facts: { "bounds.held": true, "review.approved": true, "test.passed": false, "fingerprints.fresh": true },
		expect: ["needs-human!"],
	},
	{
		name: "an approved review over stale receipts never reaches the human",
		from: "review",
		facts: { "bounds.held": true, "review.approved": true, "test.passed": true, "fingerprints.fresh": false },
		expect: ["needs-human!"],
	},
	{
		name: "a testable red review with fresh output revises",
		from: "review",
		facts: { "bounds.held": true, "review.approved": false, "review.status": "REVISE", "progress.repeated": false },
		expect: ["implement"],
	},
	{
		name: "a testable red review that repeats a witness re-plans while a re-plan is still allowed",
		from: "review",
		facts: {
			"bounds.held": true,
			"review.approved": false,
			"review.status": "REVISE",
			"progress.repeated": true,
			"plan.repair_tried": false,
			"plan.provided": false,
		},
		expect: ["plan"],
	},
	{
		name: "a repeated witness after the automatic re-plans pauses for the operator",
		from: "review",
		facts: {
			"bounds.held": true,
			"review.approved": false,
			"review.status": "REVISE",
			"progress.repeated": true,
			"plan.repair_tried": true,
		},
		expect: ["no-progress!"],
	},
	{
		name: "a repeated witness never re-plans an operator-provided plan",
		from: "review",
		facts: {
			"bounds.held": true,
			"review.approved": false,
			"review.status": "REVISE",
			"progress.repeated": true,
			"plan.repair_tried": false,
			"plan.provided": true,
		},
		expect: ["no-progress!"],
	},
	{
		name: "an untestable red review needs a human",
		from: "review",
		facts: { "bounds.held": true, "review.approved": false, "review.status": "BLOCKED" },
		expect: ["needs-human!"],
	},
	{
		name: "bounds broken by the time review ran still pause for the operator",
		from: "review",
		facts: { "bounds.held": false, "review.approved": true, "test.passed": true, "fingerprints.fresh": true },
		expect: ["unsafe!"],
	},
	{
		name: "human approval ships when the job has not shipped",
		from: "human",
		facts: { "release.approved": true, "ship.shipped": false },
		expect: ["ship"],
	},
	{
		name: "human approval on an already shipped job ends without a second commit",
		from: "human",
		facts: { "release.approved": true, "ship.shipped": true },
		expect: ["__end__"],
	},
	{
		name: "a denied release revises when the graph is configured to retry",
		from: "human",
		facts: { "release.approved": false, "policy.onHumanDeny": "revise" },
		expect: ["implement"],
	},
	{
		name: "a denied release ends when the graph is configured to end",
		from: "human",
		facts: { "release.approved": false, "policy.onHumanDeny": "end" },
		expect: ["__end__"],
	},
];

const autoCases: RoutingCase[] = [
	{
		name: "red tests with fresh evidence go back to implement",
		from: "test",
		facts: { "bounds.held": true, "test.passed": false, "progress.repeated": false },
		expect: ["implement"],
	},
	{
		name: "red tests over repeated evidence re-plan, then pause",
		from: "test",
		facts: {
			"bounds.held": true,
			"test.passed": false,
			"progress.repeated": true,
			"plan.repair_tried": true,
		},
		expect: ["no-progress!"],
	},
	{
		name: "a write outside bounds pauses for the operator",
		from: "test",
		facts: { "bounds.held": false, "test.passed": true },
		expect: ["unsafe!"],
	},
	{
		name: "release needs an approved review, green tests, held bounds and fresh receipts",
		from: "review",
		facts: {
			"bounds.held": true,
			"review.approved": true,
			"test.passed": true,
			"fingerprints.fresh": true,
		},
		expect: ["release.set"],
	},
	{
		name: "stale receipts never release, even with an approved review",
		from: "review",
		facts: {
			"bounds.held": true,
			"review.approved": true,
			"test.passed": true,
			"fingerprints.fresh": false,
		},
		expect: ["needs-human!"],
	},
	{
		name: "an approved review over red tests never releases",
		from: "review",
		facts: {
			"bounds.held": true,
			"review.approved": true,
			"test.passed": false,
			"fingerprints.fresh": true,
		},
		expect: ["needs-human!"],
	},
	{
		name: "a testable red review with fresh output revises",
		from: "review",
		facts: { "bounds.held": true, "review.approved": false, "review.status": "REVISE", "progress.repeated": false },
		expect: ["implement"],
	},
	{
		name: "a testable red review that repeats a witness re-plans while a re-plan is still allowed",
		from: "review",
		facts: {
			"bounds.held": true,
			"review.approved": false,
			"review.status": "REVISE",
			"progress.repeated": true,
			"plan.repair_tried": false,
			"plan.provided": false,
		},
		expect: ["plan"],
	},
	{
		name: "an untestable red review needs a human",
		from: "review",
		facts: { "bounds.held": true, "review.approved": false, "review.status": "BLOCKED" },
		expect: ["needs-human!"],
	},
	{
		name: "release ships once",
		from: "release.set",
		facts: { "ship.shipped": false },
		expect: ["ship"],
	},
	{
		name: "a replayed release makes no second commit",
		from: "release.set",
		facts: { "ship.shipped": true },
		expect: ["__end__"],
	},
];

test("the gated graph routes every conditional branch as data", async () => {
	const definition = await graph("coding-loop.gated");
	for (const scenario of gatedCases) {
		assert.deepEqual(fired(definition, scenario.from, state(scenario.facts)), scenario.expect, scenario.name);
	}
});

test("the autopilot graph routes every conditional branch as data", async () => {
	const definition = await graph("coding-loop.auto");
	for (const scenario of autoCases) {
		assert.deepEqual(fired(definition, scenario.from, state(scenario.facts)), scenario.expect, scenario.name);
	}
});

test("no shipped graph manufactures green test, bounds or freshness state", async () => {
	for (const name of ["coding-loop.gated", "coding-loop.auto", "spec-first"]) {
		const definition = await graph(name);
		for (const node of definition.nodes) {
			if (node.type !== "set") {
				continue;
			}
			for (const path of Object.keys(node.assignments)) {
				assert.doesNotMatch(
					path,
					/^(?:test|bounds|fingerprints|evidence)\./u,
					`${name}: set node ${node.id} may not manufacture ${path}`,
				);
			}
		}
	}
});

test("release is reachable only from evidence, and only in one place", async () => {
	const definition = await graph("coding-loop.auto");
	const releaseNodes = definition.nodes.filter(
		(node) => node.type === "set" && Object.keys(node.assignments).includes("release.approved"),
	);
	assert.equal(releaseNodes.length, 1, "exactly one node decides release");

	const inbound = definition.edges.filter((edge) => edge.to === releaseNodes[0].id);
	assert.equal(inbound.length, 1, "one way in");
	const conditions = Array.isArray(inbound[0].when) ? inbound[0].when : [inbound[0].when];
	assert.deepEqual(
		conditions.map((condition) => `${condition?.path}=${String(condition?.equals)}`).sort(),
		["bounds.held=true", "fingerprints.fresh=true", "review.approved=true", "test.passed=true"],
		"release requires an approved review, green receipts, held bounds and freshness",
	);
});

test("an autopilot graph cannot contain a human node", async () => {
	const definition = await graph("coding-loop.auto");
	assert.equal(definition.policy.allowNonInteractive, true);
	assert.equal(
		definition.nodes.some((node) => node.type === "human"),
		false,
		"the shipped autopilot graph has no human node",
	);

	// And the rule is executable, not just a property of today's file.
	assert.throws(
		() =>
			validateGraphDefinition({
				...definition,
				nodes: [
					...definition.nodes,
					{ id: "sneaky", type: "human", title: "t", question: "q", statePath: "release.approved" },
				],
			}),
		/non-interactive graph .* cannot contain human node sneaky/u,
	);
});

test("a terminal node is a sink and cannot be scheduled past", async () => {
	const definition = await graph("coding-loop.gated");
	const pauses = definition.nodes.filter((candidate) => candidate.type === "pause");
	assert.ok(pauses.length > 0, "the gated graph parks somewhere");
	for (const node of pauses) {
		assert.equal(
			definition.edges.some((edge) => edge.from === node.id),
			false,
			`${node.id} has no outgoing edge`,
		);
	}

	assert.throws(
		() =>
			validateGraphDefinition({
				...definition,
				edges: [...definition.edges, { from: "unsafe", to: "implement" }],
			}),
		/pause node unsafe cannot have outgoing edges/u,
	);
});

test("every fact a shipped graph routes on is one the loop supplies", async () => {
	// The loop's fact source is the only writer of these paths; a graph that read
	// anything else would route on state nobody produces.
	const supplied = new Set([
		"plan.provided",
		"test.passed",
		"bounds.held",
		"fingerprints.fresh",
		"ship.shipped",
		"policy.onHumanDeny",
		"plan.approved",
		"release.approved",
		"review.approved",
		"review.status",
		"progress.repeated",
		"plan.repair_tried",
	]);
	for (const name of ["coding-loop.gated", "coding-loop.auto"]) {
		for (const path of conditionPaths(await graph(name))) {
			assert.ok(supplied.has(path), `${name} routes on ${path}, which nothing supplies`);
		}
	}
});

test("a routed pause parks the run with one terminal event and a durable record", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-pause-"));
	try {
		const definition: GraphDefinition = {
			schemaVersion: 2,
			id: "pause-route",
			entry: "work",
			nodes: [
				{
					id: "work",
					type: "agent",
					prompt: "work",
					context: { mode: "isolated" },
					tools: ["read"],
					readOnly: true,
				},
				{ id: "next", type: "set", assignments: { reached: true } },
				{ id: "stop", type: "pause", recovery: "bounds", reason: "bounds left the task", resume: ["work"] },
			],
			edges: [
				{ from: "work", to: "stop", when: { path: "bounds.held", equals: false } },
				{ from: "work", to: "next", when: { path: "bounds.held", equals: true } },
				{ from: "next", to: "__end__" },
			],
			limits: { maxConcurrency: 1 },
			policy: {
				allowNonInteractive: true,
				allowNonInteractiveMutations: false,
				confirmProjectGraph: false,
				confirmMutatingNodes: false,
			},
		};

		const terminals: unknown[] = [];
		const engine = new GraphEngine(definition, {
			projectRoot: directory,
			jobId: "pause-job",
			createAgentSession: async () => ({
				session: {
					sessionId: "s",
					async prompt() {},
					getActiveToolNames: () => ["read"],
					dispose() {},
				},
			}),
			resolveFacts: async () => ({ "bounds.held": false }),
			emitTerminal: async (pause) => {
				terminals.push(pause);
			},
		});

		const stopped = await engine.runUntilPause();
		engine.dispose();

		assert.equal(stopped.status, "paused");
		assert.equal(stopped.pause?.recovery, "bounds");
		assert.equal(stopped.pause?.reason, "bounds left the task");
		assert.deepEqual(stopped.pause?.resume, ["work"]);
		assert.equal(terminals.length, 1, "exactly one terminal event");
		assert.deepEqual(terminals[0], stopped.pause);
		assert.equal(stopped.nodes.next.runs, 0, "the run never scheduled past its own park");
		assert.equal(stopped.values.reached, undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a node whose branches all miss fails instead of reporting success", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-routing-gap-"));
	try {
		const definition: GraphDefinition = {
			schemaVersion: 2,
			id: "routing-gap",
			entry: "work",
			nodes: [
				{
					id: "work",
					type: "agent",
					prompt: "work",
					context: { mode: "isolated" },
					tools: ["read"],
					readOnly: true,
				},
				{ id: "next", type: "set", assignments: { reached: true } },
			],
			edges: [{ from: "work", to: "next", when: { path: "never.true", equals: true } }],
			limits: { maxConcurrency: 1 },
			policy: {
				allowNonInteractive: true,
				allowNonInteractiveMutations: false,
				confirmProjectGraph: false,
				confirmMutatingNodes: false,
			},
		};
		const engine = new GraphEngine(definition, {
			projectRoot: directory,
			jobId: "gap-job",
			createAgentSession: async () => ({
				session: {
					sessionId: "s",
					async prompt() {},
					getActiveToolNames: () => ["read"],
					dispose() {},
				},
			}),
		});

		// `fail` parks the run after writing the durable record: a routing gap is
		// a defect in the graph the operator must fix, never reported as success.
		const stopped = await engine.runSuperstep();
		engine.dispose();
		assert.equal(stopped.status, "paused");
		assert.equal(stopped.pause?.recovery, "contract");
		assert.match(stopped.pause?.reason ?? "", /no graph edge from work matched/u);
		assert.match(stopped.nodes.work.error ?? "", /no graph edge from work matched/u);
		assert.deepEqual(stopped.pause?.resume, ["work"]);
		assert.equal(stopped.values.reached, undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the gated graph gates implement on plan approval and routes a change request back to plan", async () => {
	const gated = await graph("coding-loop.gated");
	const approval = gated.nodes.find((node) => node.id === "plan-approval");
	assert.equal(approval?.type, "human");
	if (approval?.type !== "human") throw new Error("unreachable");
	assert.equal(approval.statePath, "plan.approved");
	assert.equal(approval.detail, "stack.json", "the gate shows the plan it asks about");
	assert.equal(approval.feedbackPath, "plan.feedback");
	const plan = gated.nodes.find((node) => node.id === "plan");
	assert.equal(plan?.type, "agent");
	if (plan?.type !== "agent") throw new Error("unreachable");
	assert.equal(plan.feedbackPath, "plan.feedback", "a change request reaches the re-run planner");

	assert.deepEqual(fired(gated, "plan", state({})), ["plan-approval"]);
	assert.deepEqual(fired(gated, "plan-approval", state({ "plan.approved": true })), ["implement"]);
	assert.deepEqual(fired(gated, "plan-approval", state({ "plan.approved": false })), ["plan"]);
	assert.deepEqual(fired(gated, "plan-check", state({})), ["implement"]);

	// Autopilot has no operator, so it has no plan gate to add.
	const auto = await graph("coding-loop.auto");
	assert.equal(
		auto.nodes.some((node) => node.type === "human"),
		false,
	);
	assert.equal(
		auto.nodes.some((node) => node.id === "plan-approval"),
		false,
	);
});

test("the shipped graphs carry only maxConcurrency and route no-progress through plan before pausing", async () => {
	const loops = ["coding-loop.gated", "coding-loop.auto"] as const;
	for (const name of [...loops, "spec-first"] as const) {
		const definition = await graph(name);
		assert.deepEqual(Object.keys(definition.limits), ["maxConcurrency"], `${name} carries only maxConcurrency`);
	}

	const pauses: Record<string, { recovery: string; resume: string[] }> = {
		unsafe: { recovery: "bounds", resume: ["test"] },
		"needs-human": { recovery: "review", resume: ["implement"] },
		"no-progress": { recovery: "no_progress", resume: ["plan"] },
	};
	for (const name of loops) {
		const definition = await graph(name);
		for (const [id, expected] of Object.entries(pauses)) {
			const node = definition.nodes.find((candidate) => candidate.id === id);
			assert.equal(node?.type, "pause", `${name}: ${id} is a pause node`);
			if (node?.type !== "pause") throw new Error("unreachable");
			assert.equal(node.recovery, expected.recovery, `${name}: ${id} recovery`);
			assert.deepEqual(node.resume, expected.resume, `${name}: ${id} resume`);
			assert.ok(node.reason.length > 0, `${name}: ${id} states a reason`);
		}

		// Over every combination of the three facts, exactly one REVISE edge
		// from review fires and exactly one red-test edge from test fires: the
		// engine unions every firing edge, so two would schedule two targets.
		for (const repeated of [true, false]) {
			for (const repairTried of [true, false]) {
				for (const provided of [true, false]) {
					const facts = {
						"progress.repeated": repeated,
						"plan.repair_tried": repairTried,
						"plan.provided": provided,
					};
					const label = `${name} repeated=${repeated} repair_tried=${repairTried} provided=${provided}`;
					const expected = !repeated ? ["implement"] : repairTried || provided ? ["no-progress!"] : ["plan"];
					assert.deepEqual(
						fired(
							definition,
							"review",
							state({ "bounds.held": true, "review.approved": false, "review.status": "REVISE", ...facts }),
						),
						expected,
						`review REVISE: ${label}`,
					);
					assert.deepEqual(
						fired(definition, "test", state({ "bounds.held": true, "test.passed": false, ...facts })),
						expected,
						`red test: ${label}`,
					);
				}
			}
		}

		// A --plan job never routes to plan: the operator's frozen plan is theirs.
		for (const from of ["review", "test"]) {
			for (const repairTried of [true, false]) {
				const targets = fired(
					definition,
					from,
					state({
						"bounds.held": true,
						"review.approved": false,
						"review.status": "REVISE",
						"test.passed": false,
						"progress.repeated": true,
						"plan.repair_tried": repairTried,
						"plan.provided": true,
					}),
				);
				assert.equal(targets.includes("plan"), false, `${name}: a --plan job never routes ${from} to plan`);
			}
		}
	}
});
