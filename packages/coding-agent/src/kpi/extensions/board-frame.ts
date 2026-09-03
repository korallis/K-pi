/**
 * Paints the operator board: box-drawing frames, cell rows, and theme colour
 * over the regions `board.ts` builds. Measures plain text only; colour is
 * applied to finished, padded segments so no escape sequence ever reaches the
 * width arithmetic. No file or model access.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "../../modes/interactive/theme/theme.ts";
import {
	type BoardCell,
	type BoardModel,
	type BoardRegions,
	buildBoardRegions,
	type CellsRegion,
	fitBoard,
	flattenRegions,
	type Region,
	type Row,
	type RowsRegion,
	rowText,
	type Span,
	type StripRegion,
	type Tone,
	truncatePlain,
} from "./board.ts";

export interface BoardPalette {
	paint(tone: Tone, text: string): string;
}

/** No colour at all: what tests compare against and what non-TUI surfaces get. */
export const PLAIN_PALETTE: BoardPalette = { paint: (_tone, text) => text };

/** Every tone is a key both K-π themes define, so `fg` never throws. */
export function paletteFromTheme(theme: { fg(color: ThemeColor, text: string): string }): BoardPalette {
	return { paint: (tone, text) => (text.length === 0 ? text : theme.fg(tone, text)) };
}

export type BoardLayout = "compact" | "full";

export interface PaintOptions {
	width: number;
	layout: BoardLayout;
	palette?: BoardPalette;
	/** Below this many columns the board falls back to coloured flat rows. */
	frameMinWidth?: number;
	/** Below this many columns two-column regions stack instead. */
	columnsMinWidth?: number;
}

const DEFAULT_FRAME_MIN_WIDTH = 70;
const DEFAULT_COLUMNS_MIN_WIDTH = 100;
const STRIP_SEPARATOR = " │ ";

function pad(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? text + " ".repeat(missing) : text;
}

function fitWidth(text: string, width: number): string {
	return pad(truncatePlain(text, width), width);
}

function center(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	if (missing <= 0) return fitWidth(text, width);
	const left = Math.floor(missing / 2);
	return " ".repeat(left) + text + " ".repeat(missing - left);
}

/** A row painted span by span when it fits, else truncated in one tone. */
function paintRow(row: Row, width: number, palette: BoardPalette, fallback: Tone = "text"): string {
	const plain = rowText(row);
	if (visibleWidth(plain) > width) {
		return palette.paint(fallback, fitWidth(plain, width));
	}
	const painted = row.map((span) => palette.paint(span.tone ?? fallback, span.text)).join("");
	return painted + " ".repeat(width - visibleWidth(plain));
}

/**
 * A row painted span by span, dropping `optional` spans right-to-left when it
 * would otherwise overflow — MODEL, then ▸ lastTool, then run n for the NOW
 * row — before ever falling back to `paintRow`'s ellipsis truncation. A row
 * with no optional spans left that still overflows truncates exactly as
 * `paintRow` would.
 */
export function paintShrinkingRow(row: Row, width: number, palette: BoardPalette): string {
	let candidate = row;
	while (visibleWidth(rowText(candidate)) > width) {
		let lastOptional = -1;
		for (let index = candidate.length - 1; index >= 0; index -= 1) {
			if (candidate[index]?.optional === true) {
				lastOptional = index;
				break;
			}
		}
		if (lastOptional === -1) {
			break;
		}
		candidate = candidate.filter((_, index) => index !== lastOptional);
	}
	return paintRow(candidate, width, palette);
}

function wrapWords(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/u).filter((part) => part.length > 0)) {
		const candidate = current.length === 0 ? word : `${current} ${word}`;
		if (current.length > 0 && visibleWidth(candidate) > width) {
			lines.push(current);
			current = word;
			continue;
		}
		current = candidate;
	}
	if (current.length > 0) lines.push(current);
	return lines.length === 0 ? [""] : lines;
}

