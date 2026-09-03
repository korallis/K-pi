import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { kModeState } from "../kstack/mode.ts";

import { appendEvent, inspectChain, type JsonValue } from "./append-log.ts";
import {
	BOARD_STAGES,
	type BoardModel,
	type NodeDetail,
	normalizeStop,
	RUN_FILE_NAMES,
	renderBoard,
	researchCellFromDocument,
	type StopDisplay,
	type Verifier,
} from "./board.ts";
import { type ActivityReader, type ActivitySnapshot, createActivityReader, narrateRecord } from "./board-activity.ts";
import { createBoardComponent } from "./board-component.ts";
import { type BoardLayout, type BoardPalette, PLAIN_PALETTE, paintBoard, paletteFromTheme } from "./board-frame.ts";
import {
	type CommandCentreSources,
	createCommandCentre,
	type RunFileRow,
	type TranscriptEntry,
} from "./board-overlay.ts";
import { sessionsSnapshot } from "./bus/sessions-snapshot.ts";
import { MAX_LIVE_WORKERS } from "./bus/spawn.ts";
import {
	type LoopDependencies,
	type LoopInvocation,
	type LoopOutcome,
	makeJobId,
	parseLoopInvocation,
	resumeLoop,
	runLoop,
	writeStopMarker,
} from "./gated-loop.ts";
import { loadNamedGraph } from "./graph/engine.ts";
import { type GraphDefinition, isJsonObject } from "./graph/schema.ts";
import type { TransientReason } from "./graph/stop.ts";
import {
	type ActiveJob,
	atomicWrite,
	JOB_ID_PATTERN,
	LOOP_RECOVERIES,
	type LoopRecovery,
	type RunState,
	readActiveJob,
	readLiveJob,
} from "./run-store.ts";
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

const TRANSIENT_REASONS: Record<TransientReason, true> = { http: true, timeout: true, transport: true };

/** The backoff row state.json carries while a node waits, or nothing. */
function retryValue(value: JsonValue | undefined): BoardModel["retry"] {
	if (
		!isJsonObject(value) ||
		typeof value.node !== "string" ||
		typeof value.attempt !== "number" ||
		typeof value.reason !== "string" ||
		!(value.reason in TRANSIENT_REASONS) ||
		typeof value.delay_ms !== "number"
	) {
		return undefined;
	}
	return {
		node: value.node,
		attempt: value.attempt,
		reason: value.reason as TransientReason,
		delayMs: value.delay_ms,
	};
}

function recoveryValue(value: JsonValue | undefined): LoopRecovery | undefined {
	return typeof value === "string" && (LOOP_RECOVERIES as readonly string[]).includes(value)
		? (value as LoopRecovery)
		: undefined;
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
	 * Injected live agent count. Production derives it from the sessions
	 * registry. Never starts anything.
	 */
	agents?: number;
	/** Injected node/worker split. Production derives it from the sessions registry alongside `agents`. */
	sessions?: BoardModel["sessions"];
	/** Test/DI wall clock for the activity reader. Production uses Date.now. */
	now?: () => number;
	/** Injected activity reader. Production keeps one per live job's eventsPath. */
	activity?: ActivityReader;
	/** Which surface is being built: the always-on widget or the `/kpi status` overlay. */
	surface?: BoardModel["surface"];
	/**
	 * Build for this job even when it has finished. The widget only ever shows
	 * a live job; the Command Centre keeps showing the job it opened on so a
	 * `/kpi stop` paints STOP STOPPED instead of "no active job".
	 */
	job?: ActiveJob;
}

/**
 * Builds the operator board from run files and process-local snapshots only.
 * Must not call a model client or createAgentSession.
 */
