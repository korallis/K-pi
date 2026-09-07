import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../packages/coding-agent/src/core/extensions/loader.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../packages/coding-agent/src/core/models-store.ts";
import { registerAccounts } from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import {
	AccountsStore,
	isPoolId,
	poolIdForProvider,
	providerIdForPool,
} from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { refreshCursorModels } from "../packages/coding-agent/src/kpi/extensions/cursor/discovery.ts";
import { registerCursorProvider } from "../packages/coding-agent/src/kpi/extensions/cursor/provider.ts";
import kPi from "../packages/coding-agent/src/kpi/extensions/index.ts";

// These exercise the actual native auth/catalog surface, not captured registration wiring.
test("Cursor registration never promotes a stored API key to OAuth or invents bootstrap models", async () => {
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	const token = "fixture-cursor-api-key";
	await credentials.modify("cursor", async () => ({ type: "api_key", key: token }));
	registerCursorProvider({
		registerProvider: runtime.registerProvider.bind(runtime),
	} as unknown as ExtensionAPI);

	assert.equal(runtime.isUsingSubscription("cursor"), false);
	assert.deepEqual(await runtime.getAvailable("cursor"), []);
	assert.deepEqual(runtime.getModels("cursor"), []);
	assert.deepEqual(await credentials.read("cursor"), { type: "api_key", key: token });
});

test("Cursor offline discovery has no bootstrap and cancelled discovery preserves cancellation", async () => {
	const controller = new AbortController();
	const context: RefreshModelsContext = {
		allowNetwork: false,
		signal: controller.signal,
		publish: async () => {
			assert.fail("unverified catalogs must not be persisted");
		},
	};
	assert.deepEqual(await refreshCursorModels(context), []);
	const reason = new Error("fixture cancellation");
	controller.abort(reason);
	await assert.rejects(refreshCursorModels(context), (error) => error === reason);
});

test("loading the built-in extension preserves every official provider catalog", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	const providers = ["anthropic", "openai", "openai-codex", "xai", "zai", "zai-coding-cn", "kimi-coding"];
	const before = new Map(providers.map((provider) => [provider, structuredClone(runtime.getModels(provider))]));
	const extensionRuntime = createExtensionRuntime();
	extensionRuntime.registerProvider = runtime.registerProvider.bind(runtime);
	extensionRuntime.registerNativeProvider = runtime.registerNativeProvider.bind(runtime);
	extensionRuntime.unregisterProvider = runtime.unregisterProvider.bind(runtime);
	try {
		await loadExtensionFromFactory(kPi, process.cwd(), createEventBus(), extensionRuntime, "<builtin:kpi>");
		for (const provider of providers) {
			assert.deepEqual(runtime.getModels(provider), before.get(provider), `${provider} catalog must remain native`);
		}
	} finally {
		extensionRuntime.invalidate("catalog fixture finished");
	}
});

