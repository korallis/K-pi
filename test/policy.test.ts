import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ToolCallEvent, ToolCallEventResult } from "../packages/coding-agent/src/core/extensions/types.ts";
import {
	type ActivePolicyState,
	DEFAULT_ACTIVE_POLICY_STATE,
	type DiffStatReader,
	ensurePolicyFile,
	evaluateToolCall,
	parseDiffStat,
	type PolicyConfig,
	type PolicyRegistrationOptions,
	readGitDiffStat,
	registerPolicy,
	resolveActivePolicyState,
} from "../packages/coding-agent/src/kpi/extensions/policy.ts";

const execFile = promisify(execFileCallback);

const policy: PolicyConfig = {
	deny: ["git push", "git push --force", "git reset --hard", "rm -rf", "chmod 777"],
	commit: { gated: "confirm", autopilot: "after-release" },
	unknown: { gated: "confirm", autopilot: "deny" },
};

const cwd = "/fixture";
const gated: ActivePolicyState = {
	mode: "gated",
	releaseApproved: false,
	writeAllow: ["src/**", "test/**"],
	qualityGates: ["npm test", "npm run lint -- --max-warnings 0"],
};
const autopilot: ActivePolicyState = { ...gated, mode: "autopilot" };
const stubDiffStat: DiffStatReader = () => ({ filesChanged: 3, insertions: 12, deletions: 4 });

function bash(command: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "bash",
		input: { command },
	};
}

function write(path: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-1",
		toolName: "write",
		input: { path, content: "fixture" },
	};
}

function decide(event: ToolCallEvent, active: ActivePolicyState = gated) {
	return evaluateToolCall(event, { active, cwd, policy, readDiffStat: stubDiffStat });
}

type Hook = (
	event: ToolCallEvent,
	context: {
		cwd: string;
		ui: { confirm: (title: string, question: string) => Promise<boolean> };
	},
) => Promise<ToolCallEventResult | undefined>;

/** The registered hook, exactly as the harness would call it. */
function policyHook(options: PolicyRegistrationOptions): Hook {
	let hook: Hook | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "tool_call") {
				hook = handler as Hook;
			}
		},
	};
	registerPolicy(pi as unknown as Parameters<typeof registerPolicy>[0], options);
	assert.ok(hook, "registerPolicy must register a tool_call hook");
	return hook;
}

function operator(directory: string, answer: boolean) {
	const prompts: string[] = [];
	return {
		prompts,
		context: {
			cwd: directory,
			ui: {
				confirm: async (title: string, question: string) => {
					prompts.push(`${title}\n${question}`);
					return answer;
				},
			},
		},
	};
}

