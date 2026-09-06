import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { WorkerLauncher } from "../packages/coding-agent/src/kpi/extensions/bus/launch.ts";
import { WorkerProtocol } from "../packages/coding-agent/src/kpi/extensions/bus/protocol.ts";
import {
	type LiveWorkerSession,
	liveWorkerSessions,
	registeredBuses,
	resetSessionsRegistry,
} from "../packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts";
import { BackgroundBus, createWorkerAdmission } from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
} from "../packages/coding-agent/src/kpi/extensions/graph/engine.ts";
import type { GraphDefinition } from "../packages/coding-agent/src/kpi/extensions/graph/schema.ts";
import { createReviewerJob, reviewerBusDependencies } from "./helpers/reviewer-bus.ts";

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
		limits: { maxConcurrency: 1 },
		policy: {
			allowNonInteractive: false,
			allowNonInteractiveMutations: false,
			confirmProjectGraph: true,
			confirmMutatingNodes: true,
		},
	};
}

async function jobRoot(jobId: string, directory?: string): Promise<{ directory: string; runDirectory: string }> {
	directory ??= await mkdtemp(join(tmpdir(), "k-pi-reviewer-"));
	const job = await createReviewerJob(directory, jobId);
	return { directory, runDirectory: job.directory };
}

async function disposeJobRoot(directory: string): Promise<void> {
	const outcomes = await Promise.allSettled(
		registeredBuses()
			.filter((bus) => bus.cwd === directory)
			.map((bus) => bus.stopAll()),
	);
	const failures = outcomes.filter((outcome) => outcome.status === "rejected");
	if (failures.length > 0)
		throw new AggregateError(
			failures.map((failure) => failure.reason),
			"reviewer fixture cleanup failed",
		);
	await rm(directory, { recursive: true, force: true });
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
		await disposeJobRoot(directory);
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
		assert.equal(tools.includes("bash"), false);
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
		await disposeJobRoot(directory);
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
		// Failing closed is a contract defect: the run parks for the operator with
		// the reason on record instead of reporting the transcript as a verdict.
		const state = await engine.runUntilPause();
		assert.equal(state.status, "paused");
		assert.equal(state.pause?.recovery, "contract");
		assert.match(state.pause?.reason ?? "", /receipt-backed|did not publish/u);
		assert.equal(state.nodes.review.status, "failed");
		assert.equal(state.values.review, undefined, "no verdict was committed");
	} finally {
		await disposeJobRoot(directory);
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
		await disposeJobRoot(directory);
	}
});

test("shared admission blocks a graph reviewer when parent bus already holds max workers", async () => {
	const jobId = "review-cap";
	const { directory } = await jobRoot(jobId);
	const admission = createWorkerAdmission({ maxWorkers: 2 });
	const ownedBuses: BackgroundBus[] = [];
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
				toWorker.destroy();
				toParent.destroy();
			},
		};
	};
	const parentRun = await jobRoot(`${jobId}-parent`, directory);
	const parent = new BackgroundBus(directory, parentRun.runDirectory, `${jobId}-parent`, {
		launcher: parentLauncher,
		isProcessAlive: (pid) => parentAlive.has(pid),
		admission,
		contractPollIntervalMs: 1,
		contractWaitTimeoutMs: 500,
		lockRetryMs: 2,
	});
	ownedBuses.push(parent);
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
		const state = await engine.runUntilPause();
		assert.equal(state.status, "paused");
		assert.equal(state.pause?.recovery, "contract");
		assert.match(state.pause?.reason ?? "", /Background worker limit is 2/u);

		await parent.stopAll();
		assert.equal(admission.counts().workers, 0);

		// Writer cap is global across bus instances. Fresh bus after stopAll.
		const parentAgainRun = await jobRoot(`${jobId}-parent-2`, directory);
		const parentAgain = new BackgroundBus(directory, parentAgainRun.runDirectory, `${jobId}-parent-2`, {
			launcher: parentLauncher,
			isProcessAlive: (pid) => parentAlive.has(pid),
			admission,
			contractPollIntervalMs: 1,
			lockRetryMs: 2,
		});
		ownedBuses.push(parentAgain);
		await parentAgain.spawn({ role: "implementer", prompt: "write-again" });
		const secondRun = await jobRoot(`${jobId}-other`, directory);
		const second = new BackgroundBus(directory, secondRun.runDirectory, `${jobId}-other`, {
			launcher: parentLauncher,
			isProcessAlive: (pid) => parentAlive.has(pid),
			admission,
			contractPollIntervalMs: 1,
			lockRetryMs: 2,
		});
		ownedBuses.push(second);
		await assert.rejects(second.spawn({ role: "arena", prompt: "also write" }), /writer worker is already live/u);
		await parentAgain.stopAll();
		await second.stopAll();
	} finally {
		try {
			await Promise.all(ownedBuses.map((bus) => bus.stopAll()));
		} finally {
			await disposeJobRoot(directory);
		}
	}
});

test("a graph reviewer remains addressable after its node settles until its host shuts down", async () => {
	const jobId = "review-live";
	const { directory } = await jobRoot(jobId);
	resetSessionsRegistry();
	const bus = reviewerBusDependencies();
	const seen: LiveWorkerSession[][] = [];
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

		const whileRunning = seen.find((sessions) => sessions.some((session) => session.node === "review")) ?? [];
		assert.equal(whileRunning.length, 1, "the worker was a live session while its node ran");
		assert.equal(whileRunning[0]?.jobId, jobId);
		assert.equal(whileRunning[0]?.role, "reviewer");
		assert.equal(whileRunning[0]?.node, "review");
		assert.equal(whileRunning[0]?.alive, true);

		assert.deepEqual(
			liveWorkerSessions().map((session) => session.agentId),
			[state.nodes.review.agentId],
		);
		await disposeJobRoot(directory);
		assert.deepEqual(liveWorkerSessions(), [], "host shutdown releases the persistent peer");
	} finally {
		await disposeJobRoot(directory);
		resetSessionsRegistry();
	}
});
