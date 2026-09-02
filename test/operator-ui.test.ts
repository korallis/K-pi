import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type BoardModel,
	fitBoard,
	RUN_FILE_NAMES,
	renderBoard,
	researchCellFromDocument,
	resolveCurrentStageIndex,
} from "../packages/coding-agent/src/kpi/extensions/board.ts";
import {
	buildBoardModel,
	createStatusWidget,
	isPausedHuman,
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
			maxRounds: 3,
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
				maxRounds: 3,
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
			maxRounds: 3,
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
		await writeState(runDirectory, task, graphState as never, createStopState(3));
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
		maxRounds: 3,
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
	assert.ok(lines.every((line) => line.length <= 40));
});

test("board and status rendering never call a model client", async () => {
	await withRoot(async (root) => {
		await seedRun(root, {
			job_id: "no-model",
			mode: "gated",
			round: 0,
			maxRounds: 3,
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
			maxRounds: 3,
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
					maxRounds: 3,
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
		maxRounds: 3,
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
		maxRounds: 3,
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
				maxRounds: 3,
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
		maxRounds: 3,
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

test("every width keeps the six file lamps, the current stage, and STOP", () => {
	for (const width of [200, 120, 80, 60]) {
		const lines = renderBoard(boardModel({ width }));
		const text = lines.join("\n");
		for (const name of RUN_FILE_NAMES) {
			assert.ok(text.includes(name), `width ${width} kept the ${name} lamp`);
		}
		// A dark lamp must stay legible as dark, not vanish behind an ellipsis.
		assert.ok(text.includes("○ candidate.json"), `width ${width} kept the dark candidate lamp`);
		assert.ok(text.includes("○ verdict.json"), `width ${width} kept the dark verdict lamp`);
		assert.ok(text.includes("04 implement CURRENT"), `width ${width} kept the current stage`);
		assert.ok(text.includes("STOP RUNNING"), `width ${width} kept STOP`);
		assert.ok(
			lines.some((line) => line.startsWith("K-π")),
			`width ${width} kept the brand`,
		);
		if (width < 100) {
			for (const line of lines) {
				assert.ok(line.length <= width, `width ${width}: "${line}" fits`);
			}
		}
	}
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
		assert.ok(line.length <= 60, `"${line}" fits`);
	}
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
		assert.ok(line.length <= 40, `"${line}" fits`);
	}
});
