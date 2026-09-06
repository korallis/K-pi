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

/** Native model fields that a server or operator can explicitly supply. */
export type LocalModelMetadata = Partial<
	Pick<ProviderModelConfig, "contextWindow" | "maxTokens" | "reasoning" | "input">
>;
type MetadataSource = "discovery" | "operator";
type MetadataSources = Partial<Record<keyof LocalModelMetadata, MetadataSource>>;

export interface LocalProviderModel extends ProviderModelConfig {
	baseUrl: string;
	/** An absent field is unknown, not a capability inferred from the model id. */
	metadataSources: MetadataSources;
}

function positiveCapacity(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
export function localModel(
	id: string,
	baseUrl: string,
	name = id,
	metadata: LocalModelMetadata = {},
	sources: MetadataSources = {},
): LocalProviderModel {
	const model: LocalProviderModel = {
		id,
		name,
		api: "openai-completions",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
		metadataSources: {},
	};
	for (const field of ["contextWindow", "maxTokens"] as const) {
		if (positiveCapacity(metadata[field])) {
			model[field] = metadata[field];
			model.metadataSources[field] = sources[field] ?? "operator";
		}
	}
	if (typeof metadata.reasoning === "boolean") {
		model.reasoning = metadata.reasoning;
		model.metadataSources.reasoning = sources.reasoning ?? "operator";
	}
	if (
		Array.isArray(metadata.input) &&
		metadata.input.length > 0 &&
		metadata.input.every((value) => value === "text" || value === "image")
	) {
		model.input = [...metadata.input];
		model.metadataSources.input = sources.input ?? "operator";
	}
	return model;
}

export function storedLocalModelsPath(poolId: LocalProviderId, agentDirectory = getAgentDir()): string {
	return join(agentDirectory, `${poolId}-models.json`);
}

function readStoredCatalog(
	poolId: LocalProviderId,
	agentDirectory?: string,
): { models: LocalProviderModel[]; origins: Map<string, string> } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(storedLocalModelsPath(poolId, agentDirectory), "utf8"));
		const catalog = parsed as { version?: unknown; models?: unknown; origins?: unknown } | null;
		const current = !Array.isArray(parsed) && catalog?.version === 2;
		const entries = current ? catalog?.models : parsed;
		if (!Array.isArray(entries)) {
			return { models: [], origins: new Map() };
		}
		const models = entries.flatMap((entry) => {
			if (typeof entry !== "object" || entry === null) {
				return [];
			}
			const candidate = entry as Record<string, unknown>;
			if (typeof candidate.id !== "string" || candidate.id.length === 0) {
				return [];
			}
			if (typeof candidate.baseUrl !== "string" || candidate.baseUrl.length === 0) {
				return [];
			}
			const metadata: Record<string, unknown> = {};
			const sources: MetadataSources = {};
			// Legacy arrays included generated defaults. Only the versioned cache
			// with explicit provenance is allowed to restore capability metadata.
			if (current && typeof candidate.metadataSources === "object" && candidate.metadataSources !== null) {
				const recorded = candidate.metadataSources as Record<string, unknown>;
				for (const field of ["contextWindow", "maxTokens", "reasoning", "input"] as const) {
					const source = recorded[field];
					if (source === "discovery" || source === "operator") {
						metadata[field] = candidate[field];
						sources[field] = source;
					}
				}
			}
			return [
				localModel(
					candidate.id,
					candidate.baseUrl,
					typeof candidate.name === "string" ? candidate.name : candidate.id,
					metadata,
					sources,
				),
			];
		});
		const origins = new Map(models.map((model) => [model.id, model.baseUrl]));
		if (current && typeof catalog?.origins === "object" && catalog.origins !== null) {
			for (const [id, baseUrl] of Object.entries(catalog.origins)) {
				if (id.length > 0 && typeof baseUrl === "string" && baseUrl.length > 0) {
					origins.set(id, baseUrl);
				}
			}
		}
		return { models: models.filter((model) => origins.get(model.id) === model.baseUrl), origins };
	} catch {
		return { models: [], origins: new Map() };
	}
}

/**
 * The last known catalog, retaining only sourced metadata and origins that
 * are still configured.
 *
 * A stored entry whose server the operator has since removed is dropped rather
 * than pointed at a different one: an inference request must never be silently
 * rerouted to a host the model was not discovered on.
 */
export function readStoredLocalModels(
	poolId: LocalProviderId,
	agentDirectory?: string,
	slots?: readonly LocalSlotOrigin[],
): LocalProviderModel[] | undefined {
	const { models: entries } = readStoredCatalog(poolId, agentDirectory);
	const allowed = slots === undefined ? undefined : new Set(slots.map((slot) => slot.baseUrl));
	const models = entries.filter((entry) => allowed === undefined || allowed.has(entry.baseUrl));
	return models.length === 0 ? undefined : models;
}

