import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "../../config.ts";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { kModeState } from "../kstack/mode.ts";

import { appendEvent, type JsonValue } from "./append-log.ts";
import {
	type BoardModel,
	normalizeStop,
	RUN_FILE_NAMES,
	renderBoard,
	researchCellFromDocument,
	type StopDisplay,
} from "./board.ts";
import { liveWorkerCount } from "./bus/live-snapshot.ts";
import { type LoopDependencies, type LoopOutcome, parseLoopInvocation, resumeLoop, runLoop } from "./gated-loop.ts";
import { atomicWrite, type RunState, readActiveJob } from "./run-store.ts";
import { autoWrapState } from "./settings.ts";
import { getFooterRouteSnapshot } from "./status-line/route-snapshot.ts";
import { formatUsage } from "./status-line/segments.ts";

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

function booleanValue(value: JsonValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Paused human node: graph interrupted and/or a pending operator question.
 * Never derived from a persisted APPROVAL stop status.
 */
export function isPausedHuman(state: RunState): boolean {
	if (state.graph_status === "interrupted") return true;
	const question = state.pending_question;
	if (typeof question === "string" && question.trim().length > 0) return true;
	const pending = state.pending_human ?? state.pendingHuman;
	if (pending !== null && typeof pending === "object" && !Array.isArray(pending)) {
		return true;
	}
	return false;
}

export function displayStop(state: RunState): StopDisplay {
	return normalizeStop(stringValue(state.status ?? state.stop, "RUNNING"));
}

async function fileLitMap(directory: string): Promise<Record<string, boolean>> {
	const entries = await Promise.all(
		RUN_FILE_NAMES.map(async (name) => {
			try {
				const metadata = await stat(join(directory, name));
				return [name, metadata.isFile() && metadata.size > 0] as const;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return [name, false] as const;
				}
				throw error;
			}
		}),
	);
	return Object.fromEntries(entries);
}

