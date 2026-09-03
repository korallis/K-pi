import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionCommandContext, ExtensionContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import { appendEvent, verifyChain } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import {
	registerLiveNodeSession,
	resetSessionsRegistry,
} from "../packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts";
import {
	type ControlPlaneDependencies,
	createStatusWidget,
	liveLoopSettled,
	registerControlPlane,
} from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import type { GraphAgentSessionFactory } from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import { readLiveJob } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import { routingState } from "../packages/coding-agent/src/kpi/extensions/settings.ts";

const execFile = promisify(execFileCallback);
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;
type SessionStartHandler = (event: unknown, context: ExtensionContext) => Promise<void>;

async function withFixture(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-control-plane-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function registerFixture(dependencies: ControlPlaneDependencies = {}, options: { detached?: boolean } = {}) {
	const commands = new Map<string, CommandHandler>();
	let sessionStart: SessionStartHandler | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_start") {
				sessionStart = handler as SessionStartHandler;
			}
		},
		// The loop is detached from its handler; unless a test drives that
		// itself, the harness settles it so assertions read the finished run.
		registerCommand(name: string, options_: { handler: CommandHandler }) {
			commands.set(
				name,
				options.detached === true
					? options_.handler
					: async (args, ctx) => {
							await options_.handler(args, ctx);
							await liveLoopSettled();
						},
			);
		},
		sendUserMessage() {
			throw new Error("provider request attempted");
		},
		setModel() {
			throw new Error("model mutation attempted");
		},
	};
	registerControlPlane(pi as unknown as Parameters<typeof registerControlPlane>[0], dependencies);
	return { commands, getSessionStart: () => sessionStart };
}

type WidgetComponent = { render(width: number): string[]; dispose?(): void };
type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;
type CustomFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (value: unknown) => void,
) => WidgetComponent | Promise<WidgetComponent>;

const plainTheme = { fg: (_tone: string, text: string) => text };

function context(
	cwd: string,
	notifications: string[],
	widgets: Array<string[] | undefined>,
	options: {
		hasUI?: boolean;
		mode?: string;
		components?: Array<WidgetComponent | undefined>;
		custom?: (factory: CustomFactory, opts?: unknown) => Promise<unknown>;
		theme?: { fg(tone: string, text: string): string };
	} = {},
): ExtensionCommandContext {
	let installed: WidgetComponent | undefined;
	return {
		cwd,
		hasUI: options.hasUI ?? false,
		mode: options.mode ?? "json",
		newSession: async () => {
			throw new Error("agent start attempted");
		},
		ui: {
			custom:
				options.custom ??
				(async () => {
					throw new Error("unexpected overlay");
				}),
			notify(message: string) {
				notifications.push(message);
			},
			// The board is a component; render it the way the interactive mode
			// would, disposing whatever the key held before (setExtensionWidget).
			setWidget(_key: string, content: string[] | WidgetFactory | undefined) {
				installed?.dispose?.();
				installed = undefined;
				if (typeof content === "function") {
					installed = content({ requestRender() {} }, options.theme ?? plainTheme);
					options.components?.push(installed);
					widgets.push(installed.render(120));
				} else {
					options.components?.push(undefined);
					widgets.push(content);
				}
			},
		},
	} as unknown as ExtensionCommandContext;
}

/** Test/DI ticker: the caller fires the latest registered callback on demand; each stop counts once. */
function manualTicker(): { tick: NonNullable<ControlPlaneDependencies["tick"]>; fire: () => void; stopCount: number } {
	let callback: (() => void) | undefined;
	const state = {
		tick: (cb: () => void, _intervalMs: number) => {
			callback = cb;
			let stopped = false;
			return () => {
				if (stopped) return;
				stopped = true;
				if (callback === cb) callback = undefined;
				state.stopCount += 1;
			};
		},
		fire: () => callback?.(),
		stopCount: 0,
	};
	return state;
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const RUNNING_STATE = {
	job_id: "2026-08-31-status",
	mode: "gated",
	round: 2,
	superstep: 3,
	stage: "implement",
	node: "implementer",
	passed: false,
	status: "RUNNING",
} as const;

async function createRun(directory: string): Promise<string> {
	const runDirectory = join(directory, ".kpi", "runs", "2026-08-31-status");
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "state.json"), `${JSON.stringify(RUNNING_STATE)}\n`);
	await writeFile(join(runDirectory, "events.jsonl"), "");
	return runDirectory;
}

