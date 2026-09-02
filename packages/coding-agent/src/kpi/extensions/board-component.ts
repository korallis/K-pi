import type { Component } from "@earendil-works/pi-tui";
import type { BoardModel } from "./board.ts";
import { type BoardLayout, type BoardPalette, paintBoard } from "./board-frame.ts";

export interface BoardComponent extends Component {
	/** Swap the model; the next render paints it. */
	refresh(model: BoardModel): void;
	dispose(): void;
}

export interface BoardComponentOptions {
	layout: BoardLayout;
	palette: BoardPalette;
	onDispose?: () => void;
}

/**
 * The board as a TUI component: the widget above the editor and the `/kpi
 * status` overlay both draw through it. Rendering is cached per width and
 * model; a theme change reaches it as `invalidate()`, because the palette's
 * theme is a live proxy that already yields the new colours.
 */
export function createBoardComponent(model: BoardModel, options: BoardComponentOptions): BoardComponent {
	let current = model;
	let cache: { width: number; model: BoardModel; lines: string[] } | undefined;
	return {
		render(width: number): string[] {
			if (cache !== undefined && cache.width === width && cache.model === current) {
				return cache.lines;
			}
			const lines = paintBoard(current, { width, layout: options.layout, palette: options.palette });
			cache = { width, model: current, lines };
			return lines;
		},
		invalidate() {
			cache = undefined;
		},
		refresh(next: BoardModel) {
			current = next;
			cache = undefined;
		},
		dispose() {
			cache = undefined;
			options.onDispose?.();
		},
	};
}
