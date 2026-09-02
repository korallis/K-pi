import { DEFAULT_EXA_BASE_URL, fetchBounded } from "./endpoints.ts";
import { clampField, MAX_CONTENTS_URLS, MAX_FIELD_CHARACTERS, MAX_RESULTS_PER_REQUEST } from "./session.ts";

/**
 * A normalized research result. Nothing vendor-shaped survives this boundary:
 * every field is a usable title, an absolute HTTP(S) URL, a date string kept as
 * the provider stated it, and bounded text.
 */
export interface ResearchResult {
	title: string;
	url: string;
	/** Whatever date the provider stated, unconflated with any other date. */
	publishedDate?: string;
	text?: string;
}

/** A URL Contents could not fetch, with the reason the provider gave. */
export interface ResearchUrlFailure {
	url: string;
	status?: number;
	error?: string;
}

export interface ResearchResponse {
	results: ResearchResult[];
	/** Per-URL failures on an HTTP 200 Contents response. Bounded diagnostics. */
	failures: ResearchUrlFailure[];
}

export class ResearchHttpError extends Error {
	readonly status: number;
	readonly service: string;
	constructor(status: number, service: string) {
		super(`${service} request failed: ${status}`);
		this.name = "ResearchHttpError";
		this.status = status;
		this.service = service;
	}
}

function boundedCount(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.min(MAX_RESULTS_PER_REQUEST, Math.trunc(value)));
}

/** An absolute HTTP(S) URL, or nothing. A result without one is not citable. */
function usableUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
}

/** A title the operator can read, never a dump and never empty. */
function usableTitle(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const collapsed = value.replaceAll(/\s+/gu, " ").trim();
	return collapsed.length === 0 ? fallback : clampField(collapsed, 300);
}

function usableDate(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	return clampField(value.trim(), 64);
}

/**
 * Bounded highlight or text content. Highlights are joined in order; the result
 * is clamped again here even though the request asked for a bound, because a
 * provider's maximum is a request, not a guarantee.
 */
