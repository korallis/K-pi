import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import type {
	ExtensionCommandContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../packages/coding-agent/src/core/extensions/types.ts";
import { verifyChain } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { researchCellFromDocument } from "../packages/coding-agent/src/kpi/extensions/board.ts";
import { registeredBuses } from "../packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts";
import type { BusDependencies } from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import { liveLoopSettled, registerControlPlane } from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import {
	CONVENTIONAL_COMMIT_PATTERN,
	findJobCommit,
	INTENT_GATE_OPTIONS,
	type LoopDependencies,
	PullRequestLookupError,
	type PullRequestRecord,
	RELEASE_GATE_OPTIONS,
	runLoop,
	verifyShippedCommit,
	writeStopMarker,
} from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition, GraphRunState } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { registerPolicy } from "../packages/coding-agent/src/kpi/extensions/policy.ts";
import { readTaskForJob } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import { stackTaskHash } from "../packages/coding-agent/src/kpi/extensions/stack.ts";
import { reviewerBusDependencies } from "./helpers/reviewer-bus.ts";

const execFile = promisify(execFileCallback);
const fixtureSource = fileURLToPath(new URL("../fixtures/healthcheck-gated/", import.meta.url));
const validVerdict = JSON.stringify({
	status: "PASS",
	approved: true,
	blockingIssues: [],
	nonBlockingIssues: [],
	evidence: ["evidence.json"],
	round: 1,
	output_fingerprint: `sha256:${"a".repeat(64)}`,
});
const commandEnvironment: NodeJS.ProcessEnv = {
	...process.env,
	PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
};
delete commandEnvironment.NODE_TEST_CONTEXT;

/** Ladder decision the implementer records before product files change. */
const MINIMALIST_CANDIDATE = `{
  "ladder": "minimum-code",
  "used": "direct health handler in src/health/server.js",
  "skipped": "framework wrapper, utility module, and extra abstraction"
}`;

const implementedServer = `import { createServer } from "node:http";

export function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

export function createApp() {
  return createServer(handleRequest);
}
`;

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

async function git(directory: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd: directory });
	return stdout.trim();
}

async function cleanupFixture(root: string): Promise<void> {
	const runs = join(root, ".kpi", "runs");
	for (const bus of registeredBuses()) {
		if (bus.runDirectory.startsWith(`${runs}/`)) await bus.stopAll();
	}
	// Only unlock immutable receipts inside this test's owned temporary runs,
	// after their broker has stopped writing. Production proofs remain sealed.
	for (const run of await readdir(runs, { withFileTypes: true }).catch(() => [])) {
		if (!run.isDirectory()) continue;
		const verification = join(runs, run.name, "verification");
		for (const entry of await readdir(verification, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory()) await chmod(join(verification, entry.name), 0o700);
		}
	}
	await rm(root, { recursive: true, force: true });
}

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-gated-"));
	await rm(directory, { recursive: true, force: true });
	await cp(fixtureSource, directory, { recursive: true });
	await git(directory, "init");
	await git(directory, "config", "user.email", "fixture@example.test");
	await git(directory, "config", "user.name", "Fixture");
	await git(directory, "add", "-A");
	await git(directory, "commit", "-m", "chore: seed fixture");
	return directory;
}

function nodeId(prompt: string): string {
	if (prompt.includes("intent-proposal.schema.json"))
		return prompt.includes("frozen requirements/design/tasks") ? "plan-check" : "specify";
	// Implement mentions stack.json; match skills before the plan response contract.
	if (prompt.includes("tdd-cycle skill")) return "implement";
	if (prompt.includes("isolated-review skill")) return "review";
	if (prompt.includes("conventional-commit skill")) return "ship";
	if (
		prompt.includes("implementation plan") ||
		prompt.includes("stack.schema.json") ||
		prompt.includes("Return only JSON matching stack.schema.json")
	) {
		return "plan";
	}
	return "retry";
}

/** The map the plan node writes, exactly as `dune-architecture.md` requires. */
const healthStack = JSON.stringify(
	{
		version: 1,
		shape: "dune",
		delivery: "vertical",
		root: "src",
		current_module_id: "health",
		modules: [
			{
				id: "health",
				purpose: "healthcheck endpoint and its tests",
				folder: "src/health",
				interface: "src/health/server.js",
				allowed_paths: ["src/health/**", "test/health/**"],
				depends_on: [],
			},
		],
		scaffold_first: true,
	},
	null,
	2,
);

/** The repaired plan isolates the routing/serialization assumption before retrying implementation. */
const REVISED_HEALTH_PURPOSE =
	"isolate request routing and JSON serialization with direct health-client checks before implementation";
const healthStackRevised = healthStack.replace("healthcheck endpoint and its tests", REVISED_HEALTH_PURPOSE);

