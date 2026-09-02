import type { ResearchService } from "./session.ts";

/**
 * Where each research service is reached, and how long one request may take.
 *
 * The defaults are the vendors' own documented origins. They are overridable
 * because a service that can only ever be reached at a hard-coded public host
 * cannot be exercised, rehearsed, or contained: an operator running offline, a
 * grader proving the failure paths, and a self-hosted gateway all need to point
 * the same client somewhere else. Nothing here contacts anything - resolving an
 * endpoint is pure, so an offline run stays offline.
 */
export const DEFAULT_EXA_BASE_URL = "https://api.exa.ai";
export const DEFAULT_PERPLEXITY_BASE_URL = "https://api.perplexity.ai";

/**
 * A research request that has not answered by now is a failure, not a wait.
 *
 * Neither client set a deadline before, and neither vendor promises one, so a
 * silently hanging service could hold a planning node open indefinitely. The
 * bound is per request; the per-service attempt cap still governs how many
 * requests a job may make.
 */
export const DEFAULT_RESEARCH_TIMEOUT_MS = 15_000;

/** Bounds on an operator-supplied deadline. A zero timeout is not a deadline. */
export const MIN_RESEARCH_TIMEOUT_MS = 1_000;
export const MAX_RESEARCH_TIMEOUT_MS = 120_000;

export type ResearchEndpoints = Readonly<Record<ResearchService, string>>;

export const DEFAULT_RESEARCH_ENDPOINTS: ResearchEndpoints = {
	exa: DEFAULT_EXA_BASE_URL,
	perplexity: DEFAULT_PERPLEXITY_BASE_URL,
};

/** Environment fallbacks, named after each service's own key variable. */
export const RESEARCH_BASE_URL_ENV: Readonly<Record<ResearchService, string>> = {
	exa: "EXA_BASE_URL",
	perplexity: "PERPLEXITY_BASE_URL",
};

export class ResearchEndpointError extends Error {
	readonly service: ResearchService;
	readonly source: string;

	constructor(service: ResearchService, source: string, reason: string) {
		super(`${RESEARCH_BASE_URL_ENV[service]} from ${source} is not a usable base URL: ${reason}`);
		this.name = "ResearchEndpointError";
		this.service = service;
		this.source = source;
	}
}

/**
 * A base URL a research client may be pointed at: absolute, HTTP(S), no query,
 * no fragment, and no embedded credentials.
 *
 * Userinfo is refused rather than stripped. A URL carrying a password is a
 * credential in a settings file, and the one thing this function must never do
 * is accept it and then quote it back in an error message.
 */
export function assertResearchBaseUrl(value: string, service: ResearchService, source: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new ResearchEndpointError(service, source, "the value is empty");
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		// The raw value is never echoed: it may be the thing that is wrong with it.
		throw new ResearchEndpointError(service, source, "it is not an absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ResearchEndpointError(service, source, `the ${url.protocol.replace(":", "")} scheme is not supported`);
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new ResearchEndpointError(service, source, "it embeds credentials");
	}
	if (url.search.length > 0 || url.hash.length > 0) {
		throw new ResearchEndpointError(service, source, "a base URL carries no query or fragment");
	}
	if (url.hostname.length === 0) {
		throw new ResearchEndpointError(service, source, "it names no host");
	}
	// One trailing-slash form, so callers can always join with a leading slash.
	return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

export function assertResearchTimeoutMs(value: number, source: string): number {
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new Error(`Research timeout from ${source} must be an integer number of milliseconds`);
	}
	if (value < MIN_RESEARCH_TIMEOUT_MS || value > MAX_RESEARCH_TIMEOUT_MS) {
		throw new Error(
			`Research timeout from ${source} must be between ${MIN_RESEARCH_TIMEOUT_MS} and ${MAX_RESEARCH_TIMEOUT_MS} ms, received ${value}`,
		);
	}
	return value;
}

export interface ResearchEndpointOverrides {
	exa?: string;
	perplexity?: string;
	timeoutMs?: number;
}

/**
 * Settings win over the environment, exactly as a saved key beats `EXA_API_KEY`:
 * the operator wrote the settings file deliberately, and a stray variable on the
 * machine must never silently redirect a research call.
 */
export function resolveResearchEndpoints(
	overrides: ResearchEndpointOverrides = {},
	environment: NodeJS.ProcessEnv = process.env,
): { endpoints: ResearchEndpoints; timeoutMs: number } {
	const resolveOne = (service: ResearchService): string => {
		const configured = overrides[service];
		if (configured !== undefined && configured.trim().length > 0) {
			return assertResearchBaseUrl(configured, service, "settings");
		}
		const fromEnvironment = environment[RESEARCH_BASE_URL_ENV[service]];
		if (fromEnvironment !== undefined && fromEnvironment.trim().length > 0) {
			return assertResearchBaseUrl(fromEnvironment, service, "the environment");
		}
		return DEFAULT_RESEARCH_ENDPOINTS[service];
	};
	const timeoutFromEnvironment = environment.RESEARCH_TIMEOUT_MS;
	const timeoutMs =
		overrides.timeoutMs !== undefined
			? assertResearchTimeoutMs(overrides.timeoutMs, "settings")
			: timeoutFromEnvironment !== undefined && timeoutFromEnvironment.trim().length > 0
				? assertResearchTimeoutMs(Number(timeoutFromEnvironment), "the environment")
				: DEFAULT_RESEARCH_TIMEOUT_MS;
	return { endpoints: { exa: resolveOne("exa"), perplexity: resolveOne("perplexity") }, timeoutMs };
}

/**
 * A timed-out research request, raised as its own failure class.
 *
 * `name` is `TimeoutError` so the control plane's classifier records `timeout`
 * without depending on how a particular runtime words an abort: undici, an
 * injected fetch, and a polyfill all reject differently, and the recorded class
 * must not vary with the runtime.
 */
export class ResearchTimeoutError extends Error {
	readonly service: string;
	readonly timeoutMs: number;

	constructor(service: string, timeoutMs: number) {
		super(`${service} request timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
		this.service = service;
		this.timeoutMs = timeoutMs;
	}
}

export interface BoundedFetchOptions {
	service: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

/**
 * One research request, bounded.
 *
 * The deadline is ours and the caller's cancellation is theirs, so both are
 * armed and the reason they fire for is kept distinct: a deadline is a recorded
 * `timeout`, a caller abort stays an `abort`. The timer is always cleared, so a
 * fast answer does not keep the process alive for the rest of the window.
 */
export async function fetchBounded(url: string, init: RequestInit, options: BoundedFetchOptions): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS;
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), timeoutMs);
	// `unref` where the runtime offers it: a pending research deadline is not a
	// reason for the process to stay up.
	(timer as unknown as { unref?: () => void }).unref?.();
	const signals = options.signal === undefined ? [deadline.signal] : [deadline.signal, options.signal];
	try {
		return await (options.fetch ?? fetch)(url, { ...init, signal: AbortSignal.any(signals) });
	} catch (error) {
		if (deadline.signal.aborted && options.signal?.aborted !== true) {
			throw new ResearchTimeoutError(options.service, timeoutMs);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
