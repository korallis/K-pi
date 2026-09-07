import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { appendEvent } from "../append-log.ts";
import { parseLadderDecision } from "../minimalist.ts";
import { readTaskForJob } from "../run-store.ts";
import { assertClaimInModule, freezeCurrentSlice, stackRequiredFor } from "../stack.ts";
import { mintCapabilityId, mintWorkerDescriptor, type WorkerDescriptor } from "./identity.ts";
import { launchWorkerProcess, type WorkerLaunch, type WorkerLauncher } from "./launch.ts";
import {
	assertWriterAuthority,
	canonicalLeasePath,
	claimLease,
	defaultIsProcessAlive,
	type LeaseDependencies,
	type LeaseOwner,
	type LeaseRecord,
	pathsOverlap,
	readLeasesFile,
	releaseAllLeasesFor,
	releaseDeadLeases,
	releaseLease,
	releaseWriterAuthority,
	reserveWriterAuthority,
	transferWriterAuthority,
	WorkspaceBusyError,
} from "./leases.ts";
import { type PeerRecord, PeerRuntime } from "./peer-runtime.ts";
import {
	type CommunicateExpectation,
	type DeliverAs,
	WORKER_RESULT_TIMEOUT_MS,
	type WorkerDiagnostics,
} from "./protocol.ts";
import { hasTestShellOnly, isWriterToolSet, ROLE_RESULT_FILE, resolveRoleTools, type WorkerRole } from "./roles.ts";
import { registeredBuses, registerLiveBus, unregisterLiveBus } from "./sessions-snapshot.ts";
import {
	type ContractPin,
	describeRejection,
	evaluatePublication,
	hashContractBytes,
	mintContractPin,
	type PublicationReceipt,
	readPublicationReceipt,
	writeContract,
} from "./write-contract.ts";

/** Operational scheduler capacity, not a fixed product ceiling. */
export const MAX_LIVE_WORKERS = Number(process.env.KPI_MAX_PEERS ?? 8);
/** Maximum writers for overlapping authority, not for disjoint edit-only scopes. */
export const MAX_LIVE_WRITERS = 1;

/** How long `expect: "result"` waits for an authoritative publication. */
export const CONTRACT_WAIT_TIMEOUT_MS = 120_000;
/** How long a stopping worker is given to publish before it is signalled. */
export const STOP_GRACE_TIMEOUT_MS = 60_000;
/** What a worker is told when it is being stopped. */
export const STOP_MESSAGE = "stop: publish your result file, then exit";
const CONTRACT_POLL_INTERVAL_MS = 50;

/**
 * Process-wide (or test-scoped) admission for live background workers.
 *
 * Caps are within the process, not per `BackgroundBus` instance: a graph engine
 * bus and a parent-tool bus in the same checkout share one budget. Creating a
 * second bus must not reset the count.
 */
export interface WorkerAdmission {
	/** Reserve one slot; returns a release that returns the slot. */
	acquire(slot: { key: string; isWriter: boolean; paths?: readonly string[]; checkout?: string }): Promise<() => void>;
	/** Current occupancy. */
	counts(): { workers: number; writers: number };
}

/** Builds an isolated admission table. Tests inject one per harness. */
export function createWorkerAdmission(limits: { maxWorkers?: number; maxWriters?: number } = {}): WorkerAdmission {
	const maxWorkers = limits.maxWorkers ?? MAX_LIVE_WORKERS;
	const maxWriters = limits.maxWriters ?? MAX_LIVE_WRITERS;
	if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWriters !== 1) {
		throw new Error(
			"peer concurrency must be a positive integer and overlapping writer authority must remain exclusive",
		);
	}
	const slots = new Map<string, { isWriter: boolean; paths: readonly string[]; checkout?: string }>();
	let queue: Promise<unknown> = Promise.resolve();
	const serialize = <T>(operation: () => T | Promise<T>): Promise<T> => {
		const result = queue.then(operation, operation);
		queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	return {
		async acquire(slot) {
			return serialize(() => {
				if (slots.has(slot.key)) {
					throw new Error(`admission key already held: ${slot.key}`);
				}
				if (slots.size >= maxWorkers) {
					throw new Error(`Background worker limit is ${maxWorkers}`);
				}
				if (slot.isWriter) {
					const paths = slot.paths ?? ["."];
					if (
						[...slots.values()].some(
							(held) =>
								held.isWriter &&
								(held.checkout === undefined ||
									slot.checkout === undefined ||
									held.checkout === slot.checkout) &&
								held.paths.some((a) => paths.some((b) => pathsOverlap(a, b))),
						)
					) {
						throw new WorkspaceBusyError("A writer worker is already live");
					}
				}
				slots.set(slot.key, { isWriter: slot.isWriter, paths: slot.paths ?? ["."], checkout: slot.checkout });
				let released = false;
				return (): void => {
					if (released) {
						return;
					}
					released = true;
					slots.delete(slot.key);
				};
			});
		},
		counts() {
			let writers = 0;
			for (const held of slots.values()) {
				if (held.isWriter) {
					writers += 1;
				}
			}
			return { workers: slots.size, writers };
		},
	};
}

/**
 * Maps an admission refusal onto its reason code. Matched on the message the
 * table itself raises, so the codes and the caps cannot drift apart.
 */
export function admissionDenialReason(error: unknown): "worker-limit" | "writer-live" | "admission-held" {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("A writer worker is already live")) {
		return "writer-live";
	}
	if (message.startsWith("admission key already held")) {
		return "admission-held";
	}
	return "worker-limit";
}

