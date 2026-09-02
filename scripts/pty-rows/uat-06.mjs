/**
 * UAT-06 — US-06 Control-board TUI.
 *
 * Action: start a job and capture the widget; let it pause on a human node and
 * capture again; run `/kpi status` with the model provider unreachable.
 *
 * Every assertion reads `frame.raw`. The amber and protocol-blue claims are
 * graded on the truecolor SGR bytes a terminal receives, so a board that
 * resolved the wrong theme, or lost colour entirely, cannot pass.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	AMBER,
	bytesOf,
	check,
	drive,
	egressClean,
	fgTruecolor,
	freePort,
	PROTOCOL_BLUE,
	sandbox,
	seedRun,
	startStub,
	teardown,
	writeRow,
} from "./lib.mjs";

const JOB = "20260902-uat06";
const task = {
	job_id: JOB,
	mode: "gated",
	goal: "Add a healthcheck endpoint",
	nongoals: [],
	acceptance: [{ id: "AC-01", statement: "GET /health returns 200", required: true }],
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
};

const PAUSED = {
	job_id: JOB,
	mode: "gated",
	round: 2,
	maxRounds: 3,
	stage: "review",
	node: "human",
	status: "RUNNING",
	graph_status: "interrupted",
	pending_question: "Approve gated release?",
};

/**
 * `stubDown` never starts the loopback provider, so the provider is genuinely
 * unreachable. A board that still draws proves the board starts no model.
 *
 * When the provider is up the capture also takes one real turn, because the
 * accounts widget publishes a slot only once a request has actually been
 * credentialed - so "no percentage for a local slot" can only be read after
 * traffic, not from a cold start.
 */
async function capture(outDir, state, { stubDown = false } = {}) {
	const port = await freePort();
	const box = sandbox(`uat06-${stubDown ? "down" : "up"}`, { baseUrl: `http://127.0.0.1:${port}/v1`, port });
	let stub;
	if (!stubDown) {
		writeFileSync(
			join(box.home, "screenplay.json"),
			JSON.stringify({
				models: ["uat-stub"],
				scenes: [{ node: "any", match: {}, turns: [{ content: "TURNDONE", usage: { prompt_tokens: 120, completion_tokens: 4 } }] }],
			}),
		);
		stub = await startStub(port, join(box.home, "model.jsonl"), join(box.home, "screenplay.json"));
	}
	seedRun(box.project, JOB, {
		task,
		state,
		files: { "candidate.json": "{}\n", "evidence.json": "{}\n", "events.jsonl": "" },
	});
	const anchor = state === PAUSED ? "WAITING ON OPERATOR" : "STOP RUNNING";
	const script = stubDown
		? [
				{ expect: anchor, send: "/kpi status\r", timeout: 40 },
				{ expect: "NODE implement", timeout: 30, drain: 3, after: 2.5 },
			]
		: [
				{ expect: anchor, send: "/kpi off\r", timeout: 40 },
				{ expect: "goal wrapping off", send: "say ok\r", timeout: 30 },
				// The accounts widget publishes when a request is credentialed, and
				// the status area is shared with the K-π status - so wait for the
				// paint rather than hoping the drain catches it.
				{ expect: "LOCAL-OPENAI", timeout: 45 },
				{ expect: "TURNDONE", send: "/kpi status\r", timeout: 45 },
				{
					expect: state === PAUSED ? "THREE LAWS|STOP STATES" : "NODE implement",
					timeout: 30,
					drain: 3,
					after: 2.5,
				},
			];
	const result = await drive({ env: box.env, cwd: box.project, cols: 120, script, outDir });
	const egress = egressClean(box);
	teardown(box, stub);
	return { ...result, egress };
}

const runningDir = "/tmp/kpi-pty/evidence/UAT-06/running";
const pausedDir = "/tmp/kpi-pty/evidence/UAT-06/paused";
const downDir = "/tmp/kpi-pty/evidence/UAT-06/provider-unreachable";

const running = await capture(runningDir, RUNNING);
const paused = await capture(pausedDir, PAUSED);
const down = await capture(downDir, RUNNING, { stubDown: true });

const amber = fgTruecolor(AMBER);
const blue = fgTruecolor(PROTOCOL_BLUE);
// AC-06.2's widget field list, checked as literal cells on the wire.
const FIELDS = ["LOOP", "MODE", "ROUND", "STAGE", "NODE", "GATE", "STOP", "FILES"];
const missingFields = FIELDS.filter((field) => !running.raw.includes(bytesOf(field)));

