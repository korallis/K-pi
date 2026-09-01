import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "../../config.ts";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { kModeState } from "../kstack/mode.ts";

import { appendEvent, type JsonValue } from "./append-log.ts";
import { type LoopDependencies, type LoopOutcome, parseLoopInvocation, resumeLoop, runLoop } from "./gated-loop.ts";
import { atomicWrite, type RunState, readActiveJob } from "./run-store.ts";
import { autoWrapState } from "./settings.ts";

const STAGES = [
	"01 ac-compile",
	"02 specify",
	"03 plan",
	"04 implement",
	"05 test",
	"06 bounds",
	"07 review",
	"08 ship",
] as const;
const RUN_FILES = [
	"task.json",
	"context.md",
	"candidate.json",
	"evidence.json",
	"verdict.json",
	"events.jsonl",
] as const;

function nestedValue(state: RunState, parent: string, child: string): JsonValue | undefined {
	const value = state[parent];
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value[child];
	}
	return undefined;
}

function stringValue(value: JsonValue | undefined, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function numberValue(value: JsonValue | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function verifierLabel(state: RunState): string {
	const passed = typeof state.passed === "boolean" ? state.passed : nestedValue(state, "test", "passed");
	return passed === true ? "PASS" : passed === false ? "FAIL" : "PASS/FAIL";
}

async function fileLamps(directory: string): Promise<string> {
	const lamps = await Promise.all(
		RUN_FILES.map(async (name) => {
			try {
				const metadata = await stat(join(directory, name));
				return `${metadata.isFile() && metadata.size > 0 ? "●" : "○"} ${name}`;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return `○ ${name}`;
				}
				throw error;
			}
		}),
	);
	return lamps.join("  ");
}

export async function createStatusWidget(cwd: string): Promise<string[]> {
	const job = await readActiveJob(cwd);
	if (job === undefined) {
		return ["no active job"];
	}

	const mode = stringValue(job.state.mode, "gated");
	const round = numberValue(job.state.round, 0);
	const maxRounds = numberValue(job.state.maxRounds ?? nestedValue(job.state, "limits", "maxRounds"), 3);
	const stage = stringValue(job.state.stage, "unknown");
	const node = stringValue(job.state.node, "unknown");
	const stop = stringValue(job.state.status ?? job.state.stop, "RUNNING").toUpperCase();
	const paused = stop === "APPROVAL" || job.state.graph_status === "interrupted";
	const question = stringValue(job.state.pending_question, "");
	return [
		`K-π  LOOP ${job.jobId}  MODE ${mode}  JOB ${job.jobId}${kModeState.enabled ? "  K-STACK on" : ""}`,
		`STAGES  ${STAGES.join("   ")}`,
		`ROUND ${round}/${maxRounds}  STAGE ${stage}  NODE ${node}  ${verifierLabel(job.state)}`,
		`GATE ${paused ? "human" : "machine"}${paused ? `  WAITING ON OPERATOR ${question}` : ""}`,
		`FILES  ${await fileLamps(job.directory)}`,
		`STOP ${stop}`,
	];
}

export async function renderStatusOverlay(cwd: string): Promise<string> {
	return (await createStatusWidget(cwd)).join("\n");
}

async function installWidget(ctx: ExtensionContext): Promise<boolean> {
	const lines = await createStatusWidget(ctx.cwd);
	if (lines.length === 1 && lines[0] === "no active job") {
		ctx.ui.setWidget("kpi", undefined);
		return false;
	}
	const job = await readActiveJob(ctx.cwd);
	if (typeof ctx.ui.setTheme === "function") {
		ctx.ui.setTheme(
			job?.state.status === "APPROVAL" || job?.state.graph_status === "interrupted" ? "protocol-blue" : "loop-amber",
		);
	}
	ctx.ui.setWidget("kpi", lines);
	return true;
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	const lines = await createStatusWidget(ctx.cwd);
	if (lines.length === 1 && lines[0] === "no active job") {
		ctx.ui.setWidget("kpi", undefined);
		ctx.ui.notify("no active job", "info");
		return;
	}

	ctx.ui.setWidget("kpi", lines);
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	await ctx.ui.custom<void>(
		(_tui, _theme, _keybindings, done) => ({
			handleInput() {
				done();
			},
			invalidate() {},
			render() {
				return lines;
			},
		}),
		{ overlay: true },
	);
}

async function stopJob(ctx: ExtensionCommandContext): Promise<void> {
	const job = await readActiveJob(ctx.cwd);
	if (job === undefined) {
		ctx.ui.notify("no active job", "info");
		return;
	}

	const round = numberValue(job.state.round, 0);
	await appendEvent(job.eventsPath, {
		ts: new Date().toISOString(),
		type: "loop.terminal",
		job_id: job.jobId,
		round,
		node: stringValue(job.state.node, "control-plane"),
		status: "BLOCKED",
		reason: "operator stop",
	});
	const stoppedState: RunState = { ...job.state, status: "BLOCKED" };
	await atomicWrite(job.statePath, `${JSON.stringify(stoppedState, null, 2)}\n`);
	await installWidget(ctx);
	ctx.ui.notify(`K-π job ${job.jobId} BLOCKED`, "warning");
}

async function handleKpiCommand(
	args: string,
	ctx: ExtensionCommandContext,
	dependencies: LoopDependencies,
): Promise<void> {
	const command = args.trim();
	if (command === "" || command === "status") {
		await showStatus(ctx);
		return;
	}
	if (command === "stop") {
		await stopJob(ctx);
		return;
	}
	if (command === "off") {
		autoWrapState.enabled = false;
		ctx.ui.notify("K-π automatic goal wrapping off", "info");
		return;
	}

	try {
		const onStateChange = async () => {
			await installWidget(ctx);
		};
		let outcome: LoopOutcome;
		try {
			await readFile(join(ctx.cwd, CONFIG_DIR_NAME, "runs", command, "task.json"), "utf8");
			outcome = await resumeLoop(command, ctx, { ...dependencies, onStateChange });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			outcome = await runLoop(parseLoopInvocation(command), ctx, {
				...dependencies,
				onStateChange,
			});
		}
		ctx.ui.notify(`K-π job ${outcome.jobId} ${outcome.status}`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`K-π loop failed: ${message}`, "error");
	}
}

export function registerControlPlane(pi: ExtensionAPI, dependencies: LoopDependencies = {}): void {
	pi.on("session_start", async (_event, ctx) => {
		await installWidget(ctx);
	});

	const command = {
		description: "Control the K-π coding loop",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleKpiCommand(args, ctx, dependencies);
		},
	};
	pi.registerCommand("kpi", command);
	pi.registerCommand("loop", command);
}
