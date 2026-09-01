import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

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
export const CURSOR_FALLBACK_MODELS: ProviderModelConfig[] = [
  model("cursor-small", "Cursor Small (fallback)"),
];

interface CursorModelsResponse {
  models?: Array<{ id?: unknown; name?: unknown }>;
  data?: Array<{ id?: unknown; name?: unknown }>;
}

export async function refreshCursorModels(
  context: RefreshModelsContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelConfig[]> {
  if (!context.allowNetwork) return [...CURSOR_FALLBACK_MODELS];
  const credential = context.credential;
  const token = credential?.type === "oauth" ? credential.access : credential?.key;
  const response = await fetchImpl(`${CURSOR_BASE_URL}/models`, {
    headers: token === undefined ? undefined : { authorization: `Bearer ${token}` },
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`Cursor model refresh failed: ${response.status}`);
  const payload = (await response.json()) as CursorModelsResponse;
  const entries = payload.models ?? payload.data ?? [];
  return entries.flatMap((entry) =>
    typeof entry.id === "string"
      ? [model(entry.id, typeof entry.name === "string" ? entry.name : entry.id)]
      : [],
  );
}

export function registerCursorProvider(pi: ExtensionAPI): void {
  pi.registerProvider("cursor", {
    name: "Cursor",
    baseUrl: CURSOR_BASE_URL,
    api: "openai-completions",
    authHeader: true,
    models: CURSOR_FALLBACK_MODELS,
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