function loopSessions(
	directory: string,
	executed: string[],
	options: {
		validateCommands?: boolean;
		jobId?: string;
		/** A document to write, or null when the plan writes no map at all. */
		stack?: string | null;
		/** Deliberately tampers with accepted intent to exercise the protection boundary. */
		playbook?: string;
		/** What the ship node does with its prompt, in place of the plain local commit. */
		ship?: (prompt: string, trailer: string) => Promise<void>;
		/** One map per plan run, in order; once spent the plan answers `stack` as usual. */
		stacks?: string[];
		/** Every prompt a session received, as `<node>\n<prompt>`. */
		prompts?: string[];
		/** Thrown by implement's prompt, one per implement run, until spent. */
		implementFailures?: Error[];
		implementations?: string[];
		/** Desired-state proposals, before protected intent is accepted. */
		proposals?: Array<Record<string, unknown>>;
		/** Called with every prompt before the fake node acts on it. */
		onPrompt?: (node: string, prompt: string) => Promise<void>;
	} = {},
): GraphAgentSessionFactory {
	let sessionNumber = 0;
	return async (sessionOptions) => {
		let implementationAttempt = 0;
		sessionNumber += 1;
		let currentNode = "";
		let lastAssistantText: string | undefined;
		return {
			session: {
				sessionId: `fixture-session-${sessionNumber}`,
				async prompt(prompt) {
					const detected = nodeId(prompt);
					if (detected !== "retry") currentNode = detected;
					executed.push(currentNode || detected);
					options.prompts?.push(`${currentNode || detected}\n${prompt}`);
					await options.onPrompt?.(currentNode || detected, prompt);
					// Response contracts read getLastAssistantText after prompt; never leak
					// a prior node's JSON (plan stack) into a later schema (evidence).
					lastAssistantText = undefined;

					if (currentNode === "specify" || currentNode === "plan-check") {
						assert.ok(options.jobId, "desired-state fixture requires a run identity");
						const original = await readTaskForJob(directory, options.jobId);
						lastAssistantText = JSON.stringify({
							users: ["healthcheck client"],
							journeys: [
								{
									id: "health",
									actor: "healthcheck client",
									entry: "GET /health",
									steps: ["request the health endpoint", "receive status 200 and healthy JSON"],
									acceptance_ids: original.acceptance.map((criterion) => criterion.id),
								},
							],
							acceptance: original.acceptance,
							nongoals: original.nongoals,
							testing_criteria: ["Exercise the endpoint through the fixture HTTP client"],
							questions: [],
							...options.proposals?.shift(),
						});
					} else if (currentNode === "plan") {
						// Plan returns stack JSON; the graph engine validates and writes stack.json.
						const scripted = options.stacks?.shift();
						if (scripted !== undefined) {
							lastAssistantText = scripted;
						} else if (options.stack === null) {
							lastAssistantText = undefined;
						} else {
							lastAssistantText = options.stack ?? healthStack;
						}
						if (options.jobId !== undefined && options.playbook !== undefined) {
							const taskPath = join(directory, ".kpi", "runs", options.jobId, "task.json");
							const contract = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
							contract.playbook = options.playbook;
							await writeFile(taskPath, `${JSON.stringify(contract, null, 2)}\n`);
						}
						// A real plan binds its map to the contract hash, which is how a
						// second implement round (after a retry, a change request or a
						// re-plan) reads the map as fresh rather than judging it by mtime.
						if (options.jobId !== undefined && lastAssistantText !== undefined) {
							const map = JSON.parse(lastAssistantText) as Record<string, unknown>;
							if (map.task_hash === undefined) {
								const contract = await readTaskForJob(directory, options.jobId);
								lastAssistantText = JSON.stringify({ ...map, task_hash: stackTaskHash(contract) });
							}
						}
					} else if (currentNode === "implement") {
						const failure = options.implementFailures?.shift();
						if (failure !== undefined) {
							throw failure;
						}
						if (options.validateCommands === true && implementationAttempt === 0) {
							await assert.rejects(
								execFile("npm", ["test"], {
									cwd: directory,
									env: commandEnvironment,
								}),
							);
						}
						implementationAttempt += 1;
						if (options.jobId !== undefined) {
							await writeFile(
								join(directory, ".kpi", "runs", options.jobId, "candidate.json"),
								MINIMALIST_CANDIDATE,
							);
						}
						await writeFile(
							join(directory, "src", "health", "server.js"),
							options.implementations?.shift() ?? implementedServer,
						);
					} else if (currentNode === "review") {
						// Review runs on the RP-13 bus (workerRole). In-process
						// transcript is never the verdict; leave assistant text unset.
						lastAssistantText = undefined;
					} else if (currentNode === "ship") {
						// The commit carries the trailer the prompt asked for: that is how
						// the control plane recognises this job's own commit.
						const trailer = /^KPI-Job: [^\s`]+$/mu.exec(prompt)?.[0] ?? "";
						if (options.ship !== undefined) {
							await options.ship(prompt, trailer);
						} else {
							await git(directory, "add", "-A");
							await git(directory, "commit", "-m", `feat(health): add healthcheck endpoint\n\n${trailer}`);
						}
					}
				},
				getLastAssistantText: () => lastAssistantText,
				getActiveToolNames: () => [...(sessionOptions.tools ?? [])],
				dispose() {},
			},
		};
	};
}

/** How the fake operator answers desired-state and release dialogs. */
interface GateScript {
	/** First line of every select title, in order. */
	selections?: string[];
	/** Intent answers in order; an explicit `undefined` dismisses the dialog. Spent: Accept intent. */
	answers?: (string | undefined)[];
	/** Replaces `feedbacks`: what the editor does with every title it is shown. */
	onEditor?: (title: string) => Promise<string | undefined>;
	/** Editor answers in order; spent: a dismissed editor. */
	feedbacks?: (string | undefined)[];
	/** Release gate answers in order; spent: Approve. */
	releaseAnswers?: (string | undefined)[];
	/** Runs while release approval is open, before the operator answers. */
	onRelease?: () => Promise<void>;
	/** The node log the select checks: implement must not have run while a plan gate is open. */
	executed?: string[];
	/** Whether the context has dialog UI; a function is read on every gate. */
	hasUI?: boolean | (() => boolean);
}

function commandHarness(
	directory: string,
	factory: GraphAgentSessionFactory,
	jobId: string,
	confirmations: string[],
	busDependencies: BusDependencies = reviewerBusDependencies(),
	dependencies: LoopDependencies = {},
	gate: GateScript = {},
): {
	commands: Map<string, CommandHandler>;
	context: ExtensionCommandContext;
	notifications: string[];
	/** Every select title in full, in order. */
	selectTitles: string[];
} {
	const commands = new Map<string, CommandHandler>();
	const notifications: string[] = [];
	const selectTitles: string[] = [];
	const hasUI = (): boolean => (typeof gate.hasUI === "function" ? gate.hasUI() : (gate.hasUI ?? true));
	// The loop is detached from its handler: the harness settles it so a test
	// reads the outcome the operator would, after the run.
	const pi = {
		on() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, async (args, ctx) => {
				await options.handler(args, ctx);
				await liveLoopSettled();
			});
		},
	};
	registerControlPlane(pi as unknown as Parameters<typeof registerControlPlane>[0], {
		createAgentSession: factory,
		busDependencies,
		jobId,
		...dependencies,
	});
	const context = {
		cwd: directory,
		get hasUI() {
			return hasUI();
		},
		mode: gate.hasUI === false ? "print" : "tui",
		ui: {
			async confirm(title: string) {
				assert.ok(hasUI(), `confirm(${title}) requested without dialog UI`);
				confirmations.push(title);
				return true;
			},
			async select(title: string, options: string[]) {
				assert.ok(hasUI(), `select(${title}) requested without dialog UI`);
				selectTitles.push(title);
				const firstLine = title.split("\n")[0] ?? title;
				if (isDeepStrictEqual(options, [...RELEASE_GATE_OPTIONS])) {
					confirmations.push(firstLine);
					await gate.onRelease?.();
					return gate.releaseAnswers === undefined || gate.releaseAnswers.length === 0
						? RELEASE_GATE_OPTIONS[0]
						: gate.releaseAnswers.shift();
				}
				assert.deepEqual(options, [...INTENT_GATE_OPTIONS]);
				gate.selections?.push(firstLine);
				assert.equal(
					gate.executed?.includes("implement") ?? false,
					false,
					"implementation cannot start before desired-state acceptance",
				);
				return gate.answers === undefined || gate.answers.length === 0
					? INTENT_GATE_OPTIONS[0]
					: gate.answers.shift();
			},
			async editor(title: string) {
				assert.ok(hasUI(), `editor(${title}) requested without dialog UI`);
				return gate.onEditor === undefined ? gate.feedbacks?.shift() : gate.onEditor(title);
			},
			notify(message: string) {
				notifications.push(message);
			},
			setWidget() {},
		},
	} as unknown as ExtensionCommandContext;
	return { commands, context, notifications, selectTitles };
}

async function readEvents(directory: string, jobId: string): Promise<Record<string, unknown>[]> {
	return (await readFile(join(directory, ".kpi", "runs", jobId, "events.jsonl"), "utf8"))
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function approvalEvents(directory: string, jobId: string): Promise<Record<string, unknown>[]> {
	return (await readEvents(directory, jobId)).filter((record) => record.type === "approval.result");
}

async function terminalEvents(directory: string, jobId: string): Promise<Record<string, unknown>[]> {
	return (await readEvents(directory, jobId)).filter((record) => record.type === "loop.terminal");
}

async function latestCheckpoint(directory: string, jobId: string): Promise<GraphRunState> {
	const graphDirectory = join(directory, ".kpi", "runs", jobId, "graph");
	const names = (await readdir(graphDirectory)).sort();
	return JSON.parse(await readFile(join(graphDirectory, names.at(-1)!), "utf8")) as GraphRunState;
}

test("loop on healthcheck fixture reaches human confirm with green gates", async () => {
	const directory = await fixture();
	const jobId = "20260831-healthcheck-gated";
	const executed: string[] = [];
	const confirmations: string[] = [];
	const selections: string[] = [];
	try {
		assert.ok((await readFile(join(directory, "test", "health", "health.test.js"), "utf8")).includes("GET /health"));
		const task = await readFile(join(directory, "task.txt"), "utf8");
		const red = await execFile("npm", ["test"], {
			cwd: directory,
			env: commandEnvironment,
		}).then(
			(result) => ({ failed: false, output: result.stdout }),
			(error: { stdout?: string }) => ({ failed: true, output: error.stdout ?? "" }),
		);
		assert.equal(red.failed, true, red.output);
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { validateCommands: true, jobId }),
			jobId,
			confirmations,
			reviewerBusDependencies(),
			{},
			{ selections, executed },
		);

		await harness.commands.get("loop")!(task, harness.context);
		assert.equal(
			harness.notifications.some((message) => message.includes("failed")),
			false,
			`${harness.notifications.join("\n")}\nexecuted: ${executed.join(", ")}`,
		);

		assert.deepEqual(confirmations, ["Approve gated release"]);
		assert.ok(executed.includes("specify"));
		const approvals = await approvalEvents(directory, jobId);
		assert.deepEqual(
			approvals.map((record) => [record.node, record.approved]),
			[
				["intent", true],
				["human", true],
			],
		);
		const accepted = await readTaskForJob(directory, jobId);
		assert.equal(accepted.intent_details?.journeys[0]?.id, "health");
		assert.equal(accepted.acceptance[0]?.check?.cmd, "npm test");
		const state = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(state.status, "DONE");
		assert.equal(state.passed, true);
		assert.deepEqual(state.bounds, { held: true });
		assert.match(await git(directory, "log", "-1", "--pretty=%s"), CONVENTIONAL_COMMIT_PATTERN);
		// A finished run must be legible from the event log on its own: an
		// operator reconstructing this job from `events.jsonl` never reads
		// `state.json`.
		const terminals = (await readFile(join(directory, ".kpi", "runs", jobId, "events.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type: string; status?: string; job_id?: string })
			.filter((record) => record.type === "loop.terminal");
		assert.equal(terminals.length, 1, JSON.stringify(terminals));
		assert.equal(terminals[0]?.status, "DONE");
		assert.equal(terminals[0]?.job_id, jobId);
		assert.equal(await verifyChain(join(directory, ".kpi", "runs", jobId, "events.jsonl")), true);
	} finally {
		await cleanupFixture(directory);
	}
});

type PolicyHook = (
	event: ToolCallEvent,
	context: { cwd: string; ui: { confirm: (title: string, question: string) => Promise<boolean> } },
) => Promise<ToolCallEventResult | undefined>;

/**
 * The policy hook exactly as the harness registers it for a graph node's
 * session: it reads the live job's mode, release flag, and bounds from the run
 * store itself. What it answers here is what a real ship node's bash tool
 * would have been allowed to do.
 */
function livePolicyHook(): PolicyHook {
	let hook: PolicyHook | undefined;
	registerPolicy({
		on(event: string, handler: unknown) {
			if (event === "tool_call") hook = handler as PolicyHook;
		},
	} as unknown as Parameters<typeof registerPolicy>[0]);
	assert.ok(hook, "registerPolicy must register a tool_call hook");
	return hook;
}

function bashCall(command: string): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-ship", toolName: "bash", input: { command } };
}

/** A bare `origin` the fixture can push to, with no GitHub behind it. */
async function bareOrigin(directory: string): Promise<string> {
	const origin = await mkdtemp(join(tmpdir(), "k-pi-origin-"));
	await git(origin, "init", "--bare", "--initial-branch=main");
	await git(directory, "remote", "add", "origin", origin);
	return origin;
}

/** The ship node as the prompt asks for it, every command judged by the live policy first. */
function shipThroughPolicy(
	directory: string,
	branch: string,
	hook: PolicyHook,
	judged: { command: string; blocked: boolean; reason?: string }[],
	prompts: string[],
): (prompt: string, trailer: string) => Promise<void> {
	const context = {
		cwd: directory,
		ui: {
			confirm: async (title: string, question: string) => {
				prompts.push(`${title}\n${question}`);
				return true;
			},
		},
	};
	const judge = async (command: string): Promise<boolean> => {
		const result = await hook(bashCall(command), context);
		judged.push({ command, blocked: result?.block === true, reason: result?.reason });
		return result?.block !== true;
	};
	return async (_prompt, trailer) => {
		assert.equal(
			await git(directory, "branch", "--show-current"),
			branch,
			"the control plane put the worktree on the job branch",
		);

		// What a ship node must never be able to do, even now that release is approved.
		for (const forbidden of [
			"git push origin main",
			`git push --force origin ${branch}`,
			`git push origin --delete ${branch}`,
			"git push origin v0.2.1",
			`git push upstream ${branch}`,
			"gh pr merge --auto --merge",
		]) {
			assert.equal(await judge(forbidden), false, `${forbidden} must be blocked`);
		}

		assert.ok(await judge("git add -A"));
		await git(directory, "add", "-A");
		const message = `feat(health): add healthcheck endpoint\n\n${trailer}`;
		assert.ok(await judge(`git commit -m "${message.replaceAll("\n", "\\n")}"`));
		await git(directory, "commit", "-m", message);
	};
}

async function runDocument(directory: string, jobId: string, name: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, name), "utf8")) as Record<string, unknown>;
}

test("the ship node commits on the job branch, pushes only that branch, and opens the pull request", async () => {
	const directory = await fixture();
	const origin = await bareOrigin(directory);
	const jobId = "20260903-healthcheck-ship";
	const branch = `kpi/${jobId}`;
	const executed: string[] = [];
	const confirmations: string[] = [];
	const judged: { command: string; blocked: boolean; reason?: string }[] = [];
	const prompts: string[] = [];
	const pullRequests = new Map<string, PullRequestRecord>();
	try {
		const seedHead = await git(directory, "rev-parse", "HEAD");
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, {
				jobId,
				ship: shipThroughPolicy(directory, branch, livePolicyHook(), judged, prompts),
			}),
			jobId,
			confirmations,
			reviewerBusDependencies(),
			{
				readPullRequest: async (_projectRoot, head) => pullRequests.get(head),
				createPullRequest: async (_projectRoot, head) => {
					pullRequests.set(head, { url: "https://github.com/example/fixture/pull/1", state: "OPEN" });
				},
			},
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		assert.deepEqual(confirmations, ["Approve gated release"]);

		// The contract froze the branch rule, not "Never push".
		const task = await runDocument(directory, jobId, "task.json");
		assert.equal((task.constraints as string[]).includes("Never push"), false);
		assert.ok((task.constraints as string[]).some((constraint) => constraint.includes(branch)));

		// Every forbidden push was blocked by the live policy; the prescribed steps ran.
		const blocked = judged.filter((entry) => entry.blocked).map((entry) => entry.command);
		assert.deepEqual(blocked, [
			"git push origin main",
			`git push --force origin ${branch}`,
			`git push origin --delete ${branch}`,
			"git push origin v0.2.1",
			`git push upstream ${branch}`,
			"gh pr merge --auto --merge",
		]);
		for (const entry of judged.filter((item) => item.blocked)) {
			assert.match(entry.reason ?? "", /Policy denied/u, entry.command);
		}
		assert.deepEqual(
			judged.filter((entry) => !entry.blocked).map((entry) => entry.command.split(" ").slice(0, 3).join(" ")),
			["git add -A", "git commit -m"],
		);
		// The gated commit still asked, with the real diff stat; nothing else did.
		assert.equal(prompts.length, 1, prompts.join("\n---\n"));
		assert.match(prompts[0], /^Approve git commit\n/u);
		assert.match(prompts[0], /files changed/u);

		// The commit is on the job branch, the job branch is on origin, and the
		// marker records the branch and the pull request.
		assert.equal(await git(directory, "branch", "--show-current"), branch);
		const head = await git(directory, "rev-parse", "HEAD");
		assert.equal(await git(directory, "rev-list", "--count", `${seedHead}..HEAD`), "1");
		assert.equal(
			await git(origin, "rev-parse", `refs/heads/${branch}`),
			head,
			"origin carries the job branch at HEAD",
		);
		await assert.rejects(git(origin, "rev-parse", "--verify", "--quiet", "refs/heads/main"), "main was never pushed");
		const marker = await runDocument(directory, jobId, "ship.json");
		assert.equal(marker.job_id, jobId);
		assert.equal(marker.head, head);
		assert.equal(marker.branch, branch);
		assert.equal(marker.pr_url, "https://github.com/example/fixture/pull/1");
		assert.equal(await verifyChain(join(directory, ".kpi", "runs", jobId, "events.jsonl")), true);
	} finally {
		await cleanupFixture(directory);
		await rm(origin, { recursive: true, force: true });
	}
});

test("a pushed job branch with no pull request stops NEEDS_HUMAN and finishes on resume without a second commit", async () => {
	const directory = await fixture();
	const origin = await bareOrigin(directory);
	const jobId = "20260903-healthcheck-no-pr";
	const branch = `kpi/${jobId}`;
	const executed: string[] = [];
	const pullRequests = new Map<string, PullRequestRecord>();
	const readPullRequest = async (_projectRoot: string, head: string) => pullRequests.get(head);
	try {
		const seedHead = await git(directory, "rev-parse", "HEAD");
		const first = commandHarness(
			directory,
			loopSessions(directory, executed, {
				jobId,
				ship: async (_prompt, trailer) => {
					await git(directory, "add", "-A");
					await git(directory, "commit", "-m", `feat(health): add healthcheck endpoint\n\n${trailer}`);
					await git(directory, "push", "-u", "origin", branch);
					// gh pr create failed: signed out, say. No pull request exists.
				},
			}),
			jobId,
			[],
			reviewerBusDependencies(),
			{
				readPullRequest,
				createPullRequest: async () => {
					throw new PullRequestLookupError("GitHub authentication is required");
				},
			},
		);
		await first.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), first.context);
		const stopped = await runDocument(directory, jobId, "state.json");
		assert.equal(stopped.status, "NEEDS_HUMAN");
		assert.match(String(stopped.reason), /GitHub authentication is required/u);
		assert.match(String(stopped.reason), new RegExp(`resume with /kpi ${jobId}`, "u"));
		assert.equal(stopped.recovery, "delivery", "the recovery kind is persisted with the terminal, not only worded");
		// The operator is told through the job's own terminal, never a thrown "loop failed".
		assert.ok(
			first.notifications.some((message) => message.includes(`K-π job ${jobId} NEEDS_HUMAN`)),
			first.notifications.join("\n"),
		);
		assert.equal(
			first.notifications.some((message) => message.includes("loop failed")),
			false,
			first.notifications.join("\n"),
		);
		await assert.rejects(readFile(join(directory, ".kpi", "runs", jobId, "ship.json"), "utf8"), { code: "ENOENT" });
		const shipped = await git(directory, "rev-parse", "HEAD");

		// The operator opens the pull request by hand and resumes the job.
		pullRequests.set(branch, { url: "https://github.com/example/fixture/pull/2", state: "OPEN" });
		const resumeExecuted: string[] = [];
		const second = commandHarness(
			directory,
			loopSessions(directory, resumeExecuted, { jobId }),
			jobId,
			[],
			reviewerBusDependencies(),
			{ readPullRequest },
		);
		await second.commands.get("kpi")!(jobId, second.context);
		const done = await runDocument(directory, jobId, "state.json");
		assert.equal(done.status, "DONE", `${done.reason}\n${second.notifications.join("\n")}`);
		assert.equal(resumeExecuted.includes("ship"), false, "the ship node never ran again");
		assert.equal(await git(directory, "rev-parse", "HEAD"), shipped, "no second commit");
		assert.equal(await git(directory, "rev-list", "--count", `${seedHead}..HEAD`), "1");
		const marker = await runDocument(directory, jobId, "ship.json");
		assert.equal(marker.head, shipped);
		assert.equal(marker.branch, branch);
		assert.equal(marker.pr_url, "https://github.com/example/fixture/pull/2");
	} finally {
		await cleanupFixture(directory);
		await rm(origin, { recursive: true, force: true });
	}
});

test("delivery resumes an unpushed commit and reconciles a PR created before a transport failure", async () => {
	const directory = await fixture();
	const origin = await bareOrigin(directory);
	const jobId = "20260903-healthcheck-unpushed";
	const branch = `kpi/${jobId}`;
	let pullRequest: PullRequestRecord | undefined;
	let creations = 0;
	try {
		const initialHead = await git(directory, "rev-parse", "HEAD");
		const harness = commandHarness(
			directory,
			loopSessions(directory, [], { jobId }),
			jobId,
			[],
			reviewerBusDependencies(),
			{
				readPullRequest: async () => pullRequest,
				createPullRequest: async () => {
					creations += 1;
					pullRequest = { url: "https://github.com/example/fixture/pull/3", state: "OPEN" };
					throw Object.assign(new Error("response lost after creating the pull request"), { status: 503 });
				},
				sleep: async () => undefined,
			},
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);
		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", String(state.reason));
		assert.equal(creations, 1, "the remote PR is reconciled instead of created twice");
		const head = await git(directory, "rev-parse", "HEAD");
		assert.equal(await git(origin, "rev-parse", `refs/heads/${branch}`), head);
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
		assert.equal((await runDocument(directory, jobId, "ship.json")).pr_url, pullRequest?.url);
	} finally {
		await cleanupFixture(directory);
		await rm(origin, { recursive: true, force: true });
	}
});

test("a completed host delivery is not stranded by an uncheckpointed final lookup", async () => {
	const directory = await fixture();
	const origin = await bareOrigin(directory);
	const jobId = "20260905-delivery-finalization";
	const branch = `kpi/${jobId}`;
	let lookups = 0;
	try {
		const initialHead = await git(directory, "rev-parse", "HEAD");
		const harness = commandHarness(
			directory,
			loopSessions(directory, [], { jobId }),
			jobId,
			[],
			reviewerBusDependencies(),
			{
				readPullRequest: async () => {
					lookups += 1;
					if (lookups === 2)
						throw Object.assign(new Error("transient final lookup failure after delivery"), { status: 503 });
					return { url: "https://github.com/example/fixture/pull/4", state: "OPEN" };
				},
				sleep: async () => undefined,
			},
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);
		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", String(state.reason));
		assert.equal(await git(origin, "rev-parse", `refs/heads/${branch}`), await git(directory, "rev-parse", "HEAD"));
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
		assert.equal(
			(await runDocument(directory, jobId, "ship.json")).pr_url,
			"https://github.com/example/fixture/pull/4",
		);
	} finally {
		await cleanupFixture(directory);
		await rm(origin, { recursive: true, force: true });
	}
});

test("a provider refusal becomes actionable NEEDS_HUMAN with the provider's reason", async () => {
	const directory = await fixture();
	const jobId = "20260903-provider-refusal";
	const providerFailure =
		'400 {"type":"error","error":{"message":"You\'re out of extra usage. Add more and keep going."}}';
	const factory: GraphAgentSessionFactory = async (options) => ({
		session: {
			sessionId: "provider-refusal",
			async prompt() {},
			getLastAssistantError: () => providerFailure,
			getActiveToolNames: () => [...(options.tools ?? [])],
			dispose() {},
		},
	});
	try {
		const confirmations: string[] = [];
		const harness = commandHarness(directory, factory, jobId, confirmations);
		await harness.commands.get("kpi")!("fix the account integration", harness.context);

		const state = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as {
			status: string;
			reason: string;
		};
		assert.equal(state.status, "NEEDS_HUMAN", harness.notifications.join("\n"));
		assert.match(state.reason, /out of extra usage/u);
		assert.doesNotMatch(state.reason, /stack\.json is missing|assistant response text is unavailable/u);
		assert.ok(
			harness.notifications.some((message) => /NEEDS_HUMAN.*out of extra usage/iu.test(message)),
			`operator notification must include the actionable cause: ${harness.notifications.join("\n")}`,
		);
		assert.deepEqual(confirmations, ["K-π provider recovery"]);
		assert.ok(harness.notifications.some((message) => message.includes(`/kpi ${jobId}`)));
	} finally {
		await cleanupFixture(directory);
	}
});

test("kpi --plan freezes and hashes plan files without executing specify", async () => {
	const directory = await fixture();
	const jobId = "20260831-healthcheck-plan";
	const executed: string[] = [];
	try {
		const harness = commandHarness(directory, loopSessions(directory, executed, { jobId }), jobId, []);

		await harness.commands.get("kpi")!("--plan specs/healthcheck", harness.context);

		assert.ok(executed.includes("plan-check"));
		assert.equal(executed.includes("specify"), false);
		const checkpoint = await latestCheckpoint(directory, jobId);
		assert.equal(checkpoint.nodes.specify.runs, 0);
		for (const name of ["requirements.md", "design.md", "tasks.md"]) {
			assert.ok((await readFile(join(directory, ".kpi", "runs", jobId, "plan", name), "utf8")).length > 0);
		}
		const fingerprints = JSON.parse(
			await readFile(join(directory, ".kpi", "runs", jobId, "fingerprints.json"), "utf8"),
		) as { plan: Record<string, string> };
		assert.deepEqual(Object.keys(fingerprints.plan).sort(), [
			"plan/design.md",
			"plan/requirements.md",
			"plan/tasks.md",
		]);
		assert.ok(Object.values(fingerprints.plan).every((hash) => /^sha256:[0-9a-f]{64}$/u.test(hash)));
	} finally {
		await cleanupFixture(directory);
	}
});

test("agent response retries until it validates against response schema", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-review-response-"));
	const prompts: string[] = [];
	const responses = [JSON.stringify({ approved: true }), validVerdict];
	let responseIndex = 0;
	const factory: GraphAgentSessionFactory = async (options) => {
		let last: string | undefined;
		return {
			session: {
				sessionId: "review-session",
				async prompt(prompt) {
					prompts.push(prompt);
					last = responses[responseIndex];
					responseIndex += 1;
				},
				getLastAssistantText: () => last,
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		};
	};
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "review-contract",
		entry: "review",
		nodes: [
			{
				id: "review",
				type: "agent",
				prompt: "Review candidate",
				context: { mode: "isolated" },
				tools: ["read"],
				readOnly: true,
				response: {
					path: "verdict.json",
					schema: "verdict.schema.json",
					retries: 2,
					state: { "review.approved": "approved" },
				},
			},
		],
		edges: [{ from: "review", to: "__end__" }],
		limits: { maxConcurrency: 1 },
		policy: {
			allowNonInteractive: false,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: true,
			confirmMutatingNodes: true,
		},
	};

	try {
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "review-job",
			createAgentSession: factory,
		});
		const state = await engine.runUntilPause();

		assert.equal(prompts.length, 2);
		assert.match(prompts[1]!, /failed verdict\.schema\.json/u);
		assert.deepEqual(state.values.review, { approved: true });
		assert.deepEqual(
			JSON.parse(await readFile(join(directory, ".kpi", "runs", "review-job", "verdict.json"), "utf8")),
			JSON.parse(validVerdict),
		);
	} finally {
		await cleanupFixture(directory);
	}
});

test("ship commit subject matches the conventional commit contract", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-ship-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "file.txt");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");
		await writeFile(join(directory, "file.txt"), "changed\n");
		await git(directory, "add", "file.txt");
		await git(directory, "commit", "-m", "fix(ship): validate commit subject");

		const subject = await verifyShippedCommit(directory, previousHead);
		assert.equal(subject, "fix(ship): validate commit subject");
		assert.match(subject, CONVENTIONAL_COMMIT_PATTERN);
	} finally {
		await cleanupFixture(directory);
	}
});

test("ship verification identifies the job's own commit by its trailer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-trailer-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");

		// An unrelated conventional commit is not this job's decision.
		await writeFile(join(directory, "other.txt"), "other\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore(deps): unrelated");
		assert.equal(await findJobCommit(directory, "job-a", previousHead), undefined);
		await assert.rejects(
			verifyShippedCommit(directory, previousHead, "job-a"),
			/does not carry KPI-Job: job-a/u,
			"a commit without the trailer cannot pass verification",
		);

		// The job's own commit is found, whatever lands on top of it afterwards.
		await writeFile(join(directory, "shipped.txt"), "shipped\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", `feat(ship): the job's commit\n\nKPI-Job: job-a`);
		const shipped = await git(directory, "rev-parse", "HEAD");
		await writeFile(join(directory, "later.txt"), "later\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "docs(readme): later work");

		assert.deepEqual(await findJobCommit(directory, "job-a", previousHead), {
			head: shipped,
			subject: "feat(ship): the job's commit",
		});
		assert.equal(await findJobCommit(directory, "job-b", previousHead), undefined, "another job's id finds nothing");

		// A trailer inside a sentence is not a trailer line.
		await writeFile(join(directory, "prose.txt"), "prose\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore(x): mentions KPI-Job: job-c in prose");
		assert.equal(await findJobCommit(directory, "job-c", previousHead), undefined);
	} finally {
		await cleanupFixture(directory);
	}
});

test("two commits claiming one job id fail closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-ambiguous-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");

		for (const attempt of ["first", "second"]) {
			await writeFile(join(directory, `${attempt}.txt`), `${attempt}\n`);
			await git(directory, "add", "-A");
			await git(directory, "commit", "-m", `feat(ship): ${attempt} attempt\n\nKPI-Job: job-d`);
		}

		await assert.rejects(
			findJobCommit(directory, "job-d", previousHead),
			/Ambiguous ship commits for job-d/u,
			"nobody can say which commit was the decision",
		);
		await assert.rejects(verifyShippedCommit(directory, previousHead, "job-d"), /2 commits instead of one/u);
	} finally {
		await cleanupFixture(directory);
	}
});

test("a non-conventional job-marked commit is rejected", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-nonconventional-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");
		await writeFile(join(directory, "shipped.txt"), "shipped\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "shipped it\n\nKPI-Job: job-e");

		await assert.rejects(findJobCommit(directory, "job-e", previousHead), /not Conventional Commits: shipped it/u);
	} finally {
		await cleanupFixture(directory);
	}
});

function confirmationsFor(harness: { notifications: string[] }): string[] {
	return harness.notifications.filter((message) => message.includes("Approve"));
}

/** Every stack the plan could hand implement, and what must happen next. */
const invalidStacks: { name: string; document: string }[] = [
	{
		name: "no stack at all",
		document: "",
	},
	{
		name: "a stack that names no slice",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
	},
	{
		name: "a slice that names no module",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "nope",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
	},
	{
		name: "a module outside the task's permitted feature paths",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "health",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/healthcheck",
					interface: "src/healthcheck/api.ts",
					allowed_paths: ["src/healthcheck/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
	},
	{
		name: "a service module outside the task's permitted feature paths",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "services",
			modules: [
				{
					id: "services",
					purpose: "every service in the app",
					folder: "src/services",
					interface: "src/services/api.ts",
					allowed_paths: ["src/services/**", "test/services/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
	},
	{
		name: "horizontal delivery with no reason",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "horizontal",
			root: "src",
			current_module_id: "health",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
	},
];

test("invalid stack repair remains write-blocked and an operator can stop a persistently defective planner", async () => {
	for (const scenario of invalidStacks) {
		const directory = await fixture();
		const jobId = "20260901-stack-invalid";
		const executed: string[] = [];
		let repairObserved = false;
		try {
			const harness = commandHarness(
				directory,
				loopSessions(directory, executed, {
					jobId,
					// An empty document means the plan wrote no stack at all.
					stack: scenario.document === "" ? null : scenario.document,
					onPrompt: async (node) => {
						if (node !== "plan") return;
						const checkpoint = await latestCheckpoint(directory, jobId);
						if (checkpoint.nodes.plan.runs > 1) {
							repairObserved = true;
							// The fake planner intentionally never fixes its output. Stop it
							// explicitly rather than inventing a runtime retry cap.
							await writeStopMarker(join(directory, ".kpi", "runs", jobId), false);
						}
					},
				}),
				jobId,
				[],
			);
			await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

			const state = JSON.parse(
				await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8"),
			) as Record<string, unknown>;
			assert.equal(repairObserved, true, `${scenario.name}: the defect reached a repair attempt`);
			assert.equal(state.status, "STOPPED", `${scenario.name}: the operator stopped the indefinite fixture`);

			// The implement node never ran, so nothing was written and no commit exists.
			assert.equal(executed.includes("implement"), false, `${scenario.name}: implement must not run`);
			assert.equal(executed.includes("ship"), false, `${scenario.name}: ship must not run`);
			// The scaffold never ran, so the map was never created, and the fixture's
			// own source is exactly as it shipped.
			for (const untouched of ["src/health/api.ts", "test/health/index.test.ts"]) {
				await assert.rejects(
					readFile(join(directory, untouched), "utf8"),
					{ code: "ENOENT" },
					`${scenario.name}: ${untouched} must not exist`,
				);
			}
			assert.match(
				await readFile(join(directory, "src", "health", "server.js"), "utf8"),
				/not_found/u,
				`${scenario.name}: the fixture's source was never rewritten`,
			);
			assert.deepEqual(confirmationsFor(harness), [], `${scenario.name}: no operator was asked to approve`);
		} finally {
			await cleanupFixture(directory);
		}
	}
});

test("a stale ownership map is repaired by the planner before implementation without another approval gate", async () => {
	const directory = await fixture();
	const jobId = "20260901-stack-stale";
	const executed: string[] = [];
	try {
		// The plan writes a map bound to a different contract.
		const staleStack = JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "health",
			task_hash: `sha256:${"0".repeat(64)}`,
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		});
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId, stacks: [staleStack, healthStackRevised] }),
			jobId,
			[],
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		assert.deepEqual(executed.slice(0, 4), ["specify", "plan", "plan", "implement"]);
		assert.equal(
			executed.filter((node) => node === "implement").length,
			1,
			"the stale plan never authorized a write",
		);
		assert.deepEqual(
			(await approvalEvents(directory, jobId)).map((event) => event.node),
			["intent", "human"],
		);
	} finally {
		await cleanupFixture(directory);
	}
});

test("explicit feature ownership admits implementation without creating gratuitous interface or test stubs", async () => {
	const directory = await fixture();
	const jobId = "20260901-stack-valid";
	const executed: string[] = [];
	const confirmations: string[] = [];
	try {
		const harness = commandHarness(directory, loopSessions(directory, executed, { jobId }), jobId, confirmations);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		assert.ok(executed.includes("implement"), "a valid map reaches implement");
		const runDirectory = join(directory, ".kpi", "runs", jobId);
		const task = JSON.parse(await readFile(join(runDirectory, "task.json"), "utf8")) as {
			current_module_id?: string;
		};
		assert.equal(task.current_module_id, "health", "the plan's slice is frozen into the job contract");

		const map = await runDocument(directory, jobId, "stack.json");
		assert.equal((map.modules as Array<{ interface: string }>)[0]?.interface, "src/health/server.js");
		assert.equal(await readFile(join(directory, "src/health/server.js"), "utf8"), implementedServer);
		for (const path of ["src/health/api.ts", "test/health/index.test.ts"]) {
			await assert.rejects(readFile(join(directory, path), "utf8"), { code: "ENOENT" });
		}
		const state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		assert.equal(state.status, "DONE", `expected DONE, saw ${String(state.status)}: ${String(state.reason)}`);
	} finally {
		await cleanupFixture(directory);
	}
});

test("a planner cannot silently change the accepted playbook to bypass stack checks", async () => {
	const directory = await fixture();
	const jobId = "20260901-stack-exempt";
	const executed: string[] = [];
	try {
		// The plan is not authorized to change the operator's accepted contract.
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId, playbook: "typo" }),
			jobId,
			[],
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(state.status, "NEEDS_HUMAN");
		assert.equal(state.recovery, "contract");
		assert.equal(executed.includes("implement"), false);
	} finally {
		await cleanupFixture(directory);
	}
});

