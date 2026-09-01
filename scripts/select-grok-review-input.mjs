#!/usr/bin/env node

/**
 * Reduce the PR diff for the required Grok gate at the fork-import boundary.
 *
 * Provenance (fail closed):
 *   - Read `upstream.json` pin (commit) and UPSTREAM.md ownership rules.
 *   - Paths under upstream-owned trees whose HEAD blob is byte-identical to the
 *     pinned commit are excluded: integrity is already proven by
 *     `npm run upstream:check` (CI offline + scheduled drift).
 *   - Paths covered by a deterministic trusted check (lockfile, K-stack
 *     generated/, model provider data) are excluded only with that coverage.
 *   - First-party K-π paths and any patched-upstream path always stay in.
 *   - Anything that cannot be proven safe to exclude stays in (or fails closed
 *     when the pin object itself is missing).
 *
 * Usage:
 *   node scripts/select-grok-review-input.mjs \
 *     --repo <git-dir> --base <sha> --head <sha> --pin <upstream.json> \
 *     --out-diff <path> --out-paths <path> --out-meta <path>
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_RE = /^[0-9a-f]{40}$/i;

/** First-party K-π ownership (UPSTREAM.md §4 + fork CI/docs). Always reviewed. */
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
	"schemas/",
	"packages/coding-agent/src/kpi/",
]);

/**
 * Paths excluded only when a named deterministic trusted check covers them.
 * The Grok gate never invents coverage — the pairing is explicit.
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

/**
 * Upstream-owned trees (UPSTREAM.md §4 "Everything else under packages/").
 * Byte-identity to the pin is the only way to exclude these from Grok.
 */
export function isUpstreamOwnedPath(path) {
	if (path.startsWith("packages/coding-agent/src/kpi/")) return false;
	return path.startsWith("packages/");
}

export function isFirstPartyPath(path) {
	if (!path.includes("/")) return true; // repo-root files
	return FIRST_PARTY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function coveredArtifactRule(path) {
	return COVERED_ARTIFACT_RULES.find((rule) => rule.match(path)) ?? null;
}

/**
 * @param {string} pinText
 * @returns {{ commit: string, tag: string, repository: string, version?: string }}
 */
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
	return { commit, tag, repository, version: typeof pin.version === "string" ? pin.version : undefined };
}

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [opts]
 */
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
	// rev-parse <rev>:<path> → blob sha when the path exists at rev.
	const out = git(repo, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { allowFail: true });
	return out || null;
}

/**
 * Classify every changed path for Grok review input reduction.
 *
 * @param {{
 *   paths: string[],
 *   pinCommit: string,
 *   headSha: string,
 *   resolveBlob: (rev: string, path: string) => string | null,
 *   pinObjectPresent: boolean,
 * }} input
 */
export function classifyReviewPaths(input) {
	if (!input.pinObjectPresent) {
		throw new Error(
			`pinned upstream commit ${input.pinCommit} is not present in the git object store; cannot prove byte-identity`,
		);
	}

	/** @type {Array<{ path: string, decision: string, reason: string, check?: string }>} */
	const rows = [];
	const include = [];
	const exclude = [];

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

		if (isFirstPartyPath(path)) {
			const row = { path, decision: "include", reason: "first-party" };
			rows.push(row);
			include.push(row);
			continue;
		}

		if (!isUpstreamOwnedPath(path)) {
			// Not first-party, not packages/ — keep (fail closed on unknown ownership).
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
			// Deleted relative to pin while still in the PR path list (rename/delete).
			const row = { path, decision: "include", reason: "upstream-delete-or-rename" };
			rows.push(row);
			include.push(row);
			continue;
		}

		// Present on head but not on pin: fork-added under packages/ (or path drift).
		const row = { path, decision: "include", reason: "not-in-pin" };
		rows.push(row);
		include.push(row);
	}

	return { rows, include, exclude };
}

/**
 * Build the reduced unified diff + path list from a full git range.
 */
export function selectGrokReviewInput({
	repo,
	baseSha,
	headSha,
	pinPath,
	outDiff,
	outPaths,
	outMeta,
}) {
	const pin = parseUpstreamPin(readFileSync(pinPath, "utf8"));
	const pinPresent = git(repo, ["cat-file", "-e", `${pin.commit}^{commit}`], { allowFail: true }) !== null;
	if (!pinPresent) {
		throw new Error(
			`pinned commit ${pin.commit} missing from ${repo}; fetch the pin before Grok review input selection`,
		);
	}

	const nameOnly = git(repo, ["diff", "--name-only", "-z", `${baseSha}...${headSha}`, "--", "."]);
	const paths = nameOnly ? nameOnly.split("\0").filter(Boolean) : [];

	const classified = classifyReviewPaths({
		paths,
		pinCommit: pin.commit,
		headSha,
		pinObjectPresent: true,
		resolveBlob: (rev, path) => blobId(repo, rev, path),
	});

	const includePaths = classified.include.map((row) => row.path);
	let diffText = "";
	if (includePaths.length > 0) {
		// Batch pathspecs to stay under ARG_MAX.
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
		firstParty: classified.include.filter((r) => r.reason === "first-party").length,
		patchedUpstream: classified.include.filter((r) => r.reason === "patched-upstream").length,
		notInPin: classified.include.filter((r) => r.reason === "not-in-pin").length,
		otherIncluded: classified.include.filter(
			(r) => !["first-party", "patched-upstream", "not-in-pin"].includes(r.reason),
		).length,
	};

	const meta = {
		pin: {
			commit: pin.commit,
			tag: pin.tag,
			repository: pin.repository,
			version: pin.version ?? null,
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
		})),
		includedSample: classified.include.slice(0, 32).map((r) => ({
			path: r.path,
			reason: r.reason,
		})),
	};

	// Absolute safety ceiling on the *selected* review input (after provenance).
	// Latency is further bounded by concurrent chunking in run-chunked-grok-review.
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
	const opts = {};
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
	for (const key of ["repo", "baseSha", "headSha", "pinPath", "outDiff", "outPaths", "outMeta"]) {
		if (!opts[key]) throw new Error(`missing required --${key}`);
	}
	opts.repo = resolve(opts.repo);
	opts.pinPath = resolve(opts.pinPath);
	opts.outDiff = resolve(opts.outDiff);
	opts.outPaths = resolve(opts.outPaths);
	opts.outMeta = resolve(opts.outMeta);
	return opts;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const meta = selectGrokReviewInput(opts);
	console.log(
		`grok review input: selected=${meta.selectedDiffBytes}/${meta.fullDiffBytes} bytes paths=${meta.counts.included}/${meta.counts.changedPaths} pin=${meta.pin.tag}@${meta.pin.commit.slice(0, 12)}`,
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
