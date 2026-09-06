import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEvent,
} from "../../../core/extensions/types.ts";

import { readActiveJob } from "../run-store.ts";
import { classifyShellCommand } from "../shell-classifier.ts";
import { authorizeWorkerTool, hasWorkerDescriptor, requireWorkerIdentity, type WorkerIdentity } from "./identity.ts";
import {
	assertWriterAuthority,
	defaultIsProcessAlive,
	type LeaseOwner,
	releaseWriterAuthority,
	reserveWriterAuthority,
	sessionWriterAuthority,
} from "./leases.ts";
import { PEER_ENDPOINT_ENV, PeerClient, type PeerEndpoint } from "./peer-runtime.ts";
import {
	hasReadOnlyShell,
	hasTestShellOnly,
	isWorkerRole,
	MUTATION_TOOLS,
	WORKER_ROLES,
	type WorkerRole,
} from "./roles.ts";
import { registerSessionsCommand } from "./sessions-command.ts";
import { registeredBuses } from "./sessions-snapshot.ts";
import { type BackgroundBus, type BusDependencies, getOrCreateBackgroundBus } from "./spawn.ts";

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
	/** Graph sessions share the host bus; only exact-session writer hooks belong here. */
	graphSession?: boolean;
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
	if (!options.graphSession && hasWorkerDescriptor(options.env)) {
		registerWorkerTools(pi, options);
		return;
	}
	registerParentTools(pi, options);
}

