import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Credential } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import {
	type AccountsDependencies,
	CODEX_BILLING_CONFIRM,
	CURSOR_BILLING_CONFIRM,
	registerAccounts,
	ZAI_PERSONAL_USE_NOTE,
} from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { renderAccountsWidget } from "../packages/coding-agent/src/kpi/extensions/accounts/widget.ts";

const FIXED_TIME = new Date("2026-09-01T12:00:00.000Z");

type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;
type ProviderHook = (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>;

interface Harness {
	accounts: CommandHandler;
	pool: CommandHandler;
	context: ExtensionCommandContext;
	directory: string;
	errors: string[];
	hooks: Map<string, ProviderHook>;
	notes: string[];
	prompts: string[];
	status: Array<string | undefined>;
	store: AccountsStore;
	/** Runs the header hook from the seeded headers and returns the authorization it left. */
	route: (provider?: string, seeded?: Record<string, string>) => Promise<string>;
	/** A hook context whose provider can refresh; `refresh` stands in for the provider's oauth.refresh. */
	refreshContext: (refresh: (credential: Credential) => Promise<Credential>) => Record<string, unknown>;
	warnings: string[];
}

/**
 * `login` stands in for the runtime's login, which persists a pooled OAuth
 * grant into auth.json (model-runtime.ts login → models.login); a test injects
 * one that writes `store.authPath` itself to reproduce that.
 */
async function harness(
	confirm = true,
	login?: AccountsDependencies["login"],
	existingDirectory?: string,
): Promise<Harness> {
	const directory = existingDirectory ?? (await mkdtemp(join(tmpdir(), "k-pi-commands-")));
	const store = new AccountsStore(directory);
	const commands = new Map<string, CommandHandler>();
	const hooks = new Map<string, ProviderHook>();
	const notes: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const prompts: string[] = [];
	const status: Array<string | undefined> = [];
	const pi = {
		on(event: string, handler: ProviderHook) {
			hooks.set(event, handler);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		async setModel() {
			return true;
		},
	};
	registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], {
		store,
		now: () => FIXED_TIME,
		login:
			login ??
			(async (_providerId, slotId): Promise<Credential> => ({
				type: "oauth",
				access: `access-${slotId}`,
				refresh: `refresh-${slotId}`,
				expires: 0,
			})),
	});
	const ui = {
		async confirm(_title: string, message: string) {
			prompts.push(message);
			return confirm;
		},
		notify(message: string, level?: string) {
			(level === "error" ? errors : level === "warning" ? warnings : notes).push(message);
		},
		setStatus(_key: string, value?: string) {
			status.push(value);
		},
	};
	const context = { cwd: directory, hasUI: true, mode: "tui", ui } as unknown as ExtensionCommandContext;
	const route = async (provider = "anthropic", seeded: Record<string, string> = {}): Promise<string> => {
		const headers: Record<string, string> = { ...seeded };
		await hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers, requestId: "request-1" },
			{
				cwd: directory,
				model: { provider, id: `${provider}-model` },
				ui,
				modelRegistry: { getAvailable: () => [] },
			},
		);
		return headers.authorization ?? "";
	};
	const refreshContext = (refresh: (credential: Credential) => Promise<Credential>): Record<string, unknown> => ({
		...(context as unknown as Record<string, unknown>),
		modelRegistry: {
			getAvailable: () => [],
			getProvider: () => ({ name: "Anthropic", auth: { oauth: { refresh } } }),
		},
	});
	return {
		accounts: commands.get("accounts")!,
		pool: commands.get("pool")!,
		context,
		directory,
		errors,
		hooks,
		notes,
		prompts,
		status,
		store,
		route,
		refreshContext,
		warnings,
	};
}