const checks = [
	check(
		"amber-while-running",
		"running/frame.raw",
		running.raw.includes(amber),
		running.raw.includes(amber) ? `${AMBER} on the wire` : `${AMBER} absent`,
	),
	check(
		"running-is-not-paused-blue",
		"running/frame.raw",
		!running.raw.includes(blue),
		running.raw.includes(blue) ? `${PROTOCOL_BLUE} leaked into the running board` : `${PROTOCOL_BLUE} absent, as it must be`,
	),
	check(
		"protocol-blue-while-paused",
		"paused/frame.raw",
		paused.raw.includes(blue),
		paused.raw.includes(blue) ? `${PROTOCOL_BLUE} on the wire` : `${PROTOCOL_BLUE} absent`,
	),
	check(
		"paused-is-not-running-amber",
		"paused/frame.raw",
		!paused.raw.includes(amber),
		paused.raw.includes(amber) ? `${AMBER} leaked into the paused board` : `${AMBER} absent, as it must be`,
	),
	check(
		"widget-fields",
		"running/frame.raw",
		missingFields.length === 0,
		missingFields.length === 0 ? FIELDS.join(", ") : `missing ${missingFields.join(", ")}`,
	),
	check(
		"pending-question-shown",
		"paused/frame.raw",
		paused.raw.includes(bytesOf("Approve gated release?")),
		paused.raw.includes(bytesOf("Approve gated release?")) ? "the operator is told what they are deciding" : "question absent",
	),
	// AC-06.4: remaining % per slot, and never a percentage for a local slot.
	check(
		"accounts-local-slot-has-no-percentage",
		"running/frame.txt",
		/\ba \(local\) \$0\b/u.test(running.text) && !/\ba \(local\) \$0\s*\d+%/u.test(running.text),
		(running.text.match(/LOCAL-OPENAI[^\n]*/u) ?? ["absent"])[0].trim(),
	),
	check(
		"board-draws-with-provider-unreachable",
		"provider-unreachable/frame.raw",
		down.raw.includes(bytesOf("STOP RUNNING")) && down.raw.includes(bytesOf(`LOOP ${JOB}`)),
		down.raw.includes(bytesOf("STOP RUNNING")) ? "board drew with no provider listening" : "board did not draw",
	),
	check(
		"no-widget-truncation",
		"paused/frame.txt",
		!paused.text.includes("widget truncated"),
		paused.text.includes("widget truncated") ? "the widget dropped board rows" : "the whole board reached the operator",
	),
	check(
		"loopback-only",
		"running/egress",
		running.egress.clean && paused.egress.clean && down.egress.clean,
		running.egress.clean && paused.egress.clean && down.egress.clean ? "no outbound attempt" : "egress recorded",
	),
];

/**
 * The control: the same colour assertions, swapped. If the running frame also
 * carried protocol-blue, or the paused frame also carried amber, the pair would
 * be measuring "some colour appeared" rather than the right one.
 */
const controlFailures = [];
if (!running.raw.includes(amber) || running.raw.includes(blue)) controlFailures.push("running-board-colour");
if (!paused.raw.includes(blue) || paused.raw.includes(amber)) controlFailures.push("paused-board-colour");
const swapped = [
	running.raw.includes(blue) ? "amber-while-running(swapped)" : undefined,
	paused.raw.includes(amber) ? "protocol-blue-while-paused(swapped)" : undefined,
].filter((entry) => entry !== undefined);

const verdict = writeRow("/tmp/kpi-pty/evidence/UAT-06", "UAT-06", {
	checks,
	control: {
		describe:
			"Grading the running frame against the paused expectation and vice versa: the running board is asserted to carry protocol-blue and the paused board amber. Both must fail, or the colour checks are not reading the theme the board actually chose.",
		failedChecks: [
			...(running.raw.includes(blue) ? [] : ["running-frame-does-not-carry-protocol-blue"]),
			...(paused.raw.includes(amber) ? [] : ["paused-frame-does-not-carry-amber"]),
			...swapped,
			...controlFailures,
		],
	},
	notes: `Driven against \`dist/bundle/cli.js\` over a real PTY at 120 columns, clean HOME, scratch git repo, loopback stub.

Three captures: a running job, the same job paused on a human node, and a running job with **no provider process listening at all** (\`provider-unreachable/\`), which is how "with the model provider unreachable" is made true rather than asserted.

Colour is graded on the bytes: amber is \`ESC[38;2;255;106;26m\` and protocol-blue is \`ESC[38;2;61;169;252m\`. Each frame is also asserted to *lack* the other board's colour.

Calibration note: the board's theme is chosen when the widget is installed. A board painted before the extension-provided themes are registered carries neither colour — see \`notes-findings.md\`.`,
});

console.log(JSON.stringify(verdict, null, 2));
