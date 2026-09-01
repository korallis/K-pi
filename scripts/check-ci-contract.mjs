#!/usr/bin/env node

/**
 * Fork-integrity guard for K-pi CI.
 *
 * K-pi is its own harness, built from its own vendored source. Four properties
 * have to stay true, and none of them is provable by a build passing:
 *
 *   1. The hard gate `.github/workflows/check.yml` exists, and the gates it
 *      invokes actually exist as root npm scripts.
 *   2. No manifest points at a `scripts/<file>` that no longer exists, so
 *      removing upstream publish machinery cannot silently break `npm run check`.
 *   3. No workflow or root script carries upstream publish, release, registry,
 *      governance, issue automation, or pnpm/peer-install machinery.
 *   4. Write tokens and merges live in exactly two reviewed workflows:
 *      grok-review.yml may post one read-only review result, and auto-merge.yml
 *      may ask GitHub to merge a PR after required checks pass. Every other
 *      workflow stays read-only; neither exemption permits pushes, release,
 *      registry, or governance automation.
 *
 * Exemptions are per file and per rule (see WORKFLOW_EXEMPTIONS): there is no
 * blanket allow pattern, and no way to opt a workflow out from inside itself.
 *
 * Usage: node scripts/check-ci-contract.mjs
 * Exit codes: 0 clean, 1 violations found.
 *
 * The rule surface is exported as `inspectForkIntegrity(root)`;
 * `scripts/check-ci-contract.test.mjs` runs it against fixture repositories.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

/** Gates `.github/workflows/check.yml` invokes by name. */
const REQUIRED_ROOT_SCRIPTS = [
	"build",
	"build:offline",
	"check",
	"test",
	"test:kpi",
	"kstack:sync:check",
	"upstream:check",
];

/** Workflows the fork cannot lose: without them the required gates do not run. */
const REQUIRED_WORKFLOWS = [".github/workflows/check.yml", ".github/workflows/grok-review.yml"];

const OBSOLETE_WORKFLOWS = [".github/workflows/cursor-review.yml"];

/** Directories that never hold first-party manifests. */
const SKIPPED_DIRECTORIES = new Set([
	".git",
	".pi",
	".artifacts",
	"node_modules",
	"dist",
	"fixtures",
	"install-lock",
]);

/**
 * Automation that must not exist anywhere under `.github/`.
 *
 * Ids are the exemption keys: a workflow in WORKFLOW_EXEMPTIONS is excused from
 * the listed ids and from nothing else.
 */
const FORBIDDEN_IN_WORKFLOWS = [
	{ id: "npm-publish", pattern: /npm\s+publish/, label: "npm publish (K-pi is not published to a registry)" },
	{ id: "npm-registry", pattern: /registry\.npmjs\.org/, label: "npm registry target" },
	{ id: "registry-credential", pattern: /\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/, label: "registry credential" },
	{
		id: "cursor-credential",
		pattern: /\bCURSOR_(?:API_KEY|PUSH_TOKEN)\b/,
		label: "obsolete Cursor credential",
	},
	{
		id: "one-password-runtime",
		pattern: /\bop\s+(?:read|run|inject)\b|1password\/load-secrets-action/i,
		label: "runtime 1Password dependency",
	},
	{ id: "pnpm", pattern: /\bpnpm\b/, label: "pnpm (this fork uses npm workspaces)" },
	{ id: "pi-install", pattern: /\bpi\s+install\b/, label: "pi install (Pi is vendored, never installed)" },
	{
		id: "upstream-package-install",
		pattern: /@earendil-works\/pi-[a-z-]+@\d/,
		label: "pinned upstream package install from a registry",
	},
	{
		id: "release-automation",
		pattern: /softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action/,
		label: "release automation",
	},
	{ id: "gh-release", pattern: /gh\s+release\s+(create|edit|delete|upload)/, label: "GitHub release automation" },
	{
		id: "pull-request-automation",
		pattern: /peter-evans\/create-pull-request/,
		label: "pull-request automation",
	},
	{ id: "gh-pr-write", pattern: /gh\s+pr\s+(create|edit|close|reopen)/, label: "GitHub PR automation" },
	// Merging at all is exempt only for `auto-merge.yml`; merging *past* the
	// checks is exempt nowhere, so `--admin` is its own rule.
	{ id: "gh-pr-merge", pattern: /gh\s+pr\s+merge/, label: "PR merge automation" },
	{
		id: "merge-bypass",
		// Allow --admin on a continuation line under `run: |` / folded blocks.
		pattern: /gh\s+pr\s+merge(?:[^\n]*\n[ \t]+){0,8}[^\n]*--admin\b/,
		label: "merge that bypasses required checks (--admin)",
	},
	{ id: "git-push", pattern: /git\s+push\b/, label: "workflow that pushes" },
	{
		id: "git-history-rewrite",
		pattern: /git\s+(merge|rebase|cherry-pick)\b/,
		label: "workflow that rewrites history",
	},
	// The hazard is the trigger, not the word: workflow comments have to be able
	// to state that this fork refuses the privileged variant.
	{
		id: "privileged-pr-trigger",
		// Mapping key, scalar on:, flow list, or sequence item — with optional quotes.
		pattern:
			/(?:^[ \t]*['"]?pull_request_target['"]?[ \t]*:|(?:^|[\s\[,])['"]?pull_request_target['"]?(?=[ \t]*[,\]\n]|$)|^[ \t]*on:[ \t]*['"]?pull_request_target['"]?\s*$)/m,
		label: "pull_request_target trigger",
	},
	{
		id: "governance-automation",
		pattern: /actions\/stale|dessant\/|actions\/labeler/,
		label: "issue/PR governance automation",
	},
];

