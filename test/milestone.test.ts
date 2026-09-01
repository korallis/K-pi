import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";

import {
	AccountBalancer,
	DEFAULT_FALLBACK_CHAIN,
} from "../packages/coding-agent/src/kpi/extensions/accounts/balancer.ts";
import {
	classifyProviderFailure,
	DEFAULT_COOLDOWN_MS,
} from "../packages/coding-agent/src/kpi/extensions/accounts/errors.ts";
import type { AccountsDocument } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { renderAccountsWidget } from "../packages/coding-agent/src/kpi/extensions/accounts/widget.ts";
import { appendEvent } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { BackgroundBus, type WorkerLauncher } from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import {
	refreshCursorModels,
	registerCursorProvider,
} from "../packages/coding-agent/src/kpi/extensions/cursor/provider.ts";
import { assertMinimalistBounds } from "../packages/coding-agent/src/kpi/extensions/minimalist.ts";
import { registerPrintProfile } from "../packages/coding-agent/src/kpi/extensions/print-profile.ts";
import { formatEventEntry } from "../packages/coding-agent/src/kpi/extensions/renderers.ts";
import { exaSearch } from "../packages/coding-agent/src/kpi/extensions/research/exa.ts";
import { conductResearch } from "../packages/coding-agent/src/kpi/extensions/research/gate.ts";
import type { Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import {
	assertClaimInModule,
	assertDuneStack,
	type DuneStack,
	scaffoldModule,
} from "../packages/coding-agent/src/kpi/extensions/stack.ts";
import { assertShipApproved, createKModePlan } from "../packages/coding-agent/src/kpi/kstack/mode.ts";
import { assertKnownModels, createSuggestedModels } from "../packages/coding-agent/src/kpi/kstack/models.ts";

const accounts: AccountsDocument = {
	version: 1,
	pools: {
		anthropic: {
			strategy: "round-robin",
			slots: [
				{ id: "A", label: "personal", kind: "oauth" },
				{ id: "B", label: "work", kind: "oauth" },
			],
		},
	},
	fallback: [...DEFAULT_FALLBACK_CHAIN],
	stickiness: "session-until-exhausted",
};

test("429 usage limit classifies to the default cooldown", () => {
	const now = 1_000;
	assert.deepEqual(classifyProviderFailure({ status: 429, body: "usage limit" }, now), {
		kind: "cooldown",
		until: now + DEFAULT_COOLDOWN_MS,
		reason: "provider response 429",
	});
	assert.equal(classifyProviderFailure({ status: 403, body: "permission denied" }, now), undefined);
	assert.equal(classifyProviderFailure({ status: 403, body: "quota exhausted" }, now)?.kind, "cooldown");
	assert.equal(
		classifyProviderFailure({ status: 403, headers: { "x-error": "quota exhausted" } }, now)?.kind,
		"cooldown",
	);
});

test("a cooling sibling is never selected while B is healthy", () => {
	const balancer = new AccountBalancer(() => 10);
	balancer.markCooling("anthropic", "A", 100);
	for (let index = 0; index < 100; index += 1) {
		assert.equal(balancer.select("anthropic", accounts)?.slot.id, "B");
	}
	assert.deepEqual(DEFAULT_FALLBACK_CHAIN, ["anthropic", "openai-codex", "xai", "zai", "kimi-coding", "cursor"]);
});

test("failover appends the accounts.failover event type", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-failover-event-"));
	const path = join(directory, "events.jsonl");
	try {
		await appendEvent(path, {
			ts: new Date(0).toISOString(),
			type: "accounts.failover",
			job_id: "job",
			round: 1,
			node: "accounts",
			from: "anthropic/A",
			to: "anthropic/B",
		});
		const event = JSON.parse(await readFile(path, "utf8")) as { type: string };
		assert.equal(event.type, "accounts.failover");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("event verdict rendering remains concise", () => {
	const rendered = formatEventEntry("loop.terminal", {
		ts: new Date(0).toISOString(),
		type: "loop.terminal",
		job_id: "job",
		round: 1,
		node: "review",
		status: "BLOCKED",
		prev_hash: "0".repeat(64),
		record_hash: "1".repeat(64),
	});
	assert.ok(rendered.length < 800);
});

test("accounts widget labels each slot percentage", () => {
	const widget = renderAccountsWidget(accounts, {
		"anthropic/A": { remainingPercent: 40 },
		"anthropic/B": { remainingPercent: 80 },
	});
	assert.match(widget, /personal 40%/u);
	assert.match(widget, /work 80%/u);
	assert.doesNotMatch(widget, /^\s*\d+%\s*$/mu);
});

test("Cursor registers its id and refreshes a mocked live array", async () => {
	let id = "";
	let config: { refreshModels?: (context: RefreshModelsContext) => Promise<unknown[]> } | undefined;
	registerCursorProvider({
		registerProvider(providerId: string, providerConfig: typeof config) {
			id = providerId;
			config = providerConfig;
		},
	} as unknown as ExtensionAPI);
	assert.equal(id, "cursor");
	const response = new Response(JSON.stringify({ data: [{ id: "live", name: "Live" }] }), { status: 200 });
	const context = { allowNetwork: true, signal: new AbortController().signal } as RefreshModelsContext;
	const models = await refreshCursorModels(context, async () => response);
	assert.equal(models[0]?.id, "live");
	assert.equal(Array.isArray(await config?.refreshModels?.(context).catch(() => [])), true);
});

test("K-mode feature starts with principles and ship needs approval", async () => {
	const plan = createKModePlan("add a healthcheck");
	assert.equal(plan.playbook, "feature");
	assert.equal(plan.todos[0], "read Principles");
	const directory = await mkdtemp(join(tmpdir(), "kpi-verdict-"));
	try {
		await writeFile(join(directory, "verdict.json"), JSON.stringify({ approved: false }));
		await assert.rejects(assertShipApproved(directory), /blocked/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("K-stack setup never writes a slug outside the live registry", () => {
	const document = createSuggestedModels(["anthropic/a", "xai/b"]);
	assert.doesNotThrow(() => assertKnownModels(document, ["anthropic/a", "xai/b"]));
	document.roles.fast = "unknown/model";
	assert.throws(() => assertKnownModels(document, ["anthropic/a", "xai/b"]), /Unknown model slug/u);
});

test("background bus caps workers, writers, messages, and leases", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-bus-"));
	const messages: string[] = [];
	let pid = 1;
	const launcher: WorkerLauncher = async () => ({
		pid: pid++,
		send: async (message) => {
			messages.push(message);
		},
		stop: async () => undefined,
	});
	try {
		const bus = new BackgroundBus(directory, join(directory, ".kpi", "runs", "job"), launcher);
		const writer = await bus.spawn({ role: "implementer", prompt: "one", tools: ["read", "write"] });
		await assert.rejects(bus.spawn({ role: "implementer", prompt: "two", tools: ["edit"] }), /writer/u);
		const reviewer = await bus.spawn({ role: "reviewer", prompt: "review" });
		await assert.rejects(bus.spawn({ role: "tester", prompt: "third" }), /limit/u);
		await bus.communicate(reviewer.agentId, "follow", "followUp");
		assert.deepEqual(messages, ["follow"]);
		await bus.claim(writer.agentId, "src/a.ts");
		await assert.rejects(bus.claim(reviewer.agentId, "src/a.ts"), /claimed/u);
		await bus.stop(writer.agentId);
		await bus.claim(reviewer.agentId, "src/a.ts");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("minimalist bounds rejects a missing ladder and undeclared dependency", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-min-"));
	const run = join(directory, "run");
	try {
		await mkdir(run, { recursive: true });
		await writeFile(join(run, "candidate.json"), JSON.stringify({ summary: "x" }));
		await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { surprise: "1" } }));
		const task = { dependency_baseline: [], runtime_dependencies: [], acceptance: [] } as unknown as Task;
		await assert.rejects(assertMinimalistBounds(directory, run, task), /ladder/u);
		await writeFile(join(run, "candidate.json"), JSON.stringify({ ladder: "one-liner" }));
		await assert.rejects(assertMinimalistBounds(directory, run, task), /surprise/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("research caps results and falls back after a preferred 429", async () => {
	let calls = 0;
	const fetchMock: typeof fetch = async (input) => {
		calls += 1;
		if (String(input).includes("exa.ai")) return new Response("{}", { status: 429 });
		return new Response(
			JSON.stringify({
				results: [
					{ title: "A", url: "https://a", snippet: "one" },
					{ title: "B", url: "https://b", snippet: "two" },
				],
			}),
			{ status: 200 },
		);
	};
	const capped = await exaSearch("q", "key", {
		numResults: 99,
		fetch: async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { numResults: number };
			assert.equal(body.numResults, 10);
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		},
	});
	assert.deepEqual(capped, []);
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-"));
	try {
		const task = { goal: "current docs" } as Task;
		const document = await conductResearch(directory, directory, task, {
			exaKey: "x",
			perplexityKey: "p",
			fetch: fetchMock,
		});
		assert.equal(document.mode, "perplexity");
		assert.equal(document.sources.length, 2);
		assert.equal(calls, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Dune stack rejects generic maps and outside-module claims", () => {
	const stack: DuneStack = {
		version: 1,
		shape: "dune",
		delivery: "vertical",
		root: "src",
		scaffold_first: true,
		modules: [
			{
				id: "auth",
				purpose: "login and sessions",
				folder: "src/auth",
				interface: "src/auth/api.ts",
				allowed_paths: ["src/auth/**", "test/auth/**"],
				depends_on: [],
			},
		],
	};
	assert.doesNotThrow(() => assertDuneStack(stack));
	assert.throws(() => assertClaimInModule("/repo", "src/billing/a.ts", stack.modules[0]), /UNSAFE/u);
	stack.modules[0] = {
		...stack.modules[0],
		id: "helpers",
		folder: "src/helpers",
		interface: "src/helpers/index.ts",
		allowed_paths: ["src/helpers/**", "test/helpers/**"],
		purpose: "misc",
	};
	assert.throws(() => assertDuneStack(stack), /tight purpose/u);
});
test("Dune scaffold creates feature interface and test twin first", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-dune-"));
	try {
		const result = await scaffoldModule(directory, {
			id: "auth",
			purpose: "login and sessions",
			folder: "src/auth",
			interface: "src/auth/api.ts",
			allowed_paths: ["src/auth/**", "test/auth/**"],
			depends_on: [],
		});
		assert.equal(await readFile(result.interface, "utf8"), "export {};\n");
		assert.equal(await readFile(result.testTwin, "utf8"), "export {};\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("print mode removes mutation tools", () => {
	let start: ((event: unknown, context: ExtensionCommandContext) => void) | undefined;
	let active = ["read", "write", "edit", "grep"];
	registerPrintProfile({
		on(_event: string, handler: typeof start) {
			start = handler;
		},
		getActiveTools() {
			return active;
		},
		setActiveTools(tools: string[]) {
			active = tools;
		},
	} as unknown as ExtensionAPI);
	start?.({}, { mode: "print" } as ExtensionCommandContext);
	assert.deepEqual(active, ["read", "grep"]);
});

test("forbidden runtime dependencies and official model overlays remain absent", async () => {
	const packageDocument = JSON.parse(await readFile("package.json", "utf8")) as {
		dependencies?: Record<string, string>;
	};
	const forbidden = [
		"pstack",
		"open-pstack",
		"pi-pstack",
		"pi-intercom",
		"pi-mesh",
		"pi-bus",
		"exa-js",
		"@perplexity-ai/perplexity_ai",
	];
	for (const name of forbidden) assert.equal(packageDocument.dependencies?.[name], undefined);
	const source = await readFile("packages/coding-agent/src/kpi/extensions/index.ts", "utf8");
	assert.doesNotMatch(source, /registerProvider\("(?:anthropic|openai|openai-codex|xai)"[\s\S]*?models/u);
});
