/**
 * UAT-07 — US-07 Concise model output.
 *
 * Action: install the brevity rule the way an operator does, run the
 * structured-verdict scenario, and measure the visible assistant body.
 *
 * The measurement comes from the product: `get_last_assistant_text` is the
 * session's own answer to "what did you last say to the user", so the number is
 * read out of the running agent rather than computed here. `formatVerdictReply`
 * is never imported - it is the renderer under test, and calling it would
 * measure a function instead of a session.
 *
 * A deterministic provider stands in for the model, so what is proven is that
 * the rule is installed, reaches the wire, and the reply the product reports is
 * under budget - not that a live model is obedient. The stub only answers
 * concisely when the shipped brevity instruction is actually in the prompt it
 * received, so "on the wire" is matched, not assumed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { check, cliPath, egressClean, freePort, repoRoot, sandbox, startStub, teardown, writeRow } from "./lib.mjs";

const EVIDENCE = join(repoRoot, ".kpi", "uat", "UAT-07");
const BUDGET = 800;
const SKILL_PATH = join(repoRoot, "packages/coding-agent/src/kpi/skills/concise-output/SKILL.md");
const APPEND_TEMPLATE = join(repoRoot, "packages/coding-agent/src/kpi/templates/APPEND_SYSTEM.md");
const SYSTEM_TEMPLATE = join(repoRoot, "packages/coding-agent/src/kpi/templates/SYSTEM.md");

/** The phrase the shipped rule carries; the stub keys its concise scene off it. */
const BREVITY_PHRASE = "Keep user-visible answers short";

/**
 * One RPC session, one command at a time.
 *
 * Writing every line up front does not produce one turn per line: the session
 * queues the rest as steering on the running turn, and closing stdin can end
 * the process before the turn finishes. So each line waits for its own
 * response, and stdin stays open until the last one has answered.
 */
