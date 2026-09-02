/**
 * UAT-25 — US-25 TUI is information-complete, not pixel-perfect.
 *
 * Action: capture the board at COLUMNS=200, 120, 80 and 60.
 *
 * Pixel match is not required, so nothing here compares layout. What is checked
 * is that every required field survives every width, in the board the operator
 * is actually shown - including the lamps, which must stay legible as lit or
 * dark rather than disappearing behind an ellipsis.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesOf, check, drive, egressClean, freePort, sandbox, seedRun, startStub, teardown, writeRow, repoRoot } from "./lib.mjs";

const EVIDENCE = join(repoRoot, ".kpi", "uat", "UAT-25");
const JOB = "20260902-uat25";
const WIDTHS = [200, 120, 80, 60];
const LAMPS = ["task.json", "context.md", "candidate.json", "evidence.json", "verdict.json", "events.jsonl"];

const task = {
	job_id: JOB,
	mode: "gated",
	goal: "Width sweep",
	nongoals: [],
	acceptance: [],
	constraints: ["Never push"],
	quality_gates: ["npm test"],
	ac: { quality: "executable" },
};

const RUNNING = {
	job_id: JOB,
	mode: "gated",
	round: 2,
	maxRounds: 3,
	stage: "implement",
	node: "implement",
	status: "RUNNING",
	graph_status: "running",
	passed: true,
};

const PAUSED = {
	...RUNNING,
	stage: "review",
	node: "human",
	graph_status: "interrupted",
	pending_question: "Approve gated release?",
};

async function capture(label, { state, cols, outDir }) {
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
	seedRun(box.project, JOB, {
		task,
		state,
		files: {
			"candidate.json": "{}\n",
			"evidence.json": '{"ac":[]}\n',
			"verdict.json": '{"approved":true}\n',
			"events.jsonl": '{"type":"handoff.created"}\n',
		},
	});
	const paused = state.graph_status === "interrupted";
	const result = await drive({
		env: box.env,
		cwd: box.project,
		cols,
		rows: 50,
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

/** The board an operator is shown at this width, last paint. */
function lastBoard(text) {
	const marker = text.lastIndexOf("K-\u03c0  LOOP");
	return marker === -1 ? text : text.slice(marker);
}

const runs = [];
for (const cols of WIDTHS) {
	const running = await capture(`u25-r${cols}`, { state: RUNNING, cols, outDir: join(EVIDENCE, `running-${cols}`) });
	const paused = await capture(`u25-p${cols}`, { state: PAUSED, cols, outDir: join(EVIDENCE, `paused-${cols}`) });
	runs.push({ cols, running, paused });
}

const rows = runs.map(({ cols, running, paused }) => {
	const board = lastBoard(running.text);
	const pausedBoard = lastBoard(paused.text);
	const missingLamps = LAMPS.filter((name) => !board.includes(name));
	return {
		cols,
		brand: running.raw.includes(bytesOf("K-π")),
		mode: board.includes(`MODE ${RUNNING.mode}`),
		job: board.includes(`JOB ${JOB}`),
		round: board.includes(`ROUND ${RUNNING.round}/${RUNNING.maxRounds}`),
		stages: ["01", "02", "03", "04", "05", "06", "07", "08"].every((id) => board.includes(id)),
		currentStage: /CURRENT/u.test(board),
		passFail: /PASS|FAIL/u.test(board),
		lamps: missingLamps.length === 0,
		missingLamps,
		stop: /STOP RUNNING/u.test(board),
		pausedWaiting: /WAITING ON OPERATOR/u.test(pausedBoard),
		pausedQuestion: pausedBoard.includes("Approve gated release?"),
		pausedStop: /STOP\s+(RUNNING|STATES)/u.test(pausedBoard),
		truncated: running.text.includes("widget truncated") || paused.text.includes("widget truncated"),
		egressClean: running.egress.clean && paused.egress.clean,
	};
});
writeFileSync(join(EVIDENCE, "width-matrix.json"), `${JSON.stringify(rows, null, 2)}\n`);

const field = (name, pick) =>
	check(
		name,
		"width-matrix.json",
		rows.every(pick),
		rows.map((row) => `${row.cols}:${pick(row) ? "ok" : "MISSING"}`).join(" "),
	);

const checks = [
	field("brand-at-every-width", (row) => row.brand),
	field("mode-at-every-width", (row) => row.mode),
	field("job-at-every-width", (row) => row.job),
	field("round-at-every-width", (row) => row.round),
	field("stages-01-08-at-every-width", (row) => row.stages),
	field("current-stage-at-every-width", (row) => row.currentStage),
	field("pass-fail-at-every-width", (row) => row.passFail),
	check(
		"six-lamps-at-every-width",
		"width-matrix.json",
		rows.every((row) => row.lamps),
		rows.map((row) => `${row.cols}:${row.lamps ? "6/6" : `missing ${row.missingLamps.join(",")}`}`).join(" "),
	),
	field("stop-at-every-width", (row) => row.stop),
	field("paused-waiting-on-operator-at-every-width", (row) => row.pausedWaiting),
	field("paused-question-at-every-width", (row) => row.pausedQuestion),
	field("paused-stop-visible-at-every-width", (row) => row.pausedStop),
	check(
		"no-width-drops-board-rows",
		"width-matrix.json",
		rows.every((row) => !row.truncated),
		rows.map((row) => `${row.cols}:${row.truncated ? "TRUNCATED" : "whole"}`).join(" "),
	),
	check("loopback-only", "egress", rows.every((row) => row.egressClean), "no outbound attempt"),
];

/**
 * Control: a field the board must never contain, checked the same way at the
 * same widths. If a "required field present" check can pass for a string the
 * board never prints, the matrix is matching something other than the board.
 */
const sentinel = "STOP NOT_A_STOP_STATE";
const sentinelHits = runs.filter(({ running }) => lastBoard(running.text).includes(sentinel)).map(({ cols }) => cols);

const verdict = writeRow(EVIDENCE, "UAT-25", {
	checks,
	control: {
		describe: `The same matrix is asked for a field the board never prints (\`${sentinel}\`) at all four widths. Every width must fail to find it, otherwise the presence checks are not reading the board.`,
		failedChecks: sentinelHits.length === 0 ? WIDTHS.map((cols) => `sentinel-absent-at-${cols}`) : [],
	},
	notes: `Eight captures: running and paused at COLUMNS=200, 120, 80 and 60, each a fresh clean HOME, scratch git repo and loopback stub, driven over a real PTY against \`dist/bundle/cli.js\`.

Each width is graded on the **last board painted** in that capture, because the frame carries both the always-on widget and the \`/kpi status\` overlay; grading the whole stream would double-count every field.

\`width-matrix.json\` records, per width, each required field as present or missing — so a regression names the width and the field rather than just failing.

Pixel match is not asserted anywhere: no width comparison, no layout diff, only presence.`,
});

console.log(JSON.stringify(verdict.checks.map((entry) => `${entry.ok ? "ok" : "FAIL"} ${entry.id}: ${entry.observed}`), null, 1));
console.log("control discriminates:", verdict.control?.discriminates);
