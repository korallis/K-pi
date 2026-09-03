/**
 * UAT-16 — US-16 Graph-engineering TUI (Avid boards).
 *
 * Action: capture the amber board mid-run and the protocol-blue board while a
 * human node is paused; delete one run file and capture again.
 *
 * The dark lamp is made real: `verdict.json` is written and then removed, so the
 * lamp is dark because the file is absent, not because it was never named.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AMBER, bytesOf, check, drive, egressClean, fgTruecolor, freePort, PROTOCOL_BLUE, sandbox, seedRun, startStub, teardown, writeRow, repoRoot } from "./lib.mjs";

const EVIDENCE = join(repoRoot, ".kpi", "uat", "UAT-16");
const JOB = "20260902-uat16";
const LAMPS = ["task.json", "context.md", "candidate.json", "evidence.json", "verdict.json", "events.jsonl"];

const task = {
	job_id: JOB,
	mode: "gated",
	goal: "Graph board",
	nongoals: [],
	acceptance: [{ id: "AC-01", statement: "board renders", required: true }],
	constraints: ["Never push"],
	quality_gates: ["npm test"],
	ac: { quality: "executable" },
};

async function capture(label, { state, outDir, darkFile }) {
	const port = await freePort();
	const box = sandbox(label, { baseUrl: `http://127.0.0.1:${port}/v1`, port });
	writeFileSync(
		join(box.home, "screenplay.json"),
		JSON.stringify({
			models: ["uat-stub"],
			scenes: [{ node: "any", match: {}, turns: [{ content: "TURNDONE", usage: { prompt_tokens: 120, completion_tokens: 4 } }] }],
		}),
	);
	const stub = await startStub(port, join(box.home, "model.jsonl"), join(box.home, "screenplay.json"));
	const runDirectory = seedRun(box.project, JOB, {
		task,
		state,
		files: {
			"candidate.json": "{}\n",
			"evidence.json": '{"ac":[]}\n',
			"verdict.json": '{"approved":true}\n',
			"events.jsonl": '{"type":"handoff.created"}\n',
		},
	});
	if (darkFile !== undefined) {
		// Written above, then deleted: the lamp must report the file the operator
		// no longer has, which is different from a lamp that was never wired.
		rmSync(join(runDirectory, darkFile), { force: true });
	}
	const paused = state.graph_status === "interrupted";
	const result = await drive({
		env: box.env,
		cwd: box.project,
		cols: 140,
		script: [
			{ expect: paused ? "WAITING ON OPERATOR" : "STOP RUNNING", send: "/kpi status\r", timeout: 40 },
			{ expect: paused ? "THREE LAWS" : "NODE implement", timeout: 30, drain: 3, after: 2.5 },
		],
		outDir,
	});
	const egress = egressClean(box);
	teardown(box, stub);
	return { ...result, egress };
}

const RUNNING = {
	job_id: JOB,
	mode: "gated",
	round: 2,
	stage: "implement",
	node: "implement",
	status: "RUNNING",
	graph_status: "running",
	passed: true,
};

const PAUSED = {
	job_id: JOB,
	mode: "gated",
	round: 2,
	stage: "review",
	node: "human",
	status: "RUNNING",
	graph_status: "interrupted",
	pending_question: "Approve gated release?",
	passed: true,
};

const amberRun = await capture("u16-amber", { state: RUNNING, outDir: join(EVIDENCE, "amber") });
const pausedRun = await capture("u16-paused", { state: PAUSED, outDir: join(EVIDENCE, "paused") });
const darkRun = await capture("u16-dark", {
	state: RUNNING,
	outDir: join(EVIDENCE, "dark-lamp"),
	darkFile: "verdict.json",
});

const amberBytes = fgTruecolor(AMBER);
const blueBytes = fgTruecolor(PROTOCOL_BLUE);

// The stage rail: 01..08 with exactly one CURRENT.
const stageIds = ["01", "02", "03", "04", "05", "06", "07", "08"];
const missingStages = stageIds.filter((id) => !amberRun.raw.includes(bytesOf(id)));
/**
 * "Exactly one lit" is a claim about one board, and the frame carries two: the
 * always-on widget and the `/kpi status` overlay. Counting the whole stream
 * would report one CURRENT per board and call it a defect.
 */
function lastBoard(text) {
	const marker = Math.max(text.lastIndexOf("K-\u03c0 GRAPH CONTROL"), text.lastIndexOf("K-\u03c0 PROTOCOL"));
	return marker === -1 ? text : text.slice(marker);
}
const boardsPainted = (amberRun.text.match(/K-\u03c0 (?:GRAPH CONTROL|PROTOCOL)/gu) ?? []).length;
const currentCount = (lastBoard(amberRun.text).match(/CURRENT/gu) ?? []).length;

// Lamp order, read from the painted row rather than from the constant.
const lampRow = (amberRun.text.split("\n").find((line) => line.includes("FILES") && line.includes("task.json")) ?? "").replace(/\r/gu, "");
const lampOrder = LAMPS.map((name) => lampRow.indexOf(name));
const lampsInOrder = lampOrder.every((at, index) => at >= 0 && (index === 0 || at > lampOrder[index - 1]));

// The deliberately dark lamp.
const darkLampRow = (darkRun.text.split("\n").find((line) => line.includes("verdict.json")) ?? "").replace(/\r/gu, "");
const litLampRow = (amberRun.text.split("\n").find((line) => line.includes("verdict.json")) ?? "").replace(/\r/gu, "");
const darkLampDark = /○ verdict\.json/u.test(darkLampRow);
const litLampLit = /● verdict\.json/u.test(litLampRow);

