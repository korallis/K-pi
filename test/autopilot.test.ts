import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { registeredBuses } from "../packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts";
import type { BusDependencies } from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import { liveLoopSettled, registerControlPlane } from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import type { GraphAgentSessionFactory } from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphRunState } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import type { HostEvidence } from "../packages/coding-agent/src/kpi/extensions/graph/verification.ts";
import { isFinishedRunStatus, readTaskForJob } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import { stackTaskHash } from "../packages/coding-agent/src/kpi/extensions/stack.ts";
import { reviewerBusDependencies } from "./helpers/reviewer-bus.ts";

const execFile = promisify(execFileCallback);
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

/** Ladder decision the implementer records before product files change. */
const MINIMALIST_CANDIDATE = `{
  "ladder": "minimum-code",
  "used": "direct health handler in src/health/server.js",
  "skipped": "framework wrapper, utility module, and extra abstraction"
}`;

const verdict = JSON.stringify({
	status: "PASS",
	approved: true,
	blockingIssues: [],
	nonBlockingIssues: [],
	evidence: ["evidence.json"],
	round: 1,
	output_fingerprint: `sha256:${"a".repeat(64)}`,
});
const blockedVerdict = JSON.stringify({
	status: "BLOCKED",
	approved: false,
	blockingIssues: ["Required behavior cannot be verified locally"],
	nonBlockingIssues: [],
	evidence: ["evidence.json"],
	round: 1,
	output_fingerprint: `sha256:${"b".repeat(64)}`,
});

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

async function git(directory: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd: directory });
	return stdout.trim();
}

async function latestCheckpoint(directory: string, jobId: string): Promise<GraphRunState> {
	const graphDirectory = join(directory, ".kpi", "runs", jobId, "graph");
	const names = (await readdir(graphDirectory)).filter((name) => /^checkpoint-\d{6}\.json$/u.test(name)).sort();
	return JSON.parse(await readFile(join(graphDirectory, names.at(-1) as string), "utf8")) as GraphRunState;
}

async function cleanupFixture(root: string): Promise<void> {
	const runs = join(root, ".kpi", "runs");
	for (const bus of registeredBuses()) {
		if (bus.runDirectory.startsWith(`${runs}/`)) await bus.stopAll();
	}
	// Unlock only this fixture's sealed verification directories, after shutdown.
	for (const run of await readdir(runs, { withFileTypes: true }).catch(() => [])) {
		if (!run.isDirectory()) continue;
		const verification = join(runs, run.name, "verification");
		for (const entry of await readdir(verification, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory()) await chmod(join(verification, entry.name), 0o700);
		}
	}
	await rm(root, { recursive: true, force: true });
}

async function fixture(name: string): Promise<string> {
	const source = fileURLToPath(new URL(`../fixtures/${name}/`, import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), `k-pi-${name}-`));
	await rm(directory, { recursive: true, force: true });
	await cp(source, directory, { recursive: true });
	await git(directory, "init");
	await git(directory, "config", "user.email", "fixture@example.test");
	await git(directory, "config", "user.name", "Fixture");
	await git(directory, "add", "-A");
	await git(directory, "commit", "-m", "chore: seed fixture");
	return directory;
}

