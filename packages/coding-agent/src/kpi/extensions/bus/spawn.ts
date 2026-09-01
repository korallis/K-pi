import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { appendEvent } from "../append-log.ts";
import { parseLadderDecision } from "../minimalist.ts";
import { readTaskForJob } from "../run-store.ts";
import { mintCapabilityId, mintWorkerDescriptor, type WorkerDescriptor } from "./identity.ts";
import { launchWorkerProcess, type WorkerLaunch, type WorkerLauncher } from "./launch.ts";
import {
	claimLease,
	defaultIsProcessAlive,
	type LeaseDependencies,
	type LeaseRecord,
	readLeasesFile,
	releaseAllLeasesFor,
	releaseDeadLeases,
	releaseLease,
} from "./leases.ts";
import {
	type CommunicateExpectation,
	type DeliverAs,
	WORKER_RESULT_TIMEOUT_MS,
	type WorkerDiagnostics,
} from "./protocol.ts";
import { isWriterToolSet, ROLE_RESULT_FILE, resolveRoleTools, type WorkerRole } from "./roles.ts";
import {
	type ContractPin,
	describeRejection,
	evaluatePublication,
	hashContractBytes,
	mintContractPin,
	type PublicationReceipt,
	readPublicationReceipt,
} from "./write-contract.ts";

/** Same-tree caps. In-process only: another K-π process is not counted. */
export const MAX_LIVE_WORKERS = 2;
export const MAX_LIVE_WRITERS = 1;

/** How long `expect: "result"` waits for an authoritative publication. */
export const CONTRACT_WAIT_TIMEOUT_MS = 120_000;
/** How long a stopping worker is given to publish before it is signalled. */
export const STOP_GRACE_TIMEOUT_MS = 60_000;
/** What a worker is told when it is being stopped. */
export const STOP_MESSAGE = "stop: publish your result file, then exit";
const CONTRACT_POLL_INTERVAL_MS = 50;

export interface WorkerRecord {
	agentId: string;
	role: WorkerRole;
	pid: number;
	sessionPath: string;
	sessionDirectory: string;
	tools: string[];
	isWriter: boolean;
	contractPin?: ContractPin;
	descriptor: WorkerDescriptor;
	launch: WorkerLaunch;
	spawnedAt: string;
	lastEvent: string;
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
}

