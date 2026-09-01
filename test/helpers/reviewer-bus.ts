import { PassThrough } from "node:stream";

import type {
	WorkerLaunch,
	WorkerLauncher,
	WorkerLaunchRequest,
} from "../../packages/coding-agent/src/kpi/extensions/bus/launch.ts";
import { WorkerProtocol } from "../../packages/coding-agent/src/kpi/extensions/bus/protocol.ts";
import {
	type BusDependencies,
	createWorkerAdmission,
} from "../../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import { mintContractPin, writeContract } from "../../packages/coding-agent/src/kpi/extensions/bus/write-contract.ts";

const defaultVerdict = {
	status: "PASS",
	approved: true,
	blockingIssues: [] as string[],
	nonBlockingIssues: [] as string[],
	evidence: ["evidence.json"],
	round: 1,
	output_fingerprint: `sha256:${"a".repeat(64)}`,
};

export function fakeReviewerLauncher(
	options: {
		/** When null, settle without publishing a receipt-backed verdict. */
		verdict?: Record<string, unknown> | null;
		verdicts?: Array<Record<string, unknown> | null>;
		onLaunch?: (request: WorkerLaunchRequest) => void;
		executed?: string[];
		transcript?: string;
	} = {},
): {
	launcher: WorkerLauncher;
	launches: WorkerLaunchRequest[];
	lastArgv: string[] | undefined;
	prompts: string[];
} {
	let attempt = 0;
	let nextPid = 17_000;
	const alive = new Set<number>();
	const launches: WorkerLaunchRequest[] = [];
	const prompts: string[] = [];
	let lastArgv: string[] | undefined;

	const launcher: WorkerLauncher = async (request) => {
		launches.push(request);
		options.onLaunch?.(request);
		options.executed?.push("review");
		const pid = nextPid++;
		alive.add(pid);
		const toWorker = new PassThrough();
		const toParent = new PassThrough();
		const protocol = new WorkerProtocol({ stdin: toWorker, stdout: toParent });
		const respond = (record: Record<string, unknown>): void => {
			toParent.write(`${JSON.stringify(record)}\n`);
		};

		toWorker.on("data", (chunk: Buffer) => {
			void (async () => {
				for (const line of chunk
					.toString("utf8")
					.split("\n")
					.filter((entry) => entry.length > 0)) {
					const record = JSON.parse(line) as Record<string, unknown>;
					if (typeof record.id === "string" && typeof record.type === "string") {
						respond({
							id: record.id,
							type: "response",
							command: record.type,
							success: true,
						});
					}
					if (record.type === "prompt" && typeof record.message === "string") {
						prompts.push(record.message);
						let payload: Record<string, unknown> | null;
						if (options.verdicts !== undefined) {
							payload = options.verdicts[attempt] ?? null;
						} else if (Object.hasOwn(options, "verdict")) {
							payload = options.verdict ?? null;
						} else {
							payload = { ...defaultVerdict };
						}
						attempt += 1;
						if (payload !== null) {
							const capabilityId = request.descriptor.capabilityId;
							if (capabilityId === undefined) {
								throw new Error("reviewer fixture expected a capability id");
							}
							const pin = mintContractPin({
								agentId: request.descriptor.agentId,
								jobId: request.descriptor.jobId,
								role: request.descriptor.role,
								runDirectory: request.descriptor.runDirectory,
								capabilityId,
							});
							await writeContract({
								pin,
								agentId: request.descriptor.agentId,
								jobId: request.descriptor.jobId,
								role: request.descriptor.role,
								requestedPath: "verdict.json",
								payload,
							});
						}
						respond({
							type: "message_end",
							message: {
								role: "assistant",
								content: [
									{
										type: "text",
										text:
											options.transcript ??
											'{"status":"PASS","approved":true,"blockingIssues":[],"nonBlockingIssues":[],"evidence":[],"round":1,"output_fingerprint":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}',
									},
								],
							},
						});
						respond({ type: "agent_settled" });
					}
				}
			})();
		});

		const launch: WorkerLaunch = {
			pid,
			argv: ["node", "cli.js", "--mode", "rpc", "--tools", [...request.tools].join(",")],
			protocol,
			isAlive: () => alive.has(pid),
			stop: async () => {
				alive.delete(pid);
				protocol.close();
			},
		};
		lastArgv = launch.argv;
		return launch;
	};

	return {
		launcher,
		launches,
		prompts,
		get lastArgv() {
			return lastArgv;
		},
	};
}

export function reviewerBusDependencies(options: Parameters<typeof fakeReviewerLauncher>[0] = {}): BusDependencies & {
	launches: WorkerLaunchRequest[];
	lastArgv: () => string[] | undefined;
	prompts: string[];
} {
	const fake = fakeReviewerLauncher(options);
	return {
		launcher: fake.launcher,
		isProcessAlive: () => true,
		contractPollIntervalMs: 1,
		contractWaitTimeoutMs: 2_000,
		lockRetryMs: 2,
		lockTimeoutMs: 2_000,
		admission: createWorkerAdmission(),
		launches: fake.launches,
		prompts: fake.prompts,
		lastArgv: () => fake.lastArgv,
	};
}
