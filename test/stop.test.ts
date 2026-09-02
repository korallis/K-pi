import assert from "node:assert/strict";
import test from "node:test";

import { resolveGraphBudgetLimits } from "../packages/coding-agent/src/kpi/extensions/graph/budget.ts";
import type { GraphLimits } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import {
	canonicalFingerprint,
	classifyTransientFailure,
	createStopState,
	failingAcSetKey,
	MAX_TRANSIENT_RETRIES,
	planRetry,
	retryTransient,
	stopFingerprint,
	transitionStopState,
} from "../packages/coding-agent/src/kpi/extensions/graph/stop.ts";

const graphLimits: GraphLimits = {
	maxSteps: 24,
	maxNodeRuns: 16,
	maxConcurrency: 2,
	maxCostUsd: 5,
	timeoutMs: 1_800_000,
};

const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

test("a repeated output fingerprint stops with NO_PROGRESS", () => {
	const firstRound = transitionStopState(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
	});
	const repeated = transitionStopState(firstRound, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("2"),
		outputFingerprint: fingerprint("a"),
	});

	assert.equal(firstRound.status, "RUNNING");
	assert.equal(repeated.status, "NO_PROGRESS");
	assert.equal(repeated.round, 2);
});

test("a repeated output stops even without new verifier evidence", () => {
	const firstRound = transitionStopState(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
	});
	const repeated = transitionStopState(firstRound, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
	});

	assert.equal(repeated.status, "NO_PROGRESS");
	// The verifier ran again, so the round moved: a round key that stood still
	// would put the loop beyond the reach of `maxRounds`.
	assert.equal(repeated.round, 2);
});

test("the third failed round stops with EXHAUSTED by default", () => {
	let state = createStopState();
	for (const [index, character] of ["a", "b", "c"].entries()) {
		state = transitionStopState(state, {
			type: "verifier",
			passed: false,
			evidenceFingerprint: fingerprint(String(index + 1)),
			outputFingerprint: fingerprint(character),
		});
	}

	assert.equal(state.round, 3);
	assert.equal(state.maxRounds, 3);
	assert.equal(state.status, "EXHAUSTED");
});

test("a transient 429 retry does not increment the round", () => {
	const firstRound = transitionStopState(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
	});
	const retried = transitionStopState(firstRound, {
		type: "retry",
		reason: "http",
		status: 429,
	});

	assert.equal(retried.round, 1, "a retry is not a round");
	assert.equal(retried.status, "RUNNING");
	assert.equal(retried.retries, 1);
	assert.deepEqual(retried.evidenceFingerprints, firstRound.evidenceFingerprints);
});

test("a custom task maxRounds overrides the default before EXHAUSTED", () => {
	const limits = resolveGraphBudgetLimits(graphLimits, { maxRounds: 5 });
	assert.equal(limits.maxRounds, 5);

	let state = createStopState(limits.maxRounds);
	for (const [index, character] of ["a", "b", "c", "d"].entries()) {
		state = transitionStopState(state, {
			type: "verifier",
			passed: false,
			evidenceFingerprint: fingerprint(String(index + 1)),
			outputFingerprint: fingerprint(character),
		});
	}

	assert.equal(state.round, 4);
	assert.equal(state.status, "RUNNING", "the default cap must not stop a job that raised maxRounds");

	const exhausted = transitionStopState(state, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("5"),
		outputFingerprint: fingerprint("e"),
	});

	assert.equal(exhausted.round, 5);
	assert.equal(exhausted.maxRounds, 5);
	assert.equal(exhausted.status, "EXHAUSTED");
});

test("the default maxRounds still governs a job with no cap overrides", () => {
	assert.equal(resolveGraphBudgetLimits(graphLimits).maxRounds, 3);
	assert.equal(createStopState(resolveGraphBudgetLimits(graphLimits).maxRounds).maxRounds, 3);
});

test("the same failing acceptance set twice stops even when the prose changes", () => {
	const first = transitionStopState(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
		failingAcIds: ["AC-2", "AC-1"],
	});
	assert.equal(first.status, "RUNNING");
	assert.deepEqual(first.failingAcSets, ["AC-1,AC-2"], "the set is canonical, so order cannot hide a repeat");

	// New evidence, new prose, entirely different output fingerprint - and the
	// same two criteria still failing.
	const repeated = transitionStopState(first, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("2"),
		outputFingerprint: fingerprint("b"),
		failingAcIds: ["AC-1", "AC-2"],
	});

	assert.equal(repeated.status, "NO_PROGRESS");
	assert.equal(repeated.round, 2);
});

