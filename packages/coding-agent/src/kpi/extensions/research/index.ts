import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { defineTool, type ExtensionAPI } from "../../../core/extensions/types.ts";
import { readActiveJob } from "../run-store.ts";
import { readKpiSettings } from "../settings.ts";

import { exaContents, exaSearch } from "./exa.ts";
import { perplexitySearch } from "./perplexity.ts";
import {
	clampField,
	MAX_CONTENTS_URLS,
	MAX_RESULTS_PER_REQUEST,
	type ResearchService,
	ResearchSession,
	resolveResearchKeys,
} from "./session.ts";

/** Tool output stays bounded: a model context is not a place to dump a page. */
const MAX_TOOL_OUTPUT_CHARACTERS = 10_000;

interface ToolSession {
	session: ResearchSession;
	service: ResearchService;
}

/**
 * One session per job, so the 20-call budget, the cooldowns and the events are
 * shared by every research tool call the job makes rather than restarting with
 * each tool invocation.
 */
const sessions = new Map<string, ResearchSession>();

async function sessionFor(cwd: string, service: ResearchService): Promise<ToolSession> {
	const job = await readActiveJob(cwd);
	const jobId = job?.jobId ?? "no-job";
	const existing = sessions.get(jobId);
	if (existing !== undefined) {
		return { session: existing, service };
	}
	const session = new ResearchSession({
		jobId,
		mode: (await readKpiSettings(cwd)).research,
		keys: await resolveResearchKeys(),
		eventsPath: job === undefined ? undefined : join(cwd, CONFIG_DIR_NAME, "runs", jobId, "events.jsonl"),
		round: typeof job?.state.round === "number" ? job.state.round : 0,
		node: typeof job?.state.node === "string" ? job.state.node : "research",
	});
	sessions.set(jobId, session);
	return { session, service };
}

/** Test seam: a fresh process starts with no sessions, and so must a fresh test. */
export function resetResearchSessions(): void {
	sessions.clear();
}

function summarize(results: readonly { title: string; url: string; text?: string }[]): string {
	// Normalized citations only: never a raw provider envelope.
	const lines = results.map((result) =>
		result.text === undefined
			? `- ${result.title} ${result.url}`
			: `- ${result.title} ${result.url}\n  ${result.text}`,
	);
	return clampField(lines.join("\n"), MAX_TOOL_OUTPUT_CHARACTERS);
}

export function registerResearchTools(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "exa_search",
			label: "Exa Search",
			description: "Search current web sources through the first-party Exa REST client",
			parameters: Type.Object({ query: Type.String(), numResults: Type.Optional(Type.Number()) }),
			async execute(_id, params, signal, _update, context) {
				const { session } = await sessionFor(context.cwd, "exa");
				const outcome = await session.call("exa", params.query, async (key) =>
					exaSearch(params.query, key, {
						numResults: Math.min(params.numResults ?? 5, MAX_RESULTS_PER_REQUEST),
						signal,
					}),
				);
				if (!outcome.ok) {
					throw new Error(`Exa research call failed: ${outcome.class}`);
				}
				await session.addExternalResults("exa", outcome.value);
				return { content: [{ type: "text", text: summarize(outcome.value) }], details: { results: outcome.value } };
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "exa_contents",
			label: "Exa Contents",
			description: "Retrieve bounded highlights for at most ten URLs through Exa",
			parameters: Type.Object({ urls: Type.Array(Type.String(), { maxItems: MAX_CONTENTS_URLS }) }),
			async execute(_id, params, signal, _update, context) {
				const { session } = await sessionFor(context.cwd, "exa");
				const urls = params.urls.slice(0, MAX_CONTENTS_URLS);
				const outcome = await session.call("exa", urls.join(" "), async (key) =>
					exaContents(urls, key, { signal }),
				);
				if (!outcome.ok) {
					throw new Error(`Exa research call failed: ${outcome.class}`);
				}
				await session.addExternalResults("exa", outcome.value);
				return { content: [{ type: "text", text: summarize(outcome.value) }], details: { results: outcome.value } };
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "pplx_search",
			label: "Perplexity Search",
			description: "Search current web sources through the first-party Perplexity REST client",
			parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()) }),
			async execute(_id, params, signal, _update, context) {
				const { session } = await sessionFor(context.cwd, "perplexity");
				const outcome = await session.call("perplexity", params.query, async (key) =>
					perplexitySearch(params.query, key, {
						maxResults: Math.min(params.maxResults ?? 5, MAX_RESULTS_PER_REQUEST),
						signal,
					}),
				);
				if (!outcome.ok) {
					throw new Error(`Perplexity research call failed: ${outcome.class}`);
				}
				await session.addExternalResults("perplexity", outcome.value);
				return { content: [{ type: "text", text: summarize(outcome.value) }], details: { results: outcome.value } };
			},
		}),
	);
}
