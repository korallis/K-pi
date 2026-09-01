import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";
import {
	atomicWrite,
	createJob,
	readActiveJob,
	readJob,
	type Task,
} from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

const taskSchema = JSON.parse(
	await readFile(new URL("../packages/coding-agent/src/kpi/schemas/task.schema.json", import.meta.url), "utf8"),
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
				write_deny: [".kpi/policy.json"],
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

async function withTempDirectory(_name: string, run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-run-store-"));
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

		const persisted = JSON.parse(await readFile(join(loaded.directory, "task.json"), "utf8")) as unknown;
		assert.deepEqual(persisted, task);

		const errors = validateJsonSchema(persisted, taskSchema);
		assert.deepEqual(errors, [], `persisted task must satisfy task.schema.json: ${errors.join("; ")}`);
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

test("the active job is the most recently written progress document", async () => {
	await withTempDirectory("active-job", async (directory) => {
		assert.equal(await readActiveJob(directory), undefined, "no runs directory means no active job");

		const runs = join(directory, ".kpi", "runs");
		await mkdir(join(runs, "job-unstarted"), { recursive: true });
		assert.equal(await readActiveJob(directory), undefined, "a run without state.json has not started");

		await atomicWrite(join(runs, "job-older", "state.json"), JSON.stringify({ job_id: "job-older", round: 1 }));
		const older = await readActiveJob(directory);
		assert.equal(older?.jobId, "job-older");
		assert.equal(older?.state.round, 1);
		assert.equal(older?.directory, join(runs, "job-older"));
		assert.equal(older?.statePath, join(runs, "job-older", "state.json"));
		assert.equal(older?.eventsPath, join(runs, "job-older", "events.jsonl"));

		// mtime resolution is coarse, so the newer document is stamped forward
		// rather than raced against the clock.
		const newerPath = join(runs, "job-newer", "state.json");
		await atomicWrite(newerPath, JSON.stringify({ job_id: "job-newer", round: 7 }));
		const future = new Date(Date.now() + 60_000);
		await utimes(newerPath, future, future);
		const newer = await readActiveJob(directory);
		assert.equal(newer?.jobId, "job-newer", "the newest state.json wins");
		assert.equal(newer?.state.round, 7);

		// A document with no job_id falls back to its run directory name.
		const namelessPath = join(runs, "job-nameless", "state.json");
		await atomicWrite(namelessPath, JSON.stringify({ round: 9 }));
		const later = new Date(Date.now() + 120_000);
		await utimes(namelessPath, later, later);
		assert.equal((await readActiveJob(directory))?.jobId, "job-nameless");
	});
});
