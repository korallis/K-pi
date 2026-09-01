import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Credential } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import {
	CODEX_BILLING_CONFIRM,
	CURSOR_BILLING_CONFIRM,
	registerAccounts,
	ZAI_PERSONAL_USE_NOTE,
} from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";

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
	route: (provider?: string) => Promise<string>;
}

async function harness(confirm = true): Promise<Harness> {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-commands-"));
	const store = new AccountsStore(directory);
	const commands = new Map<string, CommandHandler>();
	const hooks = new Map<string, ProviderHook>();
	const notes: string[] = [];
	const errors: string[] = [];
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
		async login(_providerId, slotId): Promise<Credential> {
			return { type: "oauth", access: `access-${slotId}`, refresh: `refresh-${slotId}`, expires: 0 };
		},
	});
	const ui = {
		async confirm(_title: string, message: string) {
			prompts.push(message);
			return confirm;
		},
		notify(message: string, level?: string) {
			(level === "error" ? errors : notes).push(message);
		},
		setStatus(_key: string, value?: string) {
			status.push(value);
		},
	};
	const context = { cwd: directory, hasUI: true, mode: "tui", ui } as unknown as ExtensionCommandContext;
	const route = async (provider = "anthropic"): Promise<string> => {
		const headers: Record<string, string> = {};
		await hooks.get("before_provider_headers")!(
			{ type: "before_provider_headers", headers, requestId: "request-1" },
			{ cwd: directory, model: { provider, id: `${provider}-model` }, ui, modelRegistry: { getAvailable: () => [] } },
		);
		return headers.authorization ?? "";
	};
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
		assert.equal(await subject.route("anthropic"), "Bearer official-access-token");

		// Re-importing is idempotent: the default slot is not duplicated.
		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);
		assert.equal((await new AccountsStore(subject.directory).read()).pools.anthropic?.slots.length, 1);
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});

test("an existing default slot is never overwritten by the official import", async () => {
	const subject = await harness();
	try {
		await subject.accounts("login anthropic default", subject.context);
		await writeFile(
			subject.store.authPath,
			JSON.stringify({ anthropic: { type: "oauth", access: "official", refresh: "r", expires: 0 } }),
		);

		await subject.hooks.get("session_start")!({ type: "session_start" }, subject.context as never);

		assert.equal(await subject.route(), "Bearer access-default", "the operator's own slot wins");
		assert.equal((await new AccountsStore(subject.directory).read()).pools.anthropic?.slots.length, 1);
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
		assert.deepEqual(
			Object.keys(document.pools),
			["openai-codex"],
			"only the routable credential became a slot",
		);
		assert.deepEqual(Object.keys(await subject.store.readSecrets()), ["openai-codex/default"]);
		assert.equal(await subject.route("openai-codex"), "Bearer usable-codex-key");
	} finally {
		await rm(subject.directory, { recursive: true, force: true });
	}
});
