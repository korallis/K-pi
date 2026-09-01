import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEvent,
  verifyChain,
  type EventInput,
} from "../extensions/append-log.ts";

async function withEventLog(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-events-"));
  try {
    await run(join(directory, "events.jsonl"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function event(round: number): EventInput {
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

test("event payloads redact Anthropic keys and credential fields", async () => {
  await withEventLog(async (path) => {
    const rawSecret = "sk-ant-api03-example-secret";
    await appendEvent(path, {
      ...event(1),
      detail: `provider returned ${rawSecret}`,
      authorization: `Bearer ${rawSecret}`,
      nested: {
        cookie: "session=raw-cookie",
        safe: "visible",
        "sk-ant-secret-field": "hidden-key",
      },
    });

    const stored = await readFile(path, "utf8");
    assert.doesNotMatch(stored, /sk-ant-/);
    assert.doesNotMatch(stored, /raw-cookie/);
    assert.doesNotMatch(stored, /hidden-key/);
    assert.match(stored, /\[REDACTED\]/);
    assert.match(stored, /visible/);
    assert.equal(await verifyChain(path), true);
  });
});
