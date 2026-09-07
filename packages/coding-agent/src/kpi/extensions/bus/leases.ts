import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { CONFIG_DIR_NAME } from "../../../config.ts";
import { isJsonObject } from "../graph/schema.ts";
import { atomicWrite } from "../run-store.ts";
import { canonicalProjectPath } from "../stack.ts";

export const LEASE_LOCK_TIMEOUT_MS = 10_000;

/** A valid live holder is scheduler backpressure, not a model/provider failure. */
export class WorkspaceBusyError extends Error {
	readonly code = "WORKSPACE_BUSY";
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceBusyError";
	}
}

export interface LeaseOwner {
	jobId: string;
	agentId: string;
	pid: number;
	incarnation: string;
}

const sessionWriters = new Map<string, LeaseOwner>();
/** Host-only binding, pinned to a session and a single execution incarnation. */
export function bindSessionWriterAuthority(sessionId: string, owner: LeaseOwner): () => void {
	validateOwner(owner);
	if (!sessionId || owner.pid !== process.pid || sessionWriters.has(sessionId))
		throw new Error("session writer authority already bound or invalid");
	const bound = Object.freeze({ ...owner });
	sessionWriters.set(sessionId, bound);
	return () => {
		if (sessionWriters.get(sessionId) === bound) sessionWriters.delete(sessionId);
	};
}
export function sessionWriterAuthority(sessionId: string): LeaseOwner | undefined {
	return sessionWriters.get(sessionId);
}
export interface LeaseRecord {
	job_id: string;
	agent_id: string;
	pid: number;
	incarnation: string;
	at: string;
}
interface WriterAuthority extends LeaseRecord {
	paths: string[];
}
export interface LeaseDependencies {
	now?: () => Date;
	isProcessAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	lockTimeoutMs?: number;
	lockRetryMs?: number;
}
export function defaultIsProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Only ESRCH proves death. Permission/other kernel failures fail closed.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
const sleepDefault = (ms: number): Promise<void> => {
	const { promise, resolve: done } = Promise.withResolvers<void>();
	setTimeout(done, ms);
	return promise;
};
interface LockOwner {
	pid: number;
	nonce: string;
	at: string;
}
function parseLockOwner(contents: string): LockOwner | undefined {
	try {
		const value: unknown = JSON.parse(contents);
		if (
			isJsonObject(value) &&
			Number.isSafeInteger(value.pid) &&
			(value.pid as number) > 0 &&
			typeof value.nonce === "string" &&
			value.nonce.length > 0 &&
			typeof value.at === "string"
		)
			return value as unknown as LockOwner;
	} catch {
		/* Unidentifiable ownership is never automatically recovered. */
	}
	return undefined;
}
async function acquireLock(path: string, payload: string): Promise<boolean> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(payload);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temporary, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return false;
	} finally {
		await rm(temporary, { force: true });
	}
}
async function optionalRead(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}
export function leaseLockPath(directory: string): string {
	return join(directory, "leases.lock");
}
/**
 * Atomic hard-link acquisition, with a separately owned recovery gate. A
 * read/compare/unlink is NOT CAS: all dead-owner reapers must hold this gate.
 * The gate uses the same primitive, so even a reaper crash is recoverable, but
 * a stopped/live process and an unidentifiable owner are never stolen from.
 */
async function withLockPath<T>(path: string, operation: () => Promise<T>, dependencies: LeaseDependencies): Promise<T> {
	const now = dependencies.now ?? (() => new Date());
	const alive = (pid: number): boolean =>
		pid === process.pid || (dependencies.isProcessAlive ?? defaultIsProcessAlive)(pid);
	const sleep = dependencies.sleep ?? sleepDefault;
	const timeout = dependencies.lockTimeoutMs ?? LEASE_LOCK_TIMEOUT_MS;
	const deadline = now().getTime() + timeout;
	const payload = `${JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: now().toISOString() })}\n`;
	while (!(await acquireLock(path, payload))) {
		const existing = await optionalRead(path);
		if (existing === undefined) continue;
		const holder = parseLockOwner(existing);
		if (holder && !alive(holder.pid)) {
			await withLockPath(
				`${path}.recovery`,
				async () => {
					if ((await optionalRead(path)) === existing && !alive(holder.pid)) await rm(path, { force: true });
				},
				dependencies,
			);
			continue;
		}
		if (now().getTime() >= deadline) {
			const message = `lease lock held by ${holder ? `pid ${holder.pid}` : "an unreadable owner"} was not released within ${timeout}ms`;
			throw holder ? new WorkspaceBusyError(message) : new Error(message);
		}
		await sleep(dependencies.lockRetryMs ?? 5);
	}
	try {
		return await operation();
	} finally {
		if ((await optionalRead(path)) === payload) await rm(path, { force: true });
	}
}
export async function withLeaseLock<T>(
	directory: string,
	operation: () => Promise<T>,
	dependencies: LeaseDependencies = {},
): Promise<T> {
	await mkdir(directory, { recursive: true });
	return withLockPath(leaseLockPath(directory), operation, dependencies);
}

