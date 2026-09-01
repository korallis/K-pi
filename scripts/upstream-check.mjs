#!/usr/bin/env node

/**
 * Read-only upstream pin verification for the K-pi fork.
 *
 * K-pi vendors the Pi tree as its own harness source. `upstream.json` records the
 * repository, release tag, and commit that vendored tree came from. This script
 * proves the pin is still honest and reports whether upstream has moved on.
 *
 * Contract:
 *   - Reads the machine-readable pin (default: <repo>/upstream.json).
 *   - Verifies the pin against local git objects, and unless `--offline` against
 *     the upstream repository over read-only `git ls-remote`.
 *   - Every git invocation is restricted to a read-only allowlist. The script
 *     never fetches, merges, checks out, tags, pushes, publishes, releases, or
 *     opens a pull request, and writes nothing except the report paths passed on
 *     the command line.
 *   - Reporting a newer upstream release never advances the pin. Updating is a
 *     human `git fetch upstream`, a reviewed merge, and an edit of `upstream.json`.
 *
 * Usage:
 *   node scripts/upstream-check.mjs [--offline] [--pin <path>]
 *                                   [--json <path>] [--summary <path>]
 *                                   [--timeout <seconds>]
 *
 * Exit codes:
 *   0  pin verified; drift, if any, is reported and never applied. An unreachable
 *      upstream is also 0: scheduled maintenance is fail-safe.
 *   1  pin integrity violation: malformed pin, or a tag that no longer resolves
 *      to the pinned commit.
 *   2  usage error.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const ALLOWED_SCHEMES = new Set(["https:", "file:"]);

// Read-only plumbing only. Anything that can mutate a repository, a remote, or a
// registry is absent by construction, not by convention.
const READ_ONLY_GIT = new Set(["cat-file", "config", "ls-remote", "rev-list", "rev-parse"]);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function usage(message) {
	if (message) console.error(`upstream-check: ${message}`);
	console.error(
		"usage: node scripts/upstream-check.mjs [--offline] [--pin <path>] [--json <path>] [--summary <path>] [--timeout <seconds>]",
	);
	process.exit(2);
}

function parseArguments(argv) {
	const options = {
		pin: resolve(scriptDirectory, "..", "upstream.json"),
		offline: false,
		json: undefined,
		summary: undefined,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const next = () => {
			const value = argv[index + 1];
			if (value === undefined) usage(`${argument} requires a value`);
			index += 1;
			return value;
		};
		switch (argument) {
			case "--offline":
				options.offline = true;
				break;
			case "--pin":
				options.pin = resolve(process.cwd(), next());
				break;
			case "--json":
				options.json = resolve(process.cwd(), next());
				break;
			case "--summary":
				options.summary = resolve(process.cwd(), next());
				break;
			case "--timeout": {
				const seconds = Number(next());
				if (!Number.isFinite(seconds) || seconds <= 0) usage("--timeout expects a positive number of seconds");
				options.timeoutMs = Math.round(seconds * 1000);
				break;
			}
			case "--help":
			case "-h":
				usage();
				break;
			default:
				usage(`unknown argument ${argument}`);
		}
	}
	return options;
}

/** Strip embedded credentials before a URL reaches a log or a report. */
function redactUrl(url) {
	if (typeof url !== "string") return url;
	return url.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]*@/g, "$1<redacted>@");
}

function git(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	if (!READ_ONLY_GIT.has(args[0])) {
		throw new Error(`refusing to run non-read-only git subcommand: ${args[0]}`);
	}
	return execFileSync("git", args, {
		cwd,
		timeout: timeoutMs,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_OPTIONAL_LOCKS: "0" },
	}).trim();
}

function tryGit(args, options) {
	try {
		return { ok: true, value: git(args, options) };
	} catch (error) {
		const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
		return { ok: false, reason: redactUrl(stderr || error?.message || "git failed") };
	}
}

class PinError extends Error {}

function requireString(pin, field) {
	const value = pin[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new PinError(`"${field}" must be a non-empty string`);
	}
	return value;
}