/** Tools share one endpoint captured before model execution; sender is never an argument. */
function registerWorkerTools(pi: ExtensionAPI, options: BusRegistrationOptions): void {
	const rawEndpoint = (options.env ?? process.env)[PEER_ENDPOINT_ENV];
	let connection: Promise<PeerClient> | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	const client = async (): Promise<PeerClient> => {
		if (!rawEndpoint) throw new Error("worker has no authenticated peer endpoint");
		connection ??= PeerClient.connect(JSON.parse(rawEndpoint) as PeerEndpoint).catch((error) => {
			connection = undefined;
			throw error;
		});
		return connection;
	};
	const request = async (
		cwd: string,
		tool: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> => {
		const identity = await requireWorkerIdentity(cwd, options.env);
		authorizeWorkerTool(identity, tool);
		return (await client()).request(method, params);
	};
	const result = (details: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(details) }],
		details,
	});
	if (typeof pi.registerTool === "function") {
		pi.registerTool(
			defineTool({
				name: "communicate",
				label: "Communicate",
				description:
					"Durably send a direct or room message. Sender is authenticated; acceptance is not task completion.",
				parameters: Type.Object({
					to: Type.Optional(Type.String()),
					room: Type.Optional(Type.String()),
					message: Type.String(),
					id: Type.Optional(Type.String()),
					replyTo: Type.Optional(Type.String()),
					deliverAs: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
				}),
				async execute(_id, params, _signal, _update, context) {
					return result(
						await request(context.cwd, "communicate", "send", {
							to: params.to,
							room: params.room,
							text: params.message,
							id: params.id,
							replyTo: params.replyTo,
							deliverAs: params.deliverAs,
						}),
					);
				},
			}),
		);
		pi.registerTool(
			defineTool({
				name: "peers",
				label: "Peers",
				description:
					"Discover peers, join/leave job rooms, replay your scoped inbox, or acknowledge its next handled message.",
				parameters: Type.Object({
					action: Type.Union(["discover", "join", "leave", "inbox", "ack"].map((value) => Type.Literal(value))),
					room: Type.Optional(Type.String()),
					after: Type.Optional(Type.Number()),
					id: Type.Optional(Type.String()),
				}),
				async execute(_id, params, _signal, _update, context) {
					const payload =
						params.action === "join" || params.action === "leave"
							? { room: params.room }
							: params.action === "ack"
								? { id: params.id }
								: params.action === "inbox"
									? { after: params.after }
									: {};
					return result(await request(context.cwd, "peers", params.action, payload));
				},
			}),
		);
		pi.registerTool(
			defineTool({
				name: "write_contract",
				label: "Write Contract",
				description: "Ask the owning runtime to schema-validate and publish this peer role's declared contract.",
				parameters: Type.Object({ path: Type.String(), content: Type.Object({}, { additionalProperties: true }) }),
				async execute(_id, params, _signal, _update, context) {
					return result(await request(context.cwd, "write_contract", "publish", params));
				},
			}),
		);
		for (const action of ["claim", "release"] as const) {
			pi.registerTool(
				defineTool({
					name: `${action}_path`,
					label: `${action} Path`,
					description: `${action} this peer's exclusive canonical path ownership through the runtime.`,
					parameters: Type.Object({ path: Type.String() }),
					async execute(_id, params, _signal, _update, context) {
						return result(await request(context.cwd, `${action}_path`, action, params));
					},
				}),
			);
		}
	}
	if (typeof pi.on === "function") {
		pi.on("session_start", async (_event, context) => {
			await requireWorkerIdentity(context.cwd, options.env);
			await client();
			clearInterval(heartbeat);
			heartbeat = setInterval(() => {
				void client()
					.then((peer) => peer.request("heartbeat"))
					.catch(() => undefined);
			}, 20_000);
			heartbeat.unref();
		});
		pi.on("session_shutdown", async () => {
			clearInterval(heartbeat);
			if (connection) (await connection).close();
			connection = undefined;
		});
		pi.on("tool_call", async (event, context) => {
			try {
				const identity = await requireWorkerIdentity(context.cwd, options.env);
				const rejection = evaluateWorkerToolCall(event, identity);
				if (rejection) return rejection;
				authorizeWorkerTool(identity, event.toolName);
				if (
					MUTATION_TOOLS.has(event.toolName) ||
					(event.toolName === "bash" &&
						!hasReadOnlyShell(identity.role) &&
						!classifyShellCommand(String((event.input as Record<string, unknown>).command ?? "")).readOnly)
				) {
					const input = event.input as Record<string, unknown>;
					const path =
						typeof input.path === "string"
							? input.path
							: typeof input.file_path === "string"
								? input.file_path
								: undefined;
					await (await client()).request("authorize_mutation", { path });
				}
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : "invalid peer authority" };
			}
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

	if (isToolCallEventType("bash", event) && hasReadOnlyShell(identity.role)) {
		const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
		const classification = classifyShellCommand(command);
		if (!classification.readOnly) {
			return {
				block: true,
				reason: `${identity.role} workers may only run read-only shell commands: ${classification.reason}`,
			};
		}
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
	const buses = (): BackgroundBus[] => registeredBuses();
	if (!options.graphSession) registerSessionsCommand(pi, { admission: options.admission, now: options.now });
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
		return getOrCreateBackgroundBus(cwd, job.directory, job.jobId, options);
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
		for (const bus of buses()) {
			if (bus.get(agentId) !== undefined || (await bus.peers()).get(agentId) !== undefined) {
				return bus;
			}
		}
		throw new Error(`Unknown peer ${agentId} in this runtime (${cwd})`);
	};

	if (!options.graphSession && typeof pi.registerTool === "function") {
		pi.registerTool(
			defineTool({
				name: "spawn_background",
				label: "Spawn Background",
				description:
					"Start or restart a logical local peer under configured concurrency and exclusive writer admission",
				parameters: Type.Object({
					role: Type.Union(WORKER_ROLES.map((role) => Type.Literal(role))),
					prompt: Type.String(),
					model: Type.Optional(Type.String()),
					tools: Type.Optional(Type.Array(Type.String())),
					agentId: Type.Optional(Type.String()),
					writePaths: Type.Optional(Type.Array(Type.String())),
				}),
				async execute(_id, params, _signal, _update, context) {
					if (!isWorkerRole(params.role)) {
						throw new Error(`Unknown worker role: ${String(params.role)}`);
					}
					const worker = await serializeParent(async () => {
						const bus = await activeBus(context.cwd);
						return bus.spawn({
							role: params.role,
							prompt: params.prompt,
							model: params.model,
							tools: params.tools,
							agentId: params.agentId,
							writePaths: params.writePaths,
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
					const status = (await Promise.all(buses().map((bus) => bus.status()))).flat();
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
							for (const bus of buses()) {
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
		// The reservation spans actual tool execution, not just the preflight
		// check. Distinct owners in this process use the same durable boundary as
		// owners in other processes. A PID alone never grants a sibling's lease.
		const calls = new Map<string, { cwd: string; owner: LeaseOwner }>();
		pi.on("tool_call", async (event, context) => {
			if (!PARENT_WRITER_TOOLS.has(event.toolName)) return;
			if (
				event.toolName === "bash" &&
				classifyShellCommand(String((event.input as Record<string, unknown>).command ?? "")).readOnly
			)
				return;
			try {
				const input = event.input as Record<string, unknown>;
				const path =
					event.toolName === "bash" || event.toolName === "powershell"
						? undefined
						: typeof input.path === "string"
							? input.path
							: typeof input.file_path === "string"
								? input.file_path
								: undefined;
				const sessionId = context.sessionManager.getSessionId();
				const bound = sessionWriterAuthority(sessionId);
				if (bound) {
					await assertWriterAuthority(context.cwd, bound, path, options, false);
					return;
				}
				const owner: LeaseOwner = {
					jobId: (await readActiveJob(context.cwd))?.jobId ?? "chat",
					agentId: `session:${sessionId}:${event.toolCallId}`,
					pid: process.pid,
					incarnation: randomUUID(),
				};
				await reserveWriterAuthority(context.cwd, owner, path === undefined ? ["."] : [path], options);
				calls.set(event.toolCallId, { cwd: context.cwd, owner });
			} catch (error) {
				return {
					block: true,
					reason: error instanceof Error ? error.message : "workspace writer authority unavailable",
				};
			}
		});
		pi.on("tool_execution_end", async (event) => {
			const call = calls.get(event.toolCallId);
			if (!call) return;
			await releaseWriterAuthority(call.cwd, call.owner, options);
			calls.delete(event.toolCallId);
		});

		// Workers belong to the session that started them. Shutdown stops every one
		// of them, and stopping twice is a no-op.
		if (!options.graphSession) {
			pi.on("session_shutdown", async () => {
				for (const bus of buses()) {
					await bus.stopAll();
				}
			});
		}
	}
}

export type { WorkerRole };
export { defaultIsProcessAlive };
