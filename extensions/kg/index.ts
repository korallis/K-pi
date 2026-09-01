import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { KnowledgeGraphStore, type GraphPatch } from "./store.ts";

export function registerKnowledgeGraph(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "kg_propose",
      label: "KG Propose",
      description: "Write a knowledge graph patch to the inbox for control-plane acceptance",
      parameters: Type.Object({
        node: Type.Object({
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
        }),
      }),
      async execute(_id, params, _signal, _update, context) {
        const path = await new KnowledgeGraphStore(context.cwd).propose(params as GraphPatch);
        return { content: [{ type: "text", text: path }], details: { path } };
      },
    }),
  );

  pi.registerCommand("kg", {
    description: "Query, propose, or accept K-π knowledge graph claims",
    handler: async (args, context) => {
      const store = new KnowledgeGraphStore(context.cwd);
      const [action, ...rest] = args.trim().split(/\s+/u);
      if (action === "query" || action === "") {
        const nodes = await store.query(rest.join(" "));
        context.ui.notify(nodes.map((node) => `${node.id}@${node.rev} ${node.status}`).join("\n") || "No claims", "info");
        return;
      }
      if (action === "propose") {
        const patch = JSON.parse(rest.join(" ")) as GraphPatch;
        context.ui.notify(await store.propose(patch), "info");
        return;
      }
      if (action === "accept") {
        const node = await store.accept(rest.join(" "));
        context.ui.notify(`Accepted ${node.id}@${node.rev}`, "info");
        return;
      }
      throw new Error("Usage: /kg query <text> | propose <json> | accept <inbox-path>");
    },
  });
}
