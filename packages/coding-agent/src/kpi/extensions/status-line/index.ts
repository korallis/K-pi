import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";

import { renderIdleBrand, renderWorkingBrand } from "./brand.ts";
import {
	contextColor,
	DEFAULT_LEFT_SEGMENT_ORDER,
	formatContext,
	formatCost,
	formatGit,
	formatModel,
	formatPath,
	formatRequest,
	formatThinking,
	SEGMENT_SEPARATOR,
} from "./segments.ts";

type FooterState = {
	lastRequest?: string;
	startedAt: number;
	working: boolean;
	requestRender?: () => void;
};

export function registerStatusLine(pi: ExtensionAPI): void {
	let enabled = true;
	const state: FooterState = { startedAt: 0, working: false };

	pi.on("session_start", (_event, ctx) => {
		if (enabled && ctx.mode === "tui") installFooter(ctx, state);
	});

	pi.on("input", (event) => {
		if (event.source === "interactive") state.lastRequest = event.text;
		state.requestRender?.();
	});

	pi.on("agent_start", () => {
		state.startedAt = Date.now();
		state.working = true;
		state.requestRender?.();
	});

	pi.on("agent_settled", () => {
		state.working = false;
		state.requestRender?.();
	});

	pi.on("model_select", () => state.requestRender?.());

	pi.registerCommand("statusbar", {
		description: "Toggle the K-π status bar",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled && ctx.mode === "tui") {
				installFooter(ctx, state);
				ctx.ui.notify("K-π status bar enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Pi default footer restored", "info");
			}
		},
	});
}

function installFooter(ctx: ExtensionContext, state: FooterState): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		const timer = setInterval(() => {
			if (state.working) tui.requestRender();
		}, 100);
		state.requestRender = () => tui.requestRender();

		return {
			dispose() {
				clearInterval(timer);
				unsubscribe();
				state.requestRender = undefined;
			},
			invalidate() {},
			render(width: number): string[] {
				const context = ctx.getContextUsage();
				const contextPercent = context?.percent;
				const segmentText = {
					brand: state.working
						? renderWorkingBrand(Date.now() - state.startedAt, Math.floor((Date.now() - state.startedAt) / 100))
						: renderIdleBrand(),
					model: formatModel(ctx.model?.name),
					thinking: formatThinking(ctx.thinkingLevel),
					path: formatPath(ctx.cwd),
					git: formatGit(footerData.getGitBranch()),
					context_pct: formatContext(contextPercent, context?.contextWindow),
					cost: formatCost(sessionCost(ctx)),
				};

				const left = DEFAULT_LEFT_SEGMENT_ORDER.flatMap((id) => {
					const text = segmentText[id];
					if (!text) return [];
					if (id === "brand" || id === "model") return [theme.fg("accent", text)];
					if (id === "git") return [theme.fg("success", text)];
					if (id === "context_pct" && contextPercent != null) {
						return [theme.fg(contextColor(contextPercent), text)];
					}
					if (id === "cost") return [theme.fg("warning", text)];
					return [theme.fg("text", text)];
				}).join(theme.fg("dim", SEGMENT_SEPARATOR));

				const request = formatRequest(state.lastRequest);
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