/**
 * Default process-wide admission. Production buses share this. Tests MUST inject
 * `createWorkerAdmission()` so parallel harnesses do not contend.
 */
export const processWorkerAdmission: WorkerAdmission = createWorkerAdmission();

export interface WorkerRecord {
	agentId: string;
	role: WorkerRole;
	pid: number;
	sessionPath: string;
	sessionDirectory: string;
	tools: string[];
	isWriter: boolean;
	/** Immutable process incarnation used by every ownership operation. */
	owner: LeaseOwner;
	writePaths: readonly string[];
	contractPin?: ContractPin;
	descriptor: WorkerDescriptor;
	baselinePublicationId?: string;
	/** Prevents unrelated simultaneous result waits sharing one publication. */
	resultPending?: boolean;
	launch: WorkerLaunch;
	spawnedAt: string;
	lastEvent: string;
	/** The graph node that started this worker, when one did. */
	node?: string;
	/**
	 * Settlement of the initial spawn prompt. Installed on the protocol *before*
	 * that prompt is sent, so a fast `agent_settled` cannot race past the parent.
	 */
	initialSettlement: Promise<void>;
	/** Returns this worker's process-level admission slot. */
	releaseAdmission: () => void;
}

export interface WorkerStatus {
	agent_id: string;
	role: WorkerRole;
	pid: number;
	alive: boolean;
	is_writer: boolean;
	tools: string[];
	session_path: string;
	last_event: string;
	contract_path?: string;
	diagnostics: WorkerDiagnostics;
	node?: string;
}

/** One worker as the sessions registry sees it: the bus's own liveness answer, no I/O. */
export interface LiveWorker {
	agentId: string;
	role: WorkerRole;
	pid: number;
	alive: boolean;
	isWriter: boolean;
	spawnedAt: string;
	lastEvent: string;
	node?: string;
}

export type { LeaseRecord };

export interface BusDependencies extends LeaseDependencies {
	launcher?: WorkerLauncher;
	cliPath?: string;
	execPath?: string;
	startupTimeoutMs?: number;
	contractWaitTimeoutMs?: number;
	/** How long a stopping worker is given to publish. Zero skips the grace. */
	stopGraceMs?: number;
	/** Polling interval while waiting for a publication. */
	contractPollIntervalMs?: number;
	newCapabilityId?: () => string;
	newAgentSuffix?: () => string;
	/**
	 * Shared worker/writer admission. Defaults to the process-wide table so a
	 * graph bus and a parent-tool bus cannot each take a full budget.
	 */
	admission?: WorkerAdmission;
}

/**
 * One job's background workers, their leases, and their logs.
 *
 * Two different serializations are at work here, because there are two different
 * kinds of shared state. The worker table and the logs live in this process, so
 * they are serialized by one promise chain. Writer reservations and path claims
 * live in the canonical checkout's ownership directory, shared by every job and
 * owner process and serialized by the same hard-link lock primitive.
 */
export class BackgroundBus {
	readonly cwd: string;
	readonly runDirectory: string;
	readonly agentsDirectory: string;
	readonly busPath: string;
	readonly eventsPath: string;
	readonly jobId: string;
	private readonly workers = new Map<string, WorkerRecord>();
	private readonly launcher: WorkerLauncher;
	private readonly now: () => Date;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly dependencies: BusDependencies;
	private readonly admission: WorkerAdmission;
	/** The serialization point for every in-process shared-state mutation. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Once closing, nothing new starts: shutdown cannot be outrun by a spawn. */
	private closing = false;
	private peerRuntime?: Promise<PeerRuntime>;

	/** Opens the job's sole realtime endpoint and recovers durable peer records. */
	async peers(): Promise<PeerRuntime> {
		this.peerRuntime ??= PeerRuntime.open(this.runDirectory, {
			isProcessAlive: this.isProcessAlive,
			publish: async (peer, params) =>
				this.serialize(async () => {
					const worker = this.activePeer(peer);
					const result = await writeContract({
						pin: worker.contractPin,
						agentId: peer.agentId,
						jobId: this.jobId,
						role: worker.role,
						requestedPath: String(params.path),
						payload: params.content,
						now: this.now,
					});
					return {
						path: result.path,
						publication_id: result.receipt.publication_id,
						content_sha256: result.receipt.content_sha256,
					};
				}),
			claim: async (peer, path) =>
				this.serialize(async () => {
					const worker = this.activePeer(peer);
					if (!worker.isWriter) throw new Error("peer holds no mutation tool to claim for");
					const key = await this.claimKey(path);
					return { key, ...(await this.claim(peer.agentId, worker.pid, key)) };
				}),
			release: async (peer, path) =>
				this.serialize(async () => {
					this.activePeer(peer);
					return this.release(peer.agentId, await this.claimKey(path));
				}),
			authorizeMutation: async (peer, path) =>
				this.serialize(async () => {
					const worker = this.activePeer(peer);
					if (!worker.isWriter) {
						if (path !== undefined || !hasTestShellOnly(worker.role))
							throw new Error("peer holds no writer authority");
						// Exact quality gates can mutate arbitrary project files. They need
						// checkout exclusion too, but do not gain result publication authority.
						await reserveWriterAuthority(this.cwd, worker.owner, ["."], this.leaseDependencies);
					}
					await assertWriterAuthority(
						this.cwd,
						worker.owner,
						path === undefined ? undefined : await this.claimKey(path),
						this.leaseDependencies,
					);
					return { authorized: true };
				}),
		});
		return this.peerRuntime;
	}

