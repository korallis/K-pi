import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { EventRecord } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import type { BoardModel, NodeDetail } from "../packages/coding-agent/src/kpi/extensions/board.ts";
import {
	type ActivitySnapshot,
	foldActivity,
	stageActivities,
} from "../packages/coding-agent/src/kpi/extensions/board-activity.ts";
import { PLAIN_PALETTE } from "../packages/coding-agent/src/kpi/extensions/board-frame.ts";
import {
	type CommandCentre,
	type CommandCentreSources,
	createCommandCentre,
	type RunFileRow,
	type TranscriptEntry,
} from "../packages/coding-agent/src/kpi/extensions/board-overlay.ts";
import type { RunStatus } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

const JOB = "20260903-add-get-health-returning-status-ae4a7049";
const T0 = Date.parse("2026-09-03T11:45:58.000Z");
const NOW = T0 + 7 * 60_000;

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	tab: "\t",
	shiftTab: "\x1b[Z",
	enter: "\r",
	escape: "\x1b",
	backspace: "\x7f",
	ctrlC: "\x03",
} as const;

function record(partial: Partial<EventRecord> & { type: EventRecord["type"]; node: string; ts: string }): EventRecord {
	return { job_id: JOB, round: 0, prev_hash: "0".repeat(64), record_hash: "a".repeat(64), ...partial };
}

function at(offsetMs: number): string {
	return new Date(T0 + offsetMs).toISOString();
}

/** A gated run: three stages done, implement running with a retry behind it. */
function runRecords(): EventRecord[] {
	return [
		record({ type: "handoff.created", node: "ac-compiler", ts: at(0), mode: "gated" }),
		record({ type: "node.started", node: "ac-compiler", ts: at(1_000), run: 1, model: "worker-a" }),
		record({
			type: "node.finished",
			node: "ac-compiler",
			ts: at(5_000),
			run: 1,
			status: "completed",
			elapsed_ms: 4_000,
			cost_usd: 0.02,
		}),
		record({ type: "node.started", node: "specify", ts: at(6_000), run: 1 }),
		record({
			type: "tool.request",
			node: "specify",
			ts: at(8_000),
			tool: "read",
			path: "src/index.ts",
			decision: "allow",
		}),
		record({
			type: "node.finished",
			node: "specify",
			ts: at(47_000),
			run: 1,
			status: "completed",
			elapsed_ms: 41_000,
			cost_usd: 0.11,
		}),
		record({ type: "checkpoint", node: "specify", ts: at(47_500), detail: "graph/checkpoint-000002.json" }),
		record({ type: "node.started", node: "plan", ts: at(48_000), run: 1 }),
		record({
			type: "node.finished",
			node: "plan",
			ts: at(70_000),
			run: 1,
			status: "completed",
			elapsed_ms: 22_000,
			cost_usd: 0.07,
			result: "stack.json",
		}),
		record({ type: "node.started", node: "implement", ts: at(71_000), run: 1, model: "worker-b", round: 1 }),
		record({
			type: "tool.request",
			node: "implement",
			ts: at(80_000),
			tool: "write",
			path: "test/health/health.test.ts",
			decision: "allow",
		}),
		record({
			type: "node.retry",
			node: "implement",
			ts: at(90_000),
			attempt: 1,
			reason: "timeout",
			delay_ms: 2_000,
		}),
		record({
			type: "tool.request",
			node: "implement",
			ts: at(100_000),
			tool: "write",
			path: "src/health/index.ts",
			decision: "allow",
		}),
		record({
			type: "tool.request",
			node: "implement",
			ts: at(110_000),
			tool: "bash",
			path: "npm test -- --filter health",
			decision: "allow",
		}),
	];
}

function snapshotOf(records: EventRecord[], nowMs: number): ActivitySnapshot {
	const nodes = foldActivity(records, nowMs);
	return { records, nodes, stages: stageActivities(nodes, nowMs), unreadableLines: 0 };
}

