import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	assertLadderMatchesChanges,
	assertMinimalistBounds,
	LADDER_RUNGS,
	type ObservedChange,
	parseLadderDecision,
} from "../packages/coding-agent/src/kpi/extensions/minimalist.ts";
import type { Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/minimalist-one-concat", import.meta.url));

function emptyTask(overrides: Partial<Task> = {}): Task {
	return {
		job_id: "job-min",
		mode: "gated",
		goal: "concat",
		nongoals: [],
		acceptance: [],
		constraints: [],
		quality_gates: ["npm test"],
		ac: { quality: "executable" },
		dependency_baseline: [],
		runtime_dependencies: [],
		...overrides,
	};
}

async function withTempProject(
	seed: (root: string, run: string) => Promise<void>,
	body: (root: string, run: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "kpi-min-"));
	const run = join(root, "run");
	try {
		await mkdir(run, { recursive: true });
		await seed(root, run);
		await body(root, run);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const validLadder = {
	ladder: "one-liner",
	used: "template literal in src/join.js",
	skipped: "helper module and utility class",
};

test("documented ladder vocabulary is the only accepted rung set", () => {
	assert.deepEqual(
		[...LADDER_RUNGS],
		["yagni", "reuse", "standard-library", "native-platform", "existing-dependency", "one-liner", "minimum-code"],
	);
	for (const rung of LADDER_RUNGS) {
		const decision = parseLadderDecision({ ladder: rung, used: "x", skipped: "y" });
		assert.equal(decision.ladder, rung);
	}
});

test("missing ladder fails independently of dependencies", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
			await writeFile(join(run, "candidate.json"), JSON.stringify({ summary: "no ladder" }));
		},
		async (root, run) => {
			await assert.rejects(assertMinimalistBounds(root, run, emptyTask(), []), /ladder is required/u);
		},
	);
});

test("unknown rung fails independently", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
			await writeFile(
				join(run, "candidate.json"),
				JSON.stringify({ ladder: "enterprise-patterns", used: "x", skipped: "y" }),
			);
		},
		async (root, run) => {
			await assert.rejects(assertMinimalistBounds(root, run, emptyTask(), []), /unknown ladder rung/u);
		},
	);
});

test("missing used fails independently", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
			await writeFile(join(run, "candidate.json"), JSON.stringify({ ladder: "one-liner", skipped: "helper" }));
		},
		async (root, run) => {
			await assert.rejects(assertMinimalistBounds(root, run, emptyTask(), []), /used/u);
		},
	);
});

test("missing skipped fails independently", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {} }));
			await writeFile(join(run, "candidate.json"), JSON.stringify({ ladder: "one-liner", used: "inline concat" }));
		},
		async (root, run) => {
			await assert.rejects(assertMinimalistBounds(root, run, emptyTask(), []), /skipped/u);
		},
	);
});

test("placeholder used/skipped values are not meaningful decisions", () => {
	assert.throws(() => parseLadderDecision({ ladder: "one-liner", used: "n/a", skipped: "helper" }), /real decision/u);
	assert.throws(() => parseLadderDecision({ ladder: "one-liner", used: "inline", skipped: "TODO" }), /real decision/u);
});

test("undeclared runtime dependency fails independently of a valid ladder", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { surprise: "1.0.0" } }));
			await writeFile(join(run, "candidate.json"), JSON.stringify(validLadder));
		},
		async (root, run) => {
			await assert.rejects(
				assertMinimalistBounds(root, run, emptyTask({ dependency_baseline: [] }), []),
				/undeclared runtime dependencies: surprise/u,
			);
		},
	);
});

test("dependency baseline still allows only declared or baseline packages", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(
				join(root, "package.json"),
				JSON.stringify({ dependencies: { lodash: "4.0.0", surprise: "1.0.0" } }),
			);
			await writeFile(
				join(run, "candidate.json"),
				JSON.stringify({
					ladder: "minimum-code",
					used: "lodash already in package.json plus authorized surprise",
					skipped: "unlisted packages",
				}),
			);
		},
		async (root, run) => {
			await assert.rejects(
				assertMinimalistBounds(
					root,
					run,
					emptyTask({ dependency_baseline: ["lodash"], runtime_dependencies: [] }),
					[],
				),
				/undeclared runtime dependencies: surprise/u,
			);
			await assert.doesNotReject(
				assertMinimalistBounds(
					root,
					run,
					emptyTask({ dependency_baseline: ["lodash"], runtime_dependencies: ["surprise"] }),
					[],
				),
			);
		},
	);
});

