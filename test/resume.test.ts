import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import { resumeLoop } from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import type { Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

function factory(executed: string[]): GraphAgentSessionFactory {
	let sessionId = 0;
	return async () => ({
		session: {
			sessionId: `resume-${sessionId++}`,
			async prompt(prompt: string) {
				executed.push(prompt.split("\n", 1)[0]);
			},
			getActiveToolNames() {
				return ["read"];
			},
			dispose() {},
		},
	});
}

test("restored checkpoint does not rerun completed plan and implement nodes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-resume-"));
	const graph: GraphDefinition = {
		schemaVersion: 2,
		id: "resume-check",
		entry: "plan",
		nodes: ["plan", "implement", "test"].map((id) => ({
			id,
			type: "agent" as const,
			prompt: id,
			context: { mode: "isolated" as const },
			tools: ["read"],
			readOnly: true,
		})),
		edges: [
			{ from: "plan", to: "implement" },
			{ from: "implement", to: "test" },
			{ from: "test", to: "__end__" },
		],
		limits: { maxSteps: 10, maxNodeRuns: 5, maxConcurrency: 1, maxCostUsd: 1, timeoutMs: 10_000 },
		policy: {
			allowNonInteractive: true,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: false,
			confirmMutatingNodes: false,
		},
	};
	try {
		const before: string[] = [];
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId: "resume-job",
			createAgentSession: factory(before),
		});
		await engine.runSuperstep();
		await engine.runSuperstep();
		engine.dispose();
		assert.deepEqual(before, ["plan", "implement"]);

		const after: string[] = [];
		const restored = await GraphEngine.restore(graph, {
			projectRoot: directory,
			jobId: "resume-job",
			createAgentSession: factory(after),
		});
		const result = await restored.runUntilPause();
		assert.equal(result.status, "completed");
		assert.deepEqual(after, ["test"]);
		restored.dispose();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("resuming an already-DONE job is idempotent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-ship-twice-"));
	const jobId = "done-job";
	const run = join(directory, ".kpi", "runs", jobId);
	const task: Task = {
		job_id: jobId,
		mode: "gated",
		goal: "done",
		nongoals: [],
		acceptance: [],
		constraints: ["Never push"],
		quality_gates: [],
		ac: { quality: "executable" },
	};
	try {
		await mkdir(run, { recursive: true });
		await writeFile(join(run, "task.json"), JSON.stringify(task));
		await writeFile(join(run, "state.json"), JSON.stringify({ status: "DONE" }));
		const context = { cwd: directory } as ExtensionCommandContext;
		assert.equal((await resumeLoop(jobId, context)).status, "DONE");
		assert.equal((await resumeLoop(jobId, context)).status, "DONE");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
