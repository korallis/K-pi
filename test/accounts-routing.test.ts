import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import {
	AccountBalancer,
	DEFAULT_FALLBACK_CHAIN,
} from "../packages/coding-agent/src/kpi/extensions/accounts/balancer.ts";
import type { AccountsDocument, PoolId } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { UsageCache } from "../packages/coding-agent/src/kpi/extensions/accounts/usage/cache.ts";
import { readUsageHeaders } from "../packages/coding-agent/src/kpi/extensions/accounts/usage/headers.ts";
import { renderAccountsWidget } from "../packages/coding-agent/src/kpi/extensions/accounts/widget.ts";

const NOW = 1_000_000;

function model(provider: PoolId, id: string): Model<any> {
	return { provider, id, name: id } as unknown as Model<any>;
}

function pool(strategy: AccountsDocument["pools"][PoolId] extends undefined ? never : "quota-first" | "round-robin" | "sticky", ...slotIds: string[]) {
	return {
		strategy,
		slots: slotIds.map((id) => ({ id, kind: "oauth" as const, label: id })),
	};
}

function accounts(pools: AccountsDocument["pools"]): AccountsDocument {
	return {
		version: 1,
		pools,
		fallback: [...DEFAULT_FALLBACK_CHAIN],
		stickiness: "session-until-exhausted",
	};
}

async function normativeFixture(): Promise<AccountsDocument> {
	return JSON.parse(
		await readFile(new URL("../fixtures/accounts-failover/accounts.json", import.meta.url), "utf8"),
	) as AccountsDocument;
}

test("quota-first selects the highest healthy cached percentage", () => {
	const document = accounts({ anthropic: pool("quota-first", "A", "B", "C") });
	const usage = new UsageCache({ now: () => NOW });
	usage.recordHeaders("anthropic", "A", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "20" });
	usage.recordHeaders("anthropic", "B", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "85" });
	usage.recordHeaders("anthropic", "C", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "50" });

	const balancer = new AccountBalancer(() => NOW);
	const selection = balancer.select("anthropic", document, usage);

	assert.equal(selection?.slot.id, "B");
	assert.equal(selection?.reason, "quota-first");
	assert.equal(selection?.remainingPercent, 85);
});

test("quota-first skips a cooling slot even when it holds the highest percentage", () => {
	const document = accounts({ anthropic: pool("quota-first", "A", "B") });
	const usage = new UsageCache({ now: () => NOW });
	usage.recordHeaders("anthropic", "A", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "99" });
	usage.recordHeaders("anthropic", "B", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "10" });

	const balancer = new AccountBalancer(() => NOW);
	balancer.markCooling("anthropic", "A", NOW + 60_000);

	const selection = balancer.select("anthropic", document, usage);
	assert.equal(selection?.slot.id, "B");
	assert.equal(selection?.remainingPercent, 10);
});

test("unknown usage fails open to round-robin without blocking the request", () => {
	const document = accounts({ anthropic: pool("quota-first", "A", "B") });
	const usage = new UsageCache({ now: () => NOW });
	const balancer = new AccountBalancer(() => NOW);

	const first = balancer.select("anthropic", document, usage);
	assert.equal(first?.reason, "round-robin", "no cached percentage must not become a quota decision");
	assert.equal(first?.remainingPercent, undefined);
	assert.equal(first?.slot.id, "A");

	// The pin holds the same slot until a named transition releases it.
	assert.equal(balancer.select("anthropic", document, usage)?.slot.id, "A");
	balancer.advance("anthropic");
	assert.equal(balancer.select("anthropic", document, usage)?.slot.id, "B");
});

test("a known percentage outranks an unknown sibling", () => {
	const document = accounts({ anthropic: pool("quota-first", "A", "B") });
	const usage = new UsageCache({ now: () => NOW });
	usage.recordHeaders("anthropic", "B", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "5" });

	const balancer = new AccountBalancer(() => NOW);
	const selection = balancer.select("anthropic", document, usage);

	assert.equal(selection?.slot.id, "B");
	assert.equal(selection?.reason, "quota-first");
});

