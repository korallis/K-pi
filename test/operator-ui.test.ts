import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	type BoardModel,
	buildBoardRegions,
	fitBoard,
	formatCost,
	formatElapsed,
	normalizeStop,
	type Row,
	RUN_FILE_NAMES,
	renderBoard,
	researchCellFromDocument,
	resolveCurrentStageIndex,
	type StageActivity,
	shortTool,
	stopTone,
	type Tone,
} from "../packages/coding-agent/src/kpi/extensions/board.ts";
import {
	PLAIN_PALETTE,
	paintBoard,
	paintShrinkingRow,
} from "../packages/coding-agent/src/kpi/extensions/board-frame.ts";
import {
	applyBoardTheme,
	buildBoardModel,
	createStatusWidget,
	isPausedHuman,
	resetBoardThemeWarning,
} from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import { writeState } from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import { createStopState } from "../packages/coding-agent/src/kpi/extensions/graph/stop.ts";
import {
	resetFooterRouteSnapshot,
	setFooterRouteSnapshot,
} from "../packages/coding-agent/src/kpi/extensions/status-line/route-snapshot.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "kpi-operator-ui-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
		resetFooterRouteSnapshot();
	}
}

async function seedRun(
	root: string,
	state: Record<string, unknown>,
	files: Partial<Record<string, string>> = {},
): Promise<string> {
	const jobId = typeof state.job_id === "string" ? state.job_id : "job-board";
	const runDirectory = join(root, ".kpi", "runs", jobId);
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
	const defaults: Record<string, string> = {
		"task.json": JSON.stringify({ job_id: jobId, mode: "gated", goal: "g" }),
		"context.md": "# context\n",
		"candidate.json": '{"ok":true}\n',
		"evidence.json": '{"head":"abc"}\n',
		"verdict.json": '{"status":"REVISE","approved":false}\n',
		"events.jsonl": '{"type":"checkpoint"}\n',
	};
	for (const [name, body] of Object.entries({ ...defaults, ...files })) {
		if (body === undefined || body === "") {
			// leave absent
			continue;
		}
		if (body === "__empty__") {
			await writeFile(join(runDirectory, name), "");
			continue;
		}
		await writeFile(join(runDirectory, name), body);
	}
	return runDirectory;
}

test("amber board lights exactly one CURRENT stage and six nonempty file lamps", async () => {
	await withRoot(async (root) => {
		await seedRun(root, {
			job_id: "amber-1",
			mode: "gated",
			round: 2,
			stage: "implement",
			node: "implement",
			passed: true,
			status: "RUNNING",
			graph_status: "running",
			output_fingerprint: "sha256:abcdef0123456789",
			playbook: "feature",
			todos: ["plan: scope", "implement: code"],
		});
		await mkdir(join(root, ".kpi", "context"), { recursive: true });
		await writeFile(join(root, ".kpi", "context", "product.md"), "p\n");
		await writeFile(join(root, ".kpi", "context", "structure.md"), "s\n");
		const runDir = join(root, ".kpi", "runs", "amber-1");
		await writeFile(join(runDir, "bus.jsonl"), '{"type":"agent.spawned"}\n');
		setFooterRouteSnapshot({
			slotKind: "oauth",
			route: "anthropic/home",
			remainingPercent: 40,
		});

		const lines = await createStatusWidget(root, { agents: 1 });
		const text = lines.join("\n");
		assert.match(text, /K-π/);
		assert.match(text, /MODE gated/);
		assert.match(text, /JOB amber-1/);
		assert.match(text, /04 implement CURRENT/);
		const currents = text.match(/CURRENT/g) ?? [];
		assert.equal(currents.length, 1, "exactly one CURRENT stage");
		assert.match(text, /PASS/);
		assert.match(text, /● task\.json/);
		assert.match(text, /● context\.md/);
		assert.match(text, /● candidate\.json/);
		assert.match(text, /● evidence\.json/);
		assert.match(text, /● verdict\.json/);
		assert.match(text, /● events\.jsonl/);
		assert.match(text, /STOP RUNNING/);
		assert.doesNotMatch(text, /STOP APPROVAL/);
		assert.match(text, /CONTEXT LAYER/);
		assert.match(text, /product ●/);
		assert.match(text, /K-STACK feature/);
		assert.match(text, /AGENTS 1/);
		assert.match(text, /BUS ●/);
		assert.match(text, /ROUTE anthropic\/home/);
		assert.match(text, /USAGE 40%/);
		assert.doesNotMatch(text, /WAITING ON OPERATOR/);
	});
});

test("empty run files keep lamps dark", async () => {
	await withRoot(async (root) => {
		const runDirectory = await seedRun(
			root,
			{
				job_id: "lamps",
				mode: "gated",
				round: 0,
				stage: "plan",
				node: "plan",
				status: "RUNNING",
			},
			{
				"task.json": '{"job_id":"lamps"}\n',
				"context.md": "__empty__",
				"candidate.json": "",
				"evidence.json": "",
				"verdict.json": "",
				"events.jsonl": "__empty__",
			},
		);
		// remove absent ones
		await rm(join(runDirectory, "candidate.json"), { force: true });
		await rm(join(runDirectory, "evidence.json"), { force: true });
		await rm(join(runDirectory, "verdict.json"), { force: true });

		const text = (await createStatusWidget(root)).join("\n");
		assert.match(text, /● task\.json/);
		assert.match(text, /○ context\.md/);
		assert.match(text, /○ candidate\.json/);
		assert.match(text, /○ evidence\.json/);
		assert.match(text, /○ verdict\.json/);
		assert.match(text, /○ events\.jsonl/);
	});
});

