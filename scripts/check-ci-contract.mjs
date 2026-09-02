#!/usr/bin/env node

/**
 * Fork-integrity guard for K-pi CI.
 *
 * K-pi is its own harness, built from its own vendored source and published as
 * the single npm package `@korallis/k-pi`. Four properties have to stay true,
 * and none of them is provable by a build passing:
 *
 *   1. The two workflows the project cannot lose exist — `check.yml`, the only
 *      required status check, and `release.yml`, the only thing allowed to
 *      publish — and the gates and packaging they invoke exist as root npm
 *      scripts.
 *   2. No manifest points at a `scripts/<file>` that no longer exists, so
 *      retiring machinery cannot silently break `npm run check`.
 *   3. No workflow or root script carries upstream governance, issue
 *      automation, pnpm/peer-install machinery, a registry credential, a push,
 *      or a merge that bypasses the required check. Publishing is allowed in
 *      exactly one file, and never from a root script: `scripts/pack-kpi.mjs`
 *      packs a tarball and stops there.
 *   4. Write tokens live in exactly three reviewed workflows: `release.yml`
 *      publishes with OIDC and cuts the GitHub release, `auto-merge.yml` asks
 *      GitHub to merge once the required check passes, and `ai-review.yml`
 *      posts one advisory comment. Every other workflow stays read-only, and no
 *      exemption permits a push, a registry credential, or a merge bypass.
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

/** Gates and packaging the `check` and `release` workflows invoke by name. */
const REQUIRED_ROOT_SCRIPTS = [
	"build",
	"build:offline",
	"check",
	"pack",
	"test",
	"test:kpi",
	"kstack:sync:check",
	"upstream:check",
	"verify:built",
	"verify:product",
];

/**
 * Workflows the fork cannot lose: `check.yml` is the only required status check,
 * and `release.yml` is the only place allowed to publish.
 */
const REQUIRED_WORKFLOWS = [".github/workflows/check.yml", ".github/workflows/release.yml"];

