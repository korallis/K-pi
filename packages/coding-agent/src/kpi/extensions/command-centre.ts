/**
 * The K-π Command Centre: `/kpi status` as a live full-screen overlay. Pure —
 * a view state becomes painted rows, the panel layout follows the width and
 * the terminal's row budget, and the key map names what a keystroke means.
 * No I/O: board-overlay.ts owns the sources, the ticker and the input line.
 */

import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

import type { EventRecord } from "./append-log.ts";
import {
	BOARD_STAGES,
	type BoardModel,
	formatCost,
	formatElapsed,
	type NodeDetail,
	type Row,
	RUN_FILE_NAMES,
	resolveCurrentStageIndex,
	type Span,
	type StageActivity,
	stageDetailForms,
	stageIndex,
	stopTone,
	type Tone,
	truncatePlain,
} from "./board.ts";
import type { ActivitySnapshot } from "./board-activity.ts";
import { type BoardPalette, sideBySide } from "./board-frame.ts";
import { MAX_LIVE_WORKERS } from "./bus/spawn.ts";

/** One line of a node session, as the transcript reader hands it to the view. */
export interface TranscriptEntry {
	at?: string;
	kind: "system" | "prompt" | "assistant" | "tool" | "output" | "error";
	text: string;
}

/** One of the six run files, as `stat` sees it. */
export interface RunFileRow {
	name: string;
	present: boolean;
	bytes?: number;
	mtime?: string;
	note: string;
}

export type CentreView = "home" | "session";

/** Everything the painter needs; the overlay mutates it between repaints. */
export interface CentreState {
	view: CentreView;
	selected: number;
	jobId: string;
	model: BoardModel | undefined;
	/** readModel() answered undefined: the job is gone. */
	jobGone: boolean;
	activity: ActivitySnapshot | undefined;
	transcript: readonly TranscriptEntry[];
	/** The transcript reader's failure code, painted in the LIVE/SESSION panel. */
	transcriptError: string | undefined;
	files: readonly RunFileRow[];
	detail: NodeDetail | undefined;
	route: string;
	input: string;
	/** A one-line answer on the hint row: a verify result, a refusal, a failure. */
	hint: { text: string; tone: Tone } | undefined;
	/** The last refresh's failure code, painted `EVENTS ✕ <code>` in the header. */
	refreshError: string | undefined;
	/** Advances once per tick; drives every spinner. */
	spinner: number;
	/** Cost per minute, oldest first, at most ten samples. */
	costRates: readonly number[];
	nowMs: number;
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPARK_LEVELS = " ⣀⣠⣤⣴⣶⣾⣿";
const LIT = "●";
const DARK = "○";
const LAST_STAGE = BOARD_STAGES.length - 1;

/** Below this many columns the home view stacks its panels in one column. */
export const COLUMNS_MIN_WIDTH = 120;
/** Below this many columns only STAGES, LIVE and EVENTS are painted. */
export const ESSENTIALS_MIN_WIDTH = 80;
/** The rows under the overlay left to the TUI's own status lines. */
const RESERVED_ROWS = 3;
const MIN_HEIGHT = 23;

const STAGES_FULL_HEIGHT = 20;
const STAGES_COMPACT_HEIGHT = 12;
const TELEMETRY_HEIGHT = 8;
const SHARED_HEIGHT = 10;
const CONTEXT_HEIGHT = 10;
const LIVE_STACKED_HEIGHT = 8;
const EVENTS_MIN_HEIGHT = 4;
const RAIL_WIDTH = 24;
const NODE_WIDTH = 31;
const NODE_STACKED_HEIGHT = 12;

export const HOME_PLACEHOLDERS = [
	"type a message, /kpi stop, /kpi verify  ·  enter on an empty line opens the selected stage",
	"type a message, /kpi stop, /kpi verify",
] as const;
export const SESSION_PLACEHOLDERS = [
	"ask about this node, or /kpi stop  ·  esc back to command",
	"ask about this node, or /kpi stop",
] as const;
export const HOME_KEY_HINT = "tab/↑↓ select stage · enter open · esc close · r refresh";
export const SESSION_KEY_HINT = "esc back · ← → node · r refresh";
const STAGES_KEY_HINT = "tab/↑↓ select  ·  enter stream session  ·  1-8 jump";

export function spinner(frame: number): string {
	return SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}

// ---------------------------------------------------------------------------
// Keys

export type CentreKey =
	| { kind: "next" }
	| { kind: "previous" }
	| { kind: "jump"; stage: number }
	| { kind: "enter" }
	| { kind: "escape" }
	| { kind: "close" }
	| { kind: "refresh" }
	| { kind: "backspace" }
	| { kind: "type"; text: string };

/** Printable input: no control bytes, no escape sequences. */
function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	for (const character of data) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/**
 * What a keystroke means. `q`, `r` and `1`–`8` are commands only while the
 * prompt is empty; once the operator is typing they are text like any other.
 */
export function resolveKey(data: string, hasInput: boolean): CentreKey | undefined {
	if (matchesKey(data, "ctrl+c")) return { kind: "close" };
	if (matchesKey(data, "escape")) return { kind: "escape" };
	if (matchesKey(data, "shift+tab") || matchesKey(data, "up") || matchesKey(data, "left")) return { kind: "previous" };
	if (matchesKey(data, "tab") || matchesKey(data, "down") || matchesKey(data, "right")) return { kind: "next" };
	if (matchesKey(data, "return") || matchesKey(data, "enter")) return { kind: "enter" };
	if (matchesKey(data, "backspace")) return { kind: "backspace" };
	if (!hasInput) {
		if (data === "q") return { kind: "close" };
		if (data === "r") return { kind: "refresh" };
		if (/^[1-8]$/u.test(data)) return { kind: "jump", stage: Number(data) - 1 };
	}
	return isPrintable(data) ? { kind: "type", text: data } : undefined;
}

// ---------------------------------------------------------------------------
// Text helpers

function padRight(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? text + " ".repeat(missing) : text;
}

function padLeft(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? " ".repeat(missing) + text : text;
}

function rowWidth(row: Row): number {
	let total = 0;
	for (const span of row) total += visibleWidth(span.text);
	return total;
}

/** The spans that fit in `width`, the last one cut with an ellipsis. */
function cutRow(row: Row, width: number): Row {
	const out: Row = [];
	let used = 0;
	for (const span of row) {
		const span_width = visibleWidth(span.text);
		if (used + span_width <= width) {
			out.push(span);
			used += span_width;
			continue;
		}
		const room = width - used;
		if (room > 0) out.push({ ...span, text: truncatePlain(span.text, room) });
		return out;
	}
	return out;
}

/** A row cut to `width`, padded to `width`, painted span by span. */
function paintRow(row: Row, width: number, palette: BoardPalette): string {
	const fitted = cutRow(row, width);
	const painted = fitted.map((span) => palette.paint(span.tone ?? "text", span.text)).join("");
	return painted + " ".repeat(Math.max(0, width - rowWidth(fitted)));
}

function text(value: string, tone: Tone = "text"): Span {
	return { text: value, tone };
}

function kv(key: string, keyWidth: number, value: Row): Row {
	return [text(padRight(key, keyWidth), "muted"), ...value];
}

function clock(nowMs: number): string {
	const date = new Date(nowMs);
	const two = (value: number) => String(value).padStart(2, "0");
	return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function clockOf(iso: string | undefined): string {
	if (iso === undefined) return "—";
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? "—" : clock(ms);
}

function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined) return "—";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** `20260903-add-get-…-ae4a7049`: a job id that keeps its date and its suffix. */
function shortJob(jobId: string): string {
	if (jobId.length <= 30) return jobId;
	return `${jobId.slice(0, 16)}…${jobId.slice(-9)}`;
}

function sparkline(values: readonly number[]): string {
	if (values.length === 0) return "";
	const peak = Math.max(...values, 0);
	return values
		.map((value) => {
			const level = peak <= 0 ? 0 : Math.round((value / peak) * (SPARK_LEVELS.length - 1));
			return SPARK_LEVELS[Math.max(0, Math.min(SPARK_LEVELS.length - 1, level))] ?? " ";
		})
		.join("");
}

// ---------------------------------------------------------------------------
// Panels

interface Panel {
	title: string;
	right?: string;
	rows: readonly Row[];
	height: number;
	accent?: boolean;
}

/**
 * A titled box, `height` lines exactly, every line exactly `width` wide. The
 * title sits in the top border; the right title gives way before the title.
 */
function box(panel: Panel, width: number, palette: BoardPalette): string[] {
	const tone: Tone = panel.accent === true ? "borderAccent" : "border";
	const inner = Math.max(1, width - 4);
	const lines: string[] = [];
	const title = truncatePlain(panel.title, Math.max(1, width - 6));
	const left = `┌─ ${title} `;
	let right = panel.right === undefined ? "" : ` ${panel.right} ──`;
	if (visibleWidth(left) + visibleWidth(right) + 1 > width) right = "";
	const fill = "─".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right) - 1));
	lines.push(
		palette.paint(tone, "┌─ ") +
			palette.paint("accent", title) +
			palette.paint(tone, ` ${fill}`) +
			(right === "" ? "" : palette.paint("dim", ` ${panel.right}`) + palette.paint(tone, " ──")) +
			palette.paint(tone, "┐"),
	);
	const bar = palette.paint(tone, "│");
	const body = Math.max(0, panel.height - 2);
	for (let index = 0; index < body; index += 1) {
		lines.push(`${bar} ${paintRow(panel.rows[index] ?? [], inner, palette)} ${bar}`);
	}
	lines.push(palette.paint(tone, `└${"─".repeat(width - 2)}┘`));
	return lines;
}

