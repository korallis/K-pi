import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ProviderModelConfig } from "../packages/coding-agent/src/core/extensions/types.ts";

import {
	AccountBalancer,
	DEFAULT_FALLBACK_CHAIN,
} from "../packages/coding-agent/src/kpi/extensions/accounts/balancer.ts";
import {
	type AccountsDocument,
	AccountsStore,
	isLocalPool,
	type PoolId,
	poolIdForProvider,
	providerIdForPool,
} from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { renderAccountsWidget } from "../packages/coding-agent/src/kpi/extensions/accounts/widget.ts";
import {
	DEFAULT_LOCAL_BASE_URLS,
	discoverLocalModels,
	LOCAL_PROVIDER_IDS,
	readStoredLocalModels,
	refreshLocalModels,
	registerLocalProviders,
	storedLocalModelsPath,
} from "../packages/coding-agent/src/kpi/extensions/local/providers.ts";

interface Stub {
	origin: string;
	requests: Array<{ path: string; authorization?: string }>;
	close: () => Promise<void>;
}

/** A loopback server so discovery is exercised over a real socket. */
async function stubServer(routes: Record<string, { status?: number; body: unknown }>): Promise<Stub> {
	const requests: Array<{ path: string; authorization?: string }> = [];
	const server: Server = createServer((request, response) => {
		requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
		const route = routes[request.url ?? ""];
		if (route === undefined) {
			response.writeHead(404).end("{}");
			return;
		}
		response.writeHead(route.status ?? 200, { "content-type": "application/json" });
		response.end(typeof route.body === "string" ? route.body : JSON.stringify(route.body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

function localAccounts(
	pools: AccountsDocument["pools"],
	fallback: PoolId[] = [...DEFAULT_FALLBACK_CHAIN],
): AccountsDocument {
	return { version: 1, pools, fallback, stickiness: "session-until-exhausted" };
}

function localPool(baseUrl: string, ...slotIds: string[]) {
	return {
		strategy: "round-robin" as const,
		slots: slotIds.map((id) => ({ id, kind: "local" as const, label: id, baseUrl })),
	};
}

test("AC-27.1 the llama pool maps to Pi's own llama.cpp provider and is never registered", () => {
	assert.equal(providerIdForPool("llama"), "llama.cpp", "the pool is served by Pi's built-in provider");
	assert.equal(poolIdForProvider("llama.cpp"), "llama", "a llama.cpp request is attributed to the llama pool");
	assert.equal(providerIdForPool("ollama"), "ollama", "the first-party pools are their own providers");
	assert.equal(poolIdForProvider("anthropic"), "anthropic");
	assert.equal(poolIdForProvider("not-a-pool"), undefined);

	const registered: string[] = [];
	registerLocalProviders(
		{
			registerProvider(id: string) {
				registered.push(id);
			},
		} as unknown as ExtensionAPI,
		{ resolveSlots: async () => [] },
	);
	assert.deepEqual(registered, ["ollama", "lmstudio", "local-openai"]);
	assert.equal(registered.includes("llama"), false, "llama stays Pi-owned");
	assert.equal(registered.includes("llama.cpp"), false);
});

test("AC-27.2 discovery uses /v1/models, keeps exact ids, and tolerates extra fields", async () => {
	const stub = await stubServer({
		"/v1/models": {
			body: {
				object: "list",
				data: [
					{ id: "qwen2.5-coder:32b-instruct-q4_K_M", owned_by: "library", created: 1 },
					{ id: "llama3.3:70b" },
				],
			},
		},
	});
	try {
		const models = await discoverLocalModels("lmstudio", { baseUrl: `${stub.origin}/v1` });

		assert.deepEqual(
			models?.map((entry) => entry.id),
			["qwen2.5-coder:32b-instruct-q4_K_M", "llama3.3:70b"],
			"server ids are preserved exactly",
		);
		assert.deepEqual(
			stub.requests.map((request) => request.path),
			["/v1/models"],
			"only the OpenAI-compatible list was requested",
		);
		assert.equal(stub.requests[0].authorization, undefined, "no dummy credential is sent");
		for (const model of models ?? []) {
			assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "local costs zero");
		}
	} finally {
		await stub.close();
	}
});

test("AC-27.2 an empty catalog is a valid answer and a malformed identity entry is rejected", async () => {
	const empty = await stubServer({ "/v1/models": { body: { data: [] } } });
	try {
		assert.deepEqual(await discoverLocalModels("lmstudio", { baseUrl: `${empty.origin}/v1` }), []);
	} finally {
		await empty.close();
	}

	for (const body of [
		{ data: [{ name: "no id" }] },
		{ data: [{ id: 7 }] },
		{ data: [{ id: "" }] },
		{ data: "nope" },
	]) {
		const malformed = await stubServer({ "/v1/models": { body } });
		try {
			assert.equal(
				await discoverLocalModels("lmstudio", { baseUrl: `${malformed.origin}/v1` }),
				undefined,
				`malformed identity rejected: ${JSON.stringify(body)}`,
			);
		} finally {
			await malformed.close();
		}
	}
});

test("AC-27.2 Ollama falls back to /api/tags only when the v1 list is unavailable", async () => {
	// v1 present: the fallback must not be consulted at all.
	const withV1 = await stubServer({
		"/v1/models": { body: { data: [{ id: "qwen3:8b" }] } },
		"/api/tags": { body: { models: [{ name: "should-not-be-read" }] } },
	});
	try {
		const models = await discoverLocalModels("ollama", { baseUrl: `${withV1.origin}/v1` });
		assert.deepEqual(
			models?.map((entry) => entry.id),
			["qwen3:8b"],
		);
		assert.deepEqual(
			withV1.requests.map((request) => request.path),
			["/v1/models"],
			"no fallback request",
		);
	} finally {
		await withV1.close();
	}

	// v1 unavailable: now the tag list answers, with exact ids.
	const tagsOnly = await stubServer({
		"/v1/models": { status: 404, body: {} },
		"/api/tags": { body: { models: [{ name: "qwen3:8b", size: 1 }, { name: "deepseek-r1:14b" }] } },
	});
	try {
		const models = await discoverLocalModels("ollama", { baseUrl: `${tagsOnly.origin}/v1` });
		assert.deepEqual(
			models?.map((entry) => entry.id),
			["qwen3:8b", "deepseek-r1:14b"],
		);
		assert.deepEqual(
			tagsOnly.requests.map((request) => request.path),
			["/v1/models", "/api/tags"],
			"the fallback runs after, and only after, the v1 list",
		);
	} finally {
		await tagsOnly.close();
	}

	// Only Ollama has that fallback.
	const other = await stubServer({
		"/v1/models": { status: 404, body: {} },
		"/api/tags": { body: { models: [{ name: "nope" }] } },
	});
	try {
		assert.equal(await discoverLocalModels("lmstudio", { baseUrl: `${other.origin}/v1` }), undefined);
		assert.deepEqual(
			other.requests.map((request) => request.path),
			["/v1/models"],
		);
	} finally {
		await other.close();
	}
});

test("AC-27.3 defaults are the documented origins and local-openai asks", () => {
	assert.equal(DEFAULT_LOCAL_BASE_URLS.ollama, "http://127.0.0.1:11434/v1");
	assert.equal(DEFAULT_LOCAL_BASE_URLS.lmstudio, "http://127.0.0.1:1234/v1");
	assert.equal(DEFAULT_LOCAL_BASE_URLS["local-openai"], undefined, "an arbitrary server is never guessed");
	assert.deepEqual([...LOCAL_PROVIDER_IDS], ["ollama", "lmstudio", "local-openai"]);
});

test("AC-27.3 a local slot persists its base URL, needs no credential, and stores no dummy secret", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-local-slot-"));
	try {
		const store = new AccountsStore(directory);
		await store.putLocalSlot("ollama", {
			id: "default",
			kind: "local",
			label: "default",
			baseUrl: "http://127.0.0.1:11434/v1",
		});

		const document = await store.read();
		assert.equal(document.pools.ollama?.slots[0]?.kind, "local");
		assert.equal(document.pools.ollama?.slots[0]?.baseUrl, "http://127.0.0.1:11434/v1");
		assert.deepEqual(Object.keys(await store.readSecrets()), [], "no secret entry at all");
		assert.equal(await store.localBaseUrl("ollama", "default"), "http://127.0.0.1:11434/v1");

		// A local slot without its origin, or a cloud pool, is refused.
		await assert.rejects(store.putLocalSlot("ollama", { id: "bad", kind: "local" }), /needs a base URL/u);
		await assert.rejects(
			store.putLocalSlot("ollama", { id: "bad", kind: "local", baseUrl: "not a url" }),
			/invalid base URL/u,
		);
		await assert.rejects(
			store.putLocalSlot("anthropic", { id: "bad", kind: "local", baseUrl: "http://127.0.0.1/v1" }),
			/not a local pool/u,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("AC-27.4 an unreachable local server cools the slot and only a local successor is chosen", () => {
	const document = localAccounts({
		ollama: localPool("http://127.0.0.1:11434/v1", "a", "b"),
		lmstudio: localPool("http://127.0.0.1:1234/v1", "studio"),
		anthropic: { strategy: "round-robin", slots: [{ id: "home", kind: "oauth" }] },
	});
	const balancer = new AccountBalancer(() => 1_000);

	assert.equal(balancer.select("ollama", document)?.slot.id, "a");
	balancer.markCooling("ollama", "a", 60_000);
	assert.equal(balancer.select("ollama", document)?.slot.id, "b", "failover stays inside the local family");

	balancer.markCooling("ollama", "b", 60_000);
	const acrossLocal = balancer.select("ollama", document);
	assert.equal(acrossLocal?.poolId, "lmstudio", "the next local family answers");

	balancer.markCooling("lmstudio", "studio", 60_000);
	assert.equal(balancer.select("ollama", document), undefined, "a local run never escapes to a cloud seat on its own");
});

test("AC-27.5 local pools are outside the default chain and enter it only when the operator says so", () => {
	assert.equal(
		DEFAULT_FALLBACK_CHAIN.some((poolId) => isLocalPool(poolId)),
		false,
		"the default cloud chain names no local pool",
	);

	const pools: AccountsDocument["pools"] = {
		llama: localPool("http://127.0.0.1:8080/v1", "default"),
		anthropic: { strategy: "round-robin", slots: [{ id: "home", kind: "oauth" }] },
	};

	// Default chain: a cloud request never falls to the local pool.
	const cloudFirst = new AccountBalancer(() => 1_000);
	cloudFirst.markCooling("anthropic", "home", 60_000);
	assert.equal(cloudFirst.select("anthropic", localAccounts(pools)), undefined, "no silent local fallback");

	// The operator puts llama before a cloud pool: now that order applies.
	const explicit = new AccountBalancer(() => 1_000);
	explicit.markCooling("llama", "default", 60_000);
	assert.equal(
		explicit.select("llama", localAccounts(pools, ["llama", "anthropic"]))?.poolId,
		"anthropic",
		"an explicit chain is the operator's decision",
	);
});

test("AC-27.6 the accounts widget shows no quota percentage for a local slot", () => {
	const widget = renderAccountsWidget(
		localAccounts({
			ollama: localPool("http://127.0.0.1:11434/v1", "default"),
			anthropic: { strategy: "round-robin", slots: [{ id: "home", kind: "oauth", label: "home" }] },
		}),
		{ now: 0 },
	);

	assert.match(widget, /OLLAMA {2}default \(local\)/u);
	assert.doesNotMatch(widget, /default \?%/u, "a local slot has no quota to be unknown about");
	assert.match(widget, /home \?%/u, "a cloud slot still reports unknown usage");
});

test("AC-27.7 no forbidden local provider dependency is declared", async () => {
	const forbidden = ["pi-ollama", "@jamesjfoong/pi-ollama", "pi-ollama-keyring", "pi-ollama-cloud-provider"];
	for (const manifest of ["package.json", "packages/coding-agent/package.json"]) {
		const source = await readFile(new URL(`../${manifest}`, import.meta.url), "utf8");
		for (const name of forbidden) {
			assert.equal(source.includes(`"${name}"`), false, `${manifest} must not depend on ${name}`);
		}
	}
});

test("AC-27.8 every discovery request stays on the configured origin", async () => {
	const stub = await stubServer({ "/v1/models": { body: { data: [{ id: "local-only" }] } } });
	const attempted: string[] = [];
	try {
		const spy: typeof fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			attempted.push(new URL(url).origin);
			if (new URL(url).origin !== stub.origin) {
				throw new Error(`a request left the configured origin: ${url}`);
			}
			return fetch(input, init);
		};

		const models = await discoverLocalModels("ollama", { baseUrl: `${stub.origin}/v1`, fetchImpl: spy });
		assert.deepEqual(
			models?.map((entry) => entry.id),
			["local-only"],
		);
		assert.deepEqual([...new Set(attempted)], [stub.origin], "no other origin was ever contacted");
	} finally {
		await stub.close();
	}
});

test("discovery is bounded: a server that never answers aborts instead of hanging", async () => {
	const server = createServer(() => {
		// Never responds, so only the timeout can end this.
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	try {
		const started = Date.now();
		const models = await discoverLocalModels("lmstudio", {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			timeoutMs: 150,
		});

		assert.equal(models, undefined, "an unreachable list is not a catalog");
		assert.ok(Date.now() - started < 2_000, "the bound, not the socket, ended it");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("an external abort stops discovery", async () => {
	const server = createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	const controller = new AbortController();
	try {
		setTimeout(() => controller.abort(), 50);
		assert.equal(
			await discoverLocalModels("lmstudio", {
				baseUrl: `http://127.0.0.1:${port}/v1`,
				signal: controller.signal,
				timeoutMs: 10_000,
			}),
			undefined,
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("a live catalog is stored and restored offline, and never replaced by a guess", async () => {
	const agentDirectory = await mkdtemp(join(tmpdir(), "kpi-local-cache-"));
	const stub = await stubServer({ "/v1/models": { body: { data: [{ id: "qwen3:8b" }] } } });
	const dependencies = {
		resolveSlots: async () => [{ slotId: "default", baseUrl: `${stub.origin}/v1` }],
		agentDirectory,
	};
	try {
		const live = await refreshLocalModels("ollama", { allowNetwork: true }, dependencies);
		assert.deepEqual(
			live.map((entry) => entry.id),
			["qwen3:8b"],
		);
		const stored = await readFile(storedLocalModelsPath("ollama", agentDirectory), "utf8");
		assert.match(stored, /qwen3:8b/u);

		// Offline restores the stored catalog and writes nothing.
		const offline = await refreshLocalModels("ollama", { allowNetwork: false }, dependencies);
		assert.deepEqual(
			offline.map((entry) => entry.id),
			["qwen3:8b"],
		);
		assert.equal(await readFile(storedLocalModelsPath("ollama", agentDirectory), "utf8"), stored);

		// The same server, now unreachable: the catalog for that origin survives.
		const unreachable = await refreshLocalModels(
			"ollama",
			{ allowNetwork: true },
			{
				...dependencies,
				timeoutMs: 100,
				fetchImpl: async () => {
					throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
				},
			},
		);
		assert.deepEqual(
			unreachable.map((entry) => entry.id),
			["qwen3:8b"],
			"a cooled server does not erase what was known",
		);
		assert.equal(await readFile(storedLocalModelsPath("ollama", agentDirectory), "utf8"), stored);

		// A slot the operator has repointed drops the old origin's catalog rather
		// than sending its models to a host they were never discovered on.
		const repointed = await refreshLocalModels(
			"ollama",
			{ allowNetwork: false },
			{ ...dependencies, resolveSlots: async () => [{ slotId: "default", baseUrl: "http://127.0.0.1:9/v1" }] },
		);
		assert.deepEqual(repointed, [], "a stale origin is never rebound to a different server");

		// An unconfigured pool never discovers and never stores.
		assert.deepEqual(
			await refreshLocalModels(
				"lmstudio",
				{ allowNetwork: true },
				{ ...dependencies, resolveSlots: async () => [] },
			),
			[],
		);
		assert.equal(readStoredLocalModels("lmstudio", agentDirectory), undefined);
	} finally {
		await stub.close();
		await rm(agentDirectory, { recursive: true, force: true });
	}
});

test("a stored local catalog is rehydrated through current defaults and never frozen into a models array", async () => {
	const agentDirectory = await mkdtemp(join(tmpdir(), "kpi-local-rehydrate-"));
	const stub = await stubServer({ "/v1/models": { body: { data: [{ id: "qwen3:8b", name: "Qwen 3" }] } } });
	try {
		await refreshLocalModels(
			"ollama",
			{ allowNetwork: true },
			{
				resolveSlots: async () => [{ slotId: "default", baseUrl: `${stub.origin}/v1` }],
				agentDirectory,
			},
		);

		const [rehydrated] = readStoredLocalModels("ollama", agentDirectory) ?? [];
		assert.equal(rehydrated.id, "qwen3:8b");
		assert.deepEqual(rehydrated.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(rehydrated.api, "openai-completions");

		// Registration offers the stored catalog, not a frozen literal list.
		const registered: Array<{ id: string; models?: ProviderModelConfig[] }> = [];
		registerLocalProviders(
			{
				registerProvider(id: string, config: { models?: ProviderModelConfig[] }) {
					registered.push({ id, models: config.models });
				},
			} as unknown as ExtensionAPI,
			{ resolveSlots: async () => [], agentDirectory },
		);
		const ollama = registered.find((entry) => entry.id === "ollama");
		assert.deepEqual(
			ollama?.models?.map((entry) => entry.id),
			["qwen3:8b"],
			"the bootstrap list is the last known catalog",
		);
		assert.equal(
			registered.find((entry) => entry.id === "lmstudio")?.models,
			undefined,
			"a never-discovered pool freezes nothing",
		);
	} finally {
		await stub.close();
		await rm(agentDirectory, { recursive: true, force: true });
	}
});
