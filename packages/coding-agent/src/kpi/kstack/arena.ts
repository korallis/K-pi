import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentGraphNode, GraphDefinition } from "../extensions/graph/schema.ts";
import { modelFamily } from "./ladder.ts";
import { readKStackModels } from "./models.ts";
import { engineeringModelSlug } from "./observations.ts";
import {
	type EngineeringModelRequest,
	type EngineeringModelResolution,
	engineeringRoleMapping,
	resolveEngineeringModel,
} from "./routing.ts";

export interface ArchitectureDecision {
	id: string;
	/** Deliberate host/operator input, never inferred from a trivial task. */
	oneWayDoor: true;
	question: string;
	consequences: string;
	alternatives: string[];
}

export interface ArchitectureArena {
	graph: GraphDefinition;
	/** Host must apply these model selections to each node, not merely put them in a prompt. */
	assignments: Record<string, EngineeringModelResolution>;
	proposalEvidence: string[];
	judgeEvidence: string;
	judgeNodeId: string;
	independentJudge: boolean;
}

/** Construct a graph in the existing engine; no new scheduler and no automatic fanout. */
export async function createArchitectureArena(
	request: Omit<EngineeringModelRequest, "role"> & {
		projectRoot: string;
		decision: ArchitectureDecision;
		proposalCount?: number;
	},
): Promise<ArchitectureArena> {
	const { decision } = request;
	const count = request.proposalCount ?? 2;
	if (
		decision.oneWayDoor !== true ||
		!decision.id?.trim() ||
		!decision.question?.trim() ||
		!decision.consequences?.trim() ||
		!Array.isArray(decision.alternatives) ||
		decision.alternatives.length < 2 ||
		!decision.alternatives.every((alternative) => typeof alternative === "string" && alternative.trim())
	) {
		throw new Error(
			"Architecture arena requires an explicit consequential one-way-door decision and at least two alternatives",
		);
	}
	if (!Number.isSafeInteger(count) || count < 2)
		throw new Error("Architecture arena requires at least two independently scoped proposals");
	const [available, policy] = await Promise.all([
		request.modelRuntime.getAvailable(),
		readKStackModels(request.policyPath),
	]);
	const mappedPool = (role: string): typeof available => {
		const configured = engineeringRoleMapping(policy, role);
		const mapped = available.filter((model) => configured.includes(engineeringModelSlug(model)));
		return mapped.length ? mapped : available;
	};
	const proposalPool = mappedPool("planner");
	const judgePool = mappedPool("reviewer");
	const family = (model: (typeof available)[number]): string | undefined =>
		policy?.model_families?.[engineeringModelSlug(model)] ?? modelFamily(engineeringModelSlug(model));
	// Reserve an independent judge before selecting proposers; never claim provider diversity as family diversity.
	let selections: EngineeringModelResolution[] | undefined;
	let judge: EngineeringModelResolution | undefined;
	for (const candidate of judgePool) {
		const judgeFamily = family(candidate);
		if (!judgeFamily) continue;
		const pool = proposalPool.filter((model) => family(model) !== undefined && family(model) !== judgeFamily);
		if (!pool.length) continue;
		try {
			const proposals: EngineeringModelResolution[] = [];
			for (let index = 0; index < count; index++) {
				const selection = await resolveEngineeringModel({
					...request,
					role: "planner",
					modelRuntime: { getAvailable: async () => pool },
				});
				proposals.push(selection);
				if (pool.length > 1) pool.splice(pool.indexOf(selection.model), 1);
			}
			const selection = await resolveEngineeringModel({
				...request,
				role: "reviewer",
				builderModel: proposals[0].model,
				modelRuntime: { getAvailable: async () => [candidate] },
			});
			selections = proposals;
			judge = selection;
			break;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("No available authenticated model")) throw error;
		}
	}
	const independentJudge = selections !== undefined && judge !== undefined;
	if (!selections || !judge) {
		const selection = await resolveEngineeringModel({ ...request, role: "planner" });
		selections = Array.from({ length: count }, () => selection);
		judge = await resolveEngineeringModel({ ...request, role: "reviewer", builderModel: selection.model });
		judge.reason.push(
			"Arena cross-family capacity unavailable: isolated proposals are not independent-model review; mandatory host verification follows judgment.",
		);
	}
	const id = `arena-${randomUUID()}`;
	const entryId = `${id}-decision`;
	const judgeNodeId = `${id}-judge`;
	const verificationId = `${id}-verification`;
	const proposalSchema = "arena-proposal.schema.json";
	const judgeSchema = "arena-judge.schema.json";
	const proposalEvidence = selections.map((_, index) => `architecture/${id}/proposal-${index + 1}.json`);
	const judgeEvidence = `architecture/${id}/judgment.json`;
	const assignments: Record<string, EngineeringModelResolution> = {};
	const proposals: AgentGraphNode[] = selections.map((selection, index) => {
		const nodeId = `${id}-proposal-${index + 1}`;
		assignments[nodeId] = selection;
		return {
			id: nodeId,
			type: "agent",
			role: "architect",
			required: true,
			context: { mode: "isolated" },
			readOnly: true,
			tools: ["read", "grep", "find", "ls"],
			prompt: `Independently propose an architecture for this explicit one-way-door decision: ${JSON.stringify(decision)}. Your exploration lens is alternative ${(index % decision.alternatives.length) + 1}: ${decision.alternatives[index % decision.alternatives.length]}. Critique it and consider alternatives; do not read sibling proposals or judge output. Cite inspected evidence, expose tradeoffs and unresolved risks. This is a proposal, not a verified successful outcome.`,
			response: { path: proposalEvidence[index], schema: proposalSchema, retries: 0, state: {} },
		};
	});
	assignments[judgeNodeId] = judge;
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id,
		entry: entryId,
		limits: { maxConcurrency: count },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: true,
			confirmMutatingNodes: true,
		},
		nodes: [
			{
				id: entryId,
				type: "set",
				assignments: {
					[`arena.${id}.decision`]: { ...decision },
					[`arena.${id}.models`]: Object.fromEntries(
						Object.entries(assignments).map(([nodeId, selection]) => [
							nodeId,
							engineeringModelSlug(selection.model),
						]),
					),
				},
			},
			...proposals,
			{
				id: judgeNodeId,
				type: "agent",
				role: "reviewer",
				required: true,
				dependencies: proposals.map((node) => node.id),
				arenaProposalRefs: proposalEvidence,
				context: { mode: "isolated" },
				readOnly: true,
				tools: ["read", "grep", "find", "ls"],
				prompt: `Judge this one-way-door decision: ${JSON.stringify(decision)}. Read all independently generated proposal files in the run directory: ${proposalEvidence.join(", ")}. Compare tradeoffs and evidence, synthesize a reasoned decision and retain every proposal reference and unresolved risk. Your judgment is advisory, not deterministic verification or release approval.`,
				response: { path: judgeEvidence, schema: judgeSchema, retries: 0, state: {} },
			},
			...(!independentJudge
				? [{ id: verificationId, type: "verify" as const, dependencies: [judgeNodeId], required: true }]
				: []),
		],
		edges: [
			...proposals.map((node) => ({ from: entryId, to: node.id })),
			...proposals.map((node) => ({ from: node.id, to: judgeNodeId })),
			...(!independentJudge
				? [
						{ from: judgeNodeId, to: verificationId },
						{ from: verificationId, to: "__end__" },
					]
				: [{ from: judgeNodeId, to: "__end__" }]),
		],
	};
	return { graph, assignments, proposalEvidence, judgeEvidence, judgeNodeId, independentJudge };
}