const joinBefore = `/** Join two non-empty string parts with a single space. */
export function joinParts(left, right) {
	return left;
}
`;

const joinOneLiner = `/** Join two non-empty string parts with a single space. */
export function joinParts(left, right) {
	return \`\${left} \${right}\`;
}
`;

test("one-concat direct one-line change passes with zero new files", async () => {
	await withTempProject(
		async (root, run) => {
			await cp(FIXTURE, root, { recursive: true });
			await writeFile(join(run, "candidate.json"), JSON.stringify(validLadder));
			// Apply the correct one-line fix inside the seeded fixture file.
			await writeFile(join(root, "src/join.js"), joinOneLiner);
		},
		async (root, run) => {
			const changes: ObservedChange[] = [
				{
					path: "src/join.js",
					kind: "modified",
					before: joinBefore,
					after: joinOneLiner,
				},
			];
			await assert.doesNotReject(assertMinimalistBounds(root, run, emptyTask(), changes));
			// Fixture still has no extra files beyond the seed.
			const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
				dependencies?: Record<string, string>;
			};
			assert.equal(pkg.dependencies, undefined);
		},
	);
});

test("new helper file fails the one-concat ladder claim", () => {
	assert.throws(
		() =>
			assertLadderMatchesChanges(parseLadderDecision(validLadder), [
				{
					path: "src/join.js",
					kind: "modified",
					before: joinBefore,
					after: joinOneLiner,
				},
				{
					path: "src/helpers.js",
					kind: "added",
					after: "export const space = ' ';\n",
				},
			]),
		/forbids new files/u,
	);
});

test("new function helper in-place fails one-liner", () => {
	const after = `/** Join two non-empty string parts with a single space. */
function spaceJoin(a, b) {
	return a + " " + b;
}
export function joinParts(left, right) {
	return spaceJoin(left, right);
}
`;
	assert.throws(
		() =>
			assertLadderMatchesChanges(parseLadderDecision(validLadder), [
				{ path: "src/join.js", kind: "modified", before: joinBefore, after },
			]),
		/forbids adding a function or helper/u,
	);
});

test("new class fails one-liner", () => {
	const after = `export class Joiner {
	join(left, right) { return left + " " + right; }
}
export function joinParts(left, right) {
	return new Joiner().join(left, right);
}
`;
	assert.throws(
		() =>
			assertLadderMatchesChanges(parseLadderDecision(validLadder), [
				{ path: "src/join.js", kind: "modified", before: joinBefore, after },
			]),
		/forbids adding a class/u,
	);
});

test("new abstraction fails one-liner", () => {
	const after = `export interface Joinable { left: string; right: string }
export function joinParts(left, right) {
	return left + " " + right;
}
`;
	assert.throws(
		() =>
			assertLadderMatchesChanges(parseLadderDecision(validLadder), [
				{ path: "src/join.js", kind: "modified", before: joinBefore, after },
			]),
		/abstraction/u,
	);
});

test("equal-line-count multi-line rewrite fails one-liner", () => {
	// Same nonempty line count, every body line rewritten — must not pass as one-liner.
	const after = `/** Entirely different documentation for the join helper. */
export function joinParts(left, right) {
	return [left, right].filter(Boolean).join(" ");
}
`;
	assert.equal(splitNonEmpty(joinBefore).length, splitNonEmpty(after).length);
	assert.throws(
		() =>
			assertLadderMatchesChanges(parseLadderDecision(validLadder), [
				{ path: "src/join.js", kind: "modified", before: joinBefore, after },
			]),
		/actual one-line edit|multi-line rewrite/u,
	);
});

test("two-file edit fails one-liner even without new files", () => {
	assert.throws(
		() =>
			assertLadderMatchesChanges(parseLadderDecision(validLadder), [
				{ path: "src/join.js", kind: "modified", before: joinBefore, after: joinOneLiner },
				{
					path: "src/other.js",
					kind: "modified",
					before: "export const x = 1;\n",
					after: "export const x = 2;\n",
				},
			]),
		/exactly one pre-existing file/u,
	);
});

test("standard-library may add a required feature file", () => {
	assert.doesNotThrow(() =>
		assertLadderMatchesChanges(
			parseLadderDecision({
				ladder: "standard-library",
				used: "node:fs promises in src/fs-util.js",
				skipped: "lodash fs helpers",
			}),
			[
				{
					path: "src/fs-util.js",
					kind: "added",
					after: 'import { readFile } from "node:fs/promises";\nexport async function load(p) { return readFile(p, "utf8"); }\n',
				},
			],
		),
	);
});

