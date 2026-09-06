import type { Component } from "@earendil-works/pi-tui";
import { type BoardModel, type NodeDetail, resolveCurrentStageIndex } from "./board.ts";
import type { ActivitySnapshot } from "./board-activity.ts";
import type { BoardPalette } from "./board-frame.ts";
import {
	type CentreJob,
	type CentreState,
	clampStage,
	jobGroup,
	jobNeedsHuman,
	type RunFileRow,
	renderCommandCentre,
	resolveKey,
	roundSpans,
	type TranscriptEntry,
} from "./command-centre.ts";
import { BOARD_TICK_MS, type Ticker } from "./control-plane.ts";

export type { RunFileRow, TranscriptEntry } from "./command-centre.ts";

export interface CommandCentreSources {
	jobId: string;
	runDirectory: string;
	/** The live-worker cap the `WORKERS <w>/<cap>` row is drawn against. */
	workerCap: number;
	/** Same builder the widget ticks (control-plane buildBoardModel with the job's activity reader, surface "overlay"); undefined when the job is gone. */
	readModel(): Promise<BoardModel | undefined>;
	/** Native discovery supplies real snapshots. Opening transfers to that job's own sources. */
	fleet?: {
		read(): Promise<readonly CentreJob[]>;
		open(jobId: string): Promise<void>;
	};
	/** The activity snapshot produced by the latest readModel(). */
	activity(): ActivitySnapshot | undefined;
	readNodeDetail(stage: number): Promise<NodeDetail>;
	/** Newest `limit` entries of the stage's node session, oldest first. Missing → []. Unreadable → throws with a code the view paints. */
	readTranscript(stage: number, limit: number): Promise<TranscriptEntry[]>;
	/** task.json, context.md, candidate.json, evidence.json, verdict.json, events.jsonl. */
	readRunFiles(): Promise<RunFileRow[]>;
	/** CONTEXT LAYER route line; "—" when unknown. */
	route(): string;
	/** Exactly what `/kpi stop` does. */
	stop(): Promise<void>;
	/** Exactly what `/kpi verify` reports, one line. */
	verify(): Promise<string>;
	/** ctx.sendUserMessage(text); the view closes first. */
	chat(text: string): Promise<void>;
	now(): number;
	tick: Ticker;
}

export interface CommandCentreOptions {
	palette: BoardPalette;
	sources: CommandCentreSources;
	/** Closes the overlay. */
	done: () => void;
	/** tui.requestRender */
	requestRender: () => void;
	/** () => tui.terminal.rows */
	rows: () => number;
}

/** The overlay component: a TUI Component that also stops its ticker and exposes its in-flight reads. */
export type CommandCentre = Component & { dispose(): void; settled(): Promise<void> };

/** How many session entries the view keeps per read: enough for the tallest SESSION panel. */
const TRANSCRIPT_LIMIT = 200;
/** Run files and the cost sample are re-read every this many ticks. */
const FULL_REFRESH_EVERY = 5;
const COST_SAMPLES = 10;

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string" && code.length > 0) return code;
	return error instanceof Error ? error.message : String(error);
}

function loadErrorDetail(node: string, error: unknown): NodeDetail {
	return { node, status: "pending", runs: 0, toolsByName: {}, loadError: errorCode(error) };
}

/**
 * `/kpi status` in the TUI: the Command Centre. Live while the job runs — the
 * injected ticker re-reads the run files exactly like the always-on widget —
 * and usable mid-run: the input line routes `/kpi stop` and `/kpi verify` to
 * the sources and hands any other message to the chat after closing.
 */