/**
 * A titled box. The title sits on the first inner line in accent, the rows
 * below it; every emitted line is exactly `width` wide.
 */
export function framePanel(
	region: Pick<RowsRegion, "title" | "rows" | "frame">,
	width: number,
	palette: BoardPalette,
): string[] {
	const borderTone: Tone = region.frame === "accent" ? "borderAccent" : "border";
	const inner = Math.max(1, width - 4);
	const bar = palette.paint(borderTone, "│");
	const line = (content: string) => `${bar} ${content} ${bar}`;
	const lines = [palette.paint(borderTone, `┌${"─".repeat(width - 2)}┐`)];
	if (region.title !== undefined) {
		lines.push(line(palette.paint("accent", fitWidth(region.title, inner))));
	}
	for (const row of region.rows) {
		const plain = rowText(row);
		if (visibleWidth(plain) > inner && row.length === 1) {
			// A long single-tone row (an operator question) wraps rather than
			// disappearing behind an ellipsis.
			const tone = row[0]?.tone ?? "text";
			for (const part of wrapWords(plain, inner)) {
				lines.push(line(palette.paint(tone, pad(part, inner))));
			}
			continue;
		}
		lines.push(line(paintRow(row, inner, palette)));
	}
	lines.push(palette.paint(borderTone, `└${"─".repeat(width - 2)}┘`));
	return lines;
}

interface CellRowLayout {
	perRow: number;
	cellInner: number;
}

/**
 * How many cells fit on one row, and how wide each is. Rows are balanced (8
 * stages at 80 columns are 4 + 4, never 6 + 2) and stretched to fill the width.
 */
function cellLayout(cells: readonly BoardCell[], width: number, lines: (cell: BoardCell) => string[]): CellRowLayout {
	const widest = Math.max(...cells.map((cell) => Math.max(...lines(cell).map((text) => visibleWidth(text)))));
	const fitting = (natural: number) => Math.min(cells.length, Math.max(1, Math.floor((width - 1) / (natural + 1))));
	const rowsFor = (natural: number) => Math.ceil(cells.length / fitting(natural));
	// Padded cells first; unpadded cells whenever that saves a whole row.
	const natural = rowsFor(widest) < rowsFor(widest + 2) ? widest : widest + 2;
	const perRow = Math.ceil(cells.length / rowsFor(natural));
	const cellInner = Math.max(natural, Math.floor((width - (perRow + 1)) / perRow));
	return { perRow, cellInner };
}

/** The longest detail form that fits the cell; only the shortest is ever cut. */
function fitDetail(forms: readonly string[], cellInner: number): string {
	const fitting = forms.find((form) => visibleWidth(form) <= cellInner);
	return fitting ?? truncatePlain(forms.at(-1) ?? "", cellInner);
}

function junctionTone(left: BoardCell | undefined, right: BoardCell | undefined): Tone {
	if (right?.lit) return right.borderTone;
	if (left?.lit) return left.borderTone;
	return left?.borderTone ?? right?.borderTone ?? "border";
}

function borderLine(
	cells: readonly BoardCell[],
	cellInner: number,
	glyphs: [string, string, string],
	palette: BoardPalette,
): string {
	const [open, join, close] = glyphs;
	let out = palette.paint(junctionTone(undefined, cells[0]), open);
	cells.forEach((cell, index) => {
		out += palette.paint(cell.borderTone, "─".repeat(cellInner));
		const next = cells[index + 1];
		out += palette.paint(junctionTone(cell, next), next === undefined ? close : join);
	});
	return out;
}

function textLine(cells: readonly BoardCell[], cellInner: number, texts: string[], palette: BoardPalette): string {
	let out = palette.paint(junctionTone(undefined, cells[0]), "│");
	cells.forEach((cell, index) => {
		out += palette.paint(cell.tone, center(texts[index] ?? "", cellInner));
		out += palette.paint(junctionTone(cell, cells[index + 1]), "│");
	});
	return out;
}

