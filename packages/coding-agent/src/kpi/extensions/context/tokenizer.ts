import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeLlamaServerUrl } from "../../../extensions/llama/client.ts";
import type { ContextModel, ContextTokenizer } from "./serialization.ts";

export interface LlamaTokenizerConfiguration {
	kind: "llama.cpp";
	/** Explicit inference provider/model binding; aliases must be configured separately. */
	provider: string;
	model: string;
	/** Tokenizer/version identity supplied by the endpoint operator. */
	id: string;
	serverUrl: string;
	/** Optional explicit environment variable name. Never persisted in a context manifest. */
	apiKeyEnv?: string;
}

/** Uses native llama.cpp /tokenize, not inference usage, vocabulary guesses or chars/4. */
export function createLlamaContextTokenizer(config: LlamaTokenizerConfiguration): ContextTokenizer {
	const parsed = new URL(config.serverUrl);
	if (parsed.username || parsed.password || parsed.search || parsed.hash)
		throw new Error("Tokenizer URL cannot contain credentials, query or fragment");
	const serverUrl = normalizeLlamaServerUrl(config.serverUrl);
	return {
		id: config.id,
		supports: (model) => model.provider === config.provider && model.id === config.model,
		async countTokens(text, model) {
			if (model.provider !== config.provider || model.id !== config.model) return null;
			const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
			if (config.apiKeyEnv && !apiKey) return null;
			const response = await fetch(`${serverUrl}/tokenize`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
				headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
				body: JSON.stringify({ model: model.id, content: text, add_special: false, parse_special: false }),
			});
			if (!response.ok) return null;
			const result: unknown = await response.json();
			if (
				!result ||
				typeof result !== "object" ||
				!("tokens" in result) ||
				!Array.isArray(result.tokens) ||
				!result.tokens.every(
					(token: unknown) => typeof token === "number" && Number.isSafeInteger(token) && token >= 0,
				)
			)
				return null;
			return result.tokens.length;
		},
	};
}

/**
 * Explicit opt-in only: .kpi/context.json = {"version":1,"tokenizers":[
 * {"kind":"llama.cpp","provider":"llama.cpp","model":"exact-model-id",
 * "id":"operator-pinned-tokenizer-version","serverUrl":"http://127.0.0.1:8080"}]}
 * Configuration authorizes sending context to this endpoint for the exact model binding.
 * Missing/invalid configuration never initiates network access and is reported as unsupported.
 */
export async function loadContextTokenizer(
	projectRoot: string,
	model?: ContextModel,
): Promise<{ tokenizer?: ContextTokenizer; reason: string | null }> {
	if (!model) return { reason: "No model identity supplied" };
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(projectRoot, ".kpi", "context.json"), "utf8"));
	} catch (error) {
		return {
			reason:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "No authorized tokenizer configuration"
					: "Tokenizer configuration unreadable or invalid",
		};
	}
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("tokenizers" in value) ||
		!Array.isArray(value.tokenizers)
	)
		return { reason: "Invalid tokenizer configuration schema" };
	const matches = value.tokenizers.filter(
		(entry: unknown) =>
			entry !== null &&
			typeof entry === "object" &&
			"provider" in entry &&
			"model" in entry &&
			entry.provider === model.provider &&
			entry.model === model.id,
	);
	if (matches.length !== 1)
		return {
			reason: matches.length ? "Ambiguous tokenizer model binding" : "No authorized tokenizer for this model",
		};
	const entry = matches[0] as Record<string, unknown>;
	if (
		entry.kind !== "llama.cpp" ||
		typeof entry.id !== "string" ||
		!entry.id.trim() ||
		typeof entry.serverUrl !== "string" ||
		(entry.apiKeyEnv !== undefined &&
			(typeof entry.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.apiKeyEnv)))
	)
		return { reason: "Invalid or unsupported tokenizer configuration" };
	try {
		return {
			tokenizer: createLlamaContextTokenizer({
				kind: "llama.cpp",
				provider: model.provider,
				model: model.id,
				id: entry.id,
				serverUrl: entry.serverUrl,
				apiKeyEnv: entry.apiKeyEnv as string | undefined,
			}),
			reason: null,
		};
	} catch {
		return { reason: "Invalid authorized tokenizer endpoint" };
	}
}
