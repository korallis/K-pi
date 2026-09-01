#!/usr/bin/env node

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	adaptiveUnionCap,
	findingContentKey,
	normalizeFindingId,
	normalizeGrokReview,
	unionGrokFindings,
} from "./validate-grok-review.mjs";


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
	assert.equal(normalizeGrokReview(JSON.stringify([{ ...validFinding, id: "unstable" }]), changedPaths)[0].id, "grok-unstable");
	assert.throws(() => normalizeGrokReview(JSON.stringify([{ ...validFinding, id: "!!!" }]), changedPaths), /must match|empty grok slug/);
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

test("bounds the number of findings per document", () => {
	const findings = Array.from({ length: 21 }, (_, index) => ({
		...validFinding,
		id: `grok-finding-${index + 1}`,
	}));
	assert.throws(() => normalizeGrokReview(JSON.stringify(findings), changedPaths), /exceeds 20 findings/);
});

test("normalizes drifted finding ids into grok kebab slugs", () => {
	assert.equal(normalizeFindingId("Grok_Missing_Timeout"), "grok-missing-timeout");
	assert.equal(normalizeFindingId("missing-timeout"), "grok-missing-timeout");
	assert.equal(normalizeFindingId("grok.token.leak"), "grok-token-leak");
	assert.throws(() => normalizeFindingId("!!!"), /must match|empty grok slug/);
});

test("accepts underscore ids after normalize in the document path", () => {
	const raw = JSON.stringify([
		{
			...validFinding,
			id: "Grok_Missing_Fail_Closed",
		},
	]);
	assert.equal(normalizeGrokReview(raw, changedPaths)[0].id, "grok-missing-fail-closed");
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

test("adaptive union cap is min(200, max(20, chunkCount*10))", () => {
	assert.equal(adaptiveUnionCap(0), 20);
	assert.equal(adaptiveUnionCap(1), 20);
	assert.equal(adaptiveUnionCap(2), 20);
	assert.equal(adaptiveUnionCap(3), 30);
	assert.equal(adaptiveUnionCap(18), 180);
	assert.equal(adaptiveUnionCap(25), 200);
	assert.equal(adaptiveUnionCap(1000), 200);
	assert.throws(() => adaptiveUnionCap(-1), /non-negative/);
});

test("union collapses path+line+substantive duplicates across ids", () => {
	const a = {
		...validFinding,
		id: "grok-dup-a",
		severity: "P2",
		title: "Same defect",
		body: "Whitespace   does   not matter.",
	};
	const b = {
		...validFinding,
		id: "grok-dup-b",
		severity: "P1",
		title: "Same defect",
		body: "Whitespace does not matter.",
	};
	assert.equal(findingContentKey(a), findingContentKey(b));
	const merged = unionGrokFindings([[a], [b]], { chunkCount: 2 });
	assert.equal(merged.length, 1);
	assert.equal(merged[0].severity, "P1");
	assert.equal(merged[0].id, "grok-dup-b");
});

test("union applies adaptive hard cap only after validation and dedupe", () => {
	const chunks = Array.from({ length: 3 }, (_, chunkIndex) =>
		Array.from({ length: 12 }, (_, findingIndex) => ({
			...validFinding,
			id: `grok-c${chunkIndex}-f${findingIndex}`,
			title: `Defect ${chunkIndex}-${findingIndex}`,
			body: `Body ${chunkIndex}-${findingIndex}`,
			line: findingIndex + 1,
		})),
	);
	// 36 unique findings; cap for 3 chunks is 30 → overflow with full list on error.
	assert.throws(
		() => unionGrokFindings(chunks, { chunkCount: 3 }),
		(error) => {
			assert.match(error.message, /adaptive cap 30/);
			assert.equal(error.code, "union-overflow");
			assert.equal(error.overflow, true);
			assert.equal(error.findings.length, 36);
			return true;
		},
	);

	// Dedupe collapses content clones before the cap is applied.
	const clones = Array.from({ length: 3 }, (_, chunkIndex) =>
		Array.from({ length: 10 }, (_, findingIndex) => ({
			...validFinding,
			id: `grok-clone-${chunkIndex}-${findingIndex}`,
			title: `Shared ${findingIndex}`,
			body: `Shared body ${findingIndex}`,
			line: findingIndex + 1,
		})),
	);
	const collapsed = unionGrokFindings(clones, { chunkCount: 3 });
	assert.equal(collapsed.length, 10);
});

test("normalize rejects invalid locations before they can reach the union cap", () => {
	assert.throws(
		() =>
			normalizeGrokReview(
				JSON.stringify([{ ...validFinding, path: "../escape.ts" }]),
				changedPaths,
			),
		/not a changed path|repository-relative/,
	);
	assert.throws(
		() => normalizeGrokReview(JSON.stringify([{ ...validFinding, line: -3 }]), changedPaths),
		/positive integer/,
	);
	// Canonical path form still matches the changed-path set.
	const raw = JSON.stringify([{ ...validFinding, path: "./src/review.ts" }]);
	assert.equal(normalizeGrokReview(raw, changedPaths)[0].path, "src/review.ts");
});