test("the normative accounts-failover fixture never selects the cooling sibling in 100 attempts", async () => {
	const document = await normativeFixture();
	assert.deepEqual(
		document.pools.anthropic?.slots.map((slot) => slot.id),
		["A", "B"],
		"the fixture must still describe the two-slot Anthropic pool",
	);

	const usage = new UsageCache({ now: () => NOW });
	// A holds far more quota than B, so only health may keep it out.
	usage.recordHeaders("anthropic", "A", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "100" });
	usage.recordHeaders("anthropic", "B", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "1" });

	for (const strategy of ["round-robin", "quota-first", "sticky"] as const) {
		const scenario: AccountsDocument = {
			...document,
			pools: { ...document.pools, anthropic: { ...document.pools.anthropic!, strategy } },
		};
		const balancer = new AccountBalancer(() => NOW);
		balancer.markCooling("anthropic", "A", NOW + 5 * 60 * 60 * 1000);

		const chosen: string[] = [];
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const selection = balancer.select("anthropic", scenario, usage);
			assert.ok(selection, `${strategy}: attempt ${attempt} selected nothing`);
			chosen.push(selection.slot.id);
		}

		assert.equal(chosen.length, 100);
		assert.equal(
			chosen.filter((slotId) => slotId === "A").length,
			0,
			`${strategy}: the cooling sibling was selected`,
		);
		assert.deepEqual([...new Set(chosen)], ["B"]);
	}
});

test("same-family failover preserves the exact model and proposes no model change", () => {
	const document = accounts({ anthropic: pool("round-robin", "A", "B") });
	const balancer = new AccountBalancer(() => NOW);
	const source = model("anthropic", "claude-opus-4-6");
	const available = [source, model("anthropic", "claude-sonnet-4-6"), model("xai", "grok-5")];

	const from = balancer.select("anthropic", document)!;
	assert.equal(from.slot.id, "A");
	balancer.markCooling("anthropic", "A", NOW + 60_000);

	const plan = balancer.planFailover(from, document, available, source);

	assert.equal(plan?.sameFamily, true);
	assert.equal(plan?.to.poolId, "anthropic");
	assert.equal(plan?.to.slot.id, "B");
	assert.equal(plan?.model, undefined, "a sibling must not carry a model change");
});

test("cross-family fallback begins only after the whole family cools and follows the chain", () => {
	const document = accounts({
		anthropic: pool("round-robin", "A", "B", "C"),
		"openai-codex": pool("round-robin", "codex"),
		xai: pool("round-robin", "grok"),
	});
	const balancer = new AccountBalancer(() => NOW);
	const source = model("anthropic", "claude-opus-4-6");
	const available = [source, model("openai-codex", "gpt-5-codex"), model("xai", "grok-5")];

	balancer.markCooling("anthropic", "A", NOW + 60_000);
	assert.equal(balancer.select("anthropic", document)?.poolId, "anthropic", "two siblings remain healthy");
	balancer.markCooling("anthropic", "B", NOW + 60_000);
	const lastSibling = balancer.select("anthropic", document);
	assert.equal(lastSibling?.poolId, "anthropic", "one sibling remains healthy");
	assert.equal(lastSibling?.slot.id, "C");

	balancer.markCooling("anthropic", "C", NOW + 60_000);
	const plan = balancer.planFailover({ poolId: "anthropic", slot: { id: "C", kind: "oauth" } }, document, available, source);

	assert.equal(plan?.sameFamily, false);
	assert.equal(plan?.to.poolId, "openai-codex", "the next configured pool in the default chain");
	assert.equal(plan?.model?.provider, "openai-codex");
	assert.equal(
		DEFAULT_FALLBACK_CHAIN.indexOf("openai-codex") < DEFAULT_FALLBACK_CHAIN.indexOf("xai"),
		true,
		"codex precedes xai in the default chain",
	);
});