async function withProject(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-policy-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function git(directory: string, ...args: string[]): Promise<void> {
	await execFile("git", args, { cwd: directory });
}

async function seedRepository(directory: string, content: string): Promise<void> {
	await git(directory, "init");
	await git(directory, "config", "user.email", "fixture@example.test");
	await git(directory, "config", "user.name", "Fixture");
	await writeFile(join(directory, "tracked.txt"), content);
	await git(directory, "add", "-A");
	await git(directory, "commit", "-m", "chore: seed");
}

test("git push origin main is denied", async () => {
	const decision = await decide(bash("git push origin main"));
	assert.equal(decision.kind, "deny");
});

test("recursive forced removal is denied", async () => {
	assert.equal((await decide(bash("rm -rf /"))).kind, "deny");
	assert.equal((await decide(bash("rm --recursive --force /"))).kind, "deny");
});

test("production deploy commands are denied", async () => {
	assert.equal((await decide(bash("kubectl apply -f production.yaml"))).kind, "deny");
	assert.equal((await decide(bash("npm publish"))).kind, "deny");
});

test("new dependency commands are denied", async () => {
	assert.equal((await decide(bash("npm install left-pad"))).kind, "deny");
	assert.equal((await decide(bash("pnpm add left-pad"))).kind, "deny");
});

test("a denied command stays denied in autopilot", async () => {
	assert.equal((await decide(bash("git push --force origin main"), autopilot)).kind, "deny");
	assert.equal((await decide(bash("rm -rf ."), autopilot)).kind, "deny");
});

test("writes to .env are denied even when the path is allowlisted", async () => {
	const decision = await evaluateToolCall(write("src/.env"), {
		active: { ...gated, writeAllow: ["src/**"] },
		cwd,
		policy,
	});
	assert.equal(decision.kind, "deny");
});

test("writes inside write_allow are allowed", async () => {
	assert.deepEqual(await decide(write("src/fixture.ts")), { kind: "allow" });
});

test("writes outside write_allow are denied", async () => {
	assert.equal((await decide(write("package.json"))).kind, "deny");
});

test("implementer tools cannot write the reviewer verdict", async () => {
	const decision = await evaluateToolCall(write("/fixture/.kpi/runs/job-1/verdict.json"), {
		active: { ...gated, writeAllow: [".kpi/runs/**"] },
		cwd,
		policy,
	});
	assert.equal(decision.kind, "deny");
	assert.match(decision.kind === "deny" ? decision.reason : "", /reserved verdict\.json for the reviewer/u);
});

test("implementer tools cannot write deterministic release approval", async () => {
	const decision = await evaluateToolCall(write("/fixture/.kpi/runs/job-1/release.approved"), {
		active: { ...gated, writeAllow: [".kpi/runs/**"] },
		cwd,
		policy,
	});
	assert.equal(decision.kind, "deny");
	assert.match(
		decision.kind === "deny" ? decision.reason : "",
		/reserved release\.approved for the release\.set node/u,
	);
});

test("the ship marker is control-plane state on every mutation path", async () => {
	const active: ActivePolicyState = { ...gated, writeAllow: [".kpi/runs/**", "**"] };
	// The record of the one commit decision. A node that could write it could make
	// the loop skip shipping and still be accepted as done.
	const decision = await evaluateToolCall(write("/fixture/.kpi/runs/job-1/ship.json"), { active, cwd, policy });
	assert.equal(decision.kind, "deny");
	assert.match(decision.kind === "deny" ? decision.reason : "", /reserved ship\.json for the control plane/u);

	for (const command of [
		'echo "{}" > .kpi/runs/job-1/ship.json',
		"touch .kpi/runs/job-1/ship.json",
		"cat forged.json | tee .kpi/runs/job-1/ship.json",
		"cp /tmp/forged.json .kpi/runs/job-1/ship.json",
		"sh -c 'echo x > .kpi/runs/job-1/ship.json'",
		"rm .kpi/runs/job-1/ship.json",
		"git checkout HEAD -- .kpi/runs/job-1/ship.json",
	]) {
		for (const state of [active, { ...active, mode: "autopilot" as const }]) {
			const shellDecision = await evaluateToolCall(bash(command), { active: state, cwd, policy });
			assert.equal(shellDecision.kind, "deny", `${state.mode}: ${command}`);
			assert.match(
				shellDecision.kind === "deny" ? shellDecision.reason : "",
				/reserved [^\s]*ship\.json for the control plane/u,
				command,
			);
		}
	}
});

test("the authoritative knowledge graph is denied to write and edit", async () => {
	const active: ActivePolicyState = { ...gated, writeAllow: ["**"] };
	for (const path of [".kpi/kg/nodes.jsonl", ".kpi/kg/edges.jsonl", ".kpi/kg/sources.jsonl"]) {
		const decision = await evaluateToolCall(write(path), { active, cwd, policy });
		assert.equal(decision.kind, "deny", path);
		assert.match(
			decision.kind === "deny" ? decision.reason : "",
			/reserved the authoritative knowledge graph for the control plane/u,
			path,
		);
	}
	assert.deepEqual(
		await evaluateToolCall(write(".kpi/kg/inbox/patch.json"), { active, cwd, policy }),
		{ kind: "allow" },
		"a proposal is the one knowledge graph path a worker keeps",
	);
});

test("a shell command that names a reserved path is denied, never confirmed", async () => {
	const active: ActivePolicyState = { ...gated, writeAllow: ["**"] };
	const shellAttempts = [
		'echo "{}" > .kpi/kg/nodes.jsonl',
		"echo '{}' >> .kpi/kg/nodes.jsonl",
		"cat patch.json | tee .kpi/kg/edges.jsonl",
		"rm .kpi/kg/sources.jsonl",
		"mv /tmp/forged.jsonl .kpi/kg/nodes.jsonl",
		"sed -i '' -e 's/proposed/verified/' .kpi/kg/nodes.jsonl",
		"truncate -s 0 .kpi/kg/snapshots/2026-01-01/nodes.jsonl",
		"git checkout HEAD -- .kpi/kg/nodes.jsonl",
		"printf x >.kpi/kg/nodes.jsonl",
	];
	for (const command of shellAttempts) {
		for (const state of [active, { ...active, mode: "autopilot" as const }]) {
			const decision = await evaluateToolCall(bash(command), { active: state, cwd, policy });
			assert.equal(decision.kind, "deny", `${state.mode}: ${command}`);
			assert.match(
				decision.kind === "deny" ? decision.reason : "",
				/reserved .*for the knowledge graph control plane/u,
				command,
			);
		}
	}

	for (const command of [
		'echo "{}" > .kpi/runs/job-1/verdict.json',
		"touch .kpi/runs/job-1/release.approved",
		"git status && echo ok > .kpi/runs/job-1/verdict.json",
	]) {
		const decision = await evaluateToolCall(bash(command), { active, cwd, policy });
		assert.equal(decision.kind, "deny", command);
		assert.match(
			decision.kind === "deny" ? decision.reason : "",
			/reserved .*for (?:the reviewer|the release\.set node)/u,
			command,
		);
	}

	// A proposal written through the shell is still just a proposal.
	assert.equal((await evaluateToolCall(bash('echo "{}" > .kpi/kg/inbox/patch.json'), { active, cwd, policy })).kind, "confirm");
	// A declared quality gate cannot launder a reserved target.
	const gateActive: ActivePolicyState = { ...active, qualityGates: ["npm test > .kpi/kg/nodes.jsonl"] };
	assert.equal((await evaluateToolCall(bash("npm test > .kpi/kg/nodes.jsonl"), { active: gateActive, cwd, policy })).kind, "deny");
});

test("only the reserved run artifact names are protected", async () => {
	const active: ActivePolicyState = { ...gated, writeAllow: [".kpi/runs/**", ".pi/runs/**"] };
	for (const path of [
		"/fixture/.kpi/runs/job-1/candidate.json",
		"/fixture/.kpi/runs/job-1/my-verdict.json",
		"/fixture/.kpi/runs/verdict.json",
		"/fixture/.pi/runs/job-1/verdict.json",
	]) {
		assert.deepEqual(await evaluateToolCall(write(path), { active, cwd, policy }), { kind: "allow" }, path);
	}
});

test("exact non-mutating inspection commands are allowed in both modes", async () => {
	for (const command of [
		"ls",
		"ls -la",
		"pwd",
		"git status",
		"git status --short",
		"git diff",
		"git diff --stat",
		"git diff HEAD",
		"git log",
		"git log --oneline",
		"git branch --show-current",
	]) {
		assert.deepEqual(await decide(bash(command)), { kind: "allow" }, command);
		assert.deepEqual(await decide(bash(command), autopilot), { kind: "allow" }, command);
	}
});

test("the safe list is exact, not a prefix match", async () => {
	for (const command of ["git log --oneline --all", "git diff --stat -- src", "ls -la /etc", "git status; whoami"]) {
		assert.equal((await decide(bash(command))).kind, "confirm", command);
		assert.equal((await decide(bash(command), autopilot)).kind, "deny", command);
	}
});

test("exact task quality gates are allowed and never prompt", async () => {
	assert.deepEqual(await decide(bash("npm test")), { kind: "allow" });
	assert.deepEqual(await decide(bash("  npm   test  ")), { kind: "allow" });
	assert.deepEqual(await decide(bash("npm run lint -- --max-warnings 0"), autopilot), { kind: "allow" });
	assert.equal((await decide(bash("npm test -- --watch"))).kind, "confirm");
});

test("a chained command is never safe, even when the chain is the declared gate", async () => {
	const active: ActivePolicyState = { ...gated, qualityGates: ["npm test && npm run lint"] };
	assert.equal((await decide(bash("npm test && npm run lint"), active)).kind, "confirm");
	assert.equal((await decide(bash("npm test && npm run lint"), { ...active, mode: "autopilot" })).kind, "deny");
	assert.equal((await decide(bash("git status && ls -la"))).kind, "confirm");
	// A chain that touches a secret is denied outright: an operator cannot make
	// reading a credential file legal by approving it.
	assert.equal((await decide(bash("git status && cat .env"))).kind, "deny");
	assert.equal((await decide(bash("ls | tee /tmp/out"), autopilot)).kind, "deny");
});

test("gated git commit confirms and states the current HEAD diff stat", async () => {
	const decision = await decide(bash('git commit -m "feat(policy): gate commits"'));
	assert.equal(decision.kind, "confirm");
	if (decision.kind !== "confirm") return;
	assert.match(decision.question, /3 files changed/u);
	assert.match(decision.question, /12 insertions\(\+\)/u);
	assert.match(decision.question, /4 deletions\(-\)/u);
	assert.match(decision.question, /git commit -m "feat\(policy\): gate commits"/u);
});

test("a chained git commit is not the standalone commit case", async () => {
	assert.equal((await decide(bash("git add -A && git commit -m 'chore: x'"))).kind, "confirm");
	assert.equal((await decide(bash("git add -A && git commit -m 'chore: x'"), autopilot)).kind, "deny");
});

test("autopilot git commit is denied before release and allowed after", async () => {
	const before = await decide(bash('git commit -m "feat: ship"'), autopilot);
	assert.equal(before.kind, "deny");
	assert.match(before.kind === "deny" ? before.reason : "", /before release\.approved/u);
	assert.deepEqual(await decide(bash('git commit -m "feat: ship"'), { ...autopilot, releaseApproved: true }), {
		kind: "allow",
	});
});

test("unknown commands confirm in gated and are denied in autopilot", async () => {
	const confirmed = await decide(bash("curl https://example.test"));
	assert.equal(confirmed.kind, "confirm");
	const denied = await decide(bash("curl https://example.test"), autopilot);
	assert.equal(denied.kind, "deny");
	assert.match(denied.kind === "deny" ? denied.reason : "", /unrecognized command/u);
});

test("without an active job the resolved state is gated, unreleased, and unbounded", () => {
	assert.deepEqual(DEFAULT_ACTIVE_POLICY_STATE, {
		mode: "gated",
		releaseApproved: false,
		writeAllow: [],
		qualityGates: [],
	});
});

test("a diff stat reports every field git omits as an explicit zero", () => {
	assert.deepEqual(parseDiffStat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n"), {
		filesChanged: 3,
		insertions: 12,
		deletions: 4,
	});
	assert.deepEqual(parseDiffStat(" 1 file changed, 2 deletions(-)\n"), {
		filesChanged: 1,
		insertions: 0,
		deletions: 2,
	});
	assert.deepEqual(parseDiffStat(" 1 file changed, 1 insertion(+)\n"), {
		filesChanged: 1,
		insertions: 1,
		deletions: 0,
	});
	assert.deepEqual(parseDiffStat(""), { filesChanged: 0, insertions: 0, deletions: 0 });
});

