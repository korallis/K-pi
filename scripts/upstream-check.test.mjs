#!/usr/bin/env node

/**
 * Contract tests for `scripts/upstream-check.mjs`.
 *
 * Every fixture is a real local git repository reached over `file://`, so the
 * networked drift path is exercised without touching a network.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const checker = fileURLToPath(new URL("./upstream-check.mjs", import.meta.url));

const gitEnvironment = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "kpi fixture",
	GIT_AUTHOR_EMAIL: "fixture@kpi.invalid",
	GIT_COMMITTER_NAME: "kpi fixture",
	GIT_COMMITTER_EMAIL: "fixture@kpi.invalid",
};

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvironment }).trim();
}

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "kpi-upstream-check-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function makeRepository(root, name) {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	git(directory, "init", "-q", "-b", "main");
	return directory;
}

function commit(directory, message, contents) {
	writeFileSync(join(directory, "file.txt"), contents);
	git(directory, "add", "file.txt");
	git(directory, "commit", "-q", "-m", message);
	return git(directory, "rev-parse", "HEAD");
}

function writePin(directory, pin) {
	writeFileSync(join(directory, "upstream.json"), `${JSON.stringify(pin, null, 2)}\n`);
}

function basePin(overrides) {
	return {
		name: "pi",
		repository: "https://github.com/earendil-works/pi.git",
		remote: "upstream",
		version: "0.84.4",
		tag: "v0.84.4",
		commit: "b79e4cc834970cca69daebffab7df1da7d1e52c4",
		policy: { autoMerge: false, autoUpdate: false, publishToRegistry: false, driftCheck: "read-only" },
		...overrides,
	};
}

function runChecker(forkDirectory, extraArguments = []) {
	const reportPath = join(forkDirectory, "drift-report.json");
	const result = spawnSync(process.execPath, [checker, "--pin", join(forkDirectory, "upstream.json"), "--json", reportPath, ...extraArguments], {
		cwd: forkDirectory,
		encoding: "utf8",
		env: gitEnvironment,
	});
	const report = result.stdout !== null ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
	return { code: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

test("verified pin reports ok without contacting upstream", (t) => {
	const root = workspace(t);
	const fork = makeRepository(root, "fork");
	const pinned = commit(fork, "vendored pi", "pi\n");
	git(fork, "tag", "v0.84.4");
	writePin(fork, basePin({ commit: pinned }));

	const { code, report } = runChecker(fork, ["--offline"]);

	assert.equal(code, 0);
	assert.equal(report.status, "ok");
	assert.equal(report.readOnly, true);
	assert.equal(report.updateAvailable, false);
	assert.deepEqual(report.violations, []);
	assert.equal(report.local.tagCommit, pinned);
	assert.equal(report.upstream.status, "skipped");
});

test("local tag that no longer resolves to the pinned commit fails", (t) => {
	const root = workspace(t);
	const fork = makeRepository(root, "fork");
	commit(fork, "vendored pi", "pi\n");
	const moved = commit(fork, "local drift", "pi drifted\n");
	git(fork, "tag", "v0.84.4");
	writePin(fork, basePin({ commit: "b79e4cc834970cca69daebffab7df1da7d1e52c4" }));

	const { code, report } = runChecker(fork, ["--offline"]);

	assert.equal(code, 1);
	assert.equal(report.status, "pin-mismatch");
	assert.equal(report.violations.length, 1);
	assert.match(report.violations[0], new RegExp(moved));
});

test("malformed pin fails before any git work", (t) => {
	const root = workspace(t);
	const fork = makeRepository(root, "fork");
	commit(fork, "vendored pi", "pi\n");
	writePin(fork, basePin({ commit: "not-a-sha" }));

	const { code, report, stderr } = runChecker(fork, ["--offline"]);

	assert.equal(code, 1);
	assert.equal(report.status, "pin-invalid");
	assert.match(stderr, /40-character sha/);
});

test("a pin that authorizes automatic merging is invalid", (t) => {
	const root = workspace(t);
	const fork = makeRepository(root, "fork");
	commit(fork, "vendored pi", "pi\n");
	writePin(fork, basePin({ policy: { autoMerge: true } }));

	const { code, report } = runChecker(fork, ["--offline"]);

	assert.equal(code, 1);
	assert.equal(report.status, "pin-invalid");
	assert.match(report.violations[0], /autoMerge/);
});

test("upstream at the pinned release reports ok", (t) => {
	const root = workspace(t);
	const upstream = makeRepository(root, "upstream");
	const pinned = commit(upstream, "pi 0.84.4", "pi\n");
	git(upstream, "tag", "v0.84.4");

	const fork = makeRepository(root, "fork");
	commit(fork, "vendored pi", "pi\n");
	writePin(fork, basePin({ repository: pathToFileURL(upstream).href, commit: pinned }));

	const { code, report } = runChecker(fork);

	assert.equal(code, 0);
	assert.equal(report.status, "ok");
	assert.equal(report.upstream.status, "ok");
	assert.equal(report.upstream.pinnedTagCommit, pinned);
	assert.equal(report.updateAvailable, false);
});

test("a newer upstream release is reported, never applied", (t) => {
	const root = workspace(t);
	const upstream = makeRepository(root, "upstream");
	const pinned = commit(upstream, "pi 0.84.4", "pi\n");
	git(upstream, "tag", "v0.84.4");
	const released = commit(upstream, "pi 0.85.0", "pi next\n");
	git(upstream, "tag", "-a", "v0.85.0", "-m", "v0.85.0");
	const upstreamHeadBefore = git(upstream, "rev-parse", "HEAD");

	const fork = makeRepository(root, "fork");
	commit(fork, "vendored pi", "pi\n");
	writePin(fork, basePin({ repository: pathToFileURL(upstream).href, commit: pinned }));
	git(fork, "add", "upstream.json");
	git(fork, "commit", "-q", "-m", "pin upstream");
	const pinBefore = readFileSync(join(fork, "upstream.json"), "utf8");
	const forkHeadBefore = git(fork, "rev-parse", "HEAD");

	const { code, report } = runChecker(fork);

	assert.equal(code, 0);
	assert.equal(report.status, "update-available");
	assert.equal(report.updateAvailable, true);
	assert.deepEqual(report.violations, []);
	// Annotated tags must be peeled to the commit they point at.
	assert.deepEqual(report.upstream.latestTag, { tag: "v0.85.0", commit: released });

	// Read-only: no merge, no pin advance, no commit, no upstream mutation.
	assert.equal(readFileSync(join(fork, "upstream.json"), "utf8"), pinBefore);
	assert.equal(git(fork, "rev-parse", "HEAD"), forkHeadBefore);
	assert.equal(git(fork, "status", "--porcelain", "--", "upstream.json"), "");
	assert.equal(git(upstream, "rev-parse", "HEAD"), upstreamHeadBefore);
});

test("a moved upstream tag is a pin integrity failure", (t) => {
	const root = workspace(t);
	const upstream = makeRepository(root, "upstream");
	const pinned = commit(upstream, "pi 0.84.4", "pi\n");
	git(upstream, "tag", "v0.84.4");
	commit(upstream, "rewritten history", "pi rewritten\n");
	git(upstream, "tag", "-f", "v0.84.4");

	const fork = makeRepository(root, "fork");
	commit(fork, "vendored pi", "pi\n");
	writePin(fork, basePin({ repository: pathToFileURL(upstream).href, commit: pinned }));

	const { code, report } = runChecker(fork);

	assert.equal(code, 1);
	assert.equal(report.status, "pin-mismatch");
	assert.match(report.violations[0], /upstream tag v0\.84\.4 now resolves to/);
});

test("an unreachable upstream is fail-safe", (t) => {
	const root = workspace(t);
	const fork = makeRepository(root, "fork");
	const pinned = commit(fork, "vendored pi", "pi\n");
	writePin(fork, basePin({ repository: pathToFileURL(join(root, "does-not-exist.git")).href, commit: pinned }));

	const { code, report } = runChecker(fork);

	assert.equal(code, 0);
	assert.equal(report.status, "unknown");
	assert.equal(report.upstream.status, "unreachable");
	assert.deepEqual(report.violations, []);
});

test("credentials in a configured remote never reach the report", (t) => {
	const root = workspace(t);
	const fork = makeRepository(root, "fork");
	const pinned = commit(fork, "vendored pi", "pi\n");
	git(fork, "remote", "add", "upstream", "https://kpi:s3cr3t-token@github.com/earendil-works/pi.git");
	writePin(fork, basePin({ commit: pinned }));

	const { code, report, stdout } = runChecker(fork, ["--offline"]);

	assert.equal(code, 0);
	assert.equal(report.local.remoteUrl, "https://<redacted>@github.com/earendil-works/pi.git");
	assert.ok(!JSON.stringify(report).includes("s3cr3t-token"));
	assert.ok(!stdout.includes("s3cr3t-token"));
});