export async function buildBoardModel(cwd: string, options: BoardBuildOptions = {}): Promise<BoardModel | undefined> {
	const job = options.job ?? (await readLiveJob(cwd));
	if (job === undefined) return undefined;

	const state = job.state;
	const paused = isPausedHuman(state);
	const route = getFooterRouteSnapshot();
	const usage = formatUsage(route.remainingPercent, route.slotKind);
	const freeze = await jobPlaybookFreeze(job.directory, state);
	// The sessions registry is pure memory (no I/O): safe to read on every tick.
	const live = options.agents === undefined ? sessionsSnapshot({ jobId: job.jobId }).counts : undefined;
	const agents = options.agents ?? (live === undefined ? 0 : live.nodes + live.workers);
	const sessions = options.sessions ?? live;
	const busLit = await busLogLit(job.directory);

	const fileLit = await fileLitMap(job.directory);
	const passed = booleanValue(typeof state.passed === "boolean" ? state.passed : nestedValue(state, "test", "passed"));
	const recovery = recoveryValue(state.recovery);
	const retry = retryValue(state.retry);

	const reader = options.activity ?? activityReaderFor(job.eventsPath);
	const now = options.now ?? Date.now;
	const snapshot = await reader.read(job.eventsPath, now());

	return {
		jobId: job.jobId,
		mode: stringValue(state.mode, "gated"),
		round: numberValue(state.round, 0),
		...(typeof state.superstep === "number" ? { superstep: state.superstep } : {}),
		stage: stringValue(state.stage, "unknown"),
		node: stringValue(state.node, "unknown"),
		stop: displayStop(state),
		...(recovery === undefined ? {} : { recovery }),
		...(retry === undefined ? {} : { retry }),
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
		...(sessions === undefined ? {} : { sessions }),
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
		activity: snapshot.stages,
		...(snapshot.unreadableLines > 0 ? { eventsUnreadable: snapshot.unreadableLines } : {}),
		...(snapshot.readError === undefined ? {} : { eventsError: snapshot.readError }),
		...(options.surface === undefined ? {} : { surface: options.surface }),
	};
}

/** The NODE detail panel's content for one stage, from an already-read activity snapshot. */
export async function readNodeDetail(job: ActiveJob, snapshot: ActivitySnapshot, stage: number): Promise<NodeDetail> {
	const key = BOARD_STAGES[stage]?.key;
	const activity = key === undefined ? undefined : snapshot.stages[key];
	if (activity === undefined) {
		return { node: key ?? String(stage), status: "pending", runs: 0, toolsByName: {} };
	}
	const base: NodeDetail = {
		node: activity.node,
		status: activity.status,
		runs: activity.runs,
		toolsByName: activity.toolsByName,
		...(activity.elapsedMs === undefined ? {} : { elapsedMs: activity.elapsedMs }),
		...(activity.costUsd === undefined ? {} : { costUsd: activity.costUsd }),
		...(activity.model === undefined ? {} : { model: activity.model }),
		...(activity.session === undefined ? {} : { session: activity.session }),
		...(activity.error === undefined ? {} : { error: activity.error }),
	};
	if (activity.result === undefined) {
		return base;
	}
	try {
		const info = await stat(join(job.directory, activity.result));
		if (info.isDirectory()) {
			// A declared result path that is actually a directory is broken, not a
			// written file — report it as a load error rather than a lit result.
			return { ...base, loadError: "EISDIR" };
		}
		return { ...base, result: { name: activity.result, lit: true, bytes: info.size } };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...base, result: { name: activity.result, lit: false } };
		}
		return { ...base, loadError: (error as NodeJS.ErrnoException).code ?? String(error) };
	}
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

/** A callback fired on an interval; returns a function that stops it. Test/DI seam for the board's ticker. */
export type Ticker = (callback: () => void, intervalMs: number) => () => void;

/** How often the always-on widget rereads run files and repaints. */
export const BOARD_TICK_MS = 1000;

function defaultTicker(callback: () => void, intervalMs: number): () => void {
	const handle = setInterval(callback, intervalMs);
	handle.unref?.();
	return () => clearInterval(handle);
}

export type ControlPlaneDependencies = LoopDependencies & {
	tick?: Ticker;
	/** The chat line the Command Centre hands a message to. Production binds the extension API's; tests may omit it. */
	sendUserMessage?: (text: string) => void;
};