test("the production diff stat is the real current HEAD diff, read straight from git", async () => {
	await withProject(async (directory) => {
		await seedRepository(directory, "one\ntwo\nthree\n");
		assert.deepEqual(await readGitDiffStat(directory), { filesChanged: 0, insertions: 0, deletions: 0 });

		await writeFile(join(directory, "tracked.txt"), "one\ntwo\nthree\nfour\n");
		assert.deepEqual(await readGitDiffStat(directory), { filesChanged: 1, insertions: 1, deletions: 0 });

		await writeFile(join(directory, "tracked.txt"), "one\ntwo\n");
		assert.deepEqual(await readGitDiffStat(directory), { filesChanged: 1, insertions: 0, deletions: 1 });

		assert.deepEqual(await readGitDiffStat(join(directory, "not-a-repository")), {
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
		});
	});
});

test("the default policy is copied without replacing consumer changes", async () => {
	await withProject(async (directory) => {
		const path = await ensurePolicyFile(directory);
		const copied = JSON.parse(await readFile(path, "utf8")) as PolicyConfig;
		assert.ok(copied.deny.includes("git push"));

		await writeFile(path, '{"deny":["consumer rule"]}\n');
		await ensurePolicyFile(directory);
		assert.equal(await readFile(path, "utf8"), '{"deny":["consumer rule"]}\n');
	});
});