test("kpi status reports no active job without requesting a provider", async () => {
	await withFixture(async (directory) => {
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const { commands } = registerFixture();

		await commands.get("kpi")!("status", context(directory, notifications, widgets));

		assert.deepEqual(notifications, ["no active job"]);
		assert.deepEqual(widgets, [undefined]);
	});
});

test("kpi stop appends a terminal STOPPED event", async () => {
	await withFixture(async (directory) => {
		const runDirectory = await createRun(directory);
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const { commands } = registerFixture();

		await commands.get("kpi")!("stop", context(directory, notifications, widgets));

		const marker = JSON.parse(await readFile(join(runDirectory, "stop.json"), "utf8")) as Record<string, unknown>;
		assert.equal(marker.reason, "operator stop");
		assert.equal(marker.recorded, true, "no loop was live in this process: the control plane recorded the stop");
		assert.match(String(marker.at), /^\d{4}-\d{2}-\d{2}T/u);
		const lines = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trimEnd().split("\n");
		const event = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
		const state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		assert.equal(event.type, "loop.terminal");
		assert.equal(event.status, "STOPPED");
		assert.equal(event.reason, "operator stop");
		assert.equal(state.status, "STOPPED");
		assert.equal(await verifyChain(join(runDirectory, "events.jsonl")), true);
		assert.deepEqual(notifications, ["K-π job 2026-08-31-status STOPPED (resume with /kpi 2026-08-31-status)"]);
		assert.equal(await readLiveJob(directory), undefined, "a STOPPED job is finished, not live");
	});
});

test("job overlay includes the K-π brand and stages 01 through 08", async () => {
	await withFixture(async (directory) => {
		await createRun(directory);
		const overlay = (await createStatusWidget(directory)).join("\n");

		assert.match(overlay, /K-π/);
		for (const stage of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
			assert.match(overlay, new RegExp(`\\b${stage}\\b`));
		}
		assert.match(overlay, /04 implement CURRENT/);
		assert.equal((overlay.match(/CURRENT/g) ?? []).length, 1);
		assert.match(overlay, /STOP RUNNING/);
	});
});

test("session widget reads files without changing models or starting agents", async () => {
	await withFixture(async (directory) => {
		await createRun(directory);
		const widgets: Array<string[] | undefined> = [];
		const { getSessionStart } = registerFixture();
		const handler = getSessionStart();
		assert.ok(handler);

		await handler({}, context(directory, [], widgets));

		assert.equal(widgets.length, 1);
		assert.match(widgets[0]!.join("\n"), /K-π/);
	});
});

test("loop is an alias of the kpi command", () => {
	const { commands } = registerFixture({}, { detached: true });
	assert.equal(commands.get("loop"), commands.get("kpi"));
});

// ---------------------------------------------------------------------------
// B1: the shipped verification path
// ---------------------------------------------------------------------------

test("kpi verify checks a job's event chain from the harness itself", async () => {
	await withFixture(async (directory) => {
		const runDirectory = await createRun(directory);
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const { commands } = registerFixture();
		const kpi = commands.get("kpi")!;

		// A real run's log, appended through the product's own writer.
		await kpi("stop", context(directory, notifications, widgets));
		notifications.length = 0;

		await kpi("verify", context(directory, notifications, widgets));
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /events\.jsonl verified: [1-9]\d* records chained/u);

		// One byte of a record changed: the operator is told which line failed.
		const eventsPath = join(runDirectory, "events.jsonl");
		const lines = (await readFile(eventsPath, "utf8")).trimEnd().split("\n");
		lines[0] = lines[0].replace('"operator stop"', '"operator  stop"');
		await writeFile(eventsPath, `${lines.join("\n")}\n`);
		notifications.length = 0;
		await kpi("verify", context(directory, notifications, widgets));
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /events\.jsonl FAILED verification at line 1/u);
		assert.match(notifications[0], /record_hash does not match/u);
	});
});

test("kpi verify accepts a job id and refuses to eat a goal", async () => {
	await withFixture(async (directory) => {
		const runDirectory = await createRun(directory);
		const jobId = runDirectory.split("/").at(-1)!;
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const { commands } = registerFixture();

		await commands.get("kpi")!(`verify ${jobId}`, context(directory, notifications, widgets));
		assert.match(notifications.at(-1) ?? "", /verified|FAILED verification/u);

		// A goal that happens to start with the word is still a goal: the loop is
		// what must run, not the verifier.
		notifications.length = 0;
		await commands.get("kpi")!("verify the healthcheck endpoint works", context(directory, notifications, widgets));
		assert.doesNotMatch(
			notifications.join("\n"),
			/records chained|FAILED verification/u,
			"a multi-word goal was not swallowed by the verify subcommand",
		);
	});
});

