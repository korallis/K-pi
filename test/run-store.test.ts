import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  validateJsonSchema,
  type JsonSchema,
} from "../extensions/graph/json-schema.ts";
import {
  atomicWrite,
  createJob,
  readJob,
  type Task,
} from "../extensions/run-store.ts";

const taskSchema = JSON.parse(
  await readFile(new URL("../schemas/task.schema.json", import.meta.url), "utf8"),
) as JsonSchema;

/** Carries every optional slot the contract allows, so a dropped one shows. */
const task: Task = {
  job_id: "2026-08-31-hash-chain",
  mode: "gated",
  goal: "Persist a run",
  nongoals: ["rewrite the graph engine"],
  acceptance: [
    {
      id: "AC-1",
      statement: "the store round-trips an executable criterion",
      required: true,
      check: {
        kind: "command",
        cmd: "node --test --experimental-strip-types test/run-store.test.ts",
        expect: { exit: 0, stdout_includes: ["pass"] },
      },
      bounds: {
        write_allow: ["extensions/run-store.ts", "test/run-store.test.ts"],
        write_deny: [".pi/policy.json"],
      },
    },
    {
      id: "AC-2",
      statement: "a narrative criterion survives without a check or bounds",
      required: false,
    },
  ],
  constraints: ["no new runtime dependencies"],
  quality_gates: ["pnpm test"],
  ac: { quality: "executable" },
  playbook: "coding-loop.gated",
  runtime_dependencies: ["node>=22.19"],
  dependency_baseline: ["typescript@5.9.3"],
  current_module_id: "run-store",
};

async function withTempDirectory(
  name: string,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = join(tmpdir(), "k-pi-run-store", name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("createJob writes and readJob reads the run contract", async () => {
  await withTempDirectory("create-read", async (directory) => {
    const created = await createJob(directory, task, "frozen context\n");
    const loaded = await readJob(directory, task.job_id);

    assert.equal(created.directory, loaded.directory);
    assert.deepEqual(loaded.task, created.task);
    assert.deepEqual(loaded.task, task);
    assert.equal(loaded.context, "frozen context\n");
    assert.equal(await readFile(loaded.eventsPath, "utf8"), "");

    const persisted = JSON.parse(
      await readFile(join(loaded.directory, "task.json"), "utf8"),
    ) as unknown;
    assert.deepEqual(persisted, task);

    const errors = validateJsonSchema(persisted, taskSchema);
    assert.deepEqual(
      errors,
      [],
      `persisted task must satisfy task.schema.json: ${errors.join("; ")}`,
    );
  });
});

test("a crash before rename cannot expose a partial candidate.json", async () => {
  await withTempDirectory("atomic-write", async (directory) => {
    const candidatePath = join(directory, "candidate.json");
    const tempPath = join(directory, "candidate.tmp");

    await mkdir(candidatePath);
    await assert.rejects(atomicWrite(candidatePath, '{"complete":true}\n'));
    assert.equal((await stat(candidatePath)).isDirectory(), true);
    assert.equal(await readFile(tempPath, "utf8"), '{"complete":true}\n');

    await rm(candidatePath, { recursive: true });
    await atomicWrite(candidatePath, '{"complete":true}\n');
    assert.deepEqual(JSON.parse(await readFile(candidatePath, "utf8")), {
      complete: true,
    });
    await assert.rejects(readFile(tempPath, "utf8"), { code: "ENOENT" });
  });
});