function runRpc(env, cwd, lines, { timeoutMs = 120_000 } = {}) {
	return new Promise((resolveRpc) => {
		const child = spawn(process.execPath, [cliPath, "--offline", "--mode", "rpc"], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let pending = 0;
		let awaitingSettle = false;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			resolveRpc({ stdout, stderr, status: child.exitCode });
		};
		const timer = setTimeout(finish, timeoutMs);

		const send = (index) => {
			if (index >= lines.length) {
				// The final response has landed; let the emitter flush and stop.
				setTimeout(finish, 600);
				return;
			}
			pending = index;
			child.stdin.write(`${JSON.stringify(lines[index])}\n`);
		};

		let buffer = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			buffer += String(chunk);
			const complete = buffer.split("\n");
			buffer = complete.pop() ?? "";
			for (const line of complete) {
				if (line.trim().length === 0) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				const current = lines[pending];
				if (message.type === "response" && message.id === current?.id) {
					// A `prompt` response means accepted, not answered. Advancing here
					// would ask for the last assistant text before the turn produced
					// any, which reads as an empty reply rather than a slow one.
					if (current.type === "prompt" && !String(current.message).startsWith("/")) {
						awaitingSettle = true;
						continue;
					}
					send(pending + 1);
					continue;
				}
				if (awaitingSettle && (message.type === "agent_settled" || message.type === "turn_end")) {
					awaitingSettle = false;
					send(pending + 1);
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", finish);
		send(0);
	});
}

function responses(stdout) {
	return stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

function lastAssistantText(stdout) {
	for (const message of responses(stdout).reverse()) {
		if (message.type === "response" && message.command === "get_last_assistant_text") {
			return message.data?.text ?? "";
		}
	}
	return undefined;
}

/**
 * The verdict scenario. The concise scene requires the shipped brevity phrase in
 * the prompt; without it the stub answers like a diary, which is the behaviour
 * the rule exists to prevent.
 */
function screenplay() {
	const diary = [
		"Let me walk through everything I did in this round, step by step, so you have the full picture.",
		"First I re-read the task contract and the acceptance criteria, then I re-read the plan, then I",
		"re-read the evidence file, and then I considered whether the reviewer's note about the missing",
		"boundary test was blocking or non-blocking. I decided it was non-blocking, but let me explain the",
		"reasoning at length because the distinction matters and I want to be transparent about my process.",
		"I then re-ran the gates, watched them pass, and reflected on what that means for the round.",
		"In summary, after all of that deliberation and re-reading and reflection, the verdict is REVISE,",
		"and I will now narrate the next steps in similar detail so nothing is left implicit anywhere.",
		"Next, I intend to re-read the acceptance criteria one more time, then draft the missing boundary",
		"test, then run the gates again, then re-read the evidence, and then summarise all of it for you",
		"at comparable length, because I would not want to omit any part of my reasoning or my process.",
	].join(" ");
	// The control has to be able to fail the budget check, otherwise "under 800"
	// would pass for a stub that is simply polite and prove nothing about the rule.
	if (diary.length <= 800) {
		throw new Error(`control diary must exceed the 800-character budget, got ${diary.length}`);
	}
	return {
		models: ["uat-stub"],
		scenes: [
			{
				node: "concise",
				match: { promptIncludes: [BREVITY_PHRASE] },
				turns: [
					{
						content: [
							"Verdict: REVISE (not approved)",
							"Round 2",
							"Blocking: AC-01 has no executable check",
							"Evidence: .kpi/runs/job/evidence.json",
							"Next: add the check, then re-run review",
						].join("\n"),
						usage: { prompt_tokens: 120, completion_tokens: 24 },
					},
				],
			},
			{
				node: "diary",
				match: {},
				turns: [{ content: diary, usage: { prompt_tokens: 120, completion_tokens: 240 } }],
			},
		],
	};
}

const VERDICT_QUESTION = "Summarise the review verdict for round 2.";

/**
 * `installFirst` runs `/append-system` exactly as an operator would, in its own
 * session, before the session that is measured. The rule is discovered while a
 * session's system prompt is assembled, so the session that installs it is not
 * the session that carries it - which is what an operator meets on a fresh
 * agent directory.
 */
async function scenario(label, { installFirst, plantAppend }) {
	const port = await freePort();
	const box = sandbox(label, { baseUrl: `http://127.0.0.1:${port}/v1`, port });
	if (typeof plantAppend === "string") {
		writeFileSync(join(box.agentDir, "APPEND_SYSTEM.md"), plantAppend);
	}
	writeFileSync(join(box.home, "screenplay.json"), JSON.stringify(screenplay()));
	const stub = await startStub(port, join(box.home, "model.jsonl"), join(box.home, "screenplay.json"));

	let install;
	if (installFirst) {
		install = await runRpc(
			box.env,
			box.project,
			[
				{ id: "off", type: "prompt", message: "/kpi off" },
				{ id: "install", type: "prompt", message: "/append-system" },
			],
			{ timeoutMs: 90_000 },
		);
	}

	const measured = await runRpc(
		box.env,
		box.project,
		[
			{ id: "off", type: "prompt", message: "/kpi off" },
			{ id: "ask", type: "prompt", message: VERDICT_QUESTION },
			{ id: "read", type: "get_last_assistant_text" },
		],
		{ timeoutMs: 150_000 },
	);

	const appendPath = join(box.agentDir, "APPEND_SYSTEM.md");
	const installedText = existsSync(appendPath) ? readFileSync(appendPath, "utf8") : "";
	const logPath = join(box.home, "model.jsonl");
	const requests = existsSync(logPath)
		? readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.flatMap((line) => {
					try {
						return [JSON.parse(line)];
					} catch {
						return [];
					}
				})
		: [];
	const egress = egressClean(box);
	teardown(box, stub);

	return {
		label,
		installNotice: install?.stdout ?? "",
		reply: lastAssistantText(measured.stdout),
		stdout: measured.stdout,
		installedText,
		requests,
		egress,
	};
}

const installed = await scenario("u07-installed", { installFirst: true });
const bare = await scenario("u07-bare", {
	installFirst: false,
	// First-run auto-install would write the real rule; plant an operator-owned
	// file without the brevity phrase so ensureAppendSystemInstalled leaves it.
	plantAppend: [
		"# Operator append",
		"",
		"Write long, thorough answers. Narrate every step. Never compress.",
		"",
	].join("\n"),
});

// Shipped artefacts, read from the tree that builds the binary.
const skillText = readFileSync(SKILL_PATH, "utf8");
const appendTemplate = readFileSync(APPEND_TEMPLATE, "utf8");
const systemTemplate = existsSync(SYSTEM_TEMPLATE) ? readFileSync(SYSTEM_TEMPLATE, "utf8") : "";

writeFileSync(
	join(EVIDENCE, "last-assistant.txt"),
	`${installed.reply ?? "(no reply captured)"}\n`,
);
writeFileSync(join(EVIDENCE, "control-last-assistant.txt"), `${bare.reply ?? "(no reply captured)"}\n`);
writeFileSync(
	join(EVIDENCE, "measurement.json"),
	`${JSON.stringify(
		{
			budget: BUDGET,
			installed_reply_chars: installed.reply?.length ?? null,
			control_reply_chars: bare.reply?.length ?? null,
			installed_scene: installed.requests.map((record) => record.matched_node),
			control_scene: bare.requests.map((record) => record.matched_node),
			measured_through: "get_last_assistant_text",
		},
		null,
		2,
	)}\n`,
);

const replyLength = installed.reply?.length ?? 0;
const conciseServed = installed.requests.some((record) => record.matched_node === "concise");
const controlServedDiary = bare.requests.some((record) => record.matched_node === "diary");
const skillDescription = (skillText.match(/^description:\s*(.+)$/mu) ?? [])[1]?.trim();

const checks = [
	check(
		"operator-install-reports-installed",
		"u07-installed install session",
		/Installed K-π APPEND_SYSTEM\.md|already matches the shipped/u.test(installed.installNotice),
		(installed.installNotice.match(/Installed K-π[^"\\]*|already matches the shipped[^"\\]*/u) ?? ["no install notice"])[0],
	),
	check(
		"brevity-rule-in-the-agent-directory",
		"evidence/UAT-07/measurement.json",
		installed.installedText.includes(BREVITY_PHRASE),
		installed.installedText.includes(BREVITY_PHRASE) ? `APPEND_SYSTEM.md carries "${BREVITY_PHRASE}"` : "rule absent",
	),
	check(
		"brevity-rule-reached-the-wire",
		"measurement.json",
		conciseServed,
		conciseServed
			? "the stub's concise scene matched, so the shipped phrase was in the prompt"
			: `scenes served: ${installed.requests.map((record) => record.matched_node).join(", ") || "none"}`,
	),
	check(
		"reply-captured-through-the-product",
		"last-assistant.txt",
		typeof installed.reply === "string" && installed.reply.length > 0,
		`get_last_assistant_text returned ${replyLength} character(s)`,
	),
	check(
		"visible-body-under-800",
		"last-assistant.txt",
		replyLength > 0 && replyLength < BUDGET,
		`${replyLength} < ${BUDGET}`,
	),
	check(
		"rule-lives-in-append-system-not-system",
		"packages/coding-agent/src/kpi/templates/",
		appendTemplate.includes(BREVITY_PHRASE) && !systemTemplate.includes(BREVITY_PHRASE),
		`APPEND_SYSTEM.md: ${appendTemplate.includes(BREVITY_PHRASE) ? "carries it" : "missing"}; SYSTEM.md: ${systemTemplate.length === 0 ? "no such template" : systemTemplate.includes(BREVITY_PHRASE) ? "ALSO carries it" : "does not"}`,
	),
	check(
		"skill-description-is-the-documented-sentence",
		"packages/coding-agent/src/kpi/skills/concise-output/SKILL.md",
		skillDescription === "Use whenever writing to the user.",
		`description: ${JSON.stringify(skillDescription ?? null)}`,
	),
	check(
		"skill-name-is-concise-output",
		"packages/coding-agent/src/kpi/skills/concise-output/SKILL.md",
		/^name:\s*concise-output$/mu.test(skillText),
		(skillText.match(/^name:.*$/mu) ?? ["absent"])[0],
	),
	check(
		"loopback-only",
		"egress",
		installed.egress.clean && bare.egress.clean,
		installed.egress.clean && bare.egress.clean ? "no outbound attempt" : "egress recorded",
	),
];

/**
 * Control: operator-owned APPEND_SYSTEM.md without the brevity phrase (auto-install leaves it). The
 * stub's diary scene answers, and it is over budget - so the under-800
 * assertion is measuring the rule's effect rather than the stub's good manners.
 */
const controlLength = bare.reply?.length ?? 0;
const controlFailures = [
	...(controlLength >= BUDGET ? ["visible-body-under-800"] : []),
	...(controlServedDiary ? ["brevity-rule-reached-the-wire"] : []),
];

const verdict = writeRow(EVIDENCE, "UAT-07", {
	checks,
	control: {
		describe: `The same verdict question with no operator install: the stub's diary scene answers and \`get_last_assistant_text\` returns ${controlLength} characters (budget ${BUDGET}). Both the wire check and the length check must fail there, or neither is measuring the brevity rule.`,
		failedChecks: controlFailures,
	},
	notes: `Two RPC sessions per scenario against \`dist/bundle/cli.js\` with \`--offline --mode rpc\`, clean HOME, scratch git repo, loopback stub, egress guard, and no \`PI_OFFLINE\` crutch.

**Installed the way an operator does.** \`/append-system\` is run as a real command in its own session; the notice it prints is the evidence it installed. The rule is discovered while a session's system prompt is assembled, so the session that installs it is not the session that carries it — the measured session is the next one, which is what an operator meets on a fresh agent directory.

**Measured through the product.** The number is whatever \`get_last_assistant_text\` returns: the session's own answer to what it last said to the user. \`formatVerdictReply\` is the renderer under test and is never imported.

**Scope.** A deterministic provider stands in for the model. The stub answers concisely *only* when the shipped phrase "${BREVITY_PHRASE}" is in the prompt it received, so the rule reaching the wire is matched rather than assumed; what is not proven is that a live model obeys it.`,
});

console.log(JSON.stringify(verdict.checks.map((entry) => `${entry.ok ? "ok" : "FAIL"} ${entry.id}: ${entry.observed.slice(0, 80)}`), null, 1));
console.log("measured:", replyLength, "control:", controlLength, "| control discriminates:", verdict.control?.discriminates);
