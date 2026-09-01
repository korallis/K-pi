#!/usr/bin/env node

/**
 * Contract tests for `scripts/check-ci-contract.mjs`.
 *
 * Every case is a real temporary repository: a clean baseline (root manifest with
 * the gates CI invokes, plus the shipped `check` workflow the guard requires)
 * with the workflow or script under test dropped in. What the guard is *for* is
 * which escalations it lets through, so accepted cases assert zero violations and
 * rejected cases assert the exact message — a rule that fires for the wrong
 * reason is a broken rule.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspectForkIntegrity } from "./check-ci-contract.mjs";

const guardPath = fileURLToPath(new URL("./check-ci-contract.mjs", import.meta.url));
const repoRoot = dirname(dirname(guardPath));
const workflowPath = (name) => join(repoRoot, ".github", "workflows", name);

/** Mirrors the guard's REQUIRED_ROOT_SCRIPTS so a fixture manifest is clean. */
const REQUIRED_SCRIPTS = ["build", "build:offline", "check", "test", "test:kpi", "kstack:sync:check", "upstream:check"];

/**
 * Strings this file must feed the guard but must not contain verbatim: the guard
 * also scans root `scripts/`, and a literal here would flag this test instead of
 * the fixture. Assembling them at runtime keeps that scan's coverage complete.
 */
const ASSEMBLED = {
	registryCredential: ["NPM", "TOKEN"].join("_"),
	npmPublish: ["npm", "publish"].join(" "),
	registryHost: ["registry", "npmjs", "org"].join("."),
};

function cleanManifest() {
	return {
		name: "kpi-fixture",
		private: true,
		scripts: Object.fromEntries(REQUIRED_SCRIPTS.map((name) => [name, `echo ${name}`])),
	};
}

/**
 * Builds a temp repository. `workflows` and `scripts` are name → contents; the
 * shipped `check.yml` is the baseline gate unless `omitCheckWorkflow` is set.
 */
function fixture(t, { workflows = {}, scripts = {}, manifest = cleanManifest(), omitCheckWorkflow = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "kpi-ci-contract-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const workflowDirectory = join(root, ".github", "workflows");
	mkdirSync(workflowDirectory, { recursive: true });
	if (!omitCheckWorkflow) copyFileSync(workflowPath("check.yml"), join(workflowDirectory, "check.yml"));
	for (const [name, contents] of Object.entries(workflows)) {
		writeFileSync(join(workflowDirectory, name), contents);
	}
	if (Object.keys(scripts).length > 0) {
		mkdirSync(join(root, "scripts"), { recursive: true });
		for (const [name, contents] of Object.entries(scripts)) {
			writeFileSync(join(root, "scripts", name), contents);
		}
	}
	return root;
}

/** The reviewed auto-merge workflow, parameterized on the merge command. */
function autoMergeWorkflow(
	command,
	{ extraStep = "", permissions = "      contents: write\n      pull-requests: write\n" } = {},
) {
	return `name: auto-merge
on:
  pull_request:
    types: [opened, reopened, ready_for_review]
permissions: {}
jobs:
  enable:
    runs-on: ubuntu-latest
    permissions:
${permissions}    steps:
${extraStep}      - run: ${command}
`;
}

/** The reviewed Cursor pipeline: write token, autofix push, PR comments. */
function cursorWorkflow({ extraStep = "" } = {}) {
	return `name: cursor-review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  pipeline:
    runs-on: [self-hosted, macOS]
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
      - run: gh pr comment "$PR_NUMBER" --body-file /tmp/report.md
${extraStep}      - run: git push origin "HEAD:refs/heads/$HEAD_REF"
`;
}

const readOnlyWorkflow = (body) => `name: nightly
on:
  workflow_dispatch:
jobs:
  run:
    runs-on: [self-hosted, macOS]
${body}`;

test("the repository this guard ships in passes it", () => {
	assert.deepEqual(inspectForkIntegrity(repoRoot), []);
});

test("baseline fixture with only the shipped gate is clean", (t) => {
	assert.deepEqual(inspectForkIntegrity(fixture(t)), []);
});

test("the shipped auto-merge workflow is accepted", (t) => {
	const root = fixture(t, { workflows: { "auto-merge.yml": readFileSync(workflowPath("auto-merge.yml"), "utf8") } });
	assert.deepEqual(inspectForkIntegrity(root), []);
});

test("auto-merge may queue a merge and hold the write permissions it needs", (t) => {
	const root = fixture(t, { workflows: { "auto-merge.yml": autoMergeWorkflow('gh pr merge --auto --merge "$PR_URL"') } });
	assert.deepEqual(inspectForkIntegrity(root), []);
});

test("the Cursor pipeline may push its autofix commit with contents/pull-requests write", (t) => {
	assert.deepEqual(inspectForkIntegrity(fixture(t, { workflows: { "cursor-review.yml": cursorWorkflow() } })), []);
});

test("a merge that does not wait for checks is rejected", (t) => {
	const root = fixture(t, { workflows: { "auto-merge.yml": autoMergeWorkflow('gh pr merge --merge "$PR_URL"') } });
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/auto-merge.yml: forbidden merge that does not wait for checks (`gh pr merge` without --auto)",
	]);
});