test("pool strategy and chain persist and survive a reload", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic home", subject.context);
		await subject.pool("strategy anthropic round-robin", subject.context);
		await subject.pool("chain xai,anthropic,cursor", subject.context);

		// A fresh store instance reads the same file the command wrote.
		const reloaded = await new AccountsStore(subject.directory).read();
		assert.equal(reloaded.pools.anthropic?.strategy, "round-robin");
		assert.deepEqual(reloaded.fallback, ["xai", "anthropic", "cursor"]);
		assert.deepEqual(subject.errors, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("the pooled /login path allocates distinct slots and activates the newest subscription", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login-active anthropic", subject.context);
		await subject.accounts("login-active anthropic", subject.context);

		assert.deepEqual(
			(await subject.store.read()).pools.anthropic?.slots.map((slot) => slot.id),
			["default", "slot-2"],
			"each successful unnamed login keeps the existing subscription",
		);
		assert.equal(await subject.route(), "Bearer access-slot-2", "the newly authenticated subscription is active");
		assert.equal(subject.prompts.length, 2, "each new Anthropic seat gets its own warning");
		assert.deepEqual(subject.errors, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an invalid pool, strategy, chain, or slot fails without a partial write", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic home", subject.context);
		await subject.pool("strategy anthropic sticky", subject.context);
		const before = await readFile(subject.store.accountsPath, "utf8");

		for (const command of [
			"strategy nope round-robin",
			"strategy anthropic fastest",
			"strategy xai round-robin",
			"chain anthropic,nope",
			"chain anthropic,anthropic",
			"chain",
			"strategy anthropic",
		]) {
			await subject.pool(command, subject.context);
		}
		for (const command of ["pin anthropic/absent", "pin nope/home", "next anthropic", "next extra args"]) {
			await subject.accounts(command, subject.context);
		}

		assert.equal(subject.errors.length, 11, "every invalid command reported an error");
		assert.equal(await readFile(subject.store.accountsPath, "utf8"), before, "nothing reached disk");
		assert.equal((await new AccountsStore(subject.directory).read()).pools.anthropic?.strategy, "sticky");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a pin holds until the slot is exhausted", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic home", subject.context);
		await subject.accounts("login anthropic work", subject.context);
		await subject.accounts("pin anthropic/work", subject.context);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			assert.equal(await subject.route(), "Bearer access-work", "the pin holds across requests");
		}

		await subject.hooks.get("after_provider_response")!(
			{ type: "after_provider_response", requestId: "request-1", status: 429, headers: { "retry-after": "600" } },
			{
				cwd: subject.directory,
				model: { provider: "anthropic", id: "anthropic-model" },
				ui: subject.context.ui,
				modelRegistry: { getAvailable: () => [] },
			},
		);

		assert.equal(await subject.route(), "Bearer access-home", "an exhausted pin falls to the sibling");
		assert.deepEqual(subject.errors, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("next advances past the slot the session is pinned to", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic home", subject.context);
		await subject.accounts("login anthropic work", subject.context);
		await subject.accounts("pin anthropic/home", subject.context);
		assert.equal(await subject.route(), "Bearer access-home");

		// Normative grammar is no-arg: it advances whatever the session is on.
		await subject.accounts("next", subject.context);

		assert.equal(await subject.route(), "Bearer access-work", "next moved the route off the pin");
		assert.equal(await subject.route(), "Bearer access-work", "and the new slot is now the pin");
		assert.deepEqual(subject.errors, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("logout of the pinned slot releases the pin", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic home", subject.context);
		await subject.accounts("login anthropic work", subject.context);
		await subject.accounts("pin anthropic/work", subject.context);
		assert.equal(await subject.route(), "Bearer access-work");

		await subject.accounts("logout anthropic/work", subject.context);

		assert.equal(await subject.route(), "Bearer access-home", "logout released the pin");
		assert.deepEqual(subject.errors, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a temporary auth.json imports one default slot without exposing its secret", async () => {
	const subject = await harness();
	try {
		await writeFile(
			subject.store.authPath,
			JSON.stringify({
				anthropic: { type: "oauth", access: "official-access-token", refresh: "official-refresh", expires: 0 },
				xai: { type: "api_key", key: "official-xai-key" },
				exa: { type: "api_key", key: "research-not-a-pool" },
				"not-a-pool": { type: "api_key", key: "ignored" },
			}),
		);

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		const document = await new AccountsStore(subject.directory).read();
		assert.deepEqual(
			document.pools.anthropic?.slots.map((slot) => slot.id),
			["default"],
			"exactly one default slot per imported provider",
		);
		assert.equal(document.pools.anthropic?.slots[0]?.kind, "oauth");
		assert.equal(document.pools.xai?.slots[0]?.kind, "api_key");
		assert.deepEqual(Object.keys(document.pools).sort(), ["anthropic", "xai"], "a research credential is not a pool");

		// The secret is usable for routing but never printed or stored in the metadata.
		const metadata = await readFile(subject.store.accountsPath, "utf8");
		assert.doesNotMatch(metadata, /official-access-token|official-xai-key/u, "no secret in accounts.json");
		for (const message of [...subject.notes, ...subject.errors]) {
			assert.doesNotMatch(message, /official-access-token|official-xai-key/u, "no secret in operator output");
		}
		// The official slot's grant is the one auth.json holds: the runtime built
		// this request's header from it, so the hook leaves it in place and K-π
		// keeps no copy of the secret at all.
		assert.equal(
			await subject.route("anthropic", { authorization: "Bearer official-access-token" }),
			"Bearer official-access-token",
		);
		assert.equal(document.pools.anthropic?.slots[0]?.official, true);
		assert.equal(document.pools.xai?.slots[0]?.official, true);
		assert.equal((await subject.store.readSecrets())["anthropic/default"], undefined, "no copy of the grant");
		assert.doesNotMatch(await readFile(subject.store.secretsPath, "utf8").catch(() => ""), /official-/u);

		// Re-importing is idempotent: the default slot is not duplicated.
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		assert.equal((await new AccountsStore(subject.directory).read()).pools.anthropic?.slots.length, 1);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an existing default slot with a live grant of its own is never overwritten by the official import", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic default", subject.context);
		const own = await subject.store.getSlot("anthropic", "default");
		assert.ok(own);
		await subject.store.putSlot("anthropic", own, {
			type: "oauth",
			access: "access-default",
			refresh: "refresh-default",
			expires: FIXED_TIME.getTime() + 3_600_000,
		});
		await writeFile(
			subject.store.authPath,
			JSON.stringify({ anthropic: { type: "oauth", access: "official", refresh: "r", expires: 0 } }),
		);

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		const document = await new AccountsStore(subject.directory).read();
		const slots = document.pools.anthropic?.slots ?? [];
		assert.deepEqual(
			slots.map((slot) => slot.id),
			["default", "slot-2"],
		);
		const secrets = await subject.store.readSecrets();
		assert.equal(
			secrets["anthropic/default"]?.type === "oauth" && secrets["anthropic/default"].refresh,
			"refresh-default",
		);
		assert.equal(slots[0]?.official, undefined, "the operator's own live grant stays K-π-owned");
		assert.equal(slots[1]?.official, true);
		assert.equal(secrets["anthropic/slot-2"], undefined, "the official slot has no secret copy");
		assert.ok(subject.notes.some((note) => note === "Imported official credentials as anthropic/slot-2"));
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("each provider notice appears once per new slot and never after acceptance", async () => {
	const subject = await harness();
	try {
		for (const [pool, expected] of [
			["openai-codex", CODEX_BILLING_CONFIRM],
			["cursor", CURSOR_BILLING_CONFIRM],
		] as const) {
			subject.prompts.length = 0;
			await subject.accounts(`login ${pool} one`, subject.context);
			assert.deepEqual(subject.prompts, [expected], `${pool} confirms once`);

			await subject.accounts(`login ${pool} one`, subject.context);
			assert.deepEqual(subject.prompts, [expected], `${pool} never re-prompts an accepted slot`);

			await subject.accounts(`login ${pool} two`, subject.context);
			assert.deepEqual(subject.prompts, [expected, expected], `${pool} confirms again for a new slot`);
			assert.equal(
				(await subject.store.getSlot(pool, "one"))?.warningAcceptedAt,
				FIXED_TIME.toISOString(),
				`${pool} stamped the acceptance`,
			);
		}

		// z.ai states a note rather than asking, and states it once.
		subject.notes.length = 0;
		subject.prompts.length = 0;
		await subject.accounts("login zai one", subject.context);
		assert.equal(subject.prompts.length, 0, "a note is not a confirm");
		assert.ok(
			subject.notes.some((message) => message === ZAI_PERSONAL_USE_NOTE),
			"the personal-use note was stated",
		);
		subject.notes.length = 0;
		await subject.accounts("login zai one", subject.context);
		assert.equal(
			subject.notes.filter((message) => message === ZAI_PERSONAL_USE_NOTE).length,
			0,
			"the note is not repeated for an accepted slot",
		);

		// A pool with no notice never prompts at all.
		subject.prompts.length = 0;
		await subject.accounts("login kimi-coding one", subject.context);
		assert.deepEqual(subject.prompts, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a declined billing confirm creates no slot", async () => {
	const subject = await harness(false);
	try {
		await subject.accounts("login openai-codex one", subject.context);

		assert.deepEqual(subject.prompts, [CODEX_BILLING_CONFIRM]);
		assert.deepEqual((await subject.store.read()).pools, {});
		assert.deepEqual(Object.keys(await subject.store.readSecrets()), []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("next uses the current active route, needs one, and takes no arguments", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic home", subject.context);
		await subject.accounts("login anthropic work", subject.context);

		// No turn has run, so there is no route to advance.
		await subject.accounts("next", subject.context);
		assert.equal(subject.errors.length, 1);
		assert.match(subject.errors[0], /No active route to advance/u);

		// The route is whatever the last request used, not an argument.
		assert.equal(await subject.route(), "Bearer access-home");
		subject.notes.length = 0;
		await subject.accounts("next", subject.context);
		assert.match(subject.notes.at(-1) ?? "", /Advanced past the pinned anthropic slot/u);
		assert.equal(await subject.route(), "Bearer access-work", "the next header hook honours the steer");

		// Extra arguments are refused rather than silently ignored.
		subject.errors.length = 0;
		await subject.accounts("next anthropic", subject.context);
		await subject.accounts("next xai extra", subject.context);
		assert.equal(subject.errors.length, 2);
		for (const message of subject.errors) {
			assert.match(message, /Usage: \/accounts next/u);
		}
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("pin and next republish a route the next request will actually use", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic home", subject.context);
		await subject.accounts("login anthropic work", subject.context);
		assert.equal(await subject.route(), "Bearer access-home");

		subject.status.length = 0;
		await subject.accounts("pin anthropic/work", subject.context);
		assert.match(
			subject.status.at(-1) ?? "",
			/ROUTE {3}anthropic\/anthropic-model {2}via work/u,
			"the widget states the pinned slot immediately, not the stale one",
		);
		assert.equal(await subject.route(), "Bearer access-work", "and the header hook agrees");

		subject.status.length = 0;
		await subject.accounts("next", subject.context);
		assert.match(
			subject.status.at(-1) ?? "",
			/ROUTE {3}anthropic\/anthropic-model {2}via home/u,
			"advancing republishes the slot the session moved to",
		);
		assert.equal(await subject.route(), "Bearer access-home");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a malformed persisted accounts document is refused rather than half-read", async () => {
	const subject = await harness();
	try {
		const valid = {
			version: 1,
			pools: { anthropic: { strategy: "quota-first", slots: [{ id: "home", kind: "oauth" }] } },
			fallback: ["anthropic"],
			stickiness: "session-until-exhausted",
		};

		const broken: Array<[string, unknown]> = [
			["empty fallback", { ...valid, fallback: [] }],
			["repeated fallback", { ...valid, fallback: ["anthropic", "anthropic"] }],
			["unknown fallback pool", { ...valid, fallback: ["nope"] }],
			["unknown pool id", { ...valid, pools: { nope: valid.pools.anthropic } }],
			["unknown strategy", { ...valid, pools: { anthropic: { strategy: "fastest", slots: [] } } }],
			[
				"duplicate slot id",
				{
					...valid,
					pools: {
						anthropic: {
							strategy: "quota-first",
							slots: [
								{ id: "home", kind: "oauth" },
								{ id: "home", kind: "api_key" },
							],
						},
					},
				},
			],
			[
				"unknown slot kind",
				{ ...valid, pools: { anthropic: { strategy: "quota-first", slots: [{ id: "home", kind: "magic" }] } } },
			],
			[
				"non-string label",
				{
					...valid,
					pools: { anthropic: { strategy: "quota-first", slots: [{ id: "home", kind: "oauth", label: 7 }] } },
				},
			],
			[
				"invalid acceptance stamp",
				{
					...valid,
					pools: {
						anthropic: {
							strategy: "quota-first",
							slots: [{ id: "home", kind: "oauth", warningAcceptedAt: "yesterday" }],
						},
					},
				},
			],
		];

		for (const [label, document] of broken) {
			await writeFile(subject.store.accountsPath, JSON.stringify(document));
			await assert.rejects(new AccountsStore(subject.directory).read(), Error, label);
		}

		await writeFile(subject.store.accountsPath, JSON.stringify(valid));
		assert.equal((await new AccountsStore(subject.directory).read()).pools.anthropic?.slots.length, 1);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a malformed official credential is skipped without a partial import", async () => {
	const subject = await harness();
	try {
		await writeFile(
			subject.store.authPath,
			JSON.stringify({
				anthropic: { type: "oauth" },
				xai: { type: "api_key", key: "" },
				cursor: { type: "future-scheme", token: "x" },
				"openai-codex": { type: "api_key", key: "usable-codex-key" },
			}),
		);

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		const document = await new AccountsStore(subject.directory).read();
		assert.deepEqual(Object.keys(document.pools), ["openai-codex"], "only the routable credential became a slot");
		assert.equal(document.pools["openai-codex"]?.slots[0]?.official, true);
		assert.deepEqual(Object.keys(await subject.store.readSecrets()), [], "an official slot keeps no secret copy");
		assert.equal(
			await subject.route("openai-codex", { authorization: "Bearer usable-codex-key" }),
			"Bearer usable-codex-key",
			"the runtime's own header is the official slot's grant",
		);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

/** A refresh failure exactly as packages/ai/src/auth/oauth/anthropic.ts throws it, stack frames included. */
function refreshFailure(status: number, body: string): Error {
	return new Error(
		`Anthropic token refresh request failed. url=https://console.anthropic.com/v1/oauth/token; details=Error: HTTP request failed. status=${status}; url=https://console.anthropic.com/v1/oauth/token; body=${body}; stack=Error: HTTP request failed\n    at postJson (file:///opt/k-pi/dist/bundle/cli.js:10:20)\n    at refreshAnthropicToken (file:///opt/k-pi/dist/bundle/cli.js:11:5)`,
	);
}

const INVALID_GRANT_BODY = '{"error":"invalid_grant","error_description":"refresh token has been revoked"}';

function officialGrant(access: string, refresh: string, expires: number): Credential {
	return { type: "oauth", access, refresh, expires };
}

test("the official slot is served from auth.json and never refreshed by K-π", async () => {
	const subject = await harness();
	try {
		await writeFile(
			subject.store.authPath,
			JSON.stringify({ anthropic: officialGrant("official-access-token", "official-refresh", 0) }),
		);
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		// The runtime rotated the grant since: a copy would now hold a dead refresh token.
		await writeFile(
			subject.store.authPath,
			JSON.stringify({
				anthropic: officialGrant("rotated-access", "rotated-refresh", FIXED_TIME.getTime() + 7_200_000),
			}),
		);
		const refreshCalls: string[] = [];
		const context = subject.refreshContext(async (credential) => {
			refreshCalls.push(credential.type);
			throw new Error("the official slot must never be refreshed by K-π");
		});
		await subject.hooks.get("session_start")!({ type: "session_start" }, context);

		assert.deepEqual(refreshCalls, [], "no refresh call for the official slot");
		const document = await new AccountsStore(subject.directory).read();
		assert.equal(document.pools.anthropic?.slots.length, 1);
		assert.equal(document.pools.anthropic?.slots[0]?.official, true);
		assert.equal((await subject.store.readSecrets())["anthropic/default"], undefined, "no anthropic/default copy");
		assert.equal(
			await subject.route("anthropic", { authorization: "Bearer runtime" }),
			"Bearer runtime",
			"the runtime's header is this slot's grant and is left in place",
		);
		for (const message of [...subject.notes, ...subject.warnings, ...subject.errors]) {
			assert.doesNotMatch(message, /stack=|could not refresh/iu, message);
		}
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an expired legacy default copy binds to the auth.json grant it duplicated", async () => {
	const subject = await harness();
	try {
		// The harness credential expires at 0: the legacy copy is dead.
		await subject.accounts("login anthropic default", subject.context);
		await writeFile(subject.store.authPath, JSON.stringify({ anthropic: officialGrant("official", "r", 0) }));

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		const document = await new AccountsStore(subject.directory).read();
		assert.deepEqual(
			document.pools.anthropic?.slots.map((slot) => slot.id),
			["default"],
			"the expired copy is bound, not duplicated",
		);
		assert.equal(document.pools.anthropic?.slots[0]?.official, true);
		assert.equal((await subject.store.readSecrets())["anthropic/default"], undefined);
		assert.ok(
			subject.notes.some(
				(note) => note === "K-π accounts: anthropic/default now reads its credential from auth.json",
			),
			subject.notes.join("\n"),
		);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a pooled login the runtime persisted becomes the official slot and the previous official slot keeps its grant", async () => {
	const before = officialGrant("official-access-token", "official-refresh", FIXED_TIME.getTime() + 3_600_000);
	const work = officialGrant("access-work", "refresh-work", FIXED_TIME.getTime() + 3_600_000);
	let authPath: string | undefined;
	const subject = await harness(true, async (providerId) => {
		// The runtime's login persists the new grant into auth.json before it returns.
		await writeFile(authPath as string, JSON.stringify({ [providerId]: work }));
		return work;
	});
	authPath = subject.store.authPath;
	try {
		await writeFile(subject.store.authPath, JSON.stringify({ anthropic: before }));
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		await subject.accounts("login anthropic work", subject.context);

		const document = await new AccountsStore(subject.directory).read();
		const slots = document.pools.anthropic?.slots ?? [];
		assert.equal(slots.find((slot) => slot.id === "work")?.official, true, "the new login is the official slot");
		assert.equal(slots.find((slot) => slot.id === "default")?.official, undefined, "the old one is demoted");
		const secrets = await subject.store.readSecrets();
		assert.equal(secrets["anthropic/work"], undefined, "the official slot keeps no copy");
		assert.deepEqual(secrets["anthropic/default"], before, "the demoted slot keeps the grant auth.json held");
		assert.ok(
			subject.notes.some((note) => note.endsWith("(anthropic/default keeps its previous grant)")),
			subject.notes.join("\n"),
		);
		assert.deepEqual(subject.errors, []);

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		assert.equal((await new AccountsStore(subject.directory).read()).pools.anthropic?.slots.length, 2);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an api-key login that leaves auth.json alone stays a secret-backed slot", async () => {
	const subject = await harness(true, async () => ({ type: "api_key", key: "xai-secret-key" }));
	try {
		await subject.accounts("login xai work", subject.context);

		const slot = await subject.store.getSlot("xai", "work");
		assert.equal(slot?.kind, "api_key");
		assert.equal(slot?.official, undefined);
		const secret = (await subject.store.readSecrets())["xai/work"];
		assert.equal(secret?.type === "api_key" && secret.key, "xai-secret-key");
		assert.deepEqual(subject.errors, []);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an invalid_grant refresh marks the slot as needing login, once, without a stack trace", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic work", subject.context);
		const refreshCalls: string[] = [];
		const context = subject.refreshContext(async (credential) => {
			refreshCalls.push(credential.type === "oauth" ? credential.refresh : credential.type);
			throw refreshFailure(400, INVALID_GRANT_BODY);
		});

		await subject.hooks.get("turn_start")!({ type: "turn_start" }, context);

		assert.deepEqual(refreshCalls, ["refresh-work"]);
		assert.deepEqual(subject.errors, [
			"K-π accounts: anthropic/work needs a new login: Anthropic rejected its refresh token (invalid_grant). Run /accounts login anthropic work",
		]);
		for (const message of [...subject.notes, ...subject.warnings, ...subject.errors]) {
			assert.doesNotMatch(message, /stack=|\n\s+at /u, message);
		}
		const marked = await subject.store.getSlot("anthropic", "work");
		assert.equal(typeof marked?.needsLogin, "string");
		assert.match(renderAccountsWidget(await subject.store.read()), /work \?% needs login/u);

		await subject.hooks.get("turn_start")!({ type: "turn_start" }, context);
		assert.deepEqual(refreshCalls, ["refresh-work"], "a slot needing a login is not refreshed again");
		assert.equal(subject.errors.length, 1, "said once");
		assert.equal(await subject.route(), "", "a slot needing a login is never selected");

		await subject.accounts("login anthropic work", subject.context);
		assert.equal((await subject.store.getSlot("anthropic", "work"))?.needsLogin, undefined, "a login heals it");
		assert.equal(await subject.route(), "Bearer access-work");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a transient refresh failure cools the slot with a plain reason and no login demand", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic work", subject.context);
		const context = subject.refreshContext(async () => {
			throw refreshFailure(503, '{"error":"overloaded"}');
		});

		await subject.hooks.get("turn_start")!({ type: "turn_start" }, context);

		assert.equal((await subject.store.getSlot("anthropic", "work"))?.needsLogin, undefined);
		assert.equal(subject.warnings.length, 1, subject.warnings.join("\n"));
		assert.match(subject.warnings[0], /^K-π accounts: could not refresh anthropic\/work: .+; cooling 300m$/u);
		assert.doesNotMatch(subject.warnings[0], /stack=|\n\s+at /u);
		assert.deepEqual(subject.errors, []);
		assert.equal(await subject.route(), "", "the slot is cooling");
		assert.match(subject.status.at(-1) ?? "", /work \?% cd 300m/u);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("a dead auth.json grant marks the official slot as needing login without touching auth.json", async () => {
	const subject = await harness();
	try {
		await writeFile(
			subject.store.authPath,
			JSON.stringify({ anthropic: officialGrant("official-access-token", "official-refresh", 0) }),
		);
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		const authBefore = await readFile(subject.store.authPath, "utf8");
		const context = {
			...subject.refreshContext(async () => {
				throw new Error("not called");
			}),
			model: { provider: "anthropic", id: "anthropic-model" },
		};
		const runtimeFailure = (status: number, body: string) => ({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: `OAuth refresh failed for anthropic: ${refreshFailure(status, body).message}`,
			},
		});

		// A transient runtime failure is not a dead grant: nothing is marked.
		await subject.hooks.get("message_end")!(runtimeFailure(503, '{"error":"overloaded"}'), context);
		assert.equal((await subject.store.getSlot("anthropic", "default"))?.needsLogin, undefined);
		assert.deepEqual(subject.errors, []);

		await subject.hooks.get("message_end")!(runtimeFailure(400, INVALID_GRANT_BODY), context);

		assert.equal(typeof (await subject.store.getSlot("anthropic", "default"))?.needsLogin, "string");
		assert.equal(await readFile(subject.store.authPath, "utf8"), authBefore, "auth.json is never written by K-π");
		assert.equal(subject.errors.length, 1, subject.errors.join("\n"));
		assert.match(subject.errors[0], /anthropic\/default needs a new login/u);
		assert.match(subject.errors[0], /Run \/accounts login anthropic default$/u);
		assert.doesNotMatch(subject.errors[0], /stack=|\n\s+at /u);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an official slot whose auth.json entry vanished is reported once at session start", async () => {
	const subject = await harness();
	try {
		await writeFile(
			subject.store.authPath,
			JSON.stringify({ anthropic: officialGrant("official-access-token", "official-refresh", 0) }),
		);
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		await rm(subject.store.authPath);

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		assert.equal(
			(await subject.store.getSlot("anthropic", "default"))?.needsLogin,
			"auth.json no longer holds a anthropic credential",
		);
		assert.equal(subject.errors.length, 1, subject.errors.join("\n"));
		assert.match(subject.errors[0], /Run \/accounts login anthropic default$/u);

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		assert.equal(subject.errors.length, 1, "the same slot is not reported twice in one session");

		// A new session says it once again.
		const next = await harness(true, undefined, subject.directory);
		await next.hooks.get("session_start")!({ type: "session_start" }, next.context as never);
		assert.equal(next.errors.length, 1, next.errors.join("\n"));
		assert.match(next.errors[0], /Run \/accounts login anthropic default$/u);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});
