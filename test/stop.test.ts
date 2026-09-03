import assert from "node:assert/strict";
import test from "node:test";

import {
	canonicalFingerprint,
	classifyTransientFailure,
	createStopState,
	DEFAULT_RETRY_BASE_MS,
	failingAcSetKey,
	MAX_AUTOMATIC_REPLANS,
	RETRY_MAX_DELAY_MS,
	recordVerifier,
	repeatedWitness,
	retryDelayMs,
	stopFingerprint,
	type VerifierEvent,
} from "../packages/coding-agent/src/kpi/extensions/graph/stop.ts";

const fingerprint = (character: string): string => `sha256:${character.repeat(64)}`;

function review(evidence: string, output: string, failingAcIds?: readonly string[]): VerifierEvent {
	return {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint(evidence),
		outputFingerprint: fingerprint(output),
		...(failingAcIds === undefined ? {} : { failingAcIds }),
	};
}

test("a repeated output fingerprint is a repeated witness and a fresh one is not", () => {
	const fresh = createStopState();
	assert.equal(repeatedWitness(fresh, review("1", "a")), undefined, "nothing has been seen yet");

	const firstRound = recordVerifier(fresh, review("1", "a"));
	assert.equal(firstRound.round, 1);
	assert.deepEqual(firstRound.outputFingerprints, [fingerprint("a")]);

	// New evidence, the same review output: the witness is the output fingerprint.
	assert.equal(repeatedWitness(firstRound, review("2", "a")), fingerprint("a"));
	assert.equal(repeatedWitness(firstRound, review("2", "b")), undefined, "a fresh output is progress");

	// Recording the repeat moves the round but stores each witness once.
	const repeated = recordVerifier(firstRound, review("2", "a"));
	assert.equal(repeated.round, 2);
	assert.deepEqual(repeated.outputFingerprints, [fingerprint("a")]);
	assert.deepEqual(repeated.evidenceFingerprints, [fingerprint("1"), fingerprint("2")]);
	assert.equal("status" in repeated, false, "the reducer no longer decides a terminal");
});

test("the same failing acceptance set twice is a repeated witness even when the prose changes", () => {
	const first = recordVerifier(createStopState(), review("1", "a", ["AC-2", "AC-1"]));
	assert.deepEqual(first.failingAcSets, ["AC-1,AC-2"], "the set is canonical, so order cannot hide a repeat");

	// New evidence, new prose, entirely different output fingerprint - and the
	// same two criteria still failing, reordered and duplicated.
	assert.equal(repeatedWitness(first, review("2", "b", ["AC-1", "AC-2", "AC-1"])), "AC-1,AC-2");
});

test("a changed failing acceptance set continues", () => {
	const first = recordVerifier(createStopState(), review("1", "a", ["AC-1", "AC-2"]));
	const narrower = review("2", "b", ["AC-2"]);
	assert.equal(repeatedWitness(first, narrower), undefined, "fixing one criterion is progress");

	const second = recordVerifier(first, narrower);
	assert.equal(second.round, 2);
	assert.deepEqual(second.failingAcSets, ["AC-1,AC-2", "AC-2"]);
});

test("rounds are unbounded and a passing verifier is never a stop", () => {
	let state = createStopState();
	for (let index = 0; index < 50; index += 1) {
		// Every round repeats the same receipts under fresh prose over one failing set.
		state = recordVerifier(state, review("same-receipts", `prose-${index}`, ["AC-1"]));
	}
	assert.equal(state.round, 50);
	assert.equal("status" in state, false, "no counter in the reducer ends a run");
	assert.equal(state.evidenceFingerprints.length, 1, "one witness for one set of receipts");
	assert.equal(state.outputFingerprints.length, 50);
	assert.deepEqual(state.failingAcSets, ["AC-1"], "witness sets hold distinct entries only");

	const passed: VerifierEvent = {
		type: "verifier",
		passed: true,
		evidenceFingerprint: fingerprint("green"),
		outputFingerprint: fingerprint("approved"),
		failingAcIds: [],
	};
	assert.equal(repeatedWitness(state, passed), undefined);
	const done = recordVerifier(state, passed);
	assert.equal(done.round, 51, "a passing verifier is a round like any other");
	assert.deepEqual(done.failingAcSets, ["AC-1"], "a passed event adds no failing set");
	assert.deepEqual(done.repaired, [], "nothing here re-planned");
	assert.equal(done.repair, undefined);
});

