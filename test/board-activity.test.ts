import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EventRecord } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import {
	createActivityReader,
	foldActivity,
	narrateRecord,
	stageActivities,
} from "../packages/coding-agent/src/kpi/extensions/board-activity.ts";

function record(partial: Partial<EventRecord> & { type: EventRecord["type"]; node: string; ts: string }): EventRecord {
	return {
		job_id: "job-1",
		round: 0,
		prev_hash: "0".repeat(64),
		record_hash: "a".repeat(64),
		...partial,
	};
}

function iso(baseMs: number, offsetMs: number): string {
	return new Date(baseMs + offsetMs).toISOString();
}

test("activity folds node lifecycle and tool requests into per-node elapsed, cost and last tool", () => {
	const t0 = Date.parse("2026-01-01T00:00:00.000Z");
	const records: EventRecord[] = [
		record({ type: "node.started", node: "plan", ts: iso(t0, 0), run: 1, model: "X" }),
		record({ type: "tool.request", node: "plan", ts: iso(t0, 500), tool: "read", path: "a", decision: "allow" }),
		record({ type: "tool.request", node: "plan", ts: iso(t0, 1000), tool: "grep", decision: "allow" }),
		record({
			type: "tool.request",
			node: "plan",
			ts: iso(t0, 1500),
			tool: "edit",
			path: "src/x.ts",
			decision: "allow",
		}),
		record({
			type: "node.finished",
			node: "plan",
			ts: iso(t0, 3000),
			run: 1,
			status: "completed",
			elapsed_ms: 3000,
			cost_usd: 0.42,
			result: "stack.json",
		}),
	];

	const byNode = foldActivity(records, t0 + 9000);
	const plan = byNode.get("plan");
	assert.equal(plan?.status, "completed");
	assert.equal(plan?.runs, 1);
	assert.equal(plan?.elapsedMs, 3000);
	assert.equal(plan?.costUsd, 0.42);
	assert.equal(plan?.toolCalls, 3);
	assert.deepEqual(plan?.toolsByName, { read: 1, grep: 1, edit: 1 });
	assert.equal(plan?.lastTool, "edit x.ts");
	assert.equal(plan?.result, "stack.json");
	assert.equal(plan?.model, "X");

	// A node with node.started only is still running; elapsed is against `now`.
	const runningOnly = foldActivity(
		[record({ type: "node.started", node: "implement", ts: iso(t0, 0), run: 1 })],
		t0 + 5000,
	);
	const implement = runningOnly.get("implement");
	assert.equal(implement?.status, "running");
	assert.equal(implement?.elapsedMs, 5000);

	// A resumed node re-emits node.started with the same run: tool counting
	// restarts, but a later node.finished sums cost across both finished records.
	const resumeRecords: EventRecord[] = [
		record({ type: "node.started", node: "test", ts: iso(t0, 0), run: 1 }),
		record({ type: "tool.request", node: "test", ts: iso(t0, 100), tool: "bash", decision: "allow" }),
		record({ type: "tool.request", node: "test", ts: iso(t0, 200), tool: "bash", decision: "allow" }),
		record({
			type: "node.finished",
			node: "test",
			ts: iso(t0, 1000),
			run: 1,
			status: "failed",
			elapsed_ms: 1000,
			cost_usd: 0.1,
			error: "transient",
		}),
		record({ type: "node.started", node: "test", ts: iso(t0, 2000), run: 1 }),
		record({ type: "tool.request", node: "test", ts: iso(t0, 2100), tool: "bash", decision: "allow" }),
		record({
			type: "node.finished",
			node: "test",
			ts: iso(t0, 3000),
			run: 1,
			status: "completed",
			elapsed_ms: 1000,
			cost_usd: 0.05,
			result: "report.json",
		}),
	];
	const resumed = foldActivity(resumeRecords, t0 + 9000).get("test");
	assert.equal(resumed?.status, "completed");
	assert.equal(resumed?.toolCalls, 1, "tool count restarted at the resumption");
	assert.equal(resumed?.costUsd, 0.1 + 0.05);

	// stageActivities places plan-check under 'plan' and drops unrecognised nodes.
	const stages = stageActivities(
		foldActivity(
			[
				record({ type: "node.started", node: "plan-check", ts: iso(t0, 0), run: 1 }),
				record({ type: "tool.request", node: "plan-check", ts: iso(t0, 10), tool: "read", decision: "allow" }),
				record({ type: "node.started", node: "not-a-real-node", ts: iso(t0, 0), run: 1 }),
			],
			t0 + 1000,
		),
		t0 + 1000,
	);
	assert.ok(stages.plan !== undefined, "plan-check folds into the plan stage");
	assert.equal(stages.plan?.toolCalls, 1);
	assert.equal(Object.keys(stages).includes("not-a-real-node"), false);
});

