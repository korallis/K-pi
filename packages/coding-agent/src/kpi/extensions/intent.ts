import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getKpiResourceDir } from "../../config.ts";
import { scoreAcceptanceCriteria } from "./graph/ac-compiler.ts";
import { type JsonSchema, validateJsonSchema } from "./graph/json-schema.ts";
import {
	type AcceptanceCriterion,
	type IntentDetails,
	ProtectedIntentError,
	preservesAcceptanceCriterion,
	type Task,
} from "./run-store.ts";

export interface IntentProposal extends IntentDetails {
	acceptance: AcceptanceCriterion[];
	nongoals?: string[];
	questions: string[];
}

export interface IntentRefinement {
	task: Task;
	questions: string[];
	summary: string;
}

/** Resolve the proposed experience without authorising it or replacing the user's goal. */
export async function readIntentRefinement(runDirectory: string, original: Task): Promise<IntentRefinement> {
	const [source, schemaSource] = await Promise.all([
		readFile(join(runDirectory, "intent.proposal.json"), "utf8"),
		readFile(join(getKpiResourceDir(), "schemas", "intent-proposal.schema.json"), "utf8"),
	]);
	const proposal = JSON.parse(source) as IntentProposal;
	const errors = validateJsonSchema(proposal, JSON.parse(schemaSource) as JsonSchema);
	if (errors.length > 0) throw new ProtectedIntentError(`Invalid desired-state proposal: ${errors.join("; ")}`);
	const acceptance = new Map(original.acceptance.map((criterion) => [criterion.id, criterion]));
	const proposedIds = new Set<string>();
	for (const criterion of proposal.acceptance) {
		if (proposedIds.has(criterion.id))
			throw new ProtectedIntentError(`Duplicate proposed acceptance id: ${criterion.id}`);
		proposedIds.add(criterion.id);
		const accepted = acceptance.get(criterion.id);
		if (accepted !== undefined && !preservesAcceptanceCriterion(accepted, criterion)) {
			throw new ProtectedIntentError(
				`Proposal changes accepted criterion ${criterion.id}; execution must adapt instead`,
			);
		}
		acceptance.set(criterion.id, criterion);
	}
	const journeyIds = new Set<string>();
	for (const journey of proposal.journeys) {
		if (journeyIds.has(journey.id)) throw new ProtectedIntentError(`Duplicate user journey: ${journey.id}`);
		journeyIds.add(journey.id);
		if (journey.acceptance_ids.length === 0 || journey.acceptance_ids.some((id) => !acceptance.has(id))) {
			throw new ProtectedIntentError(`Journey ${journey.id} must link to explicit acceptance criteria`);
		}
	}
	const { acceptance: _criteria, nongoals, questions, ...details } = proposal;
	const criteria = [...acceptance.values()];
	const quality = scoreAcceptanceCriteria(criteria).quality;
	const task: Task = {
		...original,
		acceptance: criteria,
		nongoals: [...new Set([...original.nongoals, ...(nongoals ?? [])])],
		ac: { quality },
		intent_details: details,
	};
	const summary = [
		original.goal,
		"",
		`Users: ${details.users.length === 0 ? "no direct user interaction declared" : details.users.join(", ")}`,
		...details.journeys.map(
			(journey) =>
				`Journey ${journey.id}: ${journey.actor} · ${journey.entry} → ${journey.steps.join(" → ")} [${journey.acceptance_ids.join(", ")}]`,
		),
		"",
		"Acceptance:",
		...criteria.map(
			(criterion) =>
				`${criterion.id}${criterion.required ? " (required)" : ""}: ${criterion.statement}\n  Check: ${JSON.stringify(criterion.check ?? null)}\n  Bounds: ${JSON.stringify(criterion.bounds ?? null)}`,
		),
		"",
		`Testing criteria: ${(details.testing_criteria ?? []).join("; ") || "the explicit checks above"}`,
		`Quality commands: ${task.quality_gates.join("; ") || "none configured"}`,
		`Non-goals: ${task.nongoals.join("; ") || "none declared"}`,
		...Object.entries(details)
			.filter(([key]) => key !== "users" && key !== "journeys" && key !== "testing_criteria")
			.map(([key, value]) => `${key.replaceAll("_", " ")}: ${(value as string[]).join("; ")}`),
		...(questions.length === 0 ? [] : ["", "Unresolved decisions:", ...questions]),
	].join("\n");
	return { task, questions, summary };
}