/** Retired CI machinery. Re-adding any of these files is a violation, not a merge conflict. */
const OBSOLETE_WORKFLOWS = [
	".github/workflows/cursor-review.yml",
	".github/workflows/grok-review.yml",
	".github/workflows/react-doctor.yml",
];

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
	{ id: "npm-publish", pattern: /npm\s+publish/, label: "npm publish outside release.yml" },
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
		// Do not treat git merge-base / merge-file / merge-tree as history rewrites.
		pattern: /git\s+(merge|rebase|cherry-pick)(?![-\w])/,
		label: "workflow that rewrites history",
	},
	// The hazard is the trigger, not the word: workflow comments have to be able
	// to state that this fork refuses the privileged variant.
	{
		id: "privileged-pr-trigger",
		// Real trigger forms only — never a prose/comment mention of the forbidden name.
		pattern:
			/(?:^[ \t]*['"]?pull_request_target['"]?[ \t]*:|^[ \t]*on:[ \t]*\[[^\n\]]*\bpull_request_target\b|^[ \t]*on:[ \t]*['"]?pull_request_target['"]?[ \t]*(?:#.*)?$|^[ \t]*-[ \t]+['"]?pull_request_target['"]?[ \t]*(?:#.*)?$)/m,
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
 * The three reviewed write escalations, spelled out file by file.
 *
 * rules lists the forbidden-pattern ids the workflow is excused from;
 * writePermissions lists the permission keys it may raise to write. Anything
 * absent here stays forbidden in that file too — notably `git-push`,
 * `registry-credential`, `release-automation` (third-party release actions),
 * `merge-bypass` and `privileged-pr-trigger`, which are forbidden everywhere.
 */
const WORKFLOW_EXEMPTIONS = new Map([
	[
		".github/workflows/release.yml",
		{
			reason:
				"publishes @korallis/k-pi with npm trusted publishing (OIDC) and attaches the tarball to the tag release",
			rules: new Set(["npm-publish", "npm-registry", "gh-release"]),
			writePermissions: new Set(["contents", "id-token"]),
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
	[
		".github/workflows/ai-review.yml",
		{
			reason: "posts one advisory review comment to the pull request",
			rules: new Set(),
			writePermissions: new Set(["pull-requests"]),
		},
	],
]);

/**
 * Publish machinery that must not come back into root `scripts/`. Publishing is
 * a workflow concern: `scripts/pack-kpi.mjs` packs a tarball and never talks to
 * a registry, so no root script needs a credential or a publish command.
 */
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

/**
 * Upstream workflow filenames. These are the files a merge from upstream tries
 * to reintroduce; K-pi runs none of them. An exact blocklist rather than a word
 * regex, so this fork can own `release.yml` while still refusing upstream's
 * publish/governance set.
 */
const FORBIDDEN_WORKFLOW_FILENAMES = new Set([
	"approve-contributor.yml",
	"build-binaries.yml",
	"ci.yml",
	"issue-analysis.yml",
	"issue-gate.yml",
	"issue-triage-labels.yml",
	"npm-audit.yml",
	"pr-gate.yml",
	"publish-model-catalog.yml",
	"remove-inprogress-on-close.yml",
]);

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
			context.violation(workflow, "required workflow is missing (nothing runs the gate or the release)");
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
/**
 * Strip an unquoted `# ...` shell/YAML comment from a single command line.
 * @param {string} line
 */
function stripUnquotedLineComment(line) {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'" && !inDouble) inSingle = !inSingle;
		else if (c === '"' && !inSingle) inDouble = !inDouble;
		else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
	}
	return line;
}

function checkMergeWaitsForChecks(context, relativePath, contents) {
	for (const command of contents.match(GH_PR_MERGE_COMMAND) ?? []) {
		const effective = stripUnquotedLineComment(command);
		// Tolerates prose markup around the flag (`--auto`) but not a different
		// flag that merely starts with it (--auto-x, --autofix). A `# --auto`
		// comment must not satisfy the gate.
		if (!/--auto(?![\w-])/.test(effective)) {
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
/**
 * Drop full-line and unquoted trailing `#` comments so presence checks cannot
 * be satisfied by documentation alone.
 * @param {string} text
 */
function stripWorkflowComments(text) {
	return text
		.split("\n")
		.map((line) => {
			let inSingle = false;
			let inDouble = false;
			for (let i = 0; i < line.length; i++) {
				const c = line[i];
				if (c === "'" && !inDouble) inSingle = !inSingle;
				else if (c === '"' && !inSingle) inDouble = !inDouble;
				else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
			}
			return line;
		})
		.join("\n");
}

function checkSelfHostedPullRequestGuard(context, relativePath, contents) {
	if (relativePath !== ".github/workflows/check.yml") return;

	const code = stripWorkflowComments(contents);
	// Prefer the job-level `if:` for the self-hosted check job (order-independent
	// vs runs-on/env). Folded (`>-`) and single-line forms both count.
	const jobBlock = /^[ \t]*check:\n([\s\S]*?)(?=\n[ \t]*[A-Za-z0-9_-]+:\s*$|\n[ \t]*steps:\s*$|$)/m.exec(
		code,
	)?.[1];
	const foldedIf = jobBlock
		? /^[ \t]*if:\s*>-?\s*\n([\s\S]*?)(?=\n[ \t]*(?:runs-on|timeout-minutes|env|permissions|needs|concurrency|defaults|strategy|container|services|outputs|continue-on-error|steps):)/m.exec(
				jobBlock,
			)?.[1]
		: null;
	const singleIf = jobBlock
		? /^[ \t]*if:\s*([^\n]+)/m.exec(jobBlock)?.[1]
		: null;
	const jobIf = foldedIf ?? singleIf ?? code;

	const hasSameRepo =
		/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(jobIf) ||
		/github\.repository\s*==\s*github\.event\.pull_request\.head\.repo\.full_name/.test(jobIf);
	if (!hasSameRepo) {
		context.violation(
			relativePath,
			"self-hosted check job must require same-repository PR heads (github.event.pull_request.head.repo.full_name == github.repository)",
		);
	}

	// Draft skip remains load-bearing so half-finished work does not occupy the Mac.
	if (!/github\.event\.pull_request\.draft\s*==\s*false/.test(jobIf)) {
		context.violation(
			relativePath,
			"self-hosted check job must skip draft pull requests (github.event.pull_request.draft == false)",
		);
	}

	// Non-PR events (push/schedule/dispatch) must still be able to run the gate.
	if (!/github\.event_name\s*!=\s*'pull_request'/.test(jobIf)) {
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
			context.violation(obsolete, "retired workflow must not exist");
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
		if (isWorkflow && FORBIDDEN_WORKFLOW_FILENAMES.has(relativePath.slice(relativePath.lastIndexOf("/") + 1))) {
			context.violation(relativePath, "upstream workflow filename must not be imported");
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
