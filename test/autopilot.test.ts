import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import { registerControlPlane } from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import type { GraphAgentSessionFactory } from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";

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
	if (prompt.includes("Check the frozen task")) return "ac-compiler";
	if (prompt.includes("spec-first skill")) return "specify";
	if (prompt.includes("implementation plan and stack.json")) return "plan";
	if (prompt.includes("tdd-cycle skill")) return "implement";
	if (prompt.includes("quality-gates skill")) return "test";
	if (prompt.includes("isolated-review skill")) return "review";
	if (prompt.includes("conventional-commit skill")) return "ship";
	return "retry";
}

function autoSessions(
	directory: string,
	executed: string[],
	behavior: {
		reviewResponse?: string;
		violateBounds?: boolean;
	} = {},
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
					if (currentNode === "implement") {
						await writeFile(join(directory, "src", "server.js"), implementedServer);
						if (behavior.violateBounds === true) {
							await writeFile(join(directory, "outside.txt"), "not allowed\n");
						}
					} else if (currentNode === "test") {
						lastAssistantText = JSON.stringify({
							head: await git(directory, "rev-parse", "HEAD"),
							commands: [{ cmd: "npm test", exit: 0 }],
							ac_results: ["AC-01", "AC-02", "AC-03", "AC-04", "AC-05"].map((id) => ({ id, passed: true })),
						});
					} else if (currentNode === "review") {
						lastAssistantText = behavior.reviewResponse ?? verdict;
					} else if (currentNode === "ship") {
						await git(directory, "add", "-A");
						await git(directory, "commit", "-m", "feat(health): add healthcheck endpoint");
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
): {
	command: CommandHandler;
	confirmations: string[];
	context: ExtensionCommandContext;
	notifications: string[];
} {
	const commands = new Map<string, CommandHandler>();
	const confirmations: string[] = [];
	const notifications: string[] = [];
	const pi = {
		on() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
	};
	registerControlPlane(pi as unknown as Parameters<typeof registerControlPlane>[0], {
		createAgentSession: factory,
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

test("narrative acceptance criteria refuse forced autopilot before graph load", async () => {
	const directory = await fixture("narrative-ac");
	const jobId = "20260831-narrative-refused";
	let sessions = 0;
	const harness = commandHarness(
		directory,
		async () => {
			sessions += 1;
			throw new Error("auto graph must not start");
		},
		jobId,
	);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		assert.equal(sessions, 0);
		const document = await state(directory, jobId);
		assert.equal(document.status, "NEEDS_HUMAN");
		assert.deepEqual(document.ac, { quality: "narrative" });
		const events = await readFile(join(directory, ".kpi", "runs", jobId, "events.jsonl"), "utf8");
		assert.match(events, /"type":"ac\.refused"/u);
		await assert.rejects(readdir(join(directory, ".kpi", "runs", jobId, "graph")), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("autopilot healthcheck reaches DONE with one commit and no human node", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-auto";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed), jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		assert.deepEqual(harness.confirmations, []);
		assert.equal(executed.includes("human"), false);
		assert.ok(executed.includes("ship"));
		const document = await state(directory, jobId);
		assert.equal(document.status, "DONE");
		assert.deepEqual(document.release, { approved: true });
		const taskDocument = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "task.json"), "utf8")) as {
			acceptance: Array<{ bounds?: unknown; check?: unknown }>;
		};
		assert.equal(taskDocument.acceptance.length, 5);
		assert.ok(
			taskDocument.acceptance.every((criterion) => criterion.check !== undefined && criterion.bounds !== undefined),
		);
		assert.equal(await git(directory, "rev-parse", "--abbrev-ref", "HEAD"), `kpi/${jobId}`);
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an autopilot write outside bounds stops UNSAFE without a commit", async () => {
	const directory = await fixture("bounds-violation");
	const jobId = "20260831-bounds-unsafe";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed, { violateBounds: true }), jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		const document = await state(directory, jobId);
		assert.equal(document.status, "UNSAFE");
		assert.match(String(document.reason), /outside\.txt/u);
		assert.equal(executed.includes("review"), false);
		assert.equal(executed.includes("ship"), false);
		assert.equal(await git(directory, "rev-parse", "HEAD"), initialHead);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an untestable reviewer issue stops autopilot at NEEDS_HUMAN", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-review-needs-human";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(
		directory,
		autoSessions(directory, executed, { reviewResponse: blockedVerdict }),
		jobId,
	);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);

		const document = await state(directory, jobId);
		assert.equal(document.status, "NEEDS_HUMAN");
		assert.match(String(document.reason), /untestable blocking issue/u);
		assert.equal(executed.includes("ship"), false);
		assert.equal(await git(directory, "rev-parse", "HEAD"), initialHead);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shipping twice for one job leaves one marker and one commit", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-replay";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed), jobId);
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
		const replay = commandHarness(directory, autoSessions(directory, resumeExecuted), jobId);
		await replay.command(`resume ${jobId}`, replay.context).catch(() => undefined);
		assert.equal(await git(directory, "rev-parse", "HEAD"), shipped, "no second commit");
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1");
		assert.equal(resumeExecuted.includes("ship"), false, "the ship node never ran again");
		const afterReplay = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterReplay, marker, "the marker records one decision, not two");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a replay whose checkpoint predates the commit still refuses a second one", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-crash";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	const harness = commandHarness(directory, autoSessions(directory, executed), jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context);
		const shipped = await git(directory, "rev-parse", "HEAD");

		// The window a crash can land in: the commit exists, the marker does not.
		const runDirectory = join(directory, ".kpi", "runs", jobId);
		await rm(join(runDirectory, "ship.json"));
		const document = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		document.status = "RUNNING";
		await writeFile(join(runDirectory, "state.json"), `${JSON.stringify(document, null, 2)}\n`);

		const resumeExecuted: string[] = [];
		const replay = commandHarness(directory, autoSessions(directory, resumeExecuted), jobId);
		await replay.command(`resume ${jobId}`, replay.context).catch(() => undefined);

		assert.equal(await git(directory, "rev-parse", "HEAD"), shipped, "HEAD is untouched");
		assert.equal(await git(directory, "rev-list", "--count", `${initialHead}..HEAD`), "1", "still one commit");
		assert.equal(resumeExecuted.includes("ship"), false, "the ship node never ran again");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("autopilot cannot release from model prose alone", async () => {
	const directory = await fixture("healthcheck-auto");
	const jobId = "20260831-healthcheck-prose";
	const initialHead = await git(directory, "rev-parse", "HEAD");
	const executed: string[] = [];
	// The reviewer approves in prose while the receipts say nothing passed. The
	// release decision is data, so no edge to `release.set` can fire.
	const factory: GraphAgentSessionFactory = async (sessionOptions) => {
		let currentNode = "";
		let lastAssistantText: string | undefined;
		return {
			session: {
				sessionId: "prose-session",
				async prompt(prompt) {
					const detected = nodeId(prompt);
					if (detected !== "retry") currentNode = detected;
					executed.push(currentNode || detected);
					if (currentNode === "implement") {
						await writeFile(join(directory, "src", "server.js"), implementedServer);
					} else if (currentNode === "test") {
						lastAssistantText = JSON.stringify({
							head: await git(directory, "rev-parse", "HEAD"),
							commands: [{ cmd: "npm test", exit: 1 }],
							ac_results: ["AC-01", "AC-02", "AC-03", "AC-04", "AC-05"].map((id) => ({ id, passed: false })),
						});
					} else if (currentNode === "review") {
						lastAssistantText = verdict;
					} else if (currentNode === "ship") {
						await git(directory, "add", "-A");
						await git(directory, "commit", "-m", "feat(health): should never happen");
					}
				},
				getLastAssistantText: () => lastAssistantText,
				getActiveToolNames: () => [...(sessionOptions.tools ?? [])],
				dispose() {},
			},
		};
	};
	const harness = commandHarness(directory, factory, jobId);
	try {
		const task = await readFile(join(directory, "task.txt"), "utf8");
		await harness.command(`--mode autopilot ${task}`, harness.context).catch(() => undefined);

		assert.equal(executed.includes("ship"), false, "prose cannot reach the ship node");
		assert.equal(await git(directory, "rev-parse", "HEAD"), initialHead, "no commit was created");
		const document = await state(directory, jobId);
		assert.notEqual(document.status, "DONE");
		assert.equal(document.release, undefined, "release was never approved");
		assert.deepEqual(harness.confirmations, [], "and autopilot never asked a human");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
