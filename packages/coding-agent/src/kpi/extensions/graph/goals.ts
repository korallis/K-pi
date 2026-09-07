import { contractHash, type Task } from "../run-store.ts";
import { HOST_VERIFIER_ID, type HostEvidence, isHostVerifiedEvidence } from "./verification.ts";

export type GoalStatus = "unverified" | "passed" | "failed" | "blocked";

export interface Goal {
	id: string;
	criterion_id?: string;
	quality_gate_index?: number;
	journey_id?: string;
	depends_on?: string[];
	statement: string;
	required: boolean;
	status: GoalStatus;
	receipt_ids: string[];
	reasons: string[];
}

export interface GoalGraph {
	version: 1;
	job_id: string;
	intent_hash: string;
	tree_hash?: string;
	verification_run_id?: string;
	goals: Goal[];
}

export function acceptanceGoalId(intentHash: string, criterionId: string): string {
	return `${intentHash}:ac:${criterionId}`;
}

export function qualityGoalId(intentHash: string, index: number): string {
	return `${intentHash}:quality:${index}`;
}

/** Execution topology may change; accepted criterion identity and requiredness may not. */
export function createGoalGraph(task: Task): GoalGraph {
	const intentHash = contractHash(task);
	const ids = new Set<string>();
	for (const criterion of task.acceptance) {
		if (typeof criterion.id !== "string" || !criterion.id.trim() || criterion.id !== criterion.id.trim()) {
			throw new Error("Acceptance criteria require nonblank, unambiguous IDs");
		}
		if (ids.has(criterion.id)) throw new Error(`Duplicate acceptance criterion ID: ${criterion.id}`);
		ids.add(criterion.id);
	}
	const journeys = task.intent_details?.journeys ?? [];
	const journeyIds = new Set<string>();
	for (const journey of journeys) {
		if (!journey.id.trim() || journey.id !== journey.id.trim() || journeyIds.has(journey.id)) {
			throw new Error("User journeys require unique nonblank IDs");
		}
		journeyIds.add(journey.id);
		if (
			!journey.acceptance_ids.length ||
			new Set(journey.acceptance_ids).size !== journey.acceptance_ids.length ||
			journey.acceptance_ids.some((id) => !ids.has(id))
		)
			throw new Error(`Journey ${journey.id} requires known, unique acceptance links`);
	}
	return {
		version: 1,
		job_id: task.job_id,
		intent_hash: intentHash,
		goals: [
			...task.acceptance.map(
				(criterion): Goal => ({
					id: acceptanceGoalId(intentHash, criterion.id),
					criterion_id: criterion.id,
					statement: criterion.statement,
					required: criterion.required,
					status: "unverified",
					receipt_ids: [],
					reasons: ["No independent host verification receipt"],
				}),
			),
			...task.quality_gates.map(
				(command, index): Goal => ({
					id: qualityGoalId(intentHash, index),
					quality_gate_index: index,
					statement: command,
					required: true,
					status: "unverified",
					receipt_ids: [],
					reasons: ["No independent host verification receipt"],
				}),
			),
			...journeys.map(
				(journey): Goal => ({
					id: `${intentHash}:journey:${journey.id}`,
					journey_id: journey.id,
					depends_on: journey.acceptance_ids.map((id) => acceptanceGoalId(intentHash, id)),
					statement: `${journey.actor}: ${journey.entry} → ${journey.steps.join(" → ")}`,
					required: true,
					status: "unverified",
					receipt_ids: [],
					reasons: ["Every linked acceptance check must independently pass"],
				}),
			),
		],
	};
}

/** Only evidence validated against immutable host records and full raw output can update goals. */
export function projectGoalGraph(task: Task, evidence: HostEvidence): GoalGraph {
	if (!isHostVerifiedEvidence(evidence) || evidence.verifier_id !== HOST_VERIFIER_ID) {
		throw new Error("Goal verification requires independent host receipts; builder testimony is not authority");
	}
	const graph = createGoalGraph(task);
	if (graph.intent_hash !== evidence.intent_hash || graph.job_id !== evidence.job_id) {
		throw new Error("Goal evidence belongs to a different protected intent");
	}
	graph.tree_hash = evidence.tree_hash;
	graph.verification_run_id = evidence.run_id;
	for (const goal of graph.goals) {
		if (goal.criterion_id !== undefined) {
			const result = evidence.ac_results.find((entry) => entry.id === goal.criterion_id);
			if (!result) throw new Error(`Missing acceptance evidence: ${goal.criterion_id}`);
			goal.status = result.status;
			goal.receipt_ids = [...result.receipt_ids];
			goal.reasons = [...result.reasons];
		} else if (goal.quality_gate_index !== undefined) {
			const receipt = evidence.commands.find((entry) => entry.command_id === `quality:${goal.quality_gate_index}`);
			if (!receipt) throw new Error(`Missing quality gate evidence: ${goal.id}`);
			goal.status = receipt.passed ? "passed" : receipt.status === "exited" ? "failed" : "blocked";
			goal.receipt_ids = [receipt.receipt_id];
			goal.reasons = receipt.passed ? [] : [receipt.error ?? `Quality gate ${receipt.status}; exit ${receipt.exit}`];
		}
	}
	for (const goal of graph.goals) {
		if (goal.journey_id === undefined) continue;
		const dependencies = goal.depends_on!.map((id) => graph.goals.find((candidate) => candidate.id === id)!);
		goal.status = dependencies.every((dependency) => dependency.status === "passed")
			? "passed"
			: dependencies.some((dependency) => dependency.status === "blocked")
				? "blocked"
				: dependencies.some((dependency) => dependency.status === "unverified")
					? "unverified"
					: "failed";
		goal.receipt_ids = [...new Set(dependencies.flatMap((dependency) => dependency.receipt_ids))];
		goal.reasons = dependencies
			.filter((dependency) => dependency.status !== "passed")
			.map((dependency) => `${dependency.criterion_id}: ${dependency.status}`);
	}
	return graph;
}

/** A projection is useful for display, never independently sufficient to authorise completion. */
export function unfulfilledRequiredGoals(graph: GoalGraph): Goal[] {
	return graph.goals.filter((goal) => goal.required && goal.status !== "passed");
}