test("kpi --no-network freezes the operator's offline decision onto the contract", async () => {
	const directory = await fixture();
	const jobId = "20260902-healthcheck-offline";
	const executed: string[] = [];
	try {
		const harness = commandHarness(directory, loopSessions(directory, executed, { jobId }), jobId, []);
		// Keys are present and healthy: the only reason this job stays offline is
		// that the operator said so on the command line.
		process.env.EXA_API_KEY = "exa-offline-control";
		try {
			await harness.commands.get("kpi")!("--no-network add a healthcheck endpoint and verify it", harness.context);
		} finally {
			delete process.env.EXA_API_KEY;
		}

		const runDirectory = join(directory, ".kpi", "runs", jobId);
		const task = JSON.parse(await readFile(join(runDirectory, "task.json"), "utf8")) as {
			research_network?: string;
			goal: string;
		};
		// On the validated contract, so a resumed job in a fresh process stays offline.
		assert.equal(task.research_network, "offline");
		assert.equal(task.goal, "add a healthcheck endpoint and verify it", "the flag is not part of the goal");

		const research = JSON.parse(await readFile(join(runDirectory, "research.json"), "utf8")) as {
			mode: string;
			network: { state: string; origin?: string; reason?: string; failures: { service?: string }[] };
			sources: { kind: string; ref: string }[];
		};
		assert.equal(research.network.state, "no-network");
		assert.equal(research.network.origin, "operator", "the operator owns this decision, not the engine");
		assert.equal(research.network.reason, "operator requested no-network");
		assert.deepEqual(research.network.failures, [], "an operator decision is not a recorded failure");
		assert.equal(research.mode, "local");
		assert.ok(research.sources.length > 0, "the repository was still researched");
		for (const source of research.sources) {
			assert.equal(source.kind, "local");
			assert.doesNotMatch(source.ref, /^https?:/u, "no external URL was recorded");
		}
		// The board cell an operator sees for that state.
		assert.deepEqual(researchCellFromDocument(research), { cell: "RESEARCH local · no-network operator" });
	} finally {
		await cleanupFixture(directory);
	}
});

