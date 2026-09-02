import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "../packages/coding-agent/src/core/extensions/types.ts";

import { createStatusWidget, registerControlPlane } from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import { dispatchState, registerRouting } from "../packages/coding-agent/src/kpi/extensions/routing.ts";
import { routingState } from "../packages/coding-agent/src/kpi/extensions/settings.ts";
import { kModeState } from "../packages/coding-agent/src/kpi/kstack/mode.ts";

type InputHandler = (event: InputEvent, context: ExtensionContext) => Promise<InputEventResult>;
type AgentEndHandler = (event: unknown, context: ExtensionContext) => Promise<void>;
type StartJobParams = { goal: string; mode?: "gated" | "autopilot"; reason: string };
type StartJobTool = {
	name: string;
	promptGuidelines?: string[];
	execute(
		id: string,
		params: StartJobParams,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: { type: string; text?: string }[] }>;
};

/** A fake harness that captures exactly what routing registers and sends. */
function routingFixture(env: NodeJS.ProcessEnv = {}) {
	let input: InputHandler | undefined;
	let agentEnd: AgentEndHandler | undefined;
	let tool: StartJobTool | undefined;
	const sent: { text: string; options: unknown }[] = [];
	registerRouting(
		{
			on(event: string, handler: unknown) {
				if (event === "input") input = handler as InputHandler;
				if (event === "agent_end") agentEnd = handler as AgentEndHandler;
			},
			registerTool(definition: StartJobTool) {
				tool = definition;
			},
			sendUserMessage(text: string, options: unknown) {
				sent.push({ text, options });
			},
		} as unknown as ExtensionAPI,
		{ env, agentDirectory: join(tmpdir(), "kpi-no-agent-dir") },
	);
	return {
		input: (text: string, context: ExtensionContext) =>
			input?.({ type: "input", text, source: "interactive" }, context),
		agentEnd: (context: ExtensionContext) => agentEnd?.({ type: "agent_end", messages: [] }, context),
		tool: () => tool,
		start: (params: StartJobParams, context: ExtensionContext) => {
			if (tool === undefined) throw new Error("kpi_start_job was not registered");
			return tool.execute("call-1", params, undefined, undefined, context);
		},
		sent,
	};
}

function chatContext(cwd: string, notifications: string[] = []): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
}

async function withRoutingDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "kpi-routing-"));
	const enabledBefore = kModeState.enabled;
	try {
		delete routingState.override;
		delete dispatchState.pending;
		await run(directory);
	} finally {
		delete routingState.override;
		delete dispatchState.pending;
		kModeState.enabled = enabledBefore;
		await rm(directory, { recursive: true, force: true });
	}
}

/** Read through a call so the compiler does not narrow `pending` across awaits. */
function queued() {
	return dispatchState.pending;
}

async function writeRunState(directory: string, state: Record<string, unknown>): Promise<void> {
	const run = join(directory, ".kpi", "runs", "active");
	await mkdir(run, { recursive: true });
	await writeFile(join(run, "state.json"), JSON.stringify(state));
}

test("bare text stays plain chat and the agent starts a K-π job through kpi_start_job", async () => {
	await withRoutingDirectory(async (directory) => {
		const fixture = routingFixture();
		const notifications: string[] = [];
		const context = chatContext(directory, notifications);
		kModeState.enabled = false;

		assert.deepEqual(await fixture.input("add healthcheck", context), { action: "continue" });
		assert.equal(kModeState.enabled, false, "plain chat does not switch K-mode on");
		assert.equal(fixture.tool()?.name, "kpi_start_job");
		assert.ok(
			fixture.tool()?.promptGuidelines?.some((line) => line.includes("kpi_start_job")),
			"the routing rule rides on the tool",
		);

		const result = await fixture.start(
			{ goal: "add a healthcheck endpoint  with a test", reason: "multi-file feature" },
			context,
		);
		assert.match(result.content[0]?.text ?? "", /K-π job queued/u);
		assert.equal(dispatchState.pending?.text, "/kpi --mode gated add a healthcheck endpoint with a test");
		assert.equal(kModeState.enabled, true, "a queued job carries sticky K-mode");
		assert.deepEqual(notifications, ["K-π job queued: add a healthcheck endpoint with a test"]);
		assert.deepEqual(fixture.sent, [], "the loop is not started inside the tool call");

		await assert.rejects(
			fixture.start({ goal: "and also add metrics to the endpoint", reason: "second" }, context),
			/already queued/u,
		);

		await fixture.agentEnd(context);
		assert.deepEqual(fixture.sent, [
			{ text: "/kpi --mode gated add a healthcheck endpoint with a test", options: { expandPromptTemplates: true } },
		]);
		assert.equal(dispatchState.pending, undefined);
		await fixture.agentEnd(context);
		assert.equal(fixture.sent.length, 1, "a drained dispatch is not sent twice");
	});
});