const checks = [
	check("amber-board", "amber/frame.raw", amberRun.raw.includes(amberBytes), `${AMBER} on the wire`),
	check(
		"header-regions",
		"amber/frame.raw",
		["K-π", `MODE ${RUNNING.mode}`, `JOB ${JOB}`, `ROUND ${RUNNING.round}`].every((cell) =>
			amberRun.raw.includes(bytesOf(cell)),
		),
		(amberRun.text.match(/K-π\s+LOOP[^\n]*/u) ?? ["absent"])[0].replace(/\r/gu, "").trim(),
	),
	check(
		"header-round-unbounded",
		"amber/frame.txt",
		new RegExp(`ROUND ${RUNNING.round}(?![\\d/])`, "u").test(amberRun.text.replace(/\r/gu, "")),
		(amberRun.text.match(/ROUND[^\n]*/u) ?? ["absent"])[0].replace(/\r/gu, "").trim(),
	),
	check(
		"context-layer-lamps",
		"amber/frame.txt",
		/CONTEXT LAYER/u.test(amberRun.text) && /AGENTS \d+/u.test(amberRun.text) && /BUS/u.test(amberRun.text),
		(amberRun.text.match(/CONTEXT LAYER[^\n]*/u) ?? ["absent"])[0].replace(/\r/gu, "").trim(),
	),
	check(
		"stages-01-08-one-current",
		"amber/frame.txt",
		missingStages.length === 0 && currentCount === 1,
		`stages present: ${stageIds.length - missingStages.length}/8, CURRENT count ${currentCount} in the last of ${boardsPainted} board(s) painted`,
	),
	check(
		"iteration-pass-fail",
		"amber/frame.txt",
		/PASS\/FAIL|PASS\b|FAIL\b/u.test(amberRun.text),
		(amberRun.text.match(/ROUND[^\n]*/u) ?? ["absent"])[0].replace(/\r/gu, "").trim(),
	),
	check(
		"six-lamps-in-order",
		"amber/frame.txt",
		lampsInOrder,
		lampRow.trim().slice(0, 130) || "no lamp row",
	),
	check("stop-region", "amber/frame.raw", amberRun.raw.includes(bytesOf("STOP RUNNING")), "STOP RUNNING"),
	check(
		"deliberately-dark-lamp-goes-dark",
		"dark-lamp/frame.txt",
		darkLampDark,
		darkLampRow.trim().slice(0, 130) || "no lamp row",
	),
	check(
		"the-same-lamp-is-lit-when-the-file-exists",
		"amber/frame.txt",
		litLampLit,
		litLampLit ? "● verdict.json with the file present" : "lamp not lit even with the file present",
	),
	check("paused-protocol-blue", "paused/frame.raw", pausedRun.raw.includes(blueBytes), `${PROTOCOL_BLUE} on the wire`),
	check(
		"paused-shared-run-state",
		"paused/frame.raw",
		pausedRun.raw.includes(bytesOf("SHARED RUN STATE")),
		"SHARED RUN STATE",
	),
	check(
		"paused-stop-states-approval-lit",
		"paused/frame.txt",
		/STOP STATES/u.test(pausedRun.text) && /APPROVAL/u.test(pausedRun.text),
		(pausedRun.text.match(/STOP STATES[^\n]*/u) ?? ["absent"])[0].replace(/\r/gu, "").trim(),
	),
	check(
		"paused-three-laws",
		"paused/frame.raw",
		pausedRun.raw.includes(bytesOf("THREE LAWS")),
		"THREE LAWS",
	),
	check(
		"paused-waiting-on-operator-with-question",
		"paused/frame.raw",
		pausedRun.raw.includes(bytesOf("WAITING ON OPERATOR")) && pausedRun.raw.includes(bytesOf("Approve gated release?")),
		(pausedRun.text.match(/WAITING ON OPERATOR[^\n]*/u) ?? ["absent"])[0].replace(/\r/gu, "").trim(),
	),
	check(
		"board-is-never-a-markdown-table",
		"amber/frame.txt",
		!/\|\s*-{3,}\s*\|/u.test(amberRun.text) && !/^\s*\|.*\|\s*$/mu.test(amberRun.text),
		"no markdown table pipes in the painted board",
	),
	check(
		"no-widget-truncation",
		"paused/frame.txt",
		!pausedRun.text.includes("widget truncated"),
		pausedRun.text.includes("widget truncated") ? "board rows were dropped" : "the whole board reached the operator",
	),
	check(
		"loopback-only",
		"egress",
		[amberRun, pausedRun, darkRun].every((run) => run.egress.clean),
		"no outbound attempt",
	),
];

const verdict = writeRow(EVIDENCE, "UAT-16", {
	checks,
	notes: `Driven against \`dist/bundle/cli.js\` over a real PTY at 140 columns, clean HOME, scratch git repo, loopback stub, egress guard.

Three captures: the amber running board, the protocol-blue paused board, and a running board whose \`verdict.json\` was written and then deleted.

Colour is graded on truecolor SGR bytes. Region and lamp claims are graded on the literal cells, with the lamp order read from the painted row so a reordering in the source would fail here rather than agree with itself.

The paused board's full form is reached through \`/kpi status\`, which is the row's own action ("\`/kpi status\` expands it"); the always-on widget carries the fitted board.`,
});

console.log(JSON.stringify(verdict.checks.map((entry) => `${entry.ok ? "ok" : "FAIL"} ${entry.id}: ${entry.observed.slice(0, 70)}`), null, 1));

