import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ToolCallEvent, ToolCallEventResult } from "../packages/coding-agent/src/core/extensions/types.ts";
import { appendEvent, verifyChain } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import {
	type ActivePolicyState,
	APPROVAL_OPTIONS,
	DEFAULT_ACTIVE_POLICY_STATE,
	DEFAULT_POLICY_CONFIG,
	type DiffStatReader,
	ensurePolicyFile,
	evaluateToolCall,
	normalizePolicy,
	type PolicyConfig,
	type PolicyRegistrationOptions,
	parseDiffStat,
	parseJobBranchPush,
	readGitDiffStat,
	readPolicy,
	registerPolicy,
	resolveActivePolicyState,
	UNREADABLE_JOB_POLICY_STATE,
} from "../packages/coding-agent/src/kpi/extensions/policy.ts";
import { classifyShellCommand } from "../packages/coding-agent/src/kpi/extensions/shell-classifier.ts";

const execFile = promisify(execFileCallback);

const policy: PolicyConfig = {
	deny: ["git push --force", "git reset --hard", "rm -rf", "chmod 777"],
	allow: [],
	commit: { chat: "allow", gated: "confirm", autopilot: "after-release" },
	unknown: { chat: "allow", gated: "confirm", autopilot: "deny" },
};

const cwd = "/fixture";
const gated: ActivePolicyState = {
	mode: "gated",
	releaseApproved: false,
	writeAllow: ["src/**", "test/**"],
	qualityGates: ["npm test", "npm run lint -- --max-warnings 0"],
};
const autopilot: ActivePolicyState = { ...gated, mode: "autopilot" };
const chat: ActivePolicyState = { ...DEFAULT_ACTIVE_POLICY_STATE };
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

type HookContext = {
	cwd: string;
	ui: {
		confirm: (title: string, question: string) => Promise<boolean>;
		select?: (title: string, options: string[]) => Promise<string | undefined>;
		notify?: (message: string, type?: string) => void;
	};
};
type Hook = (event: ToolCallEvent, context: HookContext) => Promise<ToolCallEventResult | undefined>;
type SessionStart = (event: unknown, context: { cwd: string }) => Promise<void>;

/** The registered hooks, exactly as the harness would call them. */
function registeredPolicy(options: PolicyRegistrationOptions): { hook: Hook; sessionStart: SessionStart } {
	let hook: Hook | undefined;
	let sessionStart: SessionStart | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "tool_call") hook = handler as Hook;
			if (event === "session_start") sessionStart = handler as SessionStart;
		},
	};
	registerPolicy(pi as unknown as Parameters<typeof registerPolicy>[0], options);
	assert.ok(hook, "registerPolicy must register a tool_call hook");
	assert.ok(sessionStart, "registerPolicy must register a session_start hook");
	return { hook, sessionStart };
}

function policyHook(options: PolicyRegistrationOptions): Hook {
	return registeredPolicy(options).hook;
}

/** An operator whose UI only has a confirm dialog: the fallback path. */
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