/**
 * One job's background workers, their leases, and their logs.
 *
 * Two different serializations are at work here, because there are two different
 * kinds of shared state. The worker table and the logs live in this process, so
 * they are serialized by one promise chain. Leases live in a file that sibling
 * workers in other processes also write, so they are serialized by a lock in
 * that directory - the same primitive a worker-local `claim_path` uses.
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
	/** The serialization point for every in-process shared-state mutation. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Once closing, nothing new starts: shutdown cannot be outrun by a spawn. */
	private closing = false;

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
	}

	/** What the lease primitive needs, taken from this bus's own injections. */
	private get leaseDependencies(): LeaseDependencies {
		return {
			now: this.now,
			isProcessAlive: this.isProcessAlive,
			sleep: this.sleep,
			lockTimeoutMs: this.dependencies.lockTimeoutMs,
			lockStaleMs: this.dependencies.lockStaleMs,
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
			const alive = worker.launch.isAlive() && this.isProcessAlive(worker.pid);
			if (!alive) {
				this.workers.delete(agentId);
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

	/** Whether a live worker currently holds the single-writer slot. */
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
	 * The caps are checked, the identity minted, the session file created and the
	 * process launched inside one serialized step, so two concurrent spawns cannot
	 * both see one free slot and take it. Every failure after the process exists -
	 * the session bookkeeping, either log, the initial prompt - stops it again,
	 * because a worker nobody is tracking is a worker nobody will ever stop.
	 */
	async spawn(options: {
		role: WorkerRole;
		prompt: string;
		model?: string;
		tools?: readonly string[];
	}): Promise<WorkerRecord> {
		return this.serialize(async () => {
			if (this.closing) {
				throw new Error("this bus is shutting down and starts no new workers");
			}
			await this.reapUnlocked();
			const tools = resolveRoleTools(options.role, options.tools);
			const isWriter = isWriterToolSet(tools);
			if (this.workers.size >= MAX_LIVE_WORKERS) {
				throw new Error(`Background worker limit is ${MAX_LIVE_WORKERS}`);
			}
			if (isWriter && [...this.workers.values()].filter((worker) => worker.isWriter).length >= MAX_LIVE_WRITERS) {
				throw new Error("A writer worker is already live");
			}

			const agentId = `${options.role}-${(this.dependencies.newAgentSuffix ?? randomUUID)()}`;
			const capabilityId = (this.dependencies.newCapabilityId ?? mintCapabilityId)();
			const sessionDirectory = this.agentsDirectory;
			const sessionPath = join(sessionDirectory, `${agentId}.jsonl`);
			// The gates are read once, here, and travel with the worker. A later edit
			// to `task.json` cannot widen a shell that has already started.
			const task = await readTaskForJob(this.cwd, this.jobId).catch(() => undefined);
			const descriptor = mintWorkerDescriptor({
				agentId,
				jobId: this.jobId,
				role: options.role,
				runDirectory: this.runDirectory,
				tools,
				capabilityId,
				qualityGates: task?.quality_gates,
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

			const launch = await this.launcher({
				cwd: this.cwd,
				sessionPath,
				sessionDirectory,
				tools,
				model: options.model,
				descriptor,
				cliPath: this.dependencies.cliPath,
				execPath: this.dependencies.execPath,
				startupTimeoutMs: this.dependencies.startupTimeoutMs,
			});

			const record: WorkerRecord = {
				agentId,
				role: options.role,
				pid: launch.pid,
				sessionPath,
				sessionDirectory,
				tools,
				isWriter,
				contractPin,
				descriptor,
				launch,
				spawnedAt: this.now().toISOString(),
				lastEvent: "agent.spawned",
			};
			this.workers.set(agentId, record);

			try {
				await this.logSpawned({
					agent_id: agentId,
					role: options.role,
					pid: launch.pid,
					tools: [...tools],
					session_path: sessionPath,
				});
				// The initial delivery is a prompt, and its response is acceptance.
				await launch.protocol.prompt(options.prompt);
			} catch (error) {
				this.workers.delete(agentId);
				await launch.stop().catch(() => undefined);
				throw error;
			}
			return record;
		});
	}

	get(agentId: string): WorkerRecord | undefined {
		return this.workers.get(agentId);
	}

	list(): WorkerRecord[] {
		return [...this.workers.values()];
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

		if (expect === "none") {
			// Nothing is expected back, but the bytes still have to be taken by the
			// stream rather than queued in this process without limit.
			await worker.launch.protocol.send(
				deliverAs === "steer"
					? { type: "steer", message: options.message }
					: { type: "follow_up", message: options.message },
			);
			return { accepted: false };
		}

		if (expect === "ack") {
			await worker.launch.protocol.deliver(options.message, deliverAs);
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
			await worker.launch.protocol.deliver(options.message, deliverAs);
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
		this.workers.delete(agentId);
		await worker.launch.stop().catch(() => undefined);
		await releaseAllLeasesFor(this.runDirectory, agentId, this.leaseDependencies);
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
		return claimLease(this.runDirectory, { agentId, pid, key }, this.leaseDependencies);
	}

	async release(agentId: string, key: string): Promise<boolean> {
		return releaseLease(this.runDirectory, { agentId, key }, this.leaseDependencies);
	}
}

export { WORKER_RESULT_TIMEOUT_MS };
export type { WorkerLaunch, WorkerLauncher } from "./launch.ts";
export type { WorkerRole } from "./roles.ts";
