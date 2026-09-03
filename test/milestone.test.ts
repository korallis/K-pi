import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import {
	AccountBalancer,
	DEFAULT_FALLBACK_CHAIN,
} from "../packages/coding-agent/src/kpi/extensions/accounts/balancer.ts";
import {
	classifyProviderBodyFailure,
	classifyProviderFailure,
	DEFAULT_COOLDOWN_MS,
} from "../packages/coding-agent/src/kpi/extensions/accounts/errors.ts";
import type { AccountsDocument } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { UsageCache } from "../packages/coding-agent/src/kpi/extensions/accounts/usage/cache.ts";
import { renderAccountsWidget } from "../packages/coding-agent/src/kpi/extensions/accounts/widget.ts";
import { appendEvent } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { WorkerProtocol } from "../packages/coding-agent/src/kpi/extensions/bus/protocol.ts";
import {
	BackgroundBus,
	createWorkerAdmission,
	type WorkerLauncher,
} from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
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
import { parseModelLadder } from "../packages/coding-agent/src/kpi/kstack/ladder.ts";
import { assertShipApproved, createKModePlan } from "../packages/coding-agent/src/kpi/kstack/mode.ts";
import {
	assertKnownModels,
	INHERIT_PARENT,
	planModels,
	planToDocument,
} from "../packages/coding-agent/src/kpi/kstack/models.ts";

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
	assert.deepEqual(classifyProviderFailure({ status: 429 }, now), {
		kind: "cooldown",
		until: now + DEFAULT_COOLDOWN_MS,
		reason: "provider response 429",
	});
	assert.equal(
		classifyProviderFailure({ status: 403, headers: { "x-error": "quota exhausted" } }, now)?.kind,
		"cooldown",
	);

	// Body tokens are only available to a fetch client that owns the body.
	assert.equal(classifyProviderBodyFailure({ status: 403, body: "permission denied" }, now), undefined);
	assert.equal(classifyProviderBodyFailure({ status: 403, body: "quota exhausted" }, now)?.kind, "cooldown");
	assert.equal(classifyProviderBodyFailure({ status: 400, body: "out of extra usage" }, now)?.kind, "cooldown");
	assert.equal(classifyProviderBodyFailure({ status: 400, body: "invalid request" }, now), undefined);
	assert.equal(classifyProviderBodyFailure({ status: 429, body: "usage limit" }, now)?.kind, "cooldown");
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
		status: "STOPPED",
		prev_hash: "0".repeat(64),
		record_hash: "1".repeat(64),
	});
	assert.ok(rendered.length < 800);
});

test("accounts widget labels each slot percentage", () => {
	const usage = new UsageCache({ now: () => 0 });
	usage.recordHeaders("anthropic", "A", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "40" });
	usage.recordHeaders("anthropic", "B", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "80" });

	const widget = renderAccountsWidget(accounts, { usage, now: 0 });

	assert.match(widget, /personal 40%/u);
	assert.match(widget, /work 80%/u);
	assert.doesNotMatch(widget, /^\s*\d+%\s*$/mu);
});

test("Cursor registers its id and refreshes a mocked live array", async () => {
	// The refresh caches the catalog in the agent directory, so this stays in a
	// temporary one rather than writing into the operator's real home.
	const agentDirectory = await mkdtemp(join(tmpdir(), "kpi-cursor-milestone-"));
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	process.env.KPI_CODING_AGENT_DIR = agentDirectory;
	process.env.HOME = agentDirectory;
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
	try {
		const models = await refreshCursorModels(context, async () => response);
		assert.equal(models[0]?.id, "live");
		assert.equal(Array.isArray(await config?.refreshModels?.(context).catch(() => [])), true);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.KPI_CODING_AGENT_DIR;
		} else {
			process.env.KPI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousHome !== undefined) process.env.HOME = previousHome;
		await rm(agentDirectory, { recursive: true, force: true });
	}
});