test("intent clarification reaches a fresh proposer before any implementation", async () => {
	const directory = await fixture();
	const jobId = "20260903-intent-changes";
	const executed: string[] = [];
	const prompts: string[] = [];
	const feedback = "Health clients must receive JSON without authentication";
	try {
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, {
				jobId,
				prompts,
				proposals: [{}, { requirements: [feedback] }],
			}),
			jobId,
			[],
			reviewerBusDependencies(),
			{},
			{
				executed,
				answers: ["Request changes", "Request changes", "Accept intent"],
				feedbacks: ["   ", feedback],
			},
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);
		const waiting = await runDocument(directory, jobId, "state.json");
		assert.equal(waiting.status, "NEEDS_HUMAN", "blank clarification is not an operator decision");
		assert.equal(waiting.recovery, "approval");
		assert.equal(executed.includes("implement"), false);
		assert.equal((await readTaskForJob(directory, jobId)).intent_details, undefined);
		await harness.commands.get("kpi")!(jobId, harness.context);
		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		assert.deepEqual(executed.slice(0, 3), ["specify", "specify", "plan"]);
		assert.ok(prompts.filter((prompt) => prompt.startsWith("specify\n"))[1]?.includes(feedback));
		const accepted = await readTaskForJob(directory, jobId);
		assert.deepEqual(accepted.intent_details?.requirements, [feedback]);
		assert.equal((await approvalEvents(directory, jobId)).filter((event) => event.node === "intent").length, 1);
	} finally {
		await cleanupFixture(directory);
	}
});

