import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../config.ts";

export const POOL_IDS = [
	"anthropic",
	"openai",
	"openai-codex",
	"xai",
	"zai",
	"zai-coding-cn",
	"kimi-coding",
	"cursor",
	"llama",
	"ollama",
	"lmstudio",
	"local-openai",
] as const;

export type PoolId = (typeof POOL_IDS)[number];
export type PoolStrategy = "quota-first" | "round-robin" | "sticky";

/** NH-01: a credential-free `local` kind beside the two credentialed kinds. */
export type SlotKind = "oauth" | "api_key" | "local";

/** Pools served by a local server the operator runs. */
export const LOCAL_POOL_IDS: Record<string, true> = {
	llama: true,
	ollama: true,
	lmstudio: true,
	"local-openai": true,
};

export function isLocalPool(poolId: string): boolean {
	return LOCAL_POOL_IDS[poolId] === true;
}

/**
 * K-π pool id to the provider id that actually answers. `llama` is served by
 * Pi's own built-in `llama.cpp` provider, which K-π never registers.
 */
const PROVIDER_ID_BY_POOL: Record<string, string> = { llama: "llama.cpp" };

export function providerIdForPool(poolId: PoolId): string {
	return PROVIDER_ID_BY_POOL[poolId] ?? poolId;
}

/** The pool a model's provider id belongs to, or undefined when it is not ours. */
export function poolIdForProvider(providerId: string): PoolId | undefined {
	for (const [poolId, provider] of Object.entries(PROVIDER_ID_BY_POOL)) {
		if (provider === providerId) {
			return poolId as PoolId;
		}
	}
	return isPoolId(providerId) ? providerId : undefined;
}

export interface AccountSlot {
	id: string;
	kind: SlotKind;
	label?: string;
	warningAcceptedAt?: string;
	/**
	 * REQ-SL-01: the origin a `local` slot was configured with. Every request
	 * routed to the slot stays on it, so it is persisted rather than rediscovered.
	 */
	baseUrl?: string;
	/** Optional token name for a local server that wants one. Never a dummy. */
	secretRef?: string;
	/**
	 * This slot's grant is the one `auth.json` holds: the base runtime refreshes
	 * it on every request, K-π never does, and it has no `accounts.secrets.json`
	 * entry. At most one per pool, never on a `local` slot.
	 */
	official?: true;
	/**
	 * Why this slot can no longer authenticate (a revoked refresh token, an
	 * `auth.json` entry that vanished). Persisted so it stays unselectable across
	 * sessions until `/accounts login <pool> <slot>` rewrites its credential.
	 */
	needsLogin?: string;
}

export interface AccountPool {
	strategy: PoolStrategy;
	slots: AccountSlot[];
}

export interface AccountsDocument {
	version: 1;
	pools: Partial<Record<PoolId, AccountPool>>;
	fallback: PoolId[];
	stickiness: "session-until-exhausted";
}

export type AccountSecrets = Record<string, Credential>;

