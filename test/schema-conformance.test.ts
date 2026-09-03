import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVENT_TYPES } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";
import type { Evidence, Task, Verdict } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

async function loadSchema(name: string): Promise<JsonSchema> {
	return JSON.parse(
		await readFile(new URL(`../packages/coding-agent/src/kpi/schemas/${name}.schema.json`, import.meta.url), "utf8"),
	) as JsonSchema;
}

function assertValid(value: unknown, schema: JsonSchema): void {
	assert.deepEqual(validateJsonSchema(value, schema), []);
}

function assertInvalid(value: unknown, schema: JsonSchema): void {
	assert.notEqual(validateJsonSchema(value, schema).length, 0);
}

const task: Task = {
	job_id: "2026-09-01-schema-contract",
	mode: "gated",
	goal: "Keep schemas aligned",
	nongoals: [],
	acceptance: [
		{
			id: "AC-01",
			statement: "Improve the result",
			required: true,
		},
	],
	constraints: [],
	quality_gates: ["pnpm test"],
	ac: { quality: "narrative" },
	playbook: "feature",
	playbook_steps: [
		{ node: "plan", text: "scope the change" },
		{ node: "implement", text: "write the code", skip: "demo skip" },
	],
	runtime_dependencies: [],
	dependency_baseline: ["typescript"],
	current_module_id: "schema-contract",
};

const evidence: Evidence = {
	head: "0123456789abcdef",
	commands: [{ cmd: "pnpm test", exit: 0, excerpt: "ok" }],
	ac_results: [{ id: "AC-01", passed: true }],
};

const verdict: Verdict = {
	status: "PASS",
	approved: true,
	blockingIssues: [],
	nonBlockingIssues: [],
	evidence: ["test/schema-conformance.test.ts"],
	round: 1,
	output_fingerprint: `sha256:${"a".repeat(64)}`,
};

test("task, evidence, and verdict schemas match live payloads", async () => {
	const [taskSchema, evidenceSchema, verdictSchema] = await Promise.all([
		loadSchema("task"),
		loadSchema("evidence"),
		loadSchema("verdict"),
	]);

	assertValid(task, taskSchema);
	assertValid(evidence, evidenceSchema);
	assertValid(verdict, verdictSchema);

	assertInvalid({ ...task, current_module_id: "" }, taskSchema);
	assertInvalid({ ...task, limits: { maxRounds: 0 } }, taskSchema);
	assertInvalid({ ...task, limits: { maxCostUsd: 5 } }, taskSchema);
	const { head: _head, ...evidenceWithoutHead } = evidence;
	assertInvalid(evidenceWithoutHead, evidenceSchema);
	assertInvalid({ ...verdict, status: "GREEN" }, verdictSchema);
});