test("identical evidence in consecutive failed test rounds is a repeated witness and a review round in between clears it", () => {
	const failedTest = (evidence: string): VerifierEvent => ({
		type: "verifier",
		source: "test",
		passed: false,
		evidenceFingerprint: fingerprint(evidence),
		failingAcIds: ["AC-1"],
	});

	const fresh = createStopState();
	assert.equal(repeatedWitness(fresh, failedTest("1")), undefined);

	const first = recordVerifier(fresh, failedTest("1"));
	assert.equal(first.round, 1, "a failed test round counts as a round");
	assert.equal(first.lastTestEvidence, fingerprint("1"));
	assert.deepEqual(first.evidenceFingerprints, [fingerprint("1")]);
	assert.deepEqual(first.failingAcSets, [], "a test round's failing ids are not a review witness");

	// The same evidence again, straight after: the implementer changed nothing
	// the tests can see.
	assert.equal(repeatedWitness(first, failedTest("1")), `evidence:${fingerprint("1")}`);
	assert.equal(repeatedWitness(first, failedTest("2")), undefined, "different receipts are progress");

	// A review round between two identical test evidences breaks the chain:
	// the repeats are no longer consecutive.
	const reviewed = recordVerifier(first, review("1", "a"));
	assert.equal(reviewed.round, 2);
	assert.equal(reviewed.lastTestEvidence, undefined, "a review round clears the test chain");
	assert.equal(repeatedWitness(reviewed, failedTest("1")), undefined);

	// A passing test round clears it as well: it is not a failed round.
	const greenBetween = recordVerifier(first, { ...failedTest("1"), passed: true });
	assert.equal(greenBetween.lastTestEvidence, undefined);
	assert.equal(repeatedWitness(greenBetween, failedTest("1")), undefined);

	// A review event must carry the output it is judged on.
	assert.throws(
		() => repeatedWitness(first, { type: "verifier", passed: false, evidenceFingerprint: fingerprint("x") }),
		/review verifier event needs an outputFingerprint/u,
	);
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

test("retry delays double from the base and stop growing at the ceiling", () => {
	assert.equal(DEFAULT_RETRY_BASE_MS, 1_000);
	assert.equal(RETRY_MAX_DELAY_MS, 60_000);
	assert.deepEqual(
		[0, 1, 2, 3, 4, 5, 6, 7].map((spent) => retryDelayMs(spent, 1_000)),
		[1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000],
	);
	assert.equal(retryDelayMs(0), 1_000, "the base defaults to one second");
	assert.equal(retryDelayMs(40), 60_000, "no jitter and no growth past the ceiling, however long it goes");
	assert.equal(MAX_AUTOMATIC_REPLANS, 2, "two automatic re-plans per operator touch");
});

test("the transition path canonicalizes fingerprints rather than trusting the caller's spelling", () => {
	const digest = `sha256:${"A".repeat(64)}`;
	const first = recordVerifier(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: digest,
	});

	assert.deepEqual(first.outputFingerprints, [`sha256:${"a".repeat(64)}`], "a digest is stored in one canonical case");

	// The same digest in different case and padding is the same output, so the
	// repeat is caught instead of buying another round.
	assert.equal(
		repeatedWitness(first, {
			type: "verifier",
			passed: false,
			evidenceFingerprint: fingerprint("2"),
			outputFingerprint: `  sha256:${"a".repeat(64)}  `,
		}),
		`sha256:${"a".repeat(64)}`,
	);

	// A caller holding the payload rather than a digest is hashed canonically by
	// the reducer, on the same terms.
	const fromPayload = recordVerifier(createStopState(), {
		type: "verifier",
		passed: false,
		evidenceFingerprint: fingerprint("1"),
		outputFingerprint: stopFingerprint({ approved: false, blocking: ["x"] }),
	});
	assert.deepEqual(fromPayload.outputFingerprints, [canonicalFingerprint({ blocking: ["x"], approved: false })]);
	assert.equal(stopFingerprint(digest), stopFingerprint(digest.toLowerCase()));

	// Test evidence is canonicalized the same way, so a resume compares like with like.
	const tested = recordVerifier(createStopState(), {
		type: "verifier",
		source: "test",
		passed: false,
		evidenceFingerprint: `  ${digest}  `,
	});
	assert.equal(tested.lastTestEvidence, `sha256:${"a".repeat(64)}`);
	assert.equal(
		repeatedWitness(tested, { type: "verifier", source: "test", passed: false, evidenceFingerprint: digest }),
		`evidence:sha256:${"a".repeat(64)}`,
	);
});

test("transient classification retries transport, http 408/429/5xx, and timeout", () => {
	assert.equal(classifyTransientFailure(Object.assign(new Error("rate limited"), { status: 429 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { statusCode: 429 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { status: 408 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("server error"), { status: 500 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("overloaded"), { status: 503 })), "http");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { statusCode: 599 })), "http");
	assert.equal(
		classifyTransientFailure(
			Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("bad gateway"), { status: 502 }) }),
		),
		"http",
		"a 5xx one level down is still a 5xx",
	);
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { code: "UND_ERR_BODY_TIMEOUT" })), "timeout");
	assert.equal(classifyTransientFailure(Object.assign(new Error("request timed out"), {})), "timeout");
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { code: "ECONNRESET" })), "transport");
	assert.equal(classifyTransientFailure(new Error("socket hang up")), "transport");
	assert.equal(classifyTransientFailure(new Error("fetch failed")), "transport");

	// Not transient: an operator decision, a defect, a refusal, or an unrecognized failure.
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
	assert.equal(classifyTransientFailure(Object.assign(new Error("unauthorized"), { status: 401 })), undefined);
	assert.equal(classifyTransientFailure(Object.assign(new Error("forbidden"), { status: 403 })), undefined);
	assert.equal(classifyTransientFailure(Object.assign(new Error("not found"), { status: 404 })), undefined);
	assert.equal(classifyTransientFailure(Object.assign(new Error("x"), { status: 600 })), undefined);
	assert.equal(classifyTransientFailure(new Error("failed response validation")), undefined);
	assert.equal(classifyTransientFailure("a string"), undefined);
	assert.equal(classifyTransientFailure(undefined), undefined);
});
