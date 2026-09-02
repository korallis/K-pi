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

/**
 * The OpenAI client refuses to construct without some key. Local servers accept
 * anything, and the accounts hook decides what actually reaches the wire.
 */
export const LOCAL_CLIENT_PLACEHOLDER = "local";

/** Discovery is bounded: a server that never answers must not hang a session. */
export const LOCAL_DISCOVERY_TIMEOUT_MS = 2_000;

/** One local slot's origin, as the slot itself persisted it. */
export interface LocalSlotOrigin {
	slotId: string;
	baseUrl: string;
	/** Only set when the operator referenced a real credential. */
	secretRef?: string;
}

/**
 * A locally served model, pinned to the origin of the slot that serves it.
 *
 * `baseUrl` is the mechanism the fork's own request path uses — the
 * `openai-completions` client is constructed with `baseURL: model.baseUrl` —
 * so binding it here is what makes every inference request stay on the
 * configured server rather than a provider-wide guess.
 *
 * Cost is zero in every direction: AC-27.6's `(local) $0` is only truthful if
 * nothing on this path is ever priced.
 */
export function localModel(id: string, baseUrl: string, name = id): ProviderModelConfig {
	return {
		id,
		name,
		api: "openai-completions",
		baseUrl,
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

interface StoredLocalModel {
	id: string;
	name: string;
	baseUrl: string;
}

function readStoredEntries(poolId: LocalProviderId, agentDirectory?: string): StoredLocalModel[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(storedLocalModelsPath(poolId, agentDirectory), "utf8"));
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) {
				return [];
			}
			const candidate = entry as { id?: unknown; name?: unknown; baseUrl?: unknown };
			if (typeof candidate.id !== "string" || candidate.id.length === 0) {
				return [];
			}
			if (typeof candidate.baseUrl !== "string" || candidate.baseUrl.length === 0) {
				return [];
			}
			return [
				{
					id: candidate.id,
					name: typeof candidate.name === "string" ? candidate.name : candidate.id,
					baseUrl: candidate.baseUrl,
				},
			];
		});
	} catch {
		return [];
	}
}

/**
 * The last known catalog, rehydrated through the current defaults and bound
 * only to origins that are still configured.
 *
 * A stored entry whose server the operator has since removed is dropped rather
 * than pointed at a different one: an inference request must never be silently
 * rerouted to a host the model was not discovered on.
 */
export function readStoredLocalModels(
	poolId: LocalProviderId,
	agentDirectory?: string,
	slots?: readonly LocalSlotOrigin[],
): ProviderModelConfig[] | undefined {
	const entries = readStoredEntries(poolId, agentDirectory);
	const allowed = slots === undefined ? undefined : new Set(slots.map((slot) => slot.baseUrl));
	const models = entries
		.filter((entry) => allowed === undefined || allowed.has(entry.baseUrl))
		.map((entry) => localModel(entry.id, entry.baseUrl, entry.name));
	return models.length === 0 ? undefined : models;
}

function writeStoredLocalModels(
	poolId: LocalProviderId,
	models: readonly ProviderModelConfig[],
	agentDirectory?: string,
): void {
	const path = storedLocalModelsPath(poolId, agentDirectory);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	const entries: StoredLocalModel[] = models.map((entry) => ({
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl ?? "",
	}));
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

async function fetchJson(url: string, options: LocalDiscoveryOptions): Promise<{ ok: boolean; payload?: unknown }> {
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
 * Live discovery for one local server, bounded and origin-pinned. Every model
 * it returns carries that server's own base URL.
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
			return ids.map((id) => localModel(id, options.baseUrl));
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
	return ids === undefined ? undefined : ids.map((id) => localModel(id, options.baseUrl));
}

export interface LocalProviderDependencies {
	/** Every configured slot of a pool, each with the origin it persisted. */
	resolveSlots: (poolId: LocalProviderId) => Promise<readonly LocalSlotOrigin[]>;
	/** A token only for a slot whose `secretRef` names a real credential. */
	resolveToken?: (poolId: LocalProviderId, slotId: string) => Promise<string | undefined>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	agentDirectory?: string;
}

/**
 * Refreshes one pool's catalog across every configured slot, so two servers on
 * different origins each contribute their own models bound to their own origin.
 *
 * An unconfigured pool, an unreachable server, or a malformed list keeps the
 * last known catalog rather than replacing it with a guess. A reachable server
 * with nothing loaded is authoritative for this turn but is not stored over a
 * catalog that may still be valid.
 *
 * A model id served by two configured origins is ambiguous, so the first slot
 * in configuration order keeps it: rerouting a request to the other host would
 * be exactly the silent redirect AC-27.8 forbids.
 */
export async function refreshLocalModels(
	poolId: LocalProviderId,
	context: { allowNetwork: boolean; signal?: AbortSignal },
	dependencies: LocalProviderDependencies,
): Promise<ProviderModelConfig[]> {
	const slots = await dependencies.resolveSlots(poolId);
	const stored = readStoredLocalModels(poolId, dependencies.agentDirectory, slots) ?? [];
	if (!context.allowNetwork || slots.length === 0) {
		return stored;
	}

	const discovered: ProviderModelConfig[] = [];
	const seen = new Set<string>();
	let answered = false;
	for (const slot of slots) {
		const models = await discoverLocalModels(poolId, {
			baseUrl: slot.baseUrl,
			signal: context.signal,
			fetchImpl: dependencies.fetchImpl,
			timeoutMs: dependencies.timeoutMs,
			token: await dependencies.resolveToken?.(poolId, slot.slotId),
		});
		if (models === undefined) {
			continue;
		}
		answered = true;
		for (const model of models) {
			if (seen.has(model.id)) {
				continue;
			}
			seen.add(model.id);
			discovered.push(model);
		}
	}

	if (!answered) {
		return stored;
	}
	if (discovered.length === 0) {
		return [];
	}
	writeStoredLocalModels(poolId, discovered, dependencies.agentDirectory);
	return discovered;
}

/**
 * Registers the three first-party local providers.
 *
 * No provider-level `baseUrl` is ever set: a provider-wide origin would be a
 * guess that outranks nothing and could send a request to a host the operator
 * never configured. Every model carries its own origin instead, and a pool with
 * no stored catalog registers no models at all rather than a placeholder.
 */
export function registerLocalProviders(pi: ExtensionAPI, dependencies: LocalProviderDependencies): void {
	if (typeof pi.registerProvider !== "function") {
		return;
	}
	for (const poolId of LOCAL_PROVIDER_IDS) {
		// Registration is synchronous, so the stored origins are retained as they
		// were written; `refreshModels` rebinds them to the configured slots.
		const stored = readStoredLocalModels(poolId, dependencies.agentDirectory);
		pi.registerProvider(poolId, {
			name: LOCAL_PROVIDER_NAMES[poolId],
			api: "openai-completions",
			// A placeholder the OpenAI client needs to exist, never a credential
			// claim: the accounts hook replaces it with the slot's own token, or
			// removes the header entirely for a server that wants none.
			apiKey: LOCAL_CLIENT_PLACEHOLDER,
			authHeader: false,
			...(stored === undefined ? {} : { models: stored }),
			async refreshModels(context) {
				return refreshLocalModels(poolId, context, dependencies);
			},
		});
	}
}
