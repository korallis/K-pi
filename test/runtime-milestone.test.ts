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

import { registerAutoWrap } from "../packages/coding-agent/src/kpi/extensions/auto-wrap.ts";
import { createStatusWidget, registerControlPlane } from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import { autoWrapState } from "../packages/coding-agent/src/kpi/extensions/settings.ts";
import { kModeState } from "../packages/coding-agent/src/kpi/kstack/mode.ts";

test("bare goals wrap while commands and active-job follow-ups do not", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-wrap-"));
	let input: ((event: InputEvent, context: ExtensionContext) => Promise<InputEventResult>) | undefined;
	registerAutoWrap({
		on(event: string, handler: typeof input) {
			if (event === "input") input = handler;
		},
	} as unknown as ExtensionAPI);
	const context = { cwd: directory } as ExtensionContext;
	try {
		autoWrapState.enabled = true;
		const wrapped = await input?.({ type: "input", text: "add healthcheck", source: "interactive" }, context);
		assert.deepEqual(wrapped, { action: "transform", text: "/kpi --mode gated add healthcheck", images: undefined });
		assert.equal(kModeState.enabled, true);
		assert.deepEqual(await input?.({ type: "input", text: "/accounts", source: "interactive" }, context), {
			action: "continue",
		});

		const run = join(directory, ".kpi", "runs", "active");
		await mkdir(run, { recursive: true });
		await writeFile(join(run, "state.json"), JSON.stringify({ job_id: "active", status: "RUNNING" }));
		assert.deepEqual(await input?.({ type: "input", text: "follow up", source: "interactive" }, context), {
			action: "continue",
		});

		// A finished job does not own the next goal: the operator stays in K-mode.
		for (const status of ["DONE", "UNSAFE", "NEEDS_HUMAN", "EXHAUSTED", "NO_PROGRESS", "BLOCKED"]) {
			await writeFile(join(run, "state.json"), JSON.stringify({ job_id: "active", status }));
			assert.deepEqual(
				await input?.({ type: "input", text: "next goal", source: "interactive" }, context),
				{ action: "transform", text: "/kpi --mode gated next goal", images: undefined },
				`a ${status} job is finished, so a bare goal starts the next one`,
			);
		}
		// A job still running keeps owning the follow-up.
		await writeFile(join(run, "state.json"), JSON.stringify({ job_id: "active", status: "RUNNING" }));
		assert.deepEqual(await input?.({ type: "input", text: "follow up again", source: "interactive" }, context), {
			action: "continue",
		});

		autoWrapState.enabled = false;
		assert.deepEqual(await input?.({ type: "input", text: "plain", source: "interactive" }, context), {
			action: "continue",
		});
	} finally {
		autoWrapState.enabled = true;
		await rm(directory, { recursive: true, force: true });
	}
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