test("unattended gated intent cannot authorize implementation", async () => {
	const directory = await fixture();
	const jobId = "20260903-intent-no-ui";
	const executed: string[] = [];
	try {
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId }),
			jobId,
			[],
			reviewerBusDependencies(),
			{},
			{ executed, hasUI: false },
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);
		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "NEEDS_HUMAN", `${state.reason}\n${harness.notifications.join("\n")}`);
		assert.equal(state.recovery, "approval");
		assert.equal(executed.includes("implement"), false);
		assert.deepEqual(await approvalEvents(directory, jobId), []);
		assert.equal((await readTaskForJob(directory, jobId)).intent_details, undefined);
	} finally {
		await cleanupFixture(directory);
	}
});

test("dismissed intent resumes without repeating an accepted desired-state gate", async () => {
	const directory = await fixture();
	const jobId = "20260903-intent-resume";
	const executed: string[] = [];
	const selections: string[] = [];
	try {
		const first = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId }),
			jobId,
			[],
			reviewerBusDependencies(),
			{},
			{ selections, executed, answers: [undefined] },
		);
		await first.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), first.context);
		assert.equal((await runDocument(directory, jobId, "state.json")).status, "NEEDS_HUMAN");
		assert.equal(executed.includes("implement"), false);
		const resumed = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId }),
			jobId,
			[],
			reviewerBusDependencies(),
			{},
			{ selections, executed },
		);
		await resumed.commands.get("kpi")!(jobId, resumed.context);
		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${resumed.notifications.join("\n")}`);
		assert.equal(selections.length, 2);
		await resumed.commands.get("kpi")!(jobId, resumed.context);
		assert.equal(selections.length, 2);
		assert.equal((await approvalEvents(directory, jobId)).filter((event) => event.node === "intent").length, 1);
	} finally {
		await cleanupFixture(directory);
	}
});
test("host verification accepts a verify node's kind rather than its literal identifier", async () => {
	const directory = await fixture();
	const jobId = "20260905-renamed-verifier";
	const executed: string[] = [];
	try {
		const graph = JSON.parse(
			await readFile(
				new URL("../packages/coding-agent/src/kpi/graphs/coding-loop.gated.json", import.meta.url),
				"utf8",
			),
		) as GraphDefinition;
		const verificationNode = graph.nodes.find((node) => node.id === "verify")!;
		verificationNode.id = "candidate-verification-42";
		for (const edge of graph.edges) {
			if (edge.from === "verify") edge.from = verificationNode.id;
			if (edge.to === "verify") edge.to = verificationNode.id;
		}
		await mkdir(join(directory, ".kpi", "graphs"), { recursive: true });
		await writeFile(join(directory, ".kpi", "graphs", "coding-loop.gated.json"), JSON.stringify(graph));
		const harness = commandHarness(directory, loopSessions(directory, executed, { jobId }), jobId, []);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);
		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		assert.equal((await runDocument(directory, jobId, "evidence.json")).verifier_id, "host:verification");
		assert.equal(
			executed.includes("candidate-verification-42"),
			false,
			"verification executes on the host, never a model",
		);
	} finally {
		await cleanupFixture(directory);
	}
});

test("release approval cannot authorize stale, forged, or missing host evidence", async () => {
	for (const failure of ["stale", "ignored-neighbor", "forged", "missing"] as const) {
		const directory = await fixture();
		const jobId = `20260905-release-${failure}`;
		const executed: string[] = [];
		try {
			const ignoredNeighbor = join(directory, ".kpi-backup", "candidate.txt");
			if (failure === "ignored-neighbor") {
				await mkdir(join(directory, ".kpi-backup"));
				await writeFile(ignoredNeighbor, "before\n");
				await writeFile(join(directory, ".gitignore"), ".kpi/\n.kpi-backup/\n");
			}
			const seedHead = await git(directory, "rev-parse", "HEAD");
			const harness = commandHarness(
				directory,
				loopSessions(directory, executed, { jobId }),
				jobId,
				[],
				reviewerBusDependencies(),
				{},
				{
					onRelease: async () => {
						const evidence = await runDocument(directory, jobId, "evidence.json");
						assert.equal(evidence.passed, true, "the original candidate passed real host commands");
						if (failure === "stale") {
							await writeFile(
								join(directory, "src", "health", "server.js"),
								`${implementedServer}\n// changed after verification\n`,
							);
						} else if (failure === "ignored-neighbor") {
							// Same ignored filename, new content: neither a directory listing
							// nor an overbroad `.kpi` prefix exemption may hide this change.
							await writeFile(ignoredNeighbor, "after!\n");
						} else {
							const path = join(directory, ".kpi", "runs", jobId, "evidence.json");
							await rm(path);
							if (failure === "forged") {
								await writeFile(path, JSON.stringify({ ...evidence, verifier_id: "builder" }), { mode: 0o444 });
							}
						}
					},
				},
			);
			await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);
			const state = await runDocument(directory, jobId, "state.json");
			assert.equal(state.status, "NEEDS_HUMAN", `${failure}: ${state.reason}\n${harness.notifications.join("\n")}`);
			assert.equal(state.recovery, failure === "stale" || failure === "ignored-neighbor" ? "approval" : "review");
			assert.equal(executed.includes("ship"), false);
			assert.equal(await git(directory, "rev-parse", "HEAD"), seedHead);
			assert.equal(
				(await approvalEvents(directory, jobId)).some((event) => event.node === "human" && event.approved === true),
				false,
			);
		} finally {
			await cleanupFixture(directory);
		}
	}
});

