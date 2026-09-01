const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const QUOTA_TOKENS = /usage[ _-]?limit|rate[ _-]?limit|quota/iu;

/** What the global response hook carries: a status and headers, never a body. */
export interface ProviderFailure {
	status: number;
	headers?: Record<string, string | undefined>;
}

/**
 * A failure observed inside a fetch client K-π owns, which may safely consume
 * the response body it already read.
 */
export interface ProviderBodyFailure extends ProviderFailure {
	body?: string;
}

export interface CooldownClassification {
	kind: "cooldown";
	until: number;
	reason: string;
}

function header(headers: ProviderFailure["headers"], name: string): string | undefined {
	if (headers === undefined) return undefined;
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	return key === undefined ? undefined : headers[key];
}

function parsedReset(failure: ProviderFailure, now: number): number | undefined {
	const retryAfter = header(failure.headers, "retry-after");
	if (retryAfter !== undefined) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
		const timestamp = Date.parse(retryAfter);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	for (const name of ["x-ratelimit-reset", "x-rate-limit-reset", "anthropic-ratelimit-unified-reset"]) {
		const value = header(failure.headers, name);
		if (value === undefined) continue;
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
		const timestamp = Date.parse(value);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	return undefined;
}

function classify(
	failure: ProviderBodyFailure,
	quotaText: string,
	now: number,
): CooldownClassification | undefined {
	const quotaShaped = failure.status === 403 && QUOTA_TOKENS.test(quotaText);
	if (failure.status !== 429 && failure.status !== 402 && !quotaShaped) return undefined;
	return {
		kind: "cooldown",
		until: parsedReset(failure, now) ?? now + DEFAULT_COOLDOWN_MS,
		reason: `provider response ${failure.status}`,
	};
}

/**
 * The global classification: status and headers only. The `after_provider_response`
 * hook must never depend on a body it would have to consume, because consuming
 * it would take the stream away from the agent that is about to read it.
 */
export function classifyProviderFailure(
	failure: ProviderFailure,
	now = Date.now(),
): CooldownClassification | undefined {
	return classify(failure, Object.values(failure.headers ?? {}).filter(Boolean).join(" "), now);
}

/**
 * The same rules plus body tokens, for a fetch client K-π owns and whose body it
 * has already safely read. Never reachable from the global hook.
 */
export function classifyProviderBodyFailure(
	failure: ProviderBodyFailure,
	now = Date.now(),
): CooldownClassification | undefined {
	return classify(failure, [failure.body, ...Object.values(failure.headers ?? {})].filter(Boolean).join(" "), now);
}

export { DEFAULT_COOLDOWN_MS };
