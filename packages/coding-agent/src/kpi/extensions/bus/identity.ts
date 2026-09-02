import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import { CONFIG_DIR_NAME } from "../../../config.ts";
import { isJsonObject } from "../graph/schema.ts";
import { readTaskForJob } from "../run-store.ts";
import { hasTestShellOnly, isWorkerRole, ROLE_CONTRACT_FILE, ROLE_TOOLS, type WorkerRole } from "./roles.ts";

/**
 * The one environment variable a worker is started with.
 *
 * Every identity field in it is re-checked against authoritative state on disk
 * before it grants anything, so a forged descriptor buys nothing it did not
 * already have. One field is different: `capabilityId` is the unforgeable half
 * of the publication receipt, known only to the parent and to this worker. It is
 * a bearer value. It is never logged, never put in a bus or job event, and never
 * returned in tool output or status.
 */
export const WORKER_DESCRIPTOR_ENV = "KPI_WORKER_DESCRIPTOR";

export class WorkerIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerIdentityError";
	}
}

/** What the parent mints before launch and the child may never widen. */
export interface WorkerDescriptor {
	readonly agentId: string;
	readonly jobId: string;
	readonly role: WorkerRole;
	/** Absolute run directory of the job this worker belongs to. */
	readonly runDirectory: string;
	/** The one run-contract path this role may publish, run-relative. */
	readonly contractPath?: string;
	/** The tools the parent launched it with, so dispatch can re-check them. */
	readonly tools: readonly string[];
	/** Bearer: proves a publication receipt came from this capability. */
	readonly capabilityId?: string;
	/**
	 * The job's quality gates as they stood when this worker was minted.
	 *
	 * Frozen on purpose. A test shell is authorised against this list and never
	 * against `task.json`, so editing the task after a worker starts cannot widen
	 * what that worker's shell may run. Only a role whose shell is a test shell
	 * carries any.
	 */
	readonly qualityGates?: readonly string[];
}

/**
 * A descriptor validated against the project it claims to belong to.
 *
 * `tools` is the intersection of what the parent launched and what the role is
 * ever allowed, so a forged descriptor listing `write` for a reviewer grants
 * nothing.
 */
export interface WorkerIdentity extends WorkerDescriptor {
	readonly cwd: string;
}

/** A capability id is minted once per worker and never re-derived. */
export function mintCapabilityId(): string {
	return randomUUID();
}

export function mintWorkerDescriptor(options: {
	agentId: string;
	jobId: string;
	role: WorkerRole;
	runDirectory: string;
	tools: readonly string[];
	capabilityId?: string;
	qualityGates?: readonly string[];
}): WorkerDescriptor {
	const contract = ROLE_CONTRACT_FILE[options.role];
	return Object.freeze({
		agentId: options.agentId,
		jobId: options.jobId,
		role: options.role,
		runDirectory: resolve(options.runDirectory),
		contractPath: contract?.file,
		tools: Object.freeze([...options.tools]),
		capabilityId: contract === undefined ? undefined : options.capabilityId,
		qualityGates: hasTestShellOnly(options.role) ? Object.freeze(normalizeGates(options.qualityGates)) : undefined,
	});
}

/** Gates as they are compared: trimmed, non-empty, order preserved, unique. */
function normalizeGates(gates: readonly unknown[] | undefined): string[] {
	const seen = new Set<string>();
	for (const gate of gates ?? []) {
		if (typeof gate === "string" && gate.trim().length > 0) {
			seen.add(gate.trim());
		}
	}
	return [...seen];
}

/** The fixed launch environment for one worker. */
export function descriptorEnv(descriptor: WorkerDescriptor): Record<string, string> {
	return { [WORKER_DESCRIPTOR_ENV]: JSON.stringify(descriptor) };
}

/**
 * The raw descriptor this process was started with, read once.
 *
 * Captured at module load, so a worker cannot rewrite its own identity later by
 * exporting a different value from a shell: the string this returns is the one
 * the parent set at launch.
 */
const RAW_DESCRIPTOR: string | undefined = process.env[WORKER_DESCRIPTOR_ENV];

export function rawWorkerDescriptor(env?: NodeJS.ProcessEnv): string | undefined {
	return env === undefined ? RAW_DESCRIPTOR : env[WORKER_DESCRIPTOR_ENV];
}

/** Whether this process is a worker at all. A parent session is not. */
export function hasWorkerDescriptor(env?: NodeJS.ProcessEnv): boolean {
	const raw = rawWorkerDescriptor(env);
	return typeof raw === "string" && raw.trim().length > 0;
}

