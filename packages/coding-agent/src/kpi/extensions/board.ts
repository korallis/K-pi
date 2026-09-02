/**
 * Operator board (Board A amber / Board B protocol-blue).
 * Pure render from run-owned state — never starts a model.
 */

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

function verifierLabel(passed: boolean | undefined): string {
	if (passed === true) return "PASS";
	if (passed === false) return "FAIL";
	return "PASS/FAIL";
}

function shortFingerprint(value: string | undefined): string {
	if (value === undefined || value.length === 0) return "—";
	const hex = value.replace(/^sha256:/, "");
	return hex.length <= 12 ? hex : hex.slice(0, 12);
}

function stageRail(current: number): string {
	const cells = BOARD_STAGES.map((entry, index) => {
		const label = `${entry.id} ${entry.label}`;
		if (index === current) return `${label} CURRENT`;
		if (current >= 0 && index < current) return `${label} DONE`;
		return `${label} PENDING`;
	});
	// Two rows of four, matching the visual reconstruction.
	return `STAGES  ${cells.slice(0, 4).join("   ")}\n        ${cells.slice(4).join("   ")}`;
}

function contextLayer(model: BoardModel): string[] {
	const pack = model.contextPack;
	const lamps = [
		`product ${pack.product ? "●" : "○"}`,
		`structure ${pack.structure ? "●" : "○"}`,
		`tech ${pack.tech ? "●" : "○"}`,
	].join("  ");
	const lines = [`CONTEXT LAYER  ${lamps}`];
	if (model.research !== undefined) {
		lines.push(`  ${model.research.cell}`);
		if (model.research.struck !== undefined) {
			lines.push(`  ${model.research.struck}`);
		}
	}
	if (model.kstack !== undefined) {
		const done = model.kstack.todos.length;
		lines.push(`  K-STACK ${model.kstack.playbook}  ${done} steps`);
		if (model.kstack.todos.length > 0) {
			lines.push(`  PROGRESS  ${model.kstack.todos[0]}${done > 1 ? ` · +${done - 1}` : ""}`);
		}
	}
	const agents = `AGENTS ${model.agents}`;
	const bus = model.busLit ? "BUS ●" : "BUS ○";
	const route = model.route === undefined ? "" : `  ROUTE ${model.route}`;
	const usage = model.usage === undefined ? "" : `  USAGE ${model.usage}`;
	lines.push(`  ${agents}  ${bus}${route}${usage}`);
	return lines;
}

function fileRow(fileLit: Readonly<Record<string, boolean>>): string {
	return RUN_FILE_NAMES.map((name) => `${fileLit[name] === true ? "●" : "○"} ${name}`).join("  ");
}

function stopStatesLine(paused: boolean, stop: StopDisplay): string {
	const done = stop === "DONE" ? "DONE ●" : "DONE ○";
	const blocked = stop === "BLOCKED" ? "BLOCKED ●" : "BLOCKED ○";
	const approval = paused ? "APPROVAL ●" : "APPROVAL ○";
	return `STOP STATES  ${done}  ${blocked}  ${approval}`;
}

const THREE_LAWS = [
	"THREE LAWS",
	"  1. Outer loop owns the return path",
	"  2. Shared files are the contract",
	"  3. Irreversible effects stay outside the worker",
] as const;

/**
 * Renders Board A (amber running) or Board B (protocol-blue pause).
 */
export function renderBoard(model: BoardModel): string[] {
	const current = resolveCurrentStageIndex(model.stage, model.node);
	const kstackMark = model.kstack !== undefined ? "  K-STACK on" : "";
	const header = `K-π  LOOP ${model.jobId}  MODE ${model.mode}  JOB ${model.jobId}${kstackMark}`;
	const lines: string[] = [header, ...contextLayer(model)];

	for (const row of stageRail(current).split("\n")) {
		lines.push(row);
	}

	lines.push(
		`ROUND ${model.round}/${model.maxRounds}  FINGERPRINT ${shortFingerprint(model.fingerprint)}  ${verifierLabel(model.passed)}`,
	);

	const gate = model.paused ? "human" : "machine";
	lines.push(`GATE ${gate}`);
	if (model.paused) {
		lines.push("HUMAN OVERSIGHT REQUIRED");
		const question = model.pendingQuestion?.trim();
		if (question !== undefined && question.length > 0) {
			lines.push(`WAITING ON OPERATOR  ${question}`);
		} else {
			lines.push("WAITING ON OPERATOR");
		}
	}

	if (model.paused) {
		lines.push("SHARED RUN STATE");
		lines.push(`  ${fileRow(model.fileLit)}`);
		lines.push(stopStatesLine(true, model.stop));
		lines.push(...THREE_LAWS);
	} else {
		lines.push(`FILES  ${fileRow(model.fileLit)}`);
	}

	lines.push(`STOP ${model.stop}`);
	lines.push(`NODE ${model.node}`);

	return fitBoard(lines, model.width);
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
		if (current.length > 0 && candidate.length > width) {
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

function clamp(line: string, width: number): string {
	return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`;
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
			essential.push(marker.length <= width ? marker : marker.slice(0, width));
			continue;
		}
		if (line.startsWith("STOP ") || line.startsWith("STOP STATES")) {
			essential.push(clamp(line, width));
			continue;
		}
		if (line.startsWith("K-π") || line.startsWith("WAITING ON OPERATOR") || line.startsWith("HUMAN OVERSIGHT")) {
			essential.push(clamp(line, width));
		}
	}
	// Keep remaining context after the essentials, still width-bound, with lamp
	// rows folded rather than cut.
	const rest: string[] = [];
	for (const line of lines) {
		if (
			line.includes("CURRENT") ||
			line.startsWith("STOP ") ||
			line.startsWith("STOP STATES") ||
			line.startsWith("K-π") ||
			line.startsWith("WAITING ON OPERATOR") ||
			line.startsWith("HUMAN OVERSIGHT")
		) {
			continue;
		}
		if (isFileLampRow(line)) {
			rest.push(...foldLamps(line, width));
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
