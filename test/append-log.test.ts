import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendEvent,
	buildReviewVerdictEventFields,
	type EventInput,
	FIRST_HASH,
	ForbiddenEventPayloadError,
	inspectChain,
	verifyChain,
} from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";

const eventSchema = JSON.parse(
	await readFile(new URL("../packages/coding-agent/src/kpi/schemas/event.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

async function withEventLog(run: (path: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-events-"));
	try {
		await run(join(directory, "events.jsonl"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function event(round: number): Extract<EventInput, { type: "checkpoint" }> {
	return {
		ts: `2026-08-31T14:12:0${round}.000Z`,
		type: "checkpoint",
		job_id: "2026-08-31-hash-chain",
		round,
		node: "implementer",
		detail: `round ${round}`,
	};
}

test("three appended events form a verifiable hash chain", async () => {
	await withEventLog(async (path) => {
		await appendEvent(path, event(1));
		await appendEvent(path, event(2));
		await appendEvent(path, event(3));

		assert.equal(await verifyChain(path), true);

		const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
		const second = JSON.parse(lines[1]) as Record<string, unknown>;
		second.detail = "tampered";
		lines[1] = JSON.stringify(second);
		await writeFile(path, `${lines.join("\n")}\n`);

		assert.equal(await verifyChain(path), false);
	});
});

test("research and bus events persist as schema-valid chained records", async () => {
	await withEventLog(async (path) => {
		await appendEvent(path, {
			ts: "2026-09-01T12:00:00.000Z",
			type: "research.completed",
			job_id: "2026-08-31-hash-chain",
			round: 1,
			node: "researcher",
			mode: "local",
			network_state: "no-network",
			result_count: 2,
			source_refs: ["docs/spec.md", "docs/research.md"],
		});
		await appendEvent(path, {
			ts: "2026-09-01T12:00:01.000Z",
			type: "agent.message",
			job_id: "2026-08-31-hash-chain",
			round: 1,
			node: "bus",
			agent_id: "reviewer-1",
			message_id: "message-1",
			deliver_as: "followUp",
			expect: "result",
			status: "accepted",
		});

		const records = (await readFile(path, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as unknown);
		assert.equal(records.length, 2);
		for (const record of records) {
			assert.deepEqual(validateJsonSchema(record, eventSchema), []);
		}
		assert.equal(await verifyChain(path), true);
	});
});

test("secrets are redacted inside allowed semantic fields", async () => {
	await withEventLog(async (path) => {
		const canaries = [
			"Bearer bearer-secret-tail",
			"sk-ant-secret-tail",
			"oat01-secret-tail",
			"pplx-secret-tail",
			"xai-secret-tail",
			"exa-secret-tail",
			"ghp_SecretTail",
			"gho_SecretTail",
			"ghu_SecretTail",
			"ghs_SecretTail",
			"ghr_SecretTail",
			"github_pat_Secret_Tail",
			"xoxb-secret-tail",
			"AKIA1234567890SECRETT",
			"cookie: cookie-secret-tail",
			"password=password-secret-tail",
		];
		const record = await appendEvent(path, {
			ts: "2026-08-31T14:12:01.000Z",
			type: "research.result",
			job_id: "2026-08-31-hash-chain",
			round: 1,
			node: "researcher",
			reason: canaries.slice(0, 3).join(" "),
			source_refs: [...canaries.slice(3), "visible.md"],
		});

		const stored = await readFile(path, "utf8");
		for (const canary of canaries) {
			assert.doesNotMatch(stored, new RegExp(canary.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
			assert.doesNotMatch(
				JSON.stringify(record),
				new RegExp(canary.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
			);
		}
		assert.doesNotMatch(stored, /secret-tail/iu);
		assert.match(stored, /\[REDACTED\]/u);
		assert.match(stored, /visible\.md/u);
		assert.equal(await verifyChain(path), true);
	});
});

test("redaction reaches nested detail objects, keys and array items", async () => {
	await withEventLog(async (path) => {
		const record = await appendEvent(path, {
			...event(2),
			detail: {
				api_key: "hidden-key",
				"sk-ant-secret-field": "hidden-field",
				notes: ["oat01-hidden-token", "visible"],
			},
		} as unknown as EventInput);

		const stored = await readFile(path, "utf8");
		for (const leak of [/hidden-key/u, /hidden-field/u, /oat01-/u, /sk-ant-/u]) {
			assert.doesNotMatch(stored, leak);
			assert.doesNotMatch(JSON.stringify(record), leak);
		}
		assert.match(stored, /visible/u);
		assert.equal(await verifyChain(path), true);
	});
});

test("raw headers and vendor envelopes are rejected before any bytes land", async () => {
	await withEventLog(async (path) => {
		await appendEvent(path, event(1));
		const before = await readFile(path, "utf8");

		for (const payload of [
			{ ...event(2), authorization: "Bearer sk-ant-api03-example-secret" },
			{ ...event(2), headers: { "content-type": "application/json" } },
			{ ...event(2), detail: { nested: { cookie: "session=raw-cookie" } } },
			{ ...event(2), vendor: { name: "anthropic" } },
		]) {
			await assert.rejects(
				appendEvent(path, payload as unknown as EventInput),
				(error: unknown) =>
					error instanceof ForbiddenEventPayloadError && /Forbidden event payload key/u.test(error.message),
			);
		}

		assert.equal(await readFile(path, "utf8"), before);
		assert.equal(await verifyChain(path), true);
	});
});

test("concurrent appends to one log keep a single verifiable chain", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-append-race-"));
	const path = join(directory, "events.jsonl");
	try {
		// Twenty writers race on the same log. Reading the tail hash and appending
		// the record that chains to it is check-then-act, so without serialization
		// several records would claim the same predecessor.
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				appendEvent(path, {
					ts: new Date(1_700_000_000_000 + index).toISOString(),
					type: "tool.request",
					job_id: "race-job",
					round: 0,
					node: `writer-${index}`,
					tool: "write",
					decision: "allow",
				}),
			),
		);

		const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
		assert.equal(lines.length, 20, "every append landed exactly once");
		const records = lines.map((line) => JSON.parse(line) as { prev_hash: string; record_hash: string; node: string });
		assert.equal(new Set(records.map((record) => record.record_hash)).size, 20, "no two records share a hash");
		assert.equal(new Set(records.map((record) => record.prev_hash)).size, 20, "no two records claim one predecessor");
		assert.equal(new Set(records.map((record) => record.node)).size, 20, "no writer was lost");
		for (const [index, record] of records.entries()) {
			assert.equal(
				record.prev_hash,
				index === 0 ? FIRST_HASH : records[index - 1].record_hash,
				`record ${index} chains to the record written before it`,
			);
		}
		assert.equal(await verifyChain(path), true, "the whole chain verifies");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a rejected payload never blocks a concurrent writer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-append-reject-"));
	const path = join(directory, "events.jsonl");
	try {
		const results = await Promise.allSettled([
			appendEvent(path, {
				ts: new Date(1_700_000_000_000).toISOString(),
				type: "tool.request",
				job_id: "reject-job",
				round: 0,
				node: "first",
				tool: "write",
				decision: "allow",
			}),
			// A forbidden payload: it must fail without leaving the lock held.
			appendEvent(path, {
				ts: new Date(1_700_000_000_001).toISOString(),
				type: "tool.request",
				job_id: "reject-job",
				round: 0,
				node: "second",
				tool: "write",
				decision: "allow",
				authorization: "Bearer sk-ant-api03-example-secret",
			} as unknown as EventInput),
			appendEvent(path, {
				ts: new Date(1_700_000_000_002).toISOString(),
				type: "tool.request",
				job_id: "reject-job",
				round: 0,
				node: "third",
				tool: "write",
				decision: "allow",
			}),
		]);

		assert.deepEqual(
			results.map((result) => result.status),
			["fulfilled", "rejected", "fulfilled"],
		);
		assert.equal(await verifyChain(path), true, "the chain is intact after a rejected append");
		const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
		assert.equal(lines.length, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("review.verdict appends concise accepted-review fields without issue text", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-review-verdict-"));
	const path = join(directory, "events.jsonl");
	try {
		const record = await appendEvent(path, {
			ts: "2026-01-01T00:00:00.000Z",
			type: "review.verdict",
			job_id: "job-1",
			round: 2,
			node: "review",
			status: "REVISE",
			approved: false,
			blocking_count: 3,
			nonblocking_count: 1,
			fingerprint: `sha256:${"b".repeat(64)}`,
		});
		assert.equal(record.type, "review.verdict");
		assert.equal(record.blocking_count, 3);
		assert.equal(record.approved, false);
		assert.equal("blockingIssues" in record, false);
		const raw = await readFile(path, "utf8");
		assert.doesNotMatch(raw, /blockingIssues|AC still fails/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("buildReviewVerdictEventFields keeps counts only", () => {
	const fields = buildReviewVerdictEventFields({
		status: "REVISE",
		approved: false,
		blockingIssues: ["a", "b", "c"],
		nonBlockingIssues: ["n"],
		evidence: ["evidence.json"],
		round: 2,
		output_fingerprint: `sha256:${"c".repeat(64)}`,
	});
	assert.deepEqual(fields, {
		status: "REVISE",
		approved: false,
		blocking_count: 3,
		nonblocking_count: 1,
		fingerprint: `sha256:${"c".repeat(64)}`,
	});
	assert.equal(buildReviewVerdictEventFields({ status: "PASS" }), undefined);
});

// ---------------------------------------------------------------------------
// B1: the canonical form is RFC 8785, and a user can verify a chain
// ---------------------------------------------------------------------------

test("the canonical form matches RFC 8785 for keys, numbers, and escapes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-append-jcs-"));
	const path = join(directory, "events.jsonl");
	try {
		// Written out of order, with a non-ASCII key and a number, so the line on
		// disk shows exactly which serialization was hashed.
		await appendEvent(path, {
			ts: "2026-09-02T00:00:00.000Z",
			type: "tool.request",
			job_id: "jcs-job",
			round: 10,
			node: "café",
			tool: "write",
			decision: "allow",
			path: "src/ünicode/日本.ts",
		} as unknown as EventInput);
		const line = (await readFile(path, "utf8")).split("\n")[0];

		// §3.2.3 object keys sort by UTF-16 code unit, which is JavaScript's own
		// string order: every ASCII key precedes none here, so the order is total.
		const keys = [...line.matchAll(/"([^"]+)":/gu)].map((match) => match[1]);
		assert.deepEqual(
			keys.filter((key) => !key.startsWith("src")),
			[...keys.filter((key) => !key.startsWith("src"))].sort(),
			"keys are emitted in code-unit order",
		);
		// §3.2.2.2 numbers use ECMAScript number-to-string: no exponent, no ".0".
		assert.match(line, /"round":10/u, "an integer is serialized as ECMAScript would");
		// §3.2.2.1 strings keep every character that JSON need not escape, so
		// non-ASCII is literal rather than \\u-escaped.
		assert.match(line, /"node":"café"/u, "non-ASCII is not escaped");
		assert.match(line, /"path":"src\/ünicode\/日本\.ts"/u);
		assert.doesNotMatch(line, /\\\\u00e9/iu, "no redundant unicode escaping");
		assert.equal(await verifyChain(path), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an unpaired surrogate is an error, not something to escape", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-append-surrogate-"));
	const path = join(directory, "events.jsonl");
	try {
		// RFC 8785 §3.2.2.2 makes a lone surrogate an error. JSON.stringify would
		// happily escape it, and two implementations disagreeing about that would
		// hash the same input differently.
		await assert.rejects(
			appendEvent(path, {
				ts: "2026-09-02T00:00:00.000Z",
				type: "tool.request",
				job_id: "surrogate-job",
				round: 0,
				node: "writer",
				tool: "write",
				decision: "allow",
				path: `src/a\uD800b.ts`,
			} as unknown as EventInput),
			/unpaired surrogate/u,
		);
		assert.equal(await stat(path).catch(() => undefined), undefined, "nothing was written");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("inspectChain names the first broken line and what is wrong with it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-append-inspect-"));
	const path = join(directory, "events.jsonl");
	try {
		for (const index of [0, 1, 2]) {
			await appendEvent(path, {
				ts: new Date(1_700_000_000_000 + index).toISOString(),
				type: "tool.request",
				job_id: "inspect-job",
				round: 0,
				node: `writer-${index}`,
				tool: "write",
				decision: "allow",
			});
		}
		const clean = await inspectChain(path);
		assert.deepEqual(clean, { ok: true, path, records: 3 });

		// One byte of content changed: the record no longer hashes to its own hash.
		const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
		const tampered = [...lines];
		tampered[1] = tampered[1].replace('"writer-1"', '"writer-x"');
		const tamperedPath = join(directory, "tampered.jsonl");
		await writeFile(tamperedPath, `${tampered.join("\n")}\n`);
		const broken = await inspectChain(tamperedPath);
		assert.equal(broken.ok, false);
		assert.equal(broken.line, 2, "the second line is named");
		assert.equal(broken.records, 1, "one record verified before it");
		assert.match(broken.reason ?? "", /record_hash does not match the record's own bytes/u);

		// A dropped record breaks the link rather than the hash.
		const droppedPath = join(directory, "dropped.jsonl");
		await writeFile(droppedPath, `${[lines[0], lines[2]].join("\n")}\n`);
		const dropped = await inspectChain(droppedPath);
		assert.equal(dropped.ok, false);
		assert.equal(dropped.line, 2);
		assert.match(dropped.reason ?? "", /prev_hash does not chain to the previous record/u);

		const missing = await inspectChain(join(directory, "absent.jsonl"));
		assert.deepEqual(missing, {
			ok: false,
			path: join(directory, "absent.jsonl"),
			records: 0,
			reason: "no event log at this path",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
