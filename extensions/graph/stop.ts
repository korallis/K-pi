export const DEFAULT_MAX_ROUNDS = 3;

export type TerminalStatus =
  | "DONE"
  | "BLOCKED"
  | "EXHAUSTED"
  | "NO_PROGRESS"
  | "UNSAFE"
  | "NEEDS_HUMAN";

export type StopStatus = "RUNNING" | TerminalStatus;

export interface StopState {
  readonly status: StopStatus;
  readonly round: number;
  readonly maxRounds: number;
  readonly evidenceFingerprints: readonly string[];
  readonly outputFingerprints: readonly string[];
}

export interface VerifierEvent {
  readonly type: "verifier";
  readonly passed: boolean;
  readonly evidenceFingerprint: string;
  readonly outputFingerprint: string;
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

export function createStopState(
  maxRounds = DEFAULT_MAX_ROUNDS,
): StopState {
  if (!Number.isInteger(maxRounds) || maxRounds <= 0) {
    throw new Error("maxRounds must be a positive integer");
  }

  return {
    status: "RUNNING",
    round: 0,
    maxRounds,
    evidenceFingerprints: [],
    outputFingerprints: [],
  };
}

export function transitionStopState(
  state: StopState,
  event: StopEvent,
): StopState {
  if (state.status !== "RUNNING" || event.type === "retry") {
    return state;
  }

  const repeatedOutput = state.outputFingerprints.includes(
    event.outputFingerprint,
  );
  if (state.evidenceFingerprints.includes(event.evidenceFingerprint)) {
    return repeatedOutput ? { ...state, status: "NO_PROGRESS" } : state;
  }

  const round = state.round + 1;
  const status: StopStatus = repeatedOutput
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
    evidenceFingerprints: [
      ...state.evidenceFingerprints,
      event.evidenceFingerprint,
    ],
    outputFingerprints: [...state.outputFingerprints, event.outputFingerprint],
  };
}
