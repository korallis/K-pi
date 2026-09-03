import { type Component, matchesKey } from "@earendil-works/pi-tui";

import type { BoardModel, NodeDetail } from "./board.ts";
import { BOARD_STAGES, resolveCurrentStageIndex } from "./board.ts";
import { createBoardComponent } from "./board-component.ts";
import type { BoardPalette } from "./board-frame.ts";

export interface BoardOverlayOptions {
	palette: BoardPalette;
	model: BoardModel;
	done: () => void;
	/** Reads the NODE panel's detail for one stage. A rejection paints a load error, never throws. */
	loadDetail: (stage: number) => Promise<NodeDetail>;
}

const LAST_STAGE_INDEX = 7;

function loadErrorDetail(node: string, error: unknown): NodeDetail {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return {
		node,
		status: "unknown",
		runs: 0,
		toolsByName: {},
		loadError: code ?? (error instanceof Error ? error.message : String(error)),
	};
}

/**
 * The `/kpi status` overlay: a static full board (one read on open, one
 * detail read per Enter) with keyboard selection. It never polls — the
 * overlay is reachable only while the main input loop is idle, on a job that
 * is itself paused, so the run files it reads are not changing under it.
 */
export function createBoardOverlay(
	options: BoardOverlayOptions,
): Component & { dispose(): void; settled(): Promise<void> } {
	let selected = resolveCurrentStageIndex(options.model.stage, options.model.node);
	let detailOpen = false;
	let detail: NodeDetail | undefined;
	let pending: Promise<void> = Promise.resolve();
	const component = createBoardComponent(
		{ ...options.model, surface: "overlay", selectedStage: selected },
		{ layout: "full", palette: options.palette },
	);

	function apply(): void {
		pending = (async () => {
			if (detailOpen) {
				try {
					detail = await options.loadDetail(selected);
				} catch (error) {
					detail = loadErrorDetail(BOARD_STAGES[selected]?.key ?? options.model.node, error);
				}
			}
			component.refresh({
				...options.model,
				surface: "overlay",
				selectedStage: selected,
				...(detailOpen ? { detail } : {}),
			});
		})();
	}

	// The board opens already selected on the current stage, with the panel closed.
	apply();

	function dispose(): void {
		component.dispose();
	}

	return {
		render(width: number): string[] {
			return component.render(width);
		},
		handleInput(data: string): void {
			if (matchesKey(data, "left")) {
				selected = Math.max(0, selected - 1);
				apply();
				return;
			}
			if (matchesKey(data, "right")) {
				selected = Math.min(LAST_STAGE_INDEX, selected + 1);
				apply();
				return;
			}
			if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				detailOpen = !detailOpen;
				apply();
				return;
			}
			if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				dispose();
				options.done();
			}
		},
		invalidate(): void {
			component.invalidate();
		},
		dispose,
		settled(): Promise<void> {
			return pending;
		},
	};
}
