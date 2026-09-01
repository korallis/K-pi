#!/usr/bin/env node

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyReviewPaths,
	coveredArtifactRule,
	isFirstPartyPath,
	isUpstreamOwnedPath,
	parseUpstreamPin,
} from "./select-grok-review-input.mjs";

const PIN = "b79e4cc834970cca69daebffab7df1da7d1e52c4";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("parseUpstreamPin requires honest pin shape", () => {
	const pin = parseUpstreamPin(
		JSON.stringify({
			repository: "https://github.com/earendil-works/pi.git",
			tag: "v0.84.4",
			commit: PIN,
		}),
	);
	assert.equal(pin.commit, PIN);
	assert.throws(() => parseUpstreamPin("{}"), /commit/);
	assert.throws(() => parseUpstreamPin("{"), /JSON/);
});

test("ownership helpers follow UPSTREAM.md", () => {
	assert.equal(isFirstPartyPath(".github/workflows/check.yml"), true);
	assert.equal(isFirstPartyPath("scripts/select-grok-review-input.mjs"), true);
	assert.equal(isFirstPartyPath("packages/coding-agent/src/kpi/index.ts"), true);
	assert.equal(isFirstPartyPath("extensions/accounts/index.ts"), true);
	assert.equal(isFirstPartyPath("README.md"), true);
	assert.equal(isFirstPartyPath("packages/ai/src/index.ts"), false);
	assert.equal(isUpstreamOwnedPath("packages/ai/src/index.ts"), true);
	assert.equal(isUpstreamOwnedPath("packages/coding-agent/src/kpi/x.ts"), false);
});

test("covered artifacts require an explicit trusted check pairing", () => {
	assert.equal(coveredArtifactRule("package-lock.json")?.id, "lockfile-install");
	assert.equal(
		coveredArtifactRule("packages/coding-agent/src/kpi/kstack/generated/skills/x.md")?.id,
		"kstack-generated",
	);
	assert.equal(coveredArtifactRule("packages/ai/src/providers/data/openai.json")?.id, "model-provider-data");
	assert.equal(coveredArtifactRule("packages/ai/src/index.ts"), null);
});

test("byte-identical upstream blobs are excluded; patches stay in", () => {
	const blobs = new Map([
		[`${PIN}:packages/ai/src/index.ts`, "blob-same"],
		[`${HEAD}:packages/ai/src/index.ts`, "blob-same"],
		[`${PIN}:packages/coding-agent/package.json`, "blob-old"],
		[`${HEAD}:packages/coding-agent/package.json`, "blob-new"],
		[`${HEAD}:packages/coding-agent/src/kpi/foo.ts`, "kpi"],
		[`${HEAD}:scripts/gate.mjs`, "gate"],
		[`${HEAD}:package-lock.json`, "lock"],
		[`${HEAD}:packages/ai/src/providers/data/x.json`, "data"],
		[`${HEAD}:packages/new-only.ts`, "new"],
	]);
	const result = classifyReviewPaths({
		paths: [
			"packages/ai/src/index.ts",
			"packages/coding-agent/package.json",
			"packages/coding-agent/src/kpi/foo.ts",
			"scripts/gate.mjs",
			"package-lock.json",
			"packages/ai/src/providers/data/x.json",
			"packages/new-only.ts",
			"mystery/path.ts",
		],
		pinCommit: PIN,
		headSha: HEAD,
		pinObjectPresent: true,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});

	const byPath = Object.fromEntries(result.rows.map((row) => [row.path, row]));
	assert.equal(byPath["packages/ai/src/index.ts"].decision, "exclude");
	assert.equal(byPath["packages/ai/src/index.ts"].reason, "byte-identical-to-pin");
	assert.equal(byPath["packages/coding-agent/package.json"].decision, "include");
	assert.equal(byPath["packages/coding-agent/package.json"].reason, "patched-upstream");
	assert.equal(byPath["packages/coding-agent/src/kpi/foo.ts"].reason, "first-party");
	assert.equal(byPath["scripts/gate.mjs"].reason, "first-party");
	assert.equal(byPath["package-lock.json"].reason, "covered-artifact");
	assert.equal(byPath["packages/ai/src/providers/data/x.json"].reason, "covered-artifact");
	assert.equal(byPath["packages/new-only.ts"].reason, "not-in-pin");
	assert.equal(byPath["mystery/path.ts"].reason, "unproven-ownership");
	assert.equal(byPath["mystery/path.ts"].decision, "include");
});

test("missing pin object fails closed", () => {
	assert.throws(
		() =>
			classifyReviewPaths({
				paths: ["packages/ai/src/index.ts"],
				pinCommit: PIN,
				headSha: HEAD,
				pinObjectPresent: false,
				resolveBlob: () => null,
			}),
		/not present/,
	);
});

test("classification is deterministic for the same inputs", () => {
	const paths = ["scripts/a.mjs", "packages/tui/x.ts", "package-lock.json"];
	const blobs = new Map([
		[`${PIN}:packages/tui/x.ts`, "1"],
		[`${HEAD}:packages/tui/x.ts`, "1"],
		[`${HEAD}:scripts/a.mjs`, "2"],
		[`${HEAD}:package-lock.json`, "3"],
	]);
	const input = {
		paths,
		pinCommit: PIN,
		headSha: HEAD,
		pinObjectPresent: true,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	};
	assert.deepEqual(classifyReviewPaths(input), classifyReviewPaths(input));
});
