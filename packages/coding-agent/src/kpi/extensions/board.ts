/**
 * Operator board (Board A amber / Board B protocol-blue).
 * Pure render from run-owned state — never starts a model.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

export const BOARD_STAGES = [
	{ id: "01", key: "ac-compile", label: "ac-compile" },
	{ id: "02", key: "specify", label: "specify" },
	{ id: "03", key: "plan", label: "plan" },
	{ id: "04", key: "implement", label: "implement" },
	{ id: "05", key: "test", label: "test" },
	{ id: "06", key: "bounds", label: "bounds" },
	{ id: "07", key: "review", label: "review" },
	{ id: "08", key: "ship", label: "ship" },
] as const;

export const RUN_FILE_NAMES = [
	"task.json",
	"context.md",
	"candidate.json",
	"evidence.json",
	"verdict.json",
	"events.jsonl",
] as const;

export type StopDisplay = "RUNNING" | "DONE" | "BLOCKED" | "EXHAUSTED" | "NO_PROGRESS" | "UNSAFE" | "NEEDS_HUMAN";

const STOP_VOCABULARY = new Set<string>([
	"RUNNING",
	"DONE",
	"BLOCKED",
	"EXHAUSTED",
	"NO_PROGRESS",
	"UNSAFE",
	"NEEDS_HUMAN",
]);

export function normalizeStop(raw: string | undefined): StopDisplay {
	const upper = (raw ?? "RUNNING").toUpperCase();
	if (upper === "APPROVAL") return "RUNNING";
	if (STOP_VOCABULARY.has(upper)) return upper as StopDisplay;
	if (upper === "COMPLETED") return "DONE";
	if (upper === "INTERRUPTED") return "RUNNING";
	return "RUNNING";
}

export interface ResearchBoardCell {
	/** Full RESEARCH cell text. */
	cell: string;
	/** Struck service marks when engine no-network. */
	struck?: string;
}

export interface BoardModel {
	jobId: string;
	mode: string;
	round: number;
	maxRounds: number;
	/** Graph stage key (e.g. implement, plan). */
	stage: string;
	node: string;
	stop: StopDisplay;
	/** graph_status interrupted or pending human question. */
	paused: boolean;
	pendingQuestion?: string;
	/** Sticky K-mode enabled even before a playbook freezes. */
	kModeEnabled?: boolean;
	passed?: boolean;
	/** What the last verifier said; derived from `passed` when absent. */
	verifier?: Verifier;
	/** Who holds the next gate; derived from `paused` when absent. */
	gate?: "human" | "machine";
	fingerprint?: string;
	/** file name → lit (exists && size > 0) */
	fileLit: Readonly<Record<string, boolean>>;
	contextPack: { product: boolean; structure: boolean; tech: boolean };
	research?: ResearchBoardCell;
	agents: number;
	busLit: boolean;
	kstack?: { playbook: string; todos: readonly string[] };
	route?: string;
	usage?: string;
	/** Terminal width; narrow paths must keep CURRENT stage + STOP. */
	width?: number;
}

export function stageIndex(stage: string): number {
	const normalized = stage
		.toLowerCase()
		.replace(/^0?\d+\s+/, "")
		.trim();
	if (normalized.length === 0) return -1;
	const exact = BOARD_STAGES.findIndex((entry) => entry.key === normalized || entry.label === normalized);
	if (exact >= 0) return exact;
	// ac-compile aliases
	if (normalized === "ac_compile" || normalized === "accompile") return 0;
	if (normalized === "plan-check") return 2;
	if (normalized === "quality-green") return 4;
	// node-shaped aliases (implementer → implement)
	if (normalized.endsWith("er")) {
		const stem = normalized.slice(0, -2);
		const byStem = BOARD_STAGES.findIndex((entry) => entry.key === stem);
		if (byStem >= 0) return byStem;
	}
	if (normalized === "human-confirm" || normalized === "human_confirm" || normalized === "confirm") return 7;
	return -1;
}

/**
 * Exactly one current stage for the rail. Prefer `stage`, then `node` alias,
 * finally ac-compile — never zero CURRENT cells for a live board.
 */
export function resolveCurrentStageIndex(stage: string, node?: string): number {
	const fromStage = stageIndex(stage);
	if (fromStage >= 0) return fromStage;
	if (node !== undefined) {
		const fromNode = stageIndex(node);
		if (fromNode >= 0) return fromNode;
	}
	return 0; // ac-compile
}

