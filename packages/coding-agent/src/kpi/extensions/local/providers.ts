import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import type { ExtensionAPI, ProviderModelConfig } from "../../../core/extensions/types.ts";

/** Pools K-π registers itself. `llama` is Pi's own `llama.cpp` and is not here. */
export type LocalProviderId = "ollama" | "lmstudio" | "local-openai";

export const LOCAL_PROVIDER_IDS: readonly LocalProviderId[] = ["ollama", "lmstudio", "local-openai"];

/**
 * AC-27.3 defaults. `local-openai` has none: the operator is asked, because
 * guessing an origin for an arbitrary server would be a silent redirect.
 */
export const DEFAULT_LOCAL_BASE_URLS: Record<LocalProviderId, string | undefined> = {
	ollama: "http://127.0.0.1:11434/v1",
	lmstudio: "http://127.0.0.1:1234/v1",
	"local-openai": undefined,
};

const LOCAL_PROVIDER_NAMES: Record<LocalProviderId, string> = {
	ollama: "Ollama",
	lmstudio: "LM Studio",
	"local-openai": "Local OpenAI-compatible",
};

/** Discovery is bounded: a server that never answers must not hang a session. */
export const LOCAL_DISCOVERY_TIMEOUT_MS = 2_000;

/**
 * A locally served model. Cost is zero in every direction: AC-27.6's `(local) $0`
 * is only truthful if nothing on this path is ever priced.
 */
export function localModel(id: string, name = id): ProviderModelConfig {
	return {
		id,
		name,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	};
}

export function storedLocalModelsPath(poolId: LocalProviderId, agentDirectory = getAgentDir()): string {
	return join(agentDirectory, `${poolId}-models.json`);
}

/**
 * The last known catalog for a pool, rehydrated through the current defaults so
 * a stale context window or price cannot outlive the release that wrote it.
 */
export function readStoredLocalModels(
	poolId: LocalProviderId,
	agentDirectory?: string,
): ProviderModelConfig[] | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(storedLocalModelsPath(poolId, agentDirectory), "utf8"));
		if (!Array.isArray(parsed)) {
			return undefined;
		}
		const models = parsed.flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) {
				return [];
			}
			const candidate = entry as { id?: unknown; name?: unknown };
			if (typeof candidate.id !== "string" || candidate.id.length === 0) {
				return [];
			}
			return [localModel(candidate.id, typeof candidate.name === "string" ? candidate.name : candidate.id)];
		});
		return models.length === 0 ? undefined : models;
	} catch {
		return undefined;
	}
}

function writeStoredLocalModels(
	poolId: LocalProviderId,
	models: readonly ProviderModelConfig[],
	agentDirectory?: string,
): void {
	const path = storedLocalModelsPath(poolId, agentDirectory);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(models, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch {
		// A catalog cache that cannot be written must never fail discovery.
	}
}

interface OpenAiModelList {
	data?: unknown;
}

interface OllamaTagList {
	models?: unknown;
}

/**
 * Exact server ids only. An entry without a usable string id is malformed
 * identity and is rejected rather than renamed or guessed at; extra fields are
 * ignored, and an empty list is a valid answer meaning "nothing is loaded".
 */
function readModelIds(entries: unknown, idField: "id" | "name"): string[] | undefined {
	if (!Array.isArray(entries)) {
		return undefined;
	}
	const ids: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) {
			return undefined;
		}
		const value = (entry as Record<string, unknown>)[idField];
		if (typeof value !== "string" || value.length === 0) {
			return undefined;
		}
		ids.push(value);
	}
	return ids;
}

export interface LocalDiscoveryOptions {
	baseUrl: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	/** Only sent when the operator configured a token for this server. */
	token?: string;
}

function discoveryHeaders(token: string | undefined): Record<string, string> | undefined {
	// No dummy credential: a server that wants none is sent none.
	return token === undefined || token.length === 0 ? undefined : { authorization: `Bearer ${token}` };
}

async function fetchJson(
	url: string,
	options: LocalDiscoveryOptions,
): Promise<{ ok: boolean; payload?: unknown }> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LOCAL_DISCOVERY_TIMEOUT_MS);
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetchImpl(url, {
			headers: discoveryHeaders(options.token),
			signal: controller.signal,
		});
		if (!response.ok) {
			return { ok: false };
		}
		return { ok: true, payload: (await response.json()) as unknown };
	} catch {
		return { ok: false };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}

function apiRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "");
}

/**
 * Live discovery for one local server, bounded and origin-pinned.
 *
 * `/v1/models` is the contract for every OpenAI-compatible server. Ollama's
 * `/api/tags` is consulted only when that list is unavailable, per AC-27.2, so
 * a working v1 endpoint is never second-guessed.
 */
export async function discoverLocalModels(
	poolId: LocalProviderId,
	options: LocalDiscoveryOptions,
): Promise<ProviderModelConfig[] | undefined> {
	const root = apiRoot(options.baseUrl);
	const list = await fetchJson(`${root}/models`, options);
	if (list.ok) {
		const ids = readModelIds((list.payload as OpenAiModelList | undefined)?.data, "id");
		if (ids !== undefined) {
			return ids.map((id) => localModel(id));
		}
		// A reachable but malformed v1 list is a defect, not an absent endpoint.
		return undefined;
	}

	if (poolId !== "ollama") {
		return undefined;
	}
	// Only now: the OpenAI-compatible list was unavailable.
	const tags = await fetchJson(`${apiRoot(root.replace(/\/v1$/u, ""))}/api/tags`, options);
	if (!tags.ok) {
		return undefined;
	}
	const ids = readModelIds((tags.payload as OllamaTagList | undefined)?.models, "name");
	return ids === undefined ? undefined : ids.map((id) => localModel(id));
}

export interface LocalProviderDependencies {
	/** The origin a pool's slot was configured with, read at refresh time. */
	resolveBaseUrl: (poolId: LocalProviderId) => Promise<string | undefined>;
	/** A token only when the operator configured one for that server. */
	resolveToken?: (poolId: LocalProviderId) => Promise<string | undefined>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	agentDirectory?: string;
}

/**
 * Refreshes one pool's catalog. An unconfigured pool, an unreachable server, a
 * malformed list, or an empty answer all keep the last known catalog rather
 * than replacing it with a guess; only a usable non-empty list is stored.
 */
export async function refreshLocalModels(
	poolId: LocalProviderId,
	context: { allowNetwork: boolean; signal?: AbortSignal },
	dependencies: LocalProviderDependencies,
): Promise<ProviderModelConfig[]> {
	const stored = readStoredLocalModels(poolId, dependencies.agentDirectory) ?? [];
	if (!context.allowNetwork) {
		return stored;
	}
	const baseUrl = await dependencies.resolveBaseUrl(poolId);
	if (baseUrl === undefined) {
		return stored;
	}
	const discovered = await discoverLocalModels(poolId, {
		baseUrl,
		signal: context.signal,
		fetchImpl: dependencies.fetchImpl,
		timeoutMs: dependencies.timeoutMs,
		token: await dependencies.resolveToken?.(poolId),
	});
	if (discovered === undefined) {
		return stored;
	}
	if (discovered.length === 0) {
		// A reachable server with nothing loaded: AC-27.1's "only loaded models
		// appear". The empty answer is authoritative for this turn but is not
		// stored over a catalog that may still be valid after a reload.
		return [];
	}
	writeStoredLocalModels(poolId, discovered, dependencies.agentDirectory);
	return discovered;
}

/**
 * Registers the three first-party local providers. No `models` array is frozen
 * in: the bootstrap list is the last known catalog, or nothing at all when the
 * pool has never been discovered.
 */
export function registerLocalProviders(pi: ExtensionAPI, dependencies: LocalProviderDependencies): void {
	if (typeof pi.registerProvider !== "function") {
		return;
	}
	for (const poolId of LOCAL_PROVIDER_IDS) {
		const stored = readStoredLocalModels(poolId, dependencies.agentDirectory);
		pi.registerProvider(poolId, {
			name: LOCAL_PROVIDER_NAMES[poolId],
			baseUrl: DEFAULT_LOCAL_BASE_URLS[poolId] ?? "http://127.0.0.1/v1",
			api: "openai-completions",
			authHeader: false,
			...(stored === undefined ? {} : { models: stored }),
			async refreshModels(context) {
				return refreshLocalModels(poolId, context, dependencies);
			},
		});
	}
}