/** Run directories are fixed at <checkout>/.kpi/runs/<job>. */
function checkoutForRun(runDirectory: string): string {
	const run = resolve(runDirectory);
	if (basename(dirname(run)) !== "runs" || basename(dirname(dirname(run))) !== CONFIG_DIR_NAME) {
		throw new Error("lease run directory must belong to a checkout's .kpi/runs");
	}
	return dirname(dirname(dirname(run)));
}
export function leasesFilePath(runDirectory: string): string {
	return join(checkoutForRun(runDirectory), CONFIG_DIR_NAME, "ownership", "leases.json");
}
export async function workspaceOwnershipDirectory(cwd: string): Promise<string> {
	const root = await realpath(cwd);
	const directory = join(root, CONFIG_DIR_NAME, "ownership");
	// Refuse a symlink escape before creating or reading authority state.
	await canonicalProjectPath(root, directory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const actual = await realpath(directory);
	if (actual !== directory) throw new Error("workspace ownership directory must not be redirected by a symlink");
	return actual;
}
/** Resolve existing spelling (including case aliases) and preserve only missing suffixes. */
export async function canonicalLeasePath(cwd: string, path: string): Promise<string> {
	const root = await realpath(cwd);
	const key = await canonicalProjectPath(cwd, path);
	let target = join(root, key);
	const suffix: string[] = [];
	const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	// Path-scoped fencing cannot distinguish arbitrary hard-link aliases.
	if (info?.isFile() && info.nlink > 1) throw new Error("path ownership refuses multiply-linked files");
	while (true) {
		try {
			const existing = await realpath(target);
			const canonical = relative(root, join(existing, ...suffix.reverse()))
				.split(sep)
				.join("/");
			if (canonical === ".." || canonical.startsWith("../")) throw new Error("ownership path escapes the checkout");
			return canonical || ".";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || target === root) throw error;
			suffix.push(basename(target));
			target = dirname(target);
		}
	}
}
export function pathsOverlap(a: string, b: string): boolean {
	return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function containsPath(scope: string, key: string): boolean {
	return scope === "." || scope === key || key.startsWith(`${scope}/`);
}
export function leaseOwnedBy(record: LeaseRecord, owner: LeaseOwner): boolean {
	return (
		record.job_id === owner.jobId &&
		record.agent_id === owner.agentId &&
		record.pid === owner.pid &&
		record.incarnation === owner.incarnation
	);
}
function validateOwner(owner: LeaseOwner): void {
	if (!owner.jobId || !owner.agentId || !owner.incarnation || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
		throw new Error("invalid lease owner identity");
}
function recordFor(owner: LeaseOwner, dependencies: LeaseDependencies): LeaseRecord {
	validateOwner(owner);
	return {
		job_id: owner.jobId,
		agent_id: owner.agentId,
		pid: owner.pid,
		incarnation: owner.incarnation,
		at: (dependencies.now ?? (() => new Date()))().toISOString(),
	};
}
function validRecord(value: unknown): value is LeaseRecord {
	return (
		isJsonObject(value) &&
		typeof value.job_id === "string" &&
		value.job_id.length > 0 &&
		typeof value.agent_id === "string" &&
		value.agent_id.length > 0 &&
		typeof value.incarnation === "string" &&
		value.incarnation.length > 0 &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		typeof value.at === "string"
	);
}
function validKey(key: unknown): key is string {
	return (
		typeof key === "string" &&
		(key === "." || key.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."))
	);
}
function validLeaseEntry(key: string, value: unknown): value is LeaseRecord {
	return validKey(key) && validRecord(value);
}
function validAuthorityEntry(key: string, value: unknown): value is WriterAuthority {
	return (
		isJsonObject(value) &&
		validRecord(value) &&
		key === JSON.stringify([value.job_id, value.agent_id]) &&
		Array.isArray(value.paths) &&
		value.paths.length > 0 &&
		value.paths.every(validKey)
	);
}
function validRecords<T extends LeaseRecord>(
	value: unknown,
	validEntry: (key: string, entry: unknown) => entry is T,
): value is Record<string, T> {
	if (!isJsonObject(value)) return false;
	for (const key in value) {
		if (Object.hasOwn(value, key) && !validEntry(key, value[key])) return false;
	}
	return true;
}
async function readRecords<T extends LeaseRecord>(
	path: string,
	validEntry: (key: string, value: unknown) => value is T,
): Promise<Record<string, T>> {
	const bytes = await optionalRead(path);
	if (bytes === undefined) return {};
	const parsed: unknown = JSON.parse(bytes);
	if (!validRecords(parsed, validEntry)) throw new Error(`invalid ownership records: ${path}`);
	return parsed;
}
async function store(directory: string, name: string, value: unknown): Promise<void> {
	await atomicWrite(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}
async function state(
	directory: string,
	dependencies: LeaseDependencies,
): Promise<{ leases: Record<string, LeaseRecord>; authorities: Record<string, WriterAuthority> }> {
	const leases = await readRecords(join(directory, "leases.json"), validLeaseEntry);
	const authorities = await readRecords(join(directory, "writers.json"), validAuthorityEntry);
	const alive = (pid: number): boolean =>
		pid === process.pid || (dependencies.isProcessAlive ?? defaultIsProcessAlive)(pid);
	for (const [key, lease] of Object.entries(leases)) if (!alive(lease.pid)) delete leases[key];
	for (const [key, authority] of Object.entries(authorities)) if (!alive(authority.pid)) delete authorities[key];
	return { leases, authorities };
}
function rejectOverlap(
	key: string,
	owner: LeaseOwner,
	leases: Record<string, LeaseRecord>,
	authorities: Record<string, WriterAuthority>,
): void {
	for (const [held, lease] of Object.entries(leases)) {
		if (pathsOverlap(key, held) && !leaseOwnedBy(lease, owner))
			throw new WorkspaceBusyError(`Path already claimed by ${lease.agent_id} (job ${lease.job_id}): ${key}`);
	}
	for (const authority of Object.values(authorities)) {
		if (!leaseOwnedBy(authority, owner) && authority.paths.some((held) => pathsOverlap(key, held))) {
			throw new WorkspaceBusyError(
				`A writer worker is already live: ${authority.agent_id} (job ${authority.job_id}) owns ${key}`,
			);
		}
	}
}
/** Reserve before launch; transfer to the child PID before any mutation is authorised. */
export async function reserveWriterAuthority(
	cwd: string,
	owner: LeaseOwner,
	paths: readonly string[] = ["."],
	dependencies: LeaseDependencies = {},
): Promise<void> {
	validateOwner(owner);
	if (paths.length === 0) throw new Error("writer authority needs at least one path");
	const directory = await workspaceOwnershipDirectory(cwd);
	await withLeaseLock(
		directory,
		async () => {
			const keys = [
				...new Set(await Promise.all(paths.map((path) => (path === "." ? "." : canonicalLeasePath(cwd, path))))),
			];
			const { leases, authorities } = await state(directory, dependencies);
			for (const key of keys) rejectOverlap(key, owner, leases, authorities);
			const id = JSON.stringify([owner.jobId, owner.agentId]);
			if (authorities[id] && !leaseOwnedBy(authorities[id], owner))
				throw new WorkspaceBusyError("writer incarnation still owns authority");
			authorities[id] = { ...recordFor(owner, dependencies), paths: keys };
			await store(directory, "writers.json", authorities);
		},
		dependencies,
	);
}
export async function transferWriterAuthority(
	cwd: string,
	owner: LeaseOwner,
	pid: number,
	dependencies: LeaseDependencies = {},
): Promise<LeaseOwner> {
	const next = { ...owner, pid };
	validateOwner(next);
	const directory = await workspaceOwnershipDirectory(cwd);
	await withLeaseLock(
		directory,
		async () => {
			const authorities = await readRecords(join(directory, "writers.json"), validAuthorityEntry);
			const authority = authorities[JSON.stringify([owner.jobId, owner.agentId])];
			if (!authority || !leaseOwnedBy(authority, owner))
				throw new Error("writer authority transfer from stale owner");
			authority.pid = pid;
			await store(directory, "writers.json", authorities);
		},
		dependencies,
	);
	return next;
}
export async function releaseWriterAuthority(
	cwd: string,
	owner: LeaseOwner,
	dependencies: LeaseDependencies = {},
): Promise<boolean> {
	const directory = await workspaceOwnershipDirectory(cwd);
	return withLeaseLock(
		directory,
		async () => {
			const authorities = await readRecords(join(directory, "writers.json"), validAuthorityEntry);
			const id = JSON.stringify([owner.jobId, owner.agentId]);
			if (!authorities[id] || !leaseOwnedBy(authorities[id], owner)) return false;
			delete authorities[id];
			await store(directory, "writers.json", authorities);
			return true;
		},
		dependencies,
	);
}
export async function assertWriterAuthority(
	cwd: string,
	owner: LeaseOwner,
	path?: string,
	dependencies: LeaseDependencies = {},
	requireClaim = true,
): Promise<void> {
	const directory = await workspaceOwnershipDirectory(cwd);
	await withLeaseLock(
		directory,
		async () => {
			const key = path === undefined ? "." : await canonicalLeasePath(cwd, path);
			const { leases, authorities } = await state(directory, dependencies);
			const authority = authorities[JSON.stringify([owner.jobId, owner.agentId])];
			if (
				!authority ||
				!leaseOwnedBy(authority, owner) ||
				!authority.paths.some((scope) => containsPath(scope, key))
			)
				throw new Error("peer has no current writer authority for this path");
			rejectOverlap(key, owner, leases, authorities);
			if (
				requireClaim &&
				path !== undefined &&
				!Object.entries(leases).some(([scope, lease]) => leaseOwnedBy(lease, owner) && containsPath(scope, key))
			) {
				throw new Error(`claim_path required before mutating ${key}`);
			}
		},
		dependencies,
	);
}
export async function readLeasesFile(
	runDirectory: string,
	_dependencies: LeaseDependencies = {},
): Promise<Record<string, LeaseRecord>> {
	const directory = await workspaceOwnershipDirectory(checkoutForRun(runDirectory));
	return readRecords(join(directory, "leases.json"), validLeaseEntry);
}
type ClaimRequest = { agentId: string; pid: number; key: string; incarnation: string };
function runOwner(runDirectory: string, request: Omit<ClaimRequest, "key">): LeaseOwner {
	return {
		jobId: basename(runDirectory),
		agentId: request.agentId,
		pid: request.pid,
		incarnation: request.incarnation,
	};
}
export async function claimLease(
	runDirectory: string,
	request: ClaimRequest,
	dependencies: LeaseDependencies = {},
): Promise<LeaseRecord> {
	const cwd = checkoutForRun(runDirectory);
	const directory = await workspaceOwnershipDirectory(cwd);
	const owner = runOwner(runDirectory, request);
	validateOwner(owner);
	return withLeaseLock(
		directory,
		async () => {
			const key = await canonicalLeasePath(cwd, request.key);
			const { leases, authorities } = await state(directory, dependencies);
			rejectOverlap(key, owner, leases, authorities);
			const lease = recordFor(owner, dependencies);
			Object.defineProperty(leases, key, { value: lease, enumerable: true, configurable: true, writable: true });
			await store(directory, "leases.json", leases);
			return lease;
		},
		dependencies,
	);
}
export async function releaseLease(
	runDirectory: string,
	request: ClaimRequest,
	dependencies: LeaseDependencies = {},
): Promise<boolean> {
	const cwd = checkoutForRun(runDirectory);
	const directory = await workspaceOwnershipDirectory(cwd);
	return withLeaseLock(
		directory,
		async () => {
			const key = await canonicalLeasePath(cwd, request.key);
			const leases = await readRecords(join(directory, "leases.json"), validLeaseEntry);
			if (!leases[key] || !leaseOwnedBy(leases[key], runOwner(runDirectory, request))) return false;
			delete leases[key];
			await store(directory, "leases.json", leases);
			return true;
		},
		dependencies,
	);
}
export async function releaseAllLeasesFor(
	runDirectory: string,
	owner: LeaseOwner,
	dependencies: LeaseDependencies = {},
): Promise<void> {
	if (owner.jobId !== basename(runDirectory)) throw new Error("lease cleanup belongs to another job");
	const directory = await workspaceOwnershipDirectory(checkoutForRun(runDirectory));
	await withLeaseLock(
		directory,
		async () => {
			const leases = await readRecords(join(directory, "leases.json"), validLeaseEntry);
			for (const [key, lease] of Object.entries(leases)) if (leaseOwnedBy(lease, owner)) delete leases[key];
			await store(directory, "leases.json", leases);
		},
		dependencies,
	);
}
export async function releaseDeadLeases(runDirectory: string, dependencies: LeaseDependencies = {}): Promise<void> {
	const directory = await workspaceOwnershipDirectory(checkoutForRun(runDirectory));
	await withLeaseLock(
		directory,
		async () => {
			const { leases, authorities } = await state(directory, dependencies);
			await store(directory, "leases.json", leases);
			await store(directory, "writers.json", authorities);
		},
		dependencies,
	);
}