/** Colour identities a span can carry; mapped to theme keys by the painter. */
export type Tone = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "border" | "borderAccent";

export interface Span {
	text: string;
	tone?: Tone;
}

/** One logical line of a region: spans joined without separators. */
export type Row = Span[];

export function rowText(row: Row): string {
	return row.map((span) => span.text).join("");
}

export interface BoardCell {
	/** Full-height cell body, one entry per line (id / label / status). */
	lines: string[];
	/** One-line body for the compact layout. */
	compact: string;
	tone: Tone;
	borderTone: Tone;
	lit: boolean;
}

export type RegionId =
	| "header"
	| "telemetry"
	| "contextLayer"
	| "stages"
	| "iteration"
	| "oversight"
	| "lamps"
	| "stopStates"
	| "threeLaws"
	| "waiting"
	| "stop";

interface RegionBase {
	id: RegionId;
	/** The frame-less lines; what `renderBoard`, tests and non-TUI surfaces show. */
	flat: string[];
}

export interface StripRegion extends RegionBase {
	kind: "strip";
	segments: Span[];
}

export interface RowsRegion extends RegionBase {
	kind: "rows";
	title?: string;
	rows: Row[];
	/** `none` draws bare rows, `panel` a bordered box, `accent` an accent-bordered box. */
	frame: "none" | "panel" | "accent";
}

export interface CellsRegion extends RegionBase {
	kind: "cells";
	title: string;
	cells: BoardCell[];
	/** The one-row form, used by the compact layout and by narrow terminals. */
	compactRow: Row;
}

export interface StopRegion extends RegionBase {
	kind: "stop";
	text: string;
	tone: Tone;
}

export type Region = StripRegion | RowsRegion | CellsRegion | StopRegion;

export interface BoardRegions {
	variant: "amber" | "blue";
	regions: Region[];
	byId: Partial<Record<RegionId, Region>>;
}

export type Verifier = "pass" | "fail" | "pending";

/**
 * What the last verifier said. `passed` alone cannot tell "failed" from "never
 * ran", so a caller that knows whether a verdict exists says so explicitly.
 */
export function verifierFor(model: Pick<BoardModel, "passed" | "verifier">): Verifier {
	if (model.verifier !== undefined) return model.verifier;
	if (model.passed === true) return "pass";
	if (model.passed === false) return "fail";
	return "pending";
}

function verifierLabel(verifier: Verifier): string {
	if (verifier === "pass") return "PASS";
	if (verifier === "fail") return "FAIL";
	return "PASS/FAIL PENDING";
}

function shortFingerprint(value: string | undefined): string {
	if (value === undefined || value.length === 0) return "—";
	const hex = value.replace(/^sha256:/, "");
	return hex.length <= 12 ? hex : hex.slice(0, 12);
}

export function stopTone(stop: StopDisplay): Tone {
	if (stop === "RUNNING") return "warning";
	if (stop === "DONE") return "success";
	if (stop === "NEEDS_HUMAN") return "accent";
	return "error";
}

const LIT = "●";
const DARK = "○";

function stageCells(current: number): BoardCell[] {
	return BOARD_STAGES.map((entry, index) => {
		const status = index === current ? "CURRENT" : current >= 0 && index < current ? "DONE" : "PENDING";
		const tone: Tone = status === "CURRENT" ? "accent" : status === "DONE" ? "success" : "dim";
		return {
			lines: [entry.id, entry.label, status],
			compact: `${entry.id} ${entry.label} ${status}`,
			tone,
			borderTone: status === "CURRENT" ? "borderAccent" : "border",
			lit: status === "CURRENT",
		};
	});
}

function stagesRegion(current: number, title: string): CellsRegion {
	const cells = stageCells(current);
	const labels = cells.map((cell) => cell.compact);
	return {
		kind: "cells",
		id: "stages",
		title,
		cells,
		compactRow: cells.map((cell, index) => ({ text: `${index === 0 ? "" : "   "}${cell.compact}`, tone: cell.tone })),
		// Two rows of four, matching the visual reconstruction.
		flat: [`STAGES  ${labels.slice(0, 4).join("   ")}`, `        ${labels.slice(4).join("   ")}`],
	};
}

function lampCells(fileLit: Readonly<Record<string, boolean>>): BoardCell[] {
	return RUN_FILE_NAMES.map((name) => {
		const lit = fileLit[name] === true;
		return {
			lines: [name, lit ? LIT : DARK, lit ? "ON" : "DIM"],
			compact: `${lit ? LIT : DARK} ${name}`,
			tone: lit ? "accent" : "dim",
			borderTone: lit ? "borderAccent" : "border",
			lit,
		};
	});
}