function nodeId(prompt: string): string {
	if (prompt.includes("intent-proposal.schema.json")) {
		return prompt.includes("frozen requirements/design/tasks") ? "plan-check" : "specify";
	}
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

function autoSessions(
	directory: string,
	executed: string[],
	behavior: {
		violateBounds?: boolean;
		jobId: string;
		ship?: (trailer: string) => Promise<void>;
		plan?: () => Promise<void>;
	},
): GraphAgentSessionFactory {
	let sessionNumber = 0;
	return async (sessionOptions) => {
		sessionNumber += 1;
		let currentNode = "";
		let lastAssistantText: string | undefined;
		return {
			session: {
				sessionId: `auto-session-${sessionNumber}`,
				async prompt(prompt) {
					const detected = nodeId(prompt);
					if (detected !== "retry") currentNode = detected;
					executed.push(currentNode || detected);
					lastAssistantText = undefined;
					if (currentNode === "specify" || currentNode === "plan-check") {
						const original = await readTaskForJob(directory, behavior.jobId);
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
						});
					} else if (currentNode === "plan") {
						await behavior.plan?.();
						const contract = await readTaskForJob(directory, behavior.jobId);
						lastAssistantText = JSON.stringify({
							...JSON.parse(healthStack),
							task_hash: stackTaskHash(contract),
						});
					} else if (currentNode === "implement") {
						await writeFile(
							join(directory, ".kpi", "runs", behavior.jobId, "candidate.json"),
							MINIMALIST_CANDIDATE,
						);
						await writeFile(join(directory, "src", "health", "server.js"), implementedServer);
						if (behavior.violateBounds === true) {
							await writeFile(join(directory, "outside.txt"), "not allowed\n");
						}
					} else if (currentNode === "review") {
						// Review is a bus worker; transcript is not the verdict.
						lastAssistantText = undefined;
					} else if (currentNode === "ship") {
						// The commit carries the trailer the prompt asked for: that is how
						// the control plane recognises this job's own commit.
						const trailer = /^KPI-Job: [^\s`]+$/mu.exec(prompt)?.[0] ?? "";
						if (behavior.ship !== undefined) {
							await behavior.ship(trailer);
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

function commandHarness(
	directory: string,
	factory: GraphAgentSessionFactory,
	jobId: string,
	busDependencies: BusDependencies = reviewerBusDependencies(),
): {
	command: CommandHandler;
	confirmations: string[];
	context: ExtensionCommandContext;
	notifications: string[];
} {
	const commands = new Map<string, CommandHandler>();
	const confirmations: string[] = [];
	const notifications: string[] = [];
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
	});
	const context = {
		cwd: directory,
		hasUI: true,
		mode: "tui",
		ui: {
			async confirm(title: string) {
				confirmations.push(title);
				return true;
			},
			notify(message: string) {
				notifications.push(message);
			},
			setWidget() {},
		},
	} as unknown as ExtensionCommandContext;
	return {
		command: commands.get("kpi")!,
		confirmations,
		context,
		notifications,
	};
}

async function state(directory: string, jobId: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as Record<
		string,
		unknown
	>;
}

test("narrative acceptance cannot authorize autopilot without executable checks", async () => {
	const directory = await fixture("narrative-ac");
	const jobId = "20260831-narrative-refused";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed, { jobId }), jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		const document = await state(directory, jobId);
		assert.equal(document.status, "NEEDS_HUMAN");
		assert.deepEqual(document.ac, { quality: "narrative" });
		assert.equal(document.recovery, "ac_quality");
		assert.equal(executed.includes("implement"), false, "narrative intent never authorizes a product write");
		assert.equal(executed.includes("ship"), false);
		assert.equal(await git(directory, "rev-parse", "HEAD"), initialHead);
		assert.deepEqual(harness.confirmations, []);
	} finally {
		await cleanupFixture(directory);
	}
});

test("autopilot healthcheck reaches DONE with one commit and no human node", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-auto";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(
		directory,
		autoSessions(directory, executed, { jobId }),
		jobId,
		reviewerBusDependencies({ executed }),
	);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		assert.deepEqual(harness.confirmations, []);
		assert.ok(executed.includes("ship"));
		const document = await state(directory, jobId);
		assert.equal(document.status, "DONE");
		assert.deepEqual(document.release, { approved: true });
		const evidence = JSON.parse(
			await readFile(join(directory, ".kpi", "runs", jobId, "evidence.json"), "utf8"),
		) as HostEvidence;
		assert.equal(evidence.passed, true, "host acceptance commands passed before release");
		assert.ok(evidence.commands.every((receipt) => receipt.exit === 0 && receipt.passed));
		assert.deepEqual(
			evidence.ac_results.filter((result) => result.passed).map((result) => result.id),
			["AC-01", "AC-02", "AC-03", "AC-04", "AC-05"],
		);
		assert.ok(
			evidence.commands.some((receipt) => receipt.stdout.excerpt.includes("GET /health reports service health")),
			"the host command actually ran the HTTP acceptance test",
		);
		assert.ok(executed.includes("review"), "a receipt-backed reviewer ran before shipping");
		assert.equal(await git(directory, "rev-parse", "--abbrev-ref", "HEAD"), `kpi/${jobId}`);
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
	} finally {
		await cleanupFixture(directory);
	}
});

test("an autopilot write outside bounds pauses NEEDS_HUMAN without a commit", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-bounds-unsafe";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(
		directory,
		autoSessions(directory, executed, { violateBounds: true, jobId }),
		jobId,
		reviewerBusDependencies({ executed }),
	);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		const document = await state(directory, jobId);
		assert.equal(document.status, "NEEDS_HUMAN");
		assert.equal(document.recovery, "bounds");
		assert.match(String(document.reason), /write outside write_allow: .*outside\.txt/u);
		assert.ok(String(document.reason).includes(`resume with /kpi ${jobId}`), String(document.reason));
		assert.equal(isFinishedRunStatus(document.status), true);
		const checkpoint = await latestCheckpoint(directory, jobId);
		assert.equal(checkpoint.status, "paused");
		assert.deepEqual(checkpoint.pause?.resume, ["test"]);
		const terminals = (await readFile(join(directory, ".kpi", "runs", jobId, "events.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type: string; status?: string; recovery?: string })
			.filter((record) => record.type === "loop.terminal");
		assert.deepEqual(
			terminals.map((record) => [record.status, record.recovery]),
			[["NEEDS_HUMAN", "bounds"]],
		);
		assert.equal(executed.includes("review"), false);
		assert.equal(executed.includes("ship"), false);
		assert.equal(await git(directory, "rev-parse", "HEAD"), initialHead);
	} finally {
		await cleanupFixture(directory);
	}
});

test("an untestable reviewer issue returns to planning and can recover without a routine human gate", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-review-needs-human";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(
		directory,
		autoSessions(directory, executed, { jobId }),
		jobId,
		reviewerBusDependencies({ verdicts: [JSON.parse(blockedVerdict), JSON.parse(verdict)] }),
	);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		const document = await state(directory, jobId);
		assert.equal(document.status, "DONE", String(document.reason));
		assert.ok(executed.filter((node) => node === "plan").length >= 2, "blocked review returns to planning");
		assert.deepEqual(harness.confirmations, []);
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
	} finally {
		await cleanupFixture(directory);
	}
});

test("shipping twice for one job leaves one marker and one commit", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-replay";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed, { jobId }), jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);
		assert.equal((await state(directory, jobId)).status, "DONE");
		const shipped = await git(directory, "rev-parse", "HEAD");
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");

		const markerPath = join(directory, ".kpi", "runs", jobId, "ship.json");
		const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
		assert.equal(marker.job_id, jobId);
		assert.equal(marker.head, shipped);
		assert.match(String(marker.subject), /^feat\(health\)/u);

		// A crash after the commit loses the checkpoint's knowledge of it, but not
		// the marker. Replaying the run must be a no-op: the graph routes past ship.
		const resumeExecuted: string[] = [];
		const replay = commandHarness(directory, autoSessions(directory, resumeExecuted, { jobId }), jobId);
		await replay.command(jobId, replay.context);
		assert.deepEqual(
			replay.notifications.filter((message) => message.includes("failed")),
			[],
			"the replay itself must not fail",
		);
		assert.equal(await git(directory, "rev-parse", "HEAD"), shipped, "no second commit");
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
		assert.equal(resumeExecuted.includes("ship"), false, "the ship node never ran again");
		const afterReplay = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterReplay, marker, "the marker records one decision, not two");
	} finally {
		await cleanupFixture(directory);
	}
});

test("a replay whose checkpoint predates the commit still refuses a second one", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-crash";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	let beforeShip: GraphRunState | undefined;
	const harness = commandHarness(
		directory,
		autoSessions(directory, executed, {
			jobId,
			ship: async (trailer) => {
				beforeShip = await latestCheckpoint(directory, jobId);
				await git(directory, "add", "-A");
				await git(directory, "commit", "-m", `feat(health): add healthcheck endpoint\n\n${trailer}`);
			},
		}),
		jobId,
	);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);
		const shipped = await git(directory, "rev-parse", "HEAD");
		assert.equal((await state(directory, jobId)).status, "DONE");
		assert.ok(beforeShip, "the crash snapshot was captured before the commit");

		// The window a crash can land in: the commit exists, the marker does not.
		const runDirectory = join(directory, ".kpi", "runs", jobId);
		await rm(join(runDirectory, "ship.json"));
		const graphDirectory = join(runDirectory, "graph");
		for (const name of await readdir(graphDirectory)) {
			const checkpoint = /^checkpoint-(\d{6})\.json$/u.exec(name);
			if (checkpoint !== null && Number(checkpoint[1]) > beforeShip.superstep) {
				await rm(join(graphDirectory, name));
			}
		}
		await writeFile(
			join(graphDirectory, `checkpoint-${String(beforeShip.superstep).padStart(6, "0")}.json`),
			`${JSON.stringify(beforeShip, null, 2)}\n`,
		);
		const document = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		document.status = "RUNNING";
		await writeFile(join(runDirectory, "state.json"), `${JSON.stringify(document, null, 2)}\n`);

		const resumeExecuted: string[] = [];
		const replay = commandHarness(directory, autoSessions(directory, resumeExecuted, { jobId }), jobId);
		await replay.command(jobId, replay.context);
		assert.deepEqual(
			replay.notifications.filter((message) => message.includes("failed")),
			[],
			"the replay itself must not fail",
		);

		assert.equal(await git(directory, "rev-parse", "HEAD"), shipped, "HEAD is untouched");
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1", "still one commit");
		assert.equal(resumeExecuted.includes("ship"), false, "the ship node never ran again");
		assert.equal((await state(directory, jobId)).status, "DONE", "recovery completed the interrupted decision");
	} finally {
		await cleanupFixture(directory);
	}
});

test("autopilot cannot release from model prose alone", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-prose";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	// Host checks pass, but an approving reviewer transcript is not a verdict.
	const factory = autoSessions(directory, executed, {
		jobId,
		plan: async () => {
			if (executed.includes("review")) {
				await writeFile(
					join(directory, ".kpi", "runs", jobId, "stop.json"),
					JSON.stringify({
						reason: "operator stop after observing review repair",
						at: new Date().toISOString(),
						recorded: false,
					}),
				);
			}
		},
	});
	const harness = commandHarness(
		directory,
		factory,
		jobId,
		reviewerBusDependencies({ verdict: null, transcript: verdict, executed }),
	);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		assert.ok(executed.includes("review"), "the run reached the reviewer with real host evidence");
		assert.equal(executed.includes("ship"), false, "prose cannot reach the ship node");
		assert.equal(await git(directory, "rev-parse", "HEAD"), initialHead, "no commit was created");
		const document = await state(directory, jobId);
		assert.equal(document.status, "STOPPED");
		await assert.rejects(readFile(join(directory, ".kpi", "runs", jobId, "verdict.json"), "utf8"), {
			code: "ENOENT",
		});
		assert.equal(document.release, undefined, "release was never approved");
		assert.deepEqual(harness.confirmations, [], "and autopilot never asked a human");
	} finally {
		await cleanupFixture(directory);
	}
});

/** The job-marked commit for a run, as the control plane identifies it. */
async function markedCommits(directory: string, jobId: string): Promise<string[]> {
	const log = await git(directory, "log", "--format=%H%x1f%B%x1e");
	return log
		.split("\u001e")
		.map((record) => record.replace(/^\n/u, ""))
		.filter((record) => record.length > 0)
		.flatMap((record) => {
			const [head, body] = record.split("\u001f");
			return (body ?? "").split(/\r?\n/u).some((line) => line.trimEnd() === `KPI-Job: ${jobId}`) ? [head] : [];
		});
}

test("an unrelated conventional commit never counts as this job shipping", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-unrelated";
	const executed: string[] = [];
	// An external actor commits the candidate with a conventional subject but no
	// job trailer. It cannot satisfy the ship node's exactly-once decision.
	const factory = autoSessions(directory, executed, {
		jobId,
		ship: async () => {
			await git(directory, "add", "-A");
			await git(directory, "commit", "-m", "chore(deps): unrelated housekeeping");
		},
	});
	const harness = commandHarness(directory, factory, jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context).catch(() => undefined);

		assert.ok(executed.includes("ship"), "the unrelated commit did not let the job skip shipping");
		const document = await state(directory, jobId);
		assert.notEqual(document.status, "DONE", "an unrelated commit is not this job's decision");
		assert.equal(document.status, "NEEDS_HUMAN");
		assert.equal(document.recovery, "ship");
		assert.match(String(document.reason), /KPI-Job: 20260831-healthcheck-unrelated/u);
		await assert.rejects(readFile(join(directory, ".kpi", "runs", jobId, "ship.json"), "utf8"), { code: "ENOENT" });
		assert.deepEqual(await markedCommits(directory, jobId), [], "no commit claims this job");
	} finally {
		await cleanupFixture(directory);
	}
});

test("a crash after the marked commit recovers exactly once, even behind later commits", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-recover";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed, { jobId }), jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);
		const [shipCommit] = await markedCommits(directory, jobId);
		assert.ok(shipCommit !== undefined, "the run made a job-marked commit");

		// The crash window: the commit exists, the marker does not, and the state
		// document still says the run was going.
		const runDirectory = join(directory, ".kpi", "runs", jobId);
		await rm(join(runDirectory, "ship.json"));
		const document = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		document.status = "RUNNING";
		await writeFile(join(runDirectory, "state.json"), `${JSON.stringify(document, null, 2)}\n`);

		// A later commit is not this job's decision; accepted candidate bytes stay unchanged.
		await git(directory, "commit", "--allow-empty", "-m", "docs(notes): unrelated follow-up");
		const headBeforeReplay = await git(directory, "rev-parse", "HEAD");

		const resumeExecuted: string[] = [];
		const replay = commandHarness(directory, autoSessions(directory, resumeExecuted, { jobId }), jobId);
		await replay.command(jobId, replay.context);
		assert.deepEqual(
			replay.notifications.filter((message) => message.includes("failed")),
			[],
			"the replay itself must not fail",
		);

		assert.equal(resumeExecuted.includes("ship"), false, "the ship node never ran again");
		assert.equal(await git(directory, "rev-parse", "HEAD"), headBeforeReplay, "no new commit was created");
		assert.deepEqual(await markedCommits(directory, jobId), [shipCommit], "still exactly one marked commit");
		const marker = JSON.parse(await readFile(join(runDirectory, "ship.json"), "utf8")) as Record<string, unknown>;
		assert.equal(marker.head, shipCommit, "the marker names the job's own commit, not HEAD");
		assert.equal(marker.job_id, jobId);
		assert.equal((await state(directory, jobId)).status, "DONE");
		assert.equal(
			await git(directory, "rev-list", "--count", `${initialHead}..HEAD`),
			"2",
			"one ship commit plus the unrelated follow-up",
		);
	} finally {
		await cleanupFixture(directory);
	}
});

test("two commits claiming one job fail closed", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-duplicate";
	const executed: string[] = [];
	// A confused ship node makes its commit twice, both carrying the trailer.
	const factory = autoSessions(directory, executed, {
		jobId,
		ship: async (trailer) => {
			await git(directory, "add", "-A");
			await git(directory, "commit", "-m", `feat(health): first attempt\n\n${trailer}`);
			await git(directory, "commit", "--allow-empty", "-m", `feat(health): second attempt\n\n${trailer}`);
		},
	});
	const harness = commandHarness(directory, factory, jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context).catch(() => undefined);

		const document = await state(directory, jobId);
		assert.notEqual(document.status, "DONE", "an ambiguous decision is never accepted");
		assert.equal(document.status, "NEEDS_HUMAN");
		assert.equal(document.recovery, "ship");
		assert.match(String(document.reason), /2 commits instead of one|Ambiguous ship commits/u);
		assert.equal((await markedCommits(directory, jobId)).length, 2, "both real commits claimed the job");
		await assert.rejects(readFile(join(directory, ".kpi", "runs", jobId, "ship.json"), "utf8"), { code: "ENOENT" });
	} finally {
		await cleanupFixture(directory);
	}
});

test("a forged or mismatched ship marker is ignored and never skips shipping", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-forged";
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed, { jobId }), jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);
		const runDirectory = join(directory, ".kpi", "runs", jobId);
		const markerPath = join(runDirectory, "ship.json");
		const genuine = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
		const shipped = await git(directory, "rev-parse", "HEAD");

		const forgeries: { name: string; marker: unknown }[] = [
			{ name: "another job's id", marker: { ...genuine, job_id: "20260831-someone-else" } },
			{ name: "a head that is not a commit", marker: { ...genuine, head: "f".repeat(40) } },
			{ name: "a subject the commit does not have", marker: { ...genuine, subject: "feat(x): invented" } },
			{ name: "a short head", marker: { ...genuine, head: "abc123" } },
			{ name: "a missing timestamp", marker: { job_id: jobId, head: shipped, subject: genuine.subject } },
			{ name: "an unparseable timestamp", marker: { ...genuine, at: "not-a-date" } },
			{ name: "extra smuggled fields", marker: { ...genuine, approved: true } },
			{ name: "not an object at all", marker: "shipped" },
		];

		for (const forgery of forgeries) {
			await writeFile(markerPath, `${JSON.stringify(forgery.marker, null, 2)}\n`);
			// A forged marker must not be accepted as the decision. The job's real
			// commit is still there, so recovery finalizes from git and overwrites
			// the forgery with the truth.
			const replayExecuted: string[] = [];
			const replay = commandHarness(directory, autoSessions(directory, replayExecuted, { jobId }), jobId);
			const document = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<
				string,
				unknown
			>;
			document.status = "RUNNING";
			await writeFile(join(runDirectory, "state.json"), `${JSON.stringify(document, null, 2)}\n`);
			await replay.command(jobId, replay.context);
			assert.deepEqual(
				replay.notifications.filter((message) => message.includes("failed")),
				[],
				"the replay itself must not fail",
			);

			assert.equal(replayExecuted.includes("ship"), false, `${forgery.name}: no second commit attempt`);
			assert.equal(await git(directory, "rev-parse", "HEAD"), shipped, `${forgery.name}: HEAD is untouched`);
			const rewritten = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
			assert.equal(rewritten.job_id, jobId, `${forgery.name}: the marker was rewritten from git`);
			assert.equal(rewritten.head, shipped, `${forgery.name}: the marker names the real commit`);
			assert.equal(rewritten.subject, genuine.subject, `${forgery.name}: with the real subject`);
		}
	} finally {
		await cleanupFixture(directory);
	}
});

test("a transport failure after the approved commit never repeats the commit action", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260905-commit-transport-retry";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	let commitAttempts = 0;
	const harness = commandHarness(
		directory,
		autoSessions(directory, [], {
			jobId,
			ship: async (trailer) => {
				commitAttempts += 1;
				await git(directory, "add", "-A");
				await git(directory, "commit", "--allow-empty", "-m", `feat(health): verified endpoint\n\n${trailer}`);
				if (commitAttempts === 1)
					throw Object.assign(new Error("provider disconnected after git commit"), { status: 503 });
			},
		}),
		jobId,
	);
	try {
		await harness.command(`--mode autopilot ${await readFile(join(directory, "task.txt"), "utf8")}`, harness.context);
		assert.equal((await state(directory, jobId)).status, "DONE");
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
	} finally {
		await cleanupFixture(directory);
	}
});
