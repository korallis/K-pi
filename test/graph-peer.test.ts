import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getOrCreateBackgroundBus } from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { contractHash, createJob, readTaskForJob } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

test("an idle native graph peer receives a direct message without rerunning its task or changing intent", {
	timeout: 20000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-native-peer-"));
	const task = {
		job_id: "peer-job",
		mode: "gated" as const,
		goal: "Inspect the candidate",
		nongoals: [],
		acceptance: [],
		constraints: [],
		quality_gates: [],
		ac: { quality: "narrative" as const },
	};
	const job = await createJob(root, task);
	const observed = Promise.withResolvers<string>();
	const prompts: string[] = [];
	let creations = 0;
	const factory: GraphAgentSessionFactory = async (options) => {
		creations++;
		return {
			session: {
				sessionId: options.sessionManager!.getSessionId(),
				getActiveToolNames: () => options.tools ?? [],
				dispose() {},
				async prompt(text) {
					prompts.push(text);
					if (text.startsWith("Peer message")) observed.resolve(text);
				},
			},
		};
	};
	const definition: GraphDefinition = {
		schemaVersion: 2,
		id: "peer-runtime",
		entry: "reader",
		intentHash: contractHash(task),
		limits: { maxConcurrency: 2 },
		policy: {
			allowNonInteractive: false,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: true,
			confirmMutatingNodes: true,
		},
		nodes: [
			{
				id: "reader",
				type: "agent",
				role: "researcher",
				prompt: "Inspect",
				readOnly: true,
				tools: ["read"],
				context: { mode: "thread", threadKey: "reader" },
			},
			{ id: "wait", type: "human", title: "Operator", question: "Continue?", statePath: "operator.approved" },
		],
		edges: [{ from: "reader", to: "wait" }],
	};
	const engine = new GraphEngine(definition, { projectRoot: root, jobId: task.job_id, createAgentSession: factory });
	const bus = getOrCreateBackgroundBus(root, job.directory, job.jobId);
	try {
		await engine.runUntilPause();
		assert.equal(engine.state.status, "interrupted");
		const identity = engine.state.nodes.reader.agentId!;
		const sessionId = engine.state.nodes.reader.sessionId;
		const runtime = await bus.peers();
		const sent = await runtime.send("host", {
			to: identity,
			text: "Inspect the actual regression, not the previous report",
			id: "peer-wake",
		});
		const delivered = await observed.promise;
		assert.equal(sent.message.recipients[0], identity);
		assert.match(delivered, /Inspect the actual regression, not the previous report/);
		assert.equal(prompts.length, 2);
		assert.equal(creations, 1);
		assert.equal(engine.state.nodes.reader.runs, 1);
		assert.equal(engine.state.nodes.reader.sessionId, sessionId);
		assert.equal(contractHash(await readTaskForJob(root, job.jobId)), contractHash(task));
	} finally {
		engine.dispose();
		await bus.stopAll();
		await rm(root, { recursive: true, force: true });
	}
});