/**
 * One ActivityReader and one narration cursor per live job's eventsPath,
 * module state so a widget reinstall (onSessionsChange → onStateChange →
 * installWidget) never re-parses the log from scratch or re-narrates history.
 */
const activityReaders = new Map<string, ActivityReader>();
const narrationCursors = new Map<string, number>();

function activityReaderFor(eventsPath: string): ActivityReader {
	let reader = activityReaders.get(eventsPath);
	if (reader === undefined) {
		reader = createActivityReader();
		activityReaders.set(eventsPath, reader);
	}
	return reader;
}

function forgetJob(eventsPath: string): void {
	activityReaders.delete(eventsPath);
	narrationCursors.delete(eventsPath);
}

/**
 * The always-on board above the editor.
 *
 * The widget is a component, not a list of strings: the interactive mode caps
 * a string widget at ten lines and paints it in the default colour, which is
 * how the board came up as an unframed text block. A component renders at the
 * live width, is never cut, and repaints in the new colours when the theme
 * swaps between amber and protocol-blue.
 *
 * Re-entrant: every call disposes the previous widget component (which stops
 * its ticker) before installing a fresh one, so a reinstall mid-run never
 * doubles the ticker or narrates a record twice.
 */
async function installWidget(ctx: ExtensionContext, dependencies: ControlPlaneDependencies = {}): Promise<boolean> {
	const now = dependencies.now ?? Date.now;
	const tick = dependencies.tick ?? defaultTicker;
	const job = await readLiveJob(ctx.cwd);
	if (job === undefined) {
		// No live job: nothing to read, so no reader or cursor may outlive it.
		activityReaders.clear();
		narrationCursors.clear();
		ctx.ui.setWidget("kpi", undefined);
		return false;
	}
	const eventsPath = job.eventsPath;
	const reader = activityReaderFor(eventsPath);
	const model = await buildBoardModel(ctx.cwd, { now, activity: reader, surface: "widget" });
	if (model === undefined) {
		ctx.ui.setWidget("kpi", undefined);
		return false;
	}
	if (!narrationCursors.has(eventsPath)) {
		// History from before this widget (or before this reinstall) existed is
		// never narrated — only records the ticker itself observes from here.
		narrationCursors.set(eventsPath, reader.last()?.records.length ?? 0);
	}
	applyBoardTheme(ctx, model.paused);

	function narrate(): void {
		const records = reader.last()?.records ?? [];
		const seen = narrationCursors.get(eventsPath) ?? records.length;
		const cursor = Math.min(seen, records.length);
		for (const record of records.slice(cursor)) {
			const line = narrateRecord(record);
			if (line !== undefined) {
				ctx.ui.notify(line.text, line.level);
			}
		}
		narrationCursors.set(eventsPath, records.length);
	}

	ctx.ui.setWidget("kpi", (tui, theme) => {
		const component = createBoardComponent(model, { layout: "compact", palette: paletteFromTheme(theme) });
		let current = model;
		let busy = false;
		let disposed = false;
		const warned = new Set<string>();
		const stop = tick(() => {
			if (busy || disposed) return;
			busy = true;
			void buildBoardModel(ctx.cwd, { now, activity: reader, surface: "widget" })
				.then((next) => {
					if (disposed) return;
					if (next === undefined) {
						stop();
						forgetJob(eventsPath);
						ctx.ui.setWidget("kpi", undefined);
						return;
					}
					narrate();
					if (next.paused !== current.paused) applyBoardTheme(ctx, next.paused);
					current = next;
					component.refresh(next);
					tui.requestRender();
				})
				.catch((error: unknown) => {
					const key = (error as NodeJS.ErrnoException | undefined)?.code ?? String(error);
					if (!warned.has(key) && warned.size < 8) {
						warned.add(key);
						ctx.ui.notify(`K-π board refresh failed: ${key}`, "warning");
					}
				})
				.finally(() => {
					busy = false;
				});
		}, BOARD_TICK_MS);
		return {
			...component,
			dispose() {
				disposed = true;
				stop();
				component.dispose();
			},
		};
	});
	return true;
}