test("resume rejects changed accepted intent and continues only after the accepted contract is restored", async () => {
	const directory = await fixture();
	const jobId = "20260905-intent-drift";
	const executed: string[] = [];
	try {
		const first = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId }),
			jobId,
			[],
			reviewerBusDependencies(),
			{},
			{ releaseAnswers: [undefined] },
		);
		await first.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), first.context);
		assert.equal((await runDocument(directory, jobId, "state.json")).recovery, "approval");
		const taskPath = join(directory, ".kpi", "runs", jobId, "task.json");
		const acceptedBytes = await readFile(taskPath, "utf8");
		const changed = JSON.parse(acceptedBytes);
		changed.acceptance[0].required = false;
		await writeFile(taskPath, JSON.stringify(changed));
		const resumedNodes: string[] = [];
		const resumed = commandHarness(directory, loopSessions(directory, resumedNodes, { jobId }), jobId, []);
		await resumed.commands.get("kpi")!(jobId, resumed.context);
		const blocked = await runDocument(directory, jobId, "state.json");
		assert.equal(blocked.status, "NEEDS_HUMAN");
		assert.equal(blocked.recovery, "contract");
		assert.deepEqual(resumedNodes, []);
		await writeFile(taskPath, acceptedBytes);
		await resumed.commands.get("kpi")!(jobId, resumed.context);
		assert.equal((await runDocument(directory, jobId, "state.json")).status, "DONE");
		assert.deepEqual(resumedNodes, ["ship"]);
		assert.equal((await approvalEvents(directory, jobId)).filter((event) => event.node === "intent").length, 1);
	} finally {
		await cleanupFixture(directory);
	}
});