test("cross-family fallback skips a family whose every slot is cooling", () => {
	const document = accounts({
		anthropic: pool("round-robin", "A"),
		"openai-codex": pool("round-robin", "codex"),
		xai: pool("round-robin", "grok"),
	});
	const balancer = new AccountBalancer(() => NOW);
	balancer.markCooling("anthropic", "A", NOW + 60_000);
	balancer.markCooling("openai-codex", "codex", NOW + 60_000);

	assert.equal(balancer.select("anthropic", document)?.poolId, "xai");
});

test("a session pin holds until cooldown, logout, or an operator advance", () => {
	const document = accounts({ anthropic: pool("round-robin", "A", "B") });
	const balancer = new AccountBalancer(() => NOW);

	assert.equal(balancer.select("anthropic", document)?.slot.id, "A");
	assert.equal(balancer.pinned("anthropic"), "A");
	for (let attempt = 0; attempt < 5; attempt += 1) {
		assert.equal(balancer.select("anthropic", document)?.reason, "sticky");
	}

	// Cooldown releases it.
	balancer.markCooling("anthropic", "A", NOW + 60_000);
	assert.equal(balancer.pinned("anthropic"), undefined);
	assert.equal(balancer.select("anthropic", document)?.slot.id, "B");

	// Logout releases it.
	balancer.releaseSlot("anthropic", "B");
	assert.equal(balancer.pinned("anthropic"), undefined);

	// An operator advance releases it and moves the rotation on.
	const fresh = new AccountBalancer(() => NOW);
	assert.equal(fresh.select("anthropic", document)?.slot.id, "A");
	fresh.advance("anthropic");
	assert.equal(fresh.pinned("anthropic"), undefined);
	assert.equal(fresh.select("anthropic", document)?.slot.id, "B");
});

test("cooldown expiry restores a slot to the healthy set", () => {
	const document = accounts({ anthropic: pool("round-robin", "A", "B") });
	let clock = NOW;
	const balancer = new AccountBalancer(() => clock);
	balancer.markCooling("anthropic", "A", NOW + 60_000);
	assert.equal(balancer.isHealthy("anthropic", "A"), false);
	assert.equal(balancer.cooldownUntil("anthropic", "A"), NOW + 60_000);

	clock = NOW + 60_001;
	assert.equal(balancer.isHealthy("anthropic", "A"), true);
	assert.equal(balancer.cooldownUntil("anthropic", "A"), undefined);
	assert.ok(balancer.select("anthropic", document));
});

test("documented rate-limit headers populate the cache and the binding limit wins", () => {
	const usage = new UsageCache({ now: () => NOW });

	const anthropic = usage.recordHeaders("anthropic", "A", {
		"anthropic-ratelimit-requests-limit": "1000",
		"anthropic-ratelimit-requests-remaining": "900",
		"anthropic-ratelimit-tokens-limit": "2000",
		"anthropic-ratelimit-tokens-remaining": "100",
		"anthropic-ratelimit-tokens-reset": "2026-09-01T13:00:00Z",
	});
	assert.equal(anthropic?.remainingPercent, 5, "the tokens family binds at 5%");
	assert.equal(anthropic?.resetAt, Date.parse("2026-09-01T13:00:00Z"));
	assert.equal(anthropic?.source, "headers");
	assert.equal(anthropic?.observedAtMs, NOW);

	const codex = usage.recordHeaders("openai-codex", "default", {
		"x-ratelimit-limit-requests": "500",
		"x-ratelimit-remaining-requests": "250",
		"x-ratelimit-reset-requests": "60s",
	});
	assert.equal(codex?.remainingPercent, 50);
	assert.equal(codex?.resetAt, NOW + 60_000);

	assert.equal(usage.remainingPercent("anthropic", "A"), 5);
	assert.equal(usage.remainingPercent("openai-codex", "default"), 50);
	assert.equal(usage.remainingPercent("xai", "unseen"), undefined, "an unseen slot stays unknown");
});

