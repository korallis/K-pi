import { ResearchHttpError, type ResearchResult } from "./exa.ts";

export async function perplexitySearch(
  query: string,
  key: string,
  options: { maxResults?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ResearchResult[]> {
  const maxResults = Math.max(1, Math.min(10, options.maxResults ?? 5));
  const response = await (options.fetch ?? fetch)("https://api.perplexity.ai/search", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query, max_results: maxResults, search_context_size: "high" }),
    signal: options.signal,
  });
  if (!response.ok) throw new ResearchHttpError(response.status, "Perplexity");
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !("results" in payload) || !Array.isArray(payload.results)) return [];
  return payload.results.slice(0, 10).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("url" in entry) || typeof entry.url !== "string") return [];
    const title = "title" in entry && typeof entry.title === "string" ? entry.title : entry.url;
    const text = "snippet" in entry && typeof entry.snippet === "string" ? entry.snippet.slice(0, 15_000) : undefined;
    const publishedDate = "date" in entry && typeof entry.date === "string" ? entry.date : undefined;
    return [{ title, url: entry.url, text, publishedDate }];
  });
}
