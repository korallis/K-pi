import type { UsageReading } from "./types.ts";

export type ResponseHeaders = Readonly<Record<string, string | undefined>>;

/**
 * Documented rate-limit header families, each a `limit`/`remaining`/`reset`
 * triple. Only headers a provider publishes in its own docs appear here:
 *
 * - Anthropic `anthropic-ratelimit-*` (requests, tokens, input, output, unified)
 * - OpenAI and Codex `x-ratelimit-*-requests` / `x-ratelimit-*-tokens`
 * - the IETF `RateLimit-*` draft, which xAI and z.ai emit
 * - the widely used generic `x-ratelimit-*`
 */
const LIMIT_FAMILIES: readonly { limit: string; remaining: string; reset: string }[] = [
	{
		limit: "anthropic-ratelimit-unified-limit",
		remaining: "anthropic-ratelimit-unified-remaining",
		reset: "anthropic-ratelimit-unified-reset",
	},
	{
		limit: "anthropic-ratelimit-requests-limit",
		remaining: "anthropic-ratelimit-requests-remaining",
		reset: "anthropic-ratelimit-requests-reset",
	},
	{
		limit: "anthropic-ratelimit-tokens-limit",
		remaining: "anthropic-ratelimit-tokens-remaining",
		reset: "anthropic-ratelimit-tokens-reset",
	},
	{
		limit: "anthropic-ratelimit-input-tokens-limit",
		remaining: "anthropic-ratelimit-input-tokens-remaining",
		reset: "anthropic-ratelimit-input-tokens-reset",
	},
	{
		limit: "anthropic-ratelimit-output-tokens-limit",
		remaining: "anthropic-ratelimit-output-tokens-remaining",
		reset: "anthropic-ratelimit-output-tokens-reset",
	},
	{
		limit: "x-ratelimit-limit-requests",
		remaining: "x-ratelimit-remaining-requests",
		reset: "x-ratelimit-reset-requests",
	},
	{
		limit: "x-ratelimit-limit-tokens",
		remaining: "x-ratelimit-remaining-tokens",
		reset: "x-ratelimit-reset-tokens",
	},
	{ limit: "ratelimit-limit", remaining: "ratelimit-remaining", reset: "ratelimit-reset" },
	{ limit: "x-ratelimit-limit", remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" },
];

/** Windows a provider states directly rather than as a reset instant. */
const WINDOW_HEADERS: readonly string[] = [
	"anthropic-ratelimit-unified-window",
	"x-ratelimit-window",
	"ratelimit-policy",
];

function headerValue(headers: ResponseHeaders, name: string): string | undefined {
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	return key === undefined ? undefined : headers[key];
}

/** A count such as `1200` or `4.5k`, as providers emit both. */
function parseCount(raw: string | undefined): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const match = /^\s*([\d.]+)\s*([km])?\s*$/iu.exec(raw);
	if (match === null) {
		return undefined;
	}
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) {
		return undefined;
	}
	const scale = match[2]?.toLowerCase() === "k" ? 1_000 : match[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
	return value * scale;
}

/**
 * A reset expressed as epoch seconds, epoch milliseconds, an RFC 3339 instant,
 * or a duration such as `1h30m0s` / `60s`, all of which appear in provider docs.
 */
function parseReset(raw: string | undefined, nowMs: number): number | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const duration = /^\s*(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?\s*$/iu.exec(raw);
	if (duration !== null && (duration[1] ?? duration[2] ?? duration[3]) !== undefined) {
		const hours = Number(duration[1] ?? 0);
		const minutes = Number(duration[2] ?? 0);
		const seconds = Number(duration[3] ?? 0);
		return nowMs + ((hours * 60 + minutes) * 60 + seconds) * 1_000;
	}
	const numeric = Number(raw);
	if (Number.isFinite(numeric)) {
		return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
	}
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The remaining percentage a response's own rate-limit headers state.
 *
 * When a provider publishes several limit families, the binding one wins: a slot
 * with 90% of its requests but 5% of its tokens left has 5% left. A family
 * without a usable limit and remaining pair is ignored rather than guessed at,
 * and headers carrying no family at all return undefined so the slot stays
 * unknown.
 */
export function readUsageHeaders(headers: ResponseHeaders, nowMs: number): UsageReading | undefined {
	let remainingPercent: number | undefined;
	let resetAt: number | undefined;

	for (const family of LIMIT_FAMILIES) {
		const limit = parseCount(headerValue(headers, family.limit));
		const remaining = parseCount(headerValue(headers, family.remaining));
		if (limit === undefined || remaining === undefined || limit <= 0) {
			continue;
		}
		const percent = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
		if (remainingPercent === undefined || percent < remainingPercent) {
			remainingPercent = percent;
			resetAt = parseReset(headerValue(headers, family.reset), nowMs);
		}
	}

	// `retry-after` states when the slot recovers even when no family is present.
	const retryAfter = parseReset(headerValue(headers, "retry-after"), nowMs);
	if (resetAt === undefined && retryAfter !== undefined) {
		resetAt = retryAfter;
	}

	const window = WINDOW_HEADERS.map((name) => headerValue(headers, name)).find(
		(value) => value !== undefined && value.length > 0,
	);

	if (remainingPercent === undefined && resetAt === undefined && window === undefined) {
		return undefined;
	}
	return { remainingPercent, resetAt, window };
}