/**
 * A row (or balanced rows) of bordered cells: `┌─┬─┐ │ │ └─┴─┘`, the lit cell's
 * border in accent. A row that does not fill the width is padded on the right.
 */
export function frameCells(
	region: Pick<CellsRegion, "title" | "cells">,
	width: number,
	layout: "full" | "compact",
	palette: BoardPalette,
): string[] {
	// Compact cells fold the id and label onto one line and keep the status
	// below it; when that still needs two rows, one-line cells are tried and the
	// shorter of the two boards wins. A cell with live activity carries one more
	// line — DONE/CURRENT/PENDING content per the 2026-09-03 product decision —
	// in every layout. Cells are sized from their label lines alone and the
	// detail takes its longest form that fits the cell (`fitDetail`), so a long
	// tool target never widens a cell or wraps the rail in either layout.
	const twoLine = (cell: BoardCell) =>
		cell.lines.length > 2 ? [cell.lines.slice(0, -1).join(" "), cell.lines.at(-1) ?? ""] : cell.lines;
	const oneLine = (cell: BoardCell) => [cell.compact];
	const detailLines = region.cells.some((cell) => cell.detail !== undefined) ? 1 : 0;
	let labelsOf = layout === "full" ? (cell: BoardCell) => cell.lines : twoLine;
	let { perRow, cellInner } = cellLayout(region.cells, width, labelsOf);
	if (layout === "compact" && perRow < region.cells.length) {
		const single = cellLayout(region.cells, width, oneLine);
		const rowsOf = (per: number) => Math.ceil(region.cells.length / per);
		// Each rail row costs its body lines plus two borders.
		if (rowsOf(single.perRow) * (3 + detailLines) < rowsOf(perRow) * (4 + detailLines)) {
			labelsOf = oneLine;
			({ perRow, cellInner } = single);
		}
	}
	const bodyOf = (cell: BoardCell) =>
		cell.detail === undefined ? labelsOf(cell) : [...labelsOf(cell), fitDetail(cell.detail, cellInner)];
	const out: string[] = [];
	if (layout === "full") {
		out.push(palette.paint("accent", fitWidth(region.title, width)));
	}
	for (let start = 0; start < region.cells.length; start += perRow) {
		const row = region.cells.slice(start, start + perRow);
		const height = Math.max(...row.map((cell) => bodyOf(cell).length));
		out.push(pad(borderLine(row, cellInner, ["┌", "┬", "┐"], palette), width));
		for (let line = 0; line < height; line += 1) {
			out.push(
				pad(
					textLine(
						row,
						cellInner,
						row.map((cell) => bodyOf(cell)[line] ?? ""),
						palette,
					),
					width,
				),
			);
		}
		out.push(pad(borderLine(row, cellInner, ["└", "┴", "┘"], palette), width));
	}
	return out;
}

/** The header: segments joined by thin rules, boxed in the full layout. */
export function frameStrip(strip: StripRegion, width: number, palette: BoardPalette, boxed: boolean): string[] {
	const inner = boxed ? width - 4 : width;
	const separator = palette.paint("dim", STRIP_SEPARATOR);
	// The job id gives way first; MODE and ROUND never do.
	const segments = strip.segments.map((segment) => ({ ...segment }));
	const plainWidth = () =>
		segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0) +
		STRIP_SEPARATOR.length * Math.max(0, segments.length - 1);
	const job = segments.find((segment) => segment.text.startsWith("JOB "));
	if (job !== undefined && plainWidth() > inner) {
		const spare = Math.max(6, visibleWidth(job.text) - (plainWidth() - inner));
		job.text = truncatePlain(job.text, spare);
	}
	const painted = segments.map((segment) => palette.paint(segment.tone ?? "text", segment.text)).join(separator);
	const line = pad(plainWidth() <= inner ? painted : palette.paint("text", fitWidth(rowText(segments), inner)), inner);
	if (!boxed) return [line];
	const bar = palette.paint("border", "│");
	return [
		palette.paint("border", `┌${"─".repeat(width - 2)}┐`),
		`${bar} ${line} ${bar}`,
		palette.paint("border", `└${"─".repeat(width - 2)}┘`),
	];
}

