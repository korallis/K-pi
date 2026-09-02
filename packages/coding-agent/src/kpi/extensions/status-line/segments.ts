import { basename } from "node:path";

export type SlotKind = "oauth" | "api_key" | "local";

export type StatusbarPreset = "default" | "compact" | "full";

export type SegmentId =
	| "brand"
	| "model"
	| "thinking"
	| "path"
	| "git"
	| "context_pct"
	| "cost"
	| "usage"
	| "kpi_job"
	| "request";

/** Default left rail — visual-targets §1. */
export const DEFAULT_LEFT_SEGMENT_ORDER: readonly SegmentId[] = [
	"brand",
	"model",
	"thinking",
	"path",
	"git",
	"context_pct",
	"cost",
] as const;

export const DEFAULT_RIGHT_SEGMENT_ORDER: readonly SegmentId[] = ["request"] as const;

export const DEFAULT_SEGMENT_ORDER = [...DEFAULT_LEFT_SEGMENT_ORDER, ...DEFAULT_RIGHT_SEGMENT_ORDER] as const;

export const SEGMENT_SEPARATOR = "  >  ";

/** Compact: brand, model, path, cost, request. */
export const COMPACT_LEFT_SEGMENT_ORDER: readonly SegmentId[] = ["brand", "model", "path", "cost"] as const;

/** Full: default left plus usage and kpi_job. */
export const FULL_LEFT_SEGMENT_ORDER: readonly SegmentId[] = [
	"brand",
	"model",
	"thinking",
	"path",
	"git",
	"context_pct",
	"cost",
	"usage",
	"kpi_job",
] as const;

export function leftSegmentsForPreset(preset: StatusbarPreset): readonly SegmentId[] {
	if (preset === "compact") return COMPACT_LEFT_SEGMENT_ORDER;
	if (preset === "full") return FULL_LEFT_SEGMENT_ORDER;
	return DEFAULT_LEFT_SEGMENT_ORDER;
}

export type ContextColor = "success" | "warning" | "accent" | "error";

export function formatModel(name: string | undefined): string {
	return `⬡ ${name ?? "no model"}`;
}

export function formatThinking(level: string | undefined): string {
	return `● ${level ?? "off"}`;
}

export function formatPath(cwd: string): string {
	return `📁 ${basename(cwd) || cwd}`;
}

export function formatGit(branch: string | null): string | undefined {
	return branch ? `⎇ ${branch}` : undefined;
}

export function contextColor(percent: number): ContextColor {
	if (percent < 50) return "success";
	if (percent <= 70) return "warning";
	if (percent <= 90) return "accent";
	return "error";
}

export function formatContext(percent: number | null | undefined, contextWindow: number | undefined): string {
	if (percent == null || contextWindow == null) return "▦ —";
	return `▦ ${percent.toFixed(0)}%/${formatCount(contextWindow)}`;
}

/**
 * Cost cell (NH-01 / REQ-SB-08).
 * oauth → `(sub)`; local → exactly `(local) $0`; api_key → `$x.xx`.
 */
export function formatCost(cost: number, slotKind: SlotKind = "api_key"): string {
	if (slotKind === "oauth") return "(sub)";
	if (slotKind === "local") return "(local) $0";
	return `$${cost.toFixed(2)}`;
}

/**
 * Usage cell: remaining percent when known. Local and unknown omit entirely.
 */
export function formatUsage(remainingPercent: number | undefined, slotKind: SlotKind): string | undefined {
	if (slotKind === "local") return undefined;
	if (remainingPercent === undefined || !Number.isFinite(remainingPercent)) return undefined;
	return `${Math.round(remainingPercent)}%`;
}

export interface KpiJobFields {
	mode: string;
	round: number;
	maxRounds: number;
	stage: string;
	gate: "human" | "machine";
	/** e.g. `4/5` when known */
	ac?: string;
	/** e.g. `anthropic/home` */
	route?: string;
}

/** Second-line / full-preset job summary. */
export function formatKpiJob(fields: KpiJobFields): string {
	const parts = [
		"K-π",
		"LOOP",
		fields.mode,
		`r${fields.round}/${fields.maxRounds}`,
		`STAGE ${fields.stage}`,
		`GATE ${fields.gate}`,
	];
	if (fields.ac !== undefined && fields.ac.length > 0) {
		parts.push(`AC ${fields.ac}`);
	}
	if (fields.route !== undefined && fields.route.length > 0) {
		parts.push(`ROUTE ${fields.route}`);
	}
	return parts.join(" ");
}

export function formatRequest(request: string | undefined): string | undefined {
	if (!request) return undefined;
	return request.length <= 80 ? request : `${request.slice(0, 79)}…`;
}

function formatCount(value: number): string {
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
	return String(value);
}

export interface AssembleFooterInput {
	brand: string;
	model?: string;
	thinking?: string;
	path: string;
	git?: string | null;
	contextPercent?: number | null;
	contextWindow?: number;
	cost: number;
	slotKind: SlotKind;
	remainingPercent?: number;
	kpiJob?: KpiJobFields;
	request?: string;
	preset?: StatusbarPreset;
	/** Terminal width for truncation; omit to skip. */
	width?: number;
}

export interface AssembledFooter {
	/** Primary left+right line text without theme colors. */
	line: string;
	/** Optional second line (kpi job) when preset is default and a job is active. */
	jobLine?: string;
	segments: Partial<Record<SegmentId, string>>;
}

/**
 * End-to-end footer assembly used by the TUI and by tests.
 * Never touches a model client.
 */
export function assembleFooter(input: AssembleFooterInput): AssembledFooter {
	const preset = input.preset ?? "default";
	const slotKind = input.slotKind;
	const segments: Partial<Record<SegmentId, string>> = {
		brand: input.brand,
		model: formatModel(input.model),
		thinking: formatThinking(input.thinking),
		path: formatPath(input.path),
		cost: formatCost(input.cost, slotKind),
	};
	const git = formatGit(input.git ?? null);
	if (git !== undefined) segments.git = git;
	segments.context_pct = formatContext(input.contextPercent, input.contextWindow);
	const usage = formatUsage(input.remainingPercent, slotKind);
	if (usage !== undefined) segments.usage = usage;
	if (input.kpiJob !== undefined) segments.kpi_job = formatKpiJob(input.kpiJob);
	const request = formatRequest(input.request);
	if (request !== undefined) segments.request = request;

	const leftIds = leftSegmentsForPreset(preset);
	const leftParts = leftIds
		.map((id) => segments[id])
		.filter((text): text is string => typeof text === "string" && text.length > 0);
	let line = leftParts.join(SEGMENT_SEPARATOR);
	if (request !== undefined) {
		line = `${line}  ────  ${request}`;
	}

	// Default and compact keep kpi_job on a second status line when present.
	// Full already embeds kpi_job in the left rail.
	let jobLine: string | undefined;
	if (preset !== "full" && input.kpiJob !== undefined) {
		jobLine = formatKpiJob(input.kpiJob);
	}

	if (input.width !== undefined && input.width > 0 && line.length > input.width) {
		line = `${line.slice(0, Math.max(0, input.width - 1))}…`;
	}

	return { line, ...(jobLine === undefined ? {} : { jobLine }), segments };
}