function modelOf(snapshot: ActivitySnapshot, stop: RunStatus, extra: Partial<BoardModel> = {}): BoardModel {
	return {
		jobId: JOB,
		mode: "gated",
		round: 1,
		superstep: 7,
		stage: "implement",
		node: "implement",
		stop,
		paused: false,
		gate: "machine",
		fingerprint: "2d4473dabc123",
		fileLit: {
			"task.json": true,
			"context.md": true,
			"candidate.json": true,
			"evidence.json": false,
			"verdict.json": false,
			"events.jsonl": true,
		},
		contextPack: { product: true, structure: true, tech: true },
		research: { cell: "RESEARCH local 3 src · no-network" },
		agents: 1,
		sessions: { nodes: 1, workers: 0 },
		busLit: true,
		kstack: { playbook: "playbook-feature", todos: ["implement the smallest change", "run the gates"] },
		route: "anthropic/home",
		activity: snapshot.stages,
		surface: "overlay",
		...extra,
	};
}

const RUN_FILES: RunFileRow[] = [
	{ name: "task.json", present: true, bytes: 1_228, mtime: at(0), note: "frozen contract" },
	{ name: "context.md", present: true, bytes: 6_963, mtime: at(41_000), note: "frozen repository context" },
	{ name: "candidate.json", present: true, bytes: 307, mtime: at(53_000), note: "ladder minimum-code · deps none" },
	{ name: "evidence.json", present: false, note: "written by 05 test · HEAD-bound" },
	{ name: "verdict.json", present: false, note: "written by 07 review" },
	{ name: "events.jsonl", present: true, bytes: 4_120, mtime: at(110_000), note: "hash-chained · append only" },
];

const TRANSCRIPT: TranscriptEntry[] = [
	{ kind: "system", text: "implement · context thread coder · tools read grep find ls bash edit write" },
	{
		kind: "prompt",
		text: "Before production changes, write candidate.json.ladder, declare runtime dependencies, and capture failing test output.",
	},
	{ kind: "tool", text: "write  candidate.json" },
	{ kind: "output", text: "ladder minimum-code · deps none" },
	{ kind: "tool", text: "bash  npm test -- --filter health" },
	{ kind: "error", text: "FAIL test/health/health.test.ts › GET /health → 404 expected 200" },
	{ kind: "tool", text: "write  src/health/index.ts  (+9)" },
	{ kind: "assistant", text: "green captured. writing evidence excerpt · next node test" },
];

interface FakeTicker {
	tick: CommandCentreSources["tick"];
	fire(): void;
	running(): boolean;
	stopCount: number;
	intervals: number[];
}

function fakeTicker(): FakeTicker {
	let callback: (() => void) | undefined;
	const ticker: FakeTicker = {
		stopCount: 0,
		intervals: [],
		tick(next, intervalMs) {
			callback = next;
			ticker.intervals.push(intervalMs);
			return () => {
				ticker.stopCount += 1;
				callback = undefined;
			};
		},
		fire() {
			callback?.();
		},
		running() {
			return callback !== undefined;
		},
	};
	return ticker;
}

interface Harness {
	sources: CommandCentreSources;
	ticker: FakeTicker;
	calls: {
		readModel: number;
		readTranscript: number[];
		readNodeDetail: number[];
		readRunFiles: number;
		stop: number;
		verify: number;
		chat: string[];
	};
	closed: number;
	renders: number;
	model: BoardModel | undefined;
	snapshot: ActivitySnapshot;
	nowMs: number;
	/** Something the next readModel throws. */
	failure: unknown;
	/** A readModel that waits for release(). */
	hold: (() => void) | undefined;
}