// ---------------------------------------------------------------------------
// Self-healing: no caps, re-plans before the operator, the operator's stop
// ---------------------------------------------------------------------------

/** A review verdict that sends the round back, with a fixed output fingerprint. */
function reviseVerdict(fingerprint: string, issue = "AC-01 is not covered by a test"): Record<string, unknown> {
	return {
		status: "REVISE",
		approved: false,
		blockingIssues: [issue],
		nonBlockingIssues: [],
		evidence: ["evidence.json"],
		round: 1,
		output_fingerprint: `sha256:${fingerprint.repeat(64)}`,
	};
}

const passVerdict = JSON.parse(validVerdict) as Record<string, unknown>;

function timeoutFailure(): Error {
	return Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
}

test("a review round with no progress re-plans with the failing criteria as feedback", async () => {
	const directory = await fixture();
	const jobId = "20260903-replan";
	const executed: string[] = [];
	const prompts: string[] = [];
	const sliceAtPlan: (string | undefined)[] = [];
	const witness = `sha256:${"b".repeat(64)}`;
	try {
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, {
				jobId,
				prompts,
				stacks: [healthStack, healthStackRevised],
				onPrompt: async (node) => {
					if (node !== "plan") return;
					const contract = await runDocument(directory, jobId, "task.json");
					sliceAtPlan.push(
						typeof contract.current_module_id === "string" ? contract.current_module_id : undefined,
					);
				},
			}),
			jobId,
			[],
			// The same verdict twice: the reviewer keeps saying the same thing.
			reviewerBusDependencies({ verdicts: [reviseVerdict("b"), reviseVerdict("b"), passVerdict] }),
			{},
			{ executed },
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		// Host test nodes and bus reviewers are not model sessions.
		assert.deepEqual(executed.slice(0, 5), ["specify", "plan", "implement", "implement", "plan"]);
		assert.equal(executed.filter((node) => node === "plan").length, 2, executed.join(", "));

		const repair = await runDocument(directory, jobId, "repair.json");
		assert.equal(repair.round, 2);
		assert.equal(repair.witness, witness);
		assert.deepEqual(repair.failing_ac, []);
		assert.equal(repair.evidence_ref, "verdict.json");
		assert.deepEqual(state.repaired, [witness]);
		// The slice was unfrozen for the second plan and re-frozen by implement.
		assert.deepEqual(sliceAtPlan, [undefined, undefined]);
		assert.equal((await runDocument(directory, jobId, "task.json")).current_module_id, "health");
		const planPrompts = prompts.filter((prompt) => prompt.startsWith("plan\n"));
		assert.equal(planPrompts.length, 2);
		assert.match(planPrompts[1] ?? "", /repair\.json/u);
		assert.equal((await terminalEvents(directory, jobId)).length, 1);
	} finally {
		await cleanupFixture(directory);
	}
});

test("an approved review that repeats an earlier fingerprint is progress, not a re-plan", async () => {
	const directory = await fixture();
	const jobId = "20260903-pass-repeat";
	const executed: string[] = [];
	try {
		// REVISE once, then PASS twice with the same output fingerprint: the
		// release gate sends the first PASS back to implement; the second PASS
		// repeats the fingerprint on a green round.
		const repeatedPass = { ...passVerdict, output_fingerprint: `sha256:${"f".repeat(64)}` };
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId }),
			jobId,
			[],
			reviewerBusDependencies({ verdicts: [repeatedPass, repeatedPass] }),
			{},
			{ executed, releaseAnswers: ["Request changes"], feedbacks: ["tighten the response headers"] },
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		await assert.rejects(readFile(join(directory, ".kpi", "runs", jobId, "repair.json"), "utf8"), { code: "ENOENT" });
		assert.equal(state.plan_repair, undefined);
		assert.deepEqual(state.repaired, []);
		assert.equal((await runDocument(directory, jobId, "task.json")).current_module_id, "health");
		assert.equal(executed.filter((node) => node === "plan").length, 1, executed.join(", "));
		assert.equal(state.round, 2, "both green rounds were rounds");
	} finally {
		await cleanupFixture(directory);
	}
});

test("a stop that lands before the run is created creates nothing and says so", async () => {
	const directory = await fixture();
	const jobId = "20260903-stop-before-create";
	try {
		const controller = new AbortController();
		const harness = commandHarness(directory, loopSessions(directory, [], { jobId }), jobId, []);
		controller.abort();
		const outcome = await runLoop({ goal: "add a healthcheck endpoint", mode: "gated" }, harness.context, {
			jobId,
			signal: controller.signal,
		});
		assert.equal(outcome.status, "STOPPED");
		assert.equal(outcome.reason, "operator stop before the run was created");
		await assert.rejects(readdir(join(directory, ".kpi", "runs", jobId)), { code: "ENOENT" });
	} finally {
		await cleanupFixture(directory);
	}
});

test("repeated real command failures replan without changing accepted success", async () => {
	const directory = await fixture();
	const jobId = "20260903-red-twice";
	const executed: string[] = [];
	try {
		const failingSource = await readFile(join(directory, "src", "health", "server.js"), "utf8");
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, {
				jobId,
				implementations: [...Array<string>(6).fill(failingSource), implementedServer],
				stacks: [healthStack],
			}),
			jobId,
			[],
			reviewerBusDependencies(),
			{},
			{ executed },
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);
		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		const rounds = await Promise.all(
			(await readdir(join(directory, ".kpi", "runs", jobId, "verification"))).map(async (id) =>
				JSON.parse(
					await readFile(join(directory, ".kpi", "runs", jobId, "verification", id, "evidence.json"), "utf8"),
				),
			),
		);
		assert.ok(
			rounds.filter((round) =>
				round.commands.some(
					(command: { cmd: string; exit: number }) => command.cmd === "npm test" && command.exit !== 0,
				),
			).length >= 6,
			"six broken candidates must fail real verification without a repair-count stop",
		);
		const repair = await runDocument(directory, jobId, "repair.json");
		assert.deepEqual(repair.failing_ac, ["AC-01"]);
		assert.equal((await readTaskForJob(directory, jobId)).acceptance[0]?.check?.expect?.exit, 0);
		const evidence = await runDocument(directory, jobId, "evidence.json");
		assert.equal(evidence.passed, true);
		assert.deepEqual(
			(await approvalEvents(directory, jobId)).map((event) => event.node),
			["intent", "human"],
		);
		assert.ok(executed.filter((node) => node === "plan").length > 3, "strategy repair continues beyond two replans");
	} finally {
		await cleanupFixture(directory);
	}
});

test("a retry is visible on the board and in the event log before the wait starts", async () => {
	const directory = await fixture();
	const jobId = "20260903-retry-visible";
	const executed: string[] = [];
	const observed: { events: Record<string, unknown>[]; state: Record<string, unknown>; notified: boolean }[] = [];
	const slept: number[] = [];
	try {
		const notifications: string[] = [];
		let harnessNotifications: string[] = notifications;
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId, implementFailures: [timeoutFailure()] }),
			jobId,
			[],
			reviewerBusDependencies(),
			{
				retryBaseDelayMs: 1000,
				sleep: async (milliseconds) => {
					slept.push(milliseconds);
					// Everything the operator sees is there before the wait begins.
					observed.push({
						events: (await readEvents(directory, jobId)).filter((record) => record.type === "node.retry"),
						state: await runDocument(directory, jobId, "state.json"),
						notified: harnessNotifications.some((message) =>
							message.includes("retry 1 on implement: timeout; next in 1s"),
						),
					});
				},
			},
		);
		harnessNotifications = harness.notifications;
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "DONE", `${state.reason}\n${harness.notifications.join("\n")}`);
		assert.deepEqual(slept, [1000]);
		const [beforeWait] = observed;
		assert.ok(beforeWait);
		assert.equal(beforeWait.events.length, 1);
		assert.equal(beforeWait.events[0]?.node, "implement");
		assert.equal(beforeWait.events[0]?.attempt, 1);
		assert.equal(beforeWait.events[0]?.reason, "timeout");
		assert.equal(beforeWait.events[0]?.delay_ms, 1000);
		const retry = beforeWait.state.retry as Record<string, unknown>;
		assert.equal(retry.node, "implement");
		assert.equal(retry.attempt, 1);
		assert.equal(retry.reason, "timeout");
		assert.equal(retry.delay_ms, 1000);
		assert.equal(typeof retry.until_ms, "number");
		assert.equal(beforeWait.state.status, "RUNNING");
		assert.equal(beforeWait.notified, true, harness.notifications.join("\n"));
		assert.ok(
			harness.notifications.includes(`K-π ${jobId} retry 1 on implement: timeout; next in 1s (/kpi stop stops it)`),
			harness.notifications.join("\n"),
		);
		// The round never moved for a retry, and the row is gone once the node is through.
		assert.equal("retry" in state, false);
		assert.equal(executed.filter((node) => node === "implement").length, 2);
		assert.equal(await verifyChain(join(directory, ".kpi", "runs", jobId, "events.jsonl")), true);
	} finally {
		await cleanupFixture(directory);
	}
});

