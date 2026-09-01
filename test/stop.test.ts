import assert from "node:assert/strict";
import test from "node:test";

import { resolveGraphBudgetLimits } from "../packages/coding-agent/src/kpi/extensions/graph/budget.ts";
import type { GraphLimits } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { createStopState, transitionStopState } from "../packages/coding-agent/src/kpi/extensions/graph/stop.ts";

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
	assert.equal(repeated.round, 1);
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

	assert.strictEqual(retried, firstRound);
	assert.equal(retried.round, 1);
	assert.equal(retried.status, "RUNNING");
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
