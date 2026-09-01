#!/usr/bin/env node

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ARCHITECTURE_PIN_COMMIT,
	ARCHITECTURE_PIN_TAG,
	CANONICAL_UPSTREAM_REPOSITORY,
	buildReviewInventory,
	DEFAULT_INVENTORY_MAX_BYTES,
	inventoryCode,
	parseReviewInventory,
	classifyRelocationProvenance,
	classifyReviewPaths,
	coveredArtifactRule,
	isFirstPartyPath,
	isFixedRelocationPair,
	isUpstreamOwnedPath,
	mapRelocationCounterpart,
	parseNameStatus,
	parseUpstreamPin,
	resolvePinSource,
} from "./select-grok-review-input.mjs";

const PIN = ARCHITECTURE_PIN_COMMIT;
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVIL = "cccccccccccccccccccccccccccccccccccccccc";

function pinJson(overrides = {}) {
	return `${JSON.stringify(
		{
			repository: CANONICAL_UPSTREAM_REPOSITORY,
			tag: ARCHITECTURE_PIN_TAG,
			commit: PIN,
			...overrides,
		},
		null,
		2,
	)}\n`;
}

test("parseUpstreamPin requires honest pin shape and canonical repository", () => {
	const pin = parseUpstreamPin(pinJson());
	assert.equal(pin.commit, PIN);
	assert.equal(pin.repository, CANONICAL_UPSTREAM_REPOSITORY);
	assert.throws(() => parseUpstreamPin("{}"), /commit/);
	assert.throws(() => parseUpstreamPin("{"), /JSON/);
	assert.throws(
		() => parseUpstreamPin(pinJson({ repository: "https://evil.example/pi.git" })),
		/repository must be/,
	);
});