test("the registered hook keeps every AC-13.1 denial", async () => {
	const hook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
	await withProject(async (directory) => {
		const { context, prompts } = operator(directory, true);
		for (const command of ["git push origin main", "rm -rf /", "kubectl apply -f production.yaml", "npm install x"]) {
			assert.equal((await hook(bash(command), context))?.block, true, command);
		}
		for (const path of [
			"outside.ts",
			"src/.env",
			join(directory, ".kpi", "runs", "job-1", "verdict.json"),
			join(directory, ".kpi", "runs", "job-1", "release.approved"),
		]) {
			assert.equal((await hook(write(path), context))?.block, true, path);
		}
		assert.equal(await hook(write("src/fixture.ts"), context), undefined);
		assert.deepEqual(prompts, [], "denials and permitted writes never reach the operator");
	});
});

test("the registered hook blocks a bash attempt to mutate the knowledge graph, and the file stays put", async () => {
	await withProject(async (directory) => {
		const kgDirectory = join(directory, ".kpi", "kg");
		await mkdir(join(kgDirectory, "inbox"), { recursive: true });
		const nodes = join(kgDirectory, "nodes.jsonl");
		const authoritative = `${JSON.stringify({ id: "claim", rev: 1, status: "verified" })}\n`;
		await writeFile(nodes, authoritative);

		for (const active of [gated, autopilot]) {
			// Bounds wide enough that only the one-writer reservation can deny.
			const hook = policyHook({
				resolveActiveState: () => ({ ...active, writeAllow: ["**"] }),
				readDiffStat: stubDiffStat,
			});
			const { context, prompts } = operator(directory, true);

			for (const command of [
				`echo forged > ${nodes}`,
				"echo forged > .kpi/kg/nodes.jsonl",
				"rm .kpi/kg/nodes.jsonl",
				"git status && echo forged >> .kpi/kg/nodes.jsonl",
			]) {
				const result = await hook(bash(command), context);
				assert.equal(result?.block, true, `${active.mode}: ${command}`);
				assert.match(result?.reason ?? "", /knowledge graph control plane/u, command);
			}

			const result = await hook(write(".kpi/kg/nodes.jsonl"), context);
			assert.equal(result?.block, true, `${active.mode}: write tool`);
			assert.deepEqual(prompts, [], "a reserved target is denied, never offered to an operator");

			// The proposal path stays open in gated; autopilot denies the unknown shell.
			assert.equal(
				(await hook(bash('echo "{}" > .kpi/kg/inbox/patch.json'), context))?.block,
				active.mode === "autopilot" ? true : undefined,
			);
		}

		assert.equal(await readFile(nodes, "utf8"), authoritative, "no attempt reached the authoritative file");
	});
});

