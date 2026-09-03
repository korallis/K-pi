import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Credential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import {
	ANTHROPIC_EXTRA_USAGE_WARNING,
	registerAccounts,
	ZAI_PERSONAL_USE_NOTE,
} from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";

const EXPECTED_ANTHROPIC_WARNING = `Claude Pro/Max in this harness uses Anthropic’s subscription OAuth, same as Pi and Atomic.

Anthropic’s own docs: third-party harness usage draws from extra usage and is billed per token, not against the in-app Claude plan bar.

API keys (ANTHROPIC_API_KEY) are a separate pay-as-you-go path.

You are responsible for the seats you attach.

Continue?`;
const FIXED_TIME = new Date("2026-09-01T12:00:00.000Z");

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

interface AccountsHarness {
	command: CommandHandler;
	confirmations: Array<{ title: string; message: string }>;
	context: ExtensionCommandContext;
	directory: string;
	loginCalls: Array<{ providerId: string; slotId: string }>;
	notifications: string[];
	sequence: string[];
	store: AccountsStore;
}

function oauthCredential(slotId: string): Credential {
	return {
		type: "oauth",
		access: `access-${slotId}`,
		refresh: `refresh-${slotId}`,
		expires: FIXED_TIME.getTime() + 3_600_000,
	};
}