/** An operator with the selector: the three-way approval. */
function chooser(directory: string, choice: (typeof APPROVAL_OPTIONS)[number] | undefined) {
	const prompts: string[] = [];
	const options: string[][] = [];
	const notices: string[] = [];
	return {
		prompts,
		options,
		notices,
		context: {
			cwd: directory,
			ui: {
				confirm: async () => {
					throw new Error("confirm must not be used when select is available");
				},
				select: async (title: string, offered: string[]) => {
					prompts.push(title);
					options.push(offered);
					return choice;
				},
				notify: (message: string) => {
					notices.push(message);
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
	assert.match(decision.kind === "deny" ? decision.reason : "", /only a kpi\/\* branch may be pushed, not main/u);
	for (const active of [
		gated,
		autopilot,
		chat,
		{ ...gated, releaseApproved: true },
		{ ...autopilot, releaseApproved: true },
	]) {
		assert.equal((await decide(bash("git push origin main"), active)).kind, "deny", active.mode);
		assert.equal((await decide(bash("git push -u origin master"), active)).kind, "deny", active.mode);
	}
});

test("the job branch push is allowed only inside a job after release.approved", async () => {
	const push = "git push -u origin kpi/20260903-add-healthcheck";
	const chatDenied = await decide(bash(push), chat);
	assert.equal(chatDenied.kind, "deny");
	assert.match(chatDenied.kind === "deny" ? chatDenied.reason : "", /outside a K-π job/u);
	for (const active of [gated, autopilot]) {
		const before = await decide(bash(push), active);
		assert.equal(before.kind, "deny", active.mode);
		assert.match(before.kind === "deny" ? before.reason : "", /before release\.approved/u);
		assert.deepEqual(await decide(bash(push), { ...active, releaseApproved: true }), { kind: "allow" }, active.mode);
	}
	// The harmless options, in any order; the remote and the branch, quoted or not.
	const released = { ...gated, releaseApproved: true };
	for (const command of [
		"git push origin kpi/job-1",
		"git push --set-upstream origin kpi/job-1",
		"git   push  -u   origin   kpi/job-1",
		"git push -q -u origin kpi/job-1",
		"git push -u origin kpi/Job_1.a",
	]) {
		assert.deepEqual(await decide(bash(command), released), { kind: "allow" }, command);
	}
	assert.deepEqual(parseJobBranchPush("git push -u origin kpi/job-1"), { branch: "kpi/job-1" });
});

test("every other push shape stays denied after release, each for its own reason", async () => {
	const released = { ...autopilot, releaseApproved: true };
	const cases: [string, RegExp][] = [
		["git push --force origin kpi/job-1", /option --force/u],
		["git push -f origin kpi/job-1", /option -f/u],
		["git push --force-with-lease origin kpi/job-1", /option --force-with-lease/u],
		["git push -fu origin kpi/job-1", /option -fu/u],
		["git push --delete origin kpi/job-1", /option --delete/u],
		["git push -d origin kpi/job-1", /option -d/u],
		["git push --tags origin kpi/job-1", /option --tags/u],
		["git push --all origin", /option --all/u],
		["git push --mirror origin", /option --mirror/u],
		["git push --prune origin kpi/job-1", /option --prune/u],
		["git push --no-verify origin kpi/job-1", /option --no-verify/u],
		["git push -o merge_request.create origin kpi/job-1", /option -o/u],
		["git push origin +kpi/job-1", /leading \+ is a force push/u],
		["git push origin :kpi/job-1", /delete or rename/u],
		["git push origin kpi/job-1:main", /delete or rename/u],
		["git push origin HEAD:refs/heads/kpi/job-1", /delete or rename/u],
		["git push origin v0.2.1", /only a kpi\/\* branch may be pushed, not v0\.2\.1/u],
		["git push origin refs/tags/v0.2.1", /only a kpi\/\* branch/u],
		["git push origin HEAD", /only a kpi\/\* branch may be pushed, not HEAD/u],
		["git push origin kpi/job-1/nested", /only a kpi\/\* branch/u],
		["git push origin kpi/", /only a kpi\/\* branch/u],
		["git push upstream kpi/job-1", /only origin may be pushed to, not upstream/u],
		["git push git@github.com:korallis/K-pi.git kpi/job-1", /only origin may be pushed to/u],
		["git push", /must name the remote and exactly one kpi\/\* branch/u],
		["git push origin", /must name the remote and exactly one kpi\/\* branch/u],
		["git push -u origin kpi/job-1 kpi/job-2", /must name the remote and exactly one kpi\/\* branch/u],
		["git push origin kpi/job-1 && echo done", /chained/u],
		["git status; git push origin kpi/job-1", /chained/u],
		["git -C . push origin kpi/job-1", /standalone/u],
		["sudo git push origin kpi/job-1", /standalone/u],
		["git -c push.default=current push origin kpi/job-1", /standalone/u],
	];
	for (const [command, reason] of cases) {
		const decision = await decide(bash(command), released);
		assert.equal(decision.kind, "deny", command);
		assert.match(decision.kind === "deny" ? decision.reason : "", reason, command);
	}
	// Neither an operator allow entry nor a declared gate can widen the rule.
	const widened: PolicyConfig = { ...policy, allow: ["git push --force origin kpi/job-1", "git push origin main"] };
	const options = { cwd, policy: widened, active: { ...released, qualityGates: ["git push origin main"] } };
	assert.equal((await evaluateToolCall(bash("git push --force origin kpi/job-1"), options)).kind, "deny");
	assert.equal((await evaluateToolCall(bash("git push origin main"), options)).kind, "deny");
});

test("the ship node's other release steps follow the same gate", async () => {
	// Staging: unknown before release (gated asks, autopilot refuses), allowed after.
	assert.equal((await decide(bash("git add -A"), gated)).kind, "confirm");
	assert.equal((await decide(bash("git add src/health/server.js"), autopilot)).kind, "deny");
	for (const active of [gated, autopilot]) {
		assert.deepEqual(await decide(bash("git add -A"), { ...active, releaseApproved: true }), { kind: "allow" });
		assert.deepEqual(await decide(bash("git add src test"), { ...active, releaseApproved: true }), { kind: "allow" });
	}
	// Opening the pull request: a hard deny before release inside a job, allowed after.
	const create = "gh pr create --head kpi/job-1 --fill";
	for (const active of [gated, autopilot]) {
		const before = await decide(bash(create), active);
		assert.equal(before.kind, "deny", active.mode);
		assert.match(before.kind === "deny" ? before.reason : "", /gh pr create before release\.approved/u);
		const released = { ...active, releaseApproved: true };
		for (const command of [
			create,
			"gh pr create --fill",
			"gh pr create --base main --head kpi/job-1 --title 'feat: x' --body 'y'",
			"gh pr create -H kpi/job-1 --fill",
			"gh pr create --head=kpi/job-1 --fill",
		]) {
			assert.deepEqual(await decide(bash(command), released), { kind: "allow" }, command);
		}
		// A head outside kpi/* is not a release step: it is the unknown command it always was.
		assert.equal(
			(await decide(bash("gh pr create --head main --fill"), released)).kind,
			active.mode === "gated" ? "confirm" : "deny",
		);
		assert.equal((await decide(bash(`${create} && gh pr merge --auto`), released)).kind, "deny");
	}
	// Chat has no job and no release step: gh pr create is an ordinary unknown command there.
	assert.deepEqual(await decide(bash(create), chat), { kind: "allow" });
	// Merging is the auto-merge workflow's decision, never a node's or an operator's.
	for (const active of [
		chat,
		gated,
		autopilot,
		{ ...gated, releaseApproved: true },
		{ ...autopilot, releaseApproved: true },
	]) {
		for (const command of ["gh pr merge --auto --merge", "gh pr merge 12 --squash", "gh pr merge"]) {
			assert.equal((await decide(bash(command), active)).kind, "deny", `${active.mode}: ${command}`);
		}
	}
	// Looking at the pull request afterwards is a read.
	for (const command of ["gh pr view kpi/job-1 --json url,state", "gh pr checks kpi/job-1", "gh auth status"]) {
		assert.deepEqual(await decide(bash(command), autopilot), { kind: "allow" }, command);
	}
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
	assert.equal(
		(await evaluateToolCall(bash('echo "{}" > .kpi/kg/inbox/patch.json'), { active, cwd, policy })).kind,
		"confirm",
	);
	// A declared quality gate cannot launder a reserved target.
	const gateActive: ActivePolicyState = { ...active, qualityGates: ["npm test > .kpi/kg/nodes.jsonl"] };
	assert.equal(
		(await evaluateToolCall(bash("npm test > .kpi/kg/nodes.jsonl"), { active: gateActive, cwd, policy })).kind,
		"deny",
	);
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
		"git show HEAD --stat",
		"git rev-parse --abbrev-ref HEAD",
		"grep -rn foo src | head -n 5",
		"npm ls --depth=0",
		"node --version",
	]) {
		assert.deepEqual(await decide(bash(command)), { kind: "allow" }, command);
		assert.deepEqual(await decide(bash(command), autopilot), { kind: "allow" }, command);
	}
});

test("read-only inspection commands are allowed whatever their arguments, in both job modes", async () => {
	for (const command of ["git log --oneline --all", "git diff --stat -- src", "ls -la /etc", "git status; whoami"]) {
		assert.deepEqual(await decide(bash(command)), { kind: "allow" }, command);
		assert.deepEqual(await decide(bash(command), autopilot), { kind: "allow" }, command);
	}
});

test("exact task quality gates are allowed and never prompt", async () => {
	assert.deepEqual(await decide(bash("npm test")), { kind: "allow" });
	assert.deepEqual(await decide(bash("  npm   test  ")), { kind: "allow" });
	assert.deepEqual(await decide(bash("npm run lint -- --max-warnings 0"), autopilot), { kind: "allow" });
	assert.equal((await decide(bash("npm test -- --watch"))).kind, "confirm");
});

test("a composition is only as safe as its least safe segment", async () => {
	// A declared gate is exact: chaining two of them is not the gate.
	const active: ActivePolicyState = { ...gated, qualityGates: ["npm test && npm run lint"] };
	assert.equal((await decide(bash("npm test && npm run lint"), active)).kind, "confirm");
	assert.equal((await decide(bash("npm test && npm run lint"), { ...active, mode: "autopilot" })).kind, "deny");
	assert.deepEqual(await decide(bash("git status && ls -la")), { kind: "allow" });
	// A chain that touches a secret is denied outright: an operator cannot make
	// reading a credential file legal by approving it.
	assert.equal((await decide(bash("git status && cat .env"))).kind, "deny");
	// tee writes: inside the bounds it is unknown (confirm / deny by mode),
	// outside them it is a bounds denial in every mode.
	assert.equal((await decide(bash("ls | tee src/out.txt"))).kind, "confirm");
	assert.equal((await decide(bash("ls | tee src/out.txt"), autopilot)).kind, "deny");
	assert.equal((await decide(bash("ls | tee /tmp/out"))).kind, "deny");
	assert.equal((await decide(bash("ls | tee /tmp/out"), autopilot)).kind, "deny");
	assert.equal((await decide(bash("find . -name '*.ts' -exec rm {} \\;"))).kind, "confirm");
	assert.equal((await decide(bash("find . -name '*.ts' -exec rm {} \\;"), autopilot)).kind, "deny");
	assert.deepEqual(await decide(bash("sed -n 1,5p a.ts")), { kind: "allow" });
	assert.equal((await decide(bash("sed -i s/a/b/ a.ts"))).kind, "confirm");
	// The confirm names the segment that decided it.
	const decision = await decide(bash("git status && curl https://example.test"));
	assert.equal(decision.kind, "confirm");
	assert.match(decision.kind === "confirm" ? decision.question : "", /unknown head "curl"/u);
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

test("without a live job the resolved state is chat scope; an unreadable live job falls back to gated", () => {
	assert.deepEqual(DEFAULT_ACTIVE_POLICY_STATE, {
		mode: "chat",
		releaseApproved: false,
		writeAllow: [],
		qualityGates: [],
	});
	assert.deepEqual(UNREADABLE_JOB_POLICY_STATE, {
		mode: "gated",
		releaseApproved: false,
		writeAllow: [],
		qualityGates: [],
	});
});

test("chat scope never confirms but keeps every hard deny", async () => {
	for (const command of [
		"curl https://example.test",
		"npm test",
		"node packages/coding-agent/dist/bundle/cli.js --help | head -n 120",
		'git commit -m "feat: chat"',
		"echo x > notes.txt",
	]) {
		assert.deepEqual(await decide(bash(command), chat), { kind: "allow" }, command);
	}
	for (const command of [
		"git push origin main",
		"rm -rf /",
		"npm publish",
		"cat .env",
		"echo x > .kpi/runs/job-1/verdict.json",
		"echo x > .kpi/kg/nodes.jsonl",
	]) {
		assert.equal((await decide(bash(command), chat)).kind, "deny", command);
	}
	assert.deepEqual(await decide(write("package.json"), chat), { kind: "allow" }, "no job means no bounds");
	assert.equal((await decide(write("src/.env"), chat)).kind, "deny");
	assert.equal((await decide(write(".kpi/kg/nodes.jsonl"), chat)).kind, "deny");

	// An operator who wants a cautious chat can ask for it in the file.
	const cautious: PolicyConfig = { ...policy, unknown: { ...policy.unknown, chat: "confirm" } };
	const asked = await evaluateToolCall(bash("curl https://example.test"), { active: chat, cwd, policy: cautious });
	assert.equal(asked.kind, "confirm");
});

test("the two commands that prompted in ordinary chat are allowed", async () => {
	// Built by concatenation so the shell expansion is not read as a template.
	const expansion = ["$", "{PI_MODEL:-}"].join("");
	const first = `printf 'PI_MODEL=%q\\n' "${expansion}"; for f in "$HOME/.kpi/agent"/{settings.json,models.json}; do if [ -e "$f" ]; then printf 'EXISTS %s\\n' "$f"; else printf 'MISSING %s\\n' "$f"; fi; done; command -v kpi || true`;
	const second =
		"if [ -f packages/coding-agent/dist/bundle/cli.js ]; then node packages/coding-agent/dist/bundle/cli.js --help | head -n 120; else echo 'dist bundle missing'; fi";
	assert.deepEqual(await decide(bash(first), chat), { kind: "allow" });
	assert.deepEqual(await decide(bash(second), chat), { kind: "allow" });
	// The first is read-only in any scope; the second runs project code, so a
	// gated job still asks.
	assert.equal(classifyShellCommand(first).readOnly, true);
	const classified = classifyShellCommand(second);
	assert.equal(classified.readOnly, false);
	assert.match(classified.readOnly ? "" : classified.reason, /node/u);
	assert.deepEqual(await decide(bash(first)), { kind: "allow" });
	assert.equal((await decide(bash(second))).kind, "confirm");
});

test("an exact allow entry is honoured after every hard deny", async () => {
	const remembered: PolicyConfig = { ...policy, allow: ["frobnicate --all", "git push origin main"] };
	const options = { cwd, policy: remembered };
	assert.deepEqual(await evaluateToolCall(bash("frobnicate   --all"), { ...options, active: gated }), {
		kind: "allow",
	});
	assert.deepEqual(await evaluateToolCall(bash("frobnicate --all"), { ...options, active: autopilot }), {
		kind: "allow",
	});
	assert.equal(
		(await evaluateToolCall(bash("frobnicate --all --now"), { ...options, active: gated })).kind,
		"confirm",
	);
	assert.equal((await evaluateToolCall(bash("git push origin main"), { ...options, active: gated })).kind, "deny");
	assert.equal((await evaluateToolCall(bash("frobnicate --all"), { ...options, active: gated })).kind, "allow");
});

test("a policy file written before allow and chat existed still loads, and a malformed one does not", () => {
	const legacy = normalizePolicy(
		{
			deny: ["git push", "git reset --hard"],
			commit: { gated: "confirm", autopilot: "after-release" },
			unknown: { gated: "confirm", autopilot: "deny" },
		},
		"policy.json",
	);
	// The `git push` every earlier template seeded gives way to the structural
	// push rule; a narrower literal an operator wrote themselves is kept.
	assert.deepEqual(legacy, { ...DEFAULT_POLICY_CONFIG, deny: ["git reset --hard"] });
	assert.deepEqual(normalizePolicy({ deny: ["Git  Push", "git push origin"] }, "policy.json").deny, [
		"git push origin",
	]);
	assert.throws(() => normalizePolicy({ commit: {} }, "policy.json"), /must define a deny array/u);
	assert.throws(() => normalizePolicy({ deny: [], allow: "ls" }, "policy.json"), /allow must be an array/u);
	assert.throws(() => normalizePolicy({ deny: [], unknown: { chat: "yes" } }, "policy.json"), /unknown\.chat/u);
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
		assert.ok(copied.deny.includes("git push --force"));
		assert.equal(copied.deny.includes("git push"), false, "the push rule is structural, not a deny entry");
		assert.deepEqual(copied, DEFAULT_POLICY_CONFIG, "the shipped template is the in-code default");

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

		// The accepted approval lives for that hook's session, so the decline is a
		// fresh session.
		const declined = operator(directory, false);
		const decliningHook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
		const blocked = await decliningHook(bash("curl https://example.test"), declined.context);
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

test("with no live job the hook is chat scope: reads, writes, and commits run without a prompt", async () => {
	const hook = policyHook({ resolveWriteAllow: async () => ["never-applied/**"] });
	await withProject(async (directory) => {
		await seedRepository(directory, "one\ntwo\nthree\n");
		await writeFile(join(directory, "tracked.txt"), "one\ntwo\nthree\nfour\n");

		const { context, prompts } = operator(directory, false);
		for (const event of [
			bash("git status"),
			bash("curl https://example.test"),
			bash('git commit -m "feat: ship"'),
			write("src/fixture.ts"),
			write("package.json"),
		]) {
			assert.equal(await hook(event, context), undefined, JSON.stringify(event.input));
		}
		assert.equal((await hook(bash("git push origin main"), context))?.block, true);
		assert.equal((await hook(write("src/.env"), context))?.block, true);
		assert.deepEqual(prompts, [], "chat never asks");
	});
});

test("a live gated job prompts a commit from the real diff", async () => {
	const hook = policyHook({});
	await withProject(async (directory) => {
		await seedRepository(directory, "one\ntwo\nthree\n");
		await writeFile(join(directory, "tracked.txt"), "one\ntwo\nthree\nfour\n");
		await activeJob(directory, { job_id: "job-1", status: "RUNNING" }, gatedTask);

		const { context, prompts } = operator(directory, false);
		assert.equal((await hook(write("docs/notes.md"), context))?.block, true, "the job's bounds apply");
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

const gatedTask = { ...autopilotTask, mode: "gated" };

async function activeJob(directory: string, state: unknown, task: unknown = autopilotTask): Promise<string> {
	const runDirectory = join(directory, ".kpi", "runs", "job-1");
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "task.json"), JSON.stringify(task));
	await writeFile(join(runDirectory, "state.json"), JSON.stringify(state));
	return runDirectory;
}

test("a finished job never puts chat into a job mode or receives its tool requests", async () => {
	const hook = policyHook({ resolveActiveState: resolveActivePolicyState, readDiffStat: stubDiffStat });
	await withProject(async (directory) => {
		const runDirectory = await activeJob(directory, { job_id: "job-1", status: "DONE", node: "ship" });
		await writeFile(join(runDirectory, "events.jsonl"), "");
		const { context, prompts } = operator(directory, false);

		assert.equal(await hook(bash("curl https://example.test"), context), undefined, "not autopilot's deny");
		assert.equal(await hook(write("docs/notes.md"), context), undefined, "not the finished job's bounds");
		assert.deepEqual(await toolRequests(runDirectory), [], "a finished run's log is closed");
		assert.deepEqual(prompts, []);

		await writeFile(join(runDirectory, "state.json"), JSON.stringify({ job_id: "job-1", status: "RUNNING" }));
		assert.equal((await hook(bash("curl https://example.test"), context))?.block, true, "live autopilot denies");
		assert.equal((await toolRequests(runDirectory)).length, 1, "a live run records the attempt");
	});
});

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
		// Ship runs while the job is still open: release is approved before the
		// commit, and the run only reaches DONE after it.
		await writeFile(
			join(runDirectory, "state.json"),
			JSON.stringify({ job_id: "job-1", status: "RUNNING", release: { approved: true } }),
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

		// A finished run is the newest document on disk but no longer a job the
		// policy is about: its mode, bounds and approval stop applying.
		await writeFile(
			join(runDirectory, "state.json"),
			JSON.stringify({ job_id: "job-1", status: "DONE", release: { approved: true } }),
		);
		assert.deepEqual(
			await resolveActivePolicyState(directory),
			DEFAULT_ACTIVE_POLICY_STATE,
			"a finished job sets no policy mode",
		);
	});
});

test("an operator can allow a command for the session, and the same command does not ask again", async () => {
	await withProject(async (directory) => {
		const hook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
		const once = chooser(directory, "Allow for this session");
		assert.equal(await hook(bash("frobnicate --all"), once.context), undefined, "approved once");
		assert.deepEqual(once.options[0], [...APPROVAL_OPTIONS]);
		assert.match(once.prompts[0] ?? "", /Approve unrecognized command/u);
		assert.equal(await hook(bash("frobnicate   --all"), once.context), undefined, "same command, no dialog");
		assert.equal(once.prompts.length, 1);
		assert.equal(await hook(bash("frobnicate --other"), once.context), undefined, "a different command asks");
		assert.equal(once.prompts.length, 2);
		await assert.rejects(readFile(join(directory, ".kpi", "policy.json"), "utf8"), "nothing persisted");

		// A fresh registration is a fresh process: the session approval is gone.
		const later = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
		const declined = operator(directory, false);
		assert.equal((await later(bash("frobnicate --all"), declined.context))?.block, true);
	});
});

test("always allow persists to policy.json allow[] and is honoured by a fresh session", async () => {
	await withProject(async (directory) => {
		const hook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
		const always = chooser(directory, "Always allow in this project");
		assert.equal(await hook(bash("frobnicate   --all"), always.context), undefined);
		const written = JSON.parse(await readFile(join(directory, ".kpi", "policy.json"), "utf8")) as PolicyConfig;
		assert.deepEqual(written.allow, ["frobnicate --all"], "collapsed and remembered");
		assert.ok(written.deny.includes("git push --force"), "the rest of the template came with it");
		assert.match(always.notices[0] ?? "", /Always allowed in .kpi\/policy\.json: frobnicate --all/u);

		const fresh = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
		const declined = operator(directory, false);
		assert.equal(await fresh(bash("frobnicate --all"), declined.context), undefined, "no prompt in a new session");
		assert.deepEqual(declined.prompts, []);
		const unattended = policyHook({ resolveActiveState: () => autopilot, readDiffStat: stubDiffStat });
		assert.equal(await unattended(bash("frobnicate --all"), declined.context), undefined, "autopilot honours it too");

		// allow[] cannot launder a hard deny, and a remembered command is exact.
		await writeFile(
			join(directory, ".kpi", "policy.json"),
			JSON.stringify({ ...written, allow: ["frobnicate --all", "git push origin main"] }),
		);
		assert.equal((await fresh(bash("git push origin main"), declined.context))?.block, true);
		assert.equal((await fresh(bash("frobnicate --all --now"), declined.context))?.block, true);
		assert.deepEqual((await readPolicy(directory)).allow, ["frobnicate --all", "git push origin main"]);
	});
});

test("a declined or cancelled approval blocks the call", async () => {
	await withProject(async (directory) => {
		const hook = policyHook({ resolveActiveState: () => gated, readDiffStat: stubDiffStat });
		for (const choice of ["Deny", undefined] as const) {
			const answer = chooser(directory, choice);
			const outcome = await hook(bash("frobnicate --all"), answer.context);
			assert.equal(outcome?.block, true, String(choice));
			assert.match(outcome?.reason ?? "", /unrecognized command/u);
		}
		const again = chooser(directory, "Deny");
		await hook(bash("frobnicate --all"), again.context);
		assert.equal(again.prompts.length, 1, "nothing was cached");
		await assert.rejects(readFile(join(directory, ".kpi", "policy.json"), "utf8"), "nothing was persisted");
	});
});

test("the policy file is seeded only in a project directory", async () => {
	await withProject(async (directory) => {
		const { sessionStart } = registeredPolicy({});
		await sessionStart({}, { cwd: directory });
		await assert.rejects(readFile(join(directory, ".kpi", "policy.json"), "utf8"), "a bare directory gets no file");
		assert.deepEqual(await readPolicy(directory), DEFAULT_POLICY_CONFIG, "and reads as the default");

		await git(directory, "init");
		await sessionStart({}, { cwd: directory });
		const seeded = JSON.parse(await readFile(join(directory, ".kpi", "policy.json"), "utf8")) as PolicyConfig;
		assert.deepEqual(seeded, DEFAULT_POLICY_CONFIG, "a git root is a project");
	});
	await withProject(async (directory) => {
		await mkdir(join(directory, ".kpi"), { recursive: true });
		const { sessionStart } = registeredPolicy({});
		await sessionStart({}, { cwd: directory });
		await readFile(join(directory, ".kpi", "policy.json"), "utf8");
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
		{ command: 'bash -c "cat <<EOF > /tmp/heredoc.txt\\nbody\\nEOF"', allowed: false },
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

// ---------------------------------------------------------------------------
// B7: every tool attempt is recorded, so ordering is observable
// ---------------------------------------------------------------------------

/** A run store the policy hook can find, so attempts have somewhere to land. */
async function orderingJob(directory: string, mode: "gated" | "autopilot" = "gated"): Promise<string> {
	const runDirectory = join(directory, ".kpi", "runs", "2026-09-02-order");
	await mkdir(runDirectory, { recursive: true });
	await writeFile(
		join(runDirectory, "task.json"),
		`${JSON.stringify({
			job_id: "2026-09-02-order",
			mode,
			goal: "add a healthcheck",
			nongoals: [],
			acceptance: [{ id: "AC-01", statement: "healthy", required: true, bounds: { write_allow: ["src/**"] } }],
			constraints: [],
			quality_gates: ["npm test"],
			ac: { quality: "executable" },
		})}\n`,
	);
	await writeFile(
		join(runDirectory, "state.json"),
		`${JSON.stringify({ job_id: "2026-09-02-order", mode, round: 2, node: "implement", status: "RUNNING" })}\n`,
	);
	await writeFile(join(runDirectory, "events.jsonl"), "");
	return runDirectory;
}

async function toolRequests(runDirectory: string): Promise<Record<string, unknown>[]> {
	const source = await readFile(join(runDirectory, "events.jsonl"), "utf8");
	return source
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((record) => record.type === "tool.request");
}

test("an allowed write is recorded as an attempt with its decision", async () => {
	await withProject(async (directory) => {
		const runDirectory = await orderingJob(directory);
		const hook = policyHook({ resolveActiveState: async () => gated, readDiffStat: stubDiffStat });
		const attendant = operator(directory, true);

		assert.equal(await hook(write("src/health.ts"), attendant.context), undefined, "the write was allowed");

		const requests = await toolRequests(runDirectory);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].tool, "write");
		assert.equal(requests[0].decision, "allow");
		assert.equal(requests[0].path, "src/health.ts");
		assert.equal(requests[0].round, 2, "the attempt carries the round it happened in");
		assert.equal(requests[0].node, "implement");
		assert.ok(typeof requests[0].ts === "string" && requests[0].ts.length > 0, "an attempt is timestamped");
		assert.equal(await verifyChain(join(runDirectory, "events.jsonl")), true, "attempts join the hash chain");
	});
});

test("a denied write is recorded before it is refused, so ordering is provable", async () => {
	await withProject(async (directory) => {
		const runDirectory = await orderingJob(directory);
		const hook = policyHook({
			resolveActiveState: async () => gated,
			resolveWriteAllow: async () => ["src/**"],
			readDiffStat: stubDiffStat,
		});
		const attendant = operator(directory, true);

		const outcome = await hook(write("infra/deploy.sh"), attendant.context);
		assert.equal(outcome?.block, true);
		assert.match(outcome?.reason ?? "", /Policy denied write outside write_allow/u);

		const requests = await toolRequests(runDirectory);
		assert.equal(requests.length, 1, "the refused attempt is on the record");
		assert.equal(requests[0].decision, "deny");
		assert.equal(requests[0].path, "infra/deploy.sh");
		assert.match(String(requests[0].reason), /Policy denied write outside write_allow/u);
	});
});

test("a confirmed command is recorded whether or not the operator ever answers", async () => {
	await withProject(async (directory) => {
		const runDirectory = await orderingJob(directory);
		const hook = policyHook({ resolveActiveState: async () => gated, readDiffStat: stubDiffStat });
		// Declined: the attempt still happened.
		const declining = operator(directory, false);
		const outcome = await hook(bash("frobnicate --all"), declining.context);
		assert.equal(outcome?.block, true);

		const requests = await toolRequests(runDirectory);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].tool, "bash");
		assert.equal(requests[0].decision, "confirm");
		assert.equal(requests[0].path, undefined, "a command names no path");
		assert.match(String(requests[0].reason), /Approve unrecognized command/u);
	});
});

test("attempts are ordered against the run's own terminal record", async () => {
	await withProject(async (directory) => {
		const runDirectory = await orderingJob(directory);
		const eventsPath = join(runDirectory, "events.jsonl");
		const hook = policyHook({
			resolveActiveState: async () => gated,
			resolveWriteAllow: async () => ["src/**"],
			readDiffStat: stubDiffStat,
		});
		const attendant = operator(directory, true);

		// The ordering UAT-30 needs: a terminal, then proof that nothing wrote after it.
		await hook(write("src/one.ts"), attendant.context);
		await appendEvent(eventsPath, {
			ts: new Date().toISOString(),
			type: "loop.terminal",
			job_id: "2026-09-02-order",
			round: 2,
			node: "implement",
			status: "NEEDS_HUMAN",
			recovery: "stack",
			reason: "stack.json is missing; implement has no frozen map to read",
		});
		await hook(write("infra/after.sh"), attendant.context);

		const records = (await readFile(eventsPath, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const sequence = records.map((record) => `${record.type}:${record.decision ?? record.status}`);
		assert.deepEqual(sequence, ["tool.request:allow", "loop.terminal:NEEDS_HUMAN", "tool.request:deny"]);
		// The chain is what makes the order non-repudiable.
		assert.equal(await verifyChain(eventsPath), true);
	});
});

test("a tool attempt outside any job is not a failure and writes nothing", async () => {
	await withProject(async (directory) => {
		const hook = policyHook({ resolveActiveState: async () => gated, readDiffStat: stubDiffStat });
		const attendant = operator(directory, true);
		assert.equal(await hook(write("src/health.ts"), attendant.context), undefined);
		await assert.rejects(readFile(join(directory, ".kpi", "runs", "2026-09-02-order", "events.jsonl"), "utf8"));
	});
});
