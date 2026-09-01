#!/usr/bin/env node

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGrokReview, unionGrokFindings } from "./validate-grok-review.mjs";

const changedPaths = ["src/review.ts", ".github/workflows/grok-review.yml"];
const validFinding = {
	id: "grok-missing-fail-closed",
	severity: "P1",
	path: "src/review.ts",
	line: 42,
	title: "Malformed output passes the gate",
	body: "Reject non-array JSON before deriving the finding count.",
};

test("accepts an empty review", () => {
	assert.deepEqual(normalizeGrokReview("[]\n", changedPaths), []);
});

test("normalizes a fenced finding document", () => {
	assert.deepEqual(normalizeGrokReview(`\`\`\`json\n${JSON.stringify([validFinding])}\n\`\`\``, changedPaths), [validFinding]);
});

test("rejects valid JSON that is not an array", () => {
	assert.throws(() => normalizeGrokReview("null", changedPaths), /must be a JSON array/);
	assert.throws(() => normalizeGrokReview("{}", changedPaths), /must be a JSON array/);
});

test("rejects prose around the JSON document", () => {
	assert.throws(() => normalizeGrokReview(`Findings:\n${JSON.stringify([validFinding])}`, changedPaths), /not one JSON document/);
});

test("requires the exact finding fields", () => {
	assert.throws(
		() => normalizeGrokReview(JSON.stringify([{ ...validFinding, suggestion: "extra" }]), changedPaths),
		/must contain exactly/,
	);
});

test("requires unique stable finding ids", () => {
	assert.throws(() => normalizeGrokReview(JSON.stringify([{ ...validFinding, id: "unstable" }]), changedPaths), /must match/);
	assert.throws(
		() => normalizeGrokReview(JSON.stringify([validFinding, validFinding]), changedPaths),
		/duplicates grok-missing-fail-closed/,
	);
});

test("accepts only blocking severities and changed paths", () => {
	assert.throws(
		() => normalizeGrokReview(JSON.stringify([{ ...validFinding, severity: "P3" }]), changedPaths),
		/must be P0, P1, or P2/,
	);
	assert.throws(
		() => normalizeGrokReview(JSON.stringify([{ ...validFinding, path: "unchanged.ts" }]), changedPaths),
		/not a changed path/,
	);
});

test("requires a positive new-file line or null", () => {
	assert.throws(() => normalizeGrokReview(JSON.stringify([{ ...validFinding, line: 0 }]), changedPaths), /positive integer/);
	assert.deepEqual(normalizeGrokReview(JSON.stringify([{ ...validFinding, line: null }]), changedPaths)[0].line, null);
});

test("bounds the number of findings", () => {
	const findings = Array.from({ length: 21 }, (_, index) => ({
		...validFinding,
		id: `grok-finding-${index + 1}`,
	}));
	assert.throws(() => normalizeGrokReview(JSON.stringify(findings), changedPaths), /exceeds 20 findings/);
});

test("unions chunk findings with stable severity ordering", () => {
	const p2 = { ...validFinding, id: "grok-later", severity: "P2", path: "src/review.ts" };
	const p0 = { ...validFinding, id: "grok-first", severity: "P0", path: ".github/workflows/grok-review.yml" };
	const merged = unionGrokFindings([[p2], [p0]]);
	assert.deepEqual(
		merged.map((row) => row.id),
		["grok-first", "grok-later"],
	);
});

test("union rejects conflicting duplicate ids", () => {
	assert.throws(
		() =>
			unionGrokFindings([
				[validFinding],
				[{ ...validFinding, title: "Different title" }],
			]),
		/conflicting findings/,
	);
});