test("the registered hook confirms a gated commit and lets an accepted one run", async () => {
	const hook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
	await withProject(async (directory) => {
		const { context, prompts } = operator(directory, true);
		assert.equal(await hook(bash('git commit -m "feat(policy): gate commits"'), context), undefined);
		assert.equal(prompts.length, 1);
		assert.match(prompts[0], /Approve git commit/u);
		assert.match(prompts[0], /3 files changed, 12 insertions\(\+\), 4 deletions\(-\) against HEAD/u);
		assert.match(prompts[0], /git commit -m "feat\(policy\): gate commits"/u);
	});
});

test("the registered hook blocks a declined gated commit", async () => {
	const hook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
	await withProject(async (directory) => {
		const { context, prompts } = operator(directory, false);
		const result = await hook(bash('git commit -m "feat: ship"'), context);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /git commit/u);
		assert.equal(prompts.length, 1);
		assert.match(prompts[0], /12 insertions\(\+\)/u);
	});
});

test("the registered hook holds an autopilot commit until release approval", async () => {
	await withProject(async (directory) => {
		const beforeRelease = policyHook({ resolveActiveState: () => autopilot, readDiffStat: stubDiffStat });
		const before = operator(directory, true);
		const blocked = await beforeRelease(bash('git commit -m "feat: ship"'), before.context);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /before release\.approved/u);

		const afterRelease = policyHook({
			resolveActiveState: () => ({ ...autopilot, releaseApproved: true }),
			readDiffStat: stubDiffStat,
		});
		const after = operator(directory, false);
		assert.equal(await afterRelease(bash('git commit -m "feat: ship"'), after.context), undefined);
		assert.deepEqual([...before.prompts, ...after.prompts], [], "autopilot never asks an operator");
	});
});

