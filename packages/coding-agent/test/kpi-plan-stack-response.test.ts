import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { afterEach, describe, expect, it } from "vitest";

import { type GraphAgentSession, GraphEngine } from "../src/kpi/extensions/graph/engine.ts";
import type { Task } from "../src/kpi/extensions/run-store.ts";
import { freezeCurrentSlice, readDuneStack } from "../src/kpi/extensions/stack.ts";

const healthStack = {
	version: 1 as const,
	shape: "dune" as const,
	delivery: "vertical" as const,
	root: "src",
	scaffold_first: true as const,
	current_module_id: "health",
	modules: [
		{
			id: "health",
			purpose: "HTTP healthcheck endpoint and its acceptance tests",
			folder: "src/health",
			interface: "src/health/server.js",
			allowed_paths: ["src/health/**", "test/health/**"],
			depends_on: [] as string[],
		},
	],
};

function taskFor(jobId: string): Task {
	return {
		job_id: jobId,
		mode: "autopilot",
		goal: "healthcheck",
		nongoals: [],
		acceptance: [
			{
				id: "AC-01",
				statement: "cmd npm test exits 0; writes only src/health/** and test/health/**",
				required: true,
				check: { kind: "command", cmd: "npm test", expect: { exit: 0 } },
				bounds: { write_allow: ["src/health/**", "test/health/**"] },
			},
		],
		constraints: [],
		quality_gates: ["npm test"],
		ac: { quality: "executable" },
		dependency_baseline: [],
	} as Task;
}

function seedRun(root: string, jobId: string): string {
	const runDir = join(root, ".kpi", "runs", jobId);
	mkdirSync(runDir, { recursive: true });
	mkdirSync(join(root, ".kpi", "schemas"), { recursive: true });
	writeFileSync(
		join(root, ".kpi", "schemas", "stack.schema.json"),
		readFileSync(join(__dirname, "../src/kpi/schemas/stack.schema.json"), "utf8"),
	);
	writeFileSync(join(runDir, "task.json"), `${JSON.stringify(taskFor(jobId), null, 2)}\n`);
	writeFileSync(join(runDir, "context.md"), "# ctx\n");
	return runDir;
}

function planGraph() {
	return {
		schemaVersion: 2 as const,
		id: "plan-only",
		entry: "plan",
		policy: {
			onHumanDeny: "revise" as const,
			allowNonInteractive: true,
			allowNonInteractiveMutations: true,
			confirmProjectGraph: true,
			confirmMutatingNodes: false,
		},
		limits: { maxSteps: 4, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, timeoutMs: 60_000 },
		nodes: [
			{
				id: "plan",
				type: "agent" as const,
				prompt: "Produce stack.json",
				context: { mode: "isolated" as const },
				tools: ["read", "grep", "find", "ls"],
				readOnly: true,
				response: {
					path: "stack.json",
					schema: "stack.schema.json",
					retries: 0,
					state: {},
				},
			},
		],
		edges: [] as { from: string; to: string }[],
	};
}

function mockSession(body: unknown): GraphAgentSession {
	return {
		sessionId: "s1",
		prompt: async () => {},
		getLastAssistantText: () => JSON.stringify(body),
		getActiveToolNames: () => ["read", "grep", "find", "ls"],
		dispose: () => {},
	};
}

describe("plan stack.json response contract", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("writes plan-produced stack.json into the run and freezeCurrentSlice accepts it", async () => {
		const root = mkdtempSync(join(tmpdir(), "kpi-plan-stack-"));
		dirs.push(root);
		mkdirSync(join(root, "src", "health"), { recursive: true });
		mkdirSync(join(root, "test", "health"), { recursive: true });
		writeFileSync(join(root, "src", "health", "server.js"), "export {};\n");
		const jobId = "job-plan-stack-1";
		const runDir = seedRun(root, jobId);
		const task = taskFor(jobId);

		const engine = new GraphEngine(planGraph() as never, {
			projectRoot: root,
			jobId,
			createAgentSession: async () => ({ session: mockSession(healthStack) }),
		});

		let state = engine.state;
		for (let i = 0; i < 4 && state.status === "running"; i++) {
			state = await engine.runSuperstep();
		}

		expect(state.status).toBe("completed");
		const written = JSON.parse(readFileSync(join(runDir, "stack.json"), "utf8"));
		expect(written.current_module_id).toBe("health");
		expect(written.shape).toBe("dune");

		const frozen = await freezeCurrentSlice(root, runDir, task);
		expect(frozen.module.id).toBe("health");
		expect(frozen.module.folder).toBe("src/health");
	});

	it("refuses implement freeze when stack.json is missing with the Dune reason", async () => {
		const root = mkdtempSync(join(tmpdir(), "kpi-no-stack-"));
		dirs.push(root);
		const runDir = join(root, ".kpi", "runs", "job-missing");
		mkdirSync(runDir, { recursive: true });
		const task = taskFor("job-missing");
		writeFileSync(join(runDir, "task.json"), `${JSON.stringify(task, null, 2)}\n`);

		await expect(freezeCurrentSlice(root, runDir, task)).rejects.toThrow(
			/stack\.json is missing; implement has no frozen map to read/,
		);
		await expect(readDuneStack(runDir)).rejects.toThrow(/stack\.json is missing/);
	});

	it("fails the plan node when the response fails Dune semantics", async () => {
		const root = mkdtempSync(join(tmpdir(), "kpi-bad-stack-"));
		dirs.push(root);
		const jobId = "job-bad-stack";
		seedRun(root, jobId);

		const bad = {
			...healthStack,
			current_module_id: "api",
			modules: [
				{
					id: "api",
					purpose: "all the APIs for everything",
					folder: "src/api",
					interface: "src/api/index.ts",
					allowed_paths: ["src/api/**", "test/api/**"],
					depends_on: [] as string[],
				},
			],
		};

		const engine = new GraphEngine(planGraph() as never, {
			projectRoot: root,
			jobId,
			createAgentSession: async () => ({ session: mockSession(bad) }),
		});

		await expect(engine.runSuperstep()).rejects.toThrow(/Layer folder|failed response validation/i);
		// Must not invent a stack.json on failed validation
		expect(() => readFileSync(join(root, ".kpi", "runs", jobId, "stack.json"), "utf8")).toThrow();
	});
});