	private activePeer(peer: PeerRecord): WorkerRecord {
		const worker = this.workers.get(peer.agentId);
		if (
			!worker ||
			!worker.launch.isAlive() ||
			!this.isProcessAlive(worker.pid) ||
			worker.owner.pid !== worker.pid ||
			worker.owner.incarnation !== peer.incarnation
		) {
			throw new Error("peer incarnation is not live");
		}
		return worker;
	}

	private async claimKey(path: string): Promise<string> {
		const task = await readTaskForJob(this.cwd, this.jobId);
		if (stackRequiredFor(task)) {
			const { module } = await freezeCurrentSlice(this.cwd, this.runDirectory, task);
			await assertClaimInModule(this.cwd, path, module);
		}
		return canonicalLeasePath(this.cwd, path);
	}

	constructor(cwd: string, runDirectory: string, jobId: string, dependencies: BusDependencies = {}) {
		this.cwd = cwd;
		this.runDirectory = runDirectory;
		this.jobId = jobId;
		this.agentsDirectory = join(runDirectory, "agents");
		this.busPath = join(runDirectory, "bus.jsonl");
		this.eventsPath = join(runDirectory, "events.jsonl");
		this.launcher = dependencies.launcher ?? launchWorkerProcess;
		this.now = dependencies.now ?? (() => new Date());
		this.isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
		this.sleep =
			dependencies.sleep ?? ((ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
		this.dependencies = dependencies;
		this.admission = dependencies.admission ?? processWorkerAdmission;
	}

	/** What the lease primitive needs, taken from this bus's own injections. */
	private get leaseDependencies(): LeaseDependencies {
		return {
			now: this.now,
			isProcessAlive: (pid) => pid === process.pid || this.isProcessAlive(pid),
			sleep: this.sleep,
			lockTimeoutMs: this.dependencies.lockTimeoutMs,
			lockRetryMs: this.dependencies.lockRetryMs,
		};
	}

	/** Runs `operation` after everything already queued, and never out of order. */
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Records an event in both logs.
	 *
	 * `events.jsonl` is the hash-chained job log and `bus.jsonl` is the bus's own
	 * transcript. Neither carries the capability id: it is a bearer value, and a
	 * log is the one place it must not be.
	 */
	private async logSpawned(payload: {
		agent_id: string;
		role: WorkerRole;
		pid: number;
		session_path: string;
		tools: string[];
	}): Promise<void> {
		const ts = this.now().toISOString();
		await appendEvent(this.eventsPath, {
			ts,
			type: "agent.spawned",
			job_id: this.jobId,
			round: 0,
			node: "bus",
			agent_id: payload.agent_id,
			role: payload.role,
			pid: payload.pid,
			session_path: payload.session_path,
		});
		await this.appendBus({ ts, type: "agent.spawned", job_id: this.jobId, ...payload });
	}

	/**
	 * Records a refusal by the bus.
	 *
	 * A cap that only ever appears as a thrown string in one process's tool result
	 * cannot be audited after the fact, so the refusal joins the job's own
	 * hash-chained log and the bus transcript. The capability id is deliberately
	 * absent: it is the bearer that would have authorised the work, and a refusal
	 * is the last place it should be published.
	 */
	async logDenied(payload: {
		reason: "worker-limit" | "writer-live" | "admission-held" | "claim-held" | "role-tool";
		role?: WorkerRole;
		agent_id?: string;
		key?: string;
		holder?: string;
		limit?: number;
	}): Promise<void> {
		const ts = this.now().toISOString();
		await appendEvent(this.eventsPath, {
			ts,
			type: "agent.denied",
			job_id: this.jobId,
			round: 0,
			node: "bus",
			reason: payload.reason,
			...(payload.role === undefined ? {} : { role: payload.role }),
			...(payload.agent_id === undefined ? {} : { agent_id: payload.agent_id }),
			...(payload.key === undefined ? {} : { key: payload.key }),
			...(payload.holder === undefined ? {} : { holder: payload.holder }),
			...(payload.limit === undefined ? {} : { limit: payload.limit }),
		});
		await this.appendBus({ ts, type: "agent.denied", job_id: this.jobId, ...payload });
	}

	private async logMessage(payload: {
		agent_id: string;
		role: WorkerRole;
		deliver_as: DeliverAs;
		expect: CommunicateExpectation;
	}): Promise<void> {
		const ts = this.now().toISOString();
		await appendEvent(this.eventsPath, {
			ts,
			type: "agent.message",
			job_id: this.jobId,
			round: 0,
			node: "bus",
			agent_id: payload.agent_id,
			deliver_as: payload.deliver_as,
			expect: payload.expect,
		});
		await this.appendBus({ ts, type: "agent.message", job_id: this.jobId, ...payload });
	}

	/** The bus's own transcript, appended through one durable writer. */
	private async appendBus(record: Record<string, unknown>): Promise<void> {
		await mkdir(this.runDirectory, { recursive: true });
		const file = await open(this.busPath, "a", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(record)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
	}

	/** Drops workers whose process is gone, releasing whatever they held. */
	private async reapUnlocked(): Promise<void> {
		for (const [agentId, worker] of [...this.workers]) {
			// Transport loss is not proof of death. A stopped or disconnected process
			// retains admission and durable ownership until the kernel confirms exit.
			if (!this.isProcessAlive(worker.pid)) {
				this.workers.delete(agentId);
				if (this.peerRuntime) (await this.peerRuntime).deactivate(agentId);
				await releaseAllLeasesFor(this.runDirectory, worker.owner, this.leaseDependencies);
				await releaseWriterAuthority(this.cwd, worker.owner, this.leaseDependencies);
				worker.releaseAdmission();
				worker.launch.protocol.close();
			}
		}
		await releaseDeadLeases(this.runDirectory, this.leaseDependencies);
	}

	async reap(): Promise<void> {
		await this.serialize(() => this.reapUnlocked());
	}

	get live(): number {
		return this.workers.size;
	}

	/**
	 * Synchronous listing for the sessions registry: every worker in the table
	 * with this bus's own liveness answer (launch and PID through the injected
	 * predicate). Does not reap or release — render must never mutate bus state.
	 */
	liveWorkers(): LiveWorker[] {
		return [...this.workers.values()].map((worker) => ({
			agentId: worker.agentId,
			role: worker.role,
			pid: worker.pid,
			alive: worker.launch.isAlive() && this.isProcessAlive(worker.pid),
			isWriter: worker.isWriter,
			spawnedAt: worker.spawnedAt,
			lastEvent: worker.lastEvent,
			...(worker.node === undefined ? {} : { node: worker.node }),
		}));
	}

	/**
	 * Synchronous board/provider count: only workers whose launch and PID are live.
	 * Does not reap or release — render must never mutate bus state.
	 */
	countLiveProcesses(): number {
		return this.liveWorkers().filter((worker) => worker.alive).length;
	}

	/** Whether this bus owns any live candidate-writing peer, including scoped writers. */
	hasLiveWriter(): boolean {
		for (const worker of this.workers.values()) {
			if (worker.isWriter && worker.launch.isAlive() && this.isProcessAlive(worker.pid)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Starts one worker.
	 *
	 * Worker and writer caps are admitted through the process-level (or
	 * test-injected) admission table before launch, so two `BackgroundBus`
	 * instances in the same process cannot each take a full budget. Identity,
	 * session file, and process launch still run inside this bus's serialize so
	 * concurrent spawns on one bus stay ordered. Every failure after the process
	 * exists stops it again and returns the admission slot.
	 */
	async spawn(options: {
		role: WorkerRole;
		prompt: string;
		model?: string;
		tools?: readonly string[];
		/** The graph node starting this worker, when one is. */
		node?: string;
		/** Stable logical identity, reused across process incarnations. */
		agentId?: string;
		/** Scoped edit-only authority. A general shell always requires the whole checkout. */
		writePaths?: readonly string[];
	}): Promise<WorkerRecord> {
		return this.serialize(async () => {
			if (this.closing) {
				throw new Error("this bus is shutting down and starts no new workers");
			}
			await this.reapUnlocked();
			const peers = await this.peers();
			const agentId = options.agentId ?? `${options.role}-${(this.dependencies.newAgentSuffix ?? randomUUID)()}`;
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(agentId) || !agentId.startsWith(`${options.role}-`)) {
				throw new Error("agentId must be a role-prefixed safe logical identity");
			}
			const previous = peers.get(agentId);
			const existing = this.workers.get(agentId);
			if (existing) {
				if (existing.role !== options.role) throw new Error("logical peer role cannot change");
				if (existing.resultPending) throw new Error("peer has an outstanding result assignment");
				if (
					(options.model !== undefined && options.model !== previous?.model) ||
					(options.tools !== undefined && JSON.stringify(options.tools) !== JSON.stringify(existing.tools)) ||
					(options.writePaths !== undefined &&
						JSON.stringify(options.writePaths) !== JSON.stringify(existing.writePaths))
				) {
					throw new Error("stop the peer before changing model or tool authority");
				}
				await readTaskForJob(this.cwd, this.jobId);
				await peers.assign(agentId, options.prompt, options.node);
				existing.baselinePublicationId =
					existing.contractPin === undefined
						? undefined
						: (await readPublicationReceipt(existing.contractPin.receiptPath))?.publication_id;
				existing.initialSettlement = existing.launch.protocol.waitForSettled(
					this.dependencies.contractWaitTimeoutMs ?? WORKER_RESULT_TIMEOUT_MS,
				);
				existing.initialSettlement.catch(() => undefined);
				await existing.launch.protocol.deliver(options.prompt, "followUp");
				return existing;
			}
			if (previous?.pid !== undefined && this.isProcessAlive(previous.pid)) {
				throw new WorkspaceBusyError("previous peer process has not exited; refusing identity/ownership transfer");
			}
			const tools = resolveRoleTools(options.role, options.tools ?? previous?.descriptor.tools);
			const isWriter = isWriterToolSet(tools, options.role);
			const requestedPaths = options.writePaths ?? previous?.descriptor.writePaths ?? ["."];
			if (isWriter && requestedPaths.length === 0) throw new Error("writer needs a nonempty path scope");
			const writePaths = isWriter
				? await Promise.all(requestedPaths.map((path) => (path === "." ? "." : this.claimKey(path))))
				: [];
			if (isWriter && tools.includes("bash") && !writePaths.includes("."))
				throw new Error("unrestricted bash requires whole-checkout writer authority");
			let owner: LeaseOwner = { jobId: this.jobId, agentId, pid: process.pid, incarnation: randomUUID() };
			let reserved = false;
			let releaseAdmission: () => void;
			const checkout = await realpath(this.cwd);
			try {
				releaseAdmission = await this.admission.acquire({
					key: JSON.stringify([checkout, this.jobId, agentId]),
					checkout,
					isWriter,
					paths: writePaths,
				});
			} catch (error) {
				// The cap is unchanged; only the record of hitting it is new.
				await this.logDenied({
					reason: admissionDenialReason(error),
					role: options.role,
					agent_id: agentId,
					limit: this.admission.counts().workers,
				}).catch(() => undefined);
				throw error;
			}
			/** True until the slot is either on a live record or explicitly returned. */
			let admissionHeld = true;
			const returnAdmission = (): void => {
				if (!admissionHeld) {
					return;
				}
				admissionHeld = false;
				releaseAdmission();
			};

			try {
				if (isWriter) {
					await reserveWriterAuthority(this.cwd, owner, writePaths, this.leaseDependencies);
					reserved = true;
				}
				const capabilityId = (this.dependencies.newCapabilityId ?? mintCapabilityId)();
				const sessionDirectory = this.agentsDirectory;
				const sessionPath = previous?.sessionPath ?? join(sessionDirectory, `${agentId}.jsonl`);
				// The gates are read once, here, and travel with the worker. A later edit
				// to `task.json` cannot widen a shell that has already started.
				const task = await readTaskForJob(this.cwd, this.jobId);
				const descriptor = mintWorkerDescriptor({
					agentId,
					jobId: this.jobId,
					role: options.role,
					runDirectory: this.runDirectory,
					tools,
					capabilityId,
					qualityGates: previous?.descriptor.qualityGates ?? task.quality_gates,
					writePaths,
				});
				const contractPin = mintContractPin({
					agentId,
					jobId: this.jobId,
					role: options.role,
					runDirectory: this.runDirectory,
					capabilityId,
				});

				await mkdir(sessionDirectory, { recursive: true });
				// The session file exists before the worker starts, so the path it is
				// given is the path it opens.
				const handle = await open(sessionPath, "a", 0o600);
				await handle.close();
				const peerEndpoint = await peers.activate(
					{
						agentId,
						descriptor,
						sessionPath,
						model: options.model ?? previous?.model,
						taskId: options.node ?? previous?.taskId,
						prompt: options.prompt,
					},
					owner.incarnation,
				);

				const launch = await this.launcher({
					cwd: this.cwd,
					sessionPath,
					sessionDirectory,
					tools,
					model: options.model ?? previous?.model,
					descriptor,
					cliPath: this.dependencies.cliPath,
					execPath: this.dependencies.execPath,
					startupTimeoutMs: this.dependencies.startupTimeoutMs,
					peerEndpoint,
				});
				// Capture settlement of the initial turn before the prompt leaves this
				// process. A worker that settles in the same tick as acceptance would
				// otherwise race past a waiter installed after spawn returns.
				const settleTimeout = this.dependencies.contractWaitTimeoutMs ?? WORKER_RESULT_TIMEOUT_MS;
				const initialSettlement = launch.protocol.waitForSettled(settleTimeout, launch.protocol.settles);
				// Avoid an unhandled rejection if spawn fails before anyone awaits it.
				initialSettlement.catch(() => undefined);

				const record: WorkerRecord = {
					agentId,
					role: options.role,
					pid: launch.pid,
					sessionPath,
					sessionDirectory,
					tools,
					isWriter,
					owner,
					writePaths,
					contractPin,
					descriptor,
					launch,
					spawnedAt: this.now().toISOString(),
					lastEvent: "agent.spawned",
					...(options.node === undefined ? {} : { node: options.node }),
					initialSettlement,
					releaseAdmission: returnAdmission,
				};
				this.workers.set(agentId, record);
				// A failed durable PID record still enters the same confirmed-stop cleanup.

				try {
					owner = reserved
						? await transferWriterAuthority(this.cwd, owner, launch.pid, this.leaseDependencies)
						: { ...owner, pid: launch.pid };
					record.owner = owner;
					await peers.recordPid(agentId, launch.pid);
					await this.logSpawned({
						agent_id: agentId,
						role: options.role,
						pid: launch.pid,
						tools: [...tools],
						session_path: sessionPath,
					});
					// The initial delivery is a prompt, and its response is acceptance.
					await launch.protocol.prompt(options.prompt);
					peers.attachDelivery(agentId, async (message) => {
						await launch.protocol.deliver(
							`Peer message ${message.id} (#${message.sequence}) from ${message.sender}${message.room ? ` in ${message.room}` : ""}:\n${message.text}\nAcknowledge this message with peers(action:"ack", id:"${message.id}") after handling it.`,
							message.deliverAs ?? "followUp",
						);
					});
				} catch (error) {
					await launch.stop();
					if (launch.isAlive() || this.isProcessAlive(launch.pid))
						throw new Error("worker cleanup did not confirm exit; admission retained");
					this.workers.delete(agentId);
					peers.deactivate(agentId);
					await releaseAllLeasesFor(this.runDirectory, record.owner, this.leaseDependencies);
					if (reserved) await releaseWriterAuthority(this.cwd, owner, this.leaseDependencies);
					returnAdmission();
					throw error;
				}
				return record;
			} catch (error) {
				if (!this.workers.has(agentId)) {
					peers.deactivate(agentId);
					if (reserved) await releaseWriterAuthority(this.cwd, owner, this.leaseDependencies);
					returnAdmission();
				}
				throw error;
			}
		});
	}

	get(agentId: string): WorkerRecord | undefined {
		return this.workers.get(agentId);
	}

	list(): WorkerRecord[] {
		return [...this.workers.values()];
	}

	/** Restart a stopped logical peer using its durable role, task and session. */
	async restart(agentId: string): Promise<WorkerRecord> {
		if (this.workers.has(agentId)) await this.stop(agentId);
		const peer = (await this.peers()).get(agentId);
		if (!peer) throw new Error(`Unknown peer: ${agentId}`);
		return this.spawn({
			agentId,
			role: peer.descriptor.role,
			prompt: peer.prompt,
			model: peer.model,
			tools: peer.descriptor.tools,
			node: peer.taskId,
		});
	}

	async status(): Promise<WorkerStatus[]> {
		return this.serialize(async () => {
			await this.reapUnlocked();
			return [...this.workers.values()].map((worker) => ({
				agent_id: worker.agentId,
				role: worker.role,
				pid: worker.pid,
				alive: worker.launch.isAlive() && this.isProcessAlive(worker.pid),
				is_writer: worker.isWriter,
				tools: [...worker.tools],
				session_path: worker.sessionPath,
				last_event: worker.lastEvent,
				contract_path: worker.contractPin?.declaredPath,
				diagnostics: worker.launch.protocol.snapshot,
				...(worker.node === undefined ? {} : { node: worker.node }),
			}));
		});
	}

	/**
	 * Delivers a message into a live worker.
	 *
	 * `none` returns once the stream has taken the bytes, `ack` waits for the
	 * worker's acceptance, and `result` waits for a fresh authoritative
	 * publication: completion, then a receipt this capability issued after this
	 * delivery, then contract bytes matching that receipt and its schema.
	 *
	 * The settlement waiter is registered before the message is delivered. A
	 * worker can settle between the acceptance response and any later
	 * registration, and a waiter installed after that races the event it exists to
	 * observe. A follow-up makes this concrete: it is accepted while the previous
	 * turn is still ending, so the first settle a late waiter sees may belong to
	 * that turn - which is why freshness, not settlement, is what admits a result.
	 */
	async communicate(options: {
		agentId: string;
		message: string;
		deliverAs?: DeliverAs;
		expect?: CommunicateExpectation;
		timeoutMs?: number;
	}): Promise<{ accepted: boolean; contractPath?: string; publicationId?: string; contentSha256?: string }> {
		const deliverAs: DeliverAs = options.deliverAs ?? "followUp";
		const expect: CommunicateExpectation = options.expect ?? "none";
		const worker = await this.serialize(async () => {
			await this.reapUnlocked();
			const found = this.workers.get(options.agentId);
			if (found === undefined) {
				throw new Error(`Unknown or stopped worker: ${options.agentId}`);
			}
			found.lastEvent = "agent.message";
			await this.logMessage({
				agent_id: options.agentId,
				role: found.role,
				deliver_as: deliverAs,
				expect,
			});
			return found;
		});
		if (worker.resultPending) throw new Error("peer has an outstanding result assignment");
		worker.resultPending = expect === "result";
		try {
			const persistedMessage = async (): Promise<string> => {
				const { message } = await (await this.peers()).send(
					"host",
					{ to: worker.agentId, text: options.message, deliverAs },
					false,
				);
				return `Peer message ${message.id} (#${message.sequence}) from host:\n${options.message}\nAfter handling, acknowledge with peers(action:"ack", id:"${message.id}").`;
			};

			if (expect === "none") {
				// Nothing is expected back, but the bytes still have to be taken by the
				// stream rather than queued in this process without limit.
				await worker.launch.protocol.send({
					type: "prompt",
					message: await persistedMessage(),
					streamingBehavior: deliverAs,
				});
				return { accepted: false };
			}

			if (expect === "ack") {
				await worker.launch.protocol.deliver(await persistedMessage(), deliverAs);
				return { accepted: true };
			}

			const resultFile = ROLE_RESULT_FILE[worker.role];
			if (resultFile === undefined) {
				throw new Error(`role ${worker.role} produces no result file, so there is nothing to wait for`);
			}
			const pin = worker.contractPin;
			const limit = options.timeoutMs ?? this.dependencies.contractWaitTimeoutMs ?? CONTRACT_WAIT_TIMEOUT_MS;

			// Both baselines are taken before delivery, so whatever is already on disk
			// cannot be mistaken for an answer to this message.
			const baselineReceipt = pin === undefined ? undefined : await readPublicationReceipt(pin.receiptPath);
			const baselineBytes = pin === undefined ? await this.readResultBytes(resultFile) : undefined;

			const settled = worker.launch.protocol.waitForSettled(limit);
			try {
				await worker.launch.protocol.deliver(await persistedMessage(), deliverAs);
			} catch (error) {
				void settled.catch(() => undefined);
				throw error;
			}
			await settled;

			if (pin !== undefined) {
				const outcome = await this.waitForPublication(pin, baselineReceipt?.publication_id, limit);
				return {
					accepted: true,
					contractPath: outcome.receipt.declared_path,
					publicationId: outcome.receipt.publication_id,
				};
			}
			const written = await this.waitForWriterResult(resultFile, baselineBytes, limit);
			return { accepted: true, contractPath: resultFile, contentSha256: written.contentSha256 };
		} finally {
			worker.resultPending = false;
		}
	}

	/**
	 * Waits for the worker's initial spawn turn to settle, then requires a fresh
	 * receipt-backed publication for that worker's pin.
	 *
	 * No second model turn is sent. Transcript text is never consulted: only the
	 * authorized receipt + schema-valid contract file count as the result.
	 */
	async awaitInitialContract(
		agentId: string,
		timeoutMs?: number,
	): Promise<{
		receipt: PublicationReceipt;
		document: Record<string, unknown>;
		agentId: string;
		sessionPath: string;
	}> {
		const worker = this.workers.get(agentId);
		if (worker === undefined) {
			throw new Error(`Unknown or stopped worker: ${agentId}`);
		}
		const pin = worker.contractPin;
		if (pin === undefined) {
			throw new Error(`worker ${agentId} (${worker.role}) has no contract pin to collect`);
		}
		await worker.initialSettlement;
		worker.lastEvent = "agent.settled";
		const published = await this.waitForPublication(pin, worker.baselinePublicationId, timeoutMs);
		return {
			receipt: published.receipt,
			document: published.document,
			agentId: worker.agentId,
			sessionPath: worker.sessionPath,
		};
	}

	/** The result file's current bytes, or `undefined` when it is not there. */
	private async readResultBytes(file: string): Promise<string | undefined> {
		return readFile(join(this.runDirectory, file), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				return undefined;
			}
			throw error;
		});
	}

	/**
	 * Waits for a writer worker's result file to change into a valid candidate.
	 *
	 * A writer holds `write`, so there is no receipt to check and none is needed:
	 * what makes the file attributable is that exactly one writer worker may be
	 * live and the parent's own mutation tools are denied while it is. What is
	 * still needed is that this delivery produced it, so the bytes must differ
	 * from the baseline taken before the message went out - an unchanged file is
	 * the previous round's answer - and the content must be a JSON object
	 * carrying a ladder decision, checked by the same predicate the implement
	 * gate uses.
	 */
	async waitForWriterResult(
		file: string,
		baselineBytes: string | undefined,
		timeoutMs?: number,
	): Promise<{ contentSha256: string; document: Record<string, unknown> }> {
		const limit = timeoutMs ?? this.dependencies.contractWaitTimeoutMs ?? CONTRACT_WAIT_TIMEOUT_MS;
		const interval = this.dependencies.contractPollIntervalMs ?? CONTRACT_POLL_INTERVAL_MS;
		const deadline = this.now().getTime() + limit;
		let last = `${file} was never written`;
		while (true) {
			const bytes = await this.readResultBytes(file);
			if (bytes === undefined) {
				last = `${file} does not exist`;
			} else if (bytes === baselineBytes) {
				last = `${file} is unchanged from before this delivery`;
			} else {
				let document: unknown;
				try {
					document = JSON.parse(bytes);
				} catch {
					document = undefined;
					last = `${file} is not parseable JSON`;
				}
				if (document !== undefined) {
					// Same predicate the implement-gate uses: throw-or-return RP-15 shape.
					try {
						parseLadderDecision(document);
						return {
							contentSha256: hashContractBytes(bytes),
							document: document as Record<string, unknown>,
						};
					} catch (error) {
						last = error instanceof Error ? error.message : String(error);
					}
				}
			}
			if (this.now().getTime() >= deadline) {
				throw new Error(`worker did not write ${file} within ${limit}ms: ${last}`);
			}
			await this.sleep(interval);
		}
	}

	/**
	 * Waits for a publication this capability made after the baseline.
	 *
	 * Deterministic and injectable: time comes from the bus's clock and waiting
	 * from its sleep, so a test crosses the bound without sleeping. Every poll
	 * re-reads receipt and contract together, so a receipt written after its
	 * contract - the only order `write_contract` uses - is never observed as a
	 * mismatch, and a contract with no receipt never becomes an answer.
	 */
	async waitForPublication(
		pin: ContractPin,
		baselinePublicationId: string | undefined,
		timeoutMs?: number,
	): Promise<{ receipt: PublicationReceipt; document: Record<string, unknown> }> {
		const limit = timeoutMs ?? this.dependencies.contractWaitTimeoutMs ?? CONTRACT_WAIT_TIMEOUT_MS;
		const interval = this.dependencies.contractPollIntervalMs ?? CONTRACT_POLL_INTERVAL_MS;
		const deadline = this.now().getTime() + limit;
		let last = "no attempt was made";
		while (true) {
			const outcome = await evaluatePublication({ pin, baselinePublicationId });
			if (outcome.kind === "accepted") {
				return { receipt: outcome.receipt, document: outcome.document };
			}
			last = describeRejection(outcome.rejection);
			if (this.now().getTime() >= deadline) {
				throw new Error(`worker did not publish ${pin.declaredPath} within ${limit}ms: ${last}`);
			}
			await this.sleep(interval);
		}
	}

	/**
	 * Asks a worker to publish and exit, then stops it.
	 *
	 * The grace is the point. Delivering "publish and exit" and signalling in the
	 * same breath does not stop a worker politely: the shutdown path clears the
	 * queue first, so a message that has only been queued is deleted before the
	 * worker ever runs it, and the publication it asked for never happens. So the
	 * message is delivered and *waited on* - for a fresh result from a role that
	 * produces one, for settlement from a role that does not - and only then is
	 * the worker signalled.
	 *
	 * The wait is bounded, and a worker that does not answer is still stopped:
	 * the force path is not optional, it is just no longer the first thing tried.
	 */
	async publishAndStop(
		agentId: string,
		graceMs?: number,
	): Promise<{ stopped: boolean; published?: string; graced: boolean; reason?: string }> {
		const worker = this.workers.get(agentId);
		if (worker === undefined) {
			return { stopped: false, graced: false };
		}
		const grace = graceMs ?? this.dependencies.stopGraceMs ?? STOP_GRACE_TIMEOUT_MS;
		let published: string | undefined;
		let reason: string | undefined;
		if (grace > 0) {
			try {
				if (ROLE_RESULT_FILE[worker.role] !== undefined) {
					const outcome = await this.communicate({
						agentId,
						message: STOP_MESSAGE,
						deliverAs: "followUp",
						expect: "result",
						timeoutMs: grace,
					});
					published = outcome.contractPath;
				} else {
					// Nothing to publish, but the turn in flight still gets to end.
					const settled = worker.launch.protocol.waitForSettled(grace);
					await this.communicate({
						agentId,
						message: STOP_MESSAGE,
						deliverAs: "followUp",
						expect: "ack",
					});
					await settled;
				}
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error);
			}
		}
		const stopped = await this.stop(agentId);
		return { stopped, published, graced: published !== undefined || reason === undefined, reason };
	}

	/**
	 * Asks every live worker to publish and exit, then stops each one.
	 *
	 * Unlike `stopAll`, this keeps the bus open: it is the polite path `agents_stop`
	 * takes when no agent id is named. A worker that times out still stops, and the
	 * remaining workers are still asked - one hung publication cannot leave the
	 * rest running. `stopAll` stays reserved for session shutdown and fatal cleanup,
	 * where the grace is skipped and the bus closes permanently.
	 */
	async publishAndStopAll(
		graceMs?: number,
	): Promise<Array<{ agentId: string; stopped: boolean; published?: string; graced: boolean; reason?: string }>> {
		const agentIds = await this.serialize(async () => {
			await this.reapUnlocked();
			return [...this.workers.keys()];
		});
		const outcomes: Array<{
			agentId: string;
			stopped: boolean;
			published?: string;
			graced: boolean;
			reason?: string;
		}> = [];
		for (const agentId of agentIds) {
			const outcome = await this.publishAndStop(agentId, graceMs);
			outcomes.push({ agentId, ...outcome });
		}
		return outcomes;
	}

	/**
	 * Stops one worker and releases what it held. Idempotent: stopping an unknown
	 * or already stopped worker is a no-op, so shutdown can be called twice.
	 */
	async stop(agentId: string): Promise<boolean> {
		return this.serialize(() => this.stopUnlocked(agentId));
	}

	private async stopUnlocked(agentId: string): Promise<boolean> {
		const worker = this.workers.get(agentId);
		if (worker === undefined) {
			return false;
		}
		await worker.launch.stop();
		if (worker.launch.isAlive() || this.isProcessAlive(worker.pid))
			throw new Error("worker termination is not confirmed; ownership remains held");
		if (this.peerRuntime) (await this.peerRuntime).deactivate(agentId);
		await releaseAllLeasesFor(this.runDirectory, worker.owner, this.leaseDependencies);
		await releaseWriterAuthority(this.cwd, worker.owner, this.leaseDependencies);
		this.workers.delete(agentId);
		worker.releaseAdmission();
		// Always close the protocol so waitForSettled timers (initialSettlement)
		// cannot keep the event loop alive after the worker is gone.
		worker.launch.protocol.close();
		return true;
	}

	/**
	 * Stops every worker.
	 *
	 * The whole transition is one serialized step and sets `closing` first, so a
	 * spawn that arrives while shutdown is running is refused rather than left
	 * behind it: taking a snapshot of ids outside the lock and stopping them one
	 * by one would let a concurrent spawn survive the shutdown that was supposed
	 * to end it.
	 */
	async stopAll(): Promise<void> {
		await this.serialize(async () => {
			this.closing = true;
			for (const agentId of [...this.workers.keys()]) {
				await this.stopUnlocked(agentId);
			}
			if (this.peerRuntime) await (await this.peerRuntime).close();
			unregisterLiveBus(this);
		});
	}

	/** Whether this bus has been shut down and will start nothing more. */
	get isClosing(): boolean {
		return this.closing;
	}

	async readLeases(): Promise<Record<string, LeaseRecord>> {
		return readLeasesFile(this.runDirectory, this.leaseDependencies);
	}

	async releaseDeadLeases(): Promise<void> {
		await releaseDeadLeases(this.runDirectory, this.leaseDependencies);
	}

	/**
	 * Takes an exclusive lease on one canonical path key, through the same
	 * cross-process lock a worker uses.
	 */
	async claim(agentId: string, pid: number, key: string): Promise<LeaseRecord> {
		const worker = this.workers.get(agentId);
		if (!worker || worker.pid !== pid || !worker.launch.isAlive() || !this.isProcessAlive(pid))
			throw new Error("claim from inactive process");
		const canonical = await this.claimKey(key);
		if (!worker.writePaths.some((scope) => scope === "." || scope === canonical || canonical.startsWith(`${scope}/`)))
			throw new Error("claim outside writer scope");
		return claimLease(
			this.runDirectory,
			{ agentId, pid, key: canonical, incarnation: worker.owner.incarnation },
			this.leaseDependencies,
		);
	}

	async release(agentId: string, key: string): Promise<boolean> {
		const worker = this.workers.get(agentId);
		if (!worker || !worker.launch.isAlive() || !this.isProcessAlive(worker.pid))
			throw new Error("release from inactive process");
		return releaseLease(
			this.runDirectory,
			{ agentId, pid: worker.pid, key: await this.claimKey(key), incarnation: worker.owner.incarnation },
			this.leaseDependencies,
		);
	}
}

/** Runtime-owned addressing shared by graph execution, tools and session discovery. */
export function getOrCreateBackgroundBus(
	cwd: string,
	runDirectory: string,
	jobId: string,
	dependencies: BusDependencies = {},
): BackgroundBus {
	const existing = registeredBuses().find((bus) => resolve(bus.runDirectory) === resolve(runDirectory));
	if (existing) return existing;
	const bus = new BackgroundBus(cwd, runDirectory, jobId, dependencies);
	registerLiveBus(bus);
	return bus;
}

export type { WorkerLaunch, WorkerLauncher } from "./launch.ts";
export type { WorkerRole } from "./roles.ts";
export { WORKER_RESULT_TIMEOUT_MS };
