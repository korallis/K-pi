import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Context, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "../packages/ai/src/api/openai-completions.lazy.ts";
import type { ExtensionAPI, ProviderModelConfig } from "../packages/coding-agent/src/core/extensions/types.ts";
import { registerAccounts } from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import {
	type LocalProviderId,
	refreshLocalModels,
	registerLocalProviders,
} from "../packages/coding-agent/src/kpi/extensions/local/providers.ts";

interface Recorded {
	origin: string;
	path: string;
	authorization: string | undefined;
	body: string;
}

interface Stub {
	origin: string;
	requests: Recorded[];
	close: () => Promise<void>;
}

/** A loopback OpenAI-compatible server that answers discovery and inference. */
async function localServer(modelId: string): Promise<Stub> {
	const requests: Recorded[] = [];
	let origin = "";
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const path = request.url ?? "";
			requests.push({
				origin,
				path,
				authorization: request.headers.authorization,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			if (path.endsWith("/models")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ data: [{ id: modelId }] }));
				return;
			}
			if (path.endsWith("/chat/completions")) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (delta: Record<string, unknown>, finish: string | null) =>
					`data: ${JSON.stringify({
						id: "local-1",
						object: "chat.completion.chunk",
						created: 1,
						model: modelId,
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`;
				response.write(chunk({ role: "assistant", content: `served by ${modelId}` }, null));
				response.write(chunk({}, "stop"));
				response.end("data: [DONE]\n\n");
				return;
			}
			response.writeHead(404).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("loopback server has no port");
	}
	origin = `http://127.0.0.1:${address.port}`;
	return {
		origin,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

type HeaderHook = (event: { headers: Record<string, string | null> }, context: unknown) => Promise<void>;

/** A hook context carrying the same surface a real session provides. */
function hookContext(model: unknown, directory: string): unknown {
	return { model, cwd: directory, ui: { setStatus() {} } };
}

interface Harness {
	models: ProviderModelConfig[];
	headerHook: HeaderHook;
	registered: Map<string, { baseUrl?: string; apiKey?: string; models?: ProviderModelConfig[] }>;
}

/**
 * Wires the real accounts extension and the real local provider registration
 * against a store on disk, so the models under test are the ones a session
 * would actually be handed.
 */
async function harness(
	poolId: LocalProviderId,
	directory: string,
	slots: { id: string; baseUrl: string; secret?: string }[],
): Promise<Harness> {
	const store = new AccountsStore(directory);
	for (const slot of slots) {
		if (slot.secret === undefined) {
			await store.putLocalSlot(poolId, { id: slot.id, kind: "local", label: slot.id, baseUrl: slot.baseUrl });
		} else {
			// A slot the operator gave a real credential: the secret lives in the
			// secrets file and the slot only references it.
			await store.putSlot(
				poolId,
				{ id: slot.id, kind: "local", label: slot.id, baseUrl: slot.baseUrl, secretRef: `${poolId}/${slot.id}` },
				{ type: "api_key", key: slot.secret },
			);
		}
	}

	let headerHook: HeaderHook | undefined;
	const registered = new Map<string, { baseUrl?: string; apiKey?: string; models?: ProviderModelConfig[] }>();
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "before_provider_headers") {
				headerHook = handler as HeaderHook;
			}
		},
		registerCommand() {},
		registerProvider(name: string, config: { baseUrl?: string; apiKey?: string; models?: ProviderModelConfig[] }) {
			registered.set(name, config);
		},
	} as unknown as ExtensionAPI;

	registerAccounts(pi, { store, now: () => new Date() });
	const dependencies = {
		resolveSlots: async (pool: LocalProviderId) => {
			const configured = (await store.read()).pools[pool]?.slots ?? [];
			return configured.flatMap((slot) =>
				slot.kind === "local" && slot.baseUrl !== undefined
					? [{ slotId: slot.id, baseUrl: slot.baseUrl, secretRef: slot.secretRef }]
					: [],
			);
		},
		resolveToken: async (pool: LocalProviderId, slotId: string) => {
			const slot = (await store.read()).pools[pool]?.slots.find((candidate) => candidate.id === slotId);
			const reference = slot?.kind === "local" ? slot.secretRef : undefined;
			if (reference === undefined) {
				return undefined;
			}
			const credential = (await store.readSecrets())[reference];
			return credential?.type === "api_key" ? credential.key : undefined;
		},
		agentDirectory: directory,
	};
	registerLocalProviders(pi, dependencies);
	const models = await refreshLocalModels(poolId, { allowNetwork: true }, dependencies);
	assert.ok(headerHook !== undefined, "the accounts extension registers the header hook");
	return { models, headerHook, registered };
}

function localModelFor(
	entry: ProviderModelConfig,
	poolId: string,
	config: { baseUrl?: string } | undefined,
): Model<"openai-completions"> {
	// `provider-composer.applyExtension`'s own precedence, so a provider-level
	// origin would be visible here exactly as a session would see it.
	const baseUrl = entry.baseUrl ?? config?.baseUrl;
	assert.ok(baseUrl !== undefined, `${entry.id} has no origin to request`);
	return {
		...entry,
		api: "openai-completions",
		provider: poolId,
		baseUrl,
		headers: undefined,
	} as Model<"openai-completions">;
}

function promptContext(): Context {
	return { messages: [{ role: "user", content: "hello" }] } as unknown as Context;
}

