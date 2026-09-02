import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { kModeState } from "../kstack/mode.ts";

import { appendEvent, inspectChain, type JsonValue } from "./append-log.ts";
import {
	type BoardModel,
	normalizeStop,
	RUN_FILE_NAMES,
	renderBoard,
	researchCellFromDocument,
	type StopDisplay,
	type Verifier,
} from "./board.ts";
import { createBoardComponent } from "./board-component.ts";
import { type BoardLayout, type BoardPalette, PLAIN_PALETTE, paintBoard, paletteFromTheme } from "./board-frame.ts";
import { liveWorkerCount } from "./bus/live-snapshot.ts";
import { type LoopDependencies, type LoopOutcome, parseLoopInvocation, resumeLoop, runLoop } from "./gated-loop.ts";
import { atomicWrite, JOB_ID_PATTERN, type RunState, readActiveJob, readLiveJob } from "./run-store.ts";
import { isRoutingMode, type RoutingMode, routingState } from "./settings.ts";
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

/**
 * A FAIL is only a fail once a verdict exists. `passed` starts out false, so a
 * round-0 board used to read FAIL before any verifier had run.
 */
function verifierFor(passed: boolean | undefined, fileLit: Readonly<Record<string, boolean>>): Verifier {
	if (passed === true) return "pass";
	if (passed === false && fileLit["verdict.json"] === true) return "fail";
	return "pending";
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
	const job = await readLiveJob(cwd);
	if (job === undefined) return undefined;

	const state = job.state;
	const paused = isPausedHuman(state);
	const route = getFooterRouteSnapshot();
	const usage = formatUsage(route.remainingPercent, route.slotKind);
	const freeze = await jobPlaybookFreeze(job.directory, state);
	const agents = options.agents ?? liveWorkerCount();
	const busLit = await busLogLit(job.directory);

	const fileLit = await fileLitMap(job.directory);
	const passed = booleanValue(typeof state.passed === "boolean" ? state.passed : nestedValue(state, "test", "passed"));
	return {
		jobId: job.jobId,
		mode: stringValue(state.mode, "gated"),
		round: numberValue(state.round, 0),
		maxRounds: numberValue(state.maxRounds ?? nestedValue(state, "limits", "maxRounds"), 3),
		stage: stringValue(state.stage, "unknown"),
		node: stringValue(state.node, "unknown"),
		stop: displayStop(state),
		paused,
		gate: paused ? "human" : "machine",
		...(typeof state.pending_question === "string" ? { pendingQuestion: state.pending_question } : {}),
		passed,
		verifier: verifierFor(passed, fileLit),
		fingerprint: fingerprintFromState(state),
		fileLit,
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

/** The framed board for a surface of `width` columns; plain unless a palette is given. */
export async function paintStatusBoard(
	cwd: string,
	options: BoardBuildOptions & { width: number; layout: BoardLayout; palette?: BoardPalette },
): Promise<string[] | undefined> {
	const model = await buildBoardModel(cwd, options);
	if (model === undefined) return undefined;
	return paintBoard(model, {
		width: options.width,
		layout: options.layout,
		palette: options.palette ?? PLAIN_PALETTE,
	});
}

/** Reported once per process: a repeated warning would be noise, silence was the bug. */
let boardThemeWarned = false;

/**
 * Applies the board's colour identity and reports a refusal.
 *
 * `setTheme` returns a result, and discarding it is how the board came up
 * colourless for a whole session without anyone noticing: the themes K-π ships
 * were not registered when the first board was drawn, every call failed, and
 * nothing said so. The board's colour is the operator's cue for whether the
 * loop is running or waiting on them, so losing it is worth one warning.
 */
export function applyBoardTheme(
	ctx: Pick<ExtensionContext, "ui">,
	paused: boolean,
): { success: boolean; error?: string } | undefined {
	if (typeof ctx.ui.setTheme !== "function") {
		return undefined;
	}
	const name = paused ? "protocol-blue" : "loop-amber";
	const result = ctx.ui.setTheme(name);
	if (result?.success === false && !boardThemeWarned) {
		boardThemeWarned = true;
		ctx.ui.notify(`K-π board theme ${name} was refused: ${result.error ?? "unknown reason"}`, "warning");
	}
	return result;
}

/** Test seam: the once-per-process warning must not leak between tests. */
export function resetBoardThemeWarning(): void {
	boardThemeWarned = false;
}

/**
 * The always-on board above the editor.
 *
 * The widget is a component, not a list of strings: the interactive mode caps
 * a string widget at ten lines and paints it in the default colour, which is
 * how the board came up as an unframed text block. A component renders at the
 * live width, is never cut, and repaints in the new colours when the theme
 * swaps between amber and protocol-blue.
 */
async function installWidget(ctx: ExtensionContext): Promise<boolean> {
	const model = await buildBoardModel(ctx.cwd);
	if (model === undefined) {
		ctx.ui.setWidget("kpi", undefined);
		return false;
	}
	applyBoardTheme(ctx, model.paused);
	ctx.ui.setWidget("kpi", (_tui, theme) =>
		createBoardComponent(model, { layout: "compact", palette: paletteFromTheme(theme) }),
	);
	return true;
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	const model = await buildBoardModel(ctx.cwd);
	if (model === undefined) {
		ctx.ui.setWidget("kpi", undefined);
		// The last run is still worth a line: it says why the board is empty.
		const last = await readActiveJob(ctx.cwd);
		const status = typeof last?.state.status === "string" ? last.state.status : undefined;
		ctx.ui.notify(
			last === undefined ? "no active job" : `no active job — last job ${last.jobId} ${status ?? "ended"}`,
			"info",
		);
		return;
	}

	applyBoardTheme(ctx, model.paused);
	ctx.ui.setWidget("kpi", (_tui, theme) =>
		createBoardComponent(model, { layout: "compact", palette: paletteFromTheme(theme) }),
	);
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify(renderBoard(model).join("\n"), "info");
		return;
	}

	// The full board, framed and in the live theme; any key closes it.
	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => {
			const board = createBoardComponent(model, { layout: "full", palette: paletteFromTheme(theme) });
			return {
				handleInput() {
					done();
				},
				invalidate() {
					board.invalidate();
				},
				render(width: number) {
					return board.render(width);
				},
				dispose() {
					board.dispose();
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "92%", maxHeight: "90%", anchor: "center" } },
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

/**
 * Verifies a job's event log from the shipped harness.
 *
 * The chain exists so an operator can reconstruct an interrupted run, and a
 * guarantee nobody can check is not a guarantee. Verification is read-only and
 * reads no model: it recomputes each record's hash from the bytes on disk and
 * names the first line that does not chain.
 */
async function verifyJobLog(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const requested = args.trim();
	const path =
		requested.length > 0
			? join(ctx.cwd, CONFIG_DIR_NAME, "runs", requested, "events.jsonl")
			: (await readActiveJob(ctx.cwd))?.eventsPath;
	if (path === undefined) {
		ctx.ui.notify("no active job to verify; pass a job id", "info");
		return;
	}
	const report = await inspectChain(path);
	const jobId = requested.length > 0 ? requested : (await readActiveJob(ctx.cwd))?.jobId;
	if (report.ok) {
		ctx.ui.notify(`events.jsonl verified: ${report.records} records chained for ${jobId ?? "this job"}`, "info");
		return;
	}
	ctx.ui.notify(
		`events.jsonl FAILED verification at line ${report.line ?? 0}: ${report.reason ?? "unknown"} (${report.records} records verified before it)`,
		"error",
	);
}

const ROUTING_NOTICES: Record<RoutingMode, string> = {
	off: "K-π routing off: bare text is plain chat and only /kpi starts a job",
	auto: "K-π routing auto: the agent starts a job for substantial work",
	always: "K-π routing always: bare text starts a gated job",
};

/** A missing, unnameable, or non-directory run path is "not a run", never a crash. */
const TOLERATED_PROBE_ERRORS = new Set(["ENOENT", "ENAMETOOLONG", "ENOTDIR"]);

async function isRunDirectory(cwd: string, jobId: string): Promise<boolean> {
	try {
		await readFile(join(cwd, CONFIG_DIR_NAME, "runs", jobId, "task.json"), "utf8");
		return true;
	} catch (error) {
		if (TOLERATED_PROBE_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
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
	if (isRoutingMode(command)) {
		routingState.override = command;
		ctx.ui.notify(ROUTING_NOTICES[command], "info");
		return;
	}
	// A subcommand may not swallow a goal: `verify` alone, or `verify <job-id>`,
	// is the verifier; anything else is what the operator wants built.
	if (command === "verify" || (command.startsWith("verify ") && JOB_ID_PATTERN.test(command.slice(7).trim()))) {
		await verifyJobLog(command.slice("verify".length), ctx);
		return;
	}

	try {
		const onStateChange = async () => {
			await installWidget(ctx);
		};
		// Only something shaped like a job id is probed as one. A goal is free
		// text, and turning it into a path is how a long message once died with
		// ENAMETOOLONG before the loop ever started.
		const resume = JOB_ID_PATTERN.test(command) && (await isRunDirectory(ctx.cwd, command));
		const outcome: LoopOutcome = resume
			? await resumeLoop(command, ctx, { ...dependencies, onStateChange })
			: await runLoop(parseLoopInvocation(command), ctx, { ...dependencies, onStateChange });
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
		description:
			"Control the K-π coding loop: <goal>, status, stop, verify, auto|always|off routing (--max-cost-usd / --timeout-ms / --max-rounds freeze onto task.limits)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleKpiCommand(args, ctx, dependencies);
		},
	};
	pi.registerCommand("kpi", command);
	pi.registerCommand("loop", command);
}