test("a changed failing acceptance set continues", () => {
	let state = transitionStopState(createStopState(5), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
		failingAcIds: ["AC-1", "AC-2"],
	});
	state = transitionStopState(state, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("2"),
		outputFingerprint: fingerprint("b"),
		failingAcIds: ["AC-2"],
	});

	assert.equal(state.status, "RUNNING", "fixing one criterion is progress");
	assert.equal(state.round, 2);
	assert.deepEqual(state.failingAcSets, ["AC-1,AC-2", "AC-2"]);
});

test("a canonical fingerprint ignores key order and nothing else", () => {
	assert.equal(
		canonicalFingerprint({ approved: false, blocking: ["a", "b"] }),
		canonicalFingerprint({ blocking: ["a", "b"], approved: false }),
		"a reordered payload is the same output",
	);
	assert.notEqual(
		canonicalFingerprint({ approved: false, blocking: ["a", "b"] }),
		canonicalFingerprint({ approved: false, blocking: ["b", "a"] }),
		"a reordered array is different content",
	);
	assert.notEqual(canonicalFingerprint({ approved: false }), canonicalFingerprint({ approved: true }));
	assert.match(canonicalFingerprint({}), /^sha256:[0-9a-f]{64}$/u);
});

test("a failing acceptance set is sorted, deduplicated, and empty means no set", () => {
	assert.equal(failingAcSetKey(["AC-3", "AC-1", "AC-3", "AC-2"]), "AC-1,AC-2,AC-3");
	assert.equal(failingAcSetKey([]), undefined, "nothing failing is not a repeatable failure");
	assert.equal(failingAcSetKey([""]), undefined);
});

test("two transient failures retry with increasing backoff and the third stops", async () => {
	const slept: number[] = [];
	const sleep = async (milliseconds: number): Promise<void> => {
		slept.push(milliseconds);
	};
	const timeout = { type: "retry", reason: "timeout" } as const;

	let state = transitionStopState(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
		failingAcIds: ["AC-1"],
	});
	const round = state.round;

	state = await retryTransient(state, timeout, sleep, 100);
	assert.equal(state.retries, 1);
	assert.equal(state.round, round, "a retry never advances the round");

	state = await retryTransient(state, timeout, sleep, 100);
	assert.equal(state.retries, 2);
	assert.equal(state.round, round);
	assert.equal(state.status, "RUNNING");

	assert.deepEqual(slept, [100, 200], "each retry waits twice as long as the last");
	assert.deepEqual(state.retryDelaysMs, [100, 200]);
	assert.equal(planRetry(state, 100), undefined, "the budget is spent");

	// The third transient failure is deterministic and does not sleep again.
	const stopped = await retryTransient(state, timeout, sleep, 100);
	assert.equal(stopped.status, "EXHAUSTED");
	assert.equal(stopped.round, round);
	assert.deepEqual(slept, [100, 200]);
	assert.equal(MAX_TRANSIENT_RETRIES, 2);
});

test("a new round restores the retry budget", async () => {
	const sleep = async (): Promise<void> => {};
	let state = createStopState(5);
	state = await retryTransient(state, { type: "retry", reason: "transport" }, sleep, 10);
	state = await retryTransient(state, { type: "retry", reason: "transport" }, sleep, 10);
	assert.equal(state.retries, 2);

	state = transitionStopState(state, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: fingerprint("a"),
		failingAcIds: ["AC-1"],
	});

	assert.equal(state.retries, 0, "the next round starts with its own retry budget");
	assert.equal(state.round, 1);
});

test("the transition path canonicalizes fingerprints rather than trusting the caller's spelling", () => {
	const digest = `sha256:${"A".repeat(64)}`;
	const first = transitionStopState(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: digest,
	});

	assert.deepEqual(first.outputFingerprints, [`sha256:${"a".repeat(64)}`], "a digest is stored in one canonical case");

	// The same digest in different case and padding is the same output, so the
	// repeat is caught instead of buying another round.
	const repeated = transitionStopState(first, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("2"),
		outputFingerprint: `  sha256:${"a".repeat(64)}  `,
	});
	assert.equal(repeated.status, "NO_PROGRESS");

	// A caller holding the payload rather than a digest is hashed canonically by
	// the reducer, on the same terms.
	const fromPayload = transitionStopState(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: stopFingerprint({ approved: false, blocking: ["x"] }),
	});
	assert.deepEqual(fromPayload.outputFingerprints, [canonicalFingerprint({ blocking: ["x"], approved: false })]);
	assert.equal(stopFingerprint(digest), stopFingerprint(digest.toLowerCase()));
});