test("a long or multi-line goal is never probed as a job id", async () => {
	await withFixture(async (directory) => {
		const { commands } = registerFixture();
		const notifications: string[] = [];
		const goal = `${"the ui of this terminal looks nothing like the reference images ".repeat(6)}\nplease fix it`;
		await commands.get("kpi")?.(goal, context(directory, notifications, []));

		assert.ok(
			notifications.every((message) => !/ENAMETOOLONG|ENOTDIR/u.test(message)),
			`the goal was treated as text, not a path: ${notifications.join(" | ")}`,
		);
		// The loop got as far as creating a run for the goal before the fixture's
		// session factory refused to start an agent.
		const runs = await readdir(join(directory, ".kpi", "runs"));
		assert.equal(runs.length, 1, "exactly one run directory for the goal");
		const task = JSON.parse(await readFile(join(directory, ".kpi", "runs", runs[0] ?? "", "task.json"), "utf8")) as {
			goal: string;
			quality_gates: string[];
		};
		assert.equal(task.goal, goal, "the goal is kept verbatim on the contract");
		assert.deepEqual(task.quality_gates, [], "no package manager or AGENTS.md block means no guessed gates");
		assert.ok(
			notifications.some((message) => /quality gates/u.test(message)),
			"missing gates are reported to the operator",
		);
	});
});

test("kpi auto, always and off set the session routing override", async () => {
	await withFixture(async (directory) => {
		const { commands } = registerFixture();
		const notifications: string[] = [];
		try {
			for (const mode of ["off", "always", "auto"] as const) {
				await commands.get("kpi")?.(mode, context(directory, notifications, []));
				assert.equal(routingState.override, mode);
			}
			assert.deepEqual(
				notifications.map((message) => message.split(":")[0]),
				["K-π routing off", "K-π routing always", "K-π routing auto"],
			);
			assert.deepEqual(await readdir(join(directory)), [], "a routing switch starts no job");
		} finally {
			delete routingState.override;
		}
	});
});

test("a finished job is not pinned above the editor", async () => {
	await withFixture(async (directory) => {
		const runDirectory = await createRun(directory);
		await writeFile(
			join(runDirectory, "state.json"),
			`${JSON.stringify({ job_id: "2026-08-31-status", mode: "gated", stage: "plan", status: "STOPPED" })}\n`,
		);
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const { commands, getSessionStart } = registerFixture();

		await getSessionStart()?.({}, context(directory, notifications, widgets));
		assert.deepEqual(widgets, [undefined], "a dead run draws no widget");

		await commands.get("kpi")?.("status", context(directory, notifications, widgets));
		assert.deepEqual(notifications, ["no active job — last job 2026-08-31-status STOPPED"]);
	});
});

test("the session widget is a framed component painted at the live width", async () => {
	await withFixture(async (directory) => {
		await createRun(directory);
		const widgets: Array<string[] | undefined> = [];
		const { getSessionStart } = registerFixture();
		await getSessionStart()?.({}, context(directory, [], widgets));
		const lines = widgets[0] ?? [];
		assert.ok(
			lines.some((line) => line.startsWith("┌")),
			"the widget is framed",
		);
		assert.ok(
			lines.every((line) => line.length === 120),
			"every line is painted to the widget width",
		);
		const text = lines.join("\n");
		assert.match(text, /K-π GRAPH CONTROL/);
		assert.match(text, /04 implement/);
		assert.match(text, /STOP RUNNING/);
		assert.match(text, /FILES {2}○ task\.json/, "an empty run file is a dark lamp");
	});
});

/** Appends one chained record to the run's log through the product's own writer. */
async function appendEventAt(runDirectory: string, nowMs: number, event: Record<string, unknown>): Promise<void> {
	await appendEvent(join(runDirectory, "events.jsonl"), {
		ts: new Date(nowMs).toISOString(),
		job_id: "2026-08-31-status",
		round: 2,
		node: "implement",
		...event,
	} as Parameters<typeof appendEvent>[1]);
}