function lampRow(cells: BoardCell[]): Row {
	return cells.map((cell, index) => ({ text: `${index === 0 ? "" : "  "}${cell.compact}`, tone: cell.tone }));
}

function lampsRegion(model: BoardModel, paused: boolean): CellsRegion {
	const cells = paused
		? RUN_FILE_NAMES.map((name) => {
				const lit = model.fileLit[name] === true;
				const status = name === "events.jsonl" ? "APPEND" : lit ? "READY" : "MISSING";
				return {
					lines: [name, lit ? LIT : DARK, status],
					compact: `${lit ? LIT : DARK} ${name}`,
					tone: (lit ? "accent" : "dim") as Tone,
					borderTone: (lit ? "borderAccent" : "border") as Tone,
					lit,
				};
			})
		: lampCells(model.fileLit);
	const compactRow = lampRow(cells);
	const flatLamps = rowText(compactRow);
	return {
		kind: "cells",
		id: "lamps",
		title: paused ? "SHARED RUN STATE" : "FILE LAMPS",
		cells,
		compactRow,
		flat: paused ? ["SHARED RUN STATE", `  ${flatLamps}`] : [`FILES  ${flatLamps}`],
	};
}

function contextRows(model: BoardModel): Row[] {
	const pack = model.contextPack;
	const rows: Row[] = [
		[
			{ text: `product ${pack.product ? LIT : DARK}`, tone: pack.product ? "text" : "dim" },
			{ text: "  " },
			{ text: `structure ${pack.structure ? LIT : DARK}`, tone: pack.structure ? "text" : "dim" },
			{ text: "  " },
			{ text: `tech ${pack.tech ? LIT : DARK}`, tone: pack.tech ? "text" : "dim" },
		],
	];
	if (model.research !== undefined) {
		rows.push([{ text: model.research.cell, tone: "muted" }]);
		if (model.research.struck !== undefined) {
			rows.push([{ text: model.research.struck, tone: "error" }]);
		}
	}
	if (model.kstack !== undefined) {
		const done = model.kstack.todos.length;
		rows.push([{ text: `K-STACK ${model.kstack.playbook}  ${done} steps`, tone: "text" }]);
		if (model.kstack.todos.length > 0) {
			rows.push([{ text: `PROGRESS  ${model.kstack.todos[0]}${done > 1 ? ` · +${done - 1}` : ""}`, tone: "muted" }]);
		}
	}
	const cells: Span[] = [
		{ text: `AGENTS ${model.agents}`, tone: "text" },
		{ text: "  " },
		{ text: model.busLit ? `BUS ${LIT}` : `BUS ${DARK}`, tone: model.busLit ? "text" : "dim" },
	];
	if (model.route !== undefined) cells.push({ text: "  " }, { text: `ROUTE ${model.route}`, tone: "text" });
	if (model.usage !== undefined) cells.push({ text: "  " }, { text: `USAGE ${model.usage}`, tone: "text" });
	rows.push(cells);
	return rows;
}

function contextRegion(model: BoardModel): RowsRegion {
	const rows = contextRows(model);
	const [lamps, ...rest] = rows;
	return {
		kind: "rows",
		id: "contextLayer",
		title: "CONTEXT LAYER",
		rows,
		frame: "panel",
		flat: [`CONTEXT LAYER  ${rowText(lamps ?? [])}`, ...rest.map((row) => `  ${rowText(row)}`)],
	};
}

function iterationRegion(model: BoardModel): RowsRegion {
	const verifier = verifierFor(model);
	const fingerprint = shortFingerprint(model.fingerprint);
	const round = `ROUND ${model.round}/${model.maxRounds}`;
	const rows: Row[] = [[{ text: round, tone: "text" }]];
	if (verifier === "pending") {
		rows.push([{ text: "PASS/FAIL PENDING", tone: "dim" }]);
	} else {
		rows.push(
			[
				{
					text: verifier === "pass" ? `PASS ${LIT} last verifier` : `PASS ${DARK} none`,
					tone: verifier === "pass" ? "success" : "dim",
				},
			],
			[
				{
					text: verifier === "fail" ? `FAIL ${LIT} last verifier` : `FAIL ${DARK} none`,
					tone: verifier === "fail" ? "error" : "dim",
				},
			],
		);
	}
	rows.push([{ text: `FINGERPRINT ${fingerprint}`, tone: "muted" }]);
	return {
		kind: "rows",
		id: "iteration",
		title: "ITERATION LOOP",
		rows,
		frame: "panel",
		flat: [`${round}  FINGERPRINT ${fingerprint}  ${verifierLabel(verifier)}`],
	};
}