/** Rows stacked to exactly `height` lines. */
function stack(blocks: readonly string[][], height: number, width: number): string[] {
	const out = blocks.flat().slice(0, height);
	while (out.length < height) out.push(" ".repeat(width));
	return out;
}

// ---------------------------------------------------------------------------
// Stage facts

type StageStatus = "done" | "running" | "pending" | "failed" | "waiting";

function stageStatus(index: number, model: BoardModel, current: number): StageStatus {
	const record = model.activity?.[BOARD_STAGES[index]?.key ?? ""];
	if (index === current && model.paused) return "waiting";
	if (record !== undefined) {
		if (record.status === "running") return "running";
		if (record.status === "completed") return "done";
		if (record.status === "failed") return "failed";
	}
	if (index < current) return "done";
	if (index === current) return model.stop === "RUNNING" ? "running" : "pending";
	return "pending";
}

function statusGlyph(status: StageStatus, frame: number): string {
	switch (status) {
		case "done":
			return "✓";
		case "running":
			return spinner(frame);
		case "failed":
			return "✕";
		case "waiting":
			return "◉";
		case "pending":
			return DARK;
	}
}

function statusWord(status: StageStatus): string {
	switch (status) {
		case "done":
			return "DONE";
		case "running":
			return "RUNNING";
		case "failed":
			return "FAILED";
		case "waiting":
			return "WAITING";
		case "pending":
			return "PENDING";
	}
}

function statusTone(status: StageStatus): Tone {
	switch (status) {
		case "done":
			return "success";
		case "running":
			return "accent";
		case "failed":
			return "error";
		case "waiting":
			return "accent";
		case "pending":
			return "dim";
	}
}

/** The stage's second line: what board.ts already says for DONE/CURRENT/PENDING, or the failure. */
function stageDetail(status: StageStatus, record: StageActivity | undefined, width: number): string {
	if (status === "failed" && record?.error !== undefined) return truncatePlain(`✕ ${record.error}`, width);
	const form = status === "done" ? "DONE" : status === "running" || status === "waiting" ? "CURRENT" : "PENDING";
	const forms = stageDetailForms(form, record);
	return forms.find((candidate) => visibleWidth(candidate) <= width) ?? truncatePlain(forms.at(-1) ?? "—", width);
}

function currentStage(model: BoardModel): number {
	return resolveCurrentStageIndex(model.stage, model.node);
}

// ---------------------------------------------------------------------------
// Event facts