/** Retain actual proposal/judge evidence and model identities, without converting judgment into a pass. */
export async function retainArchitectureArenaEvidence(arena: ArchitectureArena, runDirectory: string): Promise<string> {
	const files = [...arena.proposalEvidence, arena.judgeEvidence];
	const evidence = await Promise.all(
		files.map(async (path) => {
			const raw = await readFile(join(runDirectory, path));
			return { path, sha256: createHash("sha256").update(raw).digest("hex"), rawBase64: raw.toString("base64") };
		}),
	);
	const judgment = JSON.parse(Buffer.from(evidence[evidence.length - 1].rawBase64, "base64").toString("utf8"));
	if (
		!Array.isArray(judgment.proposalRefs) ||
		judgment.proposalRefs.length !== arena.proposalEvidence.length ||
		!arena.proposalEvidence.every((path) => judgment.proposalRefs.includes(path))
	)
		throw new Error("Arena judgment must retain every independent proposal reference");
	const path = join(runDirectory, "architecture", arena.graph.id, `evidence-${randomUUID()}.json`);
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			graphId: arena.graph.id,
			kind: "advisory-architecture-judgment",
			models: Object.fromEntries(
				Object.entries(arena.assignments).map(([nodeId, selection]) => [
					nodeId,
					engineeringModelSlug(selection.model),
				]),
			),
			evidence,
		}),
		{ flag: "wx", mode: 0o600 },
	);
	return path;
}