/** Executes the live request path and returns the assistant text. */
async function runInference(
	model: Model<"openai-completions">,
	headers: Record<string, string | null>,
	apiKey: string,
): Promise<{ text: string; urls: string[] }> {
	const urls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
		return realFetch(input, init);
	}) as typeof fetch;
	try {
		const stream = openAICompletionsApi().stream(model, promptContext(), { apiKey, headers });
		const message = await stream.result();
		const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
		return { text, urls };
	} finally {
		globalThis.fetch = realFetch;
	}
}

test("each local slot's own origin carries its own inference requests", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-local-inference-"));
	const first = await localServer("first-model");
	const second = await localServer("second-model");
	try {
		const subject = await harness("local-openai", directory, [
			{ id: "a", baseUrl: `${first.origin}/v1` },
			{ id: "b", baseUrl: `${second.origin}/v1`, secret: "sk-second-only" },
		]);

		assert.deepEqual(
			subject.models.map((model) => [model.id, model.baseUrl]),
			[
				["first-model", `${first.origin}/v1`],
				["second-model", `${second.origin}/v1`],
			],
			"two servers contribute their own models bound to their own origins",
		);
		assert.equal(
			subject.registered.get("local-openai")?.baseUrl,
			undefined,
			"no dummy provider-wide local origin is ever registered",
		);

		// Whatever the product registered is what a session would resolve.
		const registeredKey = subject.registered.get("local-openai")?.apiKey ?? "";
		assert.ok(registeredKey.length > 0, "the client has a constructible key without a credential claim");

		for (const entry of subject.models) {
			const model = localModelFor(entry, "local-openai", subject.registered.get("local-openai"));
			const headers: Record<string, string | null> = {};
			await subject.headerHook({ headers }, hookContext(model, directory));
			const { text, urls } = await runInference(model, headers, registeredKey);

			assert.equal(text, `served by ${entry.id}`, `${entry.id} was answered by its own server`);
			const expected = entry.id === "first-model" ? first : second;
			const other = entry.id === "first-model" ? second : first;
			const inference = expected.requests.filter((request) => request.path.endsWith("/chat/completions"));
			assert.equal(inference.length, 1, `${entry.id}: exactly one request reached its configured server`);
			assert.match(inference[0].body, new RegExp(entry.id, "u"));
			assert.equal(
				other.requests.filter((request) => request.path.endsWith("/chat/completions")).length,
				0,
				`${entry.id}: nothing reached the other slot's server`,
			);
			// Each model is judged on its own turn, so a later slot's traffic can
			// never be credited to an earlier one.
			expected.requests.length = 0;
			other.requests.length = 0;
			for (const url of urls) {
				assert.ok(
					url.startsWith(expected.origin),
					`${entry.id}: every request stayed on the configured origin, saw ${url}`,
				);
			}

			// The bearer exists only where the operator referenced a real secret.
			if (entry.id === "second-model") {
				assert.equal(inference[0].authorization, "Bearer sk-second-only");
			} else {
				assert.equal(inference[0].authorization, undefined, "no Authorization is invented for a bare server");
			}
		}
	} finally {
		await first.close();
		await second.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a stored catalog keeps serving its own origin, and an unconfigured origin is never credentialed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-local-offline-"));
	const server = await localServer("kept-model");
	try {
		const subject = await harness("lmstudio", directory, [
			{ id: "only", baseUrl: `${server.origin}/v1`, secret: "sk-kept" },
		]);
		assert.equal(subject.models.length, 1);

		// Offline: the stored catalog is reused, still pinned to the same origin,
		// and the request it produces reaches that server and no other.
		const offline = await refreshLocalModels(
			"lmstudio",
			{ allowNetwork: false },
			{ resolveSlots: async () => [{ slotId: "only", baseUrl: `${server.origin}/v1` }], agentDirectory: directory },
		);
		assert.deepEqual(
			offline.map((model) => model.baseUrl),
			[`${server.origin}/v1`],
			"an offline catalog keeps the configured origin",
		);

		const model = localModelFor(offline[0], "lmstudio", subject.registered.get("lmstudio"));
		const headers: Record<string, string | null> = {};
		await subject.headerHook({ headers }, hookContext(model, directory));
		const { urls } = await runInference(model, headers, subject.registered.get("lmstudio")?.apiKey ?? "");
		assert.ok(
			urls.every((url) => url.startsWith(server.origin)),
			"the restored model still requests its own server",
		);

		// A model naming an origin no slot owns gets no credential: the hook has no
		// slot to speak for, so it must not attach one belonging to another server.
		const foreign: Record<string, string | null> = {};
		await subject.headerHook(
			{ headers: foreign },
			hookContext({ ...model, baseUrl: "http://127.0.0.1:65535/v1" }, directory),
		);
		assert.equal(foreign.authorization, undefined, "an unconfigured origin is never handed a secret");

		// And a cloud model in the same session is untouched by local wiring.
		const cloud: Record<string, string | null> = {};
		await subject.headerHook(
			{ headers: cloud },
			hookContext({ ...model, provider: "anthropic", baseUrl: "https://api.anthropic.com" }, directory),
		);
		assert.equal(cloud.authorization, undefined, "no local secret leaks onto a cloud provider");
	} finally {
		await server.close();
		await rm(directory, { recursive: true, force: true });
	}
});