function stringField(record: EventRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: EventRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordMs(record: EventRecord): number | undefined {
	const ms = Date.parse(record.ts);
	return Number.isNaN(ms) ? undefined : ms;
}

const BASE_FIELDS: Record<string, true> = {
	ts: true,
	type: true,
	job_id: true,
	round: true,
	node: true,
	prev_hash: true,
	record_hash: true,
};

/** One line for an events.jsonl record: the fields an operator reads it by. */
export function eventSummary(record: EventRecord): { text: string; tone: Tone } {
	switch (record.type) {
		case "node.started": {
			const run = numberField(record, "run");
			const model = stringField(record, "model");
			return {
				text: `${record.node}${run === undefined ? "" : ` run ${run}`}${model === undefined ? "" : ` · ${model}`}`,
				tone: "text",
			};
		}
		case "node.finished": {
			const failed = record.status === "failed";
			const elapsed = formatElapsed(numberField(record, "elapsed_ms") ?? 0);
			const cost = numberField(record, "cost_usd");
			const error = stringField(record, "error");
			return {
				text: `${record.node} ${failed ? "failed" : "done"} · ${elapsed}${cost === undefined ? "" : ` · ${formatCost(cost)}`}${
					failed && error !== undefined ? ` · ${error}` : ""
				}`,
				tone: failed ? "error" : "success",
			};
		}
		case "node.retry": {
			const attempt = numberField(record, "attempt") ?? 1;
			const reason = stringField(record, "reason") ?? "transient";
			const seconds = Math.ceil((numberField(record, "delay_ms") ?? 0) / 1000);
			return { text: `${record.node} retry ${attempt} · ${reason} · next ${seconds}s`, tone: "warning" };
		}
		case "tool.request": {
			const tool = stringField(record, "tool") ?? "?";
			const path = stringField(record, "path");
			const decision = stringField(record, "decision");
			const denied = decision === "deny";
			return {
				text: `${record.node} ${tool}${path === undefined ? "" : ` ${path}`}${denied ? " denied" : ""}`,
				tone: denied ? "warning" : "text",
			};
		}
		case "checkpoint":
			return { text: stringField(record, "detail") ?? `superstep checkpoint · ${record.node}`, tone: "muted" };
		case "loop.terminal": {
			const status = stringField(record, "status") ?? "?";
			const reason = stringField(record, "reason");
			const recovery = stringField(record, "recovery");
			return {
				text: `${status}${recovery === undefined ? "" : ` ${recovery}`}${reason === undefined ? "" : ` · ${reason}`}`,
				tone: status === "DONE" ? "success" : status === "STOPPED" ? "error" : "accent",
			};
		}
		case "review.verdict": {
			const status = stringField(record, "status") ?? "?";
			const blocking = numberField(record, "blocking_count") ?? 0;
			return { text: `${status} · ${blocking} blocking`, tone: status === "PASS" ? "success" : "warning" };
		}
		case "approval.result": {
			const approved = record.approved === true;
			const feedback = stringField(record, "feedback");
			return {
				text: `${approved ? "approved" : "denied"}${feedback === undefined ? "" : ` · ${feedback}`}`,
				tone: approved ? "success" : "warning",
			};
		}
		case "accounts.failover":
			return {
				text: `${stringField(record, "from") ?? "?"} → ${stringField(record, "to") ?? "?"}`,
				tone: "warning",
			};
		default: {
			const parts: string[] = [`r${record.round} node=${record.node}`];
			for (const [key, value] of Object.entries(record)) {
				if (BASE_FIELDS[key] === true || parts.length > 4) continue;
				if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
					parts.push(`${key}=${String(value)}`);
				}
			}
			return { text: parts.join(" "), tone: "text" };
		}
	}
}

interface RoundSpan {
	round: number;
	startMs: number;
	endMs: number;
	running: boolean;
}

/** Each round's wall time from its first node.started to its last node.finished. */
function roundSpans(records: readonly EventRecord[], nowMs: number): RoundSpan[] {
	const byRound = new Map<number, RoundSpan & { open: number }>();
	for (const record of records) {
		if (record.type !== "node.started" && record.type !== "node.finished") continue;
		const ms = recordMs(record);
		if (ms === undefined) continue;
		const entry = byRound.get(record.round) ?? {
			round: record.round,
			startMs: ms,
			endMs: ms,
			running: false,
			open: 0,
		};
		if (record.type === "node.started") {
			entry.open += 1;
			entry.startMs = Math.min(entry.startMs, ms);
		} else {
			entry.open = Math.max(0, entry.open - 1);
			entry.endMs = Math.max(entry.endMs, ms);
		}
		byRound.set(record.round, entry);
	}
	return [...byRound.values()]
		.sort((left, right) => left.round - right.round)
		.map(({ round, startMs, endMs, open }) => ({
			round,
			startMs,
			endMs: open > 0 ? Math.max(endMs, nowMs) : endMs,
			running: open > 0,
		}));
}

/** The run's wall time: first record → now while it runs, → last record once it ended. */
function runElapsed(state: CentreState): string {
	const records = state.activity?.records ?? [];
	const first = records[0] === undefined ? undefined : recordMs(records[0]);
	if (first === undefined) return "—";
	const last = records.at(-1);
	const lastMs = last === undefined ? undefined : recordMs(last);
	const end = state.model?.stop === "RUNNING" ? state.nowMs : (lastMs ?? state.nowMs);
	return formatElapsed(end - first);
}

function totalCost(model: BoardModel | undefined): number | undefined {
	let total: number | undefined;
	for (const record of Object.values(model?.activity ?? {})) {
		if (record.costUsd !== undefined) total = (total ?? 0) + record.costUsd;
	}
	return total;
}

function stopText(model: BoardModel): string {
	return model.stop === "NEEDS_HUMAN" && model.recovery !== undefined ? `NEEDS_HUMAN ${model.recovery}` : model.stop;
}

// ---------------------------------------------------------------------------
// Header

/** Brand and crumbs; `tight` drops the double spacing a narrow terminal cannot afford. */
function brand(crumbs: readonly string[], tight: boolean): Row {
	const gap = tight ? " " : "  ";
	const row: Row = [text("K-π", "accent"), text(`${gap}COMMAND`, "accent")];
	for (const crumb of crumbs) row.push(text(`${gap}› `, "dim"), text(crumb, "text"));
	return row;
}

/**
 * The header row: brand and crumbs left, the run's state right. The job id
 * shortens and the clock, then GATE, go before MODE/ROUND/STOP ever would;
 * a terminal too narrow for one row gets two.
 */
function header(
	state: CentreState,
	width: number,
	palette: BoardPalette,
	crumbs: readonly string[],
	right: Row[],
): string[] {
	const jobId = state.jobId;
	const jobForms = [jobId, shortJob(jobId), jobId.length <= 17 ? jobId : `${jobId.slice(0, 8)}…${jobId.slice(-8)}`];
	for (const tight of [false, true]) {
		for (const job of jobForms) {
			for (const candidate of right) {
				const left = brand([job, ...crumbs], tight);
				const gap = width - rowWidth(left) - rowWidth(candidate);
				if (gap >= 3) {
					const line = paintRow([...left, text(" ".repeat(gap)), ...candidate], width, palette);
					return [line, palette.paint("border", "═".repeat(width))];
				}
			}
		}
	}
	const forms = [false, true].flatMap((tight) => jobForms.map((job) => brand([job, ...crumbs], tight)));
	const left = forms.find((candidate) => rowWidth(candidate) <= width) ?? forms.at(-1) ?? [];
	return [
		paintRow(left, width, palette),
		paintRow(right.at(-1) ?? [], width, palette),
		palette.paint("border", "═".repeat(width)),
	];
}

