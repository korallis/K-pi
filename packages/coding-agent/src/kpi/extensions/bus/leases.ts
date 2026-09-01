import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { isJsonObject } from "../graph/schema.ts";
import { atomicWrite } from "../run-store.ts";

/** How long a claim waits for the lock before it refuses. */
export const LEASE_LOCK_TIMEOUT_MS = 10_000;
/**
 * How long a lock nobody can be identified from must sit before it is a
 * leftover.
 *
 * This applies only to a lock whose contents cannot be parsed into an owner. A
 * lock naming a live process is never stale, however old it is: age is not
 * evidence that a holder is gone, and a long claim is not a crashed one.
 */
export const LEASE_LOCK_STALE_MS = 30_000;
const LEASE_LOCK_RETRY_MS = 5;

export interface LeaseRecord {
	agent_id: string;
	pid: number;
	at: string;
}

export interface LeaseDependencies {
	now?: () => Date;
	/** Liveness of a recorded pid. Injected so tests need no real processes. */
	isProcessAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	lockTimeoutMs?: number;
	lockStaleMs?: number;
	lockRetryMs?: number;
}

export function defaultIsProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		// Signal 0 asks the kernel whether the process exists without touching it.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists and belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

interface LockOwner {
	pid: number;
	/** Unique per acquisition, so a release can prove the lock is still ours. */
	nonce: string;
	at: string;
}

