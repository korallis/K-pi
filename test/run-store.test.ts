import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  atomicWrite,
  createJob,
  readJob,
  type Task,
} from "../extensions/run-store.ts";

const task: Task = {
  job_id: "2026-08-31-hash-chain",
  mode: "gated",
  goal: "Persist a run",
  nongoals: [],
  acceptance: [],
  constraints: [],
  quality_gates: ["pnpm test"],
  ac: { quality: "executable" },
};

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-run-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("createJob writes and readJob reads the run contract", async () => {
  await withTempDirectory(async (directory) => {
    const created = await createJob(directory, task, "frozen context\n");
    const loaded = await readJob(directory, task.job_id);

    assert.equal(created.directory, loaded.directory);
    assert.deepEqual(loaded.task, task);
    assert.equal(loaded.context, "frozen context\n");
    assert.equal(await readFile(loaded.eventsPath, "utf8"), "");
  });
});

test("a crash before rename cannot expose a partial candidate.json", async () => {
  await withTempDirectory(async (directory) => {
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