/** The home header's right side, longest form first. */
function homeHeaderRight(state: CentreState): Row[] {
	const model = state.model;
	if (state.jobGone) return [[text("K-π no active job", "error")]];
	if (model === undefined) return [[text("K-π reading run files", "dim")]];
	const sep = text("  ·  ", "dim");
	const stop: Row = [text("STOP ", "muted"), text(stopText(model), stopTone(model.stop))];
	if (model.stop === "RUNNING") stop.push(text(` ${spinner(state.spinner)} ${runElapsed(state)}`, "accent"));
	else stop.push(text(` ${runElapsed(state)}`, "muted"));
	const problem: Row = state.refreshError === undefined ? [] : [sep, text(`EVENTS ✕ ${state.refreshError}`, "error")];
	const mode: Row = [text("MODE ", "muted"), text(model.mode)];
	const round: Row = [text("ROUND ", "muted"), text(String(model.round))];
	const gate: Row = [text("GATE ", "muted"), text(model.gate ?? (model.paused ? "human" : "machine"))];
	const clockRow: Row = [text(clock(state.nowMs), "muted")];
	return [
		[...mode, sep, ...round, sep, ...gate, sep, ...stop, ...problem, sep, ...clockRow],
		[...mode, sep, ...round, sep, ...gate, sep, ...stop, ...problem],
		[...mode, sep, ...round, sep, ...stop, ...problem],
	];
}

// ---------------------------------------------------------------------------
// Home panels

function stagesPanel(state: CentreState, model: BoardModel, height: number, width: number): Panel {
	const inner = width - 4;
	const current = currentStage(model);
	const compact = height < STAGES_FULL_HEIGHT;
	const rows: Row[] = [];
	BOARD_STAGES.forEach((stage, index) => {
		const status = stageStatus(index, model, current);
		const record = model.activity?.[stage.key];
		const selected = index === state.selected;
		const elapsed = record?.elapsedMs === undefined ? "—" : formatElapsed(record.elapsedMs);
		const head: Row = [
			text(selected ? "▸ " : "  ", "accent"),
			text(padRight(`${stage.id} ${stage.label}`, 16), selected ? "accent" : "text"),
			text(padRight(`${statusGlyph(status, state.spinner)} ${statusWord(status)}`, 11), statusTone(status)),
		];
		const used = rowWidth(head);
		head.push(text(padLeft(elapsed, Math.max(0, inner - used)), status === "running" ? "accent" : "muted"));
		rows.push(head);
		if (!compact) {
			rows.push([
				text("    "),
				text(stageDetail(status, record, Math.max(1, inner - 4)), status === "pending" ? "dim" : "muted"),
			]);
		}
	});
	rows.push([], [text(STAGES_KEY_HINT, "dim")]);
	return { title: "STAGES 01–08", right: "node · status · elapsed", rows, height };
}

function transcriptRow(entry: TranscriptEntry): Row {
	const tone: Tone =
		entry.kind === "tool"
			? "text"
			: entry.kind === "output"
				? "muted"
				: entry.kind === "error"
					? "error"
					: entry.kind === "system"
						? "dim"
						: entry.kind === "prompt"
							? "accent"
							: "text";
	return [text(padRight(entry.kind, 10), entry.kind === "tool" ? "accent" : "dim"), text(entry.text, tone)];
}

function livePanel(state: CentreState, model: BoardModel, height: number): Panel {
	const stage = BOARD_STAGES[state.selected] ?? BOARD_STAGES[0];
	const status = stageStatus(state.selected, model, currentStage(model));
	const running = status === "running";
	const body = Math.max(0, height - 2);
	const rows: Row[] = [];
	if (state.transcriptError !== undefined) {
		rows.push([text(`✕ session unreadable · ${state.transcriptError}`, "error")]);
	} else if (state.transcript.length === 0) {
		rows.push([text(status === "pending" ? "not started" : "no session entries yet", "dim")]);
	} else {
		const keep = running && state.transcript.length < body ? body - 1 : body;
		for (const entry of state.transcript.slice(-keep)) rows.push(transcriptRow(entry));
	}
	if (running && rows.length < body) {
		rows.push([text(`${spinner(state.spinner)} live · following agents/${stage.key}/*.jsonl`, "accent")]);
	}
	return {
		title: `LIVE › ${stage.id} ${stage.label}`,
		right: `agents/${stage.key}/*.jsonl · ${state.transcript.length} entries`,
		rows,
		height,
		accent: running,
	};
}

/** `RETRY <attempt> · <reason> · next <s>s` — the wait the operator is looking at. */
function retryText(retry: NonNullable<BoardModel["retry"]>): string {
	return `RETRY ${retry.attempt} · ${retry.reason} · next ${Math.ceil(retry.delayMs / 1000)}s`;
}

function roundsRow(state: CentreState): Row {
	const spans = roundSpans(state.activity?.records ?? [], state.nowMs);
	if (spans.length === 0) return [text("—", "dim")];
	const longest = Math.max(...spans.map((span) => span.endMs - span.startMs), 1);
	const row: Row = [];
	for (const span of spans) {
		const elapsed = span.endMs - span.startMs;
		const bars = Math.max(1, Math.round((elapsed / longest) * 6));
		const bar = "━".repeat(bars) + (span.running ? spinner(state.spinner) : "");
		if (row.length > 0) row.push(text("   "));
		row.push(text(`r${span.round} ${bar} ${formatElapsed(elapsed)}`, span.running ? "accent" : "success"));
	}
	return row;
}

export function telemetryRows(state: CentreState, model: BoardModel): Row[] {
	const cost = totalCost(model);
	const rate = state.costRates.at(-1);
	const costRow: Row = [text(`${formatCost(cost)} est.`, "warning")];
	if (rate !== undefined) costRow.push(text(`  +${formatCost(Math.max(0, rate))}/min`, "muted"));
	if (state.costRates.length > 0) costRow.push(text(`  ${sparkline(state.costRates)}`, "warning"));
	const nodeRuns = (state.activity?.records ?? []).filter((record) => record.type === "node.started").length;
	const steps = model.superstep ?? nodeRuns;
	const workers = model.sessions?.workers ?? 0;
	const stepsRow: Row = [
		text(String(steps)),
		text(`   NODE RUNS ${nodeRuns}   WORKERS ${workers}/${MAX_LIVE_WORKERS}`, "muted"),
	];
	if (model.retry !== undefined) stepsRow.push(text(`   ${retryText(model.retry)}`, "warning"));
	return [
		kv("COST", 9, costRow),
		kv("CONTEXT", 9, [text("—", "dim")]),
		kv("TOKENS", 9, [text("—", "dim")]),
		kv("TIME", 9, [text(runElapsed(state))]),
		kv("ROUNDS", 9, roundsRow(state)),
		kv("STEPS", 9, stepsRow),
	];
}