test("auto-merge may not bypass required checks with --admin", (t) => {
	const root = fixture(t, {
		workflows: { "auto-merge.yml": autoMergeWorkflow('gh pr merge --auto --admin --merge "$PR_URL"') },
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/auto-merge.yml: forbidden merge that bypasses required checks (--admin)",
	]);
});

test("merge automation and write tokens stay rejected in an unapproved workflow", (t) => {
	const root = fixture(t, { workflows: { "merge-queue.yml": autoMergeWorkflow('gh pr merge --auto --merge "$PR_URL"') } });
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/merge-queue.yml: forbidden PR merge automation",
		'.github/workflows/merge-queue.yml: forbidden write permission "contents: write"',
		'.github/workflows/merge-queue.yml: forbidden write permission "pull-requests: write"',
	]);
});

test("write permissions in an unapproved workflow are rejected key by key", (t) => {
	const root = fixture(t, {
		workflows: {
			"nightly.yml": readOnlyWorkflow(
				"    permissions:\n      contents: write\n      issues: write\n    steps:\n      - run: echo hi\n",
			),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		'.github/workflows/nightly.yml: forbidden write permission "contents: write"',
		'.github/workflows/nightly.yml: forbidden write permission "issues: write"',
	]);
});

test("an approved workflow may not widen past the write permissions it was granted", (t) => {
	const root = fixture(t, {
		workflows: {
			"auto-merge.yml": autoMergeWorkflow('gh pr merge --auto --merge "$PR_URL"', {
				permissions: "      contents: write\n      pull-requests: write\n      issues: write\n",
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		'.github/workflows/auto-merge.yml: forbidden write permission "issues: write"',
	]);
});

test("release automation is rejected inside an approved workflow", (t) => {
	const root = fixture(t, {
		workflows: {
			"auto-merge.yml": autoMergeWorkflow('gh pr merge --auto --merge "$PR_URL"', {
				extraStep: "      - uses: softprops/action-gh-release@v2\n",
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/auto-merge.yml: forbidden release automation"]);
});

test("gh release commands are rejected inside an approved workflow", (t) => {
	const root = fixture(t, {
		workflows: { "cursor-review.yml": cursorWorkflow({ extraStep: "      - run: gh release edit v1 --draft=false\n" }) },
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/cursor-review.yml: forbidden GitHub release automation",
	]);
});

test("registry credentials are rejected inside an approved workflow", (t) => {
	const root = fixture(t, {
		workflows: {
			"cursor-review.yml": cursorWorkflow({
				extraStep: `      - run: echo "${ASSEMBLED.registryCredential} unused"\n`,
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/cursor-review.yml: forbidden registry credential"]);
});

test("a registry publish target is rejected inside an approved workflow", (t) => {
	const root = fixture(t, {
		workflows: {
			"auto-merge.yml": autoMergeWorkflow('gh pr merge --auto --merge "$PR_URL"', {
				extraStep: `      - run: npm config set registry https://${ASSEMBLED.registryHost}/\n`,
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/auto-merge.yml: forbidden npm registry target"]);
});

test("the privileged pull-request trigger is rejected", (t) => {
	const workflow = `name: mirror
on:
  pull_request_target:
    types: [opened]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
	const root = fixture(t, { workflows: { "mirror.yml": workflow } });
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/mirror.yml: forbidden pull_request_target trigger"]);
});

test("a workflow may document that it refuses the privileged trigger", (t) => {
	const workflow = `# pull_request, never pull_request_target: no write token for fork code.
name: mirror
on:
  pull_request:
    types: [opened]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
	assert.deepEqual(inspectForkIntegrity(fixture(t, { workflows: { "mirror.yml": workflow } })), []);
});

test("pushing is rejected outside the Cursor pipeline", (t) => {
	const root = fixture(t, {
		workflows: { "nightly.yml": readOnlyWorkflow("    steps:\n      - run: git push origin HEAD:refs/heads/main\n") },
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/nightly.yml: forbidden workflow that pushes"]);
});

test("the push exemption does not let the Cursor pipeline rewrite history", (t) => {
	const root = fixture(t, {
		workflows: { "cursor-review.yml": cursorWorkflow({ extraStep: "      - run: git rebase origin/main\n" }) },
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/cursor-review.yml: forbidden workflow that rewrites history",
	]);
});

test("publish machinery is rejected in root scripts", (t) => {
	const root = fixture(t, {
		scripts: { "ship.mjs": `#!/usr/bin/env node\nexecSync("${ASSEMBLED.npmPublish} --access public");\n` },
	});
	// The guard's label for this rule is the command itself, so assemble it too.
	assert.deepEqual(inspectForkIntegrity(root), [`scripts/ship.mjs: forbidden ${ASSEMBLED.npmPublish}`]);
});

test("losing the gate workflow is a violation", (t) => {
	assert.deepEqual(inspectForkIntegrity(fixture(t, { omitCheckWorkflow: true })), [
		".github/workflows/check.yml: required gate workflow is missing (nothing runs the gates above)",
	]);
});

test("a gate the workflow invokes must exist as a root script", (t) => {
	const manifest = cleanManifest();
	delete manifest.scripts["kstack:sync:check"];
	assert.deepEqual(inspectForkIntegrity(fixture(t, { manifest })), [
		'package.json: missing required script "kstack:sync:check" (CI invokes it)',
	]);
});

/** Runs the guard's CLI against a fixture by copying it in, so argv and exit codes are real. */
function runGuard(root) {
	mkdirSync(join(root, "scripts"), { recursive: true });
	const copied = join(root, "scripts", "check-ci-contract.mjs");
	copyFileSync(guardPath, copied);
	return spawnSync(process.execPath, [copied], { encoding: "utf8" });
}

test("the CLI exits 0 and says so on a clean repository", (t) => {
	const root = fixture(t, { workflows: { "auto-merge.yml": autoMergeWorkflow('gh pr merge --auto --merge "$PR_URL"') } });
	const result = runGuard(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /fork integrity ok:/);
	assert.match(result.stdout, /2 reviewed write exemptions/);
});

test("the CLI exits 1 and names the violation and the reviewed exemptions", (t) => {
	const root = fixture(t, { workflows: { "auto-merge.yml": autoMergeWorkflow('gh pr merge --merge "$PR_URL"') } });
	const result = runGuard(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /fork integrity check failed:/);
	assert.match(result.stderr, /auto-merge\.yml: forbidden merge that does not wait for checks/);
	assert.match(result.stderr, /auto-merge\.yml: asks GitHub to merge only after required checks pass/);
	assert.match(result.stderr, /cursor-review\.yml: reviewed Cursor pipeline/);
});