function parseLockOwner(contents: string): LockOwner | undefined {
	try {
		const parsed: unknown = JSON.parse(contents);
		if (
			isJsonObject(parsed) &&
			typeof parsed.pid === "number" &&
			typeof parsed.nonce === "string" &&
			typeof parsed.at === "string"
		) {
			return { pid: parsed.pid, nonce: parsed.nonce, at: parsed.at };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Takes the lock, or reports that someone else has it.
 *
 * The owner file is written and fsynced under a unique temporary name and only
 * then linked into place. `link` fails with `EEXIST` rather than replacing, so
 * the lock either appears complete or does not appear at all - there is no
 * moment when it exists but is still empty, which is the window that let an
 * unparseable-therefore-stale rule hand the same lock to two callers.
 */
async function acquireLock(path: string, payload: string): Promise<boolean> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(payload);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temporary, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
		return false;
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

export function leasesFilePath(runDirectory: string): string {
	return join(runDirectory, "leases.json");
}

export function leaseLockPath(runDirectory: string): string {
	return join(runDirectory, "leases.lock");
}

/**
 * Takes the lease lock, runs `operation`, and always releases it.
 *
 * The lock is a file created with `wx`, which is one atomic syscall: two
 * processes racing for it cannot both succeed, so this works across processes
 * and not merely across callers inside one. Waiting is bounded, so a claim
 * refuses rather than hanging. A lock whose owner died, or that is older than the
 * stale bound, is stolen - and only the exact leftover that was inspected is
 * removed, so a live holder that took the lock in between keeps it.
 */
export async function withLeaseLock<T>(
	runDirectory: string,
	operation: () => Promise<T>,
	dependencies: LeaseDependencies = {},
): Promise<T> {
	const now = dependencies.now ?? (() => new Date());
	const isAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
	const sleep = dependencies.sleep ?? defaultSleep;
	const timeoutMs = dependencies.lockTimeoutMs ?? LEASE_LOCK_TIMEOUT_MS;
	const staleMs = dependencies.lockStaleMs ?? LEASE_LOCK_STALE_MS;
	const retryMs = dependencies.lockRetryMs ?? LEASE_LOCK_RETRY_MS;
	const path = leaseLockPath(runDirectory);
	const deadline = now().getTime() + timeoutMs;
	// The lock lives in the run directory, which a first claim may reach before
	// anything else has created it.
	await mkdir(runDirectory, { recursive: true });

	const payload = `${JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: now().toISOString() } satisfies LockOwner)}\n`;

	while (!(await acquireLock(path, payload))) {
		const existing = await readFile(path, "utf8").catch(() => undefined);
		if (existing === undefined) {
			// Released between our attempt and our read: try again immediately.
			continue;
		}
		const holder = parseLockOwner(existing);

		if (holder !== undefined) {
			if (isAlive(holder.pid)) {
				// A live holder is never stolen from. Age is not evidence.
				if (now().getTime() >= deadline) {
					throw new Error(`lease lock held by pid ${holder.pid} was not released within ${timeoutMs}ms`);
				}
				await sleep(retryMs);
				continue;
			}
			// The holder is gone. Remove exactly the leftover that was inspected, so
			// a live holder that took the lock in between keeps it.
			const current = await readFile(path, "utf8").catch(() => undefined);
			if (current === existing) {
				await rm(path, { force: true }).catch(() => undefined);
			}
			continue;
		}

		// Nobody can be identified from this lock. It becomes a leftover only after
		// the stale bound has passed since it was last written, because a lock being
		// unreadable is not proof that it is abandoned.
		const info = await stat(path).catch(() => undefined);
		const age = info === undefined ? undefined : now().getTime() - info.mtimeMs;
		if (age !== undefined && age > staleMs) {
			const current = await readFile(path, "utf8").catch(() => undefined);
			if (current === existing) {
				await rm(path, { force: true }).catch(() => undefined);
			}
			continue;
		}
		if (now().getTime() >= deadline) {
			throw new Error(`lease lock is held by an unreadable owner and was not released within ${timeoutMs}ms`);
		}
		await sleep(retryMs);
	}

	try {
		return await operation();
	} finally {
		// Release only what is still ours: a lock we already lost belongs to
		// whoever holds it now, and removing it would hand out a second one.
		const current = await readFile(path, "utf8").catch(() => undefined);
		if (current === payload) {
			await rm(path, { force: true }).catch(() => undefined);
		}
	}
}

export async function readLeasesFile(
	runDirectory: string,
	dependencies: LeaseDependencies = {},
): Promise<Record<string, LeaseRecord>> {
	const now = dependencies.now ?? (() => new Date());
	try {
		const parsed: unknown = JSON.parse(await readFile(leasesFilePath(runDirectory), "utf8"));
		if (!isJsonObject(parsed)) {
			return {};
		}
		const leases: Record<string, LeaseRecord> = {};
		for (const [path, value] of Object.entries(parsed)) {
			if (isJsonObject(value) && typeof value.agent_id === "string" && typeof value.pid === "number") {
				leases[path] = {
					agent_id: value.agent_id,
					pid: value.pid,
					at: typeof value.at === "string" ? value.at : now().toISOString(),
				};
			}
		}
		return leases;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

async function writeLeasesFile(runDirectory: string, leases: Record<string, LeaseRecord>): Promise<void> {
	await atomicWrite(leasesFilePath(runDirectory), `${JSON.stringify(leases, null, 2)}\n`);
}

/**
 * Takes an exclusive lease on one canonical path key.
 *
 * Read, decide and write all happen inside the lock, so a sibling worker in
 * another process cannot read "free" at the same moment and write itself in. The
 * file is never updated from a snapshot taken outside the lock, which is exactly
 * what a lost update is.
 */
export async function claimLease(
	runDirectory: string,
	request: { agentId: string; pid: number; key: string },
	dependencies: LeaseDependencies = {},
): Promise<LeaseRecord> {
	const now = dependencies.now ?? (() => new Date());
	const isAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
	return withLeaseLock(
		runDirectory,
		async () => {
			const leases = await readLeasesFile(runDirectory, dependencies);
			const holder = leases[request.key];
			if (holder !== undefined && holder.agent_id !== request.agentId) {
				if (isAlive(holder.pid)) {
					throw new Error(`Path already claimed by ${holder.agent_id}: ${request.key}`);
				}
				delete leases[request.key];
			}
			const lease: LeaseRecord = { agent_id: request.agentId, pid: request.pid, at: now().toISOString() };
			leases[request.key] = lease;
			await writeLeasesFile(runDirectory, leases);
			return lease;
		},
		dependencies,
	);
}

export async function releaseLease(
	runDirectory: string,
	request: { agentId: string; key: string },
	dependencies: LeaseDependencies = {},
): Promise<boolean> {
	return withLeaseLock(
		runDirectory,
		async () => {
			const leases = await readLeasesFile(runDirectory, dependencies);
			if (leases[request.key]?.agent_id !== request.agentId) {
				return false;
			}
			delete leases[request.key];
			await writeLeasesFile(runDirectory, leases);
			return true;
		},
		dependencies,
	);
}

export async function releaseAllLeasesFor(
	runDirectory: string,
	agentId: string,
	dependencies: LeaseDependencies = {},
): Promise<void> {
	await withLeaseLock(
		runDirectory,
		async () => {
			const leases = await readLeasesFile(runDirectory, dependencies);
			let changed = false;
			for (const [key, lease] of Object.entries(leases)) {
				if (lease.agent_id === agentId) {
					delete leases[key];
					changed = true;
				}
			}
			if (changed) {
				await writeLeasesFile(runDirectory, leases);
			}
		},
		dependencies,
	);
}

/** A lease whose holder is gone is not a lease. */
export async function releaseDeadLeases(runDirectory: string, dependencies: LeaseDependencies = {}): Promise<void> {
	const isAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
	await withLeaseLock(
		runDirectory,
		async () => {
			const leases = await readLeasesFile(runDirectory, dependencies);
			let changed = false;
			for (const [key, lease] of Object.entries(leases)) {
				if (!isAlive(lease.pid)) {
					delete leases[key];
					changed = true;
				}
			}
			if (changed) {
				await writeLeasesFile(runDirectory, leases);
			}
		},
		dependencies,
	);
}