function boundedText(record: Record<string, unknown>): string | undefined {
	const parts: string[] = [];
	const highlights = record.highlights;
	if (Array.isArray(highlights)) {
		for (const highlight of highlights) {
			if (typeof highlight === "string" && highlight.trim().length > 0) {
				parts.push(highlight.trim());
			}
		}
	}
	if (parts.length === 0 && typeof record.text === "string" && record.text.trim().length > 0) {
		parts.push(record.text.trim());
	}
	if (parts.length === 0) {
		return undefined;
	}
	return clampField(parts.join("\n"), MAX_FIELD_CHARACTERS);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Per-URL outcomes on an HTTP 200 Contents response.
 *
 * Contents answers 200 while individual URLs fail, so a successful envelope is
 * not a successful fetch. Only URLs whose status says success may be cited; the
 * rest become bounded diagnostics.
 */
function readStatuses(payload: Record<string, unknown>): Map<string, ResearchUrlFailure> {
	const failures = new Map<string, ResearchUrlFailure>();
	const statuses = payload.statuses;
	if (!Array.isArray(statuses)) {
		return failures;
	}
	for (const entry of statuses) {
		const record = asRecord(entry);
		if (record === undefined) {
			continue;
		}
		const url = typeof record.id === "string" ? record.id : typeof record.url === "string" ? record.url : undefined;
		if (url === undefined) {
			continue;
		}
		const status = typeof record.status === "string" ? record.status.toLowerCase() : undefined;
		if (status === "success") {
			continue;
		}
		const errorRecord = asRecord(record.error);
		failures.set(url, {
			url: clampField(url, 2_048),
			...(typeof errorRecord?.httpStatusCode === "number" ? { status: errorRecord.httpStatusCode } : {}),
			...(typeof errorRecord?.tag === "string" ? { error: clampField(errorRecord.tag, 200) } : {}),
		});
	}
	return failures;
}

function normalize(payload: unknown): ResearchResponse {
	const envelope = asRecord(payload);
	if (envelope === undefined || !Array.isArray(envelope.results)) {
		return { results: [], failures: [] };
	}
	const failures = readStatuses(envelope);
	const results: ResearchResult[] = [];
	for (const entry of envelope.results.slice(0, MAX_RESULTS_PER_REQUEST)) {
		const record = asRecord(entry);
		if (record === undefined) {
			continue;
		}
		const url = usableUrl(record.url) ?? usableUrl(record.id);
		if (url === undefined) {
			continue;
		}
		if (failures.has(url) || (typeof record.id === "string" && failures.has(record.id))) {
			// The envelope listed this URL as failed: it is a diagnostic, not a source.
			continue;
		}
		results.push({
			title: usableTitle(record.title, url),
			url,
			...(usableDate(record.publishedDate) === undefined ? {} : { publishedDate: usableDate(record.publishedDate) }),
			...(boundedText(record) === undefined ? {} : { text: boundedText(record) }),
		});
	}
	return { results, failures: [...failures.values()].slice(0, MAX_CONTENTS_URLS) };
}

/** Transport options every Exa call shares. */
export interface ExaTransportOptions {
	/** Overridable origin; defaults to Exa's documented one. */
	baseUrl?: string;
	/** Per-request deadline. Omitted means the control plane's default. */
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

async function request(
	path: "search" | "contents",
	key: string,
	body: unknown,
	transport: ExaTransportOptions,
): Promise<ResearchResponse> {
	const response = await fetchBounded(
		`${transport.baseUrl ?? DEFAULT_EXA_BASE_URL}/${path}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		{ service: "Exa", timeoutMs: transport.timeoutMs, signal: transport.signal, fetch: transport.fetch },
	);
	// Status first: Exa's error envelopes vary, especially on 429.
	if (!response.ok) {
		throw new ResearchHttpError(response.status, "Exa");
	}
	return normalize(await response.json());
}

export interface ExaSearchOptions extends ExaTransportOptions {
	numResults?: number;
	/** At most 10,000, and clamped again on the way out. */
	maxCharacters?: number;
}

/**
 * Exa Search. Content options are **nested** under `contents`, and the highlight
 * bound travels with the request so the provider never returns more than the
 * cap allows.
 */
export async function exaSearch(query: string, key: string, options: ExaSearchOptions = {}): Promise<ResearchResult[]> {
	const maxCharacters = Math.max(1, Math.min(MAX_FIELD_CHARACTERS, options.maxCharacters ?? MAX_FIELD_CHARACTERS));
	const response = await request(
		"search",
		key,
		{
			query: clampField(query, MAX_FIELD_CHARACTERS),
			type: "auto",
			numResults: boundedCount(options.numResults, 5),
			contents: {
				highlights: { numSentences: 3, highlightsPerUrl: 2, maxCharacters },
			},
		},
		options,
	);
	return response.results;
}

export interface ExaContentsOptions extends ExaTransportOptions {
	maxCharacters?: number;
	/** Opt-in only: full text is never requested by default. */
	includeText?: boolean;
}

/**
 * Exa Contents. Content options are **top-level** here, at most ten URLs are
 * sent, and the response is inspected per URL: HTTP 200 can still carry
 * failures, so only URLs the provider says it fetched are citable.
 */
export async function exaContents(
	urls: readonly string[],
	key: string,
	options: ExaContentsOptions = {},
): Promise<ResearchResponse> {
	const maxCharacters = Math.max(1, Math.min(MAX_FIELD_CHARACTERS, options.maxCharacters ?? MAX_FIELD_CHARACTERS));
	const bounded = urls
		.map((url) => usableUrl(url))
		.filter((url): url is string => url !== undefined)
		.slice(0, MAX_CONTENTS_URLS);
	return request(
		"contents",
		key,
		{
			urls: bounded,
			highlights: { numSentences: 3, highlightsPerUrl: 2, maxCharacters },
			...(options.includeText === true ? { text: { maxCharacters } } : {}),
		},
		options,
	);
}
