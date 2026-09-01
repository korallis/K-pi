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
import { parseChunkLocationIndex } from "./partition-pr-diff.mjs";


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
	const [row] = normalizeGrokReview(`\`\`\`json\n${JSON.stringify([validFinding])}\n\`\`\``, changedPaths);
	assert.equal(row.id, validFinding.id);
	assert.equal(row.line, validFinding.line);
	assert.equal(row.locationConfidence, "exact");
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
	const nullLine = normalizeGrokReview(JSON.stringify([{ ...validFinding, line: null }]), changedPaths)[0];
	assert.equal(nullLine.line, null);
	assert.equal(nullLine.locationConfidence, "file");
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



test("rejects paths outside the chunk location index", () => {
	const diff = [
		"diff --git a/src/review.ts b/src/review.ts",
		"--- a/src/review.ts",
		"+++ b/src/review.ts",
		"@@ -1,1 +1,1 @@",
		"+only",
		"",
	].join("\n");
	const locationIndex = parseChunkLocationIndex(diff);
	assert.throws(
		() =>
			normalizeGrokReview(
				JSON.stringify([
					{
						...validFinding,
						path: ".github/workflows/grok-review.yml",
						line: 1,
					},
				]),
				["src/review.ts", ".github/workflows/grok-review.yml"],
				{ locationIndex, requireLocationIndex: true },
			),
		/not in this chunk's paths/,
	);
});

test("off-hunk lines normalize to file confidence; exact lines stay exact", () => {
	const diff = [
		"diff --git a/src/review.ts b/src/review.ts",
		"--- a/src/review.ts",
		"+++ b/src/review.ts",
		"@@ -1,3 +1,4 @@",
		" context-one",
		"-old",
		"+new",
		"+added",
		" context-two",
		"",
	].join("\n");
	const locationIndex = parseChunkLocationIndex(diff);
	// context line 1 is not new-side → preserve finding, line null, file confidence
	const offHunk = normalizeGrokReview(
		JSON.stringify([{ ...validFinding, line: 1 }]),
		["src/review.ts"],
		{ locationIndex, requireLocationIndex: true },
	);
	assert.equal(offHunk[0].line, null);
	assert.equal(offHunk[0].locationConfidence, "file");
	// new-side lines 2 and 3 stay exact
	const exact = normalizeGrokReview(
		JSON.stringify([{ ...validFinding, line: 2 }]),
		["src/review.ts"],
		{ locationIndex, requireLocationIndex: true },
	);
	assert.equal(exact[0].line, 2);
	assert.equal(exact[0].locationConfidence, "exact");
	const exact2 = normalizeGrokReview(
		JSON.stringify([{ ...validFinding, id: "grok-added-line", line: 3 }]),
		["src/review.ts"],
		{ locationIndex, requireLocationIndex: true },
	);
	assert.equal(exact2[0].line, 3);
	assert.equal(exact2[0].locationConfidence, "exact");
	// model-supplied null is file confidence (finding preserved)
	const fileLevel = normalizeGrokReview(
		JSON.stringify([{ ...validFinding, id: "grok-file-level", line: null }]),
		["src/review.ts"],
		{ locationIndex, requireLocationIndex: true },
	);
	assert.equal(fileLevel[0].line, null);
	assert.equal(fileLevel[0].locationConfidence, "file");
});

test("deletion-only path keeps finding with file confidence", () => {
	const diff = [
		"diff --git a/gone.ts b/gone.ts",
		"--- a/gone.ts",
		"+++ /dev/null",
		"@@ -1,2 +0,0 @@",
		"-one",
		"-two",
		"",
	].join("\n");
	const locationIndex = parseChunkLocationIndex(diff);
	assert.equal(locationIndex.newSideLines.get("gone.ts")?.size ?? 0, 0);
	const ok = normalizeGrokReview(
		JSON.stringify([
			{
				id: "grok-deleted-file",
				severity: "P1",
				path: "gone.ts",
				line: 1,
				title: "Deletion drops required export",
				body: "Restoring the export or updating callers is required.",
			},
		]),
		["gone.ts"],
		{ locationIndex, requireLocationIndex: true },
	);
	assert.equal(ok[0].line, null);
	assert.equal(ok[0].locationConfidence, "file");
});