const DEFAULT_FALLBACK: PoolId[] = ["anthropic", "openai-codex", "xai", "zai", "kimi-coding", "cursor"];
const SLOT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function defaultAccounts(): AccountsDocument {
	return {
		version: 1,
		pools: {},
		fallback: [...DEFAULT_FALLBACK],
		stickiness: "session-until-exhausted",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const POOL_STRATEGIES = ["quota-first", "round-robin", "sticky"] as const;

export function isPoolStrategy(value: string): value is PoolStrategy {
	return (POOL_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Validates the persisted document field by field. A store that reloads is only
 * trustworthy if every pool id, strategy, slot and chain entry is checked on the
 * way in, not just the version number.
 */
function assertAccounts(value: unknown, path: string): asserts value is AccountsDocument {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isRecord(value.pools) ||
		!Array.isArray(value.fallback) ||
		value.stickiness !== "session-until-exhausted"
	) {
		throw new Error(`${path} is not a version 1 accounts store`);
	}
	for (const [poolName, pool] of Object.entries(value.pools)) {
		if (!isPoolId(poolName)) {
			throw new Error(`${path} has an unknown pool id: ${poolName}`);
		}
		if (!isRecord(pool) || typeof pool.strategy !== "string" || !isPoolStrategy(pool.strategy)) {
			throw new Error(`${path} pool ${poolName} has an unknown strategy`);
		}
		if (!Array.isArray(pool.slots)) {
			throw new Error(`${path} pool ${poolName} must define slots`);
		}
		const slotIds = new Set<string>();
		let officialSlots = 0;
		for (const slot of pool.slots) {
			if (!isRecord(slot) || typeof slot.id !== "string" || !SLOT_ID_PATTERN.test(slot.id)) {
				throw new Error(`${path} pool ${poolName} has an invalid slot id`);
			}
			if (slotIds.has(slot.id)) {
				throw new Error(`${path} pool ${poolName} has a duplicate slot id: ${slot.id}`);
			}
			slotIds.add(slot.id);
			if (slot.kind !== "oauth" && slot.kind !== "api_key" && slot.kind !== "local") {
				throw new Error(`${path} pool ${poolName} slot ${slot.id} has an unknown kind`);
			}
			if (slot.kind === "local") {
				if (typeof slot.baseUrl !== "string" || slot.baseUrl.length === 0) {
					throw new Error(`${path} pool ${poolName} slot ${slot.id} must persist its baseUrl`);
				}
				if (slot.secretRef !== undefined && (typeof slot.secretRef !== "string" || slot.secretRef.length === 0)) {
					throw new Error(`${path} pool ${poolName} slot ${slot.id} has an invalid secretRef`);
				}
			} else if (slot.baseUrl !== undefined) {
				throw new Error(`${path} pool ${poolName} slot ${slot.id} is not local but persists a baseUrl`);
			}
			// Optional fields still have a type: a label that is not a string, or
			// an acceptance stamp that is not an instant, is corruption, not absence.
			if (slot.label !== undefined && (typeof slot.label !== "string" || slot.label.length === 0)) {
				throw new Error(`${path} pool ${poolName} slot ${slot.id} has an invalid label`);
			}
			if (
				slot.warningAcceptedAt !== undefined &&
				(typeof slot.warningAcceptedAt !== "string" || Number.isNaN(Date.parse(slot.warningAcceptedAt)))
			) {
				throw new Error(`${path} pool ${poolName} slot ${slot.id} has an invalid warningAcceptedAt`);
			}
			if (slot.official !== undefined) {
				if (slot.official !== true) {
					throw new Error(`${path} pool ${poolName} slot ${slot.id} has an invalid official flag`);
				}
				if (slot.kind === "local") {
					throw new Error(`${path} pool ${poolName} slot ${slot.id} is local and cannot be official`);
				}
				officialSlots += 1;
				if (officialSlots > 1) {
					throw new Error(`${path} pool ${poolName} flags more than one official slot`);
				}
			}
			if (slot.needsLogin !== undefined && (typeof slot.needsLogin !== "string" || slot.needsLogin.length === 0)) {
				throw new Error(`${path} pool ${poolName} slot ${slot.id} has an invalid needsLogin`);
			}
		}
	}
	if (value.fallback.length === 0) {
		throw new Error(`${path} fallback must name at least one pool`);
	}
	const chain = new Set<string>();
	for (const entry of value.fallback) {
		if (typeof entry !== "string" || !isPoolId(entry)) {
			throw new Error(`${path} fallback has an unknown pool id: ${String(entry)}`);
		}
		if (chain.has(entry)) {
			throw new Error(`${path} fallback repeats ${entry}`);
		}
		chain.add(entry);
	}
}

/**
 * A credential K-π can actually route with. An official `auth.json` may hold
 * shapes from a newer Pi or a half-written file; those are skipped rather than
 * imported as a slot that would fail on its first request.
 */
function asRoutableCredential(value: unknown): Credential | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.type === "oauth") {
		return typeof value.access === "string" && value.access.length > 0 ? (value as unknown as Credential) : undefined;
	}
	if (value.type === "api_key") {
		return typeof value.key === "string" && value.key.length > 0 ? (value as unknown as Credential) : undefined;
	}
	return undefined;
}

/**
 * Whether two credentials are one grant. OAuth grants rotate their refresh
 * token and their access token independently, so either match is the same
 * lineage; keys are the same grant only when they are the same key.
 */
function sameGrant(a: Credential | undefined, b: Credential | undefined): boolean {
	if (a === undefined || b === undefined) {
		return false;
	}
	if (a.type === "oauth" && b.type === "oauth") {
		return a.refresh === b.refresh || a.access === b.access;
	}
	if (a.type === "api_key" && b.type === "api_key") {
		return a.key === b.key;
	}
	return false;
}

/** `default` first, then `slot-2`, `slot-3`, … — the first id the pool does not hold. */
function nextSlotIdIn(slots: readonly AccountSlot[]): string {
	if (!slots.some((slot) => slot.id === "default")) {
		return "default";
	}
	for (let index = 2; ; index += 1) {
		const candidate = `slot-${index}`;
		if (!slots.some((slot) => slot.id === candidate)) {
			return candidate;
		}
	}
}

function assertSecrets(value: unknown, path: string): asserts value is AccountSecrets {
	if (!isRecord(value)) {
		throw new Error(`${path} is not an account secrets object`);
	}
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporaryPath, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await file.sync();
		await file.close();
		await rename(temporaryPath, path);
		await chmod(path, 0o600);
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function secretKey(poolId: PoolId, slotId: string): string {
	return `${poolId}/${slotId}`;
}

function assertSlotId(slotId: string): void {
	if (!SLOT_ID_PATTERN.test(slotId)) {
		throw new Error(`Invalid account slot id: ${slotId}`);
	}
}

export function isPoolId(value: string): value is PoolId {
	return (POOL_IDS as readonly string[]).includes(value);
}

export class AccountsStore {
	readonly accountsPath: string;
	readonly secretsPath: string;
	readonly authPath: string;
	private mutations: Promise<void> = Promise.resolve();

	constructor(agentDirectory = getAgentDir()) {
		this.accountsPath = join(agentDirectory, "accounts.json");
		this.secretsPath = join(agentDirectory, "accounts.secrets.json");
		this.authPath = join(agentDirectory, "auth.json");
	}

	private async readAccountsUnlocked(): Promise<AccountsDocument> {
		const value = await readJson(this.accountsPath);
		if (value === undefined) {
			return defaultAccounts();
		}
		assertAccounts(value, this.accountsPath);
		return value;
	}

	private async readSecretsUnlocked(): Promise<AccountSecrets> {
		const value = await readJson(this.secretsPath);
		if (value === undefined) {
			return {};
		}
		assertSecrets(value, this.secretsPath);
		return value;
	}

	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutations.then(operation);
		this.mutations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async read(): Promise<AccountsDocument> {
		await this.mutations;
		return this.readAccountsUnlocked();
	}

	async readSecrets(): Promise<AccountSecrets> {
		await this.mutations;
		return this.readSecretsUnlocked();
	}

	async getSlot(poolId: PoolId, slotId: string): Promise<AccountSlot | undefined> {
		const document = await this.read();
		return document.pools[poolId]?.slots.find((slot) => slot.id === slotId);
	}

	async nextSlotId(poolId: PoolId): Promise<string> {
		return nextSlotIdIn((await this.read()).pools[poolId]?.slots ?? []);
	}

	/**
	 * The routable credential `auth.json` holds for a pool, read as plain JSON on
	 * purpose: the runtime's own reader would execute `!command` key values.
	 */
	async readOfficialCredential(poolId: PoolId): Promise<Credential | undefined> {
		const value = await readJson(this.authPath);
		return isRecord(value) ? asRoutableCredential(value[poolId]) : undefined;
	}

	/**
	 * Writes a slot's credential. A re-login heals a slot that needed one, so the
	 * merged slot drops `needsLogin`; `official` stays as stored, because whether
	 * this login is the grant `auth.json` now holds is settled by `claimOfficial`.
	 */
	async putSlot(poolId: PoolId, slot: AccountSlot, credential: Credential): Promise<void> {
		assertSlotId(slot.id);
		await this.mutate(async () => {
			const [document, secrets] = await Promise.all([this.readAccountsUnlocked(), this.readSecretsUnlocked()]);
			const pool = document.pools[poolId] ?? {
				strategy: "quota-first",
				slots: [],
			};
			const existingIndex = pool.slots.findIndex((existing) => existing.id === slot.id);
			const merged = existingIndex < 0 ? { ...slot } : { ...pool.slots[existingIndex], ...slot };
			delete merged.needsLogin;
			if (existingIndex < 0) {
				pool.slots.push(merged);
			} else {
				pool.slots[existingIndex] = merged;
			}
			document.pools[poolId] = pool;
			secrets[secretKey(poolId, slot.id)] = credential;

			await writePrivateJson(this.secretsPath, secrets);
			await writePrivateJson(this.accountsPath, document);
		});
	}

	/**
	 * Sets a pool's selection strategy. Validated before anything is written, so
	 * an unknown pool or strategy leaves the store exactly as it was.
	 */
	async setStrategy(poolId: PoolId, strategy: string): Promise<void> {
		if (!isPoolStrategy(strategy)) {
			throw new Error(`Unknown pool strategy: ${strategy}. Use ${POOL_STRATEGIES.join(" | ")}`);
		}
		await this.mutate(async () => {
			const document = await this.readAccountsUnlocked();
			const pool = document.pools[poolId];
			if (pool === undefined) {
				throw new Error(`No accounts configured for ${poolId}`);
			}
			pool.strategy = strategy;
			await writePrivateJson(this.accountsPath, document);
		});
	}

	/**
	 * Replaces the cross-family fallback order. Research targets are not pools
	 * and a repeated entry would make the order ambiguous, so both are refused
	 * before the write.
	 */
	async setChain(chain: readonly string[]): Promise<void> {
		if (chain.length === 0) {
			throw new Error("A fallback chain needs at least one pool");
		}
		const seen = new Set<string>();
		const validated: PoolId[] = [];
		for (const entry of chain) {
			if (!isPoolId(entry)) {
				throw new Error(`Unknown pool id: ${entry}`);
			}
			if (seen.has(entry)) {
				throw new Error(`Duplicate pool in the fallback chain: ${entry}`);
			}
			seen.add(entry);
			validated.push(entry);
		}
		await this.mutate(async () => {
			const document = await this.readAccountsUnlocked();
			document.fallback = validated;
			await writePrivateJson(this.accountsPath, document);
		});
	}

	/**
	 * Binds each pool's official slot to the grant `auth.json` holds, once per
	 * session start. One grant has one refresher: the official slot keeps no
	 * secrets copy, so the base runtime's rotation can never leave a dead
	 * duplicate behind. Binding is by content match first, then the legacy rule
	 * for a `default` copied by an older K-π (bound only when its copy is absent
	 * or an expired OAuth copy), else a fresh official slot. A flagged slot whose
	 * pool has vanished from `auth.json` is marked as needing a login. Secrets
	 * are moved or dropped, never returned, logged, or written near the repository.
	 */
	async reconcileOfficialCredentials(
		now: number,
	): Promise<{ imported: string[]; adopted: string[]; orphaned: string[] }> {
		return this.mutate(async () => {
			const [document, secrets, auth] = await Promise.all([
				this.readAccountsUnlocked(),
				this.readSecretsUnlocked(),
				readJson(this.authPath),
			]);
			const official = isRecord(auth) ? auth : {};
			const imported: string[] = [];
			const adopted: string[] = [];
			const orphaned: string[] = [];
			let accountsChanged = false;
			let secretsChanged = false;
			const dropSecret = (poolId: PoolId, slotId: string): void => {
				if (secrets[secretKey(poolId, slotId)] !== undefined) {
					delete secrets[secretKey(poolId, slotId)];
					secretsChanged = true;
				}
			};
			const flagOfficial = (poolId: PoolId, pool: AccountPool, slot: AccountSlot): void => {
				slot.official = true;
				dropSecret(poolId, slot.id);
				for (const sibling of pool.slots) {
					if (sibling === slot || sibling.official !== true) continue;
					delete sibling.official;
					// A sibling that was flagged held no secret: without the flag it
					// has no credential at all, which is a fact the operator must see.
					if (secrets[secretKey(poolId, sibling.id)] === undefined && sibling.needsLogin === undefined) {
						sibling.needsLogin = `its auth.json credential now belongs to ${slot.id}`;
					}
				}
				accountsChanged = true;
			};

			for (const [providerId, entry] of Object.entries(official)) {
				if (!isPoolId(providerId)) {
					continue;
				}
				// A malformed credential is skipped, and because every write happens
				// after the loop, skipping one cannot leave a partial import behind.
				const credential = asRoutableCredential(entry);
				if (credential === undefined) {
					continue;
				}
				const pool = document.pools[providerId] ?? { strategy: "quota-first" as const, slots: [] };
				const matched = pool.slots.find(
					(slot) => slot.kind !== "local" && sameGrant(credential, secrets[secretKey(providerId, slot.id)]),
				);
				if (matched !== undefined) {
					flagOfficial(providerId, pool, matched);
					document.pools[providerId] = pool;
					adopted.push(`${providerId}/${matched.id}`);
					continue;
				}
				const flagged = pool.slots.find((slot) => slot.official === true);
				if (flagged !== undefined) {
					if (secrets[secretKey(providerId, flagged.id)] === undefined) {
						// Already bound: the runtime's grant is this slot's, by construction.
						continue;
					}
					// Its secret is a different grant, so it is K-π-owned from now on.
					delete flagged.official;
					accountsChanged = true;
				}
				const legacyDefault = pool.slots.find((slot) => slot.id === "default");
				const legacySecret = legacyDefault === undefined ? undefined : secrets[secretKey(providerId, "default")];
				if (
					legacyDefault !== undefined &&
					legacyDefault.kind !== "local" &&
					(legacySecret === undefined ||
						(legacySecret.type === "oauth" && legacySecret.expires !== undefined && legacySecret.expires <= now))
				) {
					legacyDefault.kind = credential.type === "oauth" ? "oauth" : "api_key";
					flagOfficial(providerId, pool, legacyDefault);
					document.pools[providerId] = pool;
					adopted.push(`${providerId}/default`);
					continue;
				}
				const slotId = legacyDefault === undefined ? "default" : nextSlotIdIn(pool.slots);
				pool.slots.push({
					id: slotId,
					kind: credential.type === "oauth" ? "oauth" : "api_key",
					label: slotId,
					official: true,
				});
				document.pools[providerId] = pool;
				accountsChanged = true;
				imported.push(`${providerId}/${slotId}`);
			}

			for (const [poolName, pool] of Object.entries(document.pools)) {
				if (pool === undefined || !isPoolId(poolName)) continue;
				const flagged = pool.slots.find((slot) => slot.official === true);
				if (flagged === undefined || flagged.needsLogin !== undefined) continue;
				if (asRoutableCredential(official[poolName]) !== undefined) continue;
				flagged.needsLogin = `auth.json no longer holds a ${poolName} credential`;
				accountsChanged = true;
				orphaned.push(`${poolName}/${flagged.id}`);
			}

			if (secretsChanged) {
				await writePrivateJson(this.secretsPath, secrets);
			}
			if (accountsChanged) {
				await writePrivateJson(this.accountsPath, document);
			}
			return { imported, adopted, orphaned };
		});
	}

	/** Records why a slot can no longer authenticate; it stays unselectable until a login. */
	async markNeedsLogin(poolId: PoolId, slotId: string, reason: string): Promise<void> {
		assertSlotId(slotId);
		if (reason.length === 0) {
			throw new Error(`A needs-login reason for ${poolId}/${slotId} cannot be empty`);
		}
		await this.mutate(async () => {
			const document = await this.readAccountsUnlocked();
			const slot = document.pools[poolId]?.slots.find((candidate) => candidate.id === slotId);
			if (slot === undefined) {
				throw new Error(`Unknown account slot: ${poolId}/${slotId}`);
			}
			slot.needsLogin = reason;
			await writePrivateJson(this.accountsPath, document);
		});
	}

	/**
	 * After a pooled login: when the runtime persisted this slot's grant into
	 * `auth.json`, the slot becomes the pool's official slot and its secrets copy
	 * is dropped. The previously official sibling keeps `before` — the grant
	 * `auth.json` held until this login, read live just before it — as a
	 * K-π-refreshed secret; without one it is marked as needing a login.
	 */
	async claimOfficial(
		poolId: PoolId,
		slotId: string,
		before: Credential | undefined,
	): Promise<{ official: boolean; demoted?: string }> {
		assertSlotId(slotId);
		return this.mutate(async () => {
			const [document, secrets, auth] = await Promise.all([
				this.readAccountsUnlocked(),
				this.readSecretsUnlocked(),
				readJson(this.authPath),
			]);
			const current = isRecord(auth) ? asRoutableCredential(auth[poolId]) : undefined;
			if (!sameGrant(current, secrets[secretKey(poolId, slotId)])) {
				return { official: false };
			}
			const pool = document.pools[poolId];
			const slot = pool?.slots.find((candidate) => candidate.id === slotId);
			if (pool === undefined || slot === undefined) {
				throw new Error(`Unknown account slot: ${poolId}/${slotId}`);
			}
			delete secrets[secretKey(poolId, slotId)];
			slot.official = true;
			const previous = pool.slots.find((candidate) => candidate.id !== slotId && candidate.official === true);
			if (previous !== undefined) {
				delete previous.official;
				if (before !== undefined) {
					secrets[secretKey(poolId, previous.id)] = before;
				} else {
					previous.needsLogin = `its auth.json credential was replaced by the login of ${slotId}`;
				}
			}
			await writePrivateJson(this.secretsPath, secrets);
			await writePrivateJson(this.accountsPath, document);
			return previous === undefined ? { official: true } : { official: true, demoted: previous.id };
		});
	}

	/**
	 * Adds a credential-free `local` slot. No secrets file entry is written: a
	 * local server that wants no token must not be handed a placeholder one.
	 */
	async putLocalSlot(poolId: PoolId, slot: AccountSlot): Promise<void> {
		assertSlotId(slot.id);
		if (slot.kind !== "local") {
			throw new Error(`Slot ${slot.id} is not a local slot`);
		}
		if (typeof slot.baseUrl !== "string" || slot.baseUrl.length === 0) {
			throw new Error(`Local slot ${poolId}/${slot.id} needs a base URL`);
		}
		let origin: string;
		try {
			origin = new URL(slot.baseUrl).origin;
		} catch {
			throw new Error(`Local slot ${poolId}/${slot.id} has an invalid base URL: ${slot.baseUrl}`);
		}
		if (!isLocalPool(poolId)) {
			throw new Error(`${poolId} is not a local pool`);
		}
		void origin;
		await this.mutate(async () => {
			const document = await this.readAccountsUnlocked();
			const pool = document.pools[poolId] ?? { strategy: "round-robin" as const, slots: [] };
			const existingIndex = pool.slots.findIndex((existing) => existing.id === slot.id);
			if (existingIndex < 0) {
				pool.slots.push(slot);
			} else {
				pool.slots[existingIndex] = { ...pool.slots[existingIndex], ...slot };
			}
			document.pools[poolId] = pool;
			await writePrivateJson(this.accountsPath, document);
		});
	}

	/** The origin a local slot is pinned to, if it is a local slot. */
	async localBaseUrl(poolId: PoolId, slotId: string): Promise<string | undefined> {
		const slot = await this.getSlot(poolId, slotId);
		return slot?.kind === "local" ? slot.baseUrl : undefined;
	}

	async removeSlot(poolId: PoolId, slotId: string): Promise<boolean> {
		assertSlotId(slotId);
		return this.mutate(async () => {
			const document = await this.readAccountsUnlocked();
			const pool = document.pools[poolId];
			if (pool === undefined) {
				return false;
			}
			const remaining = pool.slots.filter((slot) => slot.id !== slotId);
			if (remaining.length === pool.slots.length) {
				return false;
			}
			if (remaining.length === 0) {
				delete document.pools[poolId];
			} else {
				pool.slots = remaining;
			}
			await writePrivateJson(this.accountsPath, document);

			const secrets = await this.readSecretsUnlocked();
			delete secrets[secretKey(poolId, slotId)];
			await writePrivateJson(this.secretsPath, secrets);
			return true;
		});
	}
}
