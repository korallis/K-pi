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
	private mutations: Promise<void> = Promise.resolve();

	constructor(agentDirectory = getAgentDir()) {
		this.accountsPath = join(agentDirectory, "accounts.json");
		this.secretsPath = join(agentDirectory, "accounts.secrets.json");
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
