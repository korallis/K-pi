import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME } from "../packages/coding-agent/src/config.ts";
import { contractHash, readTaskForJob, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import {
	assertClaimInModule,
	DuneStackError,
	freezeCurrentSlice,
	type StackModule,
	stackRequiredFor,
} from "../packages/coding-agent/src/kpi/extensions/stack.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Historical fixtures now exercise explicit ownership, not layout ceremony. */
const CASES = [
	"dune-valid",
	"dune-missing-stack",
	"dune-stale-stack",
	"dune-second-selected-module",
	"dune-prefix-escape",
	"dune-auth-under-lib",
	"dune-top-level-layer",
	"dune-top-level-generic",
	"dune-one-consumer-shared",
	"dune-horizontal-no-reason",
	"dune-no-stack-exemption",
	"dune-second-slice-extraction",
	"dune-scaffold-order",
] as const;

interface Expectation {
	case: string;
	outcome: "unsafe" | "implement";
	reason?: string;
	claim?: { path: string; reason: string };
	note: string;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

interface SeededRun {
	root: string;
	run: string;
	jobId: string;
}

/**
 * The seed copied into a tmpdir and laid out the way a live run is: the frozen
 * contract and the frozen map inside `.kpi/runs/<job_id>`. The fixture itself is
 * only ever read.
 */
async function seedRun(name: string): Promise<SeededRun> {
	const root = await mkdtemp(join(tmpdir(), `kpi-${name}-`));
	await rm(root, { recursive: true, force: true });
	await cp(join(FIXTURES, name), root, { recursive: true });

	const seeded = JSON.parse(await readFile(join(root, "task.json"), "utf8")) as Task;
	const run = join(root, CONFIG_DIR_NAME, "runs", seeded.job_id);
	await mkdir(run, { recursive: true });
	await rename(join(root, "task.json"), join(run, "task.json"));
	const { current_module_id: _slice, ...protectedTask } = seeded;
	await writeFile(
		join(run, "intent.json"),
		JSON.stringify({
			version: 1,
			job_id: seeded.job_id,
			revision: 1,
			hash: contractHash(seeded),
			accepted_at: new Date().toISOString(),
			task: protectedTask,
		}),
	);

	// A run freezes the contract first and the plan writes the map second. `cp`
	// hands both files one instant, and that order is exactly what the no-hash
	// freshness fallback reads, so it is set here instead of left to the copier.
	const frozen = new Date(Date.now() - 60_000);
	await utimes(join(run, "task.json"), frozen, frozen);
	const seededStack = join(root, "stack.json");
	if (await exists(seededStack)) {
		await rename(seededStack, join(run, "stack.json"));
		const planned = new Date(frozen.getTime() + 2_000);
		await utimes(join(run, "stack.json"), planned, planned);
	}
	return { root, run, jobId: seeded.job_id };
}

/**
 * The precondition an implement round runs: a frozen map for this contract,
 * its explicit selected slice, and canonical path ownership.
 */
async function implementPrecondition(seed: SeededRun, claim?: string): Promise<StackModule | undefined> {
	const task = await readTaskForJob(seed.root, seed.jobId);
	if (!stackRequiredFor(task)) {
		return undefined;
	}
	const { module } = await freezeCurrentSlice(seed.root, seed.run, task);
	// The boundary admits the slice's own folder before it is asked about anything else.
	await assertClaimInModule(seed.root, `${module.folder}/index.ts`, module);
	if (claim !== undefined) {
		await assertClaimInModule(seed.root, claim, module);
	}
	return module;
}

for (const name of CASES) {
	const expected = JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")) as Expectation;

	test(name, async () => {
		const seed = await seedRun(name);
		try {
			if (expected.outcome === "implement") {
				const module = await implementPrecondition(seed);
				// Either the map named the slice and the contract now carries it, or the
				// playbook is exempt and there is no slice to carry.
				const frozen = await readTaskForJob(seed.root, seed.jobId);
				assert.equal(frozen.current_module_id, module?.id, "the frozen contract is what implement reads next");
				return;
			}
			await assert.rejects(implementPrecondition(seed, expected.claim?.path), (error: unknown) => {
				assert.ok(error instanceof DuneStackError, `${name} threw ${String(error)}`);
				return true;
			});
		} finally {
			await rm(seed.root, { recursive: true, force: true });
		}
	});
}
