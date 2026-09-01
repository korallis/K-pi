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
	cursorApiKey: ["CURSOR", "API_KEY"].join("_"),
};

function cleanManifest() {
	return {
		name: "kpi-fixture",
		private: true,
		scripts: Object.fromEntries(REQUIRED_SCRIPTS.map((name) => [name, `echo ${name}`])),
	};
}

/**
 * Builds a temp repository. workflows and scripts are name → contents; the
 * shipped check and Grok workflows are the baseline unless their omit flags
 * are set.
 */
function fixture(
	t,
	{
		workflows = {},
		scripts = {},
		manifest = cleanManifest(),
		omitCheckWorkflow = false,
		omitGrokWorkflow = false,
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "kpi-ci-contract-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const workflowDirectory = join(root, ".github", "workflows");
	mkdirSync(workflowDirectory, { recursive: true });
	if (!omitCheckWorkflow) copyFileSync(workflowPath("check.yml"), join(workflowDirectory, "check.yml"));
	if (!omitGrokWorkflow) copyFileSync(workflowPath("grok-review.yml"), join(workflowDirectory, "grok-review.yml"));
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

/** The reviewed Grok gate: read-only inference plus one PR comment. */
function grokWorkflow({ extraStep = "", permissions = "      contents: read\n      pull-requests: write\n" } = {}) {
	return `name: grok-review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
${permissions}    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
${extraStep}      - run: gh api repos/example/repo/issues/1/comments --method POST
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

test("the Grok gate may post its read-only PR result", (t) => {
	assert.deepEqual(inspectForkIntegrity(fixture(t, { workflows: { "grok-review.yml": grokWorkflow() } })), []);
});

test("the Grok gate may not gain contents write", (t) => {
	const root = fixture(t, {
		workflows: {
			"grok-review.yml": grokWorkflow({
				permissions: "      contents: write\n      pull-requests: write\n",
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		'.github/workflows/grok-review.yml: forbidden write permission "contents: write"',
	]);
});


test("shipped check workflow requires same-repository PR heads on self-hosted", () => {
	const check = readFileSync(workflowPath("check.yml"), "utf8");
	assert.match(
		check,
		/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
	);
	assert.match(check, /github\.event\.pull_request\.draft\s*==\s*false/);
	assert.match(check, /github\.event_name\s*!=\s*'pull_request'/);
	assert.doesNotMatch(check, /^[ \t]*pull_request_target[ \t]*:/m);
	assert.match(
		check,
		/maintainer-owned branch|External fork contributions require a maintainer-owned branch/i,
	);
});

test("check workflow missing same-repository guard fails the contract", (t) => {
	const broken = `name: check
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  schedule:
    - cron: "0 4 * * *"
  workflow_dispatch:
jobs:
  check:
    runs-on: [self-hosted, macOS]
    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false
    steps:
      - run: echo ok
`;
	const root = fixture(t, {
		omitCheckWorkflow: true,
		workflows: { "check.yml": broken },
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/check.yml: self-hosted check job must require same-repository PR heads (github.event.pull_request.head.repo.full_name == github.repository)",
	]);
});

test("check workflow that drops non-PR event preservation fails the contract", (t) => {
	const broken = `name: check
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  check:
    runs-on: [self-hosted, macOS]
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - run: echo ok
`;
	const root = fixture(t, {
		omitCheckWorkflow: true,
		workflows: { "check.yml": broken },
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/check.yml: self-hosted check job must preserve non-pull_request events (github.event_name != 'pull_request')",
	]);
});

test("floating third-party action tags fail closed", (t) => {
	const root = fixture(t, {
		workflows: {
			"nightly.yml": readOnlyWorkflow(`    steps:
      - uses: actions/checkout@v7
      - run: echo ok
`),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/nightly.yml: third-party action must be pinned to a full commit SHA (got actions/checkout@v7)",
	]);
});

test("pinned third-party action SHAs with version comments are accepted", (t) => {
	const root = fixture(t, {
		workflows: {
			"nightly.yml": readOnlyWorkflow(`    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - run: echo ok
`),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), []);
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
				extraStep: "      - uses: softprops/action-gh-release@0000000000000000000000000000000000000001\n",
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/auto-merge.yml: forbidden release automation"]);
});

test("GitHub release commands are rejected inside the Grok gate", (t) => {
	const root = fixture(t, {
		workflows: { "grok-review.yml": grokWorkflow({ extraStep: "      - run: gh release edit v1 --draft=false\n" }) },
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/grok-review.yml: forbidden GitHub release automation",
	]);
});

test("registry credentials are rejected inside the Grok gate", (t) => {
	const root = fixture(t, {
		workflows: {
			"grok-review.yml": grokWorkflow({
				extraStep: '      - run: echo "' + ASSEMBLED.registryCredential + ' unused"\n',
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/grok-review.yml: forbidden registry credential"]);
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

test("pushing is rejected from every workflow", (t) => {
	const root = fixture(t, {
		workflows: { "nightly.yml": readOnlyWorkflow("    steps:\n      - run: git push origin HEAD:refs/heads/main\n") },
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/nightly.yml: forbidden workflow that pushes"]);
});

test("the Grok gate may neither push nor rewrite history", (t) => {
	const root = fixture(t, {
		workflows: {
			"grok-review.yml": grokWorkflow({
				extraStep: "      - run: git push origin HEAD\n      - run: git rebase origin/main\n",
			}),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/grok-review.yml: forbidden workflow that pushes",
		".github/workflows/grok-review.yml: forbidden workflow that rewrites history",
	]);
});

test("the obsolete Cursor workflow path is rejected", (t) => {
	const root = fixture(t, { workflows: { "cursor-review.yml": readOnlyWorkflow("    steps:\n      - run: echo old\n") } });
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/cursor-review.yml: obsolete Cursor review workflow must not exist",
	]);
});

test("obsolete Cursor credentials are rejected in workflows", (t) => {
	const root = fixture(t, {
		workflows: {
			"nightly.yml": readOnlyWorkflow(
				'    steps:\n      - run: echo "' + ASSEMBLED.cursorApiKey + ' is obsolete"\n',
			),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [".github/workflows/nightly.yml: forbidden obsolete Cursor credential"]);
});

test("CI workflows may not depend on 1Password at runtime", (t) => {
	const root = fixture(t, {
		workflows: {
			"nightly.yml": readOnlyWorkflow("    steps:\n      - run: op read secret-reference\n"),
		},
	});
	assert.deepEqual(inspectForkIntegrity(root), [
		".github/workflows/nightly.yml: forbidden runtime 1Password dependency",
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

test("losing the Grok gate workflow is a violation", (t) => {
	assert.deepEqual(inspectForkIntegrity(fixture(t, { omitGrokWorkflow: true })), [
		".github/workflows/grok-review.yml: required gate workflow is missing (nothing runs the gates above)",
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
	assert.match(result.stderr, /grok-review\.yml: posts one read-only Grok review result/);
});
