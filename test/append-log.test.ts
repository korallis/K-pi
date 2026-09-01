import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendEvent,
	type EventInput,
	ForbiddenEventPayloadError,
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