test("transient classification retries only transport, 429, and timeout", () => {
	assert.equal(classifyTransientFailure(Object.assign(new Error("rate limited"), { status: 429 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { statusCode: 429 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { code: "UND_ERR_BODY_TIMEOUT" })), "timeout");
	assert.equal(classifyTransientFailure(Object.assign(new Error("request timed out"), {})), "timeout");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { code: "ECONNRESET" })), "transport");
	assert.equal(classifyTransientFailure(new Error("socket hang up")), "transport");
	assert.equal(classifyTransientFailure(new Error("fetch failed")), "transport");

	// Not transient: an operator decision, a defect, or an unrecognized failure.
	assert.equal(classifyTransientFailure(Object.assign(new Error("aborted"), { name: "AbortError" })), undefined);
	assert.equal(classifyTransientFailure(Object.assign(new Error("cancelled by operator"), {})), undefined);
	assert.equal(
		classifyTransientFailure(Object.assign(new Error("connection reset by peer"), { name: "AbortError" })),
		undefined,
		"an abort with no timeout evidence wins over a transport-shaped message",
	);

	// Explicit timeout evidence is read before the abort check, because a fetch
	// deadline normally arrives as an AbortError that says it was aborted.
	assert.equal(
		classifyTransientFailure(
			Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" }),
		),
		"timeout",
	);
	assert.equal(
		classifyTransientFailure(Object.assign(new Error("aborted"), { name: "AbortError", code: "ETIMEDOUT" })),
		"timeout",
	);
	assert.equal(
		classifyTransientFailure(
			Object.assign(new Error("This operation was aborted"), {
				name: "AbortError",
				cause: Object.assign(new Error("headers timeout"), { name: "TimeoutError" }),
			}),
		),
		"timeout",
		"a timeout delivered as an abort with a TimeoutError cause is still a timeout",
	);
	assert.equal(
		classifyTransientFailure(Object.assign(new Error("The user aborted a request"), { name: "AbortError" })),
		undefined,
		"a plain operator abort stays non-transient",
	);
	assert.equal(classifyTransientFailure(Object.assign(new Error("bad request"), { status: 400 })), undefined);
	assert.equal(classifyTransientFailure(Object.assign(new Error("server error"), { status: 500 })), undefined);
	assert.equal(classifyTransientFailure(new Error("failed response validation")), undefined);
	assert.equal(classifyTransientFailure("a string"), undefined);
	assert.equal(classifyTransientFailure(undefined), undefined);
});

test("repeated evidence with changing output still ends at maxRounds", () => {
	// The verifier keeps rewriting its prose over the same receipts. Nothing is
	// no-progress by fingerprint, but the loop is not learning anything either, so
	// it must reach a terminal instead of running forever.
	let state = createStopState(3);
	const statuses: string[] = [];
	for (let index = 0; index < 3; index += 1) {
		state = transitionStopState(state, {
			type: "verifier",
			passed: false,
			evidenceFingerprint: fingerprint("same-receipts"),
			outputFingerprint: fingerprint(`prose-${index}`),
			failingAcIds: [`AC-${index}`],
		});
		statuses.push(state.status);
	}

	assert.deepEqual(statuses, ["RUNNING", "RUNNING", "EXHAUSTED"], "each verifier event is a round");
	assert.equal(state.round, 3);
	assert.equal(state.evidenceFingerprints.length, 1, "one witness for one set of receipts");
	assert.equal(state.outputFingerprints.length, 3);
});

test("a terminal state is final: further verifier events cannot revive it", () => {
	let state = createStopState(1);
	state = transitionStopState(state, {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("e1"),
		outputFingerprint: fingerprint("o1"),
	});
	assert.equal(state.status, "EXHAUSTED");
	const after = transitionStopState(state, {
		type: "verifier",
		passed: true,
		evidenceFingerprint: fingerprint("e2"),
		outputFingerprint: fingerprint("o2"),
	});
	assert.strictEqual(after, state, "an exhausted run cannot be talked into DONE");
});