/** Every GitHub permission scope; `write` on any of them is an escalation. */
const WRITE_PERMISSION =
	/^[ \t]*(actions|attestations|checks|contents|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|repository-projects|security-events|statuses)[ \t]*:[ \t]*["']?write["']?\b/gm;

const GH_PR_MERGE_COMMAND = /gh\s+pr\s+merge[^\n]*/g;

/**
 * The two reviewed write escalations, spelled out file by file.
 *
 * rules lists the forbidden-pattern ids the workflow is excused from;
 * writePermissions lists the permission keys it may raise to write. Anything
 * absent here stays forbidden in that file too.
 */
const WORKFLOW_EXEMPTIONS = new Map([
	[
		".github/workflows/grok-review.yml",
		{
			reason: "posts one read-only Grok review result to the pull request",
			rules: new Set(),
			writePermissions: new Set(["pull-requests"]),
		},
	],
	[
		".github/workflows/auto-merge.yml",
		{
			reason: "asks GitHub to merge only after required checks pass",
			rules: new Set(["gh-pr-merge"]),
			writePermissions: new Set(["contents", "pull-requests"]),
		},
	],
]);

/** Publish machinery that must not come back into root `scripts/`. */
const FORBIDDEN_IN_SCRIPTS = [
	{ id: "npm-publish", pattern: /npm\s+publish/, label: "npm publish" },
	{ id: "npm-registry", pattern: /registry\.npmjs\.org/, label: "npm registry target" },
	{ id: "registry-credential", pattern: /\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/, label: "registry credential" },
	{ id: "gh-release", pattern: /gh\s+release\s+create/, label: "GitHub release automation" },
	{ id: "shrinkwrap", pattern: /npm-shrinkwrap\.json/, label: "publish-boundary shrinkwrap generation" },
];

/** Upstream governance files that must never be imported. */
const FORBIDDEN_GITHUB_PATHS = [
	".github/ISSUE_TEMPLATE",
	".github/PULL_REQUEST_TEMPLATE.md",
	".github/FUNDING.yml",
	".github/CODE_OF_CONDUCT.md",
	".github/CONTRIBUTING.md",
];

const FORBIDDEN_WORKFLOW_NAME = /(publish|release|announce|npm-audit|issue|triage|label|stale|approve|contributor|binaries)/i;

/**
 * Third-party `uses:` refs on self-hosted runners must be full 40-char commit
 * SHAs. Floating tags (`@v7`, `@main`) are mutable and fail closed here.
 * Local actions (`./…`) and `docker://` images are out of scope.
 */
const ACTION_USES_LINE = /^[ \t]*-?[ \t]*uses:[ \t]*([^\s#]+)/gm;
const PINNED_THIRD_PARTY_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;


function toPosix(path) {
	return sep === "/" ? path : path.split(sep).join("/");
}

function exists(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function listFiles(directory) {
	const found = [];
	const walk = (current) => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
				walk(path);
			} else if (entry.isFile()) {
				found.push(path);
			}
		}
	};
	walk(directory);
	return found;
}

function readManifest(context, path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		context.violation(context.name(path), `unreadable manifest: ${error?.message ?? error}`);
		return undefined;
	}
}