function parseDescriptor(raw: string): WorkerDescriptor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new WorkerIdentityError(`${WORKER_DESCRIPTOR_ENV} is not valid JSON`);
	}
	if (!isJsonObject(parsed)) {
		throw new WorkerIdentityError(`${WORKER_DESCRIPTOR_ENV} is not an object`);
	}
	const { agentId, jobId, role, runDirectory, contractPath, tools, capabilityId, qualityGates } = parsed;
	if (typeof agentId !== "string" || agentId.trim().length === 0) {
		throw new WorkerIdentityError("worker descriptor has no agentId");
	}
	if (typeof jobId !== "string" || jobId.trim().length === 0) {
		throw new WorkerIdentityError("worker descriptor has no jobId");
	}
	if (!isWorkerRole(role)) {
		throw new WorkerIdentityError(`worker descriptor has an unknown role: ${String(role)}`);
	}
	if (typeof runDirectory !== "string" || !isAbsolute(runDirectory)) {
		throw new WorkerIdentityError("worker descriptor needs an absolute runDirectory");
	}
	if (!agentId.startsWith(`${role}-`)) {
		throw new WorkerIdentityError(`worker descriptor agentId ${agentId} does not belong to role ${role}`);
	}
	const declared = ROLE_CONTRACT_FILE[role]?.file;
	if (contractPath !== undefined && contractPath !== declared) {
		throw new WorkerIdentityError(
			`worker descriptor claims contract ${String(contractPath)}; role ${role} publishes ${declared ?? "nothing"}`,
		);
	}
	if (declared !== undefined && (typeof capabilityId !== "string" || capabilityId.trim().length === 0)) {
		throw new WorkerIdentityError(`role ${role} publishes ${declared} and needs a capability id`);
	}
	// The role's own allowance is the ceiling, whatever the descriptor says.
	const allowed = ROLE_TOOLS[role];
	const requested = Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : [];
	const granted = requested.filter((tool) => allowed.includes(tool));

	// A role with no test shell carries no gates, whatever the descriptor says.
	const gates = hasTestShellOnly(role)
		? Object.freeze(normalizeGates(Array.isArray(qualityGates) ? qualityGates : []))
		: undefined;

	return Object.freeze({
		agentId,
		jobId,
		role,
		runDirectory: resolve(runDirectory),
		contractPath: declared,
		tools: Object.freeze(granted),
		capabilityId: declared === undefined ? undefined : (capabilityId as string),
		qualityGates: gates,
	});
}

const validated = new Map<string, WorkerIdentity>();

/**
 * The validated identity of this worker process, or `undefined` in a parent.
 *
 * Everything the descriptor asserts is checked against the project it names: the
 * run directory exists, its name is the job id, `task.json` agrees, and the run
 * directory is the one this `cwd` would resolve for that job. A descriptor
 * pointing at another project, another job, or a directory that is not a run
 * grants nothing.
 */
export async function resolveWorkerIdentity(cwd: string, env?: NodeJS.ProcessEnv): Promise<WorkerIdentity | undefined> {
	const raw = rawWorkerDescriptor(env);
	if (raw === undefined || raw.trim().length === 0) {
		return undefined;
	}
	const key = `${resolve(cwd)}\u0000${raw}`;
	const cached = validated.get(key);
	if (cached !== undefined) {
		return cached;
	}

	const descriptor = parseDescriptor(raw);
	if (basename(descriptor.runDirectory) !== descriptor.jobId) {
		throw new WorkerIdentityError(
			`worker descriptor run directory ${descriptor.runDirectory} is not job ${descriptor.jobId}`,
		);
	}
	const expected = resolve(cwd, CONFIG_DIR_NAME, "runs", descriptor.jobId);
	if (expected !== descriptor.runDirectory) {
		throw new WorkerIdentityError(
			`worker descriptor belongs to another project: expected ${expected}, got ${descriptor.runDirectory}`,
		);
	}
	const info = await stat(descriptor.runDirectory).catch(() => undefined);
	if (info === undefined || !info.isDirectory()) {
		throw new WorkerIdentityError(`worker descriptor run directory does not exist: ${descriptor.runDirectory}`);
	}
	// The job's own contract has to agree that this job is this job.
	const task = await readTaskForJob(cwd, descriptor.jobId).catch(() => undefined);
	if (task === undefined) {
		throw new WorkerIdentityError(`worker descriptor names job ${descriptor.jobId}, which has no task.json`);
	}

	const identity: WorkerIdentity = Object.freeze({ ...descriptor, cwd: resolve(cwd) });
	validated.set(key, identity);
	return identity;
}

/** The identity, or a refusal. Used where a worker-only tool has been reached. */
export async function requireWorkerIdentity(cwd: string, env?: NodeJS.ProcessEnv): Promise<WorkerIdentity> {
	const identity = await resolveWorkerIdentity(cwd, env);
	if (identity === undefined) {
		throw new WorkerIdentityError(
			"this tool belongs to a background K-π worker; a parent session has no worker identity",
		);
	}
	return identity;
}

/** Re-checks at dispatch that this worker really holds the tool being used. */
export function authorizeWorkerTool(identity: WorkerIdentity, tool: string): void {
	if (!identity.tools.includes(tool)) {
		throw new WorkerIdentityError(`worker ${identity.agentId} (${identity.role}) does not hold ${tool}`);
	}
}

/** The absolute path of this worker's declared contract file, if it has one. */
export function contractAbsolutePath(identity: WorkerIdentity): string | undefined {
	return identity.contractPath === undefined ? undefined : join(identity.runDirectory, identity.contractPath);
}

/** Test seam: drops the validation cache so a new descriptor is re-checked. */
export function resetWorkerIdentityCache(): void {
	validated.clear();
}
