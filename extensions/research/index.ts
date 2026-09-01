import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { exaContents, exaSearch } from "./exa.ts";
import { perplexitySearch } from "./perplexity.ts";

async function keyFor(service: "exa" | "perplexity"): Promise<string | undefined> {
  const environment = service === "exa" ? process.env.EXA_API_KEY : process.env.PERPLEXITY_API_KEY;
  if (environment !== undefined) return environment;
  try {
    const payload: unknown = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "accounts.secrets.json"), "utf8"));
    if (typeof payload !== "object" || payload === null) return undefined;
    const credential = Reflect.get(payload, `${service}/default`);
    if (typeof credential !== "object" || credential === null) return undefined;
    const key = Reflect.get(credential, "key");
    return typeof key === "string" ? key : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function text(value: unknown): string {
  return JSON.stringify(value).slice(0, 30_000);
}

export function registerResearchTools(pi: ExtensionAPI): void {
  pi.registerTool(defineTool({
    name: "exa_search",
    label: "Exa Search",
    description: "Search current web sources through the first-party Exa REST client",
    parameters: Type.Object({ query: Type.String(), numResults: Type.Optional(Type.Number()) }),
    async execute(_id, params, signal) {
      const key = await keyFor("exa");
      if (key === undefined) throw new Error("Exa API key is not configured");
      const results = await exaSearch(params.query, key, { numResults: params.numResults, signal });
      return { content: [{ type: "text", text: text(results) }], details: { results } };
    },
  }));
  pi.registerTool(defineTool({
    name: "exa_contents",
    label: "Exa Contents",
    description: "Retrieve bounded highlights for at most ten URLs through Exa",
    parameters: Type.Object({ urls: Type.Array(Type.String(), { maxItems: 10 }) }),
    async execute(_id, params, signal) {
      const key = await keyFor("exa");
      if (key === undefined) throw new Error("Exa API key is not configured");
      const results = await exaContents(params.urls, key, { signal });
      return { content: [{ type: "text", text: text(results) }], details: { results } };
    },
  }));
  pi.registerTool(defineTool({
    name: "pplx_search",
    label: "Perplexity Search",
    description: "Search current web sources through the first-party Perplexity REST client",
    parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()) }),
    async execute(_id, params, signal) {
      const key = await keyFor("perplexity");
      if (key === undefined) throw new Error("Perplexity API key is not configured");
      const results = await perplexitySearch(params.query, key, { maxResults: params.maxResults, signal });
      return { content: [{ type: "text", text: text(results) }], details: { results } };
    },
  }));
}
