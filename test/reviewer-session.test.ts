import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { WorkerLauncher } from "../packages/coding-agent/src/kpi/extensions/bus/launch.ts";
import { WorkerProtocol } from "../packages/coding-agent/src/kpi/extensions/bus/protocol.ts";
import {
	liveWorkerSessions,
	resetSessionsRegistry,
} from "../packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts";
import { BackgroundBus, createWorkerAdmission } from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
	GraphNodeContractError,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { reviewerBusDependencies } from "./helpers/reviewer-bus.ts";

const validVerdict = {
	status: "PASS",
	approved: true,
	blockingIssues: [],
	nonBlockingIssues: [],
	evidence: ["evidence.json"],
	round: 1,
	output_fingerprint: `sha256:${"a".repeat(64)}`,
} as const;

function reviewGraph(): GraphDefinition {
	return {
		schemaVersion: 2,
		id: "review-worker",
		entry: "review",
		nodes: [
			{
				id: "review",
				type: "agent",
				prompt: "Apply the isolated-review skill. Publish verdict via write_contract.",
				context: { mode: "isolated" },
				tools: ["read", "grep", "find", "ls"],
				readOnly: true,
				workerRole: "reviewer",
				response: {
					path: "verdict.json",
					schema: "verdict.schema.json",
					retries: 0,
					state: {
						"review.approved": "approved",
						"review.status": "status",
						"review.output_fingerprint": "output_fingerprint",
					},
				},
			},
			{
				id: "implement",
				type: "agent",
				prompt: "Apply the tdd-cycle skill.",
				context: { mode: "isolated" },
				tools: ["read", "write", "edit"],
				readOnly: false,
			},
		],
		edges: [
			{ from: "review", to: "__end__" },
			{ from: "implement", to: "__end__" },
		],
		limits: {
			maxSteps: 4,
			maxNodeRuns: 4,
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
}

async function jobRoot(jobId: string): Promise<{ directory: string; runDirectory: string }> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-reviewer-"));
	const runDirectory = join(directory, ".kpi", "runs", jobId);
	await mkdir(runDirectory, { recursive: true });
	await writeFile(
		join(runDirectory, "task.json"),
		`${JSON.stringify(
			{
				job_id: jobId,
				goal: "review",
				mode: "gated",
				quality_gates: ["npm test"],
			},
			null,
			2,
		)}\n`,
	);
	return { directory, runDirectory };
}

test("fake reviewer accepts the prompt before settlement and parent requires a valid verdict", async () => {
	const jobId = "review-accept";
	const { directory } = await jobRoot(jobId);
	const accepted: string[] = [];
	const bus = reviewerBusDependencies({
		onLaunch: () => accepted.push("launched"),
	});
	try {
		const engine = new GraphEngine(reviewGraph(), {
			projectRoot: directory,
			jobId,
			busDependencies: bus,
		});
		const state = await engine.runUntilPause();
		assert.equal(state.status, "completed");
		assert.deepEqual(state.values.review, {
			approved: true,
			status: "PASS",
			output_fingerprint: validVerdict.output_fingerprint,
		});
		assert.equal(bus.launches.length, 1);
		assert.ok(accepted.includes("launched"));
		const initialPrompt = bus.prompts[0] ?? "";
		assert.match(initialPrompt, /write_contract/u);
		assert.match(initialPrompt, /verdict\.json/u);
		assert.doesNotMatch(initialPrompt, /graph engine writes/u);
		assert.doesNotMatch(initialPrompt, /Return only JSON/u);
		const onDisk = JSON.parse(await readFile(join(directory, ".kpi", "runs", jobId, "verdict.json"), "utf8"));
		assert.equal(onDisk.status, "PASS");
		assert.equal(state.nodes.review?.agentId?.startsWith("reviewer-"), true);
		assert.match(state.nodes.review?.sessionId ?? "", /reviewer-.*\.jsonl$/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reviewer argv and tools have no write or edit", async () => {
	const jobId = "review-tools";
	const { directory } = await jobRoot(jobId);
	const bus = reviewerBusDependencies();
	try {
		const engine = new GraphEngine(reviewGraph(), {
			projectRoot: directory,
			jobId,
			busDependencies: bus,
		});
		await engine.runUntilPause();
		const tools = bus.launches[0]!.tools;
		assert.ok(tools.includes("write_contract"));
		assert.ok(tools.includes("read"));
		assert.ok(tools.includes("bash"));
		assert.equal(tools.includes("write"), false);
		assert.equal(tools.includes("edit"), false);
		const argv = bus.lastArgv() ?? [];
		const toolsArg = argv.find(
			(part) => part.includes("write") || part.includes("edit") || part.includes("write_contract"),
		);
		assert.ok(toolsArg !== undefined);
		assert.match(toolsArg!, /write_contract/u);
		assert.doesNotMatch(toolsArg!, /(^|,)(write|edit)(,|$)/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("transcript saying PASS without a receipt-backed verdict fails closed", async () => {
	const jobId = "review-prose";
	const { directory } = await jobRoot(jobId);
	const bus = reviewerBusDependencies({
		verdict: null,
		transcript: JSON.stringify(validVerdict),
	});
	try {
		const engine = new GraphEngine(reviewGraph(), {
			projectRoot: directory,
			jobId,
			busDependencies: bus,
		});
		await assert.rejects(
			() => engine.runUntilPause(),
			(error: unknown) => {
				assert.ok(
					error instanceof GraphNodeContractError ||
						(error instanceof Error && /receipt-backed|did not publish/u.test(error.message)),
				);
				return true;
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("implementer and reviewer session ids differ and lineage is recorded", async () => {
	const jobId = "review-lineage";
	const { directory } = await jobRoot(jobId);
	const bus = reviewerBusDependencies();
	let implementSessionId = "";
	const factory: GraphAgentSessionFactory = async () => ({
		session: {
			sessionId: "fixture-implementer-session",
			async prompt() {
				implementSessionId = "fixture-implementer-session";
			},
			getActiveToolNames: () => ["read", "write", "edit"],
			dispose() {},
		},
	});
	try {
		const graph = reviewGraph();
		graph.entry = "implement";
		graph.edges = [
			{ from: "implement", to: "review" },
			{ from: "review", to: "__end__" },
		];
		const engine = new GraphEngine(graph, {
			projectRoot: directory,
			jobId,
			createAgentSession: factory,
			busDependencies: bus,
		});
		const state = await engine.runUntilPause();
		assert.equal(state.status, "completed");
		assert.equal(implementSessionId, "fixture-implementer-session");
		assert.equal(state.nodes.implement?.sessionId, "fixture-implementer-session");
		assert.notEqual(state.nodes.review?.sessionId, state.nodes.implement?.sessionId);
		assert.ok(state.nodes.review?.agentId?.startsWith("reviewer-"));
		assert.match(state.nodes.review?.sessionId ?? "", /agents[/\\]reviewer-.*\.jsonl$/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared admission blocks a graph reviewer when parent bus already holds max workers", async () => {
	const jobId = "review-cap";
	const { directory, runDirectory } = await jobRoot(jobId);
	const admission = createWorkerAdmission();
	const parentAlive = new Set<number>();
	let nextPid = 40_000;
	const parentLauncher: WorkerLauncher = async (request) => {
		const pid = nextPid++;
		parentAlive.add(pid);
		const toWorker = new PassThrough();
		const toParent = new PassThrough();
		const protocol = new WorkerProtocol({ stdin: toWorker, stdout: toParent });
		toWorker.on("data", (chunk: Buffer) => {
			for (const line of chunk
				.toString("utf8")
				.split("\n")
				.filter((entry) => entry.length > 0)) {
				const record = JSON.parse(line) as Record<string, unknown>;
				if (typeof record.id === "string") {
					toParent.write(
						`${JSON.stringify({ id: record.id, type: "response", command: record.type, success: true })}\n`,
					);
				}
			}
		});
		return {
			pid,
			argv: ["node", "cli.js", "--mode", "rpc", "--tools", request.tools.join(",")],
			protocol,
			isAlive: () => parentAlive.has(pid),
			stop: async () => {
				parentAlive.delete(pid);
				protocol.close();
			},
		};
	};
	const parent = new BackgroundBus(directory, runDirectory, `${jobId}-parent`, {
		launcher: parentLauncher,
		isProcessAlive: (pid) => parentAlive.has(pid),
		admission,
		contractPollIntervalMs: 1,
		contractWaitTimeoutMs: 500,
		lockRetryMs: 2,
	});
	const bus = reviewerBusDependencies();
	bus.admission = admission;
	try {
		await parent.spawn({ role: "implementer", prompt: "write" });
		await parent.spawn({ role: "explorer", prompt: "look" });
		assert.equal(admission.counts().workers, 2);
		assert.equal(admission.counts().writers, 1);

		const engine = new GraphEngine(reviewGraph(), {
			projectRoot: directory,
			jobId,
			busDependencies: bus,
		});
		await assert.rejects(() => engine.runUntilPause(), /Background worker limit is 2/u);

		await parent.stopAll();
		assert.equal(admission.counts().workers, 0);

		// Writer cap is global across bus instances. Fresh bus after stopAll.
		const parentAgain = new BackgroundBus(directory, runDirectory, `${jobId}-parent-2`, {
			launcher: parentLauncher,
			isProcessAlive: (pid) => parentAlive.has(pid),
			admission,
			contractPollIntervalMs: 1,
			lockRetryMs: 2,
		});
		await parentAgain.spawn({ role: "implementer", prompt: "write-again" });
		const second = new BackgroundBus(directory, runDirectory, `${jobId}-other`, {
			launcher: parentLauncher,
			isProcessAlive: (pid) => parentAlive.has(pid),
			admission,
			contractPollIntervalMs: 1,
			lockRetryMs: 2,
		});
		await assert.rejects(second.spawn({ role: "arena", prompt: "also write" }), /writer worker is already live/u);
		await parentAgain.stopAll();
		await second.stopAll();
	} finally {
		await parent.stopAll().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

test("a graph reviewer worker is a live worker session while its node runs and is gone after", async () => {
	const jobId = "review-live";
	const { directory } = await jobRoot(jobId);
	resetSessionsRegistry();
	const bus = reviewerBusDependencies();
	const seen: ReturnType<typeof liveWorkerSessions>[] = [];
	try {
		const engine = new GraphEngine(reviewGraph(), {
			projectRoot: directory,
			jobId,
			busDependencies: bus,
			onSessionsChange: () => {
				seen.push(liveWorkerSessions());
			},
		});
		const state = await engine.runUntilPause();
		assert.equal(state.status, "completed");

		assert.ok(seen.length >= 2, "the engine says when the worker session registers and releases");
		const whileRunning = seen[0] ?? [];
		assert.equal(whileRunning.length, 1, "the worker was a live session for the duration of its node");
		assert.equal(whileRunning[0]?.jobId, jobId);
		assert.equal(whileRunning[0]?.role, "reviewer");
		assert.equal(whileRunning[0]?.node, "review");
		assert.equal(whileRunning[0]?.alive, true);

		assert.equal(liveWorkerSessions().length, 0, "the bus is released once the node settles");
	} finally {
		resetSessionsRegistry();
		await rm(directory, { recursive: true, force: true });
	}
});