test("the registered hook splits unknown commands by mode", async () => {
	await withProject(async (directory) => {
		const gatedHook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
		const accepted = operator(directory, true);
		assert.equal(await gatedHook(bash("curl https://example.test"), accepted.context), undefined);
		assert.equal(accepted.prompts.length, 1);
		assert.match(accepted.prompts[0], /Approve unrecognized command/u);

		const declined = operator(directory, false);
		const blocked = await gatedHook(bash("curl https://example.test"), declined.context);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /unrecognized command/u);

		const autopilotHook = policyHook({ resolveActiveState: () => autopilot, readDiffStat: stubDiffStat });
		const unattended = operator(directory, true);
		const denied = await autopilotHook(bash("curl https://example.test"), unattended.context);
		assert.equal(denied?.block, true);
		assert.deepEqual(unattended.prompts, [], "autopilot denies instead of prompting");
	});
});

test("the registered hook never prompts for safe commands or declared quality gates", async () => {
	await withProject(async (directory) => {
		for (const active of [gated, autopilot]) {
			const hook = policyHook({ resolveActiveState: () => active, readDiffStat: stubDiffStat });
			const { context, prompts } = operator(directory, false);
			for (const command of [
				"ls",
				"git status",
				"git diff",
				"git log --oneline",
				"npm test",
				"npm run lint -- --max-warnings 0",
			]) {
				assert.equal(await hook(bash(command), context), undefined, `${active.mode}: ${command}`);
			}
			assert.deepEqual(prompts, []);
		}
	});
});

test("with no active job the hook defaults to gated bounds and prompts from the real diff", async () => {
	const hook = policyHook({});
	await withProject(async (directory) => {
		await seedRepository(directory, "one\ntwo\nthree\n");
		await writeFile(join(directory, "tracked.txt"), "one\ntwo\nthree\nfour\n");

		const { context, prompts } = operator(directory, false);
		assert.equal(await hook(bash("git status"), context), undefined, "safe reads still need no job");
		assert.equal((await hook(write("src/fixture.ts"), context))?.block, true, "no job means no write bounds");

		const commit = await hook(bash('git commit -m "feat: ship"'), context);
		assert.equal(commit?.block, true, "an unapproved commit is blocked");
		assert.equal(prompts.length, 1);
		assert.match(prompts[0], /1 files changed, 1 insertions\(\+\), 0 deletions\(-\) against HEAD/u);
	});
});

const autopilotTask = {
	job_id: "job-1",
	mode: "autopilot",
	acceptance: [{ id: "AC-1", statement: "ships", required: true, bounds: { write_allow: ["src/**"] } }],
	quality_gates: ["npm test"],
};

async function activeJob(directory: string, state: unknown): Promise<string> {
	const runDirectory = join(directory, ".kpi", "runs", "job-1");
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "task.json"), JSON.stringify(autopilotTask));
	await writeFile(join(runDirectory, "state.json"), JSON.stringify(state));
	return runDirectory;
}

test("the resolver reads mode, release approval, write bounds, and quality gates from one job", async () => {
	const hook = policyHook({ resolveActiveState: resolveActivePolicyState, readDiffStat: stubDiffStat });
	await withProject(async (directory) => {
		const runDirectory = await activeJob(directory, { job_id: "job-1", status: "RUNNING" });
		const { context, prompts } = operator(directory, true);
		const commit = bash('git commit -m "feat: ship"');

		assert.equal((await hook(commit, context))?.block, true, "autopilot holds the commit before release");
		assert.equal(await hook(bash("npm test"), context), undefined, "the task's quality gate runs unprompted");
		assert.equal(await hook(write("src/fixture.ts"), context), undefined, "the task's bounds allow src");
		assert.equal((await hook(write("docs/notes.md"), context))?.block, true, "outside the task's bounds");
		assert.equal((await hook(bash("curl https://example.test"), context))?.block, true, "autopilot denies unknown");

		// The loop's progress document publishes the release.set assignment flattened.
		await writeFile(
			join(runDirectory, "state.json"),
			JSON.stringify({ job_id: "job-1", status: "DONE", release: { approved: true } }),
		);
		assert.equal(await hook(commit, context), undefined, "released autopilot may commit");

		// The raw graph run state carries the same path under `values`.
		await writeFile(
			join(runDirectory, "state.json"),
			JSON.stringify({ job_id: "job-1", values: { release: { approved: true } } }),
		);
		assert.equal(await hook(commit, context), undefined, "released autopilot may commit");

		await writeFile(
			join(runDirectory, "state.json"),
			JSON.stringify({ job_id: "job-1", values: { release: { approved: false } } }),
		);
		assert.equal((await hook(commit, context))?.block, true, "a withdrawn approval holds the commit again");
		assert.deepEqual(prompts, [], "autopilot decides without an operator");
	});
});

