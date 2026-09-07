import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallEvent } from "../packages/coding-agent/src/core/extensions/types.ts";

import kPi from "../packages/coding-agent/src/kpi/extensions/index.ts";
import { createJob } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

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
		await createJob(directory, {
			job_id: "active-job",
			goal: "Restrict product edits to the accepted scope",
			mode: "gated",
			nongoals: [],
			constraints: [],
			quality_gates: [],
			ac: { quality: "executable" },
			acceptance: [
				{
					id: "AC-01",
					statement: "Product edits stay in source and tests",
					required: true,
					bounds: { write_allow: ["src/**", "test/**"] },
				},
			],
		});
		await writeFile(join(runDirectory, "state.json"), JSON.stringify({ job_id: "active-job", status: "RUNNING" }));

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