/**
 * The loop `/kpi <goal>` or `/kpi <job>` detached from its command handler.
 * One per process: the handler returns as soon as the loop is started, which
 * is what frees `/kpi status`, `/kpi stop`, `/agents` and chat mid-run, and a
 * second goal is refused while this one runs. `controller` is the operator's
 * immediate stop; `done` settles once the outcome is on the record.
 */
interface LiveLoop {
	jobId: string;
	controller: AbortController;
	done: Promise<void>;
}

let live: LiveLoop | undefined;

/** Test seam: settles when the detached loop, if any, has recorded its outcome. */
export function liveLoopSettled(): Promise<void> {
	return live?.done ?? Promise.resolve();
}

/** Clears the handle once its loop has settled, unless a newer loop already replaced it. */
function releaseLive(controller: AbortController): void {
	if (live?.controller === controller) live = undefined;
}

/** The graph a job's node sessions were named by: its thread keys are the session directories. */
async function jobGraph(cwd: string, state: RunState): Promise<GraphDefinition> {
	return loadNamedGraph(
		cwd,
		stringValue(state.mode, "gated") === "autopilot" ? "coding-loop.auto" : "coding-loop.gated",
	);
}

/** One session message as the transcript shows it; entries the view has no row for are skipped. */
function transcriptEntry(entry: Record<string, unknown>): TranscriptEntry | undefined {
	const at = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
	if (entry.type !== "message" || !isJsonObject(entry.message)) {
		return undefined;
	}
	const message = entry.message;
	const text = (blocks: unknown): string =>
		typeof blocks === "string"
			? blocks
			: Array.isArray(blocks)
				? blocks
						.flatMap((block) =>
							isJsonObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
						)
						.join("\n")
				: "";
	if (message.role === "user") {
		return { ...(at === undefined ? {} : { at }), kind: "prompt", text: text(message.content) };
	}
	if (message.role === "toolResult") {
		const body = text(message.content);
		return {
			...(at === undefined ? {} : { at }),
			kind: message.isError === true ? "error" : "output",
			text: `${typeof message.toolName === "string" ? `${message.toolName}: ` : ""}${body}`,
		};
	}
	if (message.role !== "assistant") {
		return undefined;
	}
	const calls = Array.isArray(message.content)
		? message.content.flatMap((block) =>
				isJsonObject(block) && block.type === "toolCall" && typeof block.name === "string" ? [block.name] : [],
			)
		: [];
	const spoken = text(message.content);
	if (message.stopReason === "error" && typeof message.errorMessage === "string") {
		return { ...(at === undefined ? {} : { at }), kind: "error", text: message.errorMessage };
	}
	if (calls.length > 0 && spoken.length === 0) {
		return { ...(at === undefined ? {} : { at }), kind: "tool", text: calls.join(", ") };
	}
	return { ...(at === undefined ? {} : { at }), kind: "assistant", text: spoken };
}

/**
 * The newest `limit` entries of a node's session, oldest first, from the
 * latest JSONL file under `agents/<threadKey>/`. No directory or no file is
 * an empty transcript; an unreadable one throws with its code for the view.
 */
async function readNodeTranscript(runDirectory: string, threadKey: string, limit: number): Promise<TranscriptEntry[]> {
	// The engine's session directory name for a thread key.
	const directory = join(runDirectory, "agents", threadKey.replace(/[^a-zA-Z0-9._-]/gu, "-"));
	let names: string[];
	try {
		names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const latest = names.at(-1);
	if (latest === undefined) return [];
	const entries: TranscriptEntry[] = [];
	for (const line of (await readFile(join(directory, latest), "utf8")).split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// A line still being written is not part of the transcript yet.
			continue;
		}
		const entry = isJsonObject(parsed) ? transcriptEntry(parsed) : undefined;
		if (entry !== undefined) entries.push(entry);
	}
	return entries.slice(-limit);
}