function oversightRegion(question: string | undefined): RowsRegion {
	const text = question === undefined ? "confirm to continue" : question;
	return {
		kind: "rows",
		id: "oversight",
		title: "HUMAN OVERSIGHT REQUIRED",
		rows: [
			[
				{ text: "GATE human — ", tone: "accent" },
				{ text, tone: "text" },
			],
		],
		frame: "accent",
		flat: ["HUMAN OVERSIGHT REQUIRED"],
	};
}

function waitingRegion(question: string | undefined): RowsRegion {
	return {
		kind: "rows",
		id: "waiting",
		title: "WAITING ON OPERATOR",
		rows: question === undefined ? [] : [[{ text: question, tone: "text" }]],
		frame: "accent",
		flat: [question === undefined ? "WAITING ON OPERATOR" : `WAITING ON OPERATOR  ${question}`],
	};
}

function stopStatesRegion(stop: StopDisplay): CellsRegion {
	const entries: Array<[string, boolean]> = [
		["DONE", stop === "DONE"],
		["BLOCKED", stop === "BLOCKED"],
		["APPROVAL", true],
	];
	const cells = entries.map(([label, lit]) => ({
		lines: [label, lit ? LIT : DARK],
		compact: `${label} ${lit ? LIT : DARK}`,
		tone: (lit ? "accent" : "dim") as Tone,
		borderTone: (lit ? "borderAccent" : "border") as Tone,
		lit,
	}));
	const compactRow: Row = cells.map((cell, index) => ({
		text: `${index === 0 ? "" : "  "}${cell.compact}`,
		tone: cell.tone,
	}));
	return {
		kind: "cells",
		id: "stopStates",
		title: "STOP STATES",
		cells,
		compactRow,
		flat: [`STOP STATES  ${rowText(compactRow)}`],
	};
}

const THREE_LAWS = [
	"1. Outer loop owns the return path",
	"2. Shared files are the contract",
	"3. Irreversible effects stay outside the worker",
] as const;

function threeLawsRegion(): RowsRegion {
	return {
		kind: "rows",
		id: "threeLaws",
		title: "THREE LAWS",
		rows: THREE_LAWS.map((law) => [{ text: law, tone: "muted" }]),
		frame: "panel",
		flat: ["THREE LAWS", ...THREE_LAWS.map((law) => `  ${law}`)],
	};
}

function telemetryRegion(model: BoardModel, current: number, gate: "human" | "machine"): RowsRegion {
	const stage = BOARD_STAGES[current] ?? BOARD_STAGES[0];
	const row: Row = [
		{ text: `LOOP ${model.jobId}`, tone: "text" },
		{ text: "  " },
		{ text: `STAGE ${stage.id} ${stage.label}`, tone: "accent" },
		{ text: "  " },
		{ text: `NODE ${model.node}`, tone: "text" },
		{ text: "  " },
		{ text: `GATE ${gate}`, tone: gate === "human" ? "accent" : "text" },
	];
	return { kind: "rows", id: "telemetry", rows: [row], frame: "none", flat: [rowText(row)] };
}

function headerRegion(model: BoardModel, paused: boolean): StripRegion {
	const segments: Span[] = [
		{ text: paused ? "K-π PROTOCOL" : "K-π GRAPH CONTROL", tone: "accent" },
		{ text: `MODE ${model.mode}`, tone: "text" },
		{ text: `JOB ${model.jobId}`, tone: "text" },
		{ text: `ROUND ${model.round}/${model.maxRounds}`, tone: "text" },
	];
	if (paused) segments.push({ text: "GATE approval", tone: "accent" });
	if (model.kstack !== undefined) segments.push({ text: "K-STACK on", tone: "success" });
	return { kind: "strip", id: "header", segments, flat: [segments.map((segment) => segment.text).join("  ")] };
}

/**
 * The board as regions: what each panel says, which cells are lit, and the
 * frame-less lines that mean the same thing. Board A (amber) while the loop
 * runs; Board B (protocol-blue) while a human node is paused.
 */
