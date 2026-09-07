import assert from "node:assert/strict";
import test from "node:test";

import {
	acceptanceGoalId,
	createGoalGraph,
	projectGoalGraph,
	unfulfilledRequiredGoals,
} from "../packages/coding-agent/src/kpi/extensions/graph/goals.ts";
import { HOST_VERIFIER_ID, type HostEvidence } from "../packages/coding-agent/src/kpi/extensions/graph/verification.ts";
import { contractHash, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

const task: Task = {
	job_id: "goal-identity",
	mode: "gated",
	goal: "Preserve complete accepted goal coverage",
	nongoals: [],
	acceptance: [
		{
			id: "AC-required",
			statement: "Required behavior",
			required: true,
			check: { kind: "command", cmd: "node check.cjs" },
		},
		{ id: "AC-optional", statement: "Optional behavior", required: false },
	],
	constraints: [],
	quality_gates: ["node gate.cjs"],
	ac: { quality: "partial" },
};

test("acceptance identity remains stable through execution-slice changes but not intent amendments", () => {
	const graph = createGoalGraph(task);
	const moved = createGoalGraph({ ...task, current_module_id: "different-slice" });
	assert.deepEqual(moved, graph);
	assert.equal(graph.goals[0].id, acceptanceGoalId(contractHash(task), "AC-required"));
	const amended = createGoalGraph({
		...task,
		acceptance: task.acceptance.map((criterion) => ({ ...criterion, statement: `${criterion.statement} amended` })),
	});
	assert.notEqual(amended.goals[0].id, graph.goals[0].id);
	assert.notEqual(amended.intent_hash, graph.intent_hash);
});

test("duplicate, missing, blank and whitespace-ambiguous acceptance IDs are rejected", () => {
	assert.throws(
		() => createGoalGraph({ ...task, acceptance: [task.acceptance[0], task.acceptance[0]] }),
		/Duplicate acceptance/,
	);
	for (const id of [undefined, "", " ", " AC-required"]) {
		assert.throws(
			() => createGoalGraph({ ...task, acceptance: [{ ...task.acceptance[0], id: id as string }] }),
			/IDs/,
		);
	}
});

test("required quality and acceptance goals remain incomplete when blocked or unverified", () => {
	const graph = createGoalGraph(task);
	assert.deepEqual(
		unfulfilledRequiredGoals(graph).map((goal) => goal.id),
		[graph.goals[0].id, graph.goals[2].id],
	);
	graph.goals[0].status = "blocked";
	graph.goals[2].status = "passed";
	assert.deepEqual(
		unfulfilledRequiredGoals(graph).map((goal) => goal.id),
		[graph.goals[0].id],
	);
	graph.goals[0].status = "passed";
	assert.deepEqual(unfulfilledRequiredGoals(graph), []);
	assert.equal(graph.goals[1].status, "unverified", "optional unknown goals do not become invented successes");
});

test("serialized testimony cannot update goal verification even when it claims the host identity", () => {
	for (const verifier_id of ["builder-1", HOST_VERIFIER_ID]) {
		const forged = {
			verifier_id,
			job_id: task.job_id,
			intent_hash: contractHash(task),
			tree_hash: "claimed-tree",
			passed: true,
			ac_results: task.acceptance.map((criterion) => ({ id: criterion.id, passed: true })),
		} as HostEvidence;
		assert.throws(() => projectGoalGraph(task, forged), /independent host receipts/);
	}
});