/** One row per run file, as `stat` sees it right now. */
async function readRunFileRows(runDirectory: string): Promise<RunFileRow[]> {
	return Promise.all(
		RUN_FILE_NAMES.map(async (name): Promise<RunFileRow> => {
			try {
				const info = await stat(join(runDirectory, name));
				return {
					name,
					present: true,
					bytes: info.size,
					mtime: info.mtime.toISOString(),
					note: RUN_FILE_NOTES[name],
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return { name, present: false, note: RUN_FILE_NOTES[name] };
				}
				throw error;
			}
		}),
	);
}

const RUN_FILE_NOTES: Record<(typeof RUN_FILE_NAMES)[number], string> = {
	"task.json": "frozen contract",
	"context.md": "context pack",
	"candidate.json": "implementer's ladder decision",
	"evidence.json": "verifier receipts",
	"verdict.json": "isolated review",
	"events.jsonl": "chained event log",
};

/**
 * Everything the Command Centre reads and does, built from the control
 * plane's own pieces: the widget's model builder on the job's shared reader,
 * the node session files, the run files, the route snapshot, and exactly the
 * `/kpi stop` and `/kpi verify` paths.
 */
function commandCentreSources(
	ctx: ExtensionCommandContext,
	job: ActiveJob,
	reader: ActivityReader,
	dependencies: ControlPlaneDependencies,
): CommandCentreSources {
	const now = dependencies.now ?? Date.now;
	let graph: Promise<GraphDefinition> | undefined;
	const threadKeyFor = async (stage: number): Promise<string> => {
		const key = BOARD_STAGES[stage]?.key ?? String(stage);
		const nodeId = reader.last()?.stages[key]?.node ?? key;
		graph ??= jobGraph(ctx.cwd, job.state);
		const node = (await graph).nodes.find((candidate) => candidate.id === nodeId);
		return node?.type === "agent" ? (node.context.threadKey ?? node.id) : nodeId;
	};
	return {
		jobId: job.jobId,
		runDirectory: job.directory,
		workerCap: MAX_LIVE_WORKERS,
		// The job the centre opened on, re-read each tick: a `/kpi stop` from the
		// input line ends it, and the board must then read STOP STOPPED. Only a
		// different newest job (or a deleted run) is "no active job".
		readModel: async () => {
			const current = await readActiveJob(ctx.cwd);
			if (current === undefined || current.jobId !== job.jobId) return undefined;
			return buildBoardModel(ctx.cwd, { now, activity: reader, surface: "overlay", job: current });
		},
		activity: () => reader.last(),
		readNodeDetail: async (stage) => {
			const snapshot = reader.last();
			return snapshot === undefined
				? { node: BOARD_STAGES[stage]?.key ?? String(stage), status: "pending", runs: 0, toolsByName: {} }
				: readNodeDetail(job, snapshot, stage);
		},
		readTranscript: async (stage, limit) => readNodeTranscript(job.directory, await threadKeyFor(stage), limit),
		readRunFiles: () => readRunFileRows(job.directory),
		route: () => {
			const snapshot = getFooterRouteSnapshot();
			const usage = formatUsage(snapshot.remainingPercent, snapshot.slotKind);
			return snapshot.route === undefined ? "—" : `${snapshot.route}${usage === undefined ? "" : ` ${usage}`}`;
		},
		stop: () => stopJob(ctx, dependencies),
		verify: async () => {
			const report = await inspectChain(job.eventsPath);
			return report.ok
				? `events.jsonl verified: ${report.records} records chained for ${job.jobId}`
				: `events.jsonl FAILED verification at line ${report.line ?? 0}: ${report.reason ?? "unknown"} (${report.records} records verified before it)`;
		},
		chat: async (text) => {
			if (dependencies.sendUserMessage === undefined) {
				throw new Error("K-π chat is not available in this session");
			}
			dependencies.sendUserMessage(text);
		},
		now,
		tick: dependencies.tick ?? defaultTicker,
	};
}

