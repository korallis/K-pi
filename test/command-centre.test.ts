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

const CAP_TOKENS = /maxCostUsd|timeoutMs|maxRounds|maxSteps|EXHAUSTED|NO_PROGRESS|\/3\b|\/30m|╱ \$|╱ 30/u;

function assertFits(lines: string[], width: number, label: string): void {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`${label}: line wider than ${width}: ${JSON.stringify(line)} (${visibleWidth(line)})`,
		);
		if (line.startsWith("┌") || line.startsWith("│") || line.startsWith("└")) {
			assert.equal(visibleWidth(line), width, `${label}: framed line not exactly ${width}: ${JSON.stringify(line)}`);
		}
	}
}

test("the command centre paints home and session views from run files at 200, 160, 120, 80 and 60 columns", async () => {
	const h = harness();
	const view = open(h);
	await view.settled();
	const home = new Map<number, string[]>();
	for (const width of [200, 160, 120, 80, 60]) {
		const lines = view.render(width);
		home.set(width, lines);
		assertFits(lines, width, `home@${width}`);
		const text = lines.join("\n");
		assert.equal(lines.length, 47, `home@${width} fills the row budget`);
		for (const token of [
			"K-π",
			"COMMAND",
			"MODE gated",
			"ROUND 1",
			"STOP RUNNING",
			"STAGES",
			"LIVE › 04 implement",
			"EVENTS",
		]) {
			assert.ok(text.includes(token), `home@${width} carries ${token}`);
		}
		for (const stage of [
			"01 ac-compile",
			"02 specify",
			"03 plan",
			"04 implement",
			"05 test",
			"06 bounds",
			"07 review",
			"08 ship",
		]) {
			assert.ok(text.includes(stage), `home@${width} lists ${stage}`);
		}
		assert.ok(text.includes("▸ 04 implement"), `home@${width} marks the selected stage`);
		assert.ok(text.includes("✓ DONE"), `home@${width} paints done stages`);
		assert.ok(text.includes("○ PENDING"), `home@${width} paints pending stages`);
		assert.ok(text.includes("write  src/health/index.ts"), `home@${width} tails the selected session`);
		assert.doesNotMatch(text, CAP_TOKENS, `home@${width} prints no caps`);
		if (width >= 80) {
			assert.ok(text.includes("TELEMETRY"), `home@${width} has telemetry`);
			assert.match(text, /PATH {1,2}ac-compile ?━+▶ ?specify/u, `home@${width} walks the PATH row`);
			assert.match(text, /COST {5}\$0\.20 est\./u);
			assert.match(
				text,
				/ROUNDS {3}r0 ━+ 1m09s {3}r1 ━+⠋ 5m49s/u,
				"the round's elapsed comes from node.started/node.finished",
			);
			assert.match(text, /STEPS {4}7 {3}NODE RUNS 4 {3}WORKERS 0\/2/u);
			assert.match(text, /TIME {5}7m00s/u);
		}
		if (width >= 120) {
			for (const token of [
				"SHARED RUN STATE",
				"CONTEXT LAYER",
				"● task.json",
				"○ evidence.json",
				"1.2k",
				"ROUTE     anthropic/home 71% 5h",
				"PACK      product ●  structure ●  tech ●",
				"node.retry",
				"implement retry 1 · timeout · next 2s",
			]) {
				assert.ok(text.includes(token), `home@${width} carries ${token}`);
			}
		}
	}
	assert.ok(
		home.get(160)?.some((line) => line.includes("[ implement ⠋ ]") && line.includes("ac-compile ━━▶ specify")),
		"the PATH row boxes the current stage",
	);

	view.handleInput?.(KEY.enter);
	await view.settled();
	for (const width of [200, 160, 120, 80, 60]) {
		const lines = view.render(width);
		assertFits(lines, width, `session@${width}`);
		const text = lines.join("\n");
		for (const token of [
			"› 04 implement",
			"› session",
			"SESSION › 04 implement",
			"following",
			"entries",
			"prompt",
			"Before production changes",
		]) {
			assert.ok(text.includes(token), `session@${width} carries ${token}`);
		}
		assert.doesNotMatch(text, CAP_TOKENS, `session@${width} prints no caps`);
		if (width >= 120) {
			for (const token of [
				"STAGES",
				"← → switch node",
				"FILES",
				"NODE",
				"node     implement",
				"status   RUNNING",
				"retries  1",
				"WRITES",
				"src/health/index.ts",
				"NEXT",
				"test → bounds → review",
				"model    worker-b",
			]) {
				assert.ok(text.includes(token), `session@${width} carries ${token}`);
			}
		}
	}

	// A 40-row terminal (the pty default) keeps SHARED RUN STATE and CONTEXT
	// LAYER by giving up the stage detail lines first; a shorter one keeps
	// every stage and the events.
	const forty = open(h, 40);
	await forty.settled();
	const fortyLines = forty.render(140);
	assertFits(fortyLines, 140, "home@140x40");
	assert.equal(fortyLines.length, 37);
	const fortyText = fortyLines.join("\n");
	for (const token of [
		"SHARED RUN STATE",
		"CONTEXT LAYER",
		"● task.json",
		"TELEMETRY",
		"EVENTS",
		"01 ac-compile",
		"08 ship",
	]) {
		assert.ok(fortyText.includes(token), `home@140x40 keeps ${token}`);
	}
	assert.doesNotMatch(fortyText, /41s · 1 calls/u, "the stage detail lines are what a 40-row terminal gives up");
	forty.dispose();
	const short = open(h, 30);
	await short.settled();
	const lines = short.render(160);
	assertFits(lines, 160, "home@160x30");
	assert.equal(lines.length, 27);
	const text = lines.join("\n");
	for (const stage of ["01 ac-compile", "08 ship"]) assert.ok(text.includes(stage), `short home lists ${stage}`);
	assert.ok(text.includes("EVENTS"), "short home keeps the events panel");
	short.dispose();
	view.dispose();

	// The scratch render the lead compares with the mockup.
	if (process.env.KPI_RENDER === "1") {
		for (const width of [200, 160, 120, 80, 60]) {
			const scratch = open(h);
			await scratch.settled();
			console.log(`\n=== HOME ${width} ===\n${scratch.render(width).join("\n")}`);
			scratch.handleInput?.(KEY.enter);
			await scratch.settled();
			console.log(`\n=== SESSION ${width} ===\n${scratch.render(width).join("\n")}`);
			scratch.dispose();
		}
	}
});