function assertRepositoryUrl(repository) {
	let url;
	try {
		url = new URL(repository);
	} catch {
		throw new PinError(`"repository" must be an absolute URL, got ${JSON.stringify(repository)}`);
	}
	// `file:` stays legal so the drift contract is testable without a network.
	if (!ALLOWED_SCHEMES.has(url.protocol)) {
		throw new PinError(`"repository" must use https: (or file: for fixtures), got ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new PinError('"repository" must not embed credentials');
	}
}

function loadPin(pinPath) {
	let raw;
	try {
		raw = readFileSync(pinPath, "utf8");
	} catch (error) {
		throw new PinError(`cannot read pin file ${pinPath}: ${error?.message ?? error}`);
	}
	let pin;
	try {
		pin = JSON.parse(raw);
	} catch (error) {
		throw new PinError(`pin file ${pinPath} is not valid JSON: ${error?.message ?? error}`);
	}
	if (pin === null || typeof pin !== "object" || Array.isArray(pin)) {
		throw new PinError("pin file must contain a JSON object");
	}

	const repository = requireString(pin, "repository");
	assertRepositoryUrl(repository);
	const remote = requireString(pin, "remote");
	const tag = requireString(pin, "tag");
	const version = requireString(pin, "version");
	const commit = requireString(pin, "commit");

	if (!TAG_RE.test(tag)) throw new PinError(`"tag" must look like v<major>.<minor>.<patch>, got ${tag}`);
	if (tag !== `v${version}`) throw new PinError(`"tag" (${tag}) and "version" (${version}) disagree`);
	if (!COMMIT_RE.test(commit)) throw new PinError(`"commit" must be a full 40-character sha, got ${commit}`);

	const policy = pin.policy ?? {};
	if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
		throw new PinError('"policy" must be an object when present');
	}
	for (const forbidden of ["autoMerge", "autoUpdate", "publishToRegistry"]) {
		if (policy[forbidden] === true) {
			throw new PinError(`policy.${forbidden} must be false: upstream maintenance is read-only`);
		}
	}
	if (policy.driftCheck !== undefined && policy.driftCheck !== "read-only") {
		throw new PinError('policy.driftCheck must be "read-only"');
	}

	return { repository, remote, tag, version, commit, policy };
}

function compareVersions(left, right) {
	for (let index = 0; index < 3; index += 1) {
		const difference = left[index] - right[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * @param {string} tag
 * @param {{ allowPrerelease?: boolean }} [opts]
 */
function parseTagVersion(tag, opts = {}) {
	const match = TAG_RE.exec(tag);
	if (!match) return undefined;
	// Remote "latest stable" candidates skip prereleases so -rc never outranks
	// the release line. Pins still need their numeric triple for comparison.
	if (tag.includes("-") && !opts.allowPrerelease) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function inspectLocal(pin, repoRoot, timeoutMs) {
	const state = { commitPresent: false, tagCommit: null, remoteUrl: null, violations: [] };

	state.commitPresent = tryGit(["cat-file", "-e", `${pin.commit}^{commit}`], { cwd: repoRoot, timeoutMs }).ok;

	const tagRef = tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/${pin.tag}^{commit}`], {
		cwd: repoRoot,
		timeoutMs,
	});
	if (tagRef.ok && COMMIT_RE.test(tagRef.value)) {
		state.tagCommit = tagRef.value;
		if (tagRef.value !== pin.commit) {
			state.violations.push(
				`local tag ${pin.tag} resolves to ${tagRef.value}, but ${pin.commit} is pinned in upstream.json`,
			);
		}
	}

	const remoteUrl = tryGit(["config", "--get", `remote.${pin.remote}.url`], { cwd: repoRoot, timeoutMs });
	if (remoteUrl.ok && remoteUrl.value) state.remoteUrl = redactUrl(remoteUrl.value);

	return state;
}

function parseLsRemote(output) {
	const refs = new Map();
	for (const line of output.split("\n")) {
		// `--symref` prefixes a `ref: refs/heads/<branch>\tHEAD` line; it names the
		// default branch, not an object, so it must never land in the ref map.
		if (line.startsWith("ref:")) continue;
		const [sha, ref] = line.split("\t");
		if (!sha || !ref || !COMMIT_RE.test(sha.trim())) continue;
		refs.set(ref.trim(), sha.trim());
	}
	return refs;
}

/** A peeled ref (`^{}`) carries the commit an annotated tag points at. */
function resolveTagCommit(refs, tag) {
	return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
}

