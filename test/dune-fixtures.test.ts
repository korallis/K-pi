import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME } from "../packages/coding-agent/src/config.ts";
import { readTaskForJob, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import {
	assertClaimInModule,
	assertScaffoldedBeforeBehavior,
	DuneStackError,
	freezeCurrentSlice,
	type StackModule,
	stackRequiredFor,
} from "../packages/coding-agent/src/kpi/extensions/stack.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const STACK_SOURCE = fileURLToPath(new URL("../packages/coding-agent/src/kpi/extensions/stack.ts", import.meta.url));

/** The twelve invalid-stack cases `uat.md` UAT-30 names, in its order, plus the valid control. */
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

/**
 * Every message a seed expects, as the literal fragments `stack.ts` writes
 * around its interpolations. An empty fragment means the message ends on an
 * interpolation. Reasons are the product's own prose, so a reworded message
 * fails here rather than leaving a fixture that no longer describes the harness.
 */
const REASON_SHAPES: string[][] = [
	["stack.json is missing; implement has no frozen map to read"],
	["stack.json was frozen against a different task.json"],
	["stack.json names slice ", " while task.json names ", ""],
	["UNSAFE claim outside module ", ": ", ""],
	["Auth must live in its auth folder"],
	["Layer folder ", " cannot be a top-level module"],
	["Generic module needs a tight purpose: ", ""],
	["shared needs two consuming slices before extraction; ", " declared"],
	["Horizontal delivery requires a reason"],
	["Module ", " has behaviour (", ") before its scaffold: missing ", ""],
];

interface Expectation {
	case: string;
	outcome: "unsafe" | "implement";
	reason?: string;
	claim?: { path: string; reason: string };
	note: string;
}

/** The message a shape produces: its fragments with any run of text between them. */
function reasonPattern(fragments: string[]): RegExp {
	const literals = fragments.map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
	return new RegExp(`^${literals.join(".+")}$`, "u");
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
 * The precondition an implement round runs, in the loop's order: a frozen map
 * for this contract, the one slice it names, the scaffold before any behaviour,
 * and the module boundary a `claim_path` asks about.
 */
async function implementPrecondition(seed: SeededRun, claim?: string): Promise<StackModule | undefined> {
	const task = await readTaskForJob(seed.root, seed.jobId);
	if (!stackRequiredFor(task)) {
		return undefined;
	}
	const { module } = await freezeCurrentSlice(seed.root, seed.run, task);
	await assertScaffoldedBeforeBehavior(seed.root, module);
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
				assert.equal(error.message, expected.reason);
				return true;
			});
		} finally {
			await rm(seed.root, { recursive: true, force: true });
		}
	});
}

test("every documented case has a seed, and every expected reason is still the product's own", async () => {
	const present = (await readdir(FIXTURES, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("dune-"))
		.map((entry) => entry.name);
	assert.deepEqual(present.sort(), [...CASES].sort(), "one seed directory per documented case");

	const source = await readFile(STACK_SOURCE, "utf8");
	for (const shape of REASON_SHAPES) {
		for (const fragment of shape.filter((part) => part.length > 0)) {
			assert.ok(source.includes(fragment), `stack.ts no longer writes: ${fragment}`);
		}
	}

	const exercised = new Set<number>();
	for (const name of CASES) {
		const expected = JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")) as Expectation;
		assert.equal(expected.case, name, "expected.json names its own directory");
		assert.ok(expected.note.trim().length > 0, `${name} explains itself`);
		for (const file of [".gitignore", "AGENTS.md", "package.json", "task.txt", "task.json", "expected.json"]) {
			assert.equal(await exists(join(FIXTURES, name, file)), true, `${name}/${file}`);
		}
		// Two seeds are about the absence of a map: one is refused for it, one is exempt from it.
		const stackless = name === "dune-missing-stack" || name === "dune-no-stack-exemption";
		assert.equal(await exists(join(FIXTURES, name, "stack.json")), !stackless, `${name}/stack.json`);
		const manifest = JSON.parse(await readFile(join(FIXTURES, name, "package.json"), "utf8")) as {
			dependencies?: unknown;
		};
		assert.equal(manifest.dependencies, undefined, `${name} declares no dependency`);

		if (expected.outcome === "implement") {
			assert.equal(expected.reason, undefined, `${name} reaches implement, so it names no reason`);
			assert.equal(expected.claim, undefined, `${name} reaches implement, so it names no claim`);
			continue;
		}
		const reason = expected.reason ?? "";
		const matching = [...REASON_SHAPES.entries()].filter(([, shape]) => reasonPattern(shape).test(reason));
		assert.equal(matching.length, 1, `${name} must match exactly one stack.ts message: ${reason}`);
		exercised.add(matching[0][0]);
		if (expected.claim !== undefined) {
			assert.equal(expected.claim.reason, reason, `${name} claim reason is the denial`);
		}
	}
	assert.equal(exercised.size, REASON_SHAPES.length, "every message shape has a seed");
});