test("the session widget refreshes on the injected tick, narrates lifecycle once and drops itself when the job ends", async () => {
	await withFixture(async (directory) => {
		const runDirectory = await createRun(directory);
		let nowMs = Date.parse("2026-08-31T10:00:00.000Z");
		await appendEventAt(runDirectory, nowMs, { type: "handoff.created", node: "control-plane", mode: "gated" });
		const ticker = manualTicker();
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const components: Array<WidgetComponent | undefined> = [];
		const { commands, getSessionStart } = registerFixture({ tick: ticker.tick, now: () => nowMs });
		const ctx = context(directory, notifications, widgets, { components });
		const latest = () => components.at(-1)?.render(120).join("\n") ?? "";

		await getSessionStart()?.({}, ctx);
		assert.match(latest(), /NOW implementer {2}no node\.started yet/u, "no lifecycle record yet");
		assert.equal(notifications.length, 0, "history is never narrated");

		// A node starts and works; the widget only learns of it on the tick.
		await appendEventAt(runDirectory, nowMs, { type: "node.started", run: 1 });
		await appendEventAt(runDirectory, nowMs, { type: "tool.request", tool: "read", path: "a", decision: "allow" });
		await appendEventAt(runDirectory, nowMs, { type: "tool.request", tool: "edit", path: "b.ts", decision: "allow" });
		nowMs += 65_000;
		assert.doesNotMatch(latest(), /2 tools/u, "nothing repaints without a tick");
		ticker.fire();
		await waitUntil(() => notifications.length === 1);
		assert.deepEqual(notifications, ["K-π ▶ 04 implement · run 1"]);
		const painted = latest();
		assert.match(painted, /NOW implementer/u);
		assert.match(painted, /2 tools/u);
		assert.match(painted, /▸ edit b\.ts/u);
		assert.match(painted, /1m05s/u);
		assert.equal(widgets.length, 1, "a refresh repaints in place; it never reinstalls the widget");

		// The clock moves one second: the tick that repaints 1m06s has settled.
		nowMs += 1_000;
		ticker.fire();
		await waitUntil(() => latest().includes("1m06s"));
		assert.equal(notifications.length, 1, "a tick with nothing new narrates nothing");

		await appendEventAt(runDirectory, nowMs, { type: "accounts.failover", node: "graph", from: "a", to: "b" });
		await appendEventAt(runDirectory, nowMs, {
			type: "node.finished",
			run: 1,
			status: "completed",
			elapsed_ms: 65_000,
			cost_usd: 0.42,
		});
		ticker.fire();
		await waitUntil(() => notifications.length === 3);
		assert.deepEqual(notifications.slice(1), ["K-π ⇄ route a → b", "K-π ■ 04 implement done · 1m05s · $0.42"]);

		// A reinstall (onStateChange, `/kpi status`) continues from the module cursor.
		await getSessionStart()?.({}, ctx);
		assert.equal(ticker.stopCount, 1, "the previous widget's ticker stopped when it was disposed");
		await writeFile(join(runDirectory, "state.json"), `${JSON.stringify({ ...RUNNING_STATE, round: 3 })}\n`);
		ticker.fire();
		await waitUntil(() => /ROUND 3(?![\d/])/u.test(latest()));
		assert.equal(notifications.length, 3, "history is not narrated twice");

		// `/kpi status` shows the board and leaves the widget ticking behind it.
		await commands.get("kpi")?.("status", ctx);
		assert.equal(notifications.length, 4, "the status board is one notification");
		assert.match(notifications[3] ?? "", /NOW implementer/u);
		assert.doesNotMatch(notifications[3] ?? "", /↵ detail/u, "the printed board carries no overlay key hint");
		assert.equal(ticker.stopCount, 2, "status reinstalled the widget: the old ticker stopped, a new one runs");
		await writeFile(join(runDirectory, "state.json"), `${JSON.stringify({ ...RUNNING_STATE, round: 1 })}\n`);
		ticker.fire();
		await waitUntil(() => /ROUND 1(?![\d/])/u.test(latest()));
		assert.equal(notifications.length, 4, "status narrated nothing twice");

		// A read failure is painted, not thrown: the log becomes a directory.
		await rm(join(runDirectory, "events.jsonl"));
		await mkdir(join(runDirectory, "events.jsonl"));
		ticker.fire();
		await waitUntil(() => latest().includes("EVENTS ✕ EISDIR"));
		assert.ok(!notifications.some((line) => line.includes("board refresh failed")), notifications.join("\n"));

		// The job ends: the next tick drops the widget and stops its ticker.
		await writeFile(
			join(runDirectory, "state.json"),
			`${JSON.stringify({ job_id: "2026-08-31-status", mode: "gated", stage: "ship", status: "DONE" })}\n`,
		);
		ticker.fire();
		await waitUntil(() => widgets.at(-1) === undefined);
		assert.equal(ticker.stopCount, 3, "the ticker stopped with the job");
		assert.equal(components.at(-1), undefined, "setWidget('kpi', undefined) cleared the board");
	});
});

