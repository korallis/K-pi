import { createHash } from "node:crypto";

export const DEFAULT_MAX_ROUNDS = 3;

/** Transient transport failures retried inside one round, never as a new round. */
export const MAX_TRANSIENT_RETRIES = 2;

/** First backoff step. Each further retry doubles it. */
export const DEFAULT_RETRY_BASE_MS = 1_000;

export type TerminalStatus = "DONE" | "BLOCKED" | "EXHAUSTED" | "NO_PROGRESS" | "UNSAFE" | "NEEDS_HUMAN";

export type StopStatus = "RUNNING" | TerminalStatus;

export interface StopState {
	readonly status: StopStatus;
	readonly round: number;
	readonly maxRounds: number;
	readonly evidenceFingerprints: readonly string[];
	readonly outputFingerprints: readonly string[];
	/** Canonical failing-AC-id sets, one per round that reported failures. */
	readonly failingAcSets: readonly string[];
	/** Transient retries already spent in the current round. */
	readonly retries: number;
	/** The backoff actually applied, in order. */
	readonly retryDelaysMs: readonly number[];
}

export interface VerifierEvent {
	readonly type: "verifier";
	readonly passed: boolean;
	readonly evidenceFingerprint: string;
	readonly outputFingerprint: string;
	/** Ids of the acceptance criteria that failed this round, in any order. */
	readonly failingAcIds?: readonly string[];
}

export type RetryEvent =
	| {
			readonly type: "retry";
			readonly reason: "http";
			readonly status: 429;
	  }
	| {
			readonly type: "retry";
			readonly reason: "timeout" | "transport";
	  };

export type StopEvent = VerifierEvent | RetryEvent;

/** Sleeps the injected backoff. Tests record the delays instead of waiting. */
export type Sleeper = (milliseconds: number) => Promise<void>;

function canonicalize(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("A fingerprint cannot cover a non-finite number");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(String(value));
}

/**
 * A fingerprint of an output's meaning, not its spelling: keys are sorted, so
 * a reordered payload hashes the same and only real content changes move it.
 */
export function canonicalFingerprint(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

/**
 * The canonical form of a failing-AC-id set: sorted and deduplicated, so the
 * same failures recorded in a different order are the same set. An empty set
 * has no canonical form, because "nothing failed" is not a repeatable failure.
 */
export function failingAcSetKey(ids: readonly string[]): string | undefined {
	const unique = [...new Set(ids)].filter((id) => id.length > 0).sort();
	return unique.length === 0 ? undefined : unique.join(",");
}

const DIGEST_PATTERN = /^sha256:[0-9a-fA-F]{64}$/u;

/**
 * The canonical form of a fingerprint the reducer compares and stores. A
 * reviewer supplies the normative `sha256:…` digest, which is normalized rather
 * than re-hashed so a persisted comparison survives a resume; anything else —
 * a payload, a prose blob — is hashed canonically so the two sources can never
 * be compared on different terms.
 */
export function stopFingerprint(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return DIGEST_PATTERN.test(trimmed) ? `sha256:${trimmed.slice(7).toLowerCase()}` : canonicalFingerprint(trimmed);
	}
	return canonicalFingerprint(value);
}

/** Why a failure may be retried inside the same round. */
export type TransientReason = "http" | "timeout" | "transport";

const ABORT_CODES: Record<string, true> = { ABORT_ERR: true, ERR_CANCELED: true };
const TIMEOUT_CODES: Record<string, true> = {
	ETIMEDOUT: true,
	ESERVFAIL: true,
	UND_ERR_CONNECT_TIMEOUT: true,
	UND_ERR_HEADERS_TIMEOUT: true,
	UND_ERR_BODY_TIMEOUT: true,
};
const TRANSPORT_CODES: Record<string, true> = {
	ECONNABORTED: true,
	ECONNREFUSED: true,
	ECONNRESET: true,
	EAI_AGAIN: true,
	EHOSTUNREACH: true,
	ENETDOWN: true,
	ENETRESET: true,
	ENETUNREACH: true,
	ENOTFOUND: true,
	EPIPE: true,
	UND_ERR_SOCKET: true,
};

/** The operator's, or the run's, own decision to stop. */
function statesAbort(shape: FailureShape): boolean {
	return (
		shape.name === "AbortError" ||
		ABORT_CODES[shape.code] === true ||
		/\babort(?:ed)?\b|\bcancell?ed\b/iu.test(shape.message)
	);
}

/**
 * Classifies a thrown provider failure. Only a transport fault, a 429, or a
 * timeout may be retried; an operator abort is a decision, and a validation or
 * contract failure is a defect that retrying would only repeat. Anything
 * unrecognized is treated as non-transient, so a retry is never the default.
 */
interface FailureShape {
	name: string;
	code: string;
	message: string;
	status?: number;
}

function failureShape(error: unknown): FailureShape | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	const candidate = error as {
		name?: unknown;
		code?: unknown;
		status?: unknown;
		statusCode?: unknown;
		message?: unknown;
	};
	const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
	return {
		name: typeof candidate.name === "string" ? candidate.name : "",
		code: typeof candidate.code === "string" ? candidate.code : "",
		message: typeof candidate.message === "string" ? candidate.message : "",
		status: typeof status === "number" ? status : undefined,
	};
}

/** A deadline the transport itself reports, whatever else the error also says. */
function statesTimeout(shape: FailureShape): boolean {
	return (
		shape.name === "TimeoutError" ||
		TIMEOUT_CODES[shape.code] === true ||
		/\btimed?\s?out\b|\btimeout\b/iu.test(shape.message)
	);
}