function checkRequiredScripts(context) {
	const manifest = readManifest(context, join(context.root, "package.json"));
	if (!manifest) return;
	const scripts = manifest.scripts ?? {};
	for (const name of REQUIRED_ROOT_SCRIPTS) {
		if (typeof scripts[name] !== "string" || scripts[name].trim() === "") {
			context.violation("package.json", `missing required script "${name}" (CI invokes it)`);
		}
	}
	for (const workflow of REQUIRED_WORKFLOWS) {
		if (!exists(join(context.root, workflow))) {
			context.violation(workflow, "required gate workflow is missing (nothing runs the gates above)");
		}
	}
}

const SCRIPT_REFERENCE = /(?:^|[\s"'=(&|;])((?:\.{1,2}\/)*scripts\/[\w.@-]+\.(?:mjs|cjs|js|ts|sh))/g;

function checkScriptReferences(context) {
	for (const manifestPath of listFiles(context.root).filter((path) => path.endsWith("package.json"))) {
		const manifest = readManifest(context, manifestPath);
		const scripts = manifest?.scripts;
		if (!scripts || typeof scripts !== "object") continue;
		const manifestDirectory = dirname(manifestPath);
		for (const [name, command] of Object.entries(scripts)) {
			if (typeof command !== "string") continue;
			for (const match of command.matchAll(SCRIPT_REFERENCE)) {
				const referenced = resolve(manifestDirectory, match[1]);
				if (!exists(referenced)) {
					context.violation(context.name(manifestPath), `script "${name}" runs ${match[1]}, which does not exist`);
				}
			}
		}
	}
}

/** Applies a rule table to one file, skipping only this file's exempt rule ids. */
function scan(context, path, rules, exemptRules) {
	const relativePath = context.name(path);
	const contents = readFileSync(path, "utf8");
	for (const rule of rules) {
		if (exemptRules?.has(rule.id)) continue;
		if (rule.pattern.test(contents)) context.violation(relativePath, `forbidden ${rule.label}`);
	}
	return contents;
}

/**
 * `gh pr merge` is exempt for `auto-merge.yml` only in its queueing form: every
 * invocation there must carry `--auto`, so GitHub — not this workflow — decides
 * when the required checks are satisfied.
 */
function checkMergeWaitsForChecks(context, relativePath, contents) {
	for (const command of contents.match(GH_PR_MERGE_COMMAND) ?? []) {
		// Tolerates prose markup around the flag (`--auto`) but not a different
		// flag that merely starts with it (--auto-x, --autofix).
		if (!/--auto(?![\w-])/.test(command)) {
			context.violation(relativePath, "forbidden merge that does not wait for checks (`gh pr merge` without --auto)");
		}
	}
}

function checkWritePermissions(context, relativePath, contents, allowed) {
	// Top-level grant: permissions: write-all (optional quotes)
	if (/^[ \t]*permissions:[ \t]*["']?write-all["']?\b/m.test(contents)) {
		context.violation(relativePath, 'forbidden write permission "write-all"');
	}
	// Flow-style maps: permissions: { contents: write, ... } with optional quotes
	for (const match of contents.matchAll(
		/^[ \t]*permissions:[ \t]*\{([^}]*)\}/gm,
	)) {
		const body = match[1];
		for (const entry of body.matchAll(
			/\b(actions|attestations|checks|contents|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|repository-projects|security-events|statuses)[ \t]*:[ \t]*["']?write["']?\b/g,
		)) {
			const key = entry[1];
			if (allowed?.has(key)) continue;
			context.violation(relativePath, `forbidden write permission "${key}: write"`);
		}
	}
	// Block-style scope lines (optional quotes around write).
	for (const match of contents.matchAll(WRITE_PERMISSION)) {
		const key = match[1];
		if (allowed?.has(key)) continue;
		context.violation(relativePath, `forbidden write permission "${key}: write"`);
	}
}


function checkThirdPartyActionPins(context, relativePath, contents) {
	if (!relativePath.startsWith(".github/workflows/")) return;
	for (const match of contents.matchAll(ACTION_USES_LINE)) {
		const ref = match[1];
		if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
		if (!PINNED_THIRD_PARTY_ACTION.test(ref)) {
			context.violation(
				relativePath,
				`third-party action must be pinned to a full commit SHA (got ${ref})`,
			);
		}
	}
}

/**
 * The hard `check` gate runs on a persistent self-hosted Mac. Fork pull_request
 * heads must never schedule there. The job `if:` must keep non-PR events and
 * require same-repository heads for pull_request (plus the existing draft skip).
 * `pull_request_target` remains forbidden separately.
 */
function checkSelfHostedPullRequestGuard(context, relativePath, contents) {
	if (relativePath !== ".github/workflows/check.yml") return;

	const hasSameRepo =
		/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(contents) ||
		/github\.repository\s*==\s*github\.event\.pull_request\.head\.repo\.full_name/.test(contents);
	if (!hasSameRepo) {
		context.violation(
			relativePath,
			"self-hosted check job must require same-repository PR heads (github.event.pull_request.head.repo.full_name == github.repository)",
		);
	}

	// Draft skip remains load-bearing so half-finished work does not occupy the Mac.
	if (!/github\.event\.pull_request\.draft\s*==\s*false/.test(contents)) {
		context.violation(
			relativePath,
			"self-hosted check job must skip draft pull requests (github.event.pull_request.draft == false)",
		);
	}

	// Non-PR events (push/schedule/dispatch) must still be able to run the gate.
	if (!/github\.event_name\s*!=\s*'pull_request'/.test(contents)) {
		context.violation(
			relativePath,
			"self-hosted check job must preserve non-pull_request events (github.event_name != 'pull_request')",
		);
	}
}



function checkGithub(context) {
	const githubDirectory = join(context.root, ".github");
	for (const obsolete of OBSOLETE_WORKFLOWS) {
		if (exists(join(context.root, obsolete))) {
			context.violation(obsolete, "obsolete Cursor review workflow must not exist");
		}
	}
	for (const forbidden of FORBIDDEN_GITHUB_PATHS) {
		if (exists(join(context.root, forbidden))) {
			context.violation(forbidden, "upstream governance file must not be imported");
		}
	}
	if (!exists(githubDirectory)) return;
	for (const path of listFiles(githubDirectory)) {
		const relativePath = context.name(path);
		const isWorkflow = relativePath.startsWith(".github/workflows/");
		if (isWorkflow && FORBIDDEN_WORKFLOW_NAME.test(relativePath.slice(relativePath.lastIndexOf("/") + 1))) {
			context.violation(relativePath, "workflow name declares publish/release/governance automation");
		}
		const exemption = isWorkflow ? WORKFLOW_EXEMPTIONS.get(relativePath) : undefined;
		const contents = scan(context, path, FORBIDDEN_IN_WORKFLOWS, exemption?.rules);
		if (exemption?.rules.has("gh-pr-merge")) checkMergeWaitsForChecks(context, relativePath, contents);
		checkWritePermissions(context, relativePath, contents, exemption?.writePermissions);
		checkThirdPartyActionPins(context, relativePath, contents);
		checkSelfHostedPullRequestGuard(context, relativePath, contents);

	}
}

function checkScripts(context) {
	for (const path of listFiles(join(context.root, "scripts"))) {
		// This guard names the patterns it forbids; its own source cannot be a
		// violation of itself.
		if (path === scriptPath) continue;
		scan(context, path, FORBIDDEN_IN_SCRIPTS);
	}
}

/**
 * Runs every rule against one repository root and returns the violations as
 * `"<path>: <message>"` strings. Empty array means clean.
 */
export function inspectForkIntegrity(root = repoRoot) {
	const violations = [];
	const context = {
		root,
		violations,
		violation: (where, message) => violations.push(`${where}: ${message}`),
		name: (path) => toPosix(relative(root, path)),
	};
	checkRequiredScripts(context);
	checkScriptReferences(context);
	checkGithub(context);
	checkScripts(context);
	return violations;
}

function main() {
	const violations = inspectForkIntegrity();
	if (violations.length > 0) {
		console.error("fork integrity check failed:");
		for (const entry of violations) console.error(`  - ${entry}`);
		console.error("");
		console.error("K-pi builds its own harness from vendored source: no registry publish, no release");
		console.error("automation, no upstream governance, no pnpm, no peer install of Pi. Write tokens,");
		console.error("pushes and merges exist only in the reviewed workflows named in WORKFLOW_EXEMPTIONS:");
		for (const [workflow, exemption] of WORKFLOW_EXEMPTIONS) {
			console.error(`  - ${workflow}: ${exemption.reason}`);
		}
		process.exit(1);
	}
	console.log(
		`fork integrity ok: ${REQUIRED_ROOT_SCRIPTS.length} required scripts present, no publish/release/governance automation, ${WORKFLOW_EXEMPTIONS.size} reviewed write exemptions`,
	);
}

/**
 * CLI only when invoked directly. `import.meta.url` is already symlink-resolved
 * by the loader while argv[1] is not (macOS `/var` → `/private/var`), so both
 * sides go through realpath before they are compared.
 */
function invokedDirectly() {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	try {
		return realpathSync(resolve(entry)) === scriptPath;
	} catch {
		return false;
	}
}

if (invokedDirectly()) main();