test("the session widget counts an in-process node session without starting one", async () => {
	await withFixture(async (directory) => {
		await createRun(directory);
		resetSessionsRegistry();
		registerLiveNodeSession({
			kind: "node",
			jobId: "2026-08-31-status",
			nodeId: "implement",
			sessionId: "01a0test",
			contextMode: "isolated",
			threadKey: "implement",
			startedAt: new Date().toISOString(),
			stats: () => ({ cost: 0, toolCalls: 0 }),
		});
		try {
			const ticker = manualTicker();
			const widgets: Array<string[] | undefined> = [];
			const { getSessionStart } = registerFixture({ tick: ticker.tick });
			await getSessionStart()?.({}, context(directory, [], widgets));
			assert.match(widgets[0]?.join("\n") ?? "", /AGENTS 1 · 1 node · 0 workers/u);
		} finally {
			resetSessionsRegistry();
		}
	});
});

test("a running job leaves /kpi status, /agents and chat free and refuses a second goal", async () => {
	await withFixture(async (directory) => {
		const jobId = "20260903-detached-goal";
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const reached = Promise.withResolvers<void>();
		let settled = false;
		let rejectPrompt: ((error: Error) => void) | undefined;
		// A node session that hangs until the operator's stop aborts it.
		const factory: GraphAgentSessionFactory = async (options) => ({
			session: {
				sessionId: "hanging",
				prompt: () =>
					new Promise<void>((_resolve, reject) => {
						rejectPrompt = reject;
						reached.resolve();
					}).finally(() => {
						settled = true;
					}),
				abort() {
					rejectPrompt?.(Object.assign(new Error("prompt aborted"), { name: "AbortError" }));
				},
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		});
		// The loop snapshots the worktree, so the fixture is a repository.
		await execFile("git", ["init"], { cwd: directory });
		await execFile("git", ["config", "user.email", "fixture@example.test"], { cwd: directory });
		await execFile("git", ["config", "user.name", "Fixture"], { cwd: directory });
		await execFile("git", ["commit", "--allow-empty", "-m", "chore: seed"], { cwd: directory });
		const { commands } = registerFixture({ createAgentSession: factory, jobId }, { detached: true });
		const kpi = commands.get("kpi")!;
		const ctx = context(directory, notifications, widgets);

		// The handler returns while the node is still inside its prompt.
		await kpi("add a healthcheck endpoint", ctx);
		await reached.promise;
		assert.equal(settled, false, "the loop is still running when the handler has returned");
		const runDirectory = join(directory, ".kpi", "runs", jobId);

		// The command line is free: status renders the live board.
		notifications.length = 0;
		await kpi("status", ctx);
		assert.equal(notifications.length, 1, notifications.join("\n"));
		assert.match(notifications[0] ?? "", /K-π/u);
		assert.match(notifications[0] ?? "", /STOP RUNNING/u);
		assert.equal(settled, false);

		// A second goal is refused while this one runs; nothing new starts.
		notifications.length = 0;
		await kpi("add a second endpoint", ctx);
		assert.deepEqual(notifications, [`K-π job ${jobId} is still running: /kpi status shows it, /kpi stop stops it`]);
		assert.deepEqual(await readdir(join(directory, ".kpi", "runs")), [jobId]);
		assert.equal(settled, false);

		// Stop lands at once: the handler resolves after the loop recorded STOPPED.
		notifications.length = 0;
		await kpi("stop", ctx);
		assert.equal(settled, true, "the hanging prompt was aborted");
		await liveLoopSettled();
		const marker = JSON.parse(await readFile(join(runDirectory, "stop.json"), "utf8")) as Record<string, unknown>;
		assert.equal(marker.reason, "operator stop");
		assert.equal(marker.recorded, false, "the aborted driver recorded its own terminal");
		const terminals = (await readFile(join(runDirectory, "events.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { type: string; status?: string; reason?: string })
			.filter((record) => record.type === "loop.terminal");
		assert.deepEqual(
			terminals.map((record) => [record.status, record.reason]),
			[["STOPPED", "operator stop"]],
		);
		const state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		assert.equal(state.status, "STOPPED");
		assert.equal(await readLiveJob(directory), undefined);
		assert.ok(
			notifications.includes(`K-π job ${jobId} STOPPED (resume with /kpi ${jobId})`),
			notifications.join("\n"),
		);
		assert.ok(notifications.includes(`K-π job ${jobId} STOPPED: operator stop`), notifications.join("\n"));
		assert.equal(await verifyChain(join(runDirectory, "events.jsonl")), true);
	});
});
