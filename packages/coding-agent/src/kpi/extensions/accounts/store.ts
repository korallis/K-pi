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
export type SlotKind = "oauth" | "api_key";

export interface AccountSlot {
	id: string;
	kind: SlotKind;
	label?: string;
	warningAcceptedAt?: string;
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
		for (const slot of pool.slots) {
			if (!isRecord(slot) || typeof slot.id !== "string" || !SLOT_ID_PATTERN.test(slot.id)) {
				throw new Error(`${path} pool ${poolName} has an invalid slot id`);
			}
			if (slotIds.has(slot.id)) {
				throw new Error(`${path} pool ${poolName} has a duplicate slot id: ${slot.id}`);
			}
			slotIds.add(slot.id);
			if (slot.kind !== "oauth" && slot.kind !== "api_key") {
				throw new Error(`${path} pool ${poolName} slot ${slot.id} has an unknown kind`);
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
		const slots = (await this.read()).pools[poolId]?.slots ?? [];
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

	async putSlot(poolId: PoolId, slot: AccountSlot, credential: Credential): Promise<void> {
		assertSlotId(slot.id);
		await this.mutate(async () => {
			const [document, secrets] = await Promise.all([this.readAccountsUnlocked(), this.readSecretsUnlocked()]);
			const pool = document.pools[poolId] ?? {
				strategy: "quota-first",
				slots: [],
			};
			const existingIndex = pool.slots.findIndex((existing) => existing.id === slot.id);
			if (existingIndex < 0) {
				pool.slots.push(slot);
			} else {
				pool.slots[existingIndex] = { ...pool.slots[existingIndex], ...slot };
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
	 * Imports the official `auth.json` primary credential for each provider that
	 * is a K-π pool and has no `default` slot yet. The secret moves from one
	 * private agent-directory file to another and is never returned, logged, or
	 * written anywhere near the repository.
	 */
	async importOfficialCredentials(): Promise<string[]> {
		const value = await readJson(this.authPath);
		if (!isRecord(value)) {
			return [];
		}
		return this.mutate(async () => {
			const [document, secrets] = await Promise.all([this.readAccountsUnlocked(), this.readSecretsUnlocked()]);
			const imported: string[] = [];
			for (const [providerId, entry] of Object.entries(value)) {
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
				if (pool.slots.some((slot) => slot.id === "default")) {
					continue;
				}
				pool.slots.push({ id: "default", kind: credential.type === "oauth" ? "oauth" : "api_key", label: "default" });
				document.pools[providerId] = pool;
				secrets[secretKey(providerId, "default")] = credential;
				imported.push(`${providerId}/default`);
			}
			if (imported.length === 0) {
				return imported;
			}
			await writePrivateJson(this.secretsPath, secrets);
			await writePrivateJson(this.accountsPath, document);
			return imported;
		});
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