export function createCommandCentre(options: CommandCentreOptions): CommandCentre {
	const { sources, palette } = options;
	const state: CentreState = {
		view: "home",
		selected: 0,
		jobs: [],
		selectedJob: sources.jobId,
		help: false,
		jobId: sources.jobId,
		model: undefined,
		jobGone: false,
		activity: undefined,
		transcript: [],
		transcriptError: undefined,
		files: [],
		detail: undefined,
		route: sources.route(),
		input: "",
		hint: undefined,
		refreshError: undefined,
		spinner: 0,
		costRates: [],
		nowMs: sources.now(),
		workerCap: sources.workerCap,
	};
	let version = 0;
	let cache: { width: number; rows: number; version: number; lines: string[] } | undefined;
	let disposed = false;
	let inFlight = 0;
	let ticks = 0;
	let stopTicker: (() => void) | undefined;
	let pending: Promise<void> = Promise.resolve();
	let lastSample: { atMs: number; cost: number } | undefined;

	function repaint(): void {
		version += 1;
		options.requestRender();
	}

	/** Serialises every read behind the previous one; the ticker skips while any is in flight. */
	function enqueue(work: () => Promise<void>): void {
		inFlight += 1;
		pending = pending
			.then(work)
			.catch((error: unknown) => {
				state.refreshError = errorCode(error);
			})
			.finally(() => {
				inFlight -= 1;
				if (!disposed) repaint();
			});
	}

	function sampleCost(model: BoardModel, nowMs: number): void {
		let cost: number | undefined;
		for (const record of Object.values(model.activity ?? {})) {
			if (record.costUsd !== undefined) cost = (cost ?? 0) + record.costUsd;
		}
		if (cost === undefined) return;
		if (lastSample !== undefined && nowMs > lastSample.atMs) {
			const perMinute = ((cost - lastSample.cost) / (nowMs - lastSample.atMs)) * 60_000;
			state.costRates = [...state.costRates, Math.max(0, perMinute)].slice(-COST_SAMPLES);
		}
		lastSample = { atMs: nowMs, cost };
	}

	async function readTranscript(): Promise<void> {
		try {
			state.transcript = await sources.readTranscript(state.selected, TRANSCRIPT_LIMIT);
			state.transcriptError = undefined;
		} catch (error) {
			state.transcript = [];
			state.transcriptError = errorCode(error);
		}
	}

	async function readDetail(): Promise<void> {
		if (state.view !== "session") return;
		try {
			state.detail = await sources.readNodeDetail(state.selected);
		} catch (error) {
			state.detail = loadErrorDetail(state.model?.node ?? String(state.selected), error);
		}
	}

	function endTicker(): void {
		stopTicker?.();
		stopTicker = undefined;
	}

	/**
	 * One read of everything the view shows; `full` adds the run files and a
	 * cost sample. The first read that succeeds (the open read, or the tick
	 * that recovers from an open failure) also lands on the current stage.
	 */
	async function refresh(full: boolean): Promise<void> {
		state.nowMs = sources.now();
		if (sources.fleet !== undefined) {
			state.jobs = [...(await sources.fleet.read())].sort((a, b) => jobGroup(a) - jobGroup(b));
		}
		const model = await sources.readModel();
		if (disposed) return;
		if (model === undefined) {
			state.model = undefined;
			state.jobGone = true;
			state.jobs = state.jobs.filter((job) => job.jobId !== sources.jobId);
			if (!state.jobs.some((job) => job.jobId === state.selectedJob)) {
				state.selectedJob = state.jobs[0]?.jobId ?? sources.jobId;
			}
			state.refreshError = undefined;
			if (sources.fleet === undefined) endTicker();
			return;
		}
		const first = state.model === undefined;
		state.jobGone = false;
		state.model = model;
		state.activity = sources.activity();
		state.rounds = roundSpans(state.activity?.records ?? [], state.nowMs);
		const nodeHistory = new Map<string, { retries: number; writes: string[]; denied: number }>();
		for (const record of state.activity?.records ?? []) {
			if (record.type !== "node.retry" && record.type !== "tool.request") continue;
			let history = nodeHistory.get(record.node);
			if (history === undefined) {
				history = { retries: 0, writes: [], denied: 0 };
				nodeHistory.set(record.node, history);
			}
			if (record.type === "node.retry") history.retries += 1;
			else if ((record.tool === "write" || record.tool === "edit") && typeof record.path === "string") {
				if (!history.writes.includes(record.path)) history.writes.push(record.path);
				if (record.decision === "deny") history.denied += 1;
			}
		}
		state.nodeHistory = nodeHistory;
		const discoveredLocal = state.jobs.find((job) => job.jobId === sources.jobId);
		state.jobs = [
			...state.jobs.filter((job) => job.jobId !== sources.jobId),
			{ ...discoveredLocal, jobId: sources.jobId, model },
		].sort((a, b) => jobGroup(a) - jobGroup(b));
		if (!state.jobs.some((job) => job.jobId === state.selectedJob)) state.selectedJob = sources.jobId;
		state.route = sources.route();
		state.refreshError = undefined;
		if (first) state.selected = resolveCurrentStageIndex(model.stage, model.node);
		if (full || first) {
			state.files = await sources.readRunFiles();
			sampleCost(model, state.nowMs);
		}
		await readTranscript();
		await readDetail();
		if (model.stop !== "RUNNING" && sources.fleet === undefined) endTicker();
	}

	function startTicker(): void {
		if (stopTicker !== undefined || disposed) return;
		stopTicker = sources.tick(() => {
			if (inFlight > 0 || disposed) return;
			ticks += 1;
			state.spinner += 1;
			enqueue(() => refresh(ticks % FULL_REFRESH_EVERY === 0));
		}, BOARD_TICK_MS);
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		endTicker();
		cache = undefined;
	}

	function close(): void {
		dispose();
		options.done();
	}

	function select(index: number): void {
		const next = clampStage(index);
		if (next === state.selected) return;
		state.selected = next;
		state.hint = undefined;
		enqueue(async () => {
			await readTranscript();
			await readDetail();
		});
		repaint();
	}

	function selectJob(direction: number, attention = false): void {
		const jobs = attention ? state.jobs.filter(jobNeedsHuman) : state.jobs;
		if (jobs.length === 0) {
			state.hint = { text: "Nothing is waiting for you", tone: "muted" };
			repaint();
			return;
		}
		const current = jobs.findIndex((job) => job.jobId === state.selectedJob);
		const index =
			current < 0 ? (direction > 0 ? 0 : jobs.length - 1) : (current + direction + jobs.length) % jobs.length;
		state.selectedJob = jobs[index]!.jobId;
		state.view = "home";
		state.hint = undefined;
		repaint();
	}

	/** Enter on a non-empty prompt: the two commands the centre owns, two refusals, or a chat message. */
	function submit(line: string): void {
		state.input = "";
		if (
			(line === "/kpi stop" || line === "/kpi verify") &&
			state.view === "home" &&
			state.selectedJob !== sources.jobId
		) {
			state.hint = { text: "Open the selected job before using its commands", tone: "warning" };
			repaint();
			return;
		}
		if (line === "/kpi stop") {
			enqueue(async () => {
				try {
					await sources.stop();
					state.hint = { text: "K-π stop requested", tone: "text" };
				} catch (error) {
					state.hint = { text: `K-π stop failed ✕ ${errorCode(error)}`, tone: "error" };
				}
				await refresh(true);
			});
			repaint();
			return;
		}
		if (line === "/kpi verify") {
			enqueue(async () => {
				try {
					state.hint = { text: await sources.verify(), tone: "text" };
				} catch (error) {
					state.hint = { text: `K-π verify failed ✕ ${errorCode(error)}`, tone: "error" };
				}
			});
			repaint();
			return;
		}
		if (line === "/kpi" || line.startsWith("/kpi ")) {
			state.hint = { text: `K-π ${line} is refused while a job runs; /kpi stop first`, tone: "warning" };
			repaint();
			return;
		}
		if (line.startsWith("!")) {
			state.hint = { text: "K-π bash is not available inside the command centre", tone: "warning" };
			repaint();
			return;
		}
		// Chat: the view closes first, then the message goes to the session. A
		// rejection here has no view left to paint it and would otherwise die as
		// an unhandled rejection; sendUserMessage reports its own failures.
		close();
		pending = pending.then(() => sources.chat(line)).catch(() => undefined);
	}

	// Open: one read of everything, then the ticker while the job runs. A read
	// that fails on open is painted like any refresh failure and is not
	// terminal: the job is presumed RUNNING, so the ticker retries it.
	enqueue(async () => {
		try {
			await refresh(true);
		} catch (error) {
			if (disposed) return;
			state.refreshError = errorCode(error);
			startTicker();
			return;
		}
		if (state.model?.stop === "RUNNING" || sources.fleet !== undefined) startTicker();
	});

	return {
		render(width: number): string[] {
			const rows = options.rows();
			if (cache !== undefined && cache.width === width && cache.rows === rows && cache.version === version) {
				return cache.lines;
			}
			const lines = renderCommandCentre(state, width, rows, palette);
			cache = { width, rows, version, lines };
			return lines;
		},
		handleInput(data: string): void {
			if (disposed) return;
			const key = resolveKey(data, state.input.length > 0);
			if (key === undefined) return;
			if (state.help && key.kind !== "help" && key.kind !== "escape" && key.kind !== "close") return;
			switch (key.kind) {
				case "help":
					state.help = !state.help;
					repaint();
					return;
				case "attention":
					selectJob(key.reverse ? -1 : 1, true);
					return;
				case "close":
					close();
					return;
				case "escape":
					if (state.help) {
						state.help = false;
					} else if (state.input.length > 0) {
						state.input = "";
					} else if (state.view !== "home") {
						state.view = state.view === "session" ? "details" : "home";
						state.hint = undefined;
					} else {
						close();
						return;
					}
					repaint();
					return;
				case "next":
					if (state.view === "home") selectJob(1);
					else select(state.selected + 1);
					return;
				case "previous":
					if (state.view === "home") selectJob(-1);
					else select(state.selected - 1);
					return;
				case "jump":
					if (state.view !== "home") select(key.stage);
					return;
				case "refresh":
					if (inFlight === 0) enqueue(() => refresh(true));
					return;
				case "backspace":
					state.input = [...state.input].slice(0, -1).join("");
					repaint();
					return;
				case "type":
					state.input += key.text;
					repaint();
					return;
				case "enter": {
					const line = state.input.trim();
					if (line.length > 0) {
						submit(line);
						return;
					}
					// Whitespace alone is no message; it must not linger and turn
					// q/r/1–8 into typed text.
					state.input = "";
					if (state.view === "home") {
						if (state.selectedJob !== sources.jobId && sources.fleet !== undefined) {
							const jobId = state.selectedJob;
							close();
							pending = pending.then(() => sources.fleet!.open(jobId));
							return;
						}
						if (state.model === undefined) return;
						state.view = "details";
						state.hint = undefined;
					} else if (state.view === "details") {
						state.view = "session";
						state.hint = undefined;
						enqueue(readDetail);
					}
					repaint();
					return;
				}
			}
		},
		invalidate(): void {
			cache = undefined;
		},
		dispose,
		settled(): Promise<void> {
			return pending;
		},
	};
}