/** Two blocks beside each other; the shorter one is padded with blank lines. */
export function sideBySide(left: string[], right: string[], leftWidth: number, gap: number): string[] {
	const height = Math.max(left.length, right.length);
	const rightWidth = Math.max(...right.map((line) => visibleWidth(line)), 0);
	const out: string[] = [];
	for (let index = 0; index < height; index += 1) {
		out.push(`${pad(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${pad(right[index] ?? "", rightWidth)}`);
	}
	return out;
}

function stopBox(text: string, tone: Tone, palette: BoardPalette): string[] {
	const inner = visibleWidth(text) + 2;
	return [
		palette.paint(tone, `┌${"─".repeat(inner)}┐`),
		`${palette.paint(tone, "│")} ${palette.paint(tone, text)} ${palette.paint(tone, "│")}`,
		palette.paint(tone, `└${"─".repeat(inner)}┘`),
	];
}

/** Blank lines placed left of a right-aligned block. */
function rightAlign(block: string[], width: number): string[] {
	return block.map((line) => " ".repeat(Math.max(0, width - visibleWidth(line))) + line);
}

/** Coloured flat rows for terminals too narrow for frames. */
export function paintFlat(regions: BoardRegions, width: number, palette: BoardPalette): string[] {
	const toneFor = (line: string): Tone => {
		if (line.startsWith("K-π")) return "accent";
		if (line.startsWith("STOP ") && !line.startsWith("STOP STATES"))
			return regions.byId.stop?.kind === "stop" ? regions.byId.stop.tone : "warning";
		if (line.includes("CURRENT") || line.startsWith("WAITING ON OPERATOR") || line.startsWith("HUMAN OVERSIGHT"))
			return "accent";
		if (line.includes("EVENTS ✕")) return "error";
		if (line.startsWith("NOW ")) return "text";
		return "text";
	};
	return fitBoard(flattenRegions(regions), width).map((line) => palette.paint(toneFor(line), line));
}

function rowsOf(region: Region | undefined): RowsRegion | undefined {
	return region?.kind === "rows" ? region : undefined;
}

function cellsOf(region: Region | undefined): CellsRegion | undefined {
	return region?.kind === "cells" ? region : undefined;
}