test("native-platform may add a required feature file", () => {
	assert.doesNotThrow(() =>
		assertLadderMatchesChanges(
			parseLadderDecision({
				ladder: "native-platform",
				used: "process.platform branch in src/path-sep.js",
				skipped: "path library package",
			}),
			[
				{
					path: "src/path-sep.js",
					kind: "added",
					after: 'export const sep = process.platform === "win32" ? "\\\\" : "/";\n',
				},
			],
		),
	);
});

test("minimum-code may add a required class without categorical ban", () => {
	assert.doesNotThrow(() =>
		assertLadderMatchesChanges(
			parseLadderDecision({
				ladder: "minimum-code",
				used: "ErrorBoundary class required by React AC",
				skipped: "extra HOC wrappers",
			}),
			[
				{
					path: "src/ErrorBoundary.tsx",
					kind: "added",
					after: "export class ErrorBoundary extends Component {\n\trender() { return this.props.children; }\n}\n",
				},
			],
		),
	);
});

test("reuse cannot claim a just-added used path", () => {
	assert.throws(
		() =>
			assertLadderMatchesChanges(
				parseLadderDecision({
					ladder: "reuse",
					used: "src/lib/hash.ts",
					skipped: "new hasher",
				}),
				[{ path: "src/lib/hash.ts", kind: "added", after: "export function hash() {}\n" }],
			),
		/cannot claim used=.*just added/u,
	);
});

test("runtime dependency addition fails even with a one-line body", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }));
			await writeFile(join(run, "candidate.json"), JSON.stringify(validLadder));
			await mkdir(join(root, "src"), { recursive: true });
			await writeFile(join(root, "src/join.js"), joinOneLiner);
		},
		async (root, run) => {
			await assert.rejects(
				assertMinimalistBounds(root, run, emptyTask({ dependency_baseline: [] }), [
					{
						path: "src/join.js",
						kind: "modified",
						before: joinBefore,
						after: joinOneLiner,
					},
				]),
				/undeclared runtime dependencies|forbids new runtime dependencies/u,
			);
		},
	);
});

test("existing-dependency fails for a newly declared package even when task authorizes it", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { chalk: "5.0.0" } }));
			await writeFile(
				join(run, "candidate.json"),
				JSON.stringify({
					ladder: "existing-dependency",
					used: "chalk already in the monorepo",
					skipped: "hand-rolled color codes",
				}),
			);
		},
		async (root, run) => {
			await assert.rejects(
				assertMinimalistBounds(
					root,
					run,
					emptyTask({ dependency_baseline: [], runtime_dependencies: ["chalk"] }),
					[],
				),
				/ladder existing-dependency forbids new runtime dependencies/u,
			);
		},
	);
});

test("standard-library fails when a runtime dependency is introduced", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { zod: "3.0.0" } }));
			await writeFile(
				join(run, "candidate.json"),
				JSON.stringify({
					ladder: "standard-library",
					used: "JSON.parse",
					skipped: "schema library",
				}),
			);
		},
		async (root, run) => {
			await assert.rejects(
				assertMinimalistBounds(
					root,
					run,
					emptyTask({ dependency_baseline: [], runtime_dependencies: ["zod"] }),
					[],
				),
				/ladder standard-library forbids new runtime dependencies/u,
			);
		},
	);
});

test("minimum-code may take a task-authorized new runtime dependency", async () => {
	await withTempProject(
		async (root, run) => {
			await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { zod: "3.0.0" } }));
			await writeFile(
				join(run, "candidate.json"),
				JSON.stringify({
					ladder: "minimum-code",
					used: "zod schema required by the AC",
					skipped: "hand-written validators",
				}),
			);
		},
		async (root, run) => {
			await assert.doesNotReject(
				assertMinimalistBounds(
					root,
					run,
					emptyTask({ dependency_baseline: [], runtime_dependencies: ["zod"] }),
					[],
				),
			);
		},
	);
});

test("nested ladder object form is accepted when complete", () => {
	const decision = parseLadderDecision({
		ladder: {
			ladder: "Reuse",
			used: "src/lib/hash.ts",
			skipped: "new hasher class",
		},
	});
	assert.equal(decision.ladder, "reuse");
	assert.equal(decision.used, "src/lib/hash.ts");
});

function splitNonEmpty(text: string): string[] {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}
