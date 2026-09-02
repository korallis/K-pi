import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";

import { readLiveJob } from "../run-store.ts";

import { type BrandPreset, renderIdleBrand, renderWorkingBrand } from "./brand.ts";
import { getFooterRouteSnapshot, setFooterRouteChangeListener } from "./route-snapshot.ts";
import {
	assembleFooter,
	contextColor,
	formatKpiJob,
	formatStatusRow,
	type KpiJobFields,
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
	/** Refreshed job fields for footer assembly; full embeds, default/compact second line. */
	kpiJob?: KpiJobFields;
};

const PRESET_PATTERN = /^(?:preset\s+)?(default|compact|full)$/iu;

function kpiJobSnapshotEqual(left: KpiJobFields | undefined, right: KpiJobFields | undefined): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	return (
		left.mode === right.mode &&
		left.round === right.round &&
		left.maxRounds === right.maxRounds &&
		left.stage === right.stage &&
		left.gate === right.gate &&
		left.ac === right.ac
	);
}

/**
 * Job fields for display: cached loop/stage/gate plus the current route snapshot.
 * Route/usage can change on failover without a job-field refresh.
 */
export function kpiJobWithLiveRoute(job: KpiJobFields | undefined): KpiJobFields | undefined {
	if (job === undefined) return undefined;
	const route = getFooterRouteSnapshot();
	const next: KpiJobFields = {
		mode: job.mode,
		round: job.round,
		maxRounds: job.maxRounds,
		stage: job.stage,
		gate: job.gate,
		...(job.ac === undefined ? {} : { ac: job.ac }),
		...(route.route === undefined ? {} : { route: route.route }),
	};
	return next;
}

/** Load active-job fields into FooterState. Requests render when the snapshot changes. */
export async function refreshFooterJobFields(ctx: ExtensionContext, state: FooterState): Promise<void> {
	const next = await loadKpiJobFields(ctx);
	if (!kpiJobSnapshotEqual(state.kpiJob, next)) {
		state.kpiJob = next;
		state.requestRender?.();
	} else {
		state.kpiJob = next;
	}
}

/**
 * Cosmetic footer work must never take down a session; still record why it
 * failed. A context that went stale while the refresh was in flight is not a
 * failure: the session was replaced, and its own `session_start` reinstalls the
 * footer with a live context.
 */
function noteFooterFailure(phase: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (/ctx is stale/u.test(message)) return;
	console.warn(`[kpi/status-line] ${phase} failed: ${message}`);
}

async function loadKpiJobFields(ctx: ExtensionContext): Promise<KpiJobFields | undefined> {
	const job = await readLiveJob(ctx.cwd);
	if (job === undefined) return undefined;
	const runState = job.state;
	const mode = typeof runState.mode === "string" ? runState.mode : "gated";
	const round = typeof runState.round === "number" ? runState.round : 0;
	const maxRounds =
		typeof runState.maxRounds === "number"
			? runState.maxRounds
			: typeof (runState.limits as { maxRounds?: number } | undefined)?.maxRounds === "number"
				? (runState.limits as { maxRounds: number }).maxRounds
				: 3;
	const stage = typeof runState.stage === "string" ? runState.stage : "unknown";
	const paused =
		runState.graph_status === "interrupted" ||
		(typeof runState.pending_question === "string" && runState.pending_question.trim().length > 0);
	// Route is applied at render/publish time from the live snapshot — not cached here.
	return {
		mode,
		round,
		maxRounds,
		stage,
		gate: paused ? "human" : "machine",
	};
}

export function registerStatusLine(pi: ExtensionAPI): void {
	let enabled = true;
	const state: FooterState = {
		startedAt: 0,
		working: false,
		preset: "default",
		brandPreset: "unicode",
	};

	pi.on("session_start", (_event, ctx) => {
		if (enabled && ctx.mode === "tui") {
			installFooter(ctx, state);
			void refreshFooterJobFields(ctx, state)
				.then(() => publishKpiStatus(ctx, state))
				.catch((error) => noteFooterFailure("session_start refresh", error));
		}
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

	pi.on("agent_settled", (_event, ctx) => {
		state.working = false;
		// The footer only exists in the TUI; print and JSON sessions have nowhere
		// to publish to, and are replaced under this handler's feet.
		if (!enabled || ctx.mode !== "tui") return;
		void refreshFooterJobFields(ctx, state)
			.then(() => {
				void publishKpiStatus(ctx, state).catch((error) => noteFooterFailure("agent_settled publish", error));
				state.requestRender?.();
			})
			.catch((error) => noteFooterFailure("agent_settled refresh", error));
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
				await refreshFooterJobFields(ctx, state);
				if (ctx.mode === "tui") {
					installFooter(ctx, state);
				}
				await publishKpiStatus(ctx, state);
				state.requestRender?.();
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
				await refreshFooterJobFields(ctx, state);
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
	await refreshFooterJobFields(ctx, state);
	const job = kpiJobWithLiveRoute(state.kpiJob);
	if (job === undefined || state.preset === "full") {
		// Full embeds kpi_job in the footer rail; clear the status slot to avoid duplication.
		ctx.ui.setStatus("kpi", undefined);
		return;
	}
	ctx.ui.setStatus("kpi", formatKpiJob(job));
}

function installFooter(ctx: ExtensionContext, state: FooterState): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		const timer = setInterval(() => {
			if (state.working) tui.requestRender();
		}, 100);
		state.requestRender = () => tui.requestRender();
		setFooterRouteChangeListener(() => {
			void publishKpiStatus(ctx, state).catch((error) => noteFooterFailure("route-change publish", error));
			tui.requestRender();
		});
		void publishKpiStatus(ctx, state).catch((error) => noteFooterFailure("footer install publish", error));

		return {
			dispose() {
				clearInterval(timer);
				unsubscribe();
				state.requestRender = undefined;
				setFooterRouteChangeListener(undefined);
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

				const kpiJob = kpiJobWithLiveRoute(state.kpiJob);
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
					...(kpiJob === undefined ? {} : { kpiJob }),
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
						if (id === "kpi_job") return [theme.fg("text", text)];
						return [theme.fg("text", text)];
					})
					.join(theme.fg("dim", SEGMENT_SEPARATOR));

				const request = assembled.segments.request;
				const rail =
					request === undefined || request.length === 0
						? truncateToWidth(left, width)
						: (() => {
								const right = theme.fg("muted", request);
								const padding = width - visibleWidth(left) - visibleWidth(right);
								return padding >= 4 ? left + " ".repeat(padding) + right : truncateToWidth(left, width);
							})();

				// Replacing Pi's footer took its extension-status row with it, and
				// this extension publishes into that row itself - `publishKpiStatus`
				// even clears the slot for the `full` preset to avoid duplicating
				// what the rail already shows. Without this the accounts widget, and
				// the job line for every other preset, are written and never drawn.
				const statusRow = formatStatusRow(footerData.getExtensionStatuses(), state.preset);
				return statusRow === undefined ? [rail] : [rail, truncateToWidth(theme.fg("muted", statusRow), width)];
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
export type { KpiJobFields, StatusbarPreset } from "./segments.ts";
export { assembleFooter, formatCost, formatKpiJob, formatUsage } from "./segments.ts";