function telemetryBlock(regions: BoardRegions, width: number, palette: BoardPalette, layout: BoardLayout): string[] {
	const lines: string[] = [];
	const telemetry = rowsOf(regions.byId.telemetry);
	if (telemetry !== undefined) {
		for (const row of telemetry.rows) lines.push(paintRow(row, width, palette));
	}
	if (layout !== "compact") {
		const now = rowsOf(regions.byId.now);
		if (now !== undefined && now.rows[0] !== undefined) {
			lines.push(paintShrinkingRow(now.rows[0], width, palette));
		}
	}
	if (layout === "compact") {
		const iteration = rowsOf(regions.byId.iteration);
		if (iteration !== undefined) {
			// ROUND, PASS/FAIL and FINGERPRINT share one line; a RETRY row is a
			// wait the operator is watching and keeps its own line, so the STOP
			// box stays beside the block while a node backs off.
			const spans: Row = [];
			const retries: Row[] = [];
			for (const row of iteration.rows) {
				if (row[0]?.text.startsWith("RETRY ")) {
					retries.push(row);
					continue;
				}
				if (spans.length > 0) spans.push({ text: "  " });
				spans.push(...row);
			}
			lines.push(paintRow(spans, width, palette));
			for (const row of retries) lines.push(paintRow(row, width, palette));
		}
		const waiting = rowsOf(regions.byId.waiting);
		if (waiting !== undefined) {
			// The question wraps under its label rather than being cut: it is the
			// one thing a paused board must get across.
			const label = "WAITING ON OPERATOR  ";
			const question = waiting.rows[0] === undefined ? "" : rowText(waiting.rows[0]);
			const parts = wrapWords(question, Math.max(8, width - label.length));
			parts.forEach((part, index) => {
				lines.push(
					paintRow(
						index === 0
							? [
									{ text: "WAITING ON OPERATOR", tone: "accent" },
									{ text: `  ${part}`, tone: "text" },
								]
							: [{ text: " ".repeat(label.length) }, { text: part, tone: "text" }],
						width,
						palette,
					),
				);
			});
		} else {
			const context = rowsOf(regions.byId.contextLayer);
			const summary = context?.rows.at(-1);
			const lamps = context?.rows[0];
			if (lamps !== undefined && summary !== undefined) {
				lines.push(
					paintRow([{ text: "CONTEXT ", tone: "muted" }, ...lamps, { text: "  " }, ...summary], width, palette),
				);
			}
		}
		const now = rowsOf(regions.byId.now);
		if (now !== undefined && now.rows[0] !== undefined) {
			lines.push(paintShrinkingRow(now.rows[0], width, palette));
		}
		const stopStates = cellsOf(regions.byId.stopStates);
		if (stopStates !== undefined) {
			lines.push(paintRow([{ text: "STOP STATES  ", tone: "text" }, ...stopStates.compactRow], width, palette));
		}
	}
	return lines;
}

/** The telemetry rows beside the STOP box; stacked when the row is too narrow for both. */
function telemetryWithStop(regions: BoardRegions, width: number, palette: BoardPalette): string[] {
	const stop = regions.byId.stop;
	if (stop?.kind !== "stop") return telemetryBlock(regions, width, palette, "compact");
	const box = stopBox(stop.text, stop.tone, palette);
	const boxWidth = visibleWidth(stop.text) + 4;
	const leftWidth = width - boxWidth - 2;
	// Beside the box only when nothing the operator scans for would be cut;
	// the question wraps, so only a truncated row forces the box below.
	const cut = telemetryBlock(regions, leftWidth, PLAIN_PALETTE, "compact").some((line) =>
		line.trimEnd().endsWith("…"),
	);
	if (leftWidth < 24 || cut) {
		return [...telemetryBlock(regions, width, palette, "compact"), ...rightAlign(box, width)];
	}
	return sideBySide(telemetryBlock(regions, leftWidth, palette, "compact"), box, leftWidth, 2);
}

/** A row of lamps folds onto further rows rather than being cut; every lamp keeps its name. */
function foldRow(prefix: Span, items: readonly Span[], width: number, palette: BoardPalette): string[] {
	const indent = " ".repeat(visibleWidth(prefix.text));
	const rows: Row[] = [];
	let current: Row = [prefix];
	let used = visibleWidth(prefix.text);
	for (const item of items) {
		const text = item.text.trimStart();
		const spacer = current.length === 1 ? "" : "  ";
		if (current.length > 1 && used + visibleWidth(spacer + text) > width) {
			rows.push(current);
			current = [{ text: indent }];
			used = indent.length;
			current.push({ text, tone: item.tone });
			used += visibleWidth(text);
			continue;
		}
		current.push({ text: `${spacer}${text}`, tone: item.tone });
		used += visibleWidth(spacer + text);
	}
	rows.push(current);
	return rows.map((row) => paintRow(row, width, palette));
}

function paintCompact(regions: BoardRegions, width: number, palette: BoardPalette): string[] {
	const out: string[] = [];
	const header = regions.byId.header;
	if (header?.kind === "strip") out.push(...frameStrip(header, width, palette, false));
	const stages = cellsOf(regions.byId.stages);
	if (stages !== undefined) out.push(...frameCells(stages, width, "compact", palette));
	const lamps = cellsOf(regions.byId.lamps);
	if (lamps !== undefined) {
		out.push(...foldRow({ text: "FILES  ", tone: "text" }, lamps.compactRow, width, palette));
	}
	out.push(...telemetryWithStop(regions, width, palette));
	return out;
}