async function harness(confirm: boolean): Promise<AccountsHarness> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-accounts-"));
	const store = new AccountsStore(directory);
	const commands = new Map<string, CommandHandler>();
	const confirmations: Array<{ title: string; message: string }> = [];
	const loginCalls: Array<{ providerId: string; slotId: string }> = [];
	const notifications: string[] = [];
	const sequence: string[] = [];
	const pi = {
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
	};
	registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], {
		store,
		now: () => FIXED_TIME,
		async login(providerId, slotId) {
			sequence.push("oauth");
			loginCalls.push({ providerId, slotId });
			return oauthCredential(slotId);
		},
	});
	const context = {
		cwd: directory,
		hasUI: true,
		mode: "tui",
		ui: {
			async confirm(title: string, message: string) {
				sequence.push("confirm");
				confirmations.push({ title, message });
				return confirm;
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;
	return {
		command: commands.get("accounts")!,
		confirmations,
		context,
		directory,
		loginCalls,
		notifications,
		sequence,
		store,
	};
}

test("cancelled Anthropic warning creates no account slot", async () => {
	const subject = await harness(false);
	try {
		await subject.command("login anthropic home", subject.context);

		assert.deepEqual(subject.loginCalls, []);
		assert.deepEqual((await subject.store.read()).pools, {});
		assert.equal(subject.confirmations.length, 1);
		assert.equal(subject.confirmations[0]?.message, EXPECTED_ANTHROPIC_WARNING);
		assert.equal(ANTHROPIC_EXTRA_USAGE_WARNING, EXPECTED_ANTHROPIC_WARNING);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("accepted warning is persisted and not repeated for the same slot", async () => {
	const subject = await harness(true);
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic home", subject.context);

		const slots = (await subject.store.read()).pools.anthropic?.slots;
		assert.equal(subject.confirmations.length, 1);
		assert.equal(subject.loginCalls.length, 2);
		assert.deepEqual(subject.sequence.slice(0, 2), ["confirm", "oauth"]);
		assert.equal(slots?.length, 1);
		assert.equal(slots?.[0]?.warningAcceptedAt, FIXED_TIME.toISOString());
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("Anthropic warning precedes the official OAuth window", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-accounts-oauth-"));
	const store = new AccountsStore(directory);
	const commands = new Map<string, CommandHandler>();
	const sequence: string[] = [];
	const pi = {
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		async exec(command: string, args: string[]) {
			sequence.push(`open:${command}:${args.at(-1)}`);
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], {
		store,
		now: () => FIXED_TIME,
	});
	const context = {
		cwd: directory,
		hasUI: true,
		mode: "tui",
		signal: undefined,
		modelRegistry: {
			getProvider() {
				return { auth: { oauth: {} } };
			},
			async login(_providerId: string, _method: string, interaction: ProviderAuthInteraction) {
				sequence.push("oauth");
				interaction.notify({
					type: "auth_url",
					url: "https://example.test/oauth",
				});
				return oauthCredential("home");
			},
		},
		ui: {
			async confirm() {
				sequence.push("confirm");
				return true;
			},
			notify() {},
		},
	} as unknown as ExtensionCommandContext;
	try {
		await commands.get("accounts")!("login anthropic home", context);

		assert.deepEqual(sequence.slice(0, 2), ["confirm", "oauth"]);
		assert.match(sequence[2] ?? "", /^open:.*:https:\/\/example\.test\/oauth$/u);
		assert.equal((await store.read()).pools.anthropic?.slots[0]?.id, "home");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("two Anthropic subscription slots coexist", async () => {
	const subject = await harness(true);
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);

		const document = await subject.store.read();
		assert.deepEqual(
			document.pools.anthropic?.slots.map((slot) => slot.id),
			["home", "work"],
		);
		assert.deepEqual(Object.keys(await subject.store.readSecrets()).sort(), ["anthropic/home", "anthropic/work"]);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("account metadata and secrets files use mode 0600 on POSIX", { skip: process.platform === "win32" }, async () => {
	const subject = await harness(true);
	try {
		await subject.command("login anthropic home", subject.context);

		const [accountsMode, secretsMode] = await Promise.all([
			stat(subject.store.accountsPath),
			stat(subject.store.secretsPath),
		]);
		assert.equal(accountsMode.mode & 0o777, 0o600);
		assert.equal(secretsMode.mode & 0o777, 0o600);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("accounts logout removes only the selected slot and secret", async () => {
	const subject = await harness(true);
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);
		await subject.command("logout anthropic/home", subject.context);

		assert.deepEqual(
			(await subject.store.read()).pools.anthropic?.slots.map((slot) => slot.id),
			["work"],
		);
		assert.deepEqual(Object.keys(await subject.store.readSecrets()), ["anthropic/work"]);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

type ProviderHook = (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;

interface RoutingHarness {
	command: CommandHandler;
	context: ExtensionCommandContext;
	directory: string;
	hooks: Map<string, ProviderHook>;
	/** A hook context carrying the same status sink as the command context. */
	hookContext: (model?: { provider: string; id: string }, available?: unknown[]) => Record<string, unknown>;
	readerCalls: string[];
	setModelCalls: string[];
	status: Array<string | undefined>;
	notifications: string[];
	store: AccountsStore;
}

function anthropicModel(id = "claude-opus-4-6") {
	return { provider: "anthropic", id, name: id };
}

/** Captures the registered provider hooks, exactly as the harness calls them. */
async function routingHarness(readerPercent: number | undefined = 42, setModelResult = true): Promise<RoutingHarness> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-routing-"));
	const store = new AccountsStore(directory);
	const commands = new Map<string, CommandHandler>();
	const hooks = new Map<string, ProviderHook>();
	const readerCalls: string[] = [];
	const setModelCalls: string[] = [];
	const status: Array<string | undefined> = [];
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: ProviderHook) {
			hooks.set(event, handler);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		async setModel(model: { provider: string; id: string }) {
			setModelCalls.push(`${model.provider}/${model.id}`);
			return setModelResult;
		},
	};
	registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], {
		store,
		now: () => FIXED_TIME,
		fallbackModels: async () => undefined,
		async login(_providerId, slotId) {
			return oauthCredential(slotId);
		},
		usageReaders: {
			cursor: ({ poolId, slotId }) => {
				readerCalls.push(`${poolId}/${slotId}`);
				return { remainingPercent: readerPercent };
			},
		},
	});
	const ui = {
		async confirm() {
			return true;
		},
		notify(message: string) {
			notifications.push(message);
		},
		setStatus(_key: string, value?: string) {
			status.push(value);
		},
	};
	const context = { cwd: directory, hasUI: true, mode: "tui", ui } as unknown as ExtensionCommandContext;
	const hookContext = (
		model: { provider: string; id: string } | undefined = anthropicModel(),
		available: unknown[] = [],
	): Record<string, unknown> => ({
		cwd: directory,
		model,
		ui,
		modelRegistry: { getAvailable: () => available },
	});
	return {
		command: commands.get("accounts")!,
		context,
		directory,
		hooks,
		hookContext,
		readerCalls,
		setModelCalls,
		status,
		notifications,
		store,
	};
}

test("session start refreshes each expired subscription slot independently", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);
		for (const slotId of ["home", "work"]) {
			const slot = await subject.store.getSlot("anthropic", slotId);
			assert.ok(slot);
			await subject.store.putSlot("anthropic", slot, {
				type: "oauth",
				access: `expired-${slotId}`,
				refresh: `refresh-${slotId}`,
				expires: FIXED_TIME.getTime() - 1,
			});
		}
		const refreshed: string[] = [];
		const context = {
			...subject.hookContext(),
			modelRegistry: {
				getAvailable: () => [],
				getProvider: () => ({
					auth: {
						oauth: {
							async refresh(credential: Credential) {
								assert.equal(credential.type, "oauth");
								refreshed.push(credential.refresh);
								return {
									...credential,
									access: `fresh-${credential.refresh}`,
									expires: FIXED_TIME.getTime() + 3_600_000,
								};
							},
						},
					},
				}),
			},
		};

		await subject.hooks.get("session_start")!({ type: "session_start" }, context);
		assert.deepEqual(refreshed.sort(), ["refresh-home", "refresh-work"]);
		const secrets = await subject.store.readSecrets();
		assert.equal(
			secrets["anthropic/home"]?.type === "oauth" && secrets["anthropic/home"].access,
			"fresh-refresh-home",
		);
		assert.equal(
			secrets["anthropic/work"]?.type === "oauth" && secrets["anthropic/work"].access,
			"fresh-refresh-work",
		);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("the request-header hook reads cached usage and never refreshes on the hot path", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login cursor default", subject.context);
		const headers: Record<string, string> = {};

		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers, requestId: "request-1" },
			subject.hookContext({ provider: "cursor", id: "cursor-fast" }),
		);

		assert.equal(headers.authorization, "Bearer access-default", "the hook still injects the slot credential");
		assert.deepEqual(subject.readerCalls, [], "no usage reader may run while a request is being built");

		// The refresh path is session start, off the request path.
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		assert.deepEqual(subject.readerCalls, ["cursor/default"]);
		assert.match(subject.status.at(-1) ?? "", /default 42%/u, "the widget shows the real cached percentage");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("the widget follows the route from unknown, to selected, to parsed usage, to failover", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);

		// 1. Accounts exist but nothing has been routed: unknown, no route.
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		const initial = subject.status.at(-1) ?? "";
		assert.match(initial, /home \?%/u);
		assert.match(initial, /work \?%/u);
		assert.doesNotMatch(initial, /ROUTE/u, "no route before a slot is selected");

		// 2. The header hook selects a slot: the route appears.
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "request-2" },
			subject.hookContext(),
		);
		const routed = subject.status.at(-1) ?? "";
		assert.match(routed, /ROUTE {3}anthropic\/claude-opus-4-6 {2}via home/u);
		assert.match(routed, /home \?%/u, "usage is still unknown until a response states it");

		// 3. A successful response's own headers land in the cache and are shown.
		await subject.hooks.get("after_provider_response")!(
			{
				type: "after_provider_response",
				requestId: "request-2",
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-limit": "1000",
					"anthropic-ratelimit-unified-remaining": "250",
					"anthropic-ratelimit-unified-window": "5h",
				},
			},
			subject.hookContext(),
		);
		const measured = subject.status.at(-1) ?? "";
		assert.match(measured, /home 25% 5h/u, "a non-failure response must still publish its limits");
		assert.match(measured, /ROUTE {3}anthropic\/claude-opus-4-6 {2}via home/u);

		// 4. A 429 cools the slot, fails over, and both facts reach the widget. The
		// response states no remaining count, so usage stays unknown rather than
		// being fabricated as zero.
		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "request-2", status: 429, headers: { "retry-after": "3600" } },
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		const failedOver = subject.status.at(-1) ?? "";
		assert.match(failedOver, /home \?% cd 60m/u, "the cooled slot shows its cooldown on the injected clock");
		assert.match(failedOver, /ROUTE {3}anthropic\/claude-opus-4-6 {2}via work/u, "the route moved to the sibling");
		assert.deepEqual(subject.setModelCalls, [], "a sibling failover keeps the exact model");

		// 5. The next request is built on the new route, and its own 429 states its
		// counts, so the real zero is published against the slot that just ran.
		// Attribution is per request: this response may not be charged to the slot
		// the previous request used.
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "request-2b" },
			subject.hookContext(),
		);
		await subject.hooks.get("after_provider_response")!(
			{
				type: "after_provider_response",
				requestId: "request-2b",
				status: 429,
				headers: {
					"retry-after": "1800",
					"anthropic-ratelimit-unified-limit": "1000",
					"anthropic-ratelimit-unified-remaining": "0",
				},
			},
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		const exhausted = subject.status.at(-1) ?? "";
		assert.match(exhausted, /work 0% cd 30m/u, "a stated zero is shown as zero");
		assert.match(
			exhausted,
			/ROUTE {3}anthropic\/claude-opus-4-6 {2}via work/u,
			"with no healthy successor the route still names the slot that ran, beside its cooldown",
		);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a 98%-used Codex plan hands the same model to its sibling before the next request", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login openai-codex plan-1", subject.context);
		await subject.command("login openai-codex plan-2", subject.context);
		const model = { provider: "openai-codex", id: "gpt-5.6-sol", name: "gpt-5.6-sol" };
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "codex-near-limit" },
			subject.hookContext(model, [model]),
		);
		await subject.hooks.get("after_provider_response")!(
			{
				type: "after_provider_response",
				requestId: "codex-near-limit",
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "98",
					"x-codex-primary-reset-after-seconds": "3600",
					"x-codex-primary-window-minutes": "300",
				},
			},
			subject.hookContext(model, [model]),
		);

		const nextHeaders: Record<string, string> = {};
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: nextHeaders, requestId: "codex-sibling" },
			subject.hookContext(model, [model]),
		);
		assert.equal(nextHeaders.authorization, "Bearer access-plan-2");
		assert.deepEqual(subject.setModelCalls, [], "same-provider handoff preserves the exact GPT model");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a classified 402 marks the moved sibling route for an automatic retry", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "payment-home" },
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "payment-home", status: 402, headers: {} },
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		const retry = (await subject.hooks.get("message_end")!(
			{
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "402 payment required" },
			},
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		)) as { message?: { diagnostics?: Array<{ type: string }> } } | undefined;

		assert.equal(retry?.message?.diagnostics?.at(-1)?.type, "kpi_account_failover");
		assert.deepEqual(subject.setModelCalls, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("quota-shaped 400 assistant errors exhaust sibling plans before changing provider", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);
		await subject.command("login xai grok", subject.context);
		const available = [anthropicModel(), { provider: "xai", id: "grok-5", name: "grok-5" }];
		const assistantError = {
			role: "assistant",
			stopReason: "error",
			errorMessage: '400 {"error":{"message":"You are out of extra usage"}}',
		};

		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "quota-home" },
			subject.hookContext(anthropicModel(), available),
		);
		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "quota-home", status: 400, headers: {} },
			subject.hookContext(anthropicModel(), available),
		);
		const siblingRetry = (await subject.hooks.get("message_end")!(
			{ type: "message_end", message: assistantError },
			subject.hookContext(anthropicModel(), available),
		)) as { message?: { diagnostics?: Array<{ type: string }> } } | undefined;
		assert.deepEqual(subject.setModelCalls, [], "the same GPT/Claude model survives sibling-plan handoff");
		assert.equal(siblingRetry?.message?.diagnostics?.at(-1)?.type, "kpi_account_failover");

		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "quota-work" },
			subject.hookContext(anthropicModel(), available),
		);
		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "quota-work", status: 400, headers: {} },
			subject.hookContext(anthropicModel(), available),
		);
		const providerRetry = (await subject.hooks.get("message_end")!(
			{ type: "message_end", message: assistantError },
			subject.hookContext(anthropicModel(), available),
		)) as { message?: { diagnostics?: Array<{ type: string }> } } | undefined;
		assert.deepEqual(subject.setModelCalls, ["xai/grok-5"], "provider fallback waits for both plans to cool");
		assert.equal(providerRetry?.message?.diagnostics?.at(-1)?.type, "kpi_account_failover");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a cross-family failover republishes the widget with the mapped model and pool", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login xai grok", subject.context);

		const available = [anthropicModel(), { provider: "xai", id: "grok-5", name: "grok-5" }];
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "request-3" },
			subject.hookContext(anthropicModel(), available),
		);
		assert.match(subject.status.at(-1) ?? "", /ROUTE {3}anthropic\/claude-opus-4-6 {2}via home/u);

		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "request-3", status: 429, headers: {} },
			subject.hookContext(anthropicModel(), available),
		);

		assert.deepEqual(subject.setModelCalls, ["xai/grok-5"]);
		assert.match(
			subject.status.at(-1) ?? "",
			/ROUTE {3}xai\/grok-5 {2}via grok/u,
			"the widget must show the family and model the request moved to",
		);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("login and logout republish the widget", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("list", subject.context);
		assert.deepEqual(subject.status, [], "a read-only command changes nothing to publish");

		await subject.command("login anthropic home", subject.context);
		assert.match(subject.status.at(-1) ?? "", /home \?%/u, "login publishes the new slot");

		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "request-4" },
			subject.hookContext(),
		);
		assert.match(subject.status.at(-1) ?? "", /ROUTE {3}anthropic\/claude-opus-4-6 {2}via home/u);

		await subject.command("logout anthropic/home", subject.context);
		assert.equal(subject.status.at(-1), undefined, "removing the last slot clears the widget and its stale route");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("M-05 through the live hooks: an exhausted slot is never selected in 100 requests", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);

		const beforeHeaders = subject.hooks.get("before_provider_headers")!;
		const afterResponse = subject.hooks.get("after_provider_response")!;
		const route = async (): Promise<string> => {
			const headers: Record<string, string> = {};
			await beforeHeaders(
				{ type: "before_provider_headers", headers, requestId: "request-5" },
				subject.hookContext(),
			);
			return headers.authorization ?? "";
		};

		// The first turn pins a slot; exhaust whichever one it is.
		const first = await route();
		const exhausted = first === "Bearer access-home" ? "home" : "work";
		const survivor = exhausted === "home" ? "work" : "home";
		await afterResponse(
			{ type: "after_provider_response", requestId: "request-5", status: 429, headers: { "retry-after": "3600" } },
			subject.hookContext(),
		);

		const used: string[] = [];
		for (let attempt = 0; attempt < 100; attempt += 1) {
			used.push(await route());
		}

		assert.equal(used.length, 100);
		assert.equal(
			used.filter((header) => header === `Bearer access-${exhausted}`).length,
			0,
			"the exhausted slot was selected through the live hook",
		);
		assert.deepEqual([...new Set(used)], [`Bearer access-${survivor}`]);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("same-family failover through the hook keeps the model and thinking level untouched", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);

		const session = { model: anthropicModel(), thinkingLevel: "xhigh" as const };
		const available = [anthropicModel(), { provider: "xai", id: "grok-5", name: "grok-5" }];
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "request-6" },
			subject.hookContext(session.model, available),
		);
		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "request-6", status: 429, headers: {} },
			subject.hookContext(session.model, available),
		);

		assert.deepEqual(subject.setModelCalls, [], "a sibling failover must not re-point the model");
		assert.equal(session.model.id, "claude-opus-4-6");
		assert.equal(session.thinkingLevel, "xhigh");

		// The next request routes to the sibling, still on the same model.
		const headers: Record<string, string> = {};
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers, requestId: "request-7" },
			subject.hookContext(session.model, available),
		);
		assert.equal(headers.authorization, "Bearer access-work");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("cross-family failover through the hook re-points the model only after the family cools", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login xai grok", subject.context);

		const available = [anthropicModel(), { provider: "xai", id: "grok-5", name: "grok-5" }];
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "request-8" },
			subject.hookContext(anthropicModel(), available),
		);
		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "request-8", status: 429, headers: {} },
			subject.hookContext(anthropicModel(), available),
		);

		assert.deepEqual(subject.setModelCalls, ["xai/grok-5"], "the only healthy family is xai");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("logout of the pinned slot releases the session pin", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);

		const route = async (): Promise<string> => {
			const headers: Record<string, string> = {};
			await subject.hooks.get("before_provider_headers")!(
				{ type: "before_provider_headers", headers, requestId: "request-9" },
				subject.hookContext(),
			);
			return headers.authorization ?? "";
		};

		const pinned = (await route()) === "Bearer access-home" ? "home" : "work";
		assert.equal(await route(), `Bearer access-${pinned}`, "the pin holds across requests");

		await subject.command(`logout anthropic/${pinned}`, subject.context);
		const survivor = pinned === "home" ? "work" : "home";
		assert.equal(await route(), `Bearer access-${survivor}`, "logout released the pin");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an injected reader cannot corrupt selection or rendering with unusable numbers", async () => {
	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, -5, 900, 42.4]) {
		const subject = await routingHarness(percent);
		try {
			await subject.command("login cursor default", subject.context);
			await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

			const rendered = subject.status.at(-1) ?? "";
			const expected = percent === -5 ? "0%" : percent === 900 ? "100%" : percent === 42.4 ? "42%" : "?%";
			assert.match(rendered, new RegExp(`default ${expected.replace("?", "\\?")}`, "u"), `percent ${percent}`);
			assert.doesNotMatch(rendered, /NaN|Infinity|-\d/u, `percent ${percent} leaked into the widget`);
		} finally {
			await rm(subject.directory, { recursive: true, force: true });
		}
	}
});

