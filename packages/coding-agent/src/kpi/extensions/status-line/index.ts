import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";

import { readActiveJob } from "../run-store.ts";

import { type BrandPreset, renderIdleBrand, renderWorkingBrand } from "./brand.ts";
import { getFooterRouteSnapshot } from "./route-snapshot.ts";
import {
	assembleFooter,
	contextColor,
	formatKpiJob,
	leftSegmentsForPreset,
	SEGMENT_SEPARATOR,
	type StatusbarPreset,
} from "./segments.ts";

type FooterState = {
	lastRequest?: string;
	startedAt: number;
	working: boolean;
	requestRender?: () => void;
	preset: StatusbarPreset;
	brandPreset: BrandPreset;
};

const PRESET_PATTERN = /^(?:preset\s+)?(default|compact|full)$/iu;

export function registerStatusLine(pi: ExtensionAPI): void {
	let enabled = true;
	const state: FooterState = {
		startedAt: 0,
		working: false,
		preset: "default",
		brandPreset: "unicode",
	};

	pi.on("session_start", (_event, ctx) => {
		if (enabled && ctx.mode === "tui") installFooter(ctx, state);
	});

	pi.on("input", (event) => {
		if (typeof event.text === "string" && event.text.trim().length > 0) {
			state.lastRequest = event.text.trim();
		}
	});

	pi.on("agent_start", () => {
		state.working = true;
		state.startedAt = Date.now();
		state.requestRender?.();
	});

	pi.on("agent_settled", () => {
		state.working = false;
		state.requestRender?.();
	});

	pi.on("model_select", () => state.requestRender?.());

	pi.registerCommand("statusbar", {
		description: "Toggle the K-π status bar or set preset default|compact|full",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const presetMatch = PRESET_PATTERN.exec(trimmed);
			if (presetMatch !== null) {
				state.preset = presetMatch[1].toLowerCase() as StatusbarPreset;
				enabled = true;
				if (ctx.mode === "tui") {
					installFooter(ctx, state);
				}
				await publishKpiStatus(ctx, state);
				ctx.ui.notify(`K-π status bar preset ${state.preset}`, "info");
				return;
			}
			if (trimmed === "brand unicode" || trimmed === "brand nerd" || trimmed === "brand ascii") {
				state.brandPreset = trimmed.slice("brand ".length) as BrandPreset;
				if (enabled && ctx.mode === "tui") installFooter(ctx, state);
				ctx.ui.notify(`K-π brand ${state.brandPreset}`, "info");
				return;
			}
			enabled = !enabled;
			if (enabled && ctx.mode === "tui") {
				installFooter(ctx, state);
				await publishKpiStatus(ctx, state);
				ctx.ui.notify("K-π status bar enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.setStatus("kpi", undefined);
				ctx.ui.notify("Pi default footer restored", "info");
			}
		},
	});
}

async function publishKpiStatus(ctx: ExtensionContext, state: FooterState): Promise<void> {
	const jobLine = await kpiJobLine(ctx);
	if (jobLine === undefined || state.preset === "full") {
		// Full embeds kpi_job in the footer rail; clear the status slot to avoid duplication.
		if (state.preset === "full") {
			ctx.ui.setStatus("kpi", undefined);
			return;
		}
		ctx.ui.setStatus("kpi", undefined);
		return;
	}
	ctx.ui.setStatus("kpi", jobLine);
}

async function kpiJobLine(ctx: ExtensionContext): Promise<string | undefined> {
	const job = await readActiveJob(ctx.cwd);
	if (job === undefined) return undefined;
	const state = job.state;
	const mode = typeof state.mode === "string" ? state.mode : "gated";
	const round = typeof state.round === "number" ? state.round : 0;
	const maxRounds =
		typeof state.maxRounds === "number"
			? state.maxRounds
			: typeof (state.limits as { maxRounds?: number } | undefined)?.maxRounds === "number"
				? (state.limits as { maxRounds: number }).maxRounds
				: 3;
	const stage = typeof state.stage === "string" ? state.stage : "unknown";
	const paused =
		state.graph_status === "interrupted" ||
		(typeof state.pending_question === "string" && state.pending_question.trim().length > 0);
	const route = getFooterRouteSnapshot();
	return formatKpiJob({
		mode,
		round,
		maxRounds,
		stage,
		gate: paused ? "human" : "machine",
		...(route.route === undefined ? {} : { route: route.route }),
	});
}

function installFooter(ctx: ExtensionContext, state: FooterState): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		const timer = setInterval(() => {
			if (state.working) tui.requestRender();
		}, 100);
		state.requestRender = () => tui.requestRender();
		void publishKpiStatus(ctx, state);

		return {
			dispose() {
				clearInterval(timer);
				unsubscribe();
				state.requestRender = undefined;
			},
			invalidate() {},
			render(width: number): string[] {
				const context = ctx.getContextUsage();
				const route = getFooterRouteSnapshot();
				const brand = state.working
					? renderWorkingBrand(
							Date.now() - state.startedAt,
							Math.floor((Date.now() - state.startedAt) / 100),
							state.brandPreset,
						)
					: renderIdleBrand(state.brandPreset);

				// Synchronous path only — job line is published via setStatus asynchronously.
				const assembled = assembleFooter({
					brand,
					model: ctx.model?.name,
					thinking: ctx.thinkingLevel,
					path: ctx.cwd,
					git: footerData.getGitBranch(),
					contextPercent: context?.percent,
					contextWindow: context?.contextWindow,
					cost: sessionCost(ctx),
					slotKind: route.slotKind,
					remainingPercent: route.remainingPercent,
					request: state.lastRequest,
					preset: state.preset,
					width,
				});

				const leftIds = leftSegmentsForPreset(state.preset);
				const segmentText = assembled.segments;
				const left = leftIds
					.flatMap((id) => {
						const text = segmentText[id];
						if (!text) return [];
						if (id === "brand" || id === "model") return [theme.fg("accent", text)];
						if (id === "git") return [theme.fg("success", text)];
						if (id === "context_pct" && context?.percent != null) {
							return [theme.fg(contextColor(context.percent), text)];
						}
						if (id === "cost") return [theme.fg("warning", text)];
						return [theme.fg("text", text)];
					})
					.join(theme.fg("dim", SEGMENT_SEPARATOR));

				const request = assembled.segments.request;
				if (!request) return [truncateToWidth(left, width)];

				const right = theme.fg("muted", request);
				const padding = width - visibleWidth(left) - visibleWidth(right);
				return padding >= 4 ? [left + " ".repeat(padding) + right] : [truncateToWidth(left, width)];
			},
		};
	});
}

function sessionCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			cost += (entry.message as AssistantMessage).usage.cost.total;
		}
	}
	return cost;
}

export { getFooterRouteSnapshot, resetFooterRouteSnapshot, setFooterRouteSnapshot } from "./route-snapshot.ts";
export { assembleFooter, formatCost, formatKpiJob, formatUsage } from "./segments.ts";