test("the activity reader reads only appended bytes, coalesces overlapping reads and survives a truncated log", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-board-activity-"));
	try {
		const path = join(directory, "events.jsonl");
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const line = (node: string, offsetMs: number) =>
			`${JSON.stringify(record({ type: "node.started", node, ts: iso(t0, offsetMs), run: 1 }))}\n`;

		await writeFile(path, line("a", 0) + line("b", 100));
		const reader = createActivityReader();
		const first = await reader.read(path, t0);
		assert.equal(first.records.length, 2);

		await appendFile(path, line("c", 200) + line("d", 300));
		const second = await reader.read(path, t0);
		assert.equal(second.records.length, 4, "records grew by exactly the two appended lines");

		// Corrupting the earlier bytes in place (same length) proves the reader
		// never re-parses them: a from-scratch reread would surface this as a
		// fresh unparsable line, an incremental one would not touch it at all.
		const corrupted = `${"x".repeat(line("a", 0).length - 1)}\n`;
		const wholeFile = await readFile(path, "utf8");
		await writeFile(path, corrupted + wholeFile.slice(corrupted.length));
		const third = await reader.read(path, t0);
		assert.equal(third.records.length, 4, "already-consumed bytes are never revisited");
		assert.equal(third.unreadableLines, 0);

		// Two concurrent reads coalesce onto the same in-flight promise.
		await appendFile(path, line("e", 400));
		const [concurrentA, concurrentB] = await Promise.all([reader.read(path, t0), reader.read(path, t0)]);
		assert.equal(concurrentA, concurrentB, "both callers see the same snapshot object");
		assert.equal(concurrentA.records.length, 5);

		// An unparsable middle line increments unreadableLines without throwing.
		await appendFile(path, "not json\n");
		await appendFile(path, line("f", 500));
		const withGarbage = await reader.read(path, t0);
		assert.equal(withGarbage.unreadableLines, 1);
		assert.equal(withGarbage.records.length, 6);

		// A trailing partial line (no newline yet) is not counted until it arrives.
		await appendFile(path, `{"type":"node.started"`);
		const withPartial = await reader.read(path, t0);
		assert.equal(withPartial.records.length, 6, "the unterminated tail is not a record yet");
		await appendFile(path, `,"node":"g","job_id":"job-1","round":0,"ts":"${iso(t0, 600)}","run":1}\n`);
		const withCompletedPartial = await reader.read(path, t0);
		assert.equal(withCompletedPartial.records.length, 7);

		// Truncating to zero and appending fresh lines yields only the fresh records.
		await writeFile(path, "");
		await appendFile(path, line("h", 700));
		const afterTruncate = await reader.read(path, t0);
		assert.equal(afterTruncate.records.length, 1);
		assert.equal(afterTruncate.records[0]?.node, "h");

		// ENOENT yields an empty snapshot with no readError.
		const missingReader = createActivityReader();
		const missing = await missingReader.read(join(directory, "does-not-exist.jsonl"), t0);
		assert.deepEqual(missing.records, []);
		assert.equal(missing.readError, undefined);

		// Replacing the file with a directory yields readError EISDIR and keeps
		// the previous records rather than throwing.
		await rm(path);
		await mkdir(path);
		const afterSwap = await reader.read(path, t0);
		assert.equal(afterSwap.readError, "EISDIR");
		assert.equal(afterSwap.records.length, 1, "the last good snapshot's records are kept");

		assert.equal(reader.last(), afterSwap, "last() returns the latest snapshot");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("narration is one line per node start and finish and none per tool call", () => {
	const t0 = Date.parse("2026-01-01T00:00:00.000Z");
	const started = narrateRecord(record({ type: "node.started", node: "plan", ts: iso(t0, 0), run: 1, model: "m" }));
	assert.deepEqual(started, { text: "K-π ▶ 03 plan · run 1 · m", level: "info" });

	const finished = narrateRecord(
		record({
			type: "node.finished",
			node: "plan",
			ts: iso(t0, 0),
			run: 1,
			status: "completed",
			elapsed_ms: 192_000,
			cost_usd: 0.42,
			result: "stack.json",
		}),
	);
	assert.deepEqual(finished, { text: "K-π ■ 03 plan done · 3m12s · $0.42 · stack.json", level: "info" });

	const longError = "x".repeat(200);
	const failed = narrateRecord(
		record({
			type: "node.finished",
			node: "plan",
			ts: iso(t0, 0),
			run: 1,
			status: "failed",
			elapsed_ms: 1000,
			error: longError,
		}),
	);
	assert.equal(failed?.level, "warning");
	assert.ok((failed?.text.length ?? 0) <= 120);
	assert.ok(failed?.text.includes("x".repeat(80)));
	assert.ok(!failed?.text.includes("x".repeat(81)));

	const failover = narrateRecord(
		record({ type: "accounts.failover", node: "graph", ts: iso(t0, 0), from: "a", to: "b" }),
	);
	assert.deepEqual(failover, { text: "K-π ⇄ route a → b", level: "warning" });

	assert.equal(narrateRecord(record({ type: "tool.request", node: "plan", ts: iso(t0, 0), tool: "read" })), undefined);
	assert.equal(narrateRecord(record({ type: "research.started", node: "plan", ts: iso(t0, 0) })), undefined);
	assert.equal(
		narrateRecord(record({ type: "review.verdict", node: "review", ts: iso(t0, 0), status: "PASS" })),
		undefined,
	);
	assert.equal(narrateRecord(record({ type: "checkpoint", node: "plan", ts: iso(t0, 0) })), undefined);
});
