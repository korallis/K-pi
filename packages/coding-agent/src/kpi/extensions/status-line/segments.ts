import { basename } from "node:path";

export const DEFAULT_LEFT_SEGMENT_ORDER = ["brand", "model", "thinking", "path", "git", "context_pct", "cost"] as const;

export const DEFAULT_RIGHT_SEGMENT_ORDER = ["request"] as const;
export const DEFAULT_SEGMENT_ORDER = [...DEFAULT_LEFT_SEGMENT_ORDER, ...DEFAULT_RIGHT_SEGMENT_ORDER] as const;
export const SEGMENT_SEPARATOR = "  >  ";

export type ContextColor = "success" | "warning" | "accent" | "error";
export type SlotKind = "oauth" | "api_key" | "local";

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

export function formatCost(cost: number, slotKind: SlotKind = "api_key"): string {
	if (slotKind === "oauth") return "(sub)";
	if (slotKind === "local") return "(local)";
	return `$${cost.toFixed(2)}`;
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
