import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../config.ts";
import type { ExtensionAPI, ProviderModelConfig } from "../../../core/extensions/types.ts";

import { getApiKey, login, refreshToken } from "./oauth.ts";

const CURSOR_BASE_URL = "https://api2.cursor.sh/v1";

function model(id: string, name = id): ProviderModelConfig {
	return {
		id,
		name,
		api: "openai-completions",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

/** Bootstrap only; refreshModels replaces this list after a successful live sync. */
export const CURSOR_FALLBACK_MODELS: ProviderModelConfig[] = [model("cursor-small", "Cursor Small (fallback)")];

interface CursorModelsResponse {
	models?: Array<{ id?: unknown; name?: unknown }>;
	data?: Array<{ id?: unknown; name?: unknown }>;
}

/** Where the last live catalog is kept, so `/model` is never empty after a sync. */
export function storedCursorModelsPath(agentDirectory = getAgentDir()): string {
	return join(agentDirectory, "cursor-models.json");
}

/**
 * The last known live catalog. Read synchronously at registration because the
 * provider must offer a usable list before any refresh can run; an unreadable or
 * malformed file simply means there is no stored catalog yet.
 */
/**
 * The last known live catalog, rehydrated through the current model defaults.
 *
 * Only the id and the display name are taken from the file: a cached
 * `contextWindow`, `cost` or `api` from an older release would otherwise
 * outlive the release that wrote it and quietly describe a model wrongly.
 */
export function readStoredCursorModels(agentDirectory?: string): ProviderModelConfig[] | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(storedCursorModelsPath(agentDirectory), "utf8"));
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
			return [model(candidate.id, typeof candidate.name === "string" ? candidate.name : candidate.id)];
		});
		return models.length === 0 ? undefined : models;
	} catch {
		return undefined;
	}
}

/** Persists the catalog atomically, creating the agent directory if needed. */
function writeStoredCursorModels(models: readonly ProviderModelConfig[], agentDirectory?: string): void {
	const path = storedCursorModelsPath(agentDirectory);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporaryPath, `${JSON.stringify(models, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch {
		// A catalog cache that cannot be written must never fail a refresh.
	}
}

export async function refreshCursorModels(
	context: RefreshModelsContext,
	fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelConfig[]> {
	// Offline: the last known catalog beats a bootstrap guess, and neither is
	// written back, so a cached list is never overwritten by a fallback.
	if (!context.allowNetwork) return readStoredCursorModels() ?? [...CURSOR_FALLBACK_MODELS];
	const credential = context.credential;
	const token = credential?.type === "oauth" ? credential.access : credential?.key;
	const response = await fetchImpl(`${CURSOR_BASE_URL}/models`, {
		headers: token === undefined ? undefined : { authorization: `Bearer ${token}` },
		signal: context.signal,
	});
	if (!response.ok) throw new Error(`Cursor model refresh failed: ${response.status}`);
	const payload = (await response.json()) as CursorModelsResponse;
	const entries = payload.models ?? payload.data ?? [];
	const models = entries.flatMap((entry) =>
		typeof entry.id === "string" ? [model(entry.id, typeof entry.name === "string" ? entry.name : entry.id)] : [],
	);
	if (models.length === 0) {
		// An empty live answer is not a catalog. Keep what was already known.
		return readStoredCursorModels() ?? [...CURSOR_FALLBACK_MODELS];
	}
	writeStoredCursorModels(models);
	return models;
}

export function registerCursorProvider(pi: ExtensionAPI): void {
	pi.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: CURSOR_BASE_URL,
		api: "openai-completions",
		authHeader: true,
		// Bounded bootstrap: the last live catalog when one was stored, else the
		// small fallback, so `/model` is never empty and never a frozen guess.
		models: readStoredCursorModels() ?? CURSOR_FALLBACK_MODELS,
		oauth: {
			name: "Cursor",
			isSubscription: true,
			login,
			refreshToken,
			getApiKey,
		},
		refreshModels: refreshCursorModels,
	});
}