test("routing always wraps bare goals but never commands", async () => {
	await withRoutingDirectory(async (directory) => {
		const fixture = routingFixture();
		const context = chatContext(directory);
		routingState.override = "always";
		kModeState.enabled = false;

		assert.deepEqual(await fixture.input("add healthcheck", context), {
			action: "transform",
			text: "/kpi --mode gated add healthcheck",
			images: undefined,
		});
		assert.equal(kModeState.enabled, true);
		assert.deepEqual(await fixture.input("/accounts", context), { action: "continue" });
		assert.deepEqual(await fixture.input("/kpi status", context), { action: "continue" });
		assert.deepEqual(await fixture.input("  ", context), { action: "continue" });
		const multiline = await fixture.input("add healthcheck\n  and verify it\n", context);
		assert.equal(
			multiline !== undefined && multiline.action === "transform" ? multiline.text : undefined,
			"/kpi --mode gated add healthcheck and verify it",
			"a goal is one line: the run store names paths after it",
		);
	});
});

test("a live job owns bare follow-ups and kpi_start_job refuses to start a second one", async () => {
	await withRoutingDirectory(async (directory) => {
		const fixture = routingFixture();
		const context = chatContext(directory);
		routingState.override = "always";

		await writeRunState(directory, { job_id: "active", status: "RUNNING" });
		assert.deepEqual(await fixture.input("follow up", context), { action: "continue" });
		await assert.rejects(
			fixture.start({ goal: "add a healthcheck endpoint with a test", reason: "feature" }, context),
			/job active is live/u,
		);

		// A finished job does not own the next goal.
		for (const status of ["DONE", "UNSAFE", "NEEDS_HUMAN", "EXHAUSTED", "NO_PROGRESS", "BLOCKED"]) {
			delete dispatchState.pending;
			await writeRunState(directory, { job_id: "active", status });
			assert.deepEqual(
				await fixture.input("next goal", context),
				{ action: "transform", text: "/kpi --mode gated next goal", images: undefined },
				`a ${status} job is finished, so a bare goal starts the next one`,
			);
			await fixture.start({ goal: "add a healthcheck endpoint with a test", reason: "feature" }, context);
			assert.equal(queued()?.mode, "gated", `a ${status} job does not block the tool`);
		}
	});
});

test("kpi off, kpi.routing off, and worker sessions leave no automatic job start", async () => {
	await withRoutingDirectory(async (directory) => {
		const fixture = routingFixture();
		const context = chatContext(directory);

		routingState.override = "off";
		assert.deepEqual(await fixture.input("add healthcheck", context), { action: "continue" });
		await assert.rejects(
			fixture.start({ goal: "add a healthcheck endpoint with a test", reason: "feature" }, context),
			/routing is off/u,
		);

		delete routingState.override;
		await mkdir(join(directory, ".kpi"), { recursive: true });
		await writeFile(join(directory, ".kpi", "settings.json"), JSON.stringify({ routing: "off" }));
		await assert.rejects(
			fixture.start({ goal: "add a healthcheck endpoint with a test", reason: "feature" }, context),
			/routing is off/u,
		);
		await writeFile(join(directory, ".kpi", "settings.json"), JSON.stringify({ routing: "always" }));
		assert.equal((await fixture.input("add healthcheck", context))?.action, "transform");

		await writeFile(join(directory, ".kpi", "settings.json"), JSON.stringify({ routing: "auto" }));
		for (const goal of ["hi", "apply", "why does the build fail?", "Thanks, that worked"]) {
			await assert.rejects(fixture.start({ goal, reason: "test" }, context), /refused/u, goal);
			assert.equal(dispatchState.pending, undefined, `${JSON.stringify(goal)} never queues a job`);
		}

		const worker = routingFixture({ KPI_WORKER_DESCRIPTOR: JSON.stringify({ agent_id: "w" }) });
		assert.equal(worker.tool(), undefined, "a bus worker never holds kpi_start_job");
	});
});

test("human pause selects protocol-blue and running selects loop-amber", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-theme-"));
	const run = join(directory, ".kpi", "runs", "active");
	let sessionStart: ((event: unknown, context: ExtensionContext) => Promise<void>) | undefined;
	const themes: string[] = [];
	const pi = {
		on(event: string, handler: typeof sessionStart) {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: directory,
		ui: {
			setWidget() {},
			setTheme(theme: string) {
				themes.push(theme);
				return { success: true };
			},
		},
	} as unknown as ExtensionContext;
	try {
		await mkdir(run, { recursive: true });
		await writeFile(
			join(run, "state.json"),
			JSON.stringify({
				job_id: "active",
				status: "RUNNING",
				graph_status: "interrupted",
				pending_question: "Ship?",
				playbook: "feature",
				todos: ["ship: confirm"],
			}),
		);
		kModeState.enabled = true;
		registerControlPlane(pi);
		await sessionStart?.({}, context);
		assert.match((await createStatusWidget(directory))[0] ?? "", /K-STACK on/);
		assert.equal(themes.at(-1), "protocol-blue");
		await writeFile(
			join(run, "state.json"),
			JSON.stringify({ job_id: "active", status: "RUNNING", graph_status: "running" }),
		);
		await sessionStart?.({}, context);
		assert.equal(themes.at(-1), "loop-amber");
	} finally {
		kModeState.enabled = false;
		await rm(directory, { recursive: true, force: true });
	}
});