function harness(stop: RunStatus = "RUNNING"): Harness {
	const snapshot = snapshotOf(runRecords(), NOW);
	const ticker = fakeTicker();
	const h: Harness = {
		ticker,
		calls: { readModel: 0, readTranscript: [], readNodeDetail: [], readRunFiles: 0, stop: 0, verify: 0, chat: [] },
		closed: 0,
		renders: 0,
		model: modelOf(snapshot, stop),
		snapshot,
		nowMs: NOW,
		failure: undefined,
		hold: undefined,
		sources: {
			jobId: JOB,
			runDirectory: `.kpi/runs/${JOB}`,
			workerCap: 2,
			async readModel() {
				h.calls.readModel += 1;
				if (h.failure !== undefined) {
					const failure = h.failure;
					h.failure = undefined;
					throw failure;
				}
				if (h.hold !== undefined) {
					const { promise, resolve } = Promise.withResolvers<void>();
					h.hold = resolve;
					await promise;
				}
				return h.model;
			},
			activity: () => h.snapshot,
			async readNodeDetail(stage: number): Promise<NodeDetail> {
				h.calls.readNodeDetail.push(stage);
				const key =
					["ac-compile", "specify", "plan", "implement", "test", "bounds", "review", "ship"][stage] ?? "?";
				const activity = h.snapshot.stages[key];
				if (activity === undefined) return { node: key, status: "pending", runs: 0, toolsByName: {} };
				return {
					node: activity.node,
					status: activity.status,
					runs: activity.runs,
					toolsByName: activity.toolsByName,
					elapsedMs: activity.elapsedMs,
					costUsd: activity.costUsd,
					model: activity.model,
				};
			},
			async readTranscript(stage: number, _limit: number) {
				h.calls.readTranscript.push(stage);
				return stage === 3 ? TRANSCRIPT : stage < 3 ? TRANSCRIPT.slice(0, 3) : [];
			},
			async readRunFiles() {
				h.calls.readRunFiles += 1;
				return RUN_FILES;
			},
			route: () => "anthropic/home 71% 5h · fallback openai-codex → xai",
			async stop() {
				h.calls.stop += 1;
				h.model = h.model === undefined ? undefined : { ...h.model, stop: "STOPPED" };
			},
			async verify() {
				h.calls.verify += 1;
				return "K-π events.jsonl verified: 14 records chained";
			},
			async chat(text: string) {
				h.calls.chat.push(text);
			},
			now: () => h.nowMs,
			tick: ticker.tick,
		},
	};
	return h;
}

function open(h: Harness, rows = 50) {
	const view = createCommandCentre({
		palette: PLAIN_PALETTE,
		sources: h.sources,
		done: () => {
			h.closed += 1;
		},
		requestRender: () => {
			h.renders += 1;
		},
		rows: () => rows,
	});
	return view;
}

function type(view: CommandCentre, text: string): void {
	for (const character of text) view.handleInput?.(character);
}

test("home, details and session remain navigable without overflowing narrow terminals", async () => {
	const h = harness();
	const view = open(h, 30);
	await view.settled();
	for (let depth = 0; depth < 3; depth += 1) {
		for (const width of [60, 80, 108, 120, 140, 160, 200]) {
			const lines = view.render(width);
			assert.equal(lines.length, 27);
			for (const line of lines) assert.ok(visibleWidth(line) <= width);
		}
		view.handleInput?.(KEY.enter);
		await view.settled();
	}
	view.handleInput?.("j");
	await view.settled();
	assert.equal(h.calls.readNodeDetail.at(-1), 4);
	view.handleInput?.("k");
	await view.settled();
	assert.equal(h.calls.readNodeDetail.at(-1), 3);
	view.handleInput?.(KEY.escape);
	view.handleInput?.(KEY.escape);
	assert.equal(h.closed, 0);
	view.handleInput?.(KEY.escape);
	assert.equal(h.closed, 1);
});

test("help intercepts navigation and input commands; escape dismisses it without closing", async () => {
	const h = harness();
	const view = open(h);
	await view.settled();
	const before = view.render(80).join("\n");
	view.handleInput?.("?");
	const help = view.render(80).join("\n");
	assert.notEqual(help, before);
	view.handleInput?.("j");
	view.handleInput?.(KEY.enter);
	assert.equal(view.render(80).join("\n"), help);
	assert.equal(h.calls.readNodeDetail.length, 0);
	view.handleInput?.(KEY.escape);
	assert.equal(h.closed, 0);
	assert.equal(view.render(80).join("\n"), before);
	view.dispose();
});

