export interface ResearchResult {
	title: string;
	url: string;
	publishedDate?: string;
	text?: string;
}

export class ResearchHttpError extends Error {
	readonly status: number;
	constructor(status: number, service: string) {
		super(`${service} request failed: ${status}`);
		this.status = status;
	}
}

function capped(value: number | undefined): number {
	return Math.max(1, Math.min(10, value ?? 5));
}

function normalize(value: unknown): ResearchResult[] {
	if (typeof value !== "object" || value === null || !("results" in value) || !Array.isArray(value.results)) return [];
	const entries = value.results;
	return entries.slice(0, 10).flatMap((entry) => {
		if (typeof entry !== "object" || entry === null || !("url" in entry) || typeof entry.url !== "string") return [];
		const record = entry;
		const rawHighlights: unknown = "highlights" in record ? record.highlights : undefined;
		const highlights = Array.isArray(rawHighlights)
			? rawHighlights.filter((item: unknown): item is string => typeof item === "string").join("\n")
			: undefined;
		return [
			{
				title: typeof record.title === "string" ? record.title : record.url,
				url: record.url,
				publishedDate: typeof record.publishedDate === "string" ? record.publishedDate : undefined,
				text: highlights?.slice(0, 15_000),
			},
		];
	});
}

async function request(
	path: string,
	key: string,
	body: unknown,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ResearchResult[]> {
	const response = await fetchImpl(`https://api.exa.ai/${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) throw new ResearchHttpError(response.status, "Exa");
	return normalize(await response.json());
}

export function exaSearch(
	query: string,
	key: string,
	options: { numResults?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ResearchResult[]> {
	return request(
		"search",
		key,
		{
			query,
			type: "auto",
			numResults: capped(options.numResults),
			contents: { highlights: true },
		},
		options.signal,
		options.fetch,
	);
}

export function exaContents(
	urls: readonly string[],
	key: string,
	options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ResearchResult[]> {
	return request("contents", key, { urls: urls.slice(0, 10), highlights: true }, options.signal, options.fetch);
}
