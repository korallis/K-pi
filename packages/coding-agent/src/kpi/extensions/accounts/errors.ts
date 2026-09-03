const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const QUOTA_TOKENS = /usage[ _-]?limit|rate[ _-]?limit|extra[ _-]?usage|quota/iu;
/**
 * Anthropic's refusal of an OAuth request whose Claude Code identity is below
 * the floor it enforces; the versions are read from the message and the error
 * code alone still counts as the rejection.
 */
const CLIENT_VERSION_REJECTION =
	/Claude Code (\d+\.\d+\.\d+) does not support this model; version (\d+\.\d+\.\d+) or newer is required/u;
const CLIENT_VERSION_ERROR_CODE = "claude_code_version_too_old";
/** The longest plain reason a refresh failure may put in front of the operator. */
const REFRESH_SUMMARY_LIMIT = 160;

/**
 * A `claude_code_version_too_old` refusal. `sent` is the Claude Code version
 * K-π identified as and `required` the floor Anthropic named; either is absent
 * when the body carried only the error code.
 */
export function parseClientVersionRejection(
	text: string | undefined,
): { sent?: string; required?: string } | undefined {
	if (text === undefined) return undefined;
	const match = CLIENT_VERSION_REJECTION.exec(text);
	if (match === null && !text.includes(CLIENT_VERSION_ERROR_CODE)) return undefined;
	return { sent: match?.[1], required: match?.[2] };
}

/**
 * Why an OAuth refresh failed, reduced to the one fact that decides what K-π
 * does next: a revoked grant needs a login, anything else is transient.
 */
export type RefreshFailure =
	| { kind: "invalid_grant" }
	| { kind: "http"; status: number; summary: string }
	| { kind: "transport"; summary: string };

/**
 * The provider's refresh error carries its cause text and a `stack=` frame
 * list; the summary keeps the first line before either, bounded, so a stack
 * frame can never reach a notification.
 */
export function summarizeRefreshFailure(error: unknown): RefreshFailure {
	const message = error instanceof Error ? error.message : String(error);
	if (/invalid_grant/u.test(message)) return { kind: "invalid_grant" };
	const summary = message.split(/; stack=|\n/u)[0].slice(0, REFRESH_SUMMARY_LIMIT);
	const status = /status=(\d{3})/u.exec(message);
	if (status !== null) return { kind: "http", status: Number(status[1]), summary };
	return { kind: "transport", summary };
}

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
	allowQuotaBadRequest = false,
): CooldownClassification | undefined {
	const quotaShaped =
		(failure.status === 403 || (allowQuotaBadRequest && failure.status === 400)) && QUOTA_TOKENS.test(quotaText);
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
	return classify(
		failure,
		Object.values(failure.headers ?? {})
			.filter(Boolean)
			.join(" "),
		now,
	);
}

/**
 * The same rules plus body tokens, for a fetch client K-π owns or an assistant
 * error message emitted after the provider stream has already been consumed.
 */
export function classifyProviderBodyFailure(
	failure: ProviderBodyFailure,
	now = Date.now(),
): CooldownClassification | undefined {
	return classify(
		failure,
		[failure.body, ...Object.values(failure.headers ?? {})].filter(Boolean).join(" "),
		now,
		true,
	);
}

export { DEFAULT_COOLDOWN_MS };
