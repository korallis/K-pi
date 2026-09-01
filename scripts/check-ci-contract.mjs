#!/usr/bin/env node

/**
 * Fork-integrity guard for K-pi CI.
 *
 * K-pi is its own harness, built from its own vendored source. Three properties
 * have to stay true, and none of them is provable by a build passing:
 *
 *   1. The gates CI invokes actually exist as root npm scripts.
 *   2. No manifest points at a `scripts/<file>` that no longer exists, so
 *      removing upstream publish machinery cannot silently break `npm run check`.
 *   3. No workflow or root script carries upstream publish, release, registry,
 *      governance, issue automation, or pnpm/peer-install machinery.
 *
 * Exit codes: 0 clean, 1 violations found.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

/** Gates `.github/workflows/ci.yml` invokes by name. */
const REQUIRED_ROOT_SCRIPTS = [
	"build",
	"build:offline",
	"check",
	"test",
	"test:kpi",
	"kstack:sync:check",
	"upstream:check",
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

/** Automation that must not exist anywhere under `.github/`. */
const FORBIDDEN_IN_WORKFLOWS = [
	[/npm\s+publish/, "npm publish (K-pi is not published to a registry)"],
	[/registry\.npmjs\.org/, "npm registry target"],
	[/\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/, "registry credential"],
	[/\bpnpm\b/, "pnpm (this fork uses npm workspaces)"],
	[/\bpi\s+install\b/, "pi install (Pi is vendored, never installed)"],
	[/@earendil-works\/pi-[a-z-]+@\d/, "pinned upstream package install from a registry"],
	[/peter-evans\/create-pull-request/, "pull-request automation"],
	[/softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action/, "release automation"],
	[/gh\s+(release|pr)\s+(create|merge|edit)/, "GitHub release/PR automation"],
	[/git\s+(push|merge|rebase|cherry-pick)\b/, "workflow that mutates history"],
	[/pull_request_target/, "pull_request_target"],
	[/actions\/stale|dessant\/|actions\/labeler/, "issue/PR governance automation"],
	[/^\s*(contents|pull-requests|issues|packages|id-token):\s*write/m, "write permission"],
];

/** Publish machinery that must not come back into root `scripts/`. */
const FORBIDDEN_IN_SCRIPTS = [
	[/npm\s+publish/, "npm publish"],
	[/registry\.npmjs\.org/, "npm registry target"],
	[/\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/, "registry credential"],
	[/gh\s+release\s+create/, "GitHub release automation"],
	[/npm-shrinkwrap\.json/, "publish-boundary shrinkwrap generation"],
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

const violations = [];

function violation(where, message) {
	violations.push(`${where}: ${message}`);
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

function readManifest(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		violation(relative(repoRoot, path), `unreadable manifest: ${error?.message ?? error}`);
		return undefined;
	}
}

function checkRequiredScripts() {
	const manifest = readManifest(join(repoRoot, "package.json"));
	if (!manifest) return;
	const scripts = manifest.scripts ?? {};
	for (const name of REQUIRED_ROOT_SCRIPTS) {
		if (typeof scripts[name] !== "string" || scripts[name].trim() === "") {
			violation("package.json", `missing required script "${name}" (CI invokes it)`);
		}
	}
}

const SCRIPT_REFERENCE = /(?:^|[\s"'=(&|;])((?:\.{1,2}\/)*scripts\/[\w.@-]+\.(?:mjs|cjs|js|ts|sh))/g;

function checkScriptReferences() {
	for (const manifestPath of listFiles(repoRoot).filter((path) => path.endsWith("package.json"))) {
		const manifest = readManifest(manifestPath);
		const scripts = manifest?.scripts;
		if (!scripts || typeof scripts !== "object") continue;
		const manifestDirectory = dirname(manifestPath);
		for (const [name, command] of Object.entries(scripts)) {
			if (typeof command !== "string") continue;
			for (const match of command.matchAll(SCRIPT_REFERENCE)) {
				const referenced = resolve(manifestDirectory, match[1]);
				if (!exists(referenced)) {
					violation(
						relative(repoRoot, manifestPath),
						`script "${name}" runs ${match[1]}, which does not exist`,
					);
				}
			}
		}
	}
}

function scan(path, rules) {
	const contents = readFileSync(path, "utf8");
	for (const [pattern, label] of rules) {
		if (pattern.test(contents)) violation(relative(repoRoot, path), `forbidden ${label}`);
	}
}

function checkGithub() {
	const githubDirectory = join(repoRoot, ".github");
	for (const forbidden of FORBIDDEN_GITHUB_PATHS) {
		if (exists(join(repoRoot, forbidden))) {
			violation(forbidden, "upstream governance file must not be imported");
		}
	}
	if (!exists(githubDirectory)) return;
	for (const path of listFiles(githubDirectory)) {
		const relativePath = relative(repoRoot, path);
		if (relativePath.startsWith(".github/workflows/") && FORBIDDEN_WORKFLOW_NAME.test(relativePath.split("/").pop())) {
			violation(relativePath, "workflow name declares publish/release/governance automation");
		}
		scan(path, FORBIDDEN_IN_WORKFLOWS);
	}
}

function checkScripts() {
	for (const path of listFiles(join(repoRoot, "scripts"))) {
		if (path === scriptPath) continue; // this guard names the patterns it forbids
		scan(path, FORBIDDEN_IN_SCRIPTS);
	}
}

checkRequiredScripts();
checkScriptReferences();
checkGithub();
checkScripts();

if (violations.length > 0) {
	console.error("fork integrity check failed:");
	for (const entry of violations) console.error(`  - ${entry}`);
	console.error("");
	console.error("K-pi builds its own harness from vendored source: no registry publish, no release");
	console.error("automation, no upstream governance, no pnpm, no peer install of Pi.");
	process.exit(1);
}

console.log(`fork integrity ok: ${REQUIRED_ROOT_SCRIPTS.length} required scripts present, no publish/release/governance automation`);
