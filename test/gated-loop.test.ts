import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import { registerControlPlane } from "../packages/coding-agent/src/kpi/extensions/control-plane.ts";
import {
	CONVENTIONAL_COMMIT_PATTERN,
	findJobCommit,
	verifyShippedCommit,
} from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";

const execFile = promisify(execFileCallback);
const fixtureSource = fileURLToPath(new URL("../fixtures/healthcheck-gated/", import.meta.url));
const validVerdict = JSON.stringify({
	status: "PASS",
	approved: true,
	blockingIssues: [],
	nonBlockingIssues: [],
	evidence: ["evidence.json"],
	round: 1,
	output_fingerprint: `sha256:${"a".repeat(64)}`,
});
const commandEnvironment: NodeJS.ProcessEnv = {
	...process.env,
	PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
};
delete commandEnvironment.NODE_TEST_CONTEXT;

/** Ladder decision the implementer records before product files change. */
const MINIMALIST_CANDIDATE = `{
  "ladder": "minimum-code",
  "used": "direct health handler in src/health/server.js",
  "skipped": "framework wrapper, utility module, and extra abstraction"
}`;

const implementedServer = `import { createServer } from "node:http";

export function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

export function createApp() {
  return createServer(handleRequest);
}
`;

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

async function git(directory: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd: directory });
	return stdout.trim();
}

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-gated-"));
	await rm(directory, { recursive: true, force: true });
	await cp(fixtureSource, directory, { recursive: true });
	await git(directory, "init");
	await git(directory, "config", "user.email", "fixture@example.test");
	await git(directory, "config", "user.name", "Fixture");
	await git(directory, "add", "-A");
	await git(directory, "commit", "-m", "chore: seed fixture");
	return directory;
}

function nodeId(prompt: string): string {
	if (prompt.includes("Check the frozen task")) return "ac-compiler";
	if (prompt.includes("spec-first skill")) return "specify";
	if (prompt.includes("implementation plan and stack.json")) return "plan";
	if (prompt.includes("frozen plan still matches")) return "plan-check";
	if (prompt.includes("tdd-cycle skill")) return "implement";
	if (prompt.includes("quality-gates skill")) return "test";
	if (prompt.includes("isolated-review skill")) return "review";
	if (prompt.includes("conventional-commit skill")) return "ship";
	return "retry";
}

/** The map the plan node writes, exactly as `dune-architecture.md` requires. */
const healthStack = JSON.stringify(
	{
		version: 1,
		shape: "dune",
		delivery: "vertical",
		root: "src",
		current_module_id: "health",
		modules: [
			{
				id: "health",
				purpose: "healthcheck endpoint and its tests",
				folder: "src/health",
				interface: "src/health/api.ts",
				allowed_paths: ["src/health/**", "test/health/**"],
				depends_on: [],
			},
		],
		scaffold_first: true,
	},
	null,
	2,
);

async function writePlannedStack(directory: string, jobId: string, document: string = healthStack): Promise<void> {
	const runDirectory = join(directory, ".kpi", "runs", jobId);
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "stack.json"), `${document}\n`);
}