test("official catalogs survive pooled key login, replacement, pin, logout, and offline refresh without account aliases", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-native-catalog-lifecycle-"));
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	const store = new AccountsStore(directory);
	const extensionRuntime = createExtensionRuntime();
	extensionRuntime.registerProvider = runtime.registerProvider.bind(runtime);
	extensionRuntime.registerNativeProvider = runtime.registerNativeProvider.bind(runtime);
	extensionRuntime.unregisterProvider = runtime.unregisterProvider.bind(runtime);
	const official = ["anthropic", "openai", "openai-codex", "xai", "zai", "zai-coding-cn", "kimi-coding"];
	const catalogs = new Map(official.map((id) => [id, structuredClone(runtime.getModels(id))]));
	const modelIds = runtime
		.getModels()
		.map((model) => `${model.provider}/${model.id}`)
		.sort();
	const errors: string[] = [];
	let revision = 1;
	try {
		await loadExtensionFromFactory(kPi, directory, createEventBus(), extensionRuntime, "<builtin:kpi>");
		const providerIds = runtime
			.getProviders()
			.map((provider) => provider.id)
			.sort();
		const extension = await loadExtensionFromFactory(
			(pi) =>
				registerAccounts(pi, {
					store,
					now: () => new Date("2026-09-01T12:00:00.000Z"),
					// Exercise native key storage, not a fake OAuth/entitlement flow.
					login: (providerId, slotId) =>
						runtime.login(providerId, "api_key", {
							prompt: async () => `fixture-${providerId}-${slotId}-${revision}`,
							notify: () => undefined,
						}),
				}),
			directory,
			createEventBus(),
			extensionRuntime,
			"<fixture:accounts>",
		);
		const command = extension.commands.get("accounts");
		assert.ok(command);
		const context = {
			cwd: directory,
			hasUI: true,
			mode: "tui",
			modelRegistry: runtime,
			ui: {
				confirm: async () => true,
				notify: (message: string, level?: string) => {
					if (level === "error") errors.push(message);
				},
				setStatus: () => undefined,
			},
		} as unknown as ExtensionCommandContext;
		const assertCatalogs = (transition: string) => {
			assert.deepEqual(errors, [], transition);
			assert.deepEqual(
				runtime
					.getProviders()
					.map((provider) => provider.id)
					.sort(),
				providerIds,
				transition,
			);
			assert.deepEqual(
				runtime
					.getModels()
					.map((model) => `${model.provider}/${model.id}`)
					.sort(),
				modelIds,
				`${transition}: no account-prefixed or duplicate models`,
			);
			for (const providerId of official) {
				assert.deepEqual(runtime.getModels(providerId), catalogs.get(providerId), `${transition}: ${providerId}`);
			}
		};
		assertCatalogs("built-in and account factory load");
		for (const pool of ["anthropic", "zai", "zai-coding-cn", "kimi-coding"] as const) {
			for (const slot of ["home", "work"]) {
				await command.handler(`login ${pool} ${slot}`, context);
				assert.deepEqual((await store.readSecrets())[`${pool}/${slot}`], {
					type: "api_key",
					key: `fixture-${pool}-${slot}-${revision}`,
				});
				assertCatalogs(`${pool}/${slot} login`);
			}
			assert.deepEqual(
				(await new AccountsStore(directory).read()).pools[pool]?.slots.map((slot) => slot.id),
				["home", "work"],
			);
			revision += 1;
			await command.handler(`login ${pool} work`, context);
			assert.deepEqual((await store.readSecrets())[`${pool}/work`], {
				type: "api_key",
				key: `fixture-${pool}-work-${revision}`,
			});
			assertCatalogs(`${pool}/work credential replacement`);
			await command.handler(`pin ${pool}/work`, context);
			assertCatalogs(`${pool}/work pin`);
			const refresh = await runtime.refresh({ allowNetwork: false, providers: [pool] });
			assert.equal(refresh.aborted, false);
			assert.deepEqual([...refresh.errors], []);
			assertCatalogs(`${pool} offline refresh`);
			await command.handler(`logout ${pool}/work`, context);
			assert.deepEqual(
				(await store.read()).pools[pool]?.slots.map((slot) => slot.id),
				["home"],
			);
			assert.equal((await store.readSecrets())[`${pool}/work`], undefined);
			assertCatalogs(`${pool}/work logout preserves sibling`);
			await command.handler(`logout ${pool}/home`, context);
			await runtime.logout(pool);
			assert.equal(await credentials.read(pool), undefined);
			assertCatalogs(`${pool} final logout`);
		}
	} finally {
		extensionRuntime.invalidate("catalog lifecycle fixture finished");
		await rm(directory, { recursive: true, force: true });
	}
});

test("native coding pools resolve only their documented key environment and keep built-in endpoints", async () => {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	const expected = [
		["zai", "ZAI_API_KEY", "https://api.z.ai/api/coding/paas/v4"],
		["zai-coding-cn", "ZAI_CODING_CN_API_KEY", "https://open.bigmodel.cn/api/coding/paas/v4"],
		["kimi-coding", "KIMI_API_KEY", "https://api.kimi.com/coding"],
	] as const;
	for (const [pool, variable, endpoint] of expected) {
		assert.equal(isPoolId(pool), true);
		assert.equal(providerIdForPool(pool), pool);
		assert.equal(poolIdForProvider(pool), pool);
		const provider = runtime.getProvider(pool);
		assert.ok(provider);
		assert.equal(provider.baseUrl, endpoint);
		const apiKey = provider.auth.apiKey;
		assert.ok(apiKey);
		const signal = new AbortController().signal;
		assert.deepEqual(
			await apiKey.resolve({
				ctx: {
					env: async (name) => (name === variable ? "fixture-key" : undefined),
					fileExists: async () => false,
				},
				signal,
			}),
			{ auth: { apiKey: "fixture-key" }, source: variable },
		);
		const unrelatedKeys = Object.fromEntries(
			["ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"]
				.filter((name) => name !== variable)
				.map((name) => [name, "wrong-provider-key"]),
		);
		assert.equal(
			await apiKey.resolve({
				ctx: { env: async (name) => unrelatedKeys[name], fileExists: async () => false },
				signal,
			}),
			undefined,
			`${pool} must not borrow another provider's key`,
		);
		for (const model of runtime.getModels(pool)) {
			assert.equal(model.provider, pool);
			assert.equal(model.baseUrl, endpoint);
		}
	}
	assert.equal(isPoolId("moonshot"), false);
	assert.equal(poolIdForProvider("moonshot"), undefined);
});
