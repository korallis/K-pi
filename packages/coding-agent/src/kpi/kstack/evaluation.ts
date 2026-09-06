import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type EngineeringObserved,
	engineeringModelSlug,
	engineeringRegistryDirectory,
	recordEngineeringOutcome,
} from "./observations.ts";
import { type EngineeringModelRequest, resolveEngineeringModel } from "./routing.ts";

export interface EngineeringEvaluationTask {
	id: string;
	role: string;
	taskKind?: string;
	prompt: string;
	/** Explicit workspace for the task and its deterministic checker. Never derived from model output. */
	cwd: string;
	verify: { command: string; args: string[] };
}

export interface EngineeringEvaluationInvocation {
	/** Actual adapter identity, including any model switch. Not text claimed by the model. */
	model: Model<Api>;
	output: string;
	observed?: Pick<EngineeringObserved, "toolFailures" | "toolCalls" | "contextTokens">;
}

export type EngineeringEvaluationInvoker = (input: {
	model: Model<Api>;
	task: EngineeringEvaluationTask;
	outputDirectory: string;
}) => Promise<EngineeringEvaluationInvocation>;

export interface EngineeringEvaluationResult {
	taskId: string;
	requestedModel: string;
	actualModel?: string;
	evidenceRef: string;
	verification?: "passed" | "failed";
	error?: string;
}

interface CommandEvidence {
	command: string;
	args: string[];
	cwd: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** Base64 preserves raw bytes, including non-UTF8 output. */
	stdoutBase64: string;
	stderrBase64: string;
	error?: string;
}

async function executeChecker(task: EngineeringEvaluationTask, outputPath: string): Promise<CommandEvidence> {
	const { promise, resolve: done } = Promise.withResolvers<CommandEvidence>();
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let error: string | undefined;
	const child = spawn(task.verify.command, task.verify.args, {
		cwd: task.cwd,
		shell: false,
		env: { ...process.env, NODE_TEST_CONTEXT: undefined, KPI_EVAL_OUTPUT: outputPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.on("error", (failure) => {
		error = failure.message;
	});
	child.on("close", (exitCode, signal) =>
		done({
			command: task.verify.command,
			args: task.verify.args,
			cwd: task.cwd,
			exitCode,
			signal,
			stdoutBase64: Buffer.concat(stdout).toString("base64"),
			stderrBase64: Buffer.concat(stderr).toString("base64"),
			...(error ? { error } : {}),
		}),
	);
	return promise;
}

/**
 * Host-only API: caller supplies the existing runtime adapter and operator-configured tasks/checker argv.
 * No SDK, testimony-based verdict, or implicit arena/fanout. Each task/model pair runs sequentially.
 * KPI_EVAL_OUTPUT names the raw response file consumed by the deterministic checker.
 */
export async function runEngineeringEvaluations(
	request: Omit<EngineeringModelRequest, "role"> & {
		models: string[];
		tasks: EngineeringEvaluationTask[];
		invoke: EngineeringEvaluationInvoker;
	},
): Promise<EngineeringEvaluationResult[]> {
	if (!request.projectRoot) throw new Error("Local engineering evaluations require projectRoot");
	if (typeof request.invoke !== "function")
		throw new Error("Local engineering evaluations require a real runtime invoker");
	if (!request.models.length || !request.tasks.length)
		throw new Error("Configure representative tasks and exact available model identities");
	const available = await request.modelRuntime.getAvailable();
	const results: EngineeringEvaluationResult[] = [];
	for (const task of request.tasks) {
		if (
			!task.id.trim() ||
			!task.role.trim() ||
			!task.prompt.trim() ||
			!task.cwd ||
			!task.verify.command ||
			!Array.isArray(task.verify.args)
		)
			throw new Error("Invalid representative task/checker configuration");
		const scopedTask = { ...task, cwd: resolve(request.projectRoot, task.cwd) };
		for (const requestedModel of [...new Set(request.models)]) {
			const model = available.find((candidate) => engineeringModelSlug(candidate) === requestedModel);
			if (!model) throw new Error(`Evaluation model ${requestedModel} is unavailable or unauthenticated`);
			// Reuse routing's local/cloud boundary, not a second authorization policy.
			await resolveEngineeringModel({
				...request,
				role: task.role,
				taskKind: task.taskKind,
				modelRuntime: { getAvailable: async () => [model] },
			});
			const id = randomUUID();
			const directory = join(engineeringRegistryDirectory(request.projectRoot), "evaluations", id);
			await mkdir(directory, { recursive: true });
			const evidenceRef = join(directory, "evidence.json");
			const outputPath = join(directory, "response.txt");
			const result: EngineeringEvaluationResult = { taskId: task.id, requestedModel, evidenceRef };
			const startedAt = new Date().toISOString();
			const start = performance.now();
			let invocation: EngineeringEvaluationInvocation | undefined;
			let command: CommandEvidence | undefined;
			let latencyMs: number | undefined;
			try {
				invocation = await request.invoke({ model, task: scopedTask, outputDirectory: directory });
				latencyMs = performance.now() - start;
				result.actualModel = engineeringModelSlug(invocation.model);
				await writeFile(outputPath, invocation.output, { flag: "wx", mode: 0o600 });
				if (result.actualModel !== requestedModel)
					throw new Error(
						`Adapter switched to ${result.actualModel}; no measurement attributed to requested model ${requestedModel}`,
					);
				command = await executeChecker(scopedTask, outputPath);
				if (command.error) result.error = command.error;
				else result.verification = command.exitCode === 0 && command.signal === null ? "passed" : "failed";
			} catch (error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			await writeFile(
				evidenceRef,
				`${JSON.stringify({
					version: 1,
					id,
					startedAt,
					task: scopedTask,
					...result,
					invocation: invocation
						? {
								model: result.actualModel,
								output: invocation.output,
								observed: invocation.observed,
							}
						: undefined,
					latencyMs,
					command,
				})}\n`,
				{ flag: "wx", mode: 0o600 },
			);
			if (result.verification && invocation)
				await recordEngineeringOutcome({
					projectRoot: request.projectRoot,
					role: task.role,
					model: invocation.model,
					taskId: `${task.id}/${id}`,
					taskKind: task.taskKind,
					evidenceRef,
					source: "local-evaluation",
					verification: result.verification,
					latencyMs,
					toolCalls: invocation.observed?.toolCalls,
					toolFailures: invocation.observed?.toolFailures,
					contextTokens: invocation.observed?.contextTokens,
				});
			results.push(result);
		}
	}
	return results;
}