function sharedPanel(state: CentreState, model: BoardModel, height: number, width: number): Panel {
	const inner = width - 4;
	const rows: Row[] = [];
	const files =
		state.files.length > 0
			? state.files
			: RUN_FILE_NAMES.map((name): RunFileRow => ({ name, present: model.fileLit[name] === true, note: "" }));
	for (const file of files) {
		const lamp = file.present ? LIT : DARK;
		const head = `${padRight(file.name, 16)}${padLeft(file.present ? formatBytes(file.bytes) : "—", 6)}  ${padRight(
			file.present ? clockOf(file.mtime) : "—",
			9,
		)} `;
		rows.push([
			text(`${lamp} `, file.present ? "accent" : "dim"),
			text(head, file.present ? "text" : "dim"),
			text(truncatePlain(file.note, Math.max(1, inner - 2 - visibleWidth(head))), file.present ? "muted" : "dim"),
		]);
	}
	rows.push([]);
	const footer: string[] = [];
	if (model.fingerprint !== undefined) footer.push(`FINGERPRINT ${model.fingerprint.slice(0, 12)}`);
	footer.push(`ROUND ${model.round}`);
	if (model.verifier !== undefined && model.verifier !== "pending")
		footer.push(`VERIFIER ${model.verifier.toUpperCase()}`);
	rows.push([text(footer.join("  ·  "), "muted")]);
	return { title: "SHARED RUN STATE", right: `.kpi/runs/${shortJob(model.jobId)}`, rows, height };
}

function nextStages(index: number, count: number): string[] {
	return BOARD_STAGES.slice(index + 1, index + 1 + count).map((stage) => stage.label);
}

function contextPanel(state: CentreState, model: BoardModel, height: number): Panel {
	const pack = model.contextPack;
	const lamp = (name: string, lit: boolean): Span => text(`${name} ${lit ? LIT : DARK}`, lit ? "text" : "dim");
	const current = currentStage(model);
	const research: Row =
		model.research === undefined
			? [text("—", "dim")]
			: [
					text(model.research.cell.replace(/^RESEARCH\s+/u, "")),
					...(model.research.struck === undefined ? [] : [text(`  ${model.research.struck}`, "error")]),
				];
	const kstack: Row =
		model.kstack === undefined
			? [text(model.kModeEnabled === true ? "K-mode on · no playbook frozen" : "—", "dim")]
			: [
					text(`${model.kstack.playbook} · ${model.kstack.todos.length} steps`),
					...(model.kstack.todos[0] === undefined ? [] : [text(` · ${model.kstack.todos[0]}`, "muted")]),
				];
	const agents: Row = [
		text(`${model.agents} live`),
		text(" · "),
		text(`BUS ${model.busLit ? LIT : DARK}`, model.busLit ? "text" : "dim"),
		...(model.sessions === undefined
			? []
			: [text(` · workers ${model.sessions.workers}/${MAX_LIVE_WORKERS} · nodes ${model.sessions.nodes}`, "muted")]),
	];
	const gate: Row = model.paused
		? [
				text("human · waiting on the operator", "accent"),
				...(model.pendingQuestion === undefined ? [] : [text(` · ${model.pendingQuestion}`, "text")]),
			]
		: model.mode === "autopilot"
			? [text("machine · autopilot · commits after green receipts bound to HEAD")]
			: [text(`${model.gate ?? "machine"} · next human gate after 07 review`)];
	const next = nextStages(current, 1)[0];
	const graph: Row = [
		text(`round ${model.round}`),
		...(model.superstep === undefined ? [] : [text(` · superstep ${model.superstep}`)]),
		text(
			next === undefined
				? ` · ${BOARD_STAGES[current]?.label ?? model.node} is the last stage`
				: ` · next edge ${BOARD_STAGES[current]?.label ?? model.node} → ${next}`,
			"muted",
		),
	];
	return {
		title: "CONTEXT LAYER",
		right: "research.json · accounts.json",
		rows: [
			kv("PACK", 10, [
				lamp("product", pack.product),
				text("  "),
				lamp("structure", pack.structure),
				text("  "),
				lamp("tech", pack.tech),
			]),
			kv("RESEARCH", 10, research),
			kv("K-STACK", 10, kstack),
			kv("AGENTS", 10, agents),
			kv("ROUTE", 10, [text(state.route)]),
			kv("POLICY", 10, [
				text(model.mode),
				text(
					model.mode === "autopilot"
						? " · unknown commands denied · commit after release"
						: " · unknown commands and commits ask the operator",
					"muted",
				),
			]),
			kv("GATE", 10, gate),
			kv("GRAPH", 10, graph),
		],
		height,
	};
}

function eventsPanel(state: CentreState, model: BoardModel, height: number): Panel {
	const records = state.activity?.records ?? [];
	const body = Math.max(0, height - 2);
	const current = currentStage(model);
	const currentKey = BOARD_STAGES[current]?.key;
	const running =
		model.stop === "RUNNING" && currentKey !== undefined && model.activity?.[currentKey]?.status === "running";
	const currentNode = currentKey === undefined ? undefined : model.activity?.[currentKey]?.node;
	let live: Row | undefined;
	if (running && currentNode !== undefined) {
		const last = [...records]
			.reverse()
			.find((record) => record.type === "tool.request" && record.node === currentNode);
		if (last !== undefined) {
			const since = recordMs(last);
			live = [
				text("▸ ", "accent"),
				text(padRight("live", 8), "accent"),
				text(`  ${padRight(last.type, 19)} `),
				text(eventSummary(last).text),
				text(
					`  ${spinner(state.spinner)} ${since === undefined ? "" : formatElapsed(state.nowMs - since)}`,
					"accent",
				),
			];
		}
	}
	const keep = Math.max(0, body - (live === undefined ? 0 : 1));
	const rows: Row[] = records.slice(-keep).map((record) => {
		const summary = eventSummary(record);
		return [
			text(clockOf(record.ts), "dim"),
			text(`  ${padRight(record.type, 19)} `, summary.tone === "muted" ? "muted" : "text"),
			text(summary.text, summary.tone),
		];
	});
	if (live !== undefined) rows.push(live);
	if (rows.length === 0) rows.push([text("no records yet", "dim")]);
	const right: string[] = [`${records.length} records`];
	if (model.eventsUnreadable !== undefined && model.eventsUnreadable > 0)
		right.push(`✕ ${model.eventsUnreadable} unreadable`);
	if (model.eventsError !== undefined) right.push(`✕ ${model.eventsError}`);
	if (model.stop === "RUNNING") right.push("following");
	return { title: "EVENTS · events.jsonl", right: right.join(" · "), rows, height };
}