export function buildBoardRegions(model: BoardModel): BoardRegions {
	const current = resolveCurrentStageIndex(model.stage, model.node);
	const paused = model.paused;
	const gate: "human" | "machine" = model.gate ?? (paused ? "human" : "machine");
	const question = model.pendingQuestion?.trim();
	const pending = question !== undefined && question.length > 0 ? question : undefined;
	const regions: Region[] = [
		headerRegion(model, paused),
		telemetryRegion(model, current, gate),
		contextRegion(model),
		stagesRegion(current, paused ? "STAGE RAIL" : "STAGES 01–08"),
		iterationRegion(model),
	];
	if (paused) {
		regions.push(oversightRegion(pending), waitingRegion(pending));
	}
	regions.push(lampsRegion(model, paused));
	if (paused) {
		regions.push(stopStatesRegion(model.stop), threeLawsRegion());
	}
	regions.push({
		kind: "stop",
		id: "stop",
		text: `STOP ${model.stop}`,
		tone: stopTone(model.stop),
		flat: [`STOP ${model.stop}`],
	});
	const byId: Partial<Record<RegionId, Region>> = {};
	for (const region of regions) byId[region.id] = region;
	return { variant: paused ? "blue" : "amber", regions, byId };
}

/** The frame-less board: every region's flat lines, in board order. */
export function flattenRegions(regions: BoardRegions): string[] {
	return regions.regions.flatMap((region) => region.flat);
}

/**
 * Renders Board A (amber running) or Board B (protocol-blue pause) as plain
 * lines. The painter draws the same regions with frames and colour.
 */
export function renderBoard(model: BoardModel): string[] {
	return fitBoard(flattenRegions(buildBoardRegions(model)), model.width);
}

/** The two-space gap between lamps, which is also where a lamp row may fold. */
const LAMP_SEPARATOR = "  ";

/** A row of run-file lamps, identified by carrying every file it must show. */
function isFileLampRow(line: string): boolean {
	return RUN_FILE_NAMES.every((name) => line.includes(name));
}

/**
 * Folds a lamp row instead of cutting it.
 *
 * A truncated lamp row is worse than a taller board: the operator cannot tell a
 * dark lamp from an absent one, so every lamp folds onto the next line rather
 * than disappearing behind an ellipsis. A single lamp wider than the terminal is
 * emitted whole - the name is the information.
 */
function foldLamps(line: string, width: number): string[] {
	const indent = line.slice(0, line.length - line.trimStart().length);
	const body = line.slice(indent.length);
	const label = body.startsWith("FILES") ? "FILES" : "";
	const lamps = body
		.slice(label.length)
		.trim()
		.split(LAMP_SEPARATOR)
		.filter((lamp) => lamp.length > 0);
	if (lamps.length === 0) {
		return [line];
	}
	const firstPrefix = label.length > 0 ? `${indent}${label}${LAMP_SEPARATOR}` : indent;
	const continuationPrefix = `${indent}${LAMP_SEPARATOR}`;
	const rows: string[] = [];
	let current = "";
	let prefix = firstPrefix;
	for (const lamp of lamps) {
		const candidate = current.length === 0 ? `${prefix}${lamp}` : `${current}${LAMP_SEPARATOR}${lamp}`;
		if (current.length > 0 && visibleWidth(candidate) > width) {
			rows.push(current);
			prefix = continuationPrefix;
			current = `${prefix}${lamp}`;
			continue;
		}
		current = candidate;
	}
	if (current.length > 0) {
		rows.push(current);
	}
	return rows;
}

/** Plain-text truncation: no escape sequences, so the result can still be painted. */
export function truncatePlain(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let out = "";
	for (const character of text) {
		if (visibleWidth(out + character) > width - 1) break;
		out += character;
	}
	return `${out}…`;
}

function clamp(line: string, width: number): string {
	return truncatePlain(line, width);
}

const STAGE_CELL_PATTERN = /\d{2} \S+ (?:DONE|CURRENT|PENDING)/gu;
const STAGE_CELL_SEPARATOR = "   ";

/** A stage-rail row: at least one `NN label STATUS` cell. */
function isStageRow(line: string): boolean {
	return line.match(STAGE_CELL_PATTERN) !== null;
}

/**
 * Folds a stage row the way lamp rows fold. The CURRENT cell is left out
 * because the essentials already carry it; every other stage keeps its name.
 */
