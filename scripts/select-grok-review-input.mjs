#!/usr/bin/env node

/**
 * Reduce the PR diff for the required Grok gate at the fork-import boundary.
 *
 * Provenance (fail closed):
 *   - The pin is taken from base/trusted `upstream.json` whenever it exists. A
 *     PR cannot retarget the pin to a commit it ships in order to smuggle
 *     packages/** blobs past Grok as "byte-identical-to-pin".
 *   - Head pin is allowed only for the one-time bootstrap when base has no pin,
 *     and only if it matches the canonical Pi repository + architecture pin.
 *   - Fixed relocation map: legacy first-party roots (extensions/, graphs/, …)
 *     → packages/coding-agent/src/kpi/…. Byte-identical moves are excluded;
 *     modified moves keep only the new path; missing counterpart stays included.
 *   - Paths under upstream-owned trees whose HEAD blob is byte-identical to the
 *     trusted pin commit are excluded (paired with `npm run upstream:check`).
 *   - Paths covered by a deterministic trusted check (lockfile, K-stack
 *     generated/, model provider data) are excluded only with that coverage.
 *   - Remaining first-party K-π paths and patched-upstream paths always stay in.
 *   - Missing pin object or unproven ownership fails closed / stays included.
 *
 * Usage:
 *   node scripts/select-grok-review-input.mjs \
 *     --repo <git-dir> --base <sha> --head <sha> \
 *     [--pin-base <upstream.json>] [--pin-head <upstream.json>] \
 *     --out-diff <path> --out-paths <path> --out-meta <path>
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_RE = /^[0-9a-f]{40}$/i;

/** Canonical upstream repository URL recorded in UPSTREAM.md / upstream.json. */
export const CANONICAL_UPSTREAM_REPOSITORY = "https://github.com/earendil-works/pi.git";

/**
 * Architecture landing pin. Bootstrap (base has no upstream.json) may only
 * introduce this exact pin from head — never an attacker-chosen commit.
 */
export const ARCHITECTURE_PIN_COMMIT = "b79e4cc834970cca69daebffab7df1da7d1e52c4";
export const ARCHITECTURE_PIN_TAG = "v0.84.4";

/** First-party K-π ownership. Reviewed unless relocation- or check-proven. */
export const FIRST_PARTY_PREFIXES = Object.freeze([
	".github/",
	"scripts/",
	"docs/",
	"design/",
	"test/",
	"tests/",
	"fixtures/",
	"kstack/",
	"extensions/",
	"graphs/",
	"prompts/",
	"schemas/",
	"skills/",
	"templates/",
	"themes/",
	"packages/coding-agent/src/kpi/",
]);

/**
 * Deterministic legacy → kpi relocation prefixes (RP-01A tree move). No arbitrary
 * path mapping: only these fixed pairs participate in move provenance.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const RELOCATION_PREFIX_PAIRS = Object.freeze([
	["extensions/", "packages/coding-agent/src/kpi/extensions/"],
	["graphs/", "packages/coding-agent/src/kpi/graphs/"],
	["prompts/", "packages/coding-agent/src/kpi/prompts/"],
	["schemas/", "packages/coding-agent/src/kpi/schemas/"],
	["skills/", "packages/coding-agent/src/kpi/skills/"],
	["templates/", "packages/coding-agent/src/kpi/templates/"],
	["themes/", "packages/coding-agent/src/kpi/themes/"],
	["kstack/", "packages/coding-agent/src/kpi/kstack/"],
]);

/**
 * Paths excluded only when a named deterministic trusted check covers them.
 * @type {ReadonlyArray<{ id: string, check: string, match: (path: string) => boolean }>}
 */