test("kpi stop written during a backoff stops the loop at the next wait and leaves a resumable STOPPED job", async () => {
	const directory = await fixture();
	const jobId = "20260903-stop-in-backoff";
	const executed: string[] = [];
	const slept: number[] = [];
	const confirmations: string[] = [];
	try {
		const runDirectory = join(directory, ".kpi", "runs", jobId);
		const first = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId, implementFailures: [timeoutFailure(), timeoutFailure()] }),
			jobId,
			confirmations,
			reviewerBusDependencies(),
			{
				retryBaseDelayMs: 1000,
				sleep: async (milliseconds) => {
					slept.push(milliseconds);
					if (slept.length === 2) {
						// Another session's `/kpi stop`: the marker lands mid-wait.
						await writeFile(
							join(runDirectory, "stop.json"),
							JSON.stringify({ reason: "operator stop", at: new Date().toISOString(), recorded: false }),
						);
					}
				},
			},
		);
		await first.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), first.context);

		const stopped = await runDocument(directory, jobId, "state.json");
		assert.equal(stopped.status, "STOPPED", `${stopped.reason}\n${first.notifications.join("\n")}`);
		assert.equal(stopped.reason, "operator stop");
		assert.deepEqual(slept, [1000, 2000]);
		assert.ok(
			first.notifications.includes(`K-π job ${jobId} STOPPED: operator stop`),
			first.notifications.join("\n"),
		);
		const terminals = await terminalEvents(directory, jobId);
		assert.deepEqual(
			terminals.map((record) => [record.status, record.reason]),
			[["STOPPED", "operator stop"]],
			"the driver recorded the one STOPPED terminal",
		);
		const checkpoint = await latestCheckpoint(directory, jobId);
		const implement = checkpoint.nodes.implement;
		assert.equal(implement.status, "running", "the node is left mid-run, resumable");
		assert.equal(implement.transientRetries, 2);
		assert.equal(executed.filter((node) => node === "implement").length, 2);

		// The operator resumes: the marker is lifted, the wait finishes, the node succeeds.
		const resumeExecuted: string[] = [];
		const second = commandHarness(
			directory,
			loopSessions(directory, resumeExecuted, { jobId }),
			jobId,
			confirmations,
			reviewerBusDependencies(),
			{ retryBaseDelayMs: 1000, sleep: async () => {} },
		);
		await second.commands.get("kpi")!(jobId, second.context);
		await assert.rejects(readFile(join(runDirectory, "stop.json"), "utf8"), { code: "ENOENT" });
		const done = await runDocument(directory, jobId, "state.json");
		assert.equal(done.status, "DONE", `${done.reason}\n${second.notifications.join("\n")}`);
		assert.deepEqual(confirmations, ["Approve gated release"]);
		assert.deepEqual(resumeExecuted, ["implement", "ship"], resumeExecuted.join(", "));
		assert.equal(await verifyChain(join(runDirectory, "events.jsonl")), true);
	} finally {
		await cleanupFixture(directory);
	}
});

test("the release gate offers approve, request changes, and stop", async () => {
	const directory = await fixture();
	const jobId = "20260903-release-gate";
	const executed: string[] = [];
	const confirmations: string[] = [];
	const prompts: string[] = [];
	const feedback = "Return application/json on /health, not text";
	try {
		const first = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId, prompts }),
			jobId,
			confirmations,
			reviewerBusDependencies(),
			{},
			{ executed, releaseAnswers: ["Request changes", "Stop"], feedbacks: [feedback] },
		);
		await first.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), first.context);

		const releaseTitles = first.selectTitles.filter((title) => title.startsWith("Approve gated release"));
		assert.equal(releaseTitles.length, 2, first.selectTitles.join(" | "));
		assert.deepEqual([...RELEASE_GATE_OPTIONS], ["Approve", "Request changes", "Stop"]);
		// Request changes: recorded with its feedback, and implement was told.
		const denial = (await approvalEvents(directory, jobId)).find(
			(record) => record.node === "human" && record.approved === false,
		);
		assert.ok(denial, "the change request is on the record");
		assert.equal(denial.feedback, feedback);
		const implementPrompts = prompts.filter((prompt) => prompt.startsWith("implement\n"));
		assert.equal(implementPrompts.length, 2);
		assert.doesNotMatch(implementPrompts[0] ?? "", /Operator feedback/u);
		assert.ok((implementPrompts[1] ?? "").includes(feedback), implementPrompts[1]);
		// Stop: the job is STOPPED with the gate still pending.
		const stopped = await runDocument(directory, jobId, "state.json");
		assert.equal(stopped.status, "STOPPED", `${stopped.reason}\n${first.notifications.join("\n")}`);
		assert.match(String(stopped.reason), /stopped by the operator at Approve gated release/u);
		assert.ok(String(stopped.reason).includes(`resume with /kpi ${jobId}`));
		assert.equal(stopped.graph_status, "interrupted");
		assert.equal(typeof stopped.pending_question, "string");
		assert.equal(executed.includes("ship"), false);

		// A later resume asks the gate again; Approve ships.
		const resumeExecuted: string[] = [];
		const second = commandHarness(
			directory,
			loopSessions(directory, resumeExecuted, { jobId }),
			jobId,
			confirmations,
			reviewerBusDependencies(),
			{},
			{ executed: resumeExecuted },
		);
		await second.commands.get("kpi")!(jobId, second.context);
		const done = await runDocument(directory, jobId, "state.json");
		assert.equal(done.status, "DONE", `${done.reason}\n${second.notifications.join("\n")}`);
		assert.deepEqual(confirmations, ["Approve gated release", "Approve gated release", "Approve gated release"]);
		assert.deepEqual(resumeExecuted, ["ship"], "nothing but the ship node ran on resume");
		assert.match(await git(directory, "log", "-1", "--pretty=%s"), CONVENTIONAL_COMMIT_PATTERN);
	} finally {
		await cleanupFixture(directory);
	}
});

test("an operator who denies release with policy end stops the job finally", async () => {
	const directory = await fixture();
	const jobId = "20260903-release-denied-end";
	const executed: string[] = [];
	const confirmations: string[] = [];
	try {
		// The shipped gated graph, with the policy that ends the graph on a denial.
		const shipped = JSON.parse(
			await readFile(
				new URL("../packages/coding-agent/src/kpi/graphs/coding-loop.gated.json", import.meta.url),
				"utf8",
			),
		) as { policy: Record<string, unknown> };
		shipped.policy.onHumanDeny = "end";
		await mkdir(join(directory, ".kpi", "graphs"), { recursive: true });
		await writeFile(join(directory, ".kpi", "graphs", "coding-loop.gated.json"), JSON.stringify(shipped, null, "\t"));
		const seedHead = await git(directory, "rev-parse", "HEAD");
		const first = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId }),
			jobId,
			confirmations,
			reviewerBusDependencies(),
			{},
			{ executed, releaseAnswers: ["Request changes"], feedbacks: ["not this release"] },
		);
		await first.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), first.context);

		const state = await runDocument(directory, jobId, "state.json");
		assert.equal(state.status, "STOPPED", `${state.reason}\n${first.notifications.join("\n")}`);
		assert.equal(state.reason, "release denied by the operator (final: the graph completed)");
		assert.equal(state.graph_status, "completed");
		assert.equal(executed.includes("ship"), false);
		assert.equal(await git(directory, "rev-parse", "HEAD"), seedHead, "no commit");
		assert.deepEqual(
			(await terminalEvents(directory, jobId)).map((record) => record.status),
			["STOPPED"],
		);

		// Final: a resume runs nothing and says so again.
		const resumeExecuted: string[] = [];
		const second = commandHarness(
			directory,
			loopSessions(directory, resumeExecuted, { jobId }),
			jobId,
			confirmations,
		);
		await second.commands.get("kpi")!(jobId, second.context);
		const again = await runDocument(directory, jobId, "state.json");
		assert.equal(again.status, "STOPPED");
		assert.deepEqual(resumeExecuted, []);
		assert.deepEqual(confirmations, ["Approve gated release"], "the gate was not asked again");
	} finally {
		await cleanupFixture(directory);
	}
});