/**
 * The graph walked so far: ━━▶ behind done stages, ╌╌▶ ahead, the current
 * stage boxed, the loops named. A narrow terminal gets the loops dropped,
 * then the connectors shortened, before any stage name is cut.
 */
export function pathRow(state: CentreState, model: BoardModel, width: number): Row {
	const current = currentStage(model);
	const walk = (tier: 0 | 1 | 2): Row => {
		const row: Row = [text(tier === 0 ? "PATH  " : "PATH ", "muted")];
		BOARD_STAGES.forEach((stage, index) => {
			const status = stageStatus(index, model, current);
			if (index > 0) {
				const done = stageStatus(index - 1, model, current) === "done";
				const arrow =
					tier === 0 ? (done ? " ━━▶ " : " ╌╌▶ ") : tier === 1 ? (done ? " ━▶ " : " ╌▶ ") : done ? "━▶" : "╌▶";
				row.push(text(arrow, done ? "success" : "dim"));
			}
			const glyph = statusGlyph(status, state.spinner);
			if (index === current) {
				row.push(text(tier === 0 ? `[ ${stage.label} ${glyph} ]` : `[${stage.label} ${glyph}]`, "accent"));
			} else {
				row.push(text(stage.label, status === "done" ? "success" : status === "failed" ? "error" : "dim"));
			}
		});
		return row;
	};
	const loops: string[] = [];
	const records = state.activity?.records ?? [];
	const retries = records.filter((record) => record.type === "node.retry").length;
	if (retries > 0) loops.push(`RETRY ×${retries}`);
	if (records.some((record) => record.type === "review.verdict" && record.status === "REVISE"))
		loops.push("REVISE review → implement");
	if (
		records.some(
			(record) => record.type === "node.finished" && record.status === "failed" && stageIndex(record.node) === 4,
		)
	) {
		loops.push("test ✕ → implement");
	}
	const full = walk(0);
	if (loops.length > 0) {
		const loopSpan = text(`    loops: ${loops.join(" · ")}`, "dim");
		if (rowWidth(full) + visibleWidth(loopSpan.text) <= width) return [...full, loopSpan];
	}
	if (rowWidth(full) <= width) return full;
	const spaced = walk(1);
	return rowWidth(spaced) <= width ? spaced : walk(2);
}

// ---------------------------------------------------------------------------
// Session panels

function railPanel(state: CentreState, model: BoardModel, height: number, width: number): Panel {
	const inner = width - 4;
	const current = currentStage(model);
	const rows: Row[] = BOARD_STAGES.map((stage, index) => {
		const status = stageStatus(index, model, current);
		const selected = index === state.selected;
		const head: Row = [
			text(selected ? "▸ " : "  ", "accent"),
			text(padRight(`${stage.id} ${stage.label}`, 14), selected ? "accent" : "text"),
		];
		head.push(
			text(padLeft(statusGlyph(status, state.spinner), Math.max(1, inner - rowWidth(head))), statusTone(status)),
		);
		return head;
	});
	rows.push([], [text("← → switch node", "dim")], [text("esc  back", "dim")], []);
	rows.push([text(`ROUND ${model.round}`)], [text(`GATE ${model.gate ?? (model.paused ? "human" : "machine")}`)]);
	rows.push(
		[text(`STOP ${stopText(model)}`, stopTone(model.stop))],
		[text(`${runElapsed(state)} elapsed`, "muted")],
		[],
	);
	rows.push([text("FILES", "muted")]);
	for (const name of RUN_FILE_NAMES) {
		const lit = model.fileLit[name] === true;
		rows.push([text(`${lit ? LIT : DARK} ${name}`, lit ? "accent" : "dim")]);
	}
	return { title: "STAGES", rows, height };
}

/** A transcript entry wrapped to `width`, continuation lines indented under the text. */
function wrapEntry(entry: TranscriptEntry, width: number): Row[] {
	const label = padRight(entry.kind, 10);
	const room = Math.max(8, width - 10);
	const [first] = transcriptRow(entry);
	const tone = transcriptRow(entry)[1]?.tone ?? "text";
	const lines: string[] = [];
	let currentLine = "";
	for (const word of entry.text.split(/\s+/u).filter((part) => part.length > 0)) {
		const candidate = currentLine.length === 0 ? word : `${currentLine} ${word}`;
		if (currentLine.length > 0 && visibleWidth(candidate) > room) {
			lines.push(currentLine);
			currentLine = word;
			continue;
		}
		currentLine = candidate;
	}
	if (currentLine.length > 0) lines.push(currentLine);
	if (lines.length === 0) lines.push("");
	return lines.map((line, index) => [
		index === 0 ? (first ?? text(label, "dim")) : text(" ".repeat(10)),
		text(visibleWidth(line) > room ? truncatePlain(line, room) : line, tone),
	]);
}

function sessionPanel(state: CentreState, model: BoardModel, height: number, width: number): Panel {
	const stage = BOARD_STAGES[state.selected] ?? BOARD_STAGES[0];
	const status = stageStatus(state.selected, model, currentStage(model));
	const running = status === "running";
	const body = Math.max(0, height - 2);
	const inner = width - 4;
	let rows: Row[] = [];
	if (state.transcriptError !== undefined) {
		rows.push([text(`✕ session unreadable · ${state.transcriptError}`, "error")]);
	} else if (state.transcript.length === 0) {
		rows.push([text(status === "pending" ? "not started" : "no session entries yet", "dim")]);
	} else {
		for (const entry of state.transcript) rows.push(...wrapEntry(entry, inner));
		rows = rows.slice(-(running ? body - 1 : body));
	}
	if (running && rows.length < body)
		rows.push([text(`${spinner(state.spinner)} live · following agents/${stage.key}/*.jsonl`, "accent")]);
	const record = model.activity?.[stage.key];
	const elapsed = record?.elapsedMs === undefined ? undefined : formatElapsed(record.elapsedMs);
	const right = running
		? `following · ${elapsed ?? "—"}`
		: status === "done"
			? `finished in ${elapsed ?? "—"} · replaying`
			: status === "failed"
				? `failed after ${elapsed ?? "—"}`
				: status === "waiting"
					? "waiting on the operator"
					: "pending";
	return { title: `SESSION › ${stage.id} ${stage.label}`, right, rows, height, accent: running };
}

function topTools(toolsByName: Readonly<Record<string, number>>, limit: number): string {
	const entries = Object.entries(toolsByName)
		.sort(([, left], [, right]) => right - left)
		.slice(0, limit);
	return entries.length === 0 ? "—" : entries.map(([name, count]) => `${name} ${count}`).join(" · ");
}