export const COVERED_ARTIFACT_RULES = Object.freeze([
	{
		id: "lockfile-install",
		check: "check.yml: Lockfile unchanged by install + npm ci",
		match: (path) => path === "package-lock.json",
	},
	{
		id: "kstack-generated",
		check: "npm run kstack:sync:check",
		match: (path) =>
			path.startsWith("packages/coding-agent/src/kpi/kstack/generated/") ||
			path.startsWith("kstack/generated/") ||
			path.startsWith("packages/coding-agent/src/kpi/kstack/upstream/"),
	},
	{
		id: "model-provider-data",
		check: "build:offline → check:model-data (packages/ai)",
		match: (path) => path.startsWith("packages/ai/src/providers/data/"),
	},
]);

export function isUpstreamOwnedPath(path) {
	if (path.startsWith("packages/coding-agent/src/kpi/")) return false;
	return path.startsWith("packages/");
}

export function isFirstPartyPath(path) {
	if (!path.includes("/")) return true;
	return FIRST_PARTY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function coveredArtifactRule(path) {
	return COVERED_ARTIFACT_RULES.find((rule) => rule.match(path)) ?? null;
}

/**
 * @param {string} path
 * @returns {{ direction: "legacy-to-kpi" | "kpi-to-legacy", counterpart: string } | null}
 */
export function mapRelocationCounterpart(path) {
	for (const [legacy, kpi] of RELOCATION_PREFIX_PAIRS) {
		if (path.startsWith(legacy)) {
			return { direction: "legacy-to-kpi", counterpart: `${kpi}${path.slice(legacy.length)}` };
		}
		if (path.startsWith(kpi)) {
			return { direction: "kpi-to-legacy", counterpart: `${legacy}${path.slice(kpi.length)}` };
		}
	}
	return null;
}

/**
 * True only when old→new is exactly one fixed relocation-prefix pair (same relative tail).
 * @param {string} oldPath
 * @param {string} newPath
 */
export function isFixedRelocationPair(oldPath, newPath) {
	for (const [legacy, kpi] of RELOCATION_PREFIX_PAIRS) {
		if (oldPath.startsWith(legacy) && newPath.startsWith(kpi)) {
			return oldPath.slice(legacy.length) === newPath.slice(kpi.length);
		}
		if (oldPath.startsWith(kpi) && newPath.startsWith(legacy)) {
			return oldPath.slice(kpi.length) === newPath.slice(legacy.length);
		}
	}
	return false;
}

export function normalizeUpstreamRepository(repository) {
	const trimmed = repository.trim().replace(/\/+$/u, "");
	return trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
}

export function assertCanonicalUpstreamRepository(repository) {
	const normalized = normalizeUpstreamRepository(repository);
	const expected = normalizeUpstreamRepository(CANONICAL_UPSTREAM_REPOSITORY);
	if (normalized !== expected) {
		throw new Error(
			`upstream.json repository must be ${CANONICAL_UPSTREAM_REPOSITORY} (got ${repository})`,
		);
	}
	return normalized;
}

export function parseUpstreamPin(pinText) {
	let pin;
	try {
		pin = JSON.parse(pinText);
	} catch (error) {
		throw new Error(`upstream.json is not valid JSON: ${error.message}`);
	}
	if (!pin || typeof pin !== "object") throw new Error("upstream.json must be an object");
	const commit = typeof pin.commit === "string" ? pin.commit.trim().toLowerCase() : "";
	const tag = typeof pin.tag === "string" ? pin.tag.trim() : "";
	const repository = typeof pin.repository === "string" ? pin.repository.trim() : "";
	if (!COMMIT_RE.test(commit)) throw new Error("upstream.json commit must be a 40-char hex sha");
	if (!tag) throw new Error("upstream.json tag is required");
	if (!repository) throw new Error("upstream.json repository is required");
	assertCanonicalUpstreamRepository(repository);
	return {
		commit,
		tag,
		repository: normalizeUpstreamRepository(repository),
		version: typeof pin.version === "string" ? pin.version : undefined,
	};
}

/**
 * Trust rule: base pin always wins when present. Head pin is bootstrap-only and
 * must match the recorded architecture pin + canonical repository.
 */
export function resolvePinSource({ basePinText = null, headPinText = null } = {}) {
	const baseText = typeof basePinText === "string" && basePinText.trim() ? basePinText : null;
	const headText = typeof headPinText === "string" && headPinText.trim() ? headPinText : null;

	if (baseText) {
		const pin = parseUpstreamPin(baseText);
		return { source: "base", pin, pinText: baseText };
	}

	if (headText) {
		const pin = parseUpstreamPin(headText);
		if (pin.commit !== ARCHITECTURE_PIN_COMMIT) {
			throw new Error(
				`bootstrap head pin commit must be architecture pin ${ARCHITECTURE_PIN_COMMIT} (got ${pin.commit})`,
			);
		}
		if (pin.tag !== ARCHITECTURE_PIN_TAG) {
			throw new Error(
				`bootstrap head pin tag must be architecture pin ${ARCHITECTURE_PIN_TAG} (got ${pin.tag})`,
			);
		}
		return { source: "head-bootstrap", pin, pinText: headText };
	}

	throw new Error("upstream.json missing on base and head; cannot prove fork provenance");
}

function git(repo, args, { allowFail = false } = {}) {
	try {
		return execFileSync("git", ["-C", repo, ...args], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		if (allowFail) return null;
		const stderr = error.stderr?.toString?.() ?? error.message;
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
}

function blobId(repo, rev, path) {
	const out = git(repo, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { allowFail: true });
	return out || null;
}

/**
 * Parse `git diff --name-status -z` into paths + rename pairs.
 * @param {string} nameStatus
 */
export function parseNameStatus(nameStatus) {
	const tokens = nameStatus ? nameStatus.split("\0").filter(Boolean) : [];
	/** @type {string[]} */
	const paths = [];
	/** @type {Array<{ oldPath: string, newPath: string }>} */
	const renamePairs = [];
	const pathSet = new Set();
	const addPath = (path) => {
		if (!path || pathSet.has(path)) return;
		pathSet.add(path);
		paths.push(path);
	};

	for (let i = 0; i < tokens.length; ) {
		const status = tokens[i++];
		if (!status) break;
		const code = status[0];
		if ((code === "R" || code === "C") && i + 1 < tokens.length) {
			const oldPath = tokens[i++];
			const newPath = tokens[i++];
			addPath(oldPath);
			addPath(newPath);
			renamePairs.push({ oldPath, newPath });
			continue;
		}
		if (i < tokens.length) addPath(tokens[i++]);
	}
	return { paths, renamePairs };
}

/**
 * Classify relocation pairs before generic first-party inclusion.
 */
export function classifyRelocationProvenance(input) {
	/** @type {Map<string, { path: string, decision: string, reason: string, counterpart?: string }>} */
	const decisions = new Map();
	const consumed = new Set();
	const pathSet = new Set(input.paths);

	/** @type {Array<{ legacy: string, kpi: string }>} */
	const pairs = [];
	const seen = new Set();

	const addPair = (legacy, kpi) => {
		const key = `${legacy}\0${kpi}`;
		if (seen.has(key)) return;
		if (!isFixedRelocationPair(legacy, kpi)) return;
		seen.add(key);
		pairs.push({ legacy, kpi });
	};

	for (const pair of input.renamePairs ?? []) {
		if (!isFixedRelocationPair(pair.oldPath, pair.newPath)) continue;
		const legacy = pair.oldPath.startsWith("packages/coding-agent/src/kpi/") ? pair.newPath : pair.oldPath;
		const kpi = pair.oldPath.startsWith("packages/coding-agent/src/kpi/") ? pair.oldPath : pair.newPath;
		addPair(legacy, kpi);
	}

	for (const path of input.paths) {
		const mapped = mapRelocationCounterpart(path);
		if (!mapped) continue;
		if (mapped.direction === "legacy-to-kpi") addPair(path, mapped.counterpart);
		else addPair(mapped.counterpart, path);
	}

	for (const { legacy, kpi } of pairs) {
		const baseLegacy = input.resolveBlob(input.baseSha, legacy);
		const headKpi = input.resolveBlob(input.headSha, kpi);
		const headLegacy = input.resolveBlob(input.headSha, legacy);
		const baseKpi = input.resolveBlob(input.baseSha, kpi);

		const sourceBlob = baseLegacy ?? headLegacy;
		const destBlob = headKpi ?? baseKpi;

		if (!sourceBlob || !destBlob) {
			for (const path of [legacy, kpi]) {
				if (!pathSet.has(path) || decisions.has(path)) continue;
				decisions.set(path, {
					path,
					decision: "include",
					reason: "relocation-missing-counterpart",
					counterpart: path === legacy ? kpi : legacy,
				});
				consumed.add(path);
			}
			continue;
		}

		if (sourceBlob === destBlob) {
			for (const path of [legacy, kpi]) {
				if (!pathSet.has(path)) continue;
				decisions.set(path, {
					path,
					decision: "exclude",
					reason: "relocation-identical",
					counterpart: path === legacy ? kpi : legacy,
				});
				consumed.add(path);
			}
			continue;
		}

		// Modified relocation: review kpi path only; drop legacy source side.
		if (pathSet.has(kpi)) {
			decisions.set(kpi, {
				path: kpi,
				decision: "include",
				reason: "relocation-modified",
				counterpart: legacy,
			});
			consumed.add(kpi);
		}
		if (pathSet.has(legacy)) {
			decisions.set(legacy, {
				path: legacy,
				decision: "exclude",
				reason: "relocation-source-side",
				counterpart: kpi,
			});
			consumed.add(legacy);
		}
	}

	return { decisions, consumed };
}

export function classifyReviewPaths(input) {
	if (!input.pinObjectPresent) {
		throw new Error(
			`pinned upstream commit ${input.pinCommit} is not present in the git object store; cannot prove byte-identity`,
		);
	}
	if (!input.baseSha) {
		throw new Error("baseSha is required for relocation provenance");
	}

	const rows = [];
	const include = [];
	const exclude = [];

	// Covered artifacts win over relocation so generated/lockfile stays check-gated.
	const uncoveredPaths = [];
	for (const path of input.paths) {
		const covered = coveredArtifactRule(path);
		if (covered) {
			const row = {
				path,
				decision: "exclude",
				reason: "covered-artifact",
				check: covered.check,
				ruleId: covered.id,
			};
			rows.push(row);
			exclude.push(row);
			continue;
		}
		uncoveredPaths.push(path);
	}

	const relocation = classifyRelocationProvenance({
		paths: uncoveredPaths,
		baseSha: input.baseSha,
		headSha: input.headSha,
		resolveBlob: input.resolveBlob,
		renamePairs: input.renamePairs,
	});

	for (const path of uncoveredPaths) {
		if (relocation.consumed.has(path)) {
			const row = relocation.decisions.get(path);
			rows.push(row);
			if (row.decision === "exclude") exclude.push(row);
			else include.push(row);
			continue;
		}

		if (isFirstPartyPath(path)) {
			const row = { path, decision: "include", reason: "first-party" };
			rows.push(row);
			include.push(row);
			continue;
		}

		if (!isUpstreamOwnedPath(path)) {
			const row = { path, decision: "include", reason: "unproven-ownership" };
			rows.push(row);
			include.push(row);
			continue;
		}

		const headBlob = input.resolveBlob(input.headSha, path);
		const pinBlob = input.resolveBlob(input.pinCommit, path);

		if (headBlob && pinBlob && headBlob === pinBlob) {
			const row = {
				path,
				decision: "exclude",
				reason: "byte-identical-to-pin",
				pinCommit: input.pinCommit,
				blob: headBlob,
			};
			rows.push(row);
			exclude.push(row);
			continue;
		}

		if (headBlob && pinBlob && headBlob !== pinBlob) {
			const row = {
				path,
				decision: "include",
				reason: "patched-upstream",
				pinCommit: input.pinCommit,
			};
			rows.push(row);
			include.push(row);
			continue;
		}

		if (!headBlob && pinBlob) {
			const row = { path, decision: "include", reason: "upstream-delete-or-rename" };
			rows.push(row);
			include.push(row);
			continue;
		}

		const row = { path, decision: "include", reason: "not-in-pin" };
		rows.push(row);
		include.push(row);
	}

	return { rows, include, exclude };
}


export function selectGrokReviewInput({
	repo,
	baseSha,
	headSha,
	pinBasePath = null,
	pinHeadPath = null,
	pinPath = null,
	outDiff,
	outPaths,
	outMeta,
}) {
	const readOptional = (path) => {
		if (!path) return null;
		try {
			return readFileSync(path, "utf8");
		} catch (error) {
			if (error && error.code === "ENOENT") return null;
			throw error;
		}
	};

	const resolved = pinPath
		? {
				source: "base",
				pin: parseUpstreamPin(readFileSync(pinPath, "utf8")),
				pinText: readFileSync(pinPath, "utf8"),
			}
		: resolvePinSource({
				basePinText: readOptional(pinBasePath),
				headPinText: readOptional(pinHeadPath),
			});
	const pin = resolved.pin;

	const pinPresent = git(repo, ["cat-file", "-e", `${pin.commit}^{commit}`], { allowFail: true }) !== null;
	if (!pinPresent) {
		throw new Error(
			`pinned commit ${pin.commit} missing from ${repo}; fetch the pin before Grok review input selection`,
		);
	}

	const nameStatus = git(repo, [
		"diff",
		"--name-status",
		"-z",
		"--find-renames",
		`${baseSha}...${headSha}`,
		"--",
		".",
	]);
	const { paths, renamePairs } = parseNameStatus(nameStatus);

	const classified = classifyReviewPaths({
		paths,
		pinCommit: pin.commit,
		baseSha,
		headSha,
		pinObjectPresent: true,
		renamePairs,
		resolveBlob: (rev, path) => blobId(repo, rev, path),
	});

	const includePaths = classified.include.map((row) => row.path);
	let diffText = "";
	if (includePaths.length > 0) {
		// Batch pathspecs to stay under ARG_MAX. Modified relocations include only
		// the kpi destination path (legacy source side already excluded).
		const batchSize = 200;
		const parts = [];
		for (let i = 0; i < includePaths.length; i += batchSize) {
			const batch = includePaths.slice(i, i + batchSize);
			parts.push(
				git(repo, [
					"diff",
					"--find-renames",
					"--no-ext-diff",
					"--no-textconv",
					`${baseSha}...${headSha}`,
					"--",
					...batch,
				]),
			);
		}
		diffText = parts.filter(Boolean).join("");
		if (diffText && !diffText.endsWith("\n")) diffText += "\n";
	}



	const fullDiff = git(repo, [
		"diff",
		"--find-renames",
		"--no-ext-diff",
		"--no-textconv",
		`${baseSha}...${headSha}`,
		"--",
		".",
	]);
	const fullBytes = Buffer.byteLength(fullDiff, "utf8");
	const selectedBytes = Buffer.byteLength(diffText, "utf8");

	const counts = {
		changedPaths: paths.length,
		included: includePaths.length,
		excluded: classified.exclude.length,
		byteIdenticalToPin: classified.exclude.filter((r) => r.reason === "byte-identical-to-pin").length,
		coveredArtifact: classified.exclude.filter((r) => r.reason === "covered-artifact").length,
		relocationIdentical: classified.exclude.filter((r) => r.reason === "relocation-identical").length,
		relocationSourceSide: classified.exclude.filter((r) => r.reason === "relocation-source-side").length,
		relocationModified: classified.include.filter((r) => r.reason === "relocation-modified").length,
		relocationMissingCounterpart: classified.include.filter((r) => r.reason === "relocation-missing-counterpart")
			.length,
		firstParty: classified.include.filter((r) => r.reason === "first-party").length,
		patchedUpstream: classified.include.filter((r) => r.reason === "patched-upstream").length,
		notInPin: classified.include.filter((r) => r.reason === "not-in-pin").length,
		otherIncluded: classified.include.filter(
			(r) =>
				![
					"first-party",
					"patched-upstream",
					"not-in-pin",
					"relocation-modified",
					"relocation-missing-counterpart",
				].includes(r.reason),
		).length,
	};

	const meta = {
		pin: {
			commit: pin.commit,
			tag: pin.tag,
			repository: pin.repository,
			version: pin.version ?? null,
			source: resolved.source,
		},
		baseSha,
		headSha,
		fullDiffBytes: fullBytes,
		selectedDiffBytes: selectedBytes,
		counts,
		excludedSample: classified.exclude.slice(0, 32).map((r) => ({
			path: r.path,
			reason: r.reason,
			check: r.check ?? null,
			counterpart: r.counterpart ?? null,
		})),
		includedSample: classified.include.slice(0, 32).map((r) => ({
			path: r.path,
			reason: r.reason,
			counterpart: r.counterpart ?? null,
		})),
	};

	const MAX_SELECTED_BYTES = 2_000_000;
	if (selectedBytes > MAX_SELECTED_BYTES) {
		throw new Error(
			`selected Grok review diff is ${selectedBytes} bytes after provenance reduction; fails closed above ${MAX_SELECTED_BYTES}`,
		);
	}

	writeFileSync(outDiff, diffText);
	writeFileSync(outPaths, includePaths.join("\0") + (includePaths.length ? "\0" : ""));
	writeFileSync(outMeta, `${JSON.stringify(meta, null, 2)}\n`);
	return meta;
}

function parseArgs(argv) {
	const opts = {
		pinPath: null,
		pinBasePath: null,
		pinHeadPath: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--repo":
				opts.repo = next();
				break;
			case "--base":
				opts.baseSha = next();
				break;
			case "--head":
				opts.headSha = next();
				break;
			case "--pin":
				opts.pinPath = next();
				break;
			case "--pin-base":
				opts.pinBasePath = next();
				break;
			case "--pin-head":
				opts.pinHeadPath = next();
				break;
			case "--out-diff":
				opts.outDiff = next();
				break;
			case "--out-paths":
				opts.outPaths = next();
				break;
			case "--out-meta":
				opts.outMeta = next();
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	for (const key of ["repo", "baseSha", "headSha", "outDiff", "outPaths", "outMeta"]) {
		if (!opts[key]) throw new Error(`missing required --${key}`);
	}
	if (!opts.pinPath && !opts.pinBasePath && !opts.pinHeadPath) {
		throw new Error("missing required --pin-base/--pin-head (or legacy --pin)");
	}
	opts.repo = resolve(opts.repo);
	if (opts.pinPath) opts.pinPath = resolve(opts.pinPath);
	if (opts.pinBasePath) opts.pinBasePath = resolve(opts.pinBasePath);
	if (opts.pinHeadPath) opts.pinHeadPath = resolve(opts.pinHeadPath);
	opts.outDiff = resolve(opts.outDiff);
	opts.outPaths = resolve(opts.outPaths);
	opts.outMeta = resolve(opts.outMeta);
	return opts;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const meta = selectGrokReviewInput(opts);
	console.log(
		`grok review input: selected=${meta.selectedDiffBytes}/${meta.fullDiffBytes} bytes paths=${meta.counts.included}/${meta.counts.changedPaths} pin=${meta.pin.tag}@${meta.pin.commit.slice(0, 12)} relocIdent=${meta.counts.relocationIdentical} relocMod=${meta.counts.relocationModified}`,
	);
}

function invokedDirectly() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedDirectly()) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