function inspectRemote(pin, timeoutMs) {
	const head = tryGit(["ls-remote", "--symref", pin.repository, "HEAD"], { timeoutMs });
	if (!head.ok) return { status: "unreachable", reason: head.reason };

	const tags = tryGit(["ls-remote", "--tags", pin.repository, "v*"], { timeoutMs });
	if (!tags.ok) return { status: "unreachable", reason: tags.reason };

	const headRefs = parseLsRemote(head.value);
	const symref = /^ref:\s+(\S+)\s+HEAD$/m.exec(head.value);
	const tagRefs = parseLsRemote(tags.value);

	let latest;
	for (const ref of tagRefs.keys()) {
		if (!ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
		const tag = ref.slice("refs/tags/".length);
		const version = parseTagVersion(tag);
		if (!version) continue;
		if (!latest || compareVersions(version, latest.version) > 0) {
			latest = { tag, version, commit: resolveTagCommit(tagRefs, tag) };
		}
	}

	const pinnedVersion = parseTagVersion(pin.tag, { allowPrerelease: true }) ?? [0, 0, 0];
	return {
		status: "ok",
		defaultBranch: symref ? symref[1].replace(/^refs\/heads\//, "") : null,
		headCommit: headRefs.get("HEAD") ?? null,
		pinnedTagCommit: resolveTagCommit(tagRefs, pin.tag),
		latestTag: latest ? { tag: latest.tag, commit: latest.commit } : null,
		newerThanPin: latest ? compareVersions(latest.version, pinnedVersion) > 0 : false,
	};
}

function buildReport(pin, local, remote, offline) {
	const violations = [...local.violations];
	const notes = [];

	if (!local.commitPresent) {
		notes.push(
			`pinned commit ${pin.commit} is not in this clone's object store; local verification was partial (shallow or origin-only checkout)`,
		);
	}
	if (local.tagCommit === null) {
		notes.push(`tag ${pin.tag} is not present locally; 'git fetch ${pin.remote} --tags' enables offline verification`);
	}
	if (local.remoteUrl === null) {
		notes.push(`no '${pin.remote}' git remote is configured in this clone`);
	}

	let updateAvailable = false;

	if (offline) {
		notes.push("offline mode: upstream was not contacted");
	} else if (remote.status === "unreachable") {
		notes.push(`upstream unreachable: ${remote.reason}`);
	} else {
		if (remote.pinnedTagCommit === null) {
			notes.push(`tag ${pin.tag} no longer exists upstream`);
		} else if (remote.pinnedTagCommit !== pin.commit) {
			violations.push(
				`upstream tag ${pin.tag} now resolves to ${remote.pinnedTagCommit}, but ${pin.commit} is pinned in upstream.json`,
			);
		}
		if (remote.newerThanPin && remote.latestTag) {
			updateAvailable = true;
			notes.push(
				`upstream released ${remote.latestTag.tag} (${remote.latestTag.commit ?? "unknown commit"}); the pin stays at ${pin.tag} until a human merges it`,
			);
		}
		if (remote.headCommit && remote.headCommit !== pin.commit && !updateAvailable) {
			notes.push(
				`upstream ${remote.defaultBranch ?? "HEAD"} is at ${remote.headCommit}, ahead of the pinned commit; informational only, no newer release tag`,
			);
		}
	}

	let status = "ok";
	if (violations.length > 0) status = "pin-mismatch";
	else if (updateAvailable) status = "update-available";
	else if (!offline && remote.status === "unreachable") status = "unknown";

	return {
		tool: "upstream-check",
		status,
		readOnly: true,
		checkedAt: new Date().toISOString(),
		pin: {
			repository: pin.repository,
			remote: pin.remote,
			tag: pin.tag,
			version: pin.version,
			commit: pin.commit,
		},
		local: {
			commitPresent: local.commitPresent,
			tagCommit: local.tagCommit,
			remoteUrl: local.remoteUrl,
		},
		upstream: offline ? { status: "skipped" } : remote,
		updateAvailable,
		violations,
		notes,
	};
}

function renderSummary(report) {
	const lines = [`## Upstream pin: ${report.status}`, ""];
	if (report.pin?.repository) lines.push(`- repository: \`${report.pin.repository}\``);
	if (report.pin?.tag) lines.push(`- pinned: \`${report.pin.tag}\` @ \`${report.pin.commit}\``);
	if (report.pin?.path) lines.push(`- pin file: \`${report.pin.path}\``);
	lines.push(`- update available: ${report.updateAvailable ? "yes" : "no"}`);
	lines.push("- read-only: never fetches, merges, publishes, releases, or opens a pull request");
	for (const violation of report.violations) lines.push(`- **violation**: ${violation}`);
	for (const note of report.notes) lines.push(`- note: ${note}`);
	lines.push("");
	return lines.join("\n");
}

function writeReports(report, options) {
	if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
	if (options.summary) appendFileSync(options.summary, renderSummary(report));
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	if (!isAbsolute(options.pin)) usage("--pin must resolve to an absolute path");

	let pin;
	try {
		pin = loadPin(options.pin);
	} catch (error) {
		if (!(error instanceof PinError)) throw error;
		const report = {
			tool: "upstream-check",
			status: "pin-invalid",
			readOnly: true,
			checkedAt: new Date().toISOString(),
			pin: { path: options.pin },
			updateAvailable: false,
			violations: [error.message],
			notes: [],
		};
		console.error(`upstream pin invalid: ${error.message}`);
		writeReports(report, options);
		return 1;
	}

	const repoRoot = dirname(options.pin);
	const local = inspectLocal(pin, repoRoot, options.timeoutMs);
	const remote = options.offline ? { status: "skipped" } : inspectRemote(pin, options.timeoutMs);
	const report = buildReport(pin, local, remote, options.offline);

	console.log(`upstream pin ${report.status}: ${report.pin.tag} @ ${report.pin.commit.slice(0, 9)}`);
	for (const violation of report.violations) console.error(`violation: ${violation}`);
	for (const note of report.notes) console.log(`note: ${note}`);
	writeReports(report, options);

	return report.violations.length > 0 ? 1 : 0;
}

process.exitCode = main();