test("an unavailable fallback model never substitutes another provider's credential", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login xai grok", subject.context);

		// The catalog offers no xai equivalent, so there is nothing to re-point to.
		const available = [anthropicModel()];
		const headers: Record<string, string> = {};
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers, requestId: "request-10" },
			subject.hookContext(anthropicModel(), available),
		);
		assert.equal(headers.authorization, "Bearer access-home");

		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "request-10", status: 429, headers: {} },
			subject.hookContext(anthropicModel(), available),
		);

		assert.deepEqual(subject.setModelCalls, [], "no mapped model means no model change");
		assert.doesNotMatch(subject.status.at(-1) ?? "", /ROUTE {3}xai/u, "the route must not claim a foreign family");

		// The next anthropic request has no healthy sibling, so it carries no token
		// at all rather than the xai credential.
		const retry: Record<string, string | null> = { authorization: "Bearer primary-auth-json-token" };
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: retry, requestId: "request-11" },
			subject.hookContext(anthropicModel(), available),
		);
		assert.equal(retry.authorization, null, "a cooled pool must not fall through to auth.json's primary token");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a rejected setModel leaves no mismatched active route or token", async () => {
	const subject = await routingHarness(42, false);
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login xai grok", subject.context);

		const available = [anthropicModel(), { provider: "xai", id: "grok-5", name: "grok-5" }];
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: {}, requestId: "request-12" },
			subject.hookContext(anthropicModel(), available),
		);
		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "request-12", status: 429, headers: {} },
			subject.hookContext(anthropicModel(), available),
		);

		assert.deepEqual(subject.setModelCalls, ["xai/grok-5"], "the move was attempted");
		const rejected = subject.status.at(-1) ?? "";
		assert.doesNotMatch(rejected, /ROUTE {3}xai/u, "a refused model change must not move the route");
		assert.match(rejected, /ROUTE {3}anthropic\/claude-opus-4-6 {2}via home/u);

		const retry: Record<string, string> = {};
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: retry, requestId: "request-13" },
			subject.hookContext(anthropicModel(), available),
		);
		assert.equal(retry.authorization, undefined, "no xai token may be attached to an anthropic request");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("the header hook only ever attaches a slot from the request's own family", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login xai grok", subject.context);

		for (const [provider, expected] of [
			["anthropic", "Bearer access-home"],
			["xai", "Bearer access-grok"],
		] as const) {
			const headers: Record<string, string> = {};
			await subject.hooks.get("before_provider_headers")!(
				{ type: "before_provider_headers", headers, requestId: "request-14" },
				subject.hookContext({ provider, id: `${provider}-model` }),
			);
			assert.equal(headers.authorization, expected, provider);
		}

		// A provider with no configured pool gets nothing, never a chain neighbour.
		const unconfigured: Record<string, string> = {};
		await subject.hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers: unconfigured, requestId: "request-15" },
			subject.hookContext({ provider: "zai", id: "glm" }),
		);
		assert.equal(unconfigured.authorization, undefined);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("two same-provider requests that finish in reverse order each cool only their own slot", async () => {
	const subject = await routingHarness();
	try {
		// Three slots, so the slot a failover moves the route to is not the slot the
		// in-flight request is holding. That is what makes mis-attribution visible.
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);
		await subject.command("login anthropic spare", subject.context);

		const beforeHeaders = subject.hooks.get("before_provider_headers")!;
		const afterResponse = subject.hooks.get("after_provider_response")!;

		// Request A is built on `work`. The route then moves - an operator pin here,
		// a failover in production - and request B is built on `spare` while A is
		// still in flight.
		await subject.command("pin anthropic/work", subject.context);
		const firstHeaders: Record<string, string> = {};
		await beforeHeaders(
			{ type: "before_provider_headers", headers: firstHeaders, requestId: "A" },
			subject.hookContext(),
		);
		await subject.command("pin anthropic/spare", subject.context);
		const secondHeaders: Record<string, string> = {};
		await beforeHeaders(
			{ type: "before_provider_headers", headers: secondHeaders, requestId: "B" },
			subject.hookContext(),
		);
		assert.equal(firstHeaders.authorization, "Bearer access-work");
		assert.equal(secondHeaders.authorization, "Bearer access-spare");

		// They complete in reverse order: B answers first, then A.
		await afterResponse(
			{ type: "after_provider_response", requestId: "B", status: 429, headers: { "retry-after": "600" } },
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		const afterB = subject.status.at(-1) ?? "";
		assert.match(afterB, /spare \?% cd 10m/u, "B's own slot cooled");
		assert.doesNotMatch(afterB, /work \?% cd/u, "A's slot was never cooled by B's response");
		// B's failover re-pointed the route at `home`, which is neither request's
		// slot: a route-based attribution would now charge A's response to `home`.
		assert.match(afterB, /via home/u);

		await afterResponse(
			{ type: "after_provider_response", requestId: "A", status: 429, headers: { "retry-after": "1800" } },
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		const afterA = subject.status.at(-1) ?? "";
		assert.match(afterA, /work \?% cd 30m/u, "A's own slot cooled with A's own retry-after");
		assert.match(afterA, /spare \?% cd 10m/u, "and B's earlier cooldown is unchanged");
		assert.doesNotMatch(afterA, /home \?% cd/u, "the current route was never charged for another request");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an assistant error pairs only with the one failed response still pending", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		await subject.command("login anthropic work", subject.context);
		await subject.command("login anthropic spare", subject.context);
		const beforeHeaders = subject.hooks.get("before_provider_headers")!;
		const afterResponse = subject.hooks.get("after_provider_response")!;
		const messageEnd = subject.hooks.get("message_end")!;
		const context = () => subject.hookContext(anthropicModel(), [anthropicModel()]);
		const quotaError = {
			role: "assistant",
			stopReason: "error",
			errorMessage: '400 {"error":{"message":"You are out of extra usage"}}',
		};

		// A on `work` answers 400 with no headers to classify; B on `spare` answers
		// 200 and is still streaming when A's assistant error ends.
		await subject.command("pin anthropic/work", subject.context);
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "A" }, context());
		await subject.command("pin anthropic/spare", subject.context);
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "B" }, context());
		await afterResponse({ type: "after_provider_response", requestId: "B", status: 200, headers: {} }, context());
		await afterResponse({ type: "after_provider_response", requestId: "A", status: 400, headers: {} }, context());
		// The route is on `spare` now, so A's failure cools `work` without moving
		// the route (and without a failover diagnostic): attribution, not routing.
		await messageEnd({ type: "message_end", message: quotaError }, context());
		const afterA = subject.status.at(-1) ?? "";
		assert.match(afterA, /work \?% cd/u, "the failed response's slot cooled");
		assert.doesNotMatch(afterA, /spare \?% cd/u, "the response still streaming was never charged");

		// Two failed responses pending at once is ambiguous: neither is charged,
		// and the pair is dropped rather than guessed at.
		await subject.command("pin anthropic/spare", subject.context);
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "C" }, context());
		await subject.command("pin anthropic/home", subject.context);
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "D" }, context());
		await afterResponse({ type: "after_provider_response", requestId: "C", status: 400, headers: {} }, context());
		await afterResponse({ type: "after_provider_response", requestId: "D", status: 400, headers: {} }, context());
		const unattributed = (await messageEnd({ type: "message_end", message: quotaError }, context())) as
			| { message?: { diagnostics?: Array<{ type: string; details?: { candidates?: string } }> } }
			| undefined;
		assert.equal(unattributed?.message?.diagnostics?.at(-1)?.type, "kpi_account_unattributed");
		assert.equal(unattributed?.message?.diagnostics?.at(-1)?.details?.candidates, "anthropic/spare,anthropic/home");
		assert.ok(
			subject.notifications.some((note) =>
				/could not be attributed between anthropic\/spare and anthropic\/home/u.test(note),
			),
			subject.notifications.join("\n"),
		);
		const afterAmbiguous = subject.status.at(-1) ?? "";
		assert.doesNotMatch(afterAmbiguous, /spare \?% cd/u);
		assert.doesNotMatch(afterAmbiguous, /home \?% cd/u);
		// The evidence is kept, not dropped: a second error is still ambiguous
		// between the same two, said once, and the run's end clears them.
		const again = (await messageEnd({ type: "message_end", message: quotaError }, context())) as
			| { message?: { diagnostics?: Array<{ type: string }> } }
			| undefined;
		assert.equal(again?.message?.diagnostics?.at(-1)?.type, "kpi_account_unattributed");
		assert.equal(
			subject.notifications.filter((note) => /could not be attributed/u.test(note)).length,
			1,
			"the same ambiguity is announced once",
		);
		await subject.hooks.get("agent_end")!({ type: "agent_end", messages: [] }, context());
		assert.equal(
			await messageEnd({ type: "message_end", message: quotaError }, context()),
			undefined,
			"nothing left after the run ended",
		);

		// A successful end releases the one pending success; with two pending it
		// releases neither, because which one ended is not known.
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "E" }, context());
		await afterResponse({ type: "after_provider_response", requestId: "E", status: 200, headers: {} }, context());
		await messageEnd({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }, context());
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "F" }, context());
		await afterResponse({ type: "after_provider_response", requestId: "F", status: 200, headers: {} }, context());
		const late = (await messageEnd({ type: "message_end", message: quotaError }, context())) as
			| { message?: { diagnostics?: Array<{ type: string }> } }
			| undefined;
		assert.notEqual(late?.message?.diagnostics?.at(-1)?.type, "kpi_account_unattributed", "F alone: one candidate");
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "G" }, context());
		await beforeHeaders({ type: "before_provider_headers", headers: {}, requestId: "H" }, context());
		await afterResponse({ type: "after_provider_response", requestId: "G", status: 200, headers: {} }, context());
		await afterResponse({ type: "after_provider_response", requestId: "H", status: 200, headers: {} }, context());
		await messageEnd({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }, context());
		const stillTwo = (await messageEnd({ type: "message_end", message: quotaError }, context())) as
			| { message?: { diagnostics?: Array<{ type: string }> } }
			| undefined;
		assert.equal(stillTwo?.message?.diagnostics?.at(-1)?.type, "kpi_account_unattributed", "G and H both kept");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a request that never answers leaks no attribution and blocks nothing", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		const beforeHeaders = subject.hooks.get("before_provider_headers")!;
		const afterResponse = subject.hooks.get("after_provider_response")!;

		// A transport failure: the request is built, no response ever arrives.
		await beforeHeaders(
			{ type: "before_provider_headers", headers: {}, requestId: "abandoned" },
			subject.hookContext(),
		);

		// An unrelated response - a compaction turn, or an adapter that never
		// reports - must not be charged to the abandoned request's slot.
		await afterResponse(
			{ type: "after_provider_response", requestId: "unpaired", status: 429, headers: { "retry-after": "3600" } },
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		assert.doesNotMatch(subject.status.at(-1) ?? "", /cd \d+m/u, "no slot was cooled by an unpaired response");

		// The next real request still routes, and the pool is not stuck.
		const headers: Record<string, string> = {};
		await beforeHeaders({ type: "before_provider_headers", headers, requestId: "next" }, subject.hookContext());
		assert.equal(headers.authorization, "Bearer access-home", "the pool still serves after an abandoned request");

		// Many abandoned requests cannot grow attribution without bound.
		for (let index = 0; index < 200; index += 1) {
			await beforeHeaders(
				{ type: "before_provider_headers", headers: {}, requestId: `leak-${index}` },
				subject.hookContext(),
			);
		}
		await afterResponse(
			{ type: "after_provider_response", requestId: "leak-0", status: 429, headers: { "retry-after": "3600" } },
			subject.hookContext(anthropicModel(), [anthropicModel()]),
		);
		assert.doesNotMatch(
			subject.status.at(-1) ?? "",
			/cd \d+m/u,
			"an evicted request records nothing rather than charging a stale slot",
		);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a credential travels in the header its own provider reads", async () => {
	const subject = await routingHarness();
	try {
		await subject.command("login anthropic home", subject.context);
		const beforeHeaders = subject.hooks.get("before_provider_headers")!;

		// An api_key slot for Anthropic must arrive as x-api-key, never as a bearer
		// token the provider does not read.
		await subject.store.putSlot(
			"anthropic",
			{ id: "keyed", kind: "api_key", label: "keyed" },
			{ type: "api_key", key: "sk-ant-key" },
		);
		const cases: { api: string; provider: string; header: string; value: string }[] = [
			{ api: "anthropic-messages", provider: "anthropic", header: "x-api-key", value: "sk-ant-key" },
			{ api: "openai-completions", provider: "anthropic", header: "authorization", value: "Bearer sk-ant-key" },
			{ api: "google-generative-ai", provider: "anthropic", header: "x-goog-api-key", value: "sk-ant-key" },
			{ api: "azure-openai-responses", provider: "anthropic", header: "api-key", value: "sk-ant-key" },
		];

		for (const scenario of cases) {
			await subject.command("pin anthropic/keyed", subject.context);
			const headers: Record<string, string | null> = {};
			await beforeHeaders(
				{ type: "before_provider_headers", headers, requestId: `api-${scenario.api}` },
				{
					...subject.hookContext({ provider: scenario.provider, id: "model-1" }),
					model: { provider: scenario.provider, id: "model-1", api: scenario.api },
				},
			);
			const attached = Object.entries(headers).filter(([, value]) => typeof value === "string");
			assert.deepEqual(
				attached,
				[[scenario.header, scenario.value]],
				`${scenario.api} reads ${scenario.header} and nothing else is invented`,
			);
		}

		// A subscription token is a bearer token everywhere, including Anthropic.
		await subject.command("pin anthropic/home", subject.context);
		const oauthHeaders: Record<string, string | null> = {};
		await beforeHeaders(
			{ type: "before_provider_headers", headers: oauthHeaders, requestId: "oauth-anthropic" },
			{
				...subject.hookContext(),
				model: { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" },
			},
		);
		assert.equal(oauthHeaders.authorization, "Bearer access-home", "an OAuth token stays a bearer token");
		assert.equal(oauthHeaders["x-api-key"], undefined);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

/** Only what the login path reads off a provider: its declared auth methods. */
interface ProviderStub {
	auth: {
		apiKey?: { name: string };
		oauth?: { login(interaction: ProviderAuthInteraction): Promise<Credential> };
	};
}

interface ProviderLoginHarness {
	command: CommandHandler;
	context: ExtensionCommandContext;
	directory: string;
	inputs: Array<{ title: string; placeholder: string | undefined }>;
	notifications: string[];
	sequence: string[];
	store: AccountsStore;
}

/**
 * `/accounts` with no injected `login`, so the extension's own dispatch runs
 * against whatever auth the registry declares for the pool.
 */
async function providerLoginHarness(
	providers: Record<string, ProviderStub>,
	answers: Array<string | undefined>,
): Promise<ProviderLoginHarness> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-provider-login-"));
	const store = new AccountsStore(directory);
	const commands = new Map<string, CommandHandler>();
	const inputs: Array<{ title: string; placeholder: string | undefined }> = [];
	const notifications: string[] = [];
	const sequence: string[] = [];
	const pending = [...answers];
	const pi = {
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		async exec() {
			sequence.push("open");
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], { store, now: () => FIXED_TIME });
	const context = {
		cwd: directory,
		hasUI: true,
		mode: "tui",
		modelRegistry: {
			getProvider(id: string) {
				return providers[id];
			},
			async login(id: string, type: "oauth" | "api_key", interaction: ProviderAuthInteraction) {
				sequence.push("runtime-login");
				if (type !== "oauth" || providers[id]?.auth.oauth === undefined) {
					throw new Error(`Provider ${id} has no ${type} login`);
				}
				return providers[id].auth.oauth.login(interaction);
			},
		},
		ui: {
			async confirm() {
				sequence.push("confirm");
				return true;
			},
			async input(title: string, placeholder?: string) {
				sequence.push("input");
				inputs.push({ title, placeholder });
				return pending.shift();
			},
			notify(message: string) {
				sequence.push("notify");
				notifications.push(message);
			},
			setStatus() {},
		},
	} as unknown as ExtensionCommandContext;
	return { command: commands.get("accounts")!, context, directory, inputs, notifications, sequence, store };
}

const ZAI_PROVIDERS: Record<string, ProviderStub> = { zai: { auth: { apiKey: { name: "Z.AI API key" } } } };

test("/accounts login zai notes personal use, then stores a key slot under the provider's own label", async () => {
	const subject = await providerLoginHarness(ZAI_PROVIDERS, ["  zai-secret-key  "]);
	try {
		await subject.command("login zai home", subject.context);

		assert.deepEqual(subject.sequence.slice(0, 2), ["notify", "input"], "the note precedes the key prompt");
		assert.equal(subject.notifications[0], ZAI_PERSONAL_USE_NOTE);
		assert.deepEqual(subject.inputs, [{ title: "Z.AI API key", placeholder: "Paste the key, or Enter to cancel" }]);

		const slots = (await subject.store.read()).pools.zai?.slots;
		assert.deepEqual(slots, [
			{ id: "home", kind: "api_key", label: "home", warningAcceptedAt: FIXED_TIME.toISOString() },
		]);
		assert.deepEqual(await subject.store.readSecrets(), { "zai/home": { type: "api_key", key: "zai-secret-key" } });
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a cancelled or empty zai key prompt creates no slot and writes no secret", async () => {
	const subject = await providerLoginHarness(ZAI_PROVIDERS, [undefined, "   "]);
	try {
		await subject.command("login zai home", subject.context);
		await subject.command("login zai home", subject.context);

		assert.equal(subject.inputs.length, 2, "both a dismissal and a blank answer reached the prompt");
		assert.deepEqual((await subject.store.read()).pools, {});
		assert.deepEqual(await subject.store.readSecrets(), {});
		assert.deepEqual(
			subject.notifications.filter((message) => message.includes("cancelled")),
			["K-\u03c0 accounts: Login cancelled", "K-\u03c0 accounts: Login cancelled"],
		);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("the zai key reaches the secret store and never a notification or accounts.json", async () => {
	const subject = await providerLoginHarness(ZAI_PROVIDERS, ["zai-secret-key"]);
	try {
		await subject.command("login zai home", subject.context);

		for (const message of subject.notifications) {
			assert.doesNotMatch(message, /zai-secret-key/u, "no notification carries the key");
		}
		assert.doesNotMatch(await readFile(subject.store.accountsPath, "utf8"), /zai-secret-key/u);
		assert.deepEqual((await subject.store.readSecrets())["zai/home"], { type: "api_key", key: "zai-secret-key" });
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a second /accounts login zai on the same slot does not repeat the personal-use note", async () => {
	const subject = await providerLoginHarness(ZAI_PROVIDERS, ["first-key", "second-key"]);
	try {
		await subject.command("login zai home", subject.context);
		await subject.command("login zai home", subject.context);

		assert.deepEqual(
			subject.notifications.filter((message) => message === ZAI_PERSONAL_USE_NOTE),
			[ZAI_PERSONAL_USE_NOTE],
		);
		assert.equal(subject.inputs.length, 2, "the key is still asked for on the re-login");
		assert.equal((await subject.store.read()).pools.zai?.slots.length, 1);
		assert.deepEqual(await subject.store.readSecrets(), { "zai/home": { type: "api_key", key: "second-key" } });
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("kimi-coding still logs in through OAuth although it also declares an API key", async () => {
	const oauthLogins: string[] = [];
	const subject = await providerLoginHarness(
		{
			"kimi-coding": {
				auth: {
					apiKey: { name: "Kimi API key" },
					oauth: {
						async login() {
							oauthLogins.push("kimi-coding");
							return oauthCredential("home");
						},
					},
				},
			},
		},
		[],
	);
	try {
		await subject.command("login kimi-coding home", subject.context);

		assert.deepEqual(oauthLogins, ["kimi-coding"], "the provider's own oauth login ran");
		assert.ok(
			subject.sequence.includes("runtime-login"),
			"the core runtime persists and refreshes the OAuth credential",
		);
		assert.deepEqual(subject.inputs, [], "a subscription provider is never asked for a key");
		assert.equal((await subject.store.read()).pools["kimi-coding"]?.slots[0]?.kind, "oauth");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a pool whose provider declares neither auth method names the pool in the failure", async () => {
	const subject = await providerLoginHarness({ xai: { auth: {} } }, []);
	try {
		await subject.command("login xai home", subject.context);

		assert.deepEqual(subject.notifications, [
			"K-\u03c0 accounts: Provider xai offers neither subscription OAuth nor an API key",
		]);
		assert.deepEqual((await subject.store.read()).pools, {});
		assert.deepEqual(await subject.store.readSecrets(), {});
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});
