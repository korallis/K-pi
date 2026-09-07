import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVENT_TYPES } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";
import type { IntentProposal } from "../packages/coding-agent/src/kpi/extensions/intent.ts";
import type { Task, Verdict } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import type { DuneStack } from "../packages/coding-agent/src/kpi/extensions/stack.ts";

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

const verdict: Verdict = {
	status: "PASS",
	approved: true,
	blockingIssues: [],
	nonBlockingIssues: [],
	evidence: ["test/schema-conformance.test.ts"],
	round: 1,
	output_fingerprint: `sha256:${"a".repeat(64)}`,
};

test("task and verdict schemas match live payloads", async () => {
	const [taskSchema, verdictSchema] = await Promise.all([loadSchema("task"), loadSchema("verdict")]);

	assertValid(task, taskSchema);
	assertValid(verdict, verdictSchema);

	assertInvalid({ ...task, current_module_id: "" }, taskSchema);
	assertInvalid({ ...task, limits: { maxRounds: 0 } }, taskSchema);
	assertInvalid({ ...task, limits: { maxCostUsd: 5 } }, taskSchema);
	assertInvalid({ ...verdict, status: "GREEN" }, verdictSchema);
});

test("arena judge schema rejects duplicate and insufficient proposal references", async () => {
	const schema = await loadSchema("arena-judge");
	const judgment = {
		decision: "Retain the existing module and change its implementation",
		rationale: "Both independent proposals preserve the public interface; the smaller change avoids migration",
		proposalRefs: ["arena/keep-module.json", "arena/replace-module.json"],
		unresolvedRisks: ["The changed implementation still needs host verification"],
	};

	assertValid(judgment, schema);
	assertInvalid({ ...judgment, proposalRefs: [judgment.proposalRefs[0]] }, schema);
	assertInvalid({ ...judgment, proposalRefs: [judgment.proposalRefs[0], judgment.proposalRefs[0]] }, schema);
	assertInvalid({ ...judgment, proposalRefs: [judgment.proposalRefs[0], ""] }, schema);
	assertInvalid({ ...judgment, approved: true }, schema);
	// The engine separately verifies that these references are the configured proposals.
});

test("arena proposal schema requires tradeoffs and risks without granting verdict authority", async () => {
	const schema = await loadSchema("arena-proposal");
	const proposal = {
		proposal: "Retain the public interface and replace the failing implementation",
		rationale: "Callers do not need a migration",
		tradeoffs: ["The compatibility layer remains"],
		risks: ["Existing callers may depend on undocumented behavior"],
		evidenceRefs: ["diagnostic.json"],
	};

	assertValid(proposal, schema);
	assertValid({ ...proposal, evidenceRefs: [] }, schema);
	assertInvalid({ ...proposal, tradeoffs: [] }, schema);
	assertInvalid({ ...proposal, risks: [] }, schema);
	assertInvalid({ ...proposal, evidenceRefs: [""] }, schema);
	assertInvalid({ ...proposal, approved: true }, schema);
	// Evidence references are descriptive strings here, not verified host receipts.
});

test("intent proposal schema accepts desired-state detail but rejects task authority and malformed journeys", async () => {
	const schema = await loadSchema("intent-proposal");
	const proposal: IntentProposal = {
		users: ["Operator"],
		journeys: [
			{
				id: "J-01",
				actor: "Operator",
				entry: "Open Jobs",
				steps: ["Select the active job", "Read its recovery reason"],
				acceptance_ids: ["AC-01"],
			},
		],
		acceptance: [
			{
				id: "AC-01",
				statement: "The active job exposes its recovery reason",
				required: true,
				check: { kind: "command", cmd: "npm run verify:jobs", expect: { exit: 0 } },
				bounds: { write_allow: ["src/jobs/**"], write_deny: ["src/accounts/**"] },
			},
		],
		questions: [],
	};

	assertValid(proposal, schema);
	assertInvalid({ ...proposal, goal: "Replace the accepted goal" }, schema);
	assertInvalid({ ...proposal, mode: "autopilot" }, schema);
	assertInvalid({ ...proposal, journeys: [{ ...proposal.journeys[0], steps: [] }] }, schema);
	assertInvalid({ ...proposal, journeys: [{ ...proposal.journeys[0], acceptance_ids: [""] }] }, schema);
	assertInvalid(
		{ ...proposal, acceptance: [{ ...proposal.acceptance[0], check: { kind: "model_approval" } }] },
		schema,
	);
	// Accepted-criterion preservation, duplicate IDs and journey links belong to readIntentRefinement.
});

test("stack schema accepts explicit existing-layout ownership and rejects missing ownership shape", async () => {
	const schema = await loadSchema("stack");
	const module = {
		id: "account-recovery",
		purpose: "Recover an account without disturbing active jobs",
		folder: "app/services",
		interface: "app/services/accounts.py",
		allowed_paths: ["app/services/accounts.py", "tests/test_accounts.py"],
		depends_on: [],
	};
	const stack: DuneStack = {
		version: 1,
		shape: "dune",
		delivery: "vertical",
		root: ".",
		modules: [module],
		current_module_id: module.id,
	};

	assertValid(stack, schema);
	assertInvalid({ ...stack, modules: [] }, schema);
	assertInvalid({ ...stack, modules: [{ ...module, purpose: "" }] }, schema);
	assertInvalid({ ...stack, modules: [{ ...module, allowed_paths: [] }] }, schema);
	const { allowed_paths: _paths, ...unownedModule } = module;
	assertInvalid({ ...stack, modules: [unownedModule] }, schema);
	assertInvalid({ ...stack, modules: [{ ...module, allowed_paths: "app/**" }] }, schema);
	assertInvalid({ ...stack, shape: "unrestricted" }, schema);
	assertInvalid({ ...stack, modules: [{ ...module, approved: true }] }, schema);
	// Path containment, dependency identity and write authority are enforced by stack.ts, not this schema.
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
