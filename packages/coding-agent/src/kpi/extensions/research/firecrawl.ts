import { DEFAULT_FIRECRAWL_BASE_URL, DEFAULT_RESEARCH_TIMEOUT_MS, fetchBounded } from "./endpoints.ts";
import { ResearchHttpError, type ResearchResult } from "./exa.ts";
import { clampField, MAX_FIELD_CHARACTERS, MAX_RESULTS_PER_REQUEST } from "./session.ts";

/** Documented v2 Search path, joined onto whichever origin is configured. */
export const FIRECRAWL_SEARCH_PATH = "/v2/search";

/** The vendor schema's own `query` bound (docs.firecrawl.dev/api-reference/endpoint/search). */
export const FIRECRAWL_MAX_QUERY_CHARACTERS = 500;

export interface FirecrawlSearchOptions {
	limit?: number;
	/** Overridable origin; defaults to Firecrawl's documented one. */
	baseUrl?: string;
	/** Per-request deadline. Omitted means the control plane's default. */
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function usableUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function usableTitle(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const collapsed = value.replaceAll(/\s+/gu, " ").trim();
	return collapsed.length === 0 ? fallback : clampField(collapsed, 300);
}

function boundedText(record: Record<string, unknown>): string | undefined {
	const description = typeof record.description === "string" ? record.description : undefined;
	const markdown = typeof record.markdown === "string" ? record.markdown : undefined;
	// description first: markdown is the full scraped page, not a bounded excerpt.
	const candidate = description !== undefined && description.trim().length > 0 ? description : markdown;
	if (candidate === undefined || candidate.trim().length === 0) {
		return undefined;
	}
	return clampField(candidate.trim(), MAX_FIELD_CHARACTERS);
}

/**
 * The v2 schema nests results under `data.web`; a v1-shaped deployment (a
 * self-hosted or older Firecrawl) answers with a flat `data` array instead.
 * Both are read; neither is required.
 */
function resultRecords(payload: Record<string, unknown>): unknown[] {
	const data = payload.data;
	if (asRecord(data) !== undefined && Array.isArray(asRecord(data)?.web)) {
		return (asRecord(data)?.web as unknown[]) ?? [];
	}
	if (Array.isArray(data)) {
		return data;
	}
	return [];
}

/**
 * Firecrawl Search, v2. Never sends `scrapeOptions`: this client asks for
 * bounded search excerpts, never full page content. A 200 response whose
 * envelope names failure (`success !== true`) is a `ResearchHttpError` too, so
 * it classifies as `unavailable` and cools the service rather than returning a
 * silently empty result.
 */
export async function firecrawlSearch(
	query: string,
	key: string,
	options: FirecrawlSearchOptions = {},
): Promise<ResearchResult[]> {
	const limit = Math.max(1, Math.min(MAX_RESULTS_PER_REQUEST, Math.trunc(options.limit ?? 5)));
	const response = await fetchBounded(
		`${options.baseUrl ?? DEFAULT_FIRECRAWL_BASE_URL}${FIRECRAWL_SEARCH_PATH}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				query: clampField(query, FIRECRAWL_MAX_QUERY_CHARACTERS),
				limit,
				sources: [{ type: "web" }],
				timeout: options.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS,
			}),
		},
		{ service: "Firecrawl", timeoutMs: options.timeoutMs, signal: options.signal, fetch: options.fetch },
	);
	// Status first, independent of envelope shape.
	if (!response.ok) {
		throw new ResearchHttpError(response.status, "Firecrawl");
	}
	const payload = asRecord(await response.json());
	if (payload === undefined || payload.success !== true) {
		// A 200 refusal is still a refusal: classify and cool, never a fake empty answer.
		throw new ResearchHttpError(response.status, "Firecrawl");
	}
	const results: ResearchResult[] = [];
	for (const entry of resultRecords(payload).slice(0, MAX_RESULTS_PER_REQUEST)) {
		const record = asRecord(entry);
		if (record === undefined) {
			continue;
		}
		const url = usableUrl(record.url);
		if (url === undefined) {
			continue;
		}
		results.push({
			title: usableTitle(record.title, url),
			url,
			// Firecrawl Search returns no published date.
			...(boundedText(record) === undefined ? {} : { text: boundedText(record) }),
		});
	}
	return results;
}