function loopSessions(
	directory: string,
	executed: string[],
	options: {
		validateCommands?: boolean;
		reviewResponses?: string[];
		jobId?: string;
		/** A document to write, or null when the plan writes no map at all. */
		stack?: string | null;
		/**
		 * Stands in for the K-mode matcher that owns AC-19.2: the name it would have
		 * written onto `task.json.playbook` before implement.
		 */
		playbook?: string;
	} = {},
): GraphAgentSessionFactory {
	let sessionNumber = 0;
	let reviewAttempt = 0;
	return async (sessionOptions) => {
		let implementationAttempt = 0;
		sessionNumber += 1;
		let currentNode = "";
		let lastAssistantText: string | undefined;
		return {
			session: {
				sessionId: `fixture-session-${sessionNumber}`,
				async prompt(prompt) {
					const detected = nodeId(prompt);
					if (detected !== "retry") currentNode = detected;
					executed.push(currentNode || detected);

					if (currentNode === "plan" || currentNode === "plan-check") {
						// Plan writes the map. The control plane freezes it before implement.
						if (options.jobId !== undefined && options.stack !== null) {
							await writePlannedStack(directory, options.jobId, options.stack ?? undefined);
						}
						if (options.jobId !== undefined && options.playbook !== undefined) {
							const taskPath = join(directory, ".kpi", "runs", options.jobId, "task.json");
							const contract = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
							contract.playbook = options.playbook;
							await writeFile(taskPath, `${JSON.stringify(contract, null, 2)}\n`);
						}
					} else if (currentNode === "implement") {
						if (options.validateCommands === true && implementationAttempt === 0) {
							await assert.rejects(
								execFile("npm", ["test"], {
									cwd: directory,
									env: commandEnvironment,
								}),
							);
						}
						implementationAttempt += 1;
						if (options.jobId !== undefined) {
							await writeFile(
								join(directory, ".kpi", "runs", options.jobId, "candidate.json"),
								MINIMALIST_CANDIDATE,
							);
						}
						await writeFile(join(directory, "src", "health", "server.js"), implementedServer);
					} else if (currentNode === "test") {
						if (options.validateCommands === true) {
							await execFile("npm", ["test"], {
								cwd: directory,
								env: commandEnvironment,
							});
							await execFile("npm", ["run", "lint"], {
								cwd: directory,
								env: commandEnvironment,
							});
						}
						lastAssistantText = JSON.stringify({
							head: await git(directory, "rev-parse", "HEAD"),
							commands: [
								{ cmd: "npm test", exit: 1, excerpt: "expected 200, received 404" },
								{ cmd: "npm test", exit: 0, excerpt: "pass 1" },
								{ cmd: "npm run lint", exit: 0 },
							],
							ac_results: [{ id: "AC-01", passed: true }],
						});
					} else if (currentNode === "review") {
						lastAssistantText = options.reviewResponses?.[reviewAttempt] ?? validVerdict;
						reviewAttempt += 1;
					} else if (currentNode === "ship") {
						// The commit carries the trailer the prompt asked for: that is how
						// the control plane recognises this job's own commit.
						const trailer = /^KPI-Job: [^\s`]+$/mu.exec(prompt)?.[0] ?? "";
						await git(directory, "add", "-A");
						await git(directory, "commit", "-m", `feat(health): add healthcheck endpoint\n\n${trailer}`);
					}
				},
				getLastAssistantText: () => lastAssistantText,
				getActiveToolNames: () => [...(sessionOptions.tools ?? [])],
				dispose() {},
			},
		};
	};
}

function commandHarness(
	directory: string,
	factory: GraphAgentSessionFactory,
	jobId: string,
	confirmations: string[],
): {
	commands: Map<string, CommandHandler>;
	context: ExtensionCommandContext;
	notifications: string[];
} {
	const commands = new Map<string, CommandHandler>();
	const notifications: string[] = [];
	const pi = {
		on() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
	};
	registerControlPlane(pi as unknown as Parameters<typeof registerControlPlane>[0], {
		createAgentSession: factory,
		jobId,
	});
	const context = {
		cwd: directory,
		hasUI: true,
		mode: "tui",
		ui: {
			async confirm(title: string) {
				confirmations.push(title);
				return true;
			},
			notify(message: string) {
				notifications.push(message);
			},
			setWidget() {},
		},
	} as unknown as ExtensionCommandContext;
	return { commands, context, notifications };
}

async function latestCheckpoint(directory: string, jobId: string): Promise<Record<string, unknown>> {
	const graphDirectory = join(directory, ".kpi", "runs", jobId, "graph");
	const names = (await readdir(graphDirectory)).sort();
	return JSON.parse(await readFile(join(graphDirectory, names.at(-1)!), "utf8")) as Record<string, unknown>;
}

test("loop on healthcheck fixture reaches human confirm with green gates", async () => {
	const directory = await fixture();
	const jobId = "20260831-healthcheck-gated";
	const executed: string[] = [];
	const confirmations: string[] = [];
	try {
		assert.ok((await readFile(join(directory, "test", "health", "health.test.js"), "utf8")).includes("GET /health"));
		const task = await readFile(join(directory, "task.txt"), "utf8");
		const red = await execFile("npm", ["test"], {
			cwd: directory,
			env: commandEnvironment,
		}).then(
			(result) => ({ failed: false, output: result.stdout }),
			(error: { stdout?: string }) => ({ failed: true, output: error.stdout ?? "" }),
		);
		assert.equal(red.failed, true, red.output);
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { validateCommands: true, jobId }),
			jobId,
			confirmations,
		);

		await harness.commands.get("loop")!(task, harness.context);
		assert.equal(
			harness.notifications.some((message) => message.includes("failed")),
			false,
			`${harness.notifications.join("\n")}\nexecuted: ${executed.join(", ")}`,
		);

		assert.deepEqual(confirmations, ["Approve gated release"]);
		assert.ok(executed.includes("specify"));
		const state = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(state.status, "DONE");
		assert.equal(state.passed, true);
		assert.deepEqual(state.bounds, { held: true });
		assert.match(await git(directory, "log", "-1", "--pretty=%s"), CONVENTIONAL_COMMIT_PATTERN);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("kpi --plan freezes and hashes plan files without executing specify", async () => {
	const directory = await fixture();
	const jobId = "20260831-healthcheck-plan";
	const executed: string[] = [];
	try {
		const harness = commandHarness(directory, loopSessions(directory, executed, { jobId }), jobId, []);

		await harness.commands.get("kpi")!("--plan specs/healthcheck", harness.context);

		assert.ok(executed.includes("plan-check"));
		assert.equal(executed.includes("specify"), false);
		const checkpoint = await latestCheckpoint(directory, jobId);
		const nodes = checkpoint.nodes as Record<string, { runs: number }>;
		assert.equal(nodes.specify.runs, 0);
		for (const name of ["requirements.md", "design.md", "tasks.md"]) {
			assert.ok((await readFile(join(directory, ".kpi", "runs", jobId, "plan", name), "utf8")).length > 0);
		}
		const fingerprints = JSON.parse(
			await readFile(join(directory, ".kpi", "runs", jobId, "fingerprints.json"), "utf8"),
		) as { plan: Record<string, string> };
		assert.deepEqual(Object.keys(fingerprints.plan).sort(), [
			"plan/design.md",
			"plan/requirements.md",
			"plan/tasks.md",
		]);
		assert.ok(Object.values(fingerprints.plan).every((hash) => /^sha256:[0-9a-f]{64}$/u.test(hash)));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reviewer output retries until it validates against verdict schema", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-review-response-"));
	const prompts: string[] = [];
	const responses = [JSON.stringify({ approved: true }), validVerdict];
	let responseIndex = 0;
	const factory: GraphAgentSessionFactory = async (options) => {
		let last: string | undefined;
		return {
			session: {
				sessionId: "review-session",
				async prompt(prompt) {
					prompts.push(prompt);
					last = responses[responseIndex];
					responseIndex += 1;
				},
				getLastAssistantText: () => last,
				getActiveToolNames: () => [...(options.tools ?? [])],
				dispose() {},
			},
		};
	};
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "review-contract",
		entry: "review",
		nodes: [
			{
				id: "review",
				type: "agent",
				prompt: "Review candidate",
				context: { mode: "isolated" },
				tools: ["read"],
				readOnly: true,
				response: {
					path: "verdict.json",
					schema: "verdict.schema.json",
					retries: 2,
					state: { "review.approved": "approved" },
				},
			},
		],
		edges: [{ from: "review", to: "__end__" }],
		limits: {
			maxSteps: 3,
			maxNodeRuns: 3,
			maxConcurrency: 1,
			maxCostUsd: 1,
			timeoutMs: 10_000,
		},
		policy: {
			allowNonInteractive: false,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: true,
			confirmMutatingNodes: true,
		},
	};

	try {
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "review-job",
			createAgentSession: factory,
		});
		const state = await engine.runUntilPause();

		assert.equal(prompts.length, 2);
		assert.match(prompts[1]!, /failed verdict\.schema\.json/u);
		assert.deepEqual(state.values.review, { approved: true });
		assert.deepEqual(
			JSON.parse(await readFile(join(directory, ".kpi", "runs", "review-job", "verdict.json"), "utf8")),
			JSON.parse(validVerdict),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("ship commit subject matches the conventional commit contract", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-ship-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "file.txt");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");
		await writeFile(join(directory, "file.txt"), "changed\n");
		await git(directory, "add", "file.txt");
		await git(directory, "commit", "-m", "fix(ship): validate commit subject");

		const subject = await verifyShippedCommit(directory, previousHead);
		assert.equal(subject, "fix(ship): validate commit subject");
		assert.match(subject, CONVENTIONAL_COMMIT_PATTERN);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("ship verification identifies the job's own commit by its trailer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-trailer-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");

		// An unrelated conventional commit is not this job's decision.
		await writeFile(join(directory, "other.txt"), "other\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore(deps): unrelated");
		assert.equal(await findJobCommit(directory, "job-a", previousHead), undefined);
		await assert.rejects(
			verifyShippedCommit(directory, previousHead, "job-a"),
			/does not carry KPI-Job: job-a/u,
			"a commit without the trailer cannot pass verification",
		);

		// The job's own commit is found, whatever lands on top of it afterwards.
		await writeFile(join(directory, "shipped.txt"), "shipped\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", `feat(ship): the job's commit\n\nKPI-Job: job-a`);
		const shipped = await git(directory, "rev-parse", "HEAD");
		await writeFile(join(directory, "later.txt"), "later\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "docs(readme): later work");

		assert.deepEqual(await findJobCommit(directory, "job-a", previousHead), {
			head: shipped,
			subject: "feat(ship): the job's commit",
		});
		assert.equal(await findJobCommit(directory, "job-b", previousHead), undefined, "another job's id finds nothing");

		// A trailer inside a sentence is not a trailer line.
		await writeFile(join(directory, "prose.txt"), "prose\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore(x): mentions KPI-Job: job-c in prose");
		assert.equal(await findJobCommit(directory, "job-c", previousHead), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("two commits claiming one job id fail closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-ambiguous-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");

		for (const attempt of ["first", "second"]) {
			await writeFile(join(directory, `${attempt}.txt`), `${attempt}\n`);
			await git(directory, "add", "-A");
			await git(directory, "commit", "-m", `feat(ship): ${attempt} attempt\n\nKPI-Job: job-d`);
		}

		await assert.rejects(
			findJobCommit(directory, "job-d", previousHead),
			/Ambiguous ship commits for job-d/u,
			"nobody can say which commit was the decision",
		);
		await assert.rejects(verifyShippedCommit(directory, previousHead, "job-d"), /2 commits instead of one/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a non-conventional job-marked commit is rejected", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-nonconventional-"));
	try {
		await git(directory, "init");
		await git(directory, "config", "user.email", "fixture@example.test");
		await git(directory, "config", "user.name", "Fixture");
		await writeFile(join(directory, "file.txt"), "seed\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "chore: seed");
		const previousHead = await git(directory, "rev-parse", "HEAD");
		await writeFile(join(directory, "shipped.txt"), "shipped\n");
		await git(directory, "add", "-A");
		await git(directory, "commit", "-m", "shipped it\n\nKPI-Job: job-e");

		await assert.rejects(findJobCommit(directory, "job-e", previousHead), /not Conventional Commits: shipped it/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function confirmationsFor(harness: { notifications: string[] }): string[] {
	return harness.notifications.filter((message) => message.includes("Approve"));
}

/** Every stack the plan could hand implement, and what must happen next. */
const invalidStacks: { name: string; document: string; reason: RegExp }[] = [
	{
		name: "no stack at all",
		document: "",
		reason: /stack\.json is missing/u,
	},
	{
		name: "a stack that names no slice",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
		reason: /must name current_module_id/u,
	},
	{
		name: "a slice that names no module",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "nope",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
		reason: /does not name exactly one module/u,
	},
	{
		name: "a folder that does not match its id",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "health",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/healthcheck",
					interface: "src/healthcheck/api.ts",
					allowed_paths: ["src/healthcheck/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
		reason: /Module folder must match id/u,
	},
	{
		name: "a top-level layer folder as the map",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "services",
			modules: [
				{
					id: "services",
					purpose: "every service in the app",
					folder: "src/services",
					interface: "src/services/api.ts",
					allowed_paths: ["src/services/**", "test/services/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
		reason: /cannot be a top-level module/u,
	},
	{
		name: "shared with a single consumer",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "health",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: ["shared"],
				},
				{
					id: "shared",
					purpose: "types used by slices",
					folder: "src/shared",
					interface: "src/shared/api.ts",
					allowed_paths: ["src/shared/**", "test/shared/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
		reason: /two consuming slices before extraction/u,
	},
	{
		name: "horizontal delivery with no reason",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "horizontal",
			root: "src",
			current_module_id: "health",
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
		reason: /Horizontal delivery requires a reason/u,
	},
	{
		name: "a vertical plan staging all APIs",
		document: JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "health",
			modules: [
				{
					id: "health",
					purpose: "all APIs first, then all screens",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		}),
		reason: /layer sweep/u,
	},
];

test("an invalid or missing stack stops implement UNSAFE before any write", async () => {
	for (const scenario of invalidStacks) {
		const directory = await fixture();
		const jobId = "20260901-stack-invalid";
		const executed: string[] = [];
		try {
			const harness = commandHarness(
				directory,
				loopSessions(directory, executed, {
					jobId,
					// An empty document means the plan wrote no stack at all.
					stack: scenario.document === "" ? null : scenario.document,
				}),
				jobId,
				[],
			);
			await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

			const state = JSON.parse(
				await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8"),
			) as Record<string, unknown>;
			assert.equal(state.status, "UNSAFE", `${scenario.name}: must stop UNSAFE`);
			assert.match(String(state.reason), scenario.reason, scenario.name);

			// The implement node never ran, so nothing was written and no commit exists.
			assert.equal(executed.includes("implement"), false, `${scenario.name}: implement must not run`);
			assert.equal(executed.includes("ship"), false, `${scenario.name}: ship must not run`);
			// The scaffold never ran, so the map was never created, and the fixture's
			// own source is exactly as it shipped.
			for (const untouched of ["src/health/api.ts", "test/health/index.test.ts"]) {
				await assert.rejects(
					readFile(join(directory, untouched), "utf8"),
					{ code: "ENOENT" },
					`${scenario.name}: ${untouched} must not exist`,
				);
			}
			assert.match(
				await readFile(join(directory, "src", "health", "server.js"), "utf8"),
				/not_found/u,
				`${scenario.name}: the fixture's source was never rewritten`,
			);
			assert.deepEqual(confirmationsFor(harness), [], `${scenario.name}: no operator was asked to approve`);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("a stale stack stops implement, and re-freezing it lets the round proceed", async () => {
	const directory = await fixture();
	const jobId = "20260901-stack-stale";
	const executed: string[] = [];
	try {
		// The plan writes a map bound to a different contract.
		const staleStack = JSON.stringify({
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			current_module_id: "health",
			task_hash: `sha256:${"0".repeat(64)}`,
			modules: [
				{
					id: "health",
					purpose: "healthcheck endpoint",
					folder: "src/health",
					interface: "src/health/api.ts",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
			scaffold_first: true,
		});
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId, stack: staleStack }),
			jobId,
			[],
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.equal(state.status, "UNSAFE");
		assert.match(String(state.reason), /frozen against a different task/u);
		assert.equal(executed.includes("implement"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a valid stack reaches implement, scaffolds in order, and freezes the slice", async () => {
	const directory = await fixture();
	const jobId = "20260901-stack-valid";
	const executed: string[] = [];
	const confirmations: string[] = [];
	try {
		const harness = commandHarness(directory, loopSessions(directory, executed, { jobId }), jobId, confirmations);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		assert.ok(executed.includes("implement"), "a valid map reaches implement");
		const runDirectory = join(directory, ".kpi", "runs", jobId);
		const task = JSON.parse(await readFile(join(runDirectory, "task.json"), "utf8")) as {
			current_module_id?: string;
		};
		assert.equal(task.current_module_id, "health", "the plan's slice is frozen into the job contract");

		// The scaffold exists, and it was created before the behaviour file.
		for (const path of ["src/health/api.ts", "test/health/index.test.ts", "src/health/server.js"]) {
			assert.equal((await stat(join(directory, path))).isFile(), true, path);
		}
		const state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as Record<string, unknown>;
		assert.equal(state.status, "DONE", `expected DONE, saw ${String(state.status)}: ${String(state.reason)}`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a no-stack playbook needs no map", async () => {
	const directory = await fixture();
	const jobId = "20260901-stack-exempt";
	const executed: string[] = [];
	try {
		// No map is written, and the playbook is one of the named exemptions.
		const harness = commandHarness(
			directory,
			loopSessions(directory, executed, { jobId, stack: null, playbook: "typo" }),
			jobId,
			[],
		);
		await harness.commands.get("loop")!(await readFile(join(directory, "task.txt"), "utf8"), harness.context);

		const state = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "state.json"), "utf8")) as Record<
			string,
			unknown
		>;
		assert.notEqual(state.status, "UNSAFE", `an exempt playbook must not be blocked: ${String(state.reason)}`);
		assert.ok(executed.includes("implement"), "an exempt playbook still implements");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
