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

	const failingKey = failingAcSetKey(event.failingAcIds ?? []);
	const repeatedFailingSet = failingKey !== undefined && state.failingAcSets.includes(failingKey);
	const repeatedOutput = state.outputFingerprints.includes(event.outputFingerprint);

	if (state.evidenceFingerprints.includes(event.evidenceFingerprint)) {
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
		evidenceFingerprints: [...state.evidenceFingerprints, event.evidenceFingerprint],
		outputFingerprints: [...state.outputFingerprints, event.outputFingerprint],
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