test("the command centre follows a running job on the injected tick and stops ticking when the job ends", async () => {
	const h = harness();
	const view = open(h);
	await view.settled();
	assert.equal(h.calls.readModel, 1, "one read on open");
	assert.equal(h.calls.readRunFiles, 1);
	assert.deepEqual(h.calls.readTranscript, [3], "the transcript of the current stage");
	assert.deepEqual(h.ticker.intervals, [1000], "the ticker runs at BOARD_TICK_MS while RUNNING");
	assert.ok(h.ticker.running());
	const before = view.render(160).join("\n");
	assert.match(before, /STOP RUNNING ⠋ 7m00s/u);

	// A tick re-reads the model and the selected transcript; the spinner advances.
	h.nowMs = NOW + 1_000;
	h.snapshot = snapshotOf(runRecords(), h.nowMs);
	h.model = modelOf(h.snapshot, "RUNNING", {
		retry: { node: "implement", attempt: 2, reason: "timeout", delayMs: 4_000 },
	});
	h.ticker.fire();
	await view.settled();
	assert.equal(h.calls.readModel, 2);
	assert.deepEqual(h.calls.readTranscript, [3, 3]);
	assert.equal(h.calls.readRunFiles, 1, "run files wait for the fifth tick");
	const after = view.render(160).join("\n");
	assert.match(after, /STOP RUNNING ⠙ 7m01s/u, "the spinner advanced and the elapsed moved");
	assert.match(after, /RETRY 2 · timeout · next 4s/u, "state.retry paints on the STEPS row");
	assert.ok(h.renders > 0, "every refresh requests a render");

	// Busy guard: a tick during an in-flight read is skipped, never queued.
	h.hold = () => undefined;
	h.ticker.fire();
	const settle = Promise.withResolvers<void>();
	setImmediate(settle.resolve);
	await settle.promise;
	assert.equal(h.calls.readModel, 3, "the tick's read is in flight");
	h.ticker.fire();
	assert.equal(h.calls.readModel, 3, "the second tick was skipped while the first read was in flight");
	const release = h.hold;
	h.hold = undefined;
	release?.();
	await view.settled();
	assert.equal(h.calls.readModel, 3, "the skipped tick was never queued");

	// The fifth tick re-reads the run files too.
	for (let tick = 3; tick <= 5; tick += 1) {
		h.ticker.fire();
		await view.settled();
		assert.equal(h.calls.readRunFiles, tick === 5 ? 2 : 1, `run files re-read on the fifth tick only (tick ${tick})`);
	}

	// A refresh failure paints in the header and never stops the ticker.
	h.failure = Object.assign(new Error("boom"), { code: "EIO" });
	h.ticker.fire();
	await view.settled();
	assert.match(view.render(160)[0] ?? "", /EVENTS ✕ EIO/u);
	assert.ok(h.ticker.running(), "a failed refresh keeps following");
	h.ticker.fire();
	await view.settled();
	assert.doesNotMatch(view.render(160)[0] ?? "", /EVENTS ✕/u, "the next good read clears it");

	// The job ends: one more paint, then the ticker stops.
	h.model = modelOf(h.snapshot, "DONE");
	h.ticker.fire();
	await view.settled();
	assert.equal(h.ticker.stopCount, 1);
	assert.ok(!h.ticker.running());
	assert.match(view.render(160)[0] ?? "", /STOP DONE/u);
	h.ticker.fire();
	assert.equal(h.calls.readModel, 9, "no read after the ticker stopped");
	view.dispose();
	assert.equal(h.ticker.stopCount, 1, "dispose does not stop a stopped ticker twice");

	// A job that vanishes mid-run: the header says so and the ticker stops.
	const gone = harness();
	const goneView = open(gone);
	await goneView.settled();
	gone.model = undefined;
	gone.ticker.fire();
	await goneView.settled();
	assert.match(goneView.render(160)[0] ?? "", /K-π no active job/u);
	assert.equal(gone.ticker.stopCount, 1);
	goneView.dispose();

	// A NEEDS_HUMAN job never starts the ticker and names its recovery.
	const paused = harness("NEEDS_HUMAN");
	paused.model = modelOf(paused.snapshot, "NEEDS_HUMAN", {
		recovery: "approval",
		paused: true,
		gate: "human",
		pendingQuestion: "Approve the plan?",
	});
	const pausedView = open(paused);
	await pausedView.settled();
	assert.ok(!paused.ticker.running());
	const pausedText = pausedView.render(160).join("\n");
	assert.match(pausedText, /STOP NEEDS_HUMAN approval/u);
	assert.match(pausedText, /◉ WAITING/u);
	pausedView.dispose();

	// dispose() stops a live ticker.
	const live = harness();
	const liveView = open(live);
	await liveView.settled();
	liveView.dispose();
	assert.equal(live.ticker.stopCount, 1);
	live.ticker.fire();
	assert.equal(live.calls.readModel, 1, "a disposed view never reads again");

	// A read that fails on open is painted, and is not terminal: the ticker
	// starts anyway and the next tick brings the board up.
	const late = harness();
	late.failure = Object.assign(new Error("boom"), { code: "EIO" });
	const lateView = open(late);
	await lateView.settled();
	const lateLines = lateView.render(160);
	assert.match(
		lateLines[0] ?? "",
		/K-π reading run files {2}· {2}EVENTS ✕ EIO/u,
		"the open failure paints in the header",
	);
	assert.ok(
		lateLines.some((line) => line.includes("K-π reading run files ✕ EIO · r to retry")),
		"the empty body says why and how to retry",
	);
	assert.ok(late.ticker.running(), "an open failure starts the ticker so the read is retried");
	late.ticker.fire();
	await lateView.settled();
	const recovered = lateView.render(160).join("\n");
	assert.doesNotMatch(recovered, /EVENTS ✕/u, "the retry clears the failure");
	assert.ok(recovered.includes("▸ 04 implement"), "the retry paints the board on the current stage");
	lateView.dispose();
});