test("K-mode feature comes from the generated runtime and ship needs approval", async () => {
	// The registry is the generated tree, so this reads what the sync emitted
	// rather than a table in k-pi source.
	const plan = await createKModePlan("add a healthcheck");
	assert.equal(plan.playbook, "feature");
	assert.equal(plan.steps[0].node, "specify");
	assert.ok(plan.todos[0].startsWith("specify:"));
	const directory = await mkdtemp(join(tmpdir(), "kpi-verdict-"));
	try {
		await writeFile(join(directory, "verdict.json"), JSON.stringify({ approved: false }));
		await assert.rejects(assertShipApproved(directory), /blocked/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("K-stack setup never writes a slug outside the live candidates", () => {
	const ladder = parseModelLadder(`
| Role | Prefer, in order | Why | Confidence |
|---|---|---|---|
| implementer | \`sol\` | workhorse | Medium |
| frontend | \`k3\` | design | Medium-high |
| judgment | \`opus\` | taste | Medium |
| precise | \`sol\` | contracts | Medium |
| fast | \`luna\` | cheap | Medium |
| review_panel | \`opus\`, \`sol\` | cross-family | Medium |

1. GPT-5.6 Sol — workhorse
2. Claude Opus 5 — judgment
`);
	const candidates = ["anthropic/opus", "xai/sol"];
	const document = planToDocument(planModels(ladder, candidates));
	assert.doesNotThrow(() => assertKnownModels(document, candidates));
	// A role the ladder cannot fill inherits the parent rather than inventing one.
	assert.equal(document.roles.frontend, INHERIT_PARENT);
	document.roles.fast = "unknown/model";
	assert.throws(() => assertKnownModels(document, candidates), /Unknown model slug/u);
});

test("background bus caps workers, writers, messages, and leases", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-bus-"));
	const runDirectory = join(directory, ".kpi", "runs", "job");
	const messages: string[] = [];
	const alive = new Set<number>();
	let pid = 1;
	// A peer that accepts everything, so this scenario stays about caps and
	// leases. The protocol itself is exercised in test/bus.test.ts.
	const launcher: WorkerLauncher = async (request) => {
		const workerPid = pid++;
		alive.add(workerPid);
		const toWorker = new PassThrough();
		const toParent = new PassThrough();
		toWorker.on("data", (chunk: Buffer) => {
			for (const line of chunk
				.toString("utf8")
				.split("\n")
				.filter((entry) => entry.length > 0)) {
				const record = JSON.parse(line) as { id: string; type: string; message?: string };
				if (record.message !== undefined) messages.push(record.message);
				toParent.write(
					`${JSON.stringify({ id: record.id, type: "response", command: record.type, success: true })}\n`,
				);
			}
		});
		const protocol = new WorkerProtocol({ stdin: toWorker, stdout: toParent });
		return {
			pid: workerPid,
			argv: [request.sessionPath],
			protocol,
			isAlive: () => alive.has(workerPid),
			stop: async () => {
				alive.delete(workerPid);
				protocol.close();
			},
		};
	};
	const bus = new BackgroundBus(directory, runDirectory, "job", {
		launcher,
		isProcessAlive: (candidate) => alive.has(candidate),
		admission: createWorkerAdmission(),
		contractWaitTimeoutMs: 2_000,
	});
	try {
		const writer = await bus.spawn({ role: "implementer", prompt: "one", tools: ["read", "write"] });
		await assert.rejects(bus.spawn({ role: "implementer", prompt: "two", tools: ["edit"] }), /writer/u);
		const reviewer = await bus.spawn({ role: "reviewer", prompt: "review" });
		await assert.rejects(bus.spawn({ role: "tester", prompt: "third" }), /limit/u);
		await bus.communicate({ agentId: reviewer.agentId, message: "follow", deliverAs: "followUp", expect: "ack" });
		assert.deepEqual(messages, ["one", "review", "follow"]);
		await bus.claim(writer.agentId, writer.pid, "src/a.ts");
		await assert.rejects(bus.claim(reviewer.agentId, reviewer.pid, "src/a.ts"), /claimed/u);
		await bus.stop(writer.agentId);
		await bus.claim(reviewer.agentId, reviewer.pid, "src/a.ts");
	} finally {
		await bus.stopAll().catch(() => undefined);
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
		await assert.rejects(assertMinimalistBounds(directory, run, task, []), /ladder/u);
		await writeFile(
			join(run, "candidate.json"),
			JSON.stringify({
				ladder: "one-liner",
				used: "inline expression",
				skipped: "helper module",
			}),
		);
		await assert.rejects(assertMinimalistBounds(directory, run, task, []), /surprise/u);
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
		const task = { job_id: "research-job", goal: "current docs" } as Task;
		const document = await conductResearch(directory, directory, task, {
			keys: { exa: "x", perplexity: "p" },
			mode: "auto",
			fetch: fetchMock,
		});
		assert.equal(document.mode, "perplexity", "the cooled preferred service handed over to the alternate");
		assert.equal(document.sources.length, 2);
		assert.deepEqual(
			document.network.failures.map((failure) => `${failure.service}:${failure.class}`),
			["exa:http_429"],
			"the 429 is recorded once, against the service that returned it",
		);
		assert.equal(document.network.state, "online", "one service answering is not exhaustion");
		assert.equal(calls, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Dune stack rejects generic maps and outside-module claims", async () => {
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
	// The claim boundary is asynchronous now: it resolves links before deciding.
	await assert.rejects(assertClaimInModule("/repo", "src/billing/a.ts", stack.modules[0]), /UNSAFE/u);
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