/** BUS lamp: lit when the run has a non-empty bus.jsonl history, not by live agent count. */
async function busLogLit(directory: string): Promise<boolean> {
	try {
		const metadata = await stat(join(directory, "bus.jsonl"));
		return metadata.isFile() && metadata.size > 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

/**
 * Playbook name + progress todos from the active job only (state.json, else task.json).
 * Never kModeState.plan — a later sticky match must not relabel an open job.
 */
async function jobPlaybookFreeze(
	runDirectory: string,
	state: RunState,
): Promise<{ playbook: string; todos: string[] } | undefined> {
	const statePlaybook =
		typeof state.playbook === "string" && state.playbook.trim().length > 0 ? state.playbook : undefined;
	const stateTodos = Array.isArray(state.todos)
		? state.todos.filter((entry): entry is string => typeof entry === "string")
		: undefined;

	if (statePlaybook !== undefined) {
		return { playbook: statePlaybook, todos: stateTodos ?? [] };
	}

	try {
		const task = JSON.parse(await readFile(join(runDirectory, "task.json"), "utf8")) as {
			playbook?: unknown;
			playbook_steps?: Array<{ node?: unknown; text?: unknown; skip?: unknown }>;
		};
		if (typeof task.playbook !== "string" || task.playbook.trim().length === 0) {
			return undefined;
		}
		const todos =
			stateTodos ??
			(Array.isArray(task.playbook_steps)
				? task.playbook_steps
						.filter(
							(step): step is { node: string; text: string; skip?: string } =>
								typeof step?.node === "string" &&
								step.node.trim().length > 0 &&
								typeof step?.text === "string" &&
								step.text.trim().length > 0,
						)
						.map((step) =>
							typeof step.skip === "string" && step.skip.trim().length > 0
								? `${step.node}: ${step.text} — skip: ${step.skip}`
								: `${step.node}: ${step.text}`,
						)
				: []);
		return { playbook: task.playbook, todos };
	} catch {
		return undefined;
	}
}

async function contextPackLamps(cwd: string, runDirectory: string): Promise<BoardModel["contextPack"]> {
	const roots = [join(cwd, CONFIG_DIR_NAME, "context"), join(runDirectory, "context"), runDirectory];
	const names = ["product.md", "structure.md", "tech.md"] as const;
	const lit = { product: false, structure: false, tech: false };
	for (const root of roots) {
		for (const name of names) {
			const key = name.replace(/\.md$/, "") as keyof typeof lit;
			if (lit[key]) continue;
			try {
				const metadata = await stat(join(root, name));
				if (metadata.isFile() && metadata.size > 0) lit[key] = true;
			} catch {
				// missing is dark
			}
		}
	}
	return lit;
}

async function loadResearchCell(runDirectory: string): Promise<BoardModel["research"]> {
	try {
		const raw = JSON.parse(await readFile(join(runDirectory, "research.json"), "utf8")) as Record<string, unknown>;
		return researchCellFromDocument(raw as Parameters<typeof researchCellFromDocument>[0]);
	} catch {
		return undefined;
	}
}

function fingerprintFromState(state: RunState): string | undefined {
	const direct = state.output_fingerprint ?? state.fingerprint;
	if (typeof direct === "string") return direct;
	const fingerprints = state.output_fingerprints;
	if (Array.isArray(fingerprints) && fingerprints.length > 0) {
		const last = fingerprints.at(-1);
		return typeof last === "string" ? last : undefined;
	}
	return undefined;
}

export interface BoardBuildOptions {
	/** Terminal width for narrow fit. */
	width?: number;
	/**
	 * Injected live worker count. Production reads the bus snapshot; tests inject.
	 * Never starts workers.
	 */
	agents?: number;
}

/**
 * Builds the operator board from run files and process-local snapshots only.
 * Must not call a model client or createAgentSession.
 */
export async function buildBoardModel(cwd: string, options: BoardBuildOptions = {}): Promise<BoardModel | undefined> {
	const job = await readActiveJob(cwd);
	if (job === undefined) return undefined;

	const state = job.state;
	const paused = isPausedHuman(state);
	const route = getFooterRouteSnapshot();
	const usage = formatUsage(route.remainingPercent, route.slotKind);
	const freeze = await jobPlaybookFreeze(job.directory, state);
	const agents = options.agents ?? liveWorkerCount();
	const busLit = await busLogLit(job.directory);

	return {
		jobId: job.jobId,
		mode: stringValue(state.mode, "gated"),
		round: numberValue(state.round, 0),
		maxRounds: numberValue(state.maxRounds ?? nestedValue(state, "limits", "maxRounds"), 3),
		stage: stringValue(state.stage, "unknown"),
		node: stringValue(state.node, "unknown"),
		stop: displayStop(state),
		paused,
		...(typeof state.pending_question === "string" ? { pendingQuestion: state.pending_question } : {}),
		passed: booleanValue(typeof state.passed === "boolean" ? state.passed : nestedValue(state, "test", "passed")),
		fingerprint: fingerprintFromState(state),
		fileLit: await fileLitMap(job.directory),
		contextPack: await contextPackLamps(cwd, job.directory),
		research: await loadResearchCell(job.directory),
		agents,
		// Sticky K-mode only — never the mutable plan match for an open job.
		kModeEnabled: kModeState.enabled,
		busLit,
		...(freeze === undefined
			? {}
			: {
					kstack: {
						playbook: freeze.playbook,
						todos: freeze.todos,
					},
				}),
		...(route.route === undefined ? {} : { route: route.route }),
		...(usage === undefined ? {} : { usage }),
		...(options.width === undefined ? {} : { width: options.width }),
	};
}

export async function createStatusWidget(cwd: string, options: BoardBuildOptions = {}): Promise<string[]> {
	const model = await buildBoardModel(cwd, options);
	if (model === undefined) {
		return ["no active job"];
	}
	return renderBoard(model);
}

export async function renderStatusOverlay(cwd: string, options: BoardBuildOptions = {}): Promise<string> {
	return (await createStatusWidget(cwd, options)).join("\n");
}

async function installWidget(ctx: ExtensionContext): Promise<boolean> {
	const lines = await createStatusWidget(ctx.cwd);
	if (lines.length === 1 && lines[0] === "no active job") {
		ctx.ui.setWidget("kpi", undefined);
		return false;
	}
	const job = await readActiveJob(ctx.cwd);
	if (typeof ctx.ui.setTheme === "function") {
		const paused = job !== undefined && isPausedHuman(job.state);
		ctx.ui.setTheme(paused ? "protocol-blue" : "loop-amber");
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

	const job = await readActiveJob(ctx.cwd);
	if (typeof ctx.ui.setTheme === "function") {
		const paused = job !== undefined && isPausedHuman(job.state);
		ctx.ui.setTheme(paused ? "protocol-blue" : "loop-amber");
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
