import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEvent,
} from "../../../core/extensions/types.ts";

import { readActiveJob, readTaskForJob } from "../run-store.ts";
import { assertClaimInModule, canonicalProjectPath, freezeCurrentSlice, stackRequiredFor } from "../stack.ts";
import { appendBusDenial } from "./denials.ts";
import {
	authorizeWorkerTool,
	hasWorkerDescriptor,
	requireWorkerIdentity,
	resolveWorkerIdentity,
	type WorkerIdentity,
} from "./identity.ts";
import { claimLease, defaultIsProcessAlive, type LeaseDependencies, releaseLease } from "./leases.ts";
import { setLiveWorkerCountProvider } from "./live-snapshot.ts";
import {
	hasTestShellOnly,
	isWorkerRole,
	isWriterToolSet,
	MUTATION_TOOLS,
	resolveRoleTools,
	WORKER_ROLES,
	type WorkerRole,
} from "./roles.ts";
import { BackgroundBus, type BusDependencies, MAX_LIVE_WORKERS, MAX_LIVE_WRITERS } from "./spawn.ts";
import { mintContractPin, writeContract } from "./write-contract.ts";

/**
 * Parent tools that mutate the tree, directly or through a shell.
 *
 * Every one of them is denied while a writer worker holds the slot.
 */
const PARENT_WRITER_TOOLS = new Set(["write", "edit", "apply_patch", "multi_edit", "bash", "powershell"]);