test("headers without a documented limit family leave a slot unknown", () => {
	const usage = new UsageCache({ now: () => NOW });
	assert.equal(readUsageHeaders({ "content-type": "application/json" }, NOW), undefined);
	assert.equal(usage.recordHeaders("zai", "default", { "content-type": "application/json" }), undefined);
	assert.equal(usage.remainingPercent("zai", "default"), undefined);

	// A limit with no remaining, or a zero limit, is ignored rather than guessed.
	assert.equal(usage.recordHeaders("zai", "default", { "x-ratelimit-limit": "100" }), undefined);
	assert.equal(usage.recordHeaders("zai", "default", { "x-ratelimit-limit": "0", "x-ratelimit-remaining": "0" }), undefined);
	assert.equal(usage.remainingPercent("zai", "default"), undefined);
});

test("an injected reader is the only other cache source and never blocks on failure", async () => {
	const calls: string[] = [];
	const usage = new UsageCache({
		now: () => NOW,
		readers: {
			cursor: ({ poolId, slotId }) => {
				calls.push(`${poolId}/${slotId}`);
				return { remainingPercent: 33, window: "5h" };
			},
			xai: () => {
				throw new Error("reader exploded");
			},
		},
	});

	assert.equal(usage.hasReader("cursor"), true);
	assert.equal(usage.hasReader("anthropic"), false, "no reader ships for an undocumented endpoint");

	const refreshed = await usage.refreshAll([
		{ poolId: "cursor", slotId: "default" },
		{ poolId: "xai", slotId: "default" },
		{ poolId: "anthropic", slotId: "home" },
	]);

	assert.deepEqual(calls, ["cursor/default"]);
	assert.deepEqual(
		refreshed.map((snapshot) => `${snapshot.poolId}/${snapshot.slotId}=${snapshot.remainingPercent}`),
		["cursor/default=33"],
	);
	assert.equal(usage.get("cursor", "default")?.source, "reader");
	assert.equal(usage.get("cursor", "default")?.window, "5h");
	assert.equal(usage.remainingPercent("xai", "default"), undefined, "a failing reader leaves the slot unknown");
	assert.equal(usage.remainingPercent("anthropic", "home"), undefined, "a pool without a reader is never polled");
});

test("the widget shows real cached percentages, cooldown, and the active route", () => {
	const document = accounts({ anthropic: pool("quota-first", "A", "B") });
	const usage = new UsageCache({ now: () => NOW });
	usage.recordHeaders("anthropic", "A", {
		"x-ratelimit-limit": "100",
		"x-ratelimit-remaining": "12",
		"x-ratelimit-window": "5h",
	});
	const balancer = new AccountBalancer(() => NOW);
	balancer.markCooling("anthropic", "A", NOW + 10 * 60_000);

	const widget = renderAccountsWidget(document, {
		usage,
		health: balancer,
		route: { provider: "anthropic", model: "claude-opus-4-6", slot: "B" },
		now: NOW,
	});

	assert.match(widget, /A 12% 5h cd 10m/u);
	assert.match(widget, /B \?%/u, "an unknown slot renders as unknown, never as zero");
	assert.match(widget, /ROUTE {3}anthropic\/claude-opus-4-6 {2}via B/u);
});

test("logout forgets a slot's cached usage", () => {
	const usage = new UsageCache({ now: () => NOW });
	usage.recordHeaders("anthropic", "A", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "40" });
	assert.equal(usage.remainingPercent("anthropic", "A"), 40);

	usage.forget("anthropic", "A");
	assert.equal(usage.remainingPercent("anthropic", "A"), undefined);
	assert.deepEqual(usage.entries(), []);
});
