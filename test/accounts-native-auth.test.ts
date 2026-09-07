import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Credential, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type {
	BeforeProviderAuthEvent,
	ExtensionAPI,
	ExtensionContext,
} from "../packages/coding-agent/src/core/extensions/types.ts";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { registerAccounts } from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { UsageCache } from "../packages/coding-agent/src/kpi/extensions/accounts/usage/cache.ts";
import { readUsageHeaders } from "../packages/coding-agent/src/kpi/extensions/accounts/usage/headers.ts";

const NOW = Date.UTC(2026, 8, 5);
const grant = (account: string): Credential => ({
	type: "oauth",
	refresh: `fixture-refresh-${account}`,
	expires: NOW + 3_600_000,
	access: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64")}.fixture`,
});

for (const primary of [false, true]) {
	test(`native Codex uses selected pooled grant with ${primary ? "a different primary" : "no primary"}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "kpi-native-auth-"));
		try {
			const credentials = new InMemoryCredentialStore();
			if (primary) await credentials.modify("openai-codex", async () => grant("primary"));
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
			const registry = new ModelRegistry(runtime);
			const store = new AccountsStore(directory);
			await store.putSlot("openai-codex", { id: "selected", kind: "oauth" }, grant("selected"));
			const hooks = new Map<string, (event: unknown, context: ExtensionContext) => Promise<unknown>>();
			const context = {
				cwd: directory,
				modelRegistry: registry,
				ui: { setStatus() {}, notify() {} },
			} as unknown as ExtensionContext;
			registerAccounts(
				{
					on: (name: string, handler: (event: unknown, context: ExtensionContext) => Promise<unknown>) =>
						hooks.set(name, handler),
					registerCommand() {},
					setModel: async () => false,
				} as unknown as ExtensionAPI,
				{ store, now: () => new Date(NOW), fallbackModels: async () => undefined },
			);
			runtime.setRequestAuthResolver(async (model, checkOnly, requestId) => {
				const event: BeforeProviderAuthEvent = { type: "before_provider_auth", model, checkOnly, requestId };
				await hooks.get("before_provider_auth")!(event, { ...context, model });
				return event.auth;
			});
			const model = (await runtime.getAvailable("openai-codex"))[0];
			assert.ok(model, "a pooled-only grant makes native catalog models selectable");
			const wire: Headers[] = [];
			const fetch = (async (_input: unknown, init?: RequestInit) => {
				wire.push(new Headers(init?.headers));
				return new Response(JSON.stringify({ error: { message: "fixture quota", type: "rate_limit_error" } }), {
					status: 429,
					headers: { "retry-after": "60", "content-type": "application/json" },
				});
			}) as typeof globalThis.fetch;
			const result = await runtime
				.streamSimple(
					model,
					{ messages: [{ role: "user", content: "fixture", timestamp: NOW }] },
					{
						requestId: "selected-request",
						transport: "sse",
						maxRetries: 0,
						fetch,
						// Reproduces the old Codex overwrite: native shaping must not retain this primary header.
						headers: { authorization: "Bearer primary-header", "chatgpt-account-id": "primary-header" },
						onResponse: async (response) => {
							await hooks.get("after_provider_response")!(
								{ ...response, requestId: "selected-request" },
								{ ...context, model },
							);
						},
					},
				)
				.result();
			assert.equal(wire.length, 1);
			assert.equal(wire[0].get("chatgpt-account-id"), "selected");
			assert.equal(
				wire[0].get("authorization"),
				`Bearer ${(grant("selected") as Extract<Credential, { type: "oauth" }>).access}`,
			);
			assert.equal(result.stopReason, "error");
			assert.equal(
				(await new AccountsStore(directory).getSlot("openai-codex", "selected"))?.cooldownUntil,
				NOW + 60_000,
			);
			const denied = await runtime
				.streamSimple(model, { messages: [] }, { fetch, transport: "sse", maxRetries: 0 })
				.result();
			assert.equal(denied.stopReason, "error");
			assert.match(denied.errorMessage ?? "", /No authorised resource/);
			assert.equal(wire.length, 1, "exhaustion never falls through to primary auth");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("Retry-After seconds are relative while HTTP dates remain absolute", () => {
	assert.equal(readUsageHeaders({ "retry-after": "60" }, NOW)?.resetAt, NOW + 60_000);
	assert.equal(
		readUsageHeaders({ "retry-after": new Date(NOW + 120_000).toUTCString() }, NOW)?.resetAt,
		NOW + 120_000,
	);
});

test("pooled OAuth refresh rechecks under the shared account lock", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-account-refresh-"));
	try {
		const first = new AccountsStore(directory);
		const second = new AccountsStore(directory);
		await first.putSlot("openai-codex", { id: "seat", kind: "oauth" }, {
			...grant("seat"),
			expires: NOW - 1,
		} as Credential);
		let calls = 0;
		const refresh = async () => {
			calls++;
			return grant("rotated");
		};
		const results = await Promise.all([
			first.refreshCredential("openai-codex", "seat", refresh, NOW),
			second.refreshCredential("openai-codex", "seat", refresh, NOW),
		]);
		assert.equal(calls, 1);
		assert.deepEqual(results, [grant("rotated"), grant("rotated")]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("quota ranking forgets an expired reset window instead of treating it as fresh allowance", () => {
	let now = NOW;
	const usage = new UsageCache({ now: () => now });
	usage.recordHeaders("openai-codex", "seat", { "x-codex-primary-used-percent": "99", "retry-after": "60" });
	assert.equal(usage.remainingPercent("openai-codex", "seat"), 1);
	now += 60_000;
	assert.equal(usage.remainingPercent("openai-codex", "seat"), undefined);
});