/** Bus surfaces a worker may not reach: they belong to the parent session. */
export interface BusRegistrationOptions extends BusDependencies {
	/** The environment to read the worker descriptor from. Injected by tests. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Registers the bus for whichever side of it this process is.
 *
 * A worker and its parent load the same extension, so the boundary cannot be a
 * convention about who calls what: it is which tools exist here at all. A parent
 * gets the tools that manage workers; a worker gets the tools that act as one,
 * and takes its identity from the environment it was launched with rather than
 * from an argument, because an argument is something a model can choose.
 */
export function registerBackgroundBus(pi: ExtensionAPI, options: BusRegistrationOptions = {}): void {
	if (hasWorkerDescriptor(options.env)) {
		registerWorkerTools(pi, options);
		return;
	}
	registerParentTools(pi, options);
}

function leaseDependenciesFrom(options: BusRegistrationOptions): LeaseDependencies {
	return {
		now: options.now,
		isProcessAlive: options.isProcessAlive,
		sleep: options.sleep,
		lockTimeoutMs: options.lockTimeoutMs,
		lockStaleMs: options.lockStaleMs,
		lockRetryMs: options.lockRetryMs,
	};
}

/**
 * The canonical lease key for a path, decided by RP-11's own predicate.
 *
 * The key is the repository-relative path the bytes land on, so `src/a/x`,
 * `./src/a/x`, an absolute path inside the root and a symlink alias are one
 * lease rather than four. Keying by the caller's spelling would let a second
 * worker claim the same file by writing its name differently.
 */
async function canonicalClaimKey(cwd: string, jobId: string, runDirectory: string, path: string): Promise<string> {
	const task = await readTaskForJob(cwd, jobId);
	if (stackRequiredFor(task)) {
		// The module boundary on top of the canonical key, and it returns that key.
		const { module } = await freezeCurrentSlice(cwd, runDirectory, task);
		return assertClaimInModule(cwd, path, module);
	}
	// A stackless playbook - typo, unslop, comment-strip - has no module to
	// resolve against, but path identity does not depend on one. Keying by the
	// caller's spelling here would let exactly those jobs hand out two leases for
	// one file, which is the same defect the module path already closed.
	return canonicalProjectPath(cwd, path);
}

/**
 * Tools that exist only inside a worker process.
 *
 * Each one derives its whole identity from the validated startup descriptor, so
 * there is no `agent_id` parameter to forge, and the parent's in-memory worker
 * table - which does not exist in this process - is not consulted.
 */
function registerWorkerTools(pi: ExtensionAPI, options: BusRegistrationOptions): void {
	const leaseDependencies = leaseDependenciesFrom(options);
	const identityFor = (cwd: string): Promise<WorkerIdentity> => requireWorkerIdentity(cwd, options.env);

	if (typeof pi.registerTool === "function") {
		pi.registerTool(
			defineTool({
				name: "write_contract",
				label: "Write Contract",
				description: "Publish this worker's one declared run-contract file after schema validation",
				parameters: Type.Object({
					path: Type.String(),
					content: Type.Object({}, { additionalProperties: true }),
				}),
				async execute(_id, params, _signal, _update, context) {
					const identity = await identityFor(context.cwd);
					authorizeWorkerTool(identity, "write_contract");
					const pin = mintContractPin({
						agentId: identity.agentId,
						jobId: identity.jobId,
						role: identity.role,
						runDirectory: identity.runDirectory,
						capabilityId: identity.capabilityId ?? "",
					});
					const result = await writeContract({
						pin,
						agentId: identity.agentId,
						jobId: identity.jobId,
						role: identity.role,
						requestedPath: params.path,
						payload: params.content,
						now: options.now,
					});
					// The publication id identifies this publication; the capability id
					// that authorised it is never returned.
					const details = {
						path: result.path,
						agent_id: identity.agentId,
						publication_id: result.receipt.publication_id,
						content_sha256: result.receipt.content_sha256,
					};
					return { content: [{ type: "text", text: `published ${result.path}` }], details };
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "claim_path",
				label: "Claim Path",
				description: "Acquire an exclusive same-tree path lease inside this job's frozen slice",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_id, params, _signal, _update, context) {
					const identity = await identityFor(context.cwd);
					authorizeWorkerTool(identity, "claim_path");
					// A lease is only meaningful for a worker that can write.
					if (!identity.tools.some((tool) => MUTATION_TOOLS.has(tool))) {
						throw new Error(`worker ${identity.agentId} (${identity.role}) holds no mutation tool to claim for`);
					}
					const key = await canonicalClaimKey(context.cwd, identity.jobId, identity.runDirectory, params.path);
					let lease: Awaited<ReturnType<typeof claimLease>>;
					try {
						lease = await claimLease(
							identity.runDirectory,
							{ agentId: identity.agentId, pid: process.pid, key },
							leaseDependencies,
						);
					} catch (error) {
						// The lease rule is unchanged; only the record of hitting it is new.
						const held = /^Path already claimed by (\S+):/u.exec(error instanceof Error ? error.message : "");
						if (held !== null) {
							await appendBusDenial(identity.runDirectory, identity.jobId, {
								reason: "claim-held",
								role: identity.role,
								agent_id: identity.agentId,
								key,
								holder: held[1],
							}).catch(() => undefined);
						}
						throw error;
					}
					const details = { path: params.path, key, agent_id: identity.agentId, at: lease.at };
					return { content: [{ type: "text", text: `claimed ${key}` }], details };
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "release_path",
				label: "Release Path",
				description: "Release a same-tree path lease held by this worker",
				parameters: Type.Object({ path: Type.String() }),
				async execute(_id, params, _signal, _update, context) {
					const identity = await identityFor(context.cwd);
					authorizeWorkerTool(identity, "release_path");
					const key = await canonicalClaimKey(context.cwd, identity.jobId, identity.runDirectory, params.path);
					const released = await releaseLease(
						identity.runDirectory,
						{ agentId: identity.agentId, key },
						leaseDependencies,
					);
					return {
						content: [{ type: "text", text: released ? `released ${key}` : `no lease on ${key}` }],
						details: { path: params.path, key, released },
					};
				},
			}),
		);
	}

	if (typeof pi.on === "function") {
		// The second half of tool isolation. `--tools` decides what a worker was
		// given; this decides what it may do with what it was given.
		pi.on("tool_call", async (event, ctx) => {
			const identity = await resolveWorkerIdentity(ctx.cwd, options.env).catch(() => undefined);
			if (identity === undefined) {
				return;
			}
			return evaluateWorkerToolCall(event, identity);
		});
	}
}

/**
 * What a worker may do with the tools it holds.
 *
 * Two rules. A role that must not mutate the tree may not reach a mutation tool
 * by any route, including one that was somehow registered for it. And a role
 * whose shell is a test shell may run exactly the job's declared quality gates
 * and nothing else - not a variant, not a gate with an extra redirection, not a
 * command that merely contains one.
 */
export function evaluateWorkerToolCall(
	event: ToolCallEvent,
	identity: WorkerIdentity,
): { block: true; reason: string } | undefined {
	if (MUTATION_TOOLS.has(event.toolName) && !identity.tools.some((tool) => MUTATION_TOOLS.has(tool))) {
		return {
			block: true,
			reason: `${identity.role} workers publish through write_contract and never write files directly`,
		};
	}

	if (isToolCallEventType("bash", event) && hasTestShellOnly(identity.role)) {
		const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
		// The gates come from the identity this worker was minted with, never from
		// `task.json`. Re-reading the task each call would make the shell as mutable
		// as the file: an edit after the worker started would widen it, which is the
		// opposite of a frozen contract.
		const gates = identity.qualityGates ?? [];
		if (gates.length === 0) {
			return {
				block: true,
				reason: `${identity.role} workers may only run this job's declared quality gates, and none are declared`,
			};
		}
		if (!gates.includes(command)) {
			return {
				block: true,
				reason: `${identity.role} workers may only run a declared quality gate exactly; allowed: ${gates.join(" | ")}`,
			};
		}
	}

	return undefined;
}

/** Tools that manage workers. They exist only in a parent session. */
function registerParentTools(pi: ExtensionAPI, options: BusRegistrationOptions): void {
	const buses = new Map<string, BackgroundBus>();
	setLiveWorkerCountProvider(() => {
		let count = 0;
		for (const bus of buses.values()) {
			count += bus.countLiveProcesses();
		}
		return count;
	});
	/**
	 * One parent-level queue for spawn and stop-all.
	 *
	 * Per-bus serialization alone is not enough: each job has its own bus, and
	 * switching the active job would otherwise let a second writer (or a third
	 * worker) start under a fresh table. Concurrent `spawn_background` tool calls
	 * must not both observe free slots and take them - check-then-await races are
	 * closed by running the global count and the spawn inside this same queue.
	 */
	let parentGate: Promise<unknown> = Promise.resolve();
	const serializeParent = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = parentGate.then(operation, operation);
		parentGate = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	/**
	 * The bus for the active job, created on first use.
	 *
	 * Nothing here runs at registration: a worker is started by a tool, a command,
	 * or a session that needs one, never by loading the extension.
	 */
	const activeBus = async (cwd: string): Promise<BackgroundBus> => {
		const job = await readActiveJob(cwd);
		if (job === undefined) {
			throw new Error("No active K-π job");
		}
		let bus = buses.get(job.jobId);
		if (bus === undefined) {
			bus = new BackgroundBus(cwd, job.directory, job.jobId, options);
			buses.set(job.jobId, bus);
		}
		return bus;
	};

	/**
	 * The bus that owns this agent, whichever job it belongs to.
	 *
	 * A session can own workers in more than one job, and an agent id names one
	 * worker, not one job. Resolving through the active job only would make
	 * addressing a worker depend on which job happens to be active - so a worker
	 * could become unreachable, and unstoppable, by switching jobs.
	 */
	const busOwning = async (cwd: string, agentId: string): Promise<BackgroundBus> => {
		for (const bus of buses.values()) {
			if (bus.get(agentId) !== undefined) {
				return bus;
			}
		}
		return activeBus(cwd);
	};

	/** Reap every registered bus, then count live workers and writers across jobs. */
	const countLiveAcrossJobs = async (): Promise<{ workers: number; writers: number }> => {
		let workers = 0;
		let writers = 0;
		for (const bus of buses.values()) {
			await bus.reap();
			for (const worker of bus.list()) {
				workers += 1;
				if (worker.isWriter) {
					writers += 1;
				}
			}
		}
		return { workers, writers };
	};

	/**
	 * Any live writer worker this session started, in any of its jobs.
	 *
	 * Deliberately not scoped to the active job: switching the active job in the
	 * same checkout does not stop the worker the previous job started, and that
	 * worker is still writing to the same working tree. Asking only about the
	 * active job would hand the writer slot back by changing the subject.
	 */
	const liveWriter = async (): Promise<{ agentId: string; jobId: string } | undefined> => {
		for (const bus of buses.values()) {
			await bus.reap();
			const writer = bus.list().find((worker) => worker.isWriter);
			if (writer !== undefined && bus.hasLiveWriter()) {
				return { agentId: writer.agentId, jobId: bus.jobId };
			}
		}
		return undefined;
	};

	if (typeof pi.registerTool === "function") {
		pi.registerTool(
			defineTool({
				name: "spawn_background",
				label: "Spawn Background",
				description: "Start one local background K-π worker; at most two workers and one writer",
				parameters: Type.Object({
					role: Type.Union(WORKER_ROLES.map((role) => Type.Literal(role))),
					prompt: Type.String(),
					model: Type.Optional(Type.String()),
					tools: Type.Optional(Type.Array(Type.String())),
				}),
				async execute(_id, params, _signal, _update, context) {
					if (!isWorkerRole(params.role)) {
						throw new Error(`Unknown worker role: ${String(params.role)}`);
					}
					// Global same-tree caps live here: per-bus defenses still run inside
					// `bus.spawn`, but the parent registry is what spans job switches.
					const worker = await serializeParent(async () => {
						const tools = resolveRoleTools(params.role, params.tools);
						const wantsWriter = isWriterToolSet(tools);
						const live = await countLiveAcrossJobs();
						const bus = await activeBus(context.cwd);
						if (live.workers >= MAX_LIVE_WORKERS) {
							await bus
								.logDenied({ reason: "worker-limit", role: params.role, limit: MAX_LIVE_WORKERS })
								.catch(() => undefined);
							throw new Error(`Background worker limit is ${MAX_LIVE_WORKERS}`);
						}
						if (wantsWriter && live.writers >= MAX_LIVE_WRITERS) {
							await bus
								.logDenied({ reason: "writer-live", role: params.role, limit: MAX_LIVE_WRITERS })
								.catch(() => undefined);
							throw new Error("A writer worker is already live");
						}
						return bus.spawn({
							role: params.role,
							prompt: params.prompt,
							model: params.model,
							tools: params.tools,
						});
					});
					const details = {
						agent_id: worker.agentId,
						session_path: worker.sessionPath,
						pid: worker.pid,
						role: worker.role,
						tools: worker.tools,
						is_writer: worker.isWriter,
						contract_path: worker.contractPin?.declaredPath,
					};
					return { content: [{ type: "text", text: JSON.stringify(details) }], details };
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "communicate",
				label: "Communicate",
				description: "Deliver steering or follow-up input to a background K-π worker",
				parameters: Type.Object({
					to: Type.String(),
					message: Type.String(),
					deliverAs: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
					expect: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("ack"), Type.Literal("result")])),
					timeoutMs: Type.Optional(Type.Number()),
				}),
				async execute(_id, params, _signal, _update, context) {
					const bus = await busOwning(context.cwd, params.to);
					const outcome = await bus.communicate({
						agentId: params.to,
						message: params.message,
						deliverAs: params.deliverAs,
						expect: params.expect,
						timeoutMs: params.timeoutMs,
					});
					const details = {
						to: params.to,
						expect: params.expect ?? "none",
						accepted: outcome.accepted,
						contract_path: outcome.contractPath,
						publication_id: outcome.publicationId,
					};
					return { content: [{ type: "text", text: JSON.stringify(details) }], details };
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "agents_status",
				label: "Agents Status",
				description: "List live background workers, their pids, and their last bus event",
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _update, context) {
					// Create the active job's bus if this is the first call, then report
					// every job this session owns: a worker does not stop existing
					// because the active job moved on.
					await activeBus(context.cwd).catch(() => undefined);
					const status = (await Promise.all([...buses.values()].map((bus) => bus.status()))).flat();
					return {
						content: [{ type: "text", text: JSON.stringify({ agents: status.length, workers: status }) }],
						details: { workers: status },
					};
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "agents_stop",
				label: "Agents Stop",
				description: "Ask a worker to publish its contract and exit, then stop it",
				parameters: Type.Object({
					agent_id: Type.Optional(Type.String()),
					graceMs: Type.Optional(Type.Number()),
				}),
				async execute(_id, params, _signal, _update, context) {
					if (params.agent_id === undefined) {
						// Same publish grace as a named stop, applied to every owned live
						// worker. `stopAll` is reserved for session_shutdown / fatal cleanup.
						const outcomes = await serializeParent(async () => {
							await activeBus(context.cwd).catch(() => undefined);
							const collected: Array<{
								agent_id: string;
								job_id: string;
								stopped: boolean;
								published?: string;
								graced: boolean;
								reason?: string;
							}> = [];
							for (const bus of buses.values()) {
								const stopped = await bus.publishAndStopAll(params.graceMs);
								for (const outcome of stopped) {
									collected.push({
										agent_id: outcome.agentId,
										job_id: bus.jobId,
										stopped: outcome.stopped,
										published: outcome.published,
										graced: outcome.graced,
										reason: outcome.reason,
									});
								}
							}
							return collected;
						});
						return {
							content: [
								{
									type: "text",
									text: `stopped ${outcomes.filter((entry) => entry.stopped).length} worker(s)`,
								},
							],
							details: { stopped: outcomes },
						};
					}
					const bus = await busOwning(context.cwd, params.agent_id);
					const outcome = await bus.publishAndStop(params.agent_id, params.graceMs);
					return {
						content: [
							{
								type: "text",
								text: outcome.stopped
									? `stopped ${params.agent_id}${outcome.published === undefined ? "" : ` after publishing ${outcome.published}`}`
									: `no live worker ${params.agent_id}`,
							},
						],
						details: outcome,
					};
				},
			}),
		);
	}

	if (typeof pi.on === "function") {
		/**
		 * The single-writer rule, made executable in the direction that was prose.
		 *
		 * A live writer worker holds the writer slot; the parent that started it
		 * does not get to keep writing at the same time. Otherwise "at most one
		 * writer" counts only workers and quietly excludes the session that spawned
		 * them, which is the one most likely to be editing. The slot returns when
		 * that worker is stopped or its process dies.
		 *
		 * A shell is denied outright for that interval, not inspected. `bash` can
		 * write any file in the tree, so leaving it open while denying `write` would
		 * leave the rule true only of the tools that announce themselves; and
		 * deciding which commands mutate is the endless denylist this deliberately
		 * refuses to attempt. The boring rule is: while a writer worker lives, this
		 * session does not run a shell.
		 */
		pi.on("tool_call", async (event) => {
			if (!PARENT_WRITER_TOOLS.has(event.toolName)) {
				return;
			}
			const writer = await liveWriter();
			if (writer === undefined) {
				return;
			}
			const holder = `${writer.agentId} (job ${writer.jobId})`;
			return {
				block: true,
				reason:
					event.toolName === "bash" || event.toolName === "powershell"
						? `worker ${holder} holds the single-writer slot; a shell can write anything, so it is closed until that worker stops`
						: `worker ${holder} holds the single-writer slot; stop it before writing from this session`,
			};
		});

		// Workers belong to the session that started them. Shutdown stops every one
		// of them, and stopping twice is a no-op.
		pi.on("session_shutdown", async () => {
			for (const bus of buses.values()) {
				await bus.stopAll().catch(() => undefined);
			}
			buses.clear();
		});
	}
}

export type { WorkerRole };
export { defaultIsProcessAlive };