function paintColumns(left: string[], right: string[] | undefined, width: number, columnsMinWidth: number): string[] {
	if (right === undefined) return left;
	if (width < columnsMinWidth) return [...left, ...right];
	const leftWidth = Math.floor((width - 2) * 0.4);
	return sideBySide(left, right, leftWidth, 2);
}

function paintFull(regions: BoardRegions, width: number, palette: BoardPalette, columnsMinWidth: number): string[] {
	const columnWidths =
		width < columnsMinWidth
			? [width, width]
			: [Math.floor((width - 2) * 0.4), width - 2 - Math.floor((width - 2) * 0.4)];
	const out: string[] = [];
	const header = regions.byId.header;
	if (header?.kind === "strip") out.push(...frameStrip(header, width, palette, true));
	out.push(...telemetryBlock(regions, width, palette, "full"));
	const context = rowsOf(regions.byId.contextLayer);
	if (context !== undefined) out.push(...framePanel(context, width, palette));
	const stages = cellsOf(regions.byId.stages);
	if (stages !== undefined) out.push(...frameCells(stages, width, "full", palette));
	const nodeDetail = rowsOf(regions.byId.nodeDetail);
	if (nodeDetail !== undefined) out.push(...framePanel(nodeDetail, width, palette));
	const iteration = rowsOf(regions.byId.iteration);
	const oversight = rowsOf(regions.byId.oversight);
	if (iteration !== undefined) {
		const left = framePanel(iteration, oversight === undefined ? width : columnWidths[0], palette);
		const right = oversight === undefined ? undefined : framePanel(oversight, columnWidths[1], palette);
		out.push(...paintColumns(left, right, width, columnsMinWidth));
	}
	const lamps = cellsOf(regions.byId.lamps);
	if (lamps !== undefined) out.push(...frameCells(lamps, width, "full", palette));
	const stopStates = cellsOf(regions.byId.stopStates);
	const laws = rowsOf(regions.byId.threeLaws);
	if (stopStates !== undefined && laws !== undefined) {
		const left = frameCells(stopStates, width < columnsMinWidth ? width : columnWidths[0], "full", palette);
		const right = framePanel(laws, columnWidths[1], palette);
		out.push(...paintColumns(left, right, width, columnsMinWidth));
	}
	const waiting = rowsOf(regions.byId.waiting);
	if (waiting !== undefined) out.push(...framePanel(waiting, width, palette));
	const stop = regions.byId.stop;
	if (stop?.kind === "stop") out.push(...rightAlign(stopBox(stop.text, stop.tone, palette), width));
	const keys = rowsOf(regions.byId.keys);
	if (keys !== undefined) {
		for (const row of keys.rows) out.push(paintRow(row, width, palette));
	}
	return out.map((line) => pad(line, width));
}

export function paintRegions(regions: BoardRegions, options: PaintOptions): string[] {
	const palette = options.palette ?? PLAIN_PALETTE;
	const width = Math.max(1, Math.floor(options.width));
	if (width < (options.frameMinWidth ?? DEFAULT_FRAME_MIN_WIDTH)) {
		return paintFlat(regions, width, palette);
	}
	const columnsMinWidth = options.columnsMinWidth ?? DEFAULT_COLUMNS_MIN_WIDTH;
	return options.layout === "compact"
		? paintCompact(regions, width, palette)
		: paintFull(regions, width, palette, columnsMinWidth);
}

/** Board A or Board B, framed and coloured for `width` columns. */
export function paintBoard(model: BoardModel, options: PaintOptions): string[] {
	return paintRegions(buildBoardRegions(model), options);
}