function writeStoredLocalModels(
	poolId: LocalProviderId,
	models: readonly LocalProviderModel[],
	origins: ReadonlyMap<string, string>,
	agentDirectory?: string,
): void {
	const path = storedLocalModelsPath(poolId, agentDirectory);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	const catalog = { version: 2, models, origins: Object.fromEntries(origins) };
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
 * Only explicit fields on the existing discovery response are used. OpenAI's
 * standard list and Ollama tags do not specify capacities; native model-config
 * extensions and LM Studio's documented max_context_length can supply them.
 */
function readDiscoveredModels(
	entries: unknown,
	idField: "id" | "name",
	baseUrl: string,
): LocalProviderModel[] | undefined {
	if (!Array.isArray(entries)) {
		return undefined;
	}
	const models: LocalProviderModel[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) {
			return undefined;
		}
		const candidate = entry as Record<string, unknown>;
		const id = candidate[idField];
		if (typeof id !== "string" || id.length === 0) {
			return undefined;
		}
		// These entries cannot satisfy the local chat contract. In particular,
		// Ollama explicitly labels remote models; they are not free local models.
		if (
			candidate.type === "embedding" ||
			candidate.type === "embeddings" ||
			candidate.remote_host ||
			candidate.remote_model
		) {
			continue;
		}
		const metadata = {
			contextWindow: candidate.contextWindow ?? candidate.max_context_length,
			maxTokens: candidate.maxTokens,
			reasoning: candidate.reasoning,
			input: candidate.input ?? (candidate.type === "vlm" ? ["text", "image"] : undefined),
		} as LocalModelMetadata;
		models.push(
			localModel(id, baseUrl, typeof candidate.name === "string" ? candidate.name : id, metadata, {
				contextWindow: "discovery",
				maxTokens: "discovery",
				reasoning: "discovery",
				input: "discovery",
			}),
		);
	}
	return models;
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
): Promise<LocalProviderModel[] | undefined> {
	const root = apiRoot(options.baseUrl);
	const list = await fetchJson(`${root}/models`, options);
	if (list.ok) {
		// A reachable but malformed v1 list is a defect, not an absent endpoint.
		return readDiscoveredModels((list.payload as OpenAiModelList | undefined)?.data, "id", options.baseUrl);
	}

	if (poolId !== "ollama") {
		return undefined;
	}
	// Only now: the OpenAI-compatible list was unavailable.
	const tags = await fetchJson(`${apiRoot(root.replace(/\/v1$/u, ""))}/api/tags`, options);
	if (!tags.ok) {
		return undefined;
	}
	return readDiscoveredModels((tags.payload as OllamaTagList | undefined)?.models, "name", options.baseUrl);
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
 * A previously cached model id stays bound to its configured origin, even if
 * that origin is unreachable or answers empty. New duplicate ids use the first
 * configured slot; subsequent refreshes do not silently switch their origin.
 */
export async function refreshLocalModels(
	poolId: LocalProviderId,
	context: { allowNetwork: boolean; signal?: AbortSignal },
	dependencies: LocalProviderDependencies,
): Promise<LocalProviderModel[]> {
	const slots = await dependencies.resolveSlots(poolId);
	const catalog = readStoredCatalog(poolId, dependencies.agentDirectory);
	const configuredOrigins = new Set(slots.map((slot) => slot.baseUrl));
	const stored = catalog.models.filter((model) => configuredOrigins.has(model.baseUrl));
	if (!context.allowNetwork || slots.length === 0) {
		return stored;
	}

	// Retain identity bindings even when a successful catalog no longer lists a
	// model: a later refresh must not revive the same id on another server.
	const origins = new Map([...catalog.origins].filter(([, baseUrl]) => configuredOrigins.has(baseUrl)));
	const discovered: LocalProviderModel[] = [];
	const cached: LocalProviderModel[] = [];
	const seen = new Set<string>();
	const visitedOrigins = new Set<string>();
	let updated = false;
	for (const slot of slots) {
		if (visitedOrigins.has(slot.baseUrl)) {
			continue;
		}
		visitedOrigins.add(slot.baseUrl);
		const previous = stored.filter((model) => model.baseUrl === slot.baseUrl);
		const models = await discoverLocalModels(poolId, {
			baseUrl: slot.baseUrl,
			signal: context.signal,
			fetchImpl: dependencies.fetchImpl,
			timeoutMs: dependencies.timeoutMs,
			token: await dependencies.resolveToken?.(poolId, slot.slotId),
		});
		const selected = (models ?? previous).filter((model) => {
			if (seen.has(model.id) || (origins.has(model.id) && origins.get(model.id) !== slot.baseUrl)) {
				return false;
			}
			seen.add(model.id);
			origins.set(model.id, slot.baseUrl);
			return true;
		});
		discovered.push(...selected);
		// Empty is authoritative for this refresh, but does not erase an offline
		// catalog. Failed origins keep their own entries, not another host's.
		cached.push(...(models === undefined || models.length === 0 ? previous : selected));
		updated ||= models !== undefined && models.length > 0;
	}
	if (updated) {
		writeStoredLocalModels(poolId, cached, origins, dependencies.agentDirectory);
	}
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