test("protocol-blue pause derives APPROVAL lamp without persisting APPROVAL status", async () => {
	await withRoot(async (root) => {
		const runDirectory = await seedRun(root, {
			job_id: "pause-1",
			mode: "gated",
			round: 1,
			stage: "ship",
			node: "human-confirm",
			status: "RUNNING",
			graph_status: "interrupted",
			pending_question: "Ship the change?",
		});

		const stateOnDisk = JSON.parse(
			await readFile(join(runDirectory, "state.json"), "utf8"),
		) as import("../packages/coding-agent/src/kpi/extensions/run-store.ts").RunState;
		assert.notEqual(stateOnDisk.status, "APPROVAL");
		assert.ok(isPausedHuman(stateOnDisk));

		const text = (await createStatusWidget(root)).join("\n");
		assert.match(text, /HUMAN OVERSIGHT REQUIRED/);
		assert.match(text, /WAITING ON OPERATOR\s+Ship the change\?/);
		assert.match(text, /APPROVAL ●/);
		assert.match(text, /SHARED RUN STATE/);
		assert.match(text, /THREE LAWS/);
		assert.match(text, /Outer loop owns the return path/);
		assert.match(text, /STOP RUNNING/);
		assert.doesNotMatch(text, /STOP APPROVAL/);
		assert.doesNotMatch(text, /\bno-network\b.*STOP/s);

		// writeState path must not reintroduce APPROVAL
		const task = {
			job_id: "pause-1",
			mode: "gated" as const,
			goal: "g",
			nongoals: [] as string[],
			acceptance: [{ id: "AC-01", statement: "s", required: true }],
			constraints: [] as string[],
			quality_gates: [] as string[],
			ac: { quality: "narrative" as const },
		};
		const graphState = {
			graphId: "g",
			jobId: "pause-1",
			status: "interrupted" as const,
			superstep: 0,
			active: ["human-confirm"],
			values: {},
			nodes: {},
			pendingHuman: { nodeId: "human-confirm", question: "Ship the change?" },
			budget: {
				limits: {},
				startedAtMs: 0,
				elapsedMs: 0,
				costUsd: 0,
				round: 1,
				batches: 0,
			},
		};
		await writeState(runDirectory, task, graphState as never, createStopState());
		const written = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		assert.notEqual(written.status, "APPROVAL");
		assert.equal(written.status, "RUNNING");
		assert.equal(written.graph_status, "interrupted");
	});
});

test("research cells distinguish online operator and engine no-network", () => {
	assert.deepEqual(
		researchCellFromDocument({
			network: { state: "online" },
			sources: [
				{ kind: "external", service: "exa" },
				{ kind: "external", service: "exa" },
			],
			mode: "exa",
		}),
		{ cell: "RESEARCH exa 2 src" },
	);
	assert.equal(
		researchCellFromDocument({
			network: { state: "no-network", origin: "operator" },
			sources: [],
		})?.cell,
		"RESEARCH local · no-network operator",
	);
	const engine = researchCellFromDocument({
		network: {
			state: "no-network",
			origin: "engine",
			reason: "exa and perplexity exhausted",
			failures: [{ service: "exa" }, { service: "perplexity" }],
		},
		sources: [{ kind: "local" }],
	});
	assert.match(engine?.cell ?? "", /no-network engine · exa and perplexity exhausted/);
	assert.match(engine?.struck ?? "", /EXA ✕/);
	assert.match(engine?.struck ?? "", /PPLX ✕/);
});