test("the command centre selects stages, opens a session, and routes stop, verify and chat through its sources", async () => {
	const h = harness();
	const view = open(h);
	await view.settled();

	view.handleInput?.("6");
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("▸ 06 bounds"), "1-8 jumps to a stage");
	assert.ok(view.render(160).join("\n").includes("LIVE › 06 bounds"));
	assert.deepEqual(h.calls.readTranscript.at(-1), 5);
	view.handleInput?.(KEY.tab);
	view.handleInput?.(KEY.shiftTab);
	view.handleInput?.(KEY.down);
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("▸ 07 review"), "tab/shift+tab/↓ move the selection");

	type(view, " ");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.deepEqual(h.calls.readNodeDetail, [6], "enter on an empty prompt opens the session of the selected stage");
	assert.ok(view.render(160).join("\n").includes("SESSION › 07 review"));
	assert.doesNotMatch(view.render(160).join("\n"), /> +▌/u, "a whitespace-only prompt is cleared, not kept");
	view.handleInput?.(KEY.escape);
	assert.ok(view.render(160).join("\n").includes("LIVE › 07 review"), "esc goes back home");
	assert.equal(h.closed, 0);

	// /kpi verify → the hint line.
	type(view, "/kpi verify");
	assert.match(view.render(160).join("\n"), /> \/kpi verify▌/u, "the prompt echoes what is typed");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.equal(h.calls.verify, 1);
	assert.ok(
		view.render(160).join("\n").includes("K-π events.jsonl verified: 14 records chained"),
		"the verify result shows on the hint line",
	);

	// Other /kpi goals and bash are refused with a K-π line.
	type(view, "/kpi goal");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("K-π /kpi goal is refused while a job runs; /kpi stop first"));
	type(view, "!ls");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("K-π bash is not available inside the command centre"));

	// Backspace edits, esc clears a non-empty prompt.
	type(view, "abc");
	view.handleInput?.(KEY.backspace);
	assert.match(view.render(160).join("\n"), /> ab▌/u);
	view.handleInput?.(KEY.escape);
	assert.equal(h.closed, 0, "esc with a prompt clears it instead of closing");
	assert.doesNotMatch(view.render(160).join("\n"), /> ab/u);

	// q, r and digits type once the prompt has text.
	type(view, "x");
	type(view, "q");
	assert.equal(h.closed, 0);
	type(view, "r1");
	assert.match(view.render(160).join("\n"), /> xqr1▌/u);
	view.handleInput?.(KEY.escape);

	// /kpi stop → sources.stop() once, then a repaint with the new state.
	type(view, "/kpi stop");
	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.equal(h.calls.stop, 1);
	assert.match(view.render(160).join("\n"), /STOP STOPPED/u, "the repaint after stop shows the run stopped");
	assert.equal(h.ticker.stopCount, 1, "a stopped job stops the ticker");
	assert.equal(h.closed, 0, "stop keeps the centre open");

	// Chat closes the view first, then sends.
	const order: string[] = [];
	const chatH = harness();
	chatH.sources.chat = async (text) => {
		order.push(`chat:${text}`);
	};
	const chatView = createCommandCentre({
		palette: PLAIN_PALETTE,
		sources: chatH.sources,
		done: () => {
			order.push("done");
		},
		requestRender: () => undefined,
		rows: () => 50,
	});
	await chatView.settled();
	type(chatView, "why is test pending?");
	chatView.handleInput?.(KEY.enter);
	await chatView.settled();
	assert.deepEqual(order, ["done", "chat:why is test pending?"], "the view closes before the message is sent");
	assert.equal(chatH.ticker.stopCount, 1, "closing stops the ticker");
	view.dispose();
});

