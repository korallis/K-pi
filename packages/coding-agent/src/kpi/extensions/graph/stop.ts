import { createHash } from "node:crypto";

/** First backoff step. Each further retry doubles it. */
export const DEFAULT_RETRY_BASE_MS = 1_000;

/** The backoff stops growing here. Retries themselves never stop. */
export const RETRY_MAX_DELAY_MS = 60_000;

/**
 * Automatic re-plans the driver may trigger for repeated witnesses before it
 * pauses for the operator. An operator touch (guidance, keep going) starts a
 * fresh allowance.
 */
export const MAX_AUTOMATIC_REPLANS = 2;

/**
 * The backoff before the retry that follows `spent` earlier retries: doubling
 * from the base, capped at the ceiling, no jitter. A 12th retry waits as long
 * as the 7th, and the run never ends because of it.
 */
export function retryDelayMs(spent: number, baseMs = DEFAULT_RETRY_BASE_MS): number {
	return Math.min(RETRY_MAX_DELAY_MS, baseMs * 2 ** spent);
}

/**
 * What the planner is told when a re-plan is the loop's answer to no progress:
 * the round it happened in, why, which criteria kept failing, where the
 * evidence is, the witness that repeated, and any guidance the operator gave.
 */
export interface PlanRepair {
	round: number;
	reason: string;
	failing_ac: string[];
	evidence_ref: "verdict.json" | "evidence.json";
	witness: string;
	guidance?: string;
}

export interface StopState {
	readonly round: number;
	readonly evidenceFingerprints: readonly string[];
	readonly outputFingerprints: readonly string[];
	/** Canonical failing-AC-id sets, one per review round that reported failures. */
	readonly failingAcSets: readonly string[];
	/**
	 * The evidence fingerprint of the last FAILED test round, cleared by any
	 * review round: identical evidence across consecutive failed test rounds is
	 * a witness even though review never ran.
	 */
	readonly lastTestEvidence?: string;
	/**
	 * Witnesses that triggered an automatic re-plan since the last operator
	 * touch. The same witness may appear twice; an operator touch resets it.
	 */
	readonly repaired: readonly string[];
	readonly repair?: PlanRepair;
}

export interface VerifierEvent {
	readonly type: "verifier";
	/** Which node produced the evidence. Defaults to the review verdict. */
	readonly source?: "review" | "test";
	readonly passed: boolean;
	readonly evidenceFingerprint: string;
	/** Required for a review event; a test round has no reviewer output. */
	readonly outputFingerprint?: string;
	/** Ids of the acceptance criteria that failed this round, in any order. */
	readonly failingAcIds?: readonly string[];
}

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
 * Classifies a thrown provider failure. A transport fault, an http 408/429/5xx,
 * or a timeout may be retried; a validation or contract failure is a defect
 * that retrying would only repeat, and anything unrecognized is treated as
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

	// A rate limit, a request timeout the server reports, or any server-side
	// failure is the provider's, not the run's: retried, never a new round.
	if (transientHttpStatus(shape.status) || transientHttpStatus(cause?.status)) {
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

/** 408 and 429 ask for a retry outright; every 5xx is the provider's failure. */
function transientHttpStatus(status: number | undefined): boolean {
	return status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

export function createStopState(): StopState {
	return {
		round: 0,
		evidenceFingerprints: [],
		outputFingerprints: [],
		failingAcSets: [],
		repaired: [],
	};
}

/**
 * The witnesses a verifier event carries, canonicalized so the reducer
 * compares and stores one form whatever a caller handed it: a reviewer's
 * normative digest stays itself, and a payload is hashed on sorted keys.
 */
function witnesses(event: VerifierEvent): {
	source: "review" | "test";
	evidence: string;
	output?: string;
	failingKey?: string;
} {
	const source = event.source ?? "review";
	if (source === "review" && event.outputFingerprint === undefined) {
		throw new TypeError("a review verifier event needs an outputFingerprint");
	}
	return {
		source,
		evidence: stopFingerprint(event.evidenceFingerprint),
		output: event.outputFingerprint === undefined ? undefined : stopFingerprint(event.outputFingerprint),
		failingKey: failingAcSetKey(event.failingAcIds ?? []),
	};
}

/**
 * The witness this event repeats, or undefined when it is progress.
 *
 * A review round repeats when its output fingerprint was seen before, or when
 * the same acceptance criteria fail again under different prose. A failed test
 * round repeats only when its evidence is identical to the previous failed test
 * round's — consecutive, because any review round in between clears the chain.
 * A repeat is never a stop here: the driver decides whether it re-plans or
 * pauses for the operator.
 */
export function repeatedWitness(state: StopState, event: VerifierEvent): string | undefined {
	const seen = witnesses(event);
	if (seen.source === "test") {
		return !event.passed && seen.evidence === state.lastTestEvidence ? `evidence:${seen.evidence}` : undefined;
	}
	if (seen.output !== undefined && state.outputFingerprints.includes(seen.output)) {
		return seen.output;
	}
	// The same acceptance criteria failing twice is no progress even when the
	// prose around them changed, so the fingerprint is not the only witness.
	return seen.failingKey !== undefined && state.failingAcSets.includes(seen.failingKey) ? seen.failingKey : undefined;
}

/**
 * Folds one verifier round into the state. Every event is a round: a review
 * verdict, or a FAILED test round (the driver does not record a passing test
 * round; its review round is). Witnesses are sets, so a repeat is already
 * recorded and re-appending it would only grow the state a resume carries.
 */
export function recordVerifier(state: StopState, event: VerifierEvent): StopState {
	const seen = witnesses(event);
	const evidenceFingerprints = state.evidenceFingerprints.includes(seen.evidence)
		? state.evidenceFingerprints
		: [...state.evidenceFingerprints, seen.evidence];
	const round = state.round + 1;

	if (seen.source === "test") {
		const { lastTestEvidence: _cleared, ...rest } = state;
		return {
			...rest,
			round,
			evidenceFingerprints,
			// Only a failed round extends the chain; a green round is not a failure.
			...(event.passed ? {} : { lastTestEvidence: seen.evidence }),
		};
	}

	const { lastTestEvidence: _cleared, ...rest } = state;
	const output = seen.output as string;
	return {
		...rest,
		round,
		evidenceFingerprints,
		outputFingerprints: state.outputFingerprints.includes(output)
			? state.outputFingerprints
			: [...state.outputFingerprints, output],
		failingAcSets:
			seen.failingKey === undefined || state.failingAcSets.includes(seen.failingKey)
				? state.failingAcSets
				: [...state.failingAcSets, seen.failingKey],
	};
}