function eventPayload(type: (typeof EVENT_TYPES)[number]): Record<string, unknown> {
	const base: Record<string, unknown> = {
		ts: "2026-09-01T12:00:00.000Z",
		type,
		job_id: "2026-09-01-schema-contract",
		round: 1,
		node: "test",
		prev_hash: "0".repeat(64),
		record_hash: "1".repeat(64),
	};

	switch (type) {
		case "handoff.created":
			return { ...base, mode: "gated" };
		case "approval.result":
			return { ...base, approved: false, question: "Commit?", feedback: "split the module" };
		case "checkpoint":
			return { ...base, detail: "fresh receipt" };
		case "accounts.failover":
			return { ...base, from: "anthropic/a", to: "anthropic/b" };
		case "ac.refused":
			return { ...base, quality: "narrative", reason: "missing check" };
		case "loop.terminal":
			return { ...base, status: "DONE", reason: "verified" };
		case "review.verdict":
			return {
				...base,
				status: "REVISE",
				approved: false,
				blocking_count: 2,
				nonblocking_count: 1,
				fingerprint: `sha256:${"a".repeat(64)}`,
			};
		case "research.started":
			return { ...base, mode: "auto", network_state: "online" };
		case "research.query":
			return { ...base, service: "exa", query: "official API" };
		case "research.call":
			return { ...base, service: "exa", attempt: 1 };
		case "research.result":
			return {
				...base,
				service: "exa",
				result_count: 2,
				source_refs: ["https://example.test/a", "https://example.test/b"],
			};
		case "research.fallback":
			return {
				...base,
				from: "exa",
				to: "local",
				reason: "bounded failures",
				mode: "local",
				network_state: "no-network",
			};
		case "research.completed":
			return { ...base, mode: "local", network_state: "no-network", result_count: 2 };
		case "agent.spawned":
			return {
				...base,
				agent_id: "reviewer-1",
				role: "reviewer",
				pid: 123,
				session_path: ".kpi/runs/job/agents/reviewer-1.jsonl",
				status: "running",
			};
		case "tool.request":
			return { ...base, tool: "write", decision: "deny", path: "src/health.ts", reason: "outside write_allow" };
		case "agent.denied":
			return { ...base, reason: "worker-limit", role: "implementer", limit: 2 };
		case "agent.message":
			return {
				...base,
				agent_id: "reviewer-1",
				message_id: "message-1",
				deliver_as: "followUp",
				expect: "result",
				status: "accepted",
			};
		case "node.started":
			return { ...base, run: 1, model: "openai-codex/gpt-test" };
		case "node.finished":
			return { ...base, run: 1, status: "completed", elapsed_ms: 1200, cost_usd: 0.01 };
		case "node.retry":
			return { ...base, attempt: 1, reason: "http", delay_ms: 1000, status: 503, message: "upstream overloaded" };
		default:
			return base;
	}
}

test("event schema has one valid normalized branch per event type", async () => {
	const schema = await loadSchema("event");
	const events = EVENT_TYPES.map(eventPayload);

	assert.deepEqual(
		events.map((event) => event.type),
		[...EVENT_TYPES],
	);
	for (const event of events) assertValid(event, schema);
});

test("event schema rejects cross-type and research vocabulary drift", async () => {
	const schema = await loadSchema("event");

	assertInvalid({ ...eventPayload("checkpoint"), approved: true }, schema);
	assertInvalid({ ...eventPayload("node.finished"), approved: true }, schema);
	assertInvalid({ ...eventPayload("research.started"), network_state: "degraded" }, schema);
	assertInvalid({ ...eventPayload("research.started"), mode: "native" }, schema);
	assertInvalid({ ...eventPayload("agent.message"), headers: { authorization: "secret" } }, schema);
});

test("event schema accepts node.retry and the three-word loop.terminal vocabulary", async () => {
	const schema = await loadSchema("event");
	const terminal = eventPayload("loop.terminal");

	const { status: _status, message: _message, ...retryRequiredOnly } = eventPayload("node.retry");
	assertValid(retryRequiredOnly, schema);
	assertValid({ ...terminal, status: "STOPPED", reason: "operator stop" }, schema);
	assertValid({ ...terminal, status: "NEEDS_HUMAN", reason: "resume with /kpi job", recovery: "no_progress" }, schema);
	for (const recovery of [
		"approval",
		"provider",
		"delivery",
		"ship",
		"bounds",
		"review",
		"no_progress",
		"research",
		"stack",
		"contract",
		"ac_quality",
	]) {
		assertValid({ ...terminal, status: "NEEDS_HUMAN", recovery }, schema);
	}

	for (const legacy of ["EXHAUSTED", "NO_PROGRESS", "UNSAFE", "BLOCKED"]) {
		assertInvalid({ ...terminal, status: legacy }, schema);
	}
	assertInvalid({ ...terminal, status: "NEEDS_HUMAN", recovery: "budget" }, schema);
	assertInvalid({ ...eventPayload("node.retry"), attempt: 0 }, schema);
	assertInvalid({ ...eventPayload("node.retry"), reason: "budget" }, schema);
	assertInvalid({ ...eventPayload("node.retry"), delay_ms: -1 }, schema);
	const { delay_ms: _delay, ...retryWithoutDelay } = eventPayload("node.retry");
	assertInvalid(retryWithoutDelay, schema);
	assertInvalid({ ...eventPayload("node.retry"), approved: true }, schema);
});
