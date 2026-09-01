import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionCommandContext, ExtensionContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import { verifyChain } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { createStatusWidget, registerControlPlane } from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";

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

function registerFixture() {
	const commands = new Map<string, CommandHandler>();
	let sessionStart: SessionStartHandler | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_start") {
				sessionStart = handler as SessionStartHandler;
			}
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		sendUserMessage() {
			throw new Error("provider request attempted");
		},
		setModel() {
			throw new Error("model mutation attempted");
		},
	};
	registerControlPlane(pi as unknown as Parameters<typeof registerControlPlane>[0]);
	return { commands, getSessionStart: () => sessionStart };
}

function context(cwd: string, notifications: string[], widgets: Array<string[] | undefined>): ExtensionCommandContext {
	return {
		cwd,
		hasUI: false,
		mode: "json",
		newSession: async () => {
			throw new Error("agent start attempted");
		},
		ui: {
			custom: async () => {
				throw new Error("unexpected overlay");
			},
			notify(message: string) {
				notifications.push(message);
			},
			setWidget(_key: string, content: string[] | undefined) {
				widgets.push(content);
			},
		},
	} as unknown as ExtensionCommandContext;
}

async function createRun(directory: string): Promise<string> {
	const runDirectory = join(directory, ".kpi", "runs", "2026-08-31-status");
	await mkdir(runDirectory, { recursive: true });
	await writeFile(
		join(runDirectory, "state.json"),
		`${JSON.stringify({
			job_id: "2026-08-31-status",
			mode: "gated",
			round: 2,
			maxRounds: 3,
			stage: "implement",
			node: "implementer",
			passed: false,
			status: "RUNNING",
		})}\n`,
	);
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

test("kpi stop appends a terminal BLOCKED event", async () => {
	await withFixture(async (directory) => {
		const runDirectory = await createRun(directory);
		const notifications: string[] = [];
		const widgets: Array<string[] | undefined> = [];
		const { commands } = registerFixture();

		await commands.get("kpi")!("stop", context(directory, notifications, widgets));

		const lines = (await readFile(join(runDirectory, "events.jsonl"), "utf8")).trimEnd().split("\n");
		const event = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
		const state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		assert.equal(event.type, "loop.terminal");
		assert.equal(event.status, "BLOCKED");
		assert.equal(state.status, "BLOCKED");
		assert.equal(await verifyChain(join(runDirectory, "events.jsonl")), true);
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
	const { commands } = registerFixture();
	assert.equal(commands.get("loop"), commands.get("kpi"));
});
