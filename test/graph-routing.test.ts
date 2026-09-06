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
	GraphRunState,
	JsonObject,
} from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";

const root = new URL("..", import.meta.url).pathname;
const green: JsonObject = {
	"test.passed": true,
	"bounds.held": true,
	"fingerprints.fresh": true,
	"review.approved": true,
	"ship.shipped": false,
};

async function startAt(name: string, node: string, facts: JsonObject, projectRoot: string): Promise<GraphEngine> {
	const definition = await loadNamedGraph(root, name);
	const seed = new GraphEngine(definition, { projectRoot, jobId: "routing" });
	const initial: GraphRunState = structuredClone(seed.state);
	initial.active = [node];
	seed.dispose();
	return new GraphEngine(
		definition,
		{
			projectRoot,
			jobId: "routing",
			resolveFacts: async () => facts,
			executeVerification: async () => facts,
		},
		initial,
	);
}

test("independent verification must pass before either release path is scheduled", async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), "kpi-routing-"));
	try {
		for (const name of ["coding-loop.gated", "coding-loop.auto"]) {
			const engine = await startAt(name, "verify", green, projectRoot);
			await engine.runSuperstep();
			assert.deepEqual(engine.state.active, [name.endsWith("auto") ? "release.set" : "human"]);
			engine.dispose();
			const red = await startAt(name, "verify", { ...green, "test.passed": false }, projectRoot);
			await red.runSuperstep();
			assert.deepEqual(red.state.active, ["plan"]);
			assert.equal(red.state.values.release, undefined);
			red.dispose();
		}
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("repeated engineering failures replan even for a frozen operator plan", async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), "kpi-routing-"));
	try {
		for (const name of ["coding-loop.gated", "coding-loop.auto"]) {
			const engine = await startAt(
				name,
				"test",
				{
					"bounds.held": true,
					"test.passed": false,
					"progress.repeated": true,
					"plan.provided": true,
				},
				projectRoot,
			);
			await engine.runSuperstep();
			assert.deepEqual(engine.state.active, ["plan"]);
			assert.equal(engine.state.status, "running");
			engine.dispose();
		}
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("a safety violation still parks and retains the explicit recovery target", async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), "kpi-routing-"));
	try {
		const engine = await startAt(
			"coding-loop.auto",
			"test",
			{ "bounds.held": false, "test.passed": true },
			projectRoot,
		);
		await engine.runSuperstep();
		assert.equal(engine.state.status, "paused");
		assert.equal(engine.state.pause?.recovery, "bounds");
		assert.deepEqual(engine.state.pause?.resume, ["test"]);
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("release approval remains external and refusal does not schedule shipping", async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), "kpi-routing-"));
	try {
		const engine = await startAt("coding-loop.gated", "human", green, projectRoot);
		await engine.runSuperstep();
		assert.equal(engine.state.status, "interrupted");
		await engine.submitHuman({ approved: false, feedback: "Do not ship this candidate" });
		assert.deepEqual(engine.state.active, ["implement"]);
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("unmatched control branches cannot report successful exhaustion", async () => {
	const projectRoot = await mkdtemp(join(tmpdir(), "kpi-routing-"));
	try {
		const definition: GraphDefinition = {
			schemaVersion: 2,
			id: "gap",
			entry: "start",
			nodes: [{ id: "start", type: "set", assignments: {} }],
			edges: [{ from: "start", to: "__end__", when: { path: "missing", equals: true } }],
			limits: { maxConcurrency: 1 },
			policy: {
				allowNonInteractive: false,
				allowNonInteractiveMutations: false,
				confirmProjectGraph: true,
				confirmMutatingNodes: true,
			},
		};
		const engine = new GraphEngine(definition, { projectRoot, jobId: "gap" });
		await engine.runUntilPause();
		assert.equal(engine.state.status, "paused");
		assert.equal(engine.state.pause?.recovery, "contract");
		engine.dispose();
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
});

test("noninteractive graphs reject human gates instead of answering on their behalf", async () => {
	const definition = await loadNamedGraph(root, "coding-loop.auto");
	definition.nodes.push({
		id: "approval",
		type: "human",
		title: "Release",
		question: "Ship?",
		statePath: "release.approved",
	});
	assert.throws(() => validateGraphDefinition(definition), /non-interactive graph/);
});