/**
 * Classifies a thrown provider failure. Only a transport fault, a 429, or a
 * timeout may be retried; a validation or contract failure is a defect that
 * retrying would only repeat, and anything unrecognized is treated as
 * non-transient so a retry is never the default.
 *
 * Explicit timeout evidence is read before the abort check, and one level of
 * `cause` is inspected, because a fetch deadline is normally delivered as an
 * `AbortError` whose message says it was aborted. A plain operator abort — one
 * with no timeout evidence anywhere — stays non-transient.
 */
export function classifyTransientFailure(error: unknown): TransientReason | undefined {
	const shape = failureShape(error);
	if (shape === undefined) {
		return undefined;
	}
	const cause = failureShape((error as { cause?: unknown }).cause);
	if (statesTimeout(shape) || (cause !== undefined && statesTimeout(cause))) {
		return "timeout";
	}

	// Otherwise an abort is the operator's, or the run's, own decision. Checked
	// before transport because an aborted request also looks like a socket fault,
	// and one level down as well: a wrapped cancellation is still a cancellation.
	if (statesAbort(shape) || (cause !== undefined && statesAbort(cause))) {
		return undefined;
	}

	if (shape.status === 429 || cause?.status === 429) {
		return "http";
	}
	if (
		TRANSPORT_CODES[shape.code] === true ||
		(cause !== undefined && TRANSPORT_CODES[cause.code] === true) ||
		/socket hang up|fetch failed|network error|connection reset/iu.test(shape.message)
	) {
		return "transport";
	}
	return undefined;
}

export function createStopState(maxRounds = DEFAULT_MAX_ROUNDS): StopState {
	if (!Number.isInteger(maxRounds) || maxRounds <= 0) {
		throw new Error("maxRounds must be a positive integer");
	}

	return {
		status: "RUNNING",
		round: 0,
		maxRounds,
		evidenceFingerprints: [],
		outputFingerprints: [],
		failingAcSets: [],
		retries: 0,
		retryDelaysMs: [],
	};
}

export interface RetryPlan {
	/** 1 for the first retry of this round. */
	attempt: number;
	delayMs: number;
}

/**
 * The next backoff step, or undefined once this round's retries are spent. A
 * retry is not a round, so the round key never moves.
 */
export function planRetry(state: StopState, baseDelayMs = DEFAULT_RETRY_BASE_MS): RetryPlan | undefined {
	if (state.status !== "RUNNING" || state.retries >= MAX_TRANSIENT_RETRIES) {
		return undefined;
	}
	const attempt = state.retries + 1;
	return { attempt, delayMs: baseDelayMs * 2 ** state.retries };
}

export function transitionStopState(state: StopState, event: StopEvent): StopState {
	if (state.status !== "RUNNING") {
		return state;
	}

	if (event.type === "retry") {
		const plan = planRetry(state);
		if (plan === undefined) {
			// Two retries already spent in this round: stop deterministically
			// instead of retrying a third time or silently continuing.
			return { ...state, status: "EXHAUSTED" };
		}
		return {
			...state,
			retries: plan.attempt,
			retryDelaysMs: [...state.retryDelaysMs, plan.delayMs],
		};
	}

	// Both fingerprints are canonicalized here, so the reducer compares and
	// stores one form whatever a caller handed it: a reviewer's normative digest
	// stays itself, and a payload is hashed on sorted keys.
	const outputFingerprint = stopFingerprint(event.outputFingerprint);
	const evidenceFingerprint = stopFingerprint(event.evidenceFingerprint);
	const failingKey = failingAcSetKey(event.failingAcIds ?? []);
	const repeatedFailingSet = failingKey !== undefined && state.failingAcSets.includes(failingKey);
	const repeatedOutput = state.outputFingerprints.includes(outputFingerprint);

	if (state.evidenceFingerprints.includes(evidenceFingerprint)) {
		// Nothing new was verified. Only a repeat of what already failed proves
		// the loop is stuck.
		return repeatedOutput || repeatedFailingSet ? { ...state, status: "NO_PROGRESS" } : state;
	}

	const round = state.round + 1;
	// The same acceptance criteria failing twice is no progress even when the
	// prose around them changed, so the fingerprint is not the only witness.
	const status: StopStatus =
		repeatedOutput || repeatedFailingSet
			? "NO_PROGRESS"
			: event.passed
				? "DONE"
				: round >= state.maxRounds
					? "EXHAUSTED"
					: "RUNNING";

	return {
		...state,
		status,
		round,
		evidenceFingerprints: [...state.evidenceFingerprints, evidenceFingerprint],
		outputFingerprints: [...state.outputFingerprints, outputFingerprint],
		failingAcSets: failingKey === undefined ? state.failingAcSets : [...state.failingAcSets, failingKey],
		// A new round starts with a fresh retry budget.
		retries: 0,
	};
}

/**
 * Applies one transient failure: waits the planned backoff through the injected
 * sleeper, then folds the retry into the state. The round never changes, and
 * the third transient failure in a round stops without sleeping again.
 */
export async function retryTransient(
	state: StopState,
	event: RetryEvent,
	sleep: Sleeper,
	baseDelayMs = DEFAULT_RETRY_BASE_MS,
): Promise<StopState> {
	const plan = planRetry(state, baseDelayMs);
	if (plan === undefined) {
		return transitionStopState(state, event);
	}
	await sleep(plan.delayMs);
	return {
		...state,
		retries: plan.attempt,
		retryDelaysMs: [...state.retryDelaysMs, plan.delayMs],
	};
}