async function showStatus(ctx: ExtensionCommandContext, dependencies: ControlPlaneDependencies): Promise<void> {
	const job = await readLiveJob(ctx.cwd);
	if (job === undefined) {
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

	// One read for the board shown by this command; the always-on widget keeps
	// ticking on the same reader, so this never re-parses the log or re-narrates
	// it. Only the interactive Command Centre carries the overlay surface: the
	// print/rpc notification is the plain board.
	const overlay = ctx.mode === "tui" && ctx.hasUI;
	const reader = activityReaderFor(job.eventsPath);
	const model = await buildBoardModel(ctx.cwd, {
		now: dependencies.now,
		activity: reader,
		...(overlay ? { surface: "overlay" as const } : {}),
	});
	if (model === undefined) {
		ctx.ui.setWidget("kpi", undefined);
		ctx.ui.notify("no active job", "info");
		return;
	}

	// `/kpi status` must not freeze the board: the widget is reinstalled with its
	// ticker (re-entrant), never replaced by a static component.
	await installWidget(ctx, dependencies);
	if (!overlay) {
		ctx.ui.notify(renderBoard(model).join("\n"), "info");
		return;
	}

	// The Command Centre: live on the same reader and tick as the widget behind
	// it, and usable while the detached loop runs.
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			createCommandCentre({
				palette: paletteFromTheme(theme),
				done,
				requestRender: () => tui.requestRender(),
				rows: () => tui.terminal.rows,
				sources: commandCentreSources(ctx, job, reader, dependencies),
			}),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
	);
}

/**
 * `/kpi stop` (C9). The marker goes down first, so a loop in another process
 * stops at its next superstep or wait. A loop live in this process is aborted
 * at once and records its own STOPPED terminal; otherwise the control plane
 * records it here. Either way the job is STOPPED and resumes with `/kpi <id>`.
 */
