import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "../../../core/extensions/types.ts";

import { PATCH_KINDS } from "./schema.ts";
import { KnowledgeGraphControlPlane, KnowledgeGraphProposals } from "./store.ts";

/** Shape hint for the model. `validatePatch` is the enforcing contract. */
const claimEnvelope = {
	id: Type.String(),
	kind: Type.String(),
	source_ids: Type.Array(Type.String()),
	status: Type.Union([
		Type.Literal("proposed"),
		Type.Literal("verified"),
		Type.Literal("rejected"),
		Type.Literal("superseded"),
	]),
	observed_at: Type.String(),
};

export function registerKnowledgeGraph(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "kg_propose",
			label: "KG Propose",
			description:
				"Propose a knowledge graph claim. Writes one patch to the inbox for control-plane acceptance; " +
				"the authoritative nodes, edges, sources, and snapshots are never writable from here.",
			parameters: Type.Object({
				source: Type.Optional(Type.Object({ ...claimEnvelope, uri: Type.String() })),
				node: Type.Optional(Type.Object(claimEnvelope)),
				edge: Type.Optional(
					Type.Object({
						...claimEnvelope,
						from: Type.String(),
						to: Type.String(),
						confidence: Type.Optional(Type.Number()),
					}),
				),
			}),
			async execute(_id, params, _signal, _update, context) {
				// Proposal surface only: this class has no authoritative write path.
				const path = await new KnowledgeGraphProposals(context.cwd).propose(params);
				return { content: [{ type: "text", text: path }], details: { path } };
			},
		}),
	);

	pi.registerCommand("kg", {
		description: "Query, propose, or accept K-π knowledge graph claims",
		handler: async (args, context) => {
			const [action, ...rest] = args.trim().split(/\s+/u);
			if (action === "query" || action === "") {
				const nodes = await new KnowledgeGraphProposals(context.cwd).query(rest.join(" "));
				context.ui.notify(
					nodes.map((node) => `${node.id}@${node.rev} ${node.status}`).join("\n") || "No claims",
					"info",
				);
				return;
			}
			if (action === "propose") {
				const patch: unknown = JSON.parse(rest.join(" "));
				context.ui.notify(await new KnowledgeGraphProposals(context.cwd).propose(patch), "info");
				return;
			}
			if (action === "accept") {
				// The operator command is the control plane: the one authoritative writer.
				const accepted = await new KnowledgeGraphControlPlane(context.cwd).accept(rest.join(" "));
				const summary: string[] = [];
				for (const kind of PATCH_KINDS) {
					const record = accepted[kind];
					if (record !== undefined) {
						summary.push(`${kind} ${record.id}@${record.rev}`);
					}
				}
				context.ui.notify(`Accepted ${summary.join("  ")}`, "info");
				return;
			}
			throw new Error("Usage: /kg query <text> | propose <json> | accept <inbox-path>");
		},
	});
}