test("narrow width keeps CURRENT stage and STOP visible", () => {
	const lines = renderBoard({
		jobId: "narrow",
		mode: "gated",
		round: 1,
		stage: "test",
		node: "test",
		stop: "RUNNING",
		paused: false,
		fileLit: Object.fromEntries(
			["task.json", "context.md", "candidate.json", "evidence.json", "verdict.json", "events.jsonl"].map((n) => [
				n,
				true,
			]),
		),
		contextPack: { product: false, structure: false, tech: false },
		agents: 0,
		busLit: false,
		width: 40,
	});
	const text = lines.join("\n");
	assert.match(text, /CURRENT/);
	assert.match(text, /STOP RUNNING/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test("board and status rendering never call a model client", async () => {
	await withRoot(async (root) => {
		await seedRun(root, {
			job_id: "no-model",
			mode: "gated",
			round: 0,
			stage: "specify",
			node: "specify",
			status: "RUNNING",
		});

		const fakeModel = {
			complete() {
				throw new Error("model must not be called during board render");
			},
			stream() {
				throw new Error("model must not be called during board render");
			},
		};
		// Board path is pure FS + snapshots; hang the fake on global to catch accidental use.
		(globalThis as { __kpiFakeModel?: unknown }).__kpiFakeModel = fakeModel;
		try {
			await createStatusWidget(root);
			await buildBoardModel(root);
			fitBoard(["K-π", "04 implement CURRENT", "STOP RUNNING"], 50);
		} finally {
			delete (globalThis as { __kpiFakeModel?: unknown }).__kpiFakeModel;
		}
	});
});

test("BUS lamp tracks bus.jsonl history independent of AGENTS count", async () => {
	await withRoot(async (root) => {
		await seedRun(root, {
			job_id: "bus-1",
			mode: "gated",
			round: 0,
			stage: "plan",
			node: "plan",
			status: "RUNNING",
		});
		let text = (await createStatusWidget(root, { agents: 3 })).join("\n");
		assert.match(text, /AGENTS 3/);
		assert.match(text, /BUS ○/);

		await writeFile(join(root, ".kpi", "runs", "bus-1", "bus.jsonl"), '{"type":"message"}\n');
		text = (await createStatusWidget(root, { agents: 0 })).join("\n");
		assert.match(text, /AGENTS 0/);
		assert.match(text, /BUS ●/);
	});
});

test("playbook freeze ignores mutable kModeState.plan for an open job", async () => {
	await withRoot(async (root) => {
		const { kModeState } = await import("../packages/coding-agent/src/kpi/kstack/mode.ts");
		const previous = { enabled: kModeState.enabled, plan: kModeState.plan };
		try {
			await seedRun(
				root,
				{
					job_id: "freeze-1",
					mode: "gated",
					round: 1,
					stage: "implement",
					node: "implement",
					status: "RUNNING",
					playbook: "feature",
					todos: ["implement: frozen step"],
				},
				{
					"task.json": JSON.stringify({
						job_id: "freeze-1",
						mode: "gated",
						goal: "g",
						playbook: "feature",
						playbook_steps: [{ node: "implement", text: "frozen step" }],
					}),
				},
			);
			// Unrelated sticky match must not relabel the board.
			kModeState.enabled = true;
			kModeState.plan = {
				playbook: "review",
				todos: ["review: wrong plan"],
				steps: [{ node: "review", text: "wrong plan" }],
			};

			const text = (await createStatusWidget(root)).join("\n");
			assert.match(text, /K-STACK feature/);
			assert.match(text, /PROGRESS {2}implement: frozen step/);
			assert.doesNotMatch(text, /wrong plan/);
			assert.match(text, /K-STACK on/);
		} finally {
			kModeState.enabled = previous.enabled;
			kModeState.plan = previous.plan;
		}
	});
});

test("unknown stage still lights exactly one CURRENT via node then ac-compile", () => {
	assert.equal(resolveCurrentStageIndex("not-a-stage", "implement"), 3);
	assert.equal(resolveCurrentStageIndex("garbage", "human-confirm"), 7);
	assert.equal(resolveCurrentStageIndex("???"), 0);

	const viaNode = renderBoard({
		jobId: "cur-1",
		mode: "gated",
		round: 0,
		stage: "not-a-stage",
		node: "test",
		stop: "RUNNING",
		paused: false,
		fileLit: Object.fromEntries(
			["task.json", "context.md", "candidate.json", "evidence.json", "verdict.json", "events.jsonl"].map((n) => [
				n,
				false,
			]),
		),
		contextPack: { product: false, structure: false, tech: false },
		agents: 0,
		busLit: false,
	}).join("\n");
	assert.match(viaNode, /05 test CURRENT/);
	assert.equal((viaNode.match(/CURRENT/g) ?? []).length, 1);

	const fallback = renderBoard({
		jobId: "cur-2",
		mode: "gated",
		round: 0,
		stage: "???",
		node: "also-bad",
		stop: "RUNNING",
		paused: false,
		fileLit: Object.fromEntries(
			["task.json", "context.md", "candidate.json", "evidence.json", "verdict.json", "events.jsonl"].map((n) => [
				n,
				false,
			]),
		),
		contextPack: { product: false, structure: false, tech: false },
		agents: 0,
		busLit: false,
	}).join("\n");
	assert.match(fallback, /01 ac-compile CURRENT/);
	assert.equal((fallback.match(/CURRENT/g) ?? []).length, 1);
});

test("sticky kMode alone does not light K-STACK on for an active job without freeze", async () => {
	await withRoot(async (root) => {
		const { kModeState } = await import("../packages/coding-agent/src/kpi/kstack/mode.ts");
		const previous = { enabled: kModeState.enabled, plan: kModeState.plan };
		try {
			await seedRun(root, {
				job_id: "no-freeze",
				mode: "gated",
				round: 0,
				stage: "plan",
				node: "plan",
				status: "RUNNING",
			});
			kModeState.enabled = true;
			kModeState.plan = {
				playbook: "review",
				todos: ["review: sticky only"],
				steps: [{ node: "review", text: "sticky only" }],
			};
			const text = (await createStatusWidget(root)).join("\n");
			assert.doesNotMatch(text, /K-STACK on/);
			assert.doesNotMatch(text, /K-STACK review/);
		} finally {
			kModeState.enabled = previous.enabled;
			kModeState.plan = previous.plan;
		}
	});
});

// ---------------------------------------------------------------------------
// B15: a narrow board folds, it does not lose information
// ---------------------------------------------------------------------------

function boardModel(overrides: Partial<BoardModel> = {}): BoardModel {
	return {
		jobId: "2026-09-02-healthcheck",
		mode: "gated",
		round: 2,
		stage: "implement",
		node: "implement",
		stop: "RUNNING",
		paused: false,
		passed: false,
		fingerprint: `sha256:${"a".repeat(64)}`,
		fileLit: {
			"task.json": true,
			"context.md": true,
			"candidate.json": false,
			"evidence.json": true,
			"verdict.json": false,
			"events.jsonl": true,
		},
		contextPack: { product: true, structure: true, tech: false },
		agents: 1,
		busLit: true,
		...overrides,
	};
}

const REQUIRED_FIELDS = ["K-π", "MODE gated", "JOB 2026-09", "ROUND 2", "STOP RUNNING"] as const;

function requireFields(text: string, label: string): void {
	for (const field of REQUIRED_FIELDS) {
		assert.ok(text.includes(field), `${label} kept ${field}`);
	}
	for (const name of RUN_FILE_NAMES) {
		assert.ok(text.includes(name), `${label} kept the ${name} lamp`);
	}
	for (const stage of ["ac-compile", "specify", "plan", "implement", "test", "bounds", "review", "ship"]) {
		assert.ok(text.includes(stage), `${label} kept the ${stage} stage`);
	}
	assert.equal((text.match(/CURRENT/gu) ?? []).length, 1, `${label} lights exactly one CURRENT`);
}

test("the framed board keeps every required field at 200, 120, 80 and 60 columns", () => {
	for (const width of [200, 120, 80, 60]) {
		for (const layout of ["full", "compact"] as const) {
			const lines = paintBoard(boardModel(), { width, layout });
			const text = lines.join("\n");
			const label = `${layout} at ${width}`;
			requireFields(text, label);
			// A dark lamp must stay legible as dark, not vanish behind an ellipsis.
			assert.ok(/○/u.test(text) && text.includes("candidate.json"), `${label} kept the dark candidate lamp`);
			if (width >= 70) {
				assert.ok(
					lines.every((line) => visibleWidth(line) === width),
					`${label}: every framed line is exactly ${width} wide`,
				);
				assert.ok(text.includes("┌"), `${label} is framed`);
				const stageRows = lines.filter((line) => line.includes("ac-compile")).length;
				assert.equal(stageRows, width >= 120 ? 1 : 1, `${label}: ac-compile sits on one row`);
				const shipRows = lines.filter((line) => line.includes("ship")).length;
				assert.equal(shipRows >= 1, true, label);
				if (width >= 120) {
					assert.ok(
						lines.some((line) => line.includes("ac-compile") && line.includes("ship")),
						`${label}: eight stages on one row`,
					);
				} else {
					assert.ok(
						!lines.some((line) => line.includes("ac-compile") && line.includes("ship")),
						`${label}: stages wrap into two rows`,
					);
				}
			} else {
				assert.ok(!text.includes("┌"), `${label} falls back to flat rows`);
				assert.ok(
					lines.every((line) => visibleWidth(line) <= width),
					`${label}: every flat line fits`,
				);
			}
		}
	}
});

test("colour never enters the width math", () => {
	const ansi = { paint: (_tone: Tone, text: string) => `\u001b[38;5;208m${text}\u001b[39m` };
	for (const width of [120, 80]) {
		for (const layout of ["full", "compact"] as const) {
			const coloured = paintBoard(boardModel(), { width, layout, palette: ansi });
			const plain = paintBoard(boardModel(), { width, layout, palette: PLAIN_PALETTE });
			assert.ok(
				coloured.every((line) => visibleWidth(line) === width),
				`${layout} at ${width} stays ${width} wide with colour`,
			);
			assert.deepEqual(
				coloured.map((line) => stripTerminalSequences(line)),
				plain,
				`${layout} at ${width}: colour changes nothing but colour`,
			);
		}
	}
});

test("tones: the current stage and lit lamps are accent, done stages success, pending dim", () => {
	const seen: Array<[Tone, string]> = [];
	const spy = {
		paint(tone: Tone, text: string) {
			seen.push([tone, text]);
			return text;
		},
	};
	paintBoard(boardModel(), { width: 120, layout: "full", palette: spy });
	const toneOf = (needle: string) => seen.filter(([, text]) => text.trim() === needle).map(([tone]) => tone);
	assert.deepEqual([...new Set(toneOf("CURRENT"))], ["accent"]);
	assert.deepEqual([...new Set(toneOf("DONE"))], ["success"]);
	assert.deepEqual([...new Set(toneOf("PENDING"))], ["dim"]);
	assert.ok(
		toneOf("●").every((tone) => tone === "accent"),
		"lit lamps are accent",
	);
	assert.ok(
		toneOf("○").every((tone) => tone === "dim"),
		"dark lamps are dim",
	);
	assert.ok(
		seen.some(([tone, text]) => tone === "borderAccent" && text.includes("─")),
		"the current cell's border is accent",
	);
	assert.ok(
		seen.some(([tone, text]) => tone === "warning" && text === "STOP RUNNING"),
		"a running STOP box is warning",
	);
});

test("a paused board is the protocol variant with APPROVAL lit", () => {
	const paused = boardModel({
		paused: true,
		stage: "ship",
		node: "human-confirm",
		pendingQuestion: "Ship the change?",
	});
	assert.equal(buildBoardRegions(paused).variant, "blue");
	assert.equal(buildBoardRegions(boardModel()).variant, "amber");
	const seen: Array<[Tone, string]> = [];
	const spy = {
		paint(tone: Tone, text: string) {
			seen.push([tone, text]);
			return text;
		},
	};
	const text = paintBoard(paused, { width: 120, layout: "full", palette: spy }).join("\n");
	for (const field of [
		"K-π PROTOCOL",
		"SHARED RUN STATE",
		"STOP STATES",
		"APPROVAL",
		"THREE LAWS",
		"WAITING ON OPERATOR",
		"Ship the change?",
		"STAGE RAIL",
		"STOP RUNNING",
		"HUMAN OVERSIGHT REQUIRED",
	]) {
		assert.ok(text.includes(field), `the paused board shows ${field}`);
	}
	assert.ok(!text.includes("STOP APPROVAL"), "APPROVAL is a lamp, never a stop state");
	assert.ok(
		seen.some(([tone, text]) => tone === "accent" && text.trim() === "APPROVAL"),
		"APPROVAL is lit",
	);
	assert.ok(
		seen.some(([tone, text]) => tone === "dim" && text.trim() === "DONE"),
		"DONE is dark while paused",
	);
	const compact = paintBoard(paused, { width: 100, layout: "compact" }).join("\n");
	assert.ok(compact.includes("WAITING ON OPERATOR  Ship the change?"), "the widget carries the question");
	assert.ok(compact.includes("APPROVAL ●"), "the widget lights APPROVAL");
});

test("the compact widget is at most 12 lines at 100 columns and keeps STOP and the lamps", () => {
	const running = paintBoard(boardModel(), { width: 100, layout: "compact" });
	assert.ok(running.length <= 12, `running widget is ${running.length} lines`);
	const wide = paintBoard(boardModel(), { width: 120, layout: "compact" });
	assert.ok(wide.length <= 9, `running widget at 120 is ${wide.length} lines`);
	requireFields(running.join("\n"), "the running widget");
	assert.ok(
		running.some((line) => line.includes("FILES") && line.includes("task.json")),
		"lamps stay on one FILES row",
	);
	assert.ok(
		running.some((line) => line.includes("NODE implement") && line.includes("GATE machine")),
		"telemetry row",
	);

	const paused = paintBoard(
		boardModel({
			paused: true,
			pendingQuestion: "All quality gates and isolated review are green. Approve this change for commit?",
		}),
		{ width: 100, layout: "compact" },
	);
	// A paused widget carries the question and STOP STATES as well; the
	// question wraps under its label instead of being cut.
	assert.ok(paused.length <= 14, `paused widget is ${paused.length} lines`);
	const pausedWide = paintBoard(
		boardModel({
			paused: true,
			pendingQuestion: "All quality gates and isolated review are green. Approve this change for commit?",
		}),
		{ width: 120, layout: "compact" },
	);
	assert.ok(pausedWide.length <= 12, `paused widget at 120 is ${pausedWide.length} lines`);
	assert.ok(pausedWide.join("\n").includes("Approve this change for commit?"), "the whole question survives");
	const text = paused.join("\n");
	assert.ok(text.includes("STOP RUNNING"), "STOP survived");
	assert.ok(text.includes("WAITING ON OPERATOR"), "the operator question survived");
	assert.ok(text.includes("04 implement CURRENT"), "the current stage survived");
	for (const name of RUN_FILE_NAMES) {
		assert.ok(text.includes(name), `the ${name} lamp survived`);
	}
});

test("PASS/FAIL reads PENDING until a verdict exists", async () => {
	await withRoot(async (root) => {
		await seedRun(
			root,
			{
				job_id: "pending-1",
				mode: "gated",
				round: 0,
				stage: "plan",
				node: "plan",
				passed: false,
				status: "RUNNING",
			},
			{ "verdict.json": "" },
		);
		await rm(join(root, ".kpi", "runs", "pending-1", "verdict.json"), { force: true });
		let text = (await createStatusWidget(root)).join("\n");
		assert.match(text, /PASS\/FAIL PENDING/);
		assert.doesNotMatch(text, /\bFAIL\b(?! PENDING)/);

		await writeFile(
			join(root, ".kpi", "runs", "pending-1", "verdict.json"),
			'{"status":"REVISE","approved":false}\n',
		);
		text = (await createStatusWidget(root)).join("\n");
		assert.match(text, /FINGERPRINT \S+ {2}FAIL$/m);
	});
});

test("a paused narrow board keeps the operator question and the lamps", () => {
	const lines = renderBoard(
		boardModel({
			width: 60,
			paused: true,
			stop: "RUNNING",
			pendingQuestion: "All quality gates and isolated review are green. Approve this change for commit?",
		}),
	);
	const text = lines.join("\n");
	assert.ok(text.includes("WAITING ON OPERATOR"), "the operator is still told they are the gate");
	assert.ok(text.includes("HUMAN OVERSIGHT"));
	assert.ok(text.includes("STOP STATES"));
	for (const name of RUN_FILE_NAMES) {
		assert.ok(text.includes(name), `the paused board kept the ${name} lamp`);
	}
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 60, `"${line}" fits`);
	}
});

test("a refused board theme is reported once instead of silently ignored", () => {
	resetBoardThemeWarning();
	const notices: Array<{ message: string; level: string }> = [];
	const ctx = {
		ui: {
			setTheme: (name: string) => ({ success: false, error: `Theme not found: ${name}` }),
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
	} as unknown as Parameters<typeof applyBoardTheme>[0];

	// Discarding this result is how the board came up colourless for a whole
	// session with nothing said: the themes K-π ships were not registered when
	// the first board was drawn, so every call failed quietly.
	const first = applyBoardTheme(ctx, false);
	assert.equal(first?.success, false);
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.equal(notices[0]?.level, "warning");
	assert.match(notices[0]?.message ?? "", /loop-amber was refused: Theme not found: loop-amber/u);

	// Once, not once per repaint - the board is redrawn on every state change.
	applyBoardTheme(ctx, true);
	applyBoardTheme(ctx, false);
	assert.equal(notices.length, 1, "the warning does not repeat");
});

test("an applied board theme says nothing and names the board it drew", () => {
	resetBoardThemeWarning();
	const notices: string[] = [];
	const asked: string[] = [];
	const ctx = {
		ui: {
			setTheme: (name: string) => {
				asked.push(name);
				return { success: true };
			},
			notify: (message: string) => notices.push(message),
		},
	} as unknown as Parameters<typeof applyBoardTheme>[0];

	assert.equal(applyBoardTheme(ctx, false)?.success, true);
	assert.equal(applyBoardTheme(ctx, true)?.success, true);
	assert.deepEqual(asked, ["loop-amber", "protocol-blue"]);
	assert.deepEqual(notices, []);
});

test("folding a lamp row preserves every lamp in order", () => {
	const row = `FILES  ${RUN_FILE_NAMES.map((name) => `● ${name}`).join("  ")}`;
	const folded = fitBoard(["K-π board", "04 implement CURRENT", row, "STOP RUNNING"], 40);
	const lampLines = folded.filter((line) => /[●○]/u.test(line));
	assert.ok(lampLines.length > 1, "a 40-column terminal needs more than one lamp row");
	const order = lampLines
		.join("  ")
		.split("  ")
		.filter((token) => /^[●○] \S+$/u.test(token))
		.map((token) => token.slice(2));
	assert.deepEqual(order, [...RUN_FILE_NAMES], "every lamp survived, in order");
	for (const line of folded) {
		assert.ok(visibleWidth(line) <= 40, `"${line}" fits`);
	}
});

// ---------------------------------------------------------------------------
// Board live: the NOW row, per-stage activity and the AGENTS split
// ---------------------------------------------------------------------------

/** plan finished (3m12s, 3 calls, $0.42); implement running (12m04s, 41 calls, $1.20, last tool `edit board.ts`). */
function liveActivity(lastTool = "edit board.ts"): Record<string, StageActivity> {
	return {
		plan: {
			status: "completed",
			runs: 1,
			elapsedMs: 192_000,
			costUsd: 0.42,
			toolCalls: 3,
			toolsByName: { read: 1, grep: 1, edit: 1 },
			lastTool: "edit x.ts",
			model: "m",
			node: "plan",
			result: "stack.json",
		},
		implement: {
			status: "running",
			runs: 1,
			elapsedMs: 724_000,
			costUsd: 1.2,
			toolCalls: 41,
			toolsByName: { edit: 41 },
			lastTool,
			model: "m",
			node: "implement",
		},
	};
}

function nowRowOf(model: BoardModel): Row {
	const now = buildBoardRegions(model).byId.now;
	assert.equal(now?.kind, "rows");
	return now?.kind === "rows" ? (now.rows[0] ?? []) : [];
}

test("elapsed and cost formatters are short and never fabricate a figure", () => {
	assert.equal(formatElapsed(12_000), "12s");
	assert.equal(formatElapsed(192_000), "3m12s");
	assert.equal(formatElapsed(3_720_000), "1h02m");
	for (const ms of [0, 999, 59_999, 60_000, 3_599_999, 3_600_000, 36_000_000, 360_000_000, 8_640_000_000]) {
		assert.ok(formatElapsed(ms).length <= 6, `${ms} ms → ${formatElapsed(ms)}`);
	}
	assert.equal(formatElapsed(360_000_000), "4d04h");
	assert.equal(formatElapsed(8_640_000_000), "99d23h", "a hundred days saturates rather than widens");
	assert.equal(formatCost(0.42), "$0.42");
	assert.equal(formatCost(12), "$12");
	assert.equal(formatCost(undefined), "$—", "an unknown cost is never a fabricated $0");
	assert.equal(shortTool("edit", "/a/b/board.ts"), "edit board.ts");
	assert.equal(shortTool("bash"), "bash");
});

test("the NOW row names the running node and tool and the full board carries elapsed and cost per stage", () => {
	const live = boardModel({ activity: liveActivity() });

	const compact = paintBoard(live, { width: 120, layout: "compact" });
	const nowLine = compact.find((line) => line.startsWith("NOW implement"));
	assert.ok(nowLine !== undefined, "the compact widget carries a NOW row");
	for (const field of ["run 1", "41 tools", "▸ edit board.ts", "12m04s", "$1.20", "MODEL m"]) {
		assert.ok(nowLine.includes(field), `the NOW row carries ${field}`);
	}
	// Height: the design's 10/13 plus the compact cells' detail line (product
	// decision 2026-09-03) — one more line per rail row.
	assert.ok(compact.length <= 11, `the widget with activity is ${compact.length} lines at 120`);
	const narrow = paintBoard(live, { width: 100, layout: "compact" });
	assert.ok(narrow.length <= 14, `the widget with activity is ${narrow.length} lines at 100`);
	// The compact rail is sized from the label lines: eight cells stay on one
	// row at 120 and the detail shrinks to the cell — DONE keeps its cost, then
	// CURRENT its elapsed — instead of wrapping the rail or cutting the figure.
	assert.ok(
		compact.some((line) => line.includes("ac-compile") && line.includes("ship")),
		"eight stages on one compact row with activity",
	);
	const compactDetail = compact.find((line) => line.includes("3m12s · $0.42"));
	assert.ok(compactDetail !== undefined, "the compact DONE cell keeps elapsed and cost at 120");
	assert.ok(compactDetail.includes("edit  12m04s"), "the compact CURRENT cell keeps the tool and elapsed at 120");
	assert.ok(!compactDetail.includes("…"), compactDetail);
	const longTool = paintBoard(boardModel({ activity: liveActivity(`edit ${"x".repeat(60)}.ts`) }), {
		width: 120,
		layout: "compact",
	});
	assert.equal(longTool.length, compact.length, "a long tool target never grows the widget");
	assert.ok(
		longTool.some((line) => line.includes("edit  12m04s")),
		"a long tool target gives way to the elapsed",
	);

	const wide = paintBoard(live, { width: 200, layout: "full" });
	const planDetail = wide.find((line) => line.includes("3m12s · $0.42 est."));
	assert.ok(planDetail !== undefined, "the full plan cell at 200 reads <elapsed> · $<cost> est. in one rail row");
	assert.ok(planDetail.includes("edit board.ts  12m04s"), "the implement cell reads <lastTool>  <elapsed>");
	assert.ok(/│\s+—\s+│/u.test(planDetail), "pending cells carry a — detail line");
	assert.equal(
		wide.length,
		paintBoard(boardModel(), { width: 200, layout: "full" }).length + 2,
		"activity adds exactly one detail line per rail row to the full board at 200 (one row of eight, plus NOW)",
	);
	const full = paintBoard(live, { width: 120, layout: "full" });
	assert.ok(
		full.some((line) => line.includes("3m12s · $0.42") && line.includes("edit  12m04s")),
		"the full board at 120 shrinks the detail the same way",
	);

	for (const width of [200, 120, 80, 60]) {
		for (const layout of ["full", "compact"] as const) {
			const lines = paintBoard(live, { width, layout });
			const text = lines.join("\n");
			const label = `${layout} at ${width} with activity`;
			requireFields(text, label);
			const now = lines.find((line) => line.trimStart().startsWith("NOW implement"));
			assert.ok(now !== undefined, `${label} keeps the NOW row`);
			for (const field of ["41 tools", "12m04s", "$1.20"]) {
				assert.ok(now.includes(field), `${label}: the NOW row keeps ${field}`);
			}
			assert.ok(!now.includes("…"), `${label}: the NOW row shrinks, it is never cut: ${now}`);
		}
	}

	const flat = renderBoard(live);
	const flatNow = flat.find((line) => line.startsWith("NOW implement"));
	assert.ok(flatNow !== undefined && !flatNow.includes("CURRENT"), "the flat board carries the NOW line");
	assert.equal((flat.join("\n").match(/CURRENT/gu) ?? []).length, 1);

	const unreadable = renderBoard(boardModel({ activity: liveActivity(), eventsUnreadable: 2 })).join("\n");
	assert.ok(unreadable.includes("EVENTS ✕ 2 unreadable"));
	const failed = renderBoard(boardModel({ activity: liveActivity(), eventsError: "EACCES" })).join("\n");
	assert.ok(failed.includes("EVENTS ✕ EACCES"));
	const silent = renderBoard(boardModel({ activity: {} })).join("\n");
	assert.ok(silent.includes("NOW implement  no node.started yet"));

	const seen: Array<[Tone, string]> = [];
	const spy = {
		paint(tone: Tone, text: string) {
			seen.push([tone, text]);
			return text;
		},
	};
	const selected = paintBoard(boardModel({ activity: liveActivity(), selectedStage: 4 }), {
		width: 120,
		layout: "full",
		palette: spy,
	});
	assert.ok(
		seen.some(([tone, text]) => tone === "warning" && text.trim() === "test"),
		"the selected 05 cell is painted in the warning tone",
	);
	assert.equal((selected.join("\n").match(/CURRENT/gu) ?? []).length, 1, "selection never adds a CURRENT");
});

test("the NOW row shrinks its optional spans instead of forcing the STOP box below", () => {
	const row = nowRowOf(
		boardModel({ activity: liveActivity("edit packages/coding-agent/src/kpi/extensions/board.ts") }),
	);
	const at = (width: number) => paintShrinkingRow(row, width, PLAIN_PALETTE);
	const wide = at(200);
	assert.ok(
		["MODEL m", "▸ edit", "run 1"].every((field) => wide.includes(field)),
		"everything fits at 200",
	);
	const shrunk = at(60);
	assert.ok(!shrunk.includes("…"), `no ellipsis while an optional span remains: ${shrunk}`);
	for (const field of ["NOW implement", "41 tools", "12m04s", "$1.20"]) {
		assert.ok(shrunk.includes(field), `the shrunk NOW row keeps ${field}`);
	}
	// Drop order, right to left: MODEL first, then the tool, then the run.
	const droppedModel = at(visibleWidth(wide.trimEnd()) - 1);
	assert.ok(!droppedModel.includes("MODEL") && droppedModel.includes("▸ edit") && droppedModel.includes("run 1"));
	const droppedTool = at(visibleWidth(droppedModel.trimEnd()) - 1);
	assert.ok(!droppedTool.includes("▸") && droppedTool.includes("run 1") && droppedTool.includes("41 tools"));
	const droppedRun = at(visibleWidth(droppedTool.trimEnd()) - 1);
	assert.ok(!droppedRun.includes("run 1") && droppedRun.includes("41 tools") && !droppedRun.includes("…"));
	// Nothing optional left: only now may the row be cut.
	assert.ok(at(20).endsWith("…"));

	const short = paintBoard(boardModel({ activity: liveActivity() }), { width: 100, layout: "compact" });
	const long = paintBoard(boardModel({ activity: liveActivity(`edit ${"y".repeat(65)}.ts`) }), {
		width: 100,
		layout: "compact",
	});
	assert.equal(long.length, short.length, "a 70-char tool target never pushes the STOP box below");
	// The box sits beside the telemetry block (three rows tall, so it flanks
	// LOOP/ROUND/CONTEXT) and the NOW row under it shrank instead of being cut.
	assert.ok(
		long.some((line) => line.startsWith("ROUND ") && line.includes("│ STOP RUNNING │")),
		"the STOP box stays beside the telemetry block",
	);
	const nowLine = long.find((line) => line.startsWith("NOW implement"));
	assert.ok(nowLine !== undefined && !nowLine.includes("…") && !nowLine.includes("▸"), nowLine);
});

test("the AGENTS cell breaks live sessions into nodes and workers", () => {
	const split = paintBoard(boardModel({ agents: 3, sessions: { nodes: 1, workers: 2 } }), {
		width: 120,
		layout: "compact",
	}).join("\n");
	assert.ok(split.includes("AGENTS 3 · 1 node · 2 workers"), split);
	const plural = renderBoard(boardModel({ agents: 2, sessions: { nodes: 2, workers: 0 } })).join("\n");
	assert.ok(plural.includes("AGENTS 2 · 2 nodes · 0 workers"), plural);
	const countOnly = renderBoard(boardModel({ agents: 1 })).join("\n");
	assert.match(countOnly, /AGENTS 1 {2}BUS/u, "without the split the cell is the count alone");
});

test("the board shows ROUND without a maximum and a retry row while a node backs off", () => {
	const retrying = boardModel({ retry: { node: "implement", attempt: 3, reason: "timeout", delayMs: 8_000 } });
	for (const width of [200, 120, 100, 80, 60]) {
		for (const layout of ["full", "compact"] as const) {
			const lines = paintBoard(retrying, { width, layout });
			const text = lines.join("\n");
			const label = `${layout} at ${width}`;
			assert.ok(text.includes("ROUND 2"), `${label} shows ROUND 2`);
			assert.doesNotMatch(text, /ROUND 2[\d/]/u, `${label} shows no maximum after ROUND 2`);
			assert.ok(text.includes("RETRY 3 · timeout · next 8s"), `${label} carries the retry row`);
			assert.ok(text.includes("STOP RUNNING"), `${label} keeps STOP RUNNING while backing off`);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= width),
				`${label}: no line wider than ${width}`,
			);
		}
	}
	const flat = renderBoard(retrying).join("\n");
	assert.match(flat, /^RETRY 3 · timeout · next 8s$/mu, "the flat board carries the retry row on its own line");
	assert.doesNotMatch(renderBoard(boardModel()).join("\n"), /RETRY/u, "no retry row without a retry");
	const flatWide = renderBoard(
		boardModel({ round: 12, retry: { node: "plan", attempt: 1, reason: "http", delayMs: 1_000 } }),
	);
	assert.ok(
		flatWide.some((line) => line.startsWith("ROUND 12  ")),
		"the iteration line reads ROUND 12 with no maximum",
	);
	assert.ok(
		flatWide.some((line) => line === "RETRY 1 · http · next 1s"),
		"the first retry waits one second",
	);

	const bounds = boardModel({ stop: "NEEDS_HUMAN", recovery: "bounds", paused: false });
	const boundsText = paintBoard(bounds, { width: 120, layout: "full" }).join("\n");
	assert.ok(boundsText.includes("│ STOP NEEDS_HUMAN bounds │"), "a bounds pause names its recovery in the STOP box");
	assert.ok(renderBoard(bounds).includes("STOP NEEDS_HUMAN bounds"), "the flat board names the recovery too");
	/** The tone the STOP box is painted in for a model, at 120 columns. */
	const stopBoxTone = (model: BoardModel, layout: "full" | "compact", text: string): Tone | undefined => {
		let found: Tone | undefined;
		paintBoard(model, {
			width: 120,
			layout,
			palette: {
				paint(tone, painted) {
					if (painted === text) found = tone;
					return painted;
				},
			},
		});
		return found;
	};
	assert.equal(
		stopBoxTone(bounds, "compact", "STOP NEEDS_HUMAN bounds"),
		"accent",
		"a NEEDS_HUMAN STOP box is accent",
	);

	const stopped = boardModel({ stop: "STOPPED" });
	assert.ok(paintBoard(stopped, { width: 100, layout: "compact" }).join("\n").includes("│ STOP STOPPED │"));
	assert.equal(stopBoxTone(stopped, "full", "STOP STOPPED"), "error", "an operator stop is error");
	assert.equal(stopBoxTone(boardModel({ stop: "DONE" }), "full", "STOP DONE"), "success", "DONE is success");

	// Board B: the stop-state cells are DONE / STOPPED / APPROVAL. APPROVAL is the
	// pause lamp (Board B only paints while a human node is paused); DONE and
	// STOPPED light for the run state.
	const pausedStopped = boardModel({
		paused: true,
		stage: "ship",
		node: "human-confirm",
		pendingQuestion: "Ship?",
		stop: "STOPPED",
	});
	const cells = buildBoardRegions(pausedStopped).byId.stopStates;
	assert.ok(cells?.kind === "cells");
	assert.deepEqual(
		cells.cells.map((cell) => [cell.lines[0], cell.lit]),
		[
			["DONE", false],
			["STOPPED", true],
			["APPROVAL", true],
		],
	);
	const pausedText = paintBoard(pausedStopped, { width: 120, layout: "full" }).join("\n");
	assert.ok(pausedText.includes("STOPPED"), "Board B has a STOPPED cell");
	assert.ok(!pausedText.includes("BLOCKED"), "BLOCKED is no longer a stop state");
	const compactPaused = paintBoard(pausedStopped, { width: 100, layout: "compact" }).join("\n");
	assert.ok(compactPaused.includes("STOP STATES  DONE ○  STOPPED ●  APPROVAL ●"), compactPaused);
});

test("legacy stop tokens on disk normalise to the four run states", () => {
	assert.equal(normalizeStop(undefined), "RUNNING");
	assert.equal(normalizeStop("running"), "RUNNING");
	assert.equal(normalizeStop("APPROVAL"), "RUNNING");
	assert.equal(normalizeStop("INTERRUPTED"), "RUNNING");
	assert.equal(normalizeStop("COMPLETED"), "DONE");
	assert.equal(normalizeStop("DONE"), "DONE");
	assert.equal(normalizeStop("STOPPED"), "STOPPED");
	assert.equal(normalizeStop("NEEDS_HUMAN"), "NEEDS_HUMAN");
	for (const legacy of ["BLOCKED", "EXHAUSTED", "NO_PROGRESS", "UNSAFE"]) {
		assert.equal(normalizeStop(legacy), "NEEDS_HUMAN", `${legacy} is a NEEDS_HUMAN of an earlier release`);
	}
	assert.equal(normalizeStop("garbage"), "RUNNING");
	assert.equal(stopTone("RUNNING"), "warning");
	assert.equal(stopTone("NEEDS_HUMAN"), "accent");
	assert.equal(stopTone("DONE"), "success");
	assert.equal(stopTone("STOPPED"), "error");
});
