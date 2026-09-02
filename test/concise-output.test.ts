import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EventRecord } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import {
	appendSystemInstalled,
	ensureAppendSystemInstalled,
	installAppendSystemCommand,
	shippedAppendSystemPath,
} from "../packages/coding-agent/src/kpi/extensions/append-system.ts";
import { formatEventEntry, formatVerdictReply } from "../packages/coding-agent/src/kpi/extensions/renderers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function event(partial: Partial<EventRecord> & { type: EventRecord["type"] }): EventRecord {
	return {
		ts: "2026-01-01T00:00:00.000Z",
		job_id: "job-1",
		round: 1,
		node: "review",
		prev_hash: "0".repeat(64),
		record_hash: "a".repeat(64),
		...partial,
	};
}

test("research accounts bus checkpoint and terminal renderers are field-aware", () => {
	assert.match(
		formatEventEntry(
			"research.completed",
			event({
				type: "research.completed",
				mode: "exa",
				service: "exa",
				network_state: "online",
				result_count: 4,
			}),
		),
		/research\.completed.*mode=exa.*svc=exa.*net=online.*n=4/,
	);
	assert.match(
		formatEventEntry(
			"accounts.failover",
			event({ type: "accounts.failover", from: "anthropic/a", to: "openai/b", reason: "429" }),
		),
		/accounts\.failover.*anthropic\/a → openai\/b.*429/,
	);
	assert.match(
		formatEventEntry("agent.spawned", event({ type: "agent.spawned", agent_id: "w1", role: "reviewer", pid: 42 })),
		/agent\.spawned.*reviewer w1 pid=42/,
	);
	assert.match(
		formatEventEntry("checkpoint", event({ type: "checkpoint", detail: "after implement" })),
		/checkpoint.*after implement/,
	);
	assert.match(
		formatEventEntry("loop.terminal", event({ type: "loop.terminal", status: "DONE", reason: "all AC green" })),
		/loop\.terminal.*DONE — all AC green/,
	);
	assert.doesNotMatch(formatEventEntry("checkpoint", event({ type: "checkpoint" })), /\|/);
	assert.match(
		formatEventEntry(
			"review.verdict",
			event({
				type: "review.verdict",
				status: "REVISE",
				approved: false,
				blocking_count: 2,
				nonblocking_count: 1,
			}),
		),
		/review\.verdict.*REVISE.*not-approved.*blocking=2.*nonblocking=1/,
	);
	assert.doesNotMatch(
		formatEventEntry(
			"review.verdict",
			event({
				type: "review.verdict",
				status: "PASS",
				approved: true,
				blocking_count: 0,
			}),
		),
		/blockingIssues|transcript|\[/,
	);
});

test("structured verdict protocol reply stays under 800 visible characters", () => {
	const reply = formatVerdictReply({
		status: "REVISE",
		approved: false,
		round: 2,
		blockingIssues: [
			"AC-01 still fails quality-gates",
			"candidate.json missing bounds claim",
			"reviewer found an unsafe write outside the slice",
		],
		nonBlockingIssues: ["typo in comment", "changelog lag"],
		evidence: ["evidence.json", "events.jsonl", "test/output.log", "coverage/summary.json"],
	});
	assert.ok(reply.length < 800, `reply length ${reply.length} must be < 800`);
	assert.match(reply, /^Verdict: REVISE/);
	assert.match(reply, /Blocking:/);
	assert.match(reply, /Next:/);
	assert.doesNotMatch(reply, /STAGES|CONTEXT LAYER|THREE LAWS/);
});

test("PASS verdict reply is short and actionable", () => {
	const reply = formatVerdictReply({
		status: "PASS",
		approved: true,
		round: 1,
		blockingIssues: [],
		evidence: ["evidence.json"],
	});
	assert.ok(reply.length < 800);
	assert.match(reply, /approved/);
	assert.match(reply, /ship when the human gate allows/i);
});

test("concise-output skill and APPEND_SYSTEM require short user-visible answers", async () => {
	const skill = await readFile(join(root, "packages/coding-agent/src/kpi/skills/concise-output/SKILL.md"), "utf8");
	const append = await readFile(join(root, "packages/coding-agent/src/kpi/templates/APPEND_SYSTEM.md"), "utf8");
	assert.match(skill, /Lead with the verdict/i);
	assert.match(skill, /Do not narrate routine work/i);
	assert.match(append, /Keep user-visible answers short/i);
	assert.match(append, /Do not narrate routine work or reproduce the control board/i);
});

/**
 * A command context whose only capability is answering the replace dialog: the
 * install path must not need a session, a model, or a job.
 */
function commandContext(agentDirectory: string, approve: boolean): Parameters<typeof installAppendSystemCommand>[0] {
	return {
		cwd: agentDirectory,
		hasUI: true,
		mode: "json",
		ui: {
			confirm: async () => approve,
			notify: () => undefined,
		},
	} as unknown as Parameters<typeof installAppendSystemCommand>[0];
}

// ---------------------------------------------------------------------------
// B11: the brevity prompt is installed by the product, not by hand
// ---------------------------------------------------------------------------

test("a fresh agent directory gets the shipped APPEND_SYSTEM on first run", async () => {
	const home = await mkdtemp(join(tmpdir(), "kpi-append-system-"));
	try {
		const agentDirectory = join(home, ".kpi", "agent");
		const first = await ensureAppendSystemInstalled(agentDirectory);
		assert.equal(first.outcome, "installed");
		assert.equal(first.path, join(agentDirectory, "APPEND_SYSTEM.md"));

		// The file the resource loader looks for, with the rule actually in it.
		const installed = await readFile(first.path, "utf8");
		const shipped = await readFile(shippedAppendSystemPath(), "utf8");
		assert.equal(installed, shipped, "the shipped prompt is what landed");
		assert.match(installed, /Keep user-visible answers short/u);
		assert.equal(await appendSystemInstalled(agentDirectory), true);

		// Second run: already current, and nothing is rewritten.
		const before = (await stat(first.path)).mtimeMs;
		const second = await ensureAppendSystemInstalled(agentDirectory);
		assert.equal(second.outcome, "current");
		assert.equal((await stat(first.path)).mtimeMs, before, "an unchanged file is not rewritten");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an operator's own APPEND_SYSTEM is never silently overwritten", async () => {
	const home = await mkdtemp(join(tmpdir(), "kpi-append-system-owned-"));
	try {
		const agentDirectory = join(home, ".kpi", "agent");
		await mkdir(agentDirectory, { recursive: true });
		const target = join(agentDirectory, "APPEND_SYSTEM.md");
		const mine = "# mine\n\nAlways answer in limerick form.\n";
		await writeFile(target, mine);

		// First run leaves it alone and says whose it is.
		const status = await ensureAppendSystemInstalled(agentDirectory);
		assert.equal(status.outcome, "operator-owned");
		assert.equal(await readFile(target, "utf8"), mine, "the operator's file survived first run");

		// The explicit command asks before replacing, and a decline keeps the file.
		const declined = await installAppendSystemCommand(commandContext(agentDirectory, false), agentDirectory);
		assert.equal(declined.outcome, "kept");
		assert.equal(await readFile(target, "utf8"), mine, "declining kept the operator's file");

		// Approving is what replaces it.
		const approved = await installAppendSystemCommand(commandContext(agentDirectory, true), agentDirectory);
		assert.equal(approved.outcome, "replaced");
		assert.equal(await readFile(target, "utf8"), await readFile(shippedAppendSystemPath(), "utf8"));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