async function stopJob(ctx: ExtensionCommandContext, dependencies: ControlPlaneDependencies): Promise<void> {
	const handle = live;
	if (handle !== undefined) {
		// The marker goes into a run that exists; a loop still preparing its
		// contract sees the abort before it creates one and creates nothing.
		const runDirectory = join(ctx.cwd, CONFIG_DIR_NAME, "runs", handle.jobId);
		if (await isRunDirectory(ctx.cwd, handle.jobId)) {
			await writeStopMarker(runDirectory, false);
		}
		handle.controller.abort();
		await handle.done;
		ctx.ui.notify(
			(await isRunDirectory(ctx.cwd, handle.jobId))
				? `K-π job ${handle.jobId} STOPPED (resume with /kpi ${handle.jobId})`
				: `K-π job ${handle.jobId} stopped before its run was created; nothing to resume`,
			"info",
		);
		return;
	}
	const job = await readLiveJob(ctx.cwd);
	if (job === undefined) {
		ctx.ui.notify("no active job", "info");
		return;
	}
	await writeStopMarker(job.directory, true);
	await appendEvent(job.eventsPath, {
		ts: new Date().toISOString(),
		type: "loop.terminal",
		job_id: job.jobId,
		round: numberValue(job.state.round, 0),
		node: stringValue(job.state.node, "control-plane"),
		status: "STOPPED",
		reason: "operator stop",
	});
	const stoppedState: RunState = { ...job.state, status: "STOPPED", reason: "operator stop" };
	await atomicWrite(job.statePath, `${JSON.stringify(stoppedState, null, 2)}\n`);
	forgetJob(job.eventsPath);
	await installWidget(ctx, dependencies);
	ctx.ui.notify(`K-π job ${job.jobId} STOPPED (resume with /kpi ${job.jobId})`, "info");
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
	dependencies: ControlPlaneDependencies,
): Promise<void> {
	const command = args.trim();
	if (command === "" || command === "status") {
		await showStatus(ctx, dependencies);
		return;
	}
	if (command === "stop") {
		await stopJob(ctx, dependencies);
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

	if (live !== undefined) {
		ctx.ui.notify(`K-π job ${live.jobId} is still running: /kpi status shows it, /kpi stop stops it`, "warning");
		return;
	}
	// Only something shaped like a job id is probed as one. A goal is free
	// text, and turning it into a path is how a long message once died with
	// ENAMETOOLONG before the loop ever started.
	const resume = JOB_ID_PATTERN.test(command) && (await isRunDirectory(ctx.cwd, command));
	let invocation: LoopInvocation | undefined;
	if (!resume) {
		try {
			invocation = parseLoopInvocation(command);
		} catch (error) {
			ctx.ui.notify(`K-π loop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
	}
	const jobId = invocation === undefined ? command : (dependencies.jobId ?? makeJobId(invocation.goal));
	const controller = new AbortController();
	const loopDependencies: LoopDependencies = {
		...dependencies,
		jobId,
		signal: controller.signal,
		onStateChange: async () => {
			await installWidget(ctx, dependencies);
		},
	};
	// The loop runs detached: the handler returns once it is started, which is
	// what keeps `/kpi status`, `/kpi stop`, `/agents` and chat usable mid-run.
	// The captured ctx stays valid (it is marked stale only on a session
	// replacement), and every rejection is caught here: nothing is unhandled.
	const handle: LiveLoop = {
		jobId,
		controller,
		done: (async () => {
			let outcome: LoopOutcome | undefined;
			try {
				outcome =
					invocation === undefined
						? await resumeLoop(jobId, ctx, loopDependencies)
						: await runLoop(invocation, ctx, loopDependencies);
			} catch (error) {
				ctx.ui.notify(`K-π loop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				// The loop has settled: a new goal may start and a stop has nothing
				// to abort, whatever the outcome report goes on to ask.
				releaseLive(controller);
			}
			if (outcome !== undefined) {
				try {
					await reportOutcome(ctx, outcome);
				} catch (error) {
					ctx.ui.notify(`K-π loop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
			try {
				await installWidget(ctx, dependencies);
			} catch (error) {
				ctx.ui.notify(
					`K-π board refresh failed: ${(error as NodeJS.ErrnoException | undefined)?.code ?? String(error)}`,
					"warning",
				);
			}
		})(),
	};
	live = handle;
}

/** The outcome notice, and the provider recovery prompt an interactive session gets. */
async function reportOutcome(ctx: ExtensionCommandContext, outcome: LoopOutcome): Promise<void> {
	const reason = outcome.reason === undefined ? "" : `: ${outcome.reason}`;
	ctx.ui.notify(
		`K-π job ${outcome.jobId} ${outcome.status}${reason}`,
		outcome.status === "NEEDS_HUMAN" ? "warning" : "info",
	);
	if (outcome.status === "NEEDS_HUMAN" && ctx.hasUI && outcome.recovery === "provider") {
		const resumeAfterFix = await ctx.ui.confirm(
			"K-π provider recovery",
			`${outcome.reason ?? "The provider account is unavailable."}\n\nResolve the account or choose another model, then resume this job?`,
		);
		ctx.ui.notify(
			resumeAfterFix
				? `After resolving the provider, run /kpi ${outcome.jobId}`
				: `K-π job ${outcome.jobId} remains at NEEDS_HUMAN`,
			"info",
		);
	}
}

export function registerControlPlane(pi: ExtensionAPI, dependencies: ControlPlaneDependencies = {}): void {
	pi.on("session_start", async (_event, ctx) => {
		await installWidget(ctx, dependencies);
	});

	const command = {
		description: "Control the K-π coding loop: <goal>, status, stop, verify, auto|always|off routing",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleKpiCommand(args, ctx, {
				sendUserMessage: (text) => pi.sendUserMessage(text),
				...dependencies,
			});
		},
	};
	pi.registerCommand("kpi", command);
	pi.registerCommand("loop", command);
}