test("an unreadable task contract resolves to the safe default instead of escaping the hook", async () => {
	const hook = policyHook({ resolveActiveState: resolveActivePolicyState, readDiffStat: stubDiffStat });
	await withProject(async (directory) => {
		const runDirectory = await activeJob(directory, { job_id: "job-1", status: "RUNNING" });
		await writeFile(join(runDirectory, "task.json"), "{ not json");

		const { context, prompts } = operator(directory, false);
		assert.equal((await hook(write("src/fixture.ts"), context))?.block, true, "no readable bounds, no write");
		assert.equal((await hook(bash('git commit -m "feat: ship"'), context))?.block, true);
		assert.equal(prompts.length, 1, "the safe default is gated, so the commit asks");
		assert.match(prompts[0], /3 files changed, 12 insertions\(\+\), 4 deletions\(-\) against HEAD/u);
	});
});

test("bash cannot write outside write_allow, whatever shape the write takes", async () => {
	const active: ActivePolicyState = { ...gated, writeAllow: ["src/**", "test/**"] };
	const cases: { command: string; allowed: boolean }[] = [
		{ command: "echo x > src/generated.ts", allowed: true },
		{ command: "npm test > /dev/null 2>&1", allowed: true },
		{ command: "echo x > /tmp/outside.txt", allowed: false },
		{ command: "echo x > ../outside.txt", allowed: false },
		{ command: "echo x >> docs/notes.md", allowed: false },
		{ command: "printf x | tee /etc/motd", allowed: false },
		{ command: "cat src/a.ts | tee -a /tmp/copy.txt", allowed: false },
		{ command: "dd if=/dev/zero of=/tmp/blob bs=1 count=1", allowed: false },
		{ command: "cp src/a.ts /tmp/a.ts", allowed: false },
		{ command: "cp src/a.ts test/a.ts", allowed: true },
		{ command: "mv src/a.ts ../a.ts", allowed: false },
		{ command: "install -m 0644 src/a.ts /usr/local/share/a.ts", allowed: false },
		{ command: "sh -c 'echo x > /tmp/nested.txt'", allowed: false },
		{ command: "bash -c \"cat <<EOF > /tmp/heredoc.txt\\nbody\\nEOF\"", allowed: false },
		{ command: "( echo x > /tmp/subshell.txt )", allowed: false },
	];

	for (const scenario of cases) {
		const decision = await decide(bash(scenario.command), active);
		if (scenario.allowed) {
			assert.notEqual(
				decision.kind === "deny" && /outside write_allow/u.test(decision.reason),
				true,
				`${scenario.command} stays inside the bounds`,
			);
			continue;
		}
		assert.equal(decision.kind, "deny", scenario.command);
		if (decision.kind !== "deny") continue;
		assert.match(decision.reason, /outside write_allow/u, scenario.command);
	}
});

test("bash cannot read or write a secret-shaped path", async () => {
	for (const command of [
		"cat .env",
		"cat .env.production",
		"cat ~/.ssh/id_rsa",
		"cp ~/.ssh/id_rsa src/key.txt",
		"cat ~/.kpi/agent/auth.json",
		"grep -r token ~/.kpi/agent/accounts.secrets.json",
		"echo pasted > src/.env",
	]) {
		const decision = await decide(bash(command), { ...gated, writeAllow: ["src/**"] });
		assert.equal(decision.kind, "deny", command);
		if (decision.kind !== "deny") continue;
		assert.match(decision.reason, /secret-shaped path|outside write_allow/u, command);
	}
});
