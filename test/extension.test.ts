import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallEvent } from "../packages/coding-agent/src/core/extensions/types.ts";

import { EVENT_TYPES } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import kPi from "../packages/coding-agent/src/kpi/extensions/index.ts";

test("extension factory registers commands, policy hook, and renderers", () => {
	const commandNames: string[] = [];
	const eventNames: string[] = [];
	const rendererNames: string[] = [];

	const pi = {
		on(event: string) {
			eventNames.push(event);
		},
		registerCommand(name: string) {
			commandNames.push(name);
		},
		registerEntryRenderer(name: string) {
			rendererNames.push(name);
		},
	};

	assert.doesNotThrow(() => kPi(pi as unknown as Parameters<typeof kPi>[0]));
	// `/pool` is part of the spec's command table alongside `/accounts`.
	assert.deepEqual(commandNames, [
		"pool",
		"accounts",
		"kpi",
		"loop",
		"kpi-ping",
		"k-mode",
		"setup-kstack",
		"statusbar",
	]);
	assert.equal(eventNames.filter((event) => event === "tool_call").length, 1);
	assert.deepEqual(rendererNames, EVENT_TYPES);
});

test("default policy resolves write bounds from the active job", async () => {
	type Hook = (
		event: ToolCallEvent,
		context: { cwd: string },
	) => Promise<{ block?: boolean; reason?: string } | undefined>;

	let hook: Hook | undefined;
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "tool_call") {
				hook = handler as Hook;
			}
		},
		registerCommand() {},
		registerEntryRenderer() {},
	};
	kPi(pi as unknown as Parameters<typeof kPi>[0]);
	assert.ok(hook);

	const directory = await mkdtemp(join(tmpdir(), "k-pi-extension-policy-"));
	const runDirectory = join(directory, ".kpi", "runs", "active-job");
	try {
		await mkdir(runDirectory, { recursive: true });
		await Promise.all([
			writeFile(
				join(runDirectory, "task.json"),
				JSON.stringify({
					acceptance: [{ bounds: { write_allow: ["src/**", "test/**"] } }],
				}),
			),
			writeFile(join(runDirectory, "state.json"), JSON.stringify({ job_id: "active-job", status: "RUNNING" })),
		]);

		const context = { cwd: directory };
		const allowedWrite: ToolCallEvent = {
			type: "tool_call",
			toolCallId: "allowed",
			toolName: "write",
			input: { path: "src/server.ts", content: "export {};\n" },
		};
		const deniedWrite: ToolCallEvent = {
			...allowedWrite,
			toolCallId: "denied",
			input: { path: "package.json", content: "{}\n" },
		};
		assert.equal(await hook(allowedWrite, context), undefined);
		assert.equal((await hook(deniedWrite, context))?.block, true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