test("human attention follows runtime status, not recoverable repair, and opens the selected real job", async () => {
	const h = harness();
	const opened: string[] = [];
	h.sources.fleet = {
		read: async () => [
			{
				jobId: "repair",
				model: modelOf(h.snapshot, "RUNNING", {
					paused: true,
					retry: { node: "implement", attempt: 2, reason: "timeout", delayMs: 4000 },
				}),
			},
			{ jobId: "waiting", model: modelOf(h.snapshot, "NEEDS_HUMAN", { pendingQuestion: "Allow src/api.ts?" }) },
			{ jobId: "finished", model: modelOf(h.snapshot, "DONE") },
			{ jobId: "cancelled", model: modelOf(h.snapshot, "STOPPED") },
		],
		open: async (jobId) => {
			opened.push(jobId);
		},
	};
	const view = open(h);
	await view.settled();
	view.handleInput?.(KEY.tab);
	const selected = view.render(108).find((line) => line.startsWith("▸"));
	assert.ok(selected?.includes("waiting"));
	type(view, "/kpi stop");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.equal(h.calls.stop, 0, "a fleet selection must never stop the locally opened job");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.deepEqual(opened, ["waiting"]);
	assert.equal(h.closed, 1);
});

test("fleet refresh stays live when the opened job ends and selection survives snapshot order changes", async () => {
	const h = harness();
	const opened: string[] = [];
	let reversed = false;
	h.sources.fleet = {
		read: async () => {
			const jobs = ["first", "second"].map((jobId) => ({ jobId, model: modelOf(h.snapshot, "NEEDS_HUMAN") }));
			return reversed ? jobs.reverse() : jobs;
		},
		open: async (jobId) => {
			opened.push(jobId);
		},
	};
	const view = open(h);
	await view.settled();
	view.handleInput?.(KEY.tab);
	h.model = modelOf(h.snapshot, "DONE");
	reversed = true;
	h.ticker.fire();
	await view.settled();
	assert.ok(h.ticker.running());
	assert.ok(
		view
			.render(80)
			.find((line) => line.startsWith("▸"))
			?.includes("first"),
	);
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.deepEqual(opened, ["first"]);
});

test("refresh recovers after read failure, serializes slow reads, and stops after a terminal local result", async () => {
	const h = harness();
	h.failure = Object.assign(new Error("unreadable"), { code: "EIO" });
	const view = open(h);
	await view.settled();
	assert.ok(h.ticker.running());
	h.ticker.fire();
	await view.settled();
	const recovered = view.render(80).join("\n");
	assert.ok(recovered.includes(JOB.slice(0, 25)));
	h.hold = () => undefined;
	h.ticker.fire();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const reads = h.calls.readModel;
	h.ticker.fire();
	assert.equal(h.calls.readModel, reads);
	const release = h.hold;
	h.hold = undefined;
	release?.();
	await view.settled();
	h.model = modelOf(h.snapshot, "DONE");
	h.ticker.fire();
	await view.settled();
	assert.equal(h.ticker.running(), false);
	const endedReads = h.calls.readModel;
	h.ticker.fire();
	assert.equal(h.calls.readModel, endedReads);
	view.dispose();
});

test("commands stay in the overlay and ordinary text closes before sending to chat", async () => {
	const h = harness();
	const view = open(h);
	await view.settled();
	type(view, "/kpi verify");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.equal(h.calls.verify, 1);
	assert.equal(h.closed, 0);
	type(view, "/kpi stop");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.equal(h.calls.stop, 1);
	assert.equal(h.ticker.running(), false);
	type(view, "xjkr1?");
	view.handleInput?.(KEY.backspace);
	h.sources.chat = async (message) => {
		assert.equal(h.closed, 1);
		h.calls.chat.push(message);
	};
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.deepEqual(h.calls.chat, ["xjkr1"]);
});