test("ownership helpers follow UPSTREAM.md", () => {
	assert.equal(isFirstPartyPath(".github/workflows/check.yml"), true);
	assert.equal(isFirstPartyPath("scripts/select-grok-review-input.mjs"), true);
	assert.equal(isFirstPartyPath("packages/coding-agent/src/kpi/index.ts"), true);
	assert.equal(isFirstPartyPath("extensions/accounts/index.ts"), true);
	assert.equal(isFirstPartyPath("graphs/x.json"), true);
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

test("fixed relocation map pairs legacy roots with kpi only", () => {
	assert.equal(
		mapRelocationCounterpart("extensions/a.ts")?.counterpart,
		"packages/coding-agent/src/kpi/extensions/a.ts",
	);
	assert.equal(
		mapRelocationCounterpart("packages/coding-agent/src/kpi/graphs/x.json")?.counterpart,
		"graphs/x.json",
	);
	assert.equal(mapRelocationCounterpart("scripts/x.mjs"), null);
	assert.equal(mapRelocationCounterpart("packages/ai/src/x.ts"), null);
	assert.equal(
		isFixedRelocationPair("extensions/a.ts", "packages/coding-agent/src/kpi/extensions/a.ts"),
		true,
	);
	assert.equal(
		isFixedRelocationPair("extensions/a.ts", "packages/coding-agent/src/kpi/extensions/b.ts"),
		false,
	);
	assert.equal(isFixedRelocationPair("extensions/a.ts", "scripts/a.ts"), false);
	assert.equal(isFixedRelocationPair("foo/a.ts", "packages/coding-agent/src/kpi/foo/a.ts"), false);
});

test("identical relocation excludes both sides", () => {
	const legacy = "extensions/gated-loop.ts";
	const kpi = "packages/coding-agent/src/kpi/extensions/gated-loop.ts";
	const blobs = new Map([
		[`${BASE}:${legacy}`, "blob-same"],
		[`${HEAD}:${kpi}`, "blob-same"],
	]);
	const result = classifyRelocationProvenance({
		paths: [legacy, kpi],
		baseSha: BASE,
		headSha: HEAD,
		renamePairs: [{ oldPath: legacy, newPath: kpi }],
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});
	assert.equal(result.decisions.get(legacy).decision, "exclude");
	assert.equal(result.decisions.get(legacy).reason, "relocation-identical");
	assert.equal(result.decisions.get(kpi).decision, "exclude");
	assert.equal(result.decisions.get(kpi).reason, "relocation-identical");
});

test("modified relocation includes only the new kpi path", () => {
	const legacy = "extensions/gated-loop.ts";
	const kpi = "packages/coding-agent/src/kpi/extensions/gated-loop.ts";
	const blobs = new Map([
		[`${BASE}:${legacy}`, "blob-old"],
		[`${HEAD}:${kpi}`, "blob-new"],
	]);
	const result = classifyRelocationProvenance({
		paths: [legacy, kpi],
		baseSha: BASE,
		headSha: HEAD,
		renamePairs: [{ oldPath: legacy, newPath: kpi }],
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});
	assert.equal(result.decisions.get(kpi).decision, "include");
	assert.equal(result.decisions.get(kpi).reason, "relocation-modified");
	assert.equal(result.decisions.get(legacy).decision, "exclude");
	assert.equal(result.decisions.get(legacy).reason, "relocation-source-side");
});

test("missing relocation counterpart fails safe to include", () => {
	const legacy = "extensions/only-old.ts";
	const result = classifyRelocationProvenance({
		paths: [legacy],
		baseSha: BASE,
		headSha: HEAD,
		resolveBlob: (rev, path) => {
			if (rev === BASE && path === legacy) return "blob";
			return null;
		},
	});
	assert.equal(result.decisions.get(legacy).decision, "include");
	assert.equal(result.decisions.get(legacy).reason, "relocation-missing-counterpart");
});

test("no arbitrary path mapping participates in relocation provenance", () => {
	const result = classifyRelocationProvenance({
		paths: ["random/a.ts", "other/a.ts"],
		baseSha: BASE,
		headSha: HEAD,
		renamePairs: [{ oldPath: "random/a.ts", newPath: "other/a.ts" }],
		resolveBlob: () => "same",
	});
	assert.equal(result.consumed.size, 0);
	assert.equal(result.decisions.size, 0);
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
		baseSha: BASE,
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
				baseSha: BASE,
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
		baseSha: BASE,
		headSha: HEAD,
		pinObjectPresent: true,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	};
	assert.deepEqual(classifyReviewPaths(input), classifyReviewPaths(input));
});

test("base pin always wins over a hostile head pin", () => {
	const base = pinJson();
	const evilHead = pinJson({ commit: EVIL, tag: "v0.0.0-evil" });
	const resolved = resolvePinSource({ basePinText: base, headPinText: evilHead });
	assert.equal(resolved.source, "base");
	assert.equal(resolved.pin.commit, PIN);
	assert.notEqual(resolved.pin.commit, EVIL);
});

test("head pin change cannot alter exclusion when base pin exists", () => {
	const base = pinJson();
	const evilHead = pinJson({ commit: EVIL, tag: "v9.9.9" });
	const resolved = resolvePinSource({ basePinText: base, headPinText: evilHead });

	const blobs = new Map([
		[`${PIN}:packages/ai/src/index.ts`, "trusted-upstream"],
		[`${EVIL}:packages/ai/src/index.ts`, "malicious"],
		[`${HEAD}:packages/ai/src/index.ts`, "malicious"],
	]);

	const withBasePin = classifyReviewPaths({
		paths: ["packages/ai/src/index.ts"],
		pinCommit: resolved.pin.commit,
		baseSha: BASE,
		headSha: HEAD,
		pinObjectPresent: true,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});
	assert.equal(withBasePin.rows[0].decision, "include");
	assert.equal(withBasePin.rows[0].reason, "patched-upstream");

	const withEvilPin = classifyReviewPaths({
		paths: ["packages/ai/src/index.ts"],
		pinCommit: EVIL,
		baseSha: BASE,
		headSha: HEAD,
		pinObjectPresent: true,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});
	assert.equal(withEvilPin.rows[0].decision, "exclude");
	assert.equal(withEvilPin.rows[0].reason, "byte-identical-to-pin");
});

test("bootstrap head pin only accepts the architecture pin", () => {
	const ok = resolvePinSource({ basePinText: null, headPinText: pinJson() });
	assert.equal(ok.source, "head-bootstrap");
	assert.equal(ok.pin.commit, ARCHITECTURE_PIN_COMMIT);
	assert.equal(ok.pin.tag, ARCHITECTURE_PIN_TAG);

	assert.throws(
		() => resolvePinSource({ headPinText: pinJson({ commit: EVIL }) }),
		/architecture pin/,
	);
	assert.throws(
		() => resolvePinSource({ headPinText: pinJson({ tag: "v0.0.1" }) }),
		/architecture pin/,
	);
	assert.throws(
		() => resolvePinSource({ headPinText: pinJson({ repository: "https://evil.example/pi.git" }) }),
		/repository must be/,
	);
	assert.throws(() => resolvePinSource({}), /missing on base and head/);
});

test("parseNameStatus captures rename pairs", () => {
	const raw = ["R100", "extensions/a.ts", "packages/coding-agent/src/kpi/extensions/a.ts", "M", "scripts/x.mjs", ""].join(
		"\0",
	);
	const parsed = parseNameStatus(raw);
	assert.deepEqual(parsed.renamePairs, [
		{ oldPath: "extensions/a.ts", newPath: "packages/coding-agent/src/kpi/extensions/a.ts" },
	]);
	assert.ok(parsed.paths.includes("extensions/a.ts"));
	assert.ok(parsed.paths.includes("packages/coding-agent/src/kpi/extensions/a.ts"));
	assert.ok(parsed.paths.includes("scripts/x.mjs"));
});


test("head-only dual add is not relocation-identical", () => {
	const legacy = "extensions/new-both.ts";
	const kpi = "packages/coding-agent/src/kpi/extensions/new-both.ts";
	const blobs = new Map([
		[`${HEAD}:${legacy}`, "blob-same"],
		[`${HEAD}:${kpi}`, "blob-same"],
	]);
	const result = classifyRelocationProvenance({
		paths: [legacy, kpi],
		baseSha: BASE,
		headSha: HEAD,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});
	assert.equal(result.decisions.get(legacy).decision, "include");
	assert.equal(result.decisions.get(legacy).reason, "relocation-missing-counterpart");
	assert.equal(result.decisions.get(kpi).decision, "include");
});



test("inventoryCode is stable one- or two-byte base36", () => {
	assert.equal(inventoryCode(0), "0");
	assert.equal(inventoryCode(10), "a");
	assert.equal(inventoryCode(35), "z");
	assert.equal(inventoryCode(36), "10");
	assert.equal(inventoryCode(37), "11");
});

test("buildReviewInventory is complete: every path once, lockfiles present, dictionary round-trips", () => {
	const rows = [
		{ path: "pnpm-lock.yaml", decision: "exclude", reason: "covered-artifact", check: "check.yml: Lockfile unchanged by install + npm ci" },
		{ path: "package-lock.json", decision: "exclude", reason: "covered-artifact", check: "check.yml: Lockfile unchanged by install + npm ci" },
		{ path: "src/a.ts", decision: "include", reason: "first-party" },
		{ path: "src/b.ts", decision: "include", reason: "first-party" },
		{ path: "packages/coding-agent/src/kpi/x.ts", decision: "include", reason: "relocation-modified" },
	];
	const statusByPath = new Map([
		["pnpm-lock.yaml", "D"],
		["package-lock.json", "A"],
		["src/a.ts", "M"],
		["src/b.ts", "M"],
		["packages/coding-agent/src/kpi/x.ts", "M"],
	]);
	const inv = buildReviewInventory({ rows, statusByPath, maxBytes: DEFAULT_INVENTORY_MAX_BYTES });
	assert.equal(inv.complete, true);
	assert.equal(inv.omitted, 0);
	assert.match(inv.text, /^complete:1$/m);
	assert.match(inv.text, /^rows:5$/m);
	assert.equal(inv.text.includes("omitted:"), false);
	assert.ok(inv.bytes <= DEFAULT_INVENTORY_MAX_BYTES);

	const parsed = parseReviewInventory(inv.text);
	assert.equal(parsed.rows.length, 5);
	const paths = parsed.rows.map((r) => r.path).sort();
	assert.deepEqual(paths, [...statusByPath.keys()].sort());
	// every path exactly once
	assert.equal(new Set(paths).size, paths.length);

	const byPath = new Map(parsed.rows.map((r) => [r.path, r]));
	assert.equal(byPath.get("package-lock.json").status, "A");
	assert.equal(byPath.get("package-lock.json").decision, "exclude");
	assert.match(byPath.get("package-lock.json").reason, /covered-artifact/);
	assert.equal(byPath.get("pnpm-lock.yaml").status, "D");
	assert.equal(byPath.get("src/a.ts").decision, "include");
	assert.equal(byPath.get("src/a.ts").reason, "first-party");
	// no file contents
	assert.equal(inv.text.includes("node_modules"), false);
	// dictionary present
	assert.match(inv.text, /^d:[0-9a-z]+=include$/m);
	assert.match(inv.text, /^d:[0-9a-z]+=exclude$/m);
	assert.match(inv.text, /^r:[0-9a-z]+=first-party$/m);
});

test("buildReviewInventory fails closed when complete inventory exceeds maxBytes", () => {
	const rows = [];
	for (let i = 0; i < 200; i++) {
		rows.push({ path: `unique-prefix-${i}/deep/path/file-${i}.ts`, decision: "include", reason: "first-party" });
	}
	assert.throws(
		() => buildReviewInventory({ rows, maxBytes: 200 }),
		/fails closed above maxBytes 200/,
	);
});

test("buildReviewInventory monorepo-scale path list stays complete under default budget", () => {
	const rows = [];
	const statusByPath = new Map();
	for (let i = 0; i < 2200; i++) {
		const path = `packages/coding-agent/src/kpi/mod${Math.floor(i / 50)}/file-${i}.ts`;
		rows.push({
			path,
			decision: i % 7 === 0 ? "exclude" : "include",
			reason: i % 7 === 0 ? "byte-identical-to-pin" : "first-party",
		});
		statusByPath.set(path, "M");
	}
	rows.push({ path: "package-lock.json", decision: "exclude", reason: "covered-artifact", check: "check.yml: Lockfile unchanged by install + npm ci" });
	rows.push({ path: "pnpm-lock.yaml", decision: "exclude", reason: "covered-artifact", check: "check.yml: Lockfile unchanged by install + npm ci" });
	statusByPath.set("package-lock.json", "A");
	statusByPath.set("pnpm-lock.yaml", "D");

	const inv = buildReviewInventory({ rows, statusByPath, maxBytes: DEFAULT_INVENTORY_MAX_BYTES });
	assert.equal(inv.complete, true);
	assert.equal(inv.omitted, 0);
	assert.ok(inv.bytes <= DEFAULT_INVENTORY_MAX_BYTES, `bytes ${inv.bytes}`);
	const parsed = parseReviewInventory(inv.text);
	assert.equal(parsed.rows.length, rows.length);
	assert.ok(parsed.rows.some((r) => r.path === "package-lock.json" && r.status === "A"));
	assert.ok(parsed.rows.some((r) => r.path === "pnpm-lock.yaml" && r.status === "D"));
});


test("missing HEAD kpi is not relocation-identical via base fallback", () => {
	const legacy = "extensions/gated-loop.ts";
	const kpi = "packages/coding-agent/src/kpi/extensions/gated-loop.ts";
	const blobs = new Map([
		[`${BASE}:${legacy}`, "blob-same"],
		[`${BASE}:${kpi}`, "blob-same"],
		// HEAD kpi intentionally absent
	]);
	const result = classifyRelocationProvenance({
		paths: [legacy, kpi],
		baseSha: BASE,
		headSha: HEAD,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});
	assert.equal(result.decisions.get(legacy).decision, "include");
	assert.equal(result.decisions.get(kpi).decision, "include");
});


test("retained legacy on HEAD stays in review after identical kpi relocate", () => {
	const legacy = "extensions/gated-loop.ts";
	const kpi = "packages/coding-agent/src/kpi/extensions/gated-loop.ts";
	const blobs = new Map([
		[`${BASE}:${legacy}`, "blob-same"],
		[`${HEAD}:${kpi}`, "blob-same"],
		[`${HEAD}:${legacy}`, "blob-same"],
	]);
	const result = classifyRelocationProvenance({
		paths: [legacy, kpi],
		baseSha: BASE,
		headSha: HEAD,
		resolveBlob: (rev, path) => blobs.get(`${rev}:${path}`) ?? null,
	});
	assert.equal(result.decisions.get(kpi).decision, "exclude");
	assert.equal(result.decisions.get(legacy).decision, "include");
	assert.equal(result.decisions.get(legacy).reason, "relocation-legacy-retained");
});
