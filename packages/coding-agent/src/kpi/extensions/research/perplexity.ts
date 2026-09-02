import { DEFAULT_PERPLEXITY_BASE_URL, fetchBounded } from "./endpoints.ts";
import { ResearchHttpError, type ResearchResult } from "./exa.ts";
import { clampField, MAX_FIELD_CHARACTERS, MAX_RESULTS_PER_REQUEST } from "./session.ts";

/** Documented Search path, joined onto whichever origin is configured. */
const PERPLEXITY_SEARCH_PATH = "/search";

/**
 * Token bounds, because they are the only hard ones Perplexity Search offers.
 * `search_context_size` is qualitative and bounds nothing, so a hard-bounded
 * request omits it rather than pretending it is a limit.
 */
export const DEFAULT_MAX_TOKENS = 2_000;
export const DEFAULT_MAX_TOKENS_PER_PAGE = 512;

export interface PerplexitySearchOptions {
	maxResults?: number;
	maxTokens?: number;
	maxTokensPerPage?: number;
	/** Overridable origin; defaults to Perplexity's documented one. */
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

/**
 * The date the provider stated, kept as one field. `date` and `last_updated`
 * mean different things, so the published date is never filled from the other.
 */
function publishedDate(record: Record<string, unknown>): string | undefined {
	const value = record.date;
	return typeof value === "string" && value.trim().length > 0 ? clampField(value.trim(), 64) : undefined;
}

function boundedSnippet(record: Record<string, unknown>): string | undefined {
	const candidate = typeof record.snippet === "string" ? record.snippet : undefined;
	if (candidate === undefined || candidate.trim().length === 0) {
		return undefined;
	}
	return clampField(candidate.trim(), MAX_FIELD_CHARACTERS);
}

export async function perplexitySearch(
	query: string,
	key: string,
	options: PerplexitySearchOptions = {},
): Promise<ResearchResult[]> {
	const maxResults = Math.max(1, Math.min(MAX_RESULTS_PER_REQUEST, Math.trunc(options.maxResults ?? 5)));
	const response = await fetchBounded(
		`${options.baseUrl ?? DEFAULT_PERPLEXITY_BASE_URL}${PERPLEXITY_SEARCH_PATH}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				query: clampField(query, MAX_FIELD_CHARACTERS),
				max_results: maxResults,
				// Hard bounds only. No `search_context_size`: it is qualitative.
				max_tokens: Math.max(1, Math.trunc(options.maxTokens ?? DEFAULT_MAX_TOKENS)),
				max_tokens_per_page: Math.max(1, Math.trunc(options.maxTokensPerPage ?? DEFAULT_MAX_TOKENS_PER_PAGE)),
			}),
		},
		{ service: "Perplexity", timeoutMs: options.timeoutMs, signal: options.signal, fetch: options.fetch },
	);
	// Status first, independent of envelope shape.
	if (!response.ok) {
		throw new ResearchHttpError(response.status, "Perplexity");
	}
	const payload = asRecord(await response.json());
	if (payload === undefined || !Array.isArray(payload.results)) {
		return [];
	}
	const results: ResearchResult[] = [];
	for (const entry of payload.results.slice(0, MAX_RESULTS_PER_REQUEST)) {
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
			...(publishedDate(record) === undefined ? {} : { publishedDate: publishedDate(record) }),
			...(boundedSnippet(record) === undefined ? {} : { text: boundedSnippet(record) }),
		});
	}
	return results;
}