function foldStages(line: string, width: number): string[] {
	const cells = (line.match(STAGE_CELL_PATTERN) ?? []).filter((cell) => !cell.endsWith("CURRENT"));
	const label = line.trimStart().startsWith("STAGES") ? "STAGES" : "";
	const rows: string[] = [];
	let current = "";
	let prefix = label.length > 0 ? `${label}  ` : "        ";
	for (const cell of cells) {
		const candidate = current.length === 0 ? `${prefix}${cell}` : `${current}${STAGE_CELL_SEPARATOR}${cell}`;
		if (current.length > 0 && visibleWidth(candidate) > width) {
			rows.push(current);
			prefix = "        ";
			current = `${prefix}${cell}`;
			continue;
		}
		current = candidate;
	}
	if (current.length > 0) rows.push(current);
	return rows;
}

/** The header gives up the job id before MODE or ROUND. */
function fitHeader(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	const segments = line.split("  ");
	const job = segments.findIndex((segment) => segment.startsWith("JOB "));
	if (job !== -1) {
		const excess = visibleWidth(line) - width;
		const keep = Math.max("JOB ".length + 6, visibleWidth(segments[job] ?? "") - excess);
		segments[job] = truncatePlain(segments[job] ?? "", keep);
	}
	return clamp(segments.join("  "), width);
}

/** Rows a narrow board keeps first: the brand, the current stage, STOP, and the operator's question. */
function isEssentialRow(line: string): boolean {
	return (
		line.includes("CURRENT") ||
		line.startsWith("STOP ") ||
		line.startsWith("K-π") ||
		line.startsWith("WAITING ON OPERATOR") ||
		line.startsWith("HUMAN OVERSIGHT")
	);
}

/**
 * Narrow terminals may wrap; the current stage, STOP, and every run-file lamp
 * must remain visible.
 */
export function fitBoard(lines: readonly string[], width?: number): string[] {
	if (width === undefined || width <= 0 || width >= 100) {
		return [...lines];
	}
	const essential: string[] = [];
	for (const line of lines) {
		if (line.includes("CURRENT")) {
			const match = /(\d{2}\s+\S+)\s+CURRENT/u.exec(line);
			const marker = match !== null ? `${match[1]} CURRENT` : "CURRENT";
			essential.push(clamp(marker, width));
			continue;
		}
		if (isEssentialRow(line)) {
			essential.push(line.startsWith("K-π") ? fitHeader(line, width) : clamp(line, width));
		}
	}
	// Keep remaining context after the essentials, still width-bound, with lamp
	// and stage rows folded rather than cut.
	const rest: string[] = [];
	for (const line of lines) {
		if (isEssentialRow(line) && !line.includes("CURRENT")) {
			continue;
		}
		if (isFileLampRow(line)) {
			rest.push(...foldLamps(line, width));
			continue;
		}
		if (isStageRow(line)) {
			rest.push(...foldStages(line, width));
			continue;
		}
		rest.push(clamp(line, width));
	}
	return [...essential, ...rest];
}

/** Research.json → board cell. Never invents external URLs. */
export function researchCellFromDocument(document: {
	network?: {
		state?: string;
		origin?: string;
		reason?: string;
		failures?: Array<{ service?: string }>;
	};
	sources?: Array<{ kind?: string; service?: string | null }>;
	mode?: string;
}): ResearchBoardCell | undefined {
	const network = document.network;
	if (network === undefined) return undefined;
	if (network.state === "online") {
		const external = (document.sources ?? []).filter((source) => source.kind === "external");
		const service =
			external.find((source) => typeof source.service === "string" && source.service.length > 0)?.service ??
			document.mode ??
			"exa";
		return { cell: `RESEARCH ${service} ${external.length} src` };
	}
	if (network.state === "no-network") {
		const origin = network.origin === "engine" ? "engine" : "operator";
		if (origin === "operator") {
			return { cell: "RESEARCH local · no-network operator" };
		}
		const reason = typeof network.reason === "string" && network.reason.length > 0 ? network.reason : "exhausted";
		const failed = new Set(
			(network.failures ?? [])
				.map((failure) => failure.service?.toLowerCase())
				.filter((service): service is string => typeof service === "string"),
		);
		const struck = ["exa", "perplexity"]
			.filter((service) => failed.has(service) || failed.has(service === "perplexity" ? "pplx" : service))
			.map((service) => (service === "perplexity" ? "PPLX ✕" : "EXA ✕"))
			.join("  ");
		// Always show both struck marks when engine no-network recorded any failure list.
		const marks =
			struck.length > 0 ? struck : (network.failures ?? []).length > 0 ? "EXA ✕  PPLX ✕" : "EXA ✕  PPLX ✕";
		return {
			cell: `RESEARCH local · no-network engine · ${reason}`,
			struck: marks,
		};
	}
	return undefined;
}