test("the status overlay selects stages with arrow keys, opens the node detail on enter and closes on q", async () => {
	const h = harness();
	const view = open(h);
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("▸ 04 implement"), "opens on the current stage");

	view.handleInput?.(KEY.right);
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("▸ 05 test"));
	view.handleInput?.(KEY.left);
	view.handleInput?.(KEY.left);
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("▸ 03 plan"));
	view.handleInput?.(KEY.up);
	view.handleInput?.(KEY.up);
	view.handleInput?.(KEY.up);
	view.handleInput?.(KEY.up);
	await view.settled();
	assert.ok(view.render(160).join("\n").includes("▸ 01 ac-compile"), "the selection clamps at the first stage");

	view.handleInput?.(KEY.enter);
	await view.settled();
	assert.deepEqual(h.calls.readNodeDetail, [0]);
	const session = view.render(160).join("\n");
	assert.ok(session.includes("NODE"), "enter opens the node detail");
	assert.ok(session.includes("node     ac-compiler"));
	assert.ok(session.includes("status   DONE"));
	assert.ok(session.includes("cost     $0.02 est."));
	assert.ok(session.includes("model    worker-a"));

	view.handleInput?.("q");
	assert.equal(h.closed, 1, "q closes");
	assert.equal(h.ticker.stopCount, 1, "closing stops the ticker");
	view.handleInput?.(KEY.right);
	assert.equal(h.closed, 1, "a closed view ignores input");

	const otherH = harness();
	const other = open(otherH);
	await other.settled();
	other.handleInput?.(KEY.ctrlC);
	assert.equal(otherH.closed, 1, "ctrl+c closes");
	assert.equal(otherH.ticker.stopCount, 1, "ctrl+c stops the ticker");
});