function nodeRows(state: CentreState, model: BoardModel, inner: number): Row[] {
	const stage = BOARD_STAGES[state.selected] ?? BOARD_STAGES[0];
	const status = stageStatus(state.selected, model, currentStage(model));
	const detail = state.detail;
	const value = (content: string, tone: Tone = "text"): Row => [
		text(truncatePlain(content, Math.max(1, inner - 9)), tone),
	];
	const rows: Row[] = [];
	if (detail?.loadError !== undefined) rows.push([text(`✕ load error ${detail.loadError}`, "error")]);
	const records = state.activity?.records ?? [];
	const node = detail?.node ?? stage.key;
	const retries = records.filter((record) => record.type === "node.retry" && record.node === node).length;
	rows.push(kv("node", 9, value(node)));
	rows.push(kv("status", 9, value(statusWord(status), statusTone(status))));
	rows.push(kv("runs", 9, value(String(detail?.runs ?? 0))));
	rows.push(kv("retries", 9, value(String(retries), retries > 0 ? "warning" : "text")));
	rows.push(kv("elapsed", 9, value(detail?.elapsedMs === undefined ? "—" : formatElapsed(detail.elapsedMs))));
	rows.push(kv("cost", 9, value(detail?.costUsd === undefined ? "—" : `${formatCost(detail.costUsd)} est.`)));
	rows.push(kv("tokens", 9, value("—", "dim")));
	rows.push(kv("model", 9, value(detail?.model ?? "—")));
	rows.push(kv("route", 9, value(state.route)));
	rows.push(kv("tools", 9, value(topTools(detail?.toolsByName ?? {}, 4))));
	if (detail?.result !== undefined) {
		rows.push(
			kv(
				"result",
				9,
				value(
					detail.result.lit ? `${detail.result.name} ${LIT}` : `${detail.result.name} ${DARK}`,
					detail.result.lit ? "text" : "dim",
				),
			),
		);
	}
	if (detail?.error !== undefined) rows.push(kv("error", 9, value(detail.error, "error")));
	rows.push([]);
	const writes = records.filter(
		(record) =>
			record.type === "tool.request" &&
			record.node === node &&
			(record.tool === "write" || record.tool === "edit") &&
			typeof record.path === "string",
	);
	rows.push([text("WRITES", "accent")]);
	if (writes.length === 0) rows.push([text("none", "dim")]);
	const paths = [...new Set(writes.map((record) => String(record.path)))];
	for (const path of paths.slice(-4)) rows.push([text(truncatePlain(path, inner))]);
	if (paths.length > 4) rows.push([text(`+${paths.length - 4} more`, "dim")]);
	const denied = writes.filter((record) => record.decision === "deny").length;
	if (writes.length > 0)
		rows.push(
			denied === 0 ? [text("all allowed by policy ✓", "success")] : [text(`${denied} denied by policy ✕`, "error")],
		);
	rows.push([]);
	rows.push([text("STEP", "accent")]);
	rows.push([
		text(
			model.superstep === undefined ? `round ${model.round}` : `superstep ${model.superstep} · round ${model.round}`,
		),
	]);
	rows.push([]);
	rows.push([text("NEXT", "accent")]);
	const next = nextStages(state.selected, 3);
	rows.push([text(next.length === 0 ? "end of graph" : next.join(" → "), "muted")]);
	if (model.mode === "gated" && state.selected < 7) rows.push([text("then human gate", "muted")]);
	rows.push([]);
	rows.push([text("TELEMETRY", "accent")]);
	rows.push(kv("cost", 8, [text(`${formatCost(totalCost(model))} est.`, "warning")]));
	if (state.costRates.length > 0) rows.push([text(`        ${sparkline(state.costRates)}`, "warning")]);
	rows.push(kv("context", 8, [text("—", "dim")]));
	rows.push(kv("tokens", 8, [text("—", "dim")]));
	rows.push(kv("time", 8, [text(runElapsed(state))]));
	rows.push(kv("route", 8, [text(truncatePlain(state.route, Math.max(1, inner - 8)))]));
	return rows;
}

// ---------------------------------------------------------------------------
// Layout

interface Chrome {
	/** Longest first; the first that fits the prompt row is painted. */
	placeholders: readonly string[];
	keyHint: string;
}

function inputRows(state: CentreState, width: number, palette: BoardPalette, chrome: Chrome): string[] {
	const rule = palette.paint("border", "─".repeat(width));
	const placeholder =
		chrome.placeholders.find((candidate) => visibleWidth(candidate) + 4 <= width) ?? chrome.placeholders.at(-1) ?? "";
	const prompt: Row =
		state.input.length === 0
			? [text("> ", "accent"), text("  "), text(placeholder, "dim")]
			: [text("> ", "accent"), text(state.input), text("▌", "accent")];
	const hint: Row =
		state.hint === undefined ? [text(chrome.keyHint, "dim")] : [text(state.hint.text, state.hint.tone)];
	return [rule, paintRow(prompt, width, palette), rule, paintRow(hint, width, palette)];
}

/** The overlay's height: the terminal's rows less the TUI's own status lines, never below MIN_HEIGHT. */
export function overlayHeight(rows: number): number {
	return Math.max(MIN_HEIGHT, rows - RESERVED_ROWS);
}

function emptyBody(message: string, height: number, width: number, palette: BoardPalette): string[] {
	return stack([[paintRow([text(message, "dim")], width, palette)]], height, width);
}

function homeBody(state: CentreState, model: BoardModel, body: number, width: number, palette: BoardPalette): string[] {
	const paint = (panel: Panel, panelWidth: number) => box(panel, panelWidth, palette);
	if (width >= COLUMNS_MIN_WIDTH) {
		const leftWidth = Math.floor(width * 0.475);
		const rightWidth = width - leftWidth - 1;
		let stagesH = STAGES_FULL_HEIGHT;
		if (body - stagesH < EVENTS_MIN_HEIGHT) stagesH = STAGES_COMPACT_HEIGHT;
		let remaining = body - stagesH;
		const sharedH = remaining - SHARED_HEIGHT >= EVENTS_MIN_HEIGHT ? SHARED_HEIGHT : 0;
		remaining -= sharedH;
		const eventsH = remaining;
		const liveH = Math.max(3, stagesH - TELEMETRY_HEIGHT);
		const left = [paint(stagesPanel(state, model, stagesH, leftWidth), leftWidth)];
		const right = [
			paint(livePanel(state, model, liveH), rightWidth),
			paint(
				{ title: "TELEMETRY", right: "events.jsonl", rows: telemetryRows(state, model), height: TELEMETRY_HEIGHT },
				rightWidth,
			),
		];
		if (sharedH > 0) {
			left.push(paint(sharedPanel(state, model, sharedH, leftWidth), leftWidth));
			right.push(paint(contextPanel(state, model, CONTEXT_HEIGHT), rightWidth));
		}
		const columns = sideBySide(left.flat(), right.flat(), leftWidth, 1);
		const events = eventsH >= 3 ? paint(eventsPanel(state, model, eventsH), width) : [];
		return stack([columns, events], body, width);
	}
	// One column: STAGES, LIVE and TELEMETRY first, the stage detail lines
	// next, SHARED and CONTEXT last; EVENTS takes whatever is left.
	const essentials = width < ESSENTIALS_MIN_WIDTH;
	let remaining = body - EVENTS_MIN_HEIGHT;
	let stagesH = STAGES_COMPACT_HEIGHT;
	remaining -= stagesH;
	const liveH = remaining >= LIVE_STACKED_HEIGHT ? LIVE_STACKED_HEIGHT : Math.max(0, remaining);
	remaining -= liveH;
	const telemetryH = !essentials && remaining >= TELEMETRY_HEIGHT ? TELEMETRY_HEIGHT : 0;
	remaining -= telemetryH;
	if (remaining >= STAGES_FULL_HEIGHT - STAGES_COMPACT_HEIGHT) {
		stagesH = STAGES_FULL_HEIGHT;
		remaining -= STAGES_FULL_HEIGHT - STAGES_COMPACT_HEIGHT;
	}
	const sharedH = !essentials && remaining >= SHARED_HEIGHT ? SHARED_HEIGHT : 0;
	remaining -= sharedH;
	const contextH = !essentials && remaining >= CONTEXT_HEIGHT ? CONTEXT_HEIGHT : 0;
	remaining -= contextH;
	const eventsH = EVENTS_MIN_HEIGHT + remaining;
	const blocks = [paint(stagesPanel(state, model, stagesH, width), width)];
	if (liveH >= 3) blocks.push(paint(livePanel(state, model, liveH), width));
	if (telemetryH > 0) {
		blocks.push(
			paint(
				{ title: "TELEMETRY", right: "events.jsonl", rows: telemetryRows(state, model), height: telemetryH },
				width,
			),
		);
	}
	if (sharedH > 0) blocks.push(paint(sharedPanel(state, model, sharedH, width), width));
	if (contextH > 0) blocks.push(paint(contextPanel(state, model, contextH), width));
	if (eventsH >= 3) blocks.push(paint(eventsPanel(state, model, eventsH), width));
	return stack(blocks, body, width);
}

function sessionBody(
	state: CentreState,
	model: BoardModel,
	body: number,
	width: number,
	palette: BoardPalette,
): string[] {
	const paint = (panel: Panel, panelWidth: number) => box(panel, panelWidth, palette);
	if (width >= COLUMNS_MIN_WIDTH) {
		const sessionWidth = width - RAIL_WIDTH - NODE_WIDTH - 2;
		const rail = paint(railPanel(state, model, body, RAIL_WIDTH), RAIL_WIDTH);
		const session = paint(sessionPanel(state, model, body, sessionWidth), sessionWidth);
		const node = paint({ title: "NODE", rows: nodeRows(state, model, NODE_WIDTH - 4), height: body }, NODE_WIDTH);
		return stack(
			[sideBySide(sideBySide(rail, session, RAIL_WIDTH, 1), node, RAIL_WIDTH + 1 + sessionWidth, 1)],
			body,
			width,
		);
	}
	if (width >= ESSENTIALS_MIN_WIDTH && body >= NODE_STACKED_HEIGHT + 6) {
		const sessionH = body - NODE_STACKED_HEIGHT;
		return stack(
			[
				paint(sessionPanel(state, model, sessionH, width), width),
				paint({ title: "NODE", rows: nodeRows(state, model, width - 4), height: NODE_STACKED_HEIGHT }, width),
			],
			body,
			width,
		);
	}
	return stack([paint(sessionPanel(state, model, body, width), width)], body, width);
}

/** Every row of the overlay for `width` columns and the terminal's `rows`. */
export function renderCommandCentre(state: CentreState, width: number, rows: number, palette: BoardPalette): string[] {
	const height = overlayHeight(rows);
	const model = state.model;
	const stage = BOARD_STAGES[state.selected] ?? BOARD_STAGES[0];
	const session = state.view === "session";
	const crumbs = session ? [`${stage.id} ${stage.label}`, "session"] : [];
	let right: Row[];
	if (!session || model === undefined) {
		right = homeHeaderRight(state);
	} else {
		const status = stageStatus(state.selected, model, currentStage(model));
		const live =
			status === "running"
				? `${spinner(state.spinner)} live`
				: status === "done"
					? "done"
					: statusWord(status).toLowerCase();
		const file = state.detail?.session ?? `agents/${stage.key}/*.jsonl`;
		const problem = state.refreshError === undefined ? "" : `  ·  EVENTS ✕ ${state.refreshError}`;
		const gone = state.jobGone ? "  ·  K-π no active job" : "";
		right = [
			[
				text(`${file}  ·  ${state.transcript.length} entries  ·  `, "muted"),
				text(live, status === "running" ? "accent" : "muted"),
				text(problem, "error"),
				text(gone, "error"),
			],
			[
				text(`${state.transcript.length} entries · `, "muted"),
				text(live, status === "running" ? "accent" : "muted"),
				text(problem, "error"),
				text(gone, "error"),
			],
		];
	}
	const top = header(state, width, palette, crumbs, right);
	const chrome: Chrome = session
		? { placeholders: SESSION_PLACEHOLDERS, keyHint: SESSION_KEY_HINT }
		: { placeholders: HOME_PLACEHOLDERS, keyHint: HOME_KEY_HINT };
	const bottom = inputRows(state, width, palette, chrome);
	const showPath = !session && width >= ESSENTIALS_MIN_WIDTH && model !== undefined;
	const body = height - top.length - bottom.length - (showPath ? 1 : 0);
	if (model === undefined) {
		return [
			...top,
			...emptyBody(state.jobGone ? "K-π no active job" : "K-π reading run files", body, width, palette),
			...bottom,
		];
	}
	const middle = session
		? sessionBody(state, model, body, width, palette)
		: homeBody(state, model, body, width, palette);
	const path = showPath ? [paintRow(pathRow(state, model, width), width, palette)] : [];
	return [...top, ...middle, ...path, ...bottom];
}

export function clampStage(index: number): number {
	return Math.max(0, Math.min(LAST_STAGE, index));
}
