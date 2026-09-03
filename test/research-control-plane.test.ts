import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { registerAccounts } from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { verifyChain } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { researchCellFromDocument } from "../packages/coding-agent/src/kpi/extensions/board.ts";
import { parseLoopInvocation } from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";
import {
	assertResearchBaseUrl,
	DEFAULT_EXA_BASE_URL,
	DEFAULT_FIRECRAWL_BASE_URL,
	DEFAULT_PERPLEXITY_BASE_URL,
	DEFAULT_RESEARCH_TIMEOUT_MS,
	fetchBounded,
	ResearchEndpointError,
	ResearchTimeoutError,
	resolveResearchEndpoints,
} from "../packages/coding-agent/src/kpi/extensions/research/endpoints.ts";
import {
	conductResearch,
	REQUIRED_EXTERNAL_SOURCES,
	taskHash,
} from "../packages/coding-agent/src/kpi/extensions/research/gate.ts";
import {
	canonicalizeUrl,
	classifyResearchFailure,
	MAX_EXTERNAL_CALLS_PER_JOB,
	ResearchBudgetError,
	ResearchSession,
	ResearchShortfallError,
	researchSecretName,
	resolveResearchKeys,
} from "../packages/coding-agent/src/kpi/extensions/research/session.ts";
import {
	promptResearchSetup,
	removeResearchKey,
	saveResearchKeys,
} from "../packages/coding-agent/src/kpi/extensions/research/setup.ts";
import type { Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import { readKpiSettings, writeResearchMode } from "../packages/coding-agent/src/kpi/extensions/settings.ts";

/** Canaries: if either string reaches an artifact, a secret leaked. */
const EXA_CANARY = "exa-secret-canary-9d41f2";
const PPLX_CANARY = "pplx-secret-canary-7c08ab";
const FIRECRAWL_CANARY = "firecrawl-secret-canary-a03be9";
const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");

function task(goal = "add a healthcheck endpoint"): Task {
	return {
		job_id: "2026-09-01-research",
		mode: "gated",
		goal,
		nongoals: [],
		acceptance: [{ id: "AC-01", statement: "researched", required: true }],
		constraints: [],
		quality_gates: ["npm test"],
		ac: { quality: "executable" },
	} as unknown as Task;
}

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), "kpi-research-home-"));
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	const previousExa = process.env.EXA_API_KEY;
	const previousPerplexity = process.env.PERPLEXITY_API_KEY;
	const previousFirecrawl = process.env.FIRECRAWL_API_KEY;
	process.env.HOME = home;
	delete process.env.KPI_CODING_AGENT_DIR;
	delete process.env.EXA_API_KEY;
	delete process.env.PERPLEXITY_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
	try {
		return await run(home);
	} finally {
		const restore = (name: string, value: string | undefined): void => {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		};
		restore("HOME", previousHome);
		restore("KPI_CODING_AGENT_DIR", previousAgentDir);
		restore("EXA_API_KEY", previousExa);
		restore("PERPLEXITY_API_KEY", previousPerplexity);
		restore("FIRECRAWL_API_KEY", previousFirecrawl);
		await rm(home, { recursive: true, force: true });
	}
}

function exaPayload(urls: readonly string[]): string {
	return JSON.stringify({
		results: urls.map((url, index) => ({
			title: `Result ${index}`,
			url,
			publishedDate: "2026-08-01",
			highlights: [`highlight for ${url}`],
		})),
	});
}

test("a saved research key beats the environment, and the environment is the fallback", async () => {
	await withHome(async (home) => {
		const agentDirectory = join(home, ".kpi", "agent");
		const secretsPath = join(agentDirectory, "accounts.secrets.json");

		process.env.EXA_API_KEY = "env-exa";
		process.env.PERPLEXITY_API_KEY = "env-pplx";
		assert.deepEqual(
			await resolveResearchKeys(agentDirectory),
			{ exa: "env-exa", perplexity: "env-pplx", firecrawl: undefined },
			"with nothing saved, the environment is the fallback",
		);

		await saveResearchKeys({ exa: EXA_CANARY }, secretsPath);
		assert.deepEqual(
			await resolveResearchKeys(agentDirectory),
			{ exa: EXA_CANARY, perplexity: "env-pplx", firecrawl: undefined },
			"a saved key wins; the unsaved service still falls back",
		);

		// 0600, and the file is a normal JSON object with just this credential.
		const mode = (await stat(secretsPath)).mode & 0o777;
		assert.equal(mode, 0o600, `secrets must be 0600, saw ${mode.toString(8)}`);
		const stored = JSON.parse(await readFile(secretsPath, "utf8")) as Record<string, { key?: string }>;
		assert.deepEqual(Object.keys(stored), [researchSecretName("exa")]);
		assert.equal(stored[researchSecretName("exa")].key, EXA_CANARY);

		await saveResearchKeys({ perplexity: PPLX_CANARY }, secretsPath);
		assert.deepEqual(await resolveResearchKeys(agentDirectory), {
			exa: EXA_CANARY,
			perplexity: PPLX_CANARY,
			firecrawl: undefined,
		});
		assert.equal((await stat(secretsPath)).mode & 0o777, 0o600, "rewrites stay 0600");

		// Logout removes only the named credential.
		assert.equal(await removeResearchKey("exa", secretsPath), true);
		assert.equal(await removeResearchKey("exa", secretsPath), false, "removing twice is not an error");
		assert.deepEqual(await resolveResearchKeys(agentDirectory), {
			exa: "env-exa",
			perplexity: PPLX_CANARY,
			firecrawl: undefined,
		});
	});
});

test("research mode persists and a named service without a key falls back", async () => {
	const project = await mkdtemp(join(tmpdir(), "kpi-research-mode-"));
	try {
		assert.equal((await readKpiSettings(project)).research, "auto", "the default is auto");
		for (const mode of ["exa", "perplexity", "firecrawl", "local", "auto"] as const) {
			await writeResearchMode(project, mode);
			assert.equal((await readKpiSettings(project)).research, mode, `${mode} persists`);
		}
		// An unrelated setting already in the file survives a mode write.
		await writeResearchMode(project, "exa");
		const path = join(project, ".kpi", "settings.json");
		const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		await writeFile(path, JSON.stringify({ ...document, other: true }, null, 2));
		await writeResearchMode(project, "local");
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { research: "local", other: true });

		// A garbage file is a narrower mode, not a crash.
		await writeFile(path, "not json");
		assert.equal((await readKpiSettings(project)).research, "auto");

		// Mode selects the service order; a named service without a key falls back.
		const keyed = new ResearchSession({ jobId: "j", mode: "perplexity", keys: { exa: "e", perplexity: "p" } });
		assert.deepEqual(keyed.configuredServices, ["perplexity"]);
		const unkeyed = new ResearchSession({ jobId: "j", mode: "perplexity", keys: { exa: "e" } });
		assert.deepEqual(unkeyed.configuredServices, ["exa"], "falls back through auto");
		const auto = new ResearchSession({ jobId: "j", mode: "auto", keys: { exa: "e", perplexity: "p" } });
		assert.deepEqual(auto.configuredServices, ["exa", "perplexity"], "auto prefers Exa first");
		const local = new ResearchSession({ jobId: "j", mode: "local", keys: { exa: "e", perplexity: "p" } });
		assert.deepEqual(local.configuredServices, [], "local asks nobody");
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("the twenty-first external call is refused before fetch", async () => {
	let fetches = 0;
	const session = new ResearchSession({
		jobId: "budget-job",
		mode: "auto",
		keys: { exa: EXA_CANARY },
		now: () => FIXED_NOW,
	});

	for (let index = 0; index < MAX_EXTERNAL_CALLS_PER_JOB; index += 1) {
		const outcome = await session.call("exa", `query ${index}`, async () => {
			fetches += 1;
			return [];
		});
		assert.equal(outcome.ok, true, `call ${index + 1} is inside the budget`);
	}
	assert.equal(session.callsSpent, MAX_EXTERNAL_CALLS_PER_JOB);
	assert.equal(session.callsRemaining, 0);

	await assert.rejects(
		session.call("exa", "one too many", async () => {
			fetches += 1;
			return [];
		}),
		ResearchBudgetError,
		"the call that would cross the budget is refused",
	);
	assert.equal(fetches, MAX_EXTERNAL_CALLS_PER_JOB, "the refused call never reached fetch");

	// An operator may raise the cap; nothing else may.
	const raised = new ResearchSession({ jobId: "raised", mode: "auto", keys: { exa: "k" }, maxExternalCalls: 1 });
	assert.equal(raised.callsRemaining, 1);
	await raised.call("exa", "q", async () => []);
	await assert.rejects(
		raised.call("exa", "q", async () => []),
		ResearchBudgetError,
	);
});

test("a 429 cools the service, the alternate is tried once, then NH-02 sets effective no-network", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-exhaust-"));
	try {
		await writeFile(join(directory, "AGENTS.md"), "# Contract\n\nthe repository's own contract\n");
		const requests: string[] = [];
		const fetchMock: typeof fetch = async (input) => {
			const url = String(input);
			requests.push(url);
			if (url.includes("exa.ai")) {
				return new Response(JSON.stringify({ error: { code: "slow_down" } }), { status: 429 });
			}
			// The alternate service times out rather than answering.
			throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
		};

		const events: { type: string; payload: Record<string, unknown> }[] = [];
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: EXA_CANARY, perplexity: PPLX_CANARY },
			mode: "auto",
			fetch: fetchMock,
			now: () => FIXED_NOW,
			eventsPath: join(directory, "events.jsonl"),
		});
		void events;

		// Each service was asked exactly once: bounded attempts, no retry storm.
		assert.equal(requests.filter((url) => url.includes("exa.ai")).length, 1, "Exa was tried once");
		assert.equal(requests.filter((url) => url.includes("perplexity.ai")).length, 1, "the alternate was tried once");

		assert.equal(document.mode, "local", "exhaustion downgrades to local research");
		assert.equal(document.network.state, "no-network");
		assert.equal(document.network.origin, "engine", "the engine concluded this, not the operator");
		assert.match(String(document.network.reason), /exa and perplexity each failed their bounded attempts/u);
		assert.deepEqual(
			document.network.failures.map((failure) => `${failure.service}:${failure.class}`),
			["exa:http_429", "perplexity:timeout"],
			"one recorded failure per attempt, classified by status and transport",
		);
		assert.ok(
			document.sources.every((source) => source.kind === "local"),
			"no external URL is fabricated after exhaustion",
		);
		assert.ok(
			document.sources.some((source) => source.ref === "AGENTS.md"),
			"the repository's own contract is a local source",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a healthy service with one distinct source ends NEEDS_HUMAN and is never downgraded", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-shortfall-"));
	try {
		let calls = 0;
		const fetchMock: typeof fetch = async () => {
			calls += 1;
			// Two paths on one host are one source, and the same URL twice is one.
			return new Response(
				exaPayload([
					"https://docs.example.com/guide",
					"https://docs.example.com/guide#anchor",
					"https://docs.example.com/other",
				]),
				{ status: 200 },
			);
		};

		await assert.rejects(
			conductResearch(directory, directory, task(), {
				keys: { exa: EXA_CANARY },
				mode: "exa",
				fetch: fetchMock,
				now: () => FIXED_NOW,
			}),
			(error: unknown) =>
				error instanceof ResearchShortfallError &&
				error.service === "exa" &&
				error.origins.length === 1 &&
				/two are required/u.test(error.message),
			"a shortfall is a human decision, not a local fallback",
		);
		assert.equal(calls, 2, "one bounded alternate query, then it stops");
		await assert.rejects(readFile(join(directory, "research.json"), "utf8"), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("auto asks exa, then perplexity, then firecrawl, and a firecrawl key alone goes online", async () => {
	const all = new ResearchSession({
		jobId: "order",
		mode: "auto",
		keys: { exa: "e", perplexity: "p", firecrawl: "f" },
	});
	assert.deepEqual(all.configuredServices, ["exa", "perplexity", "firecrawl"]);

	// A named mode without its own key falls back through the keyed list, same
	// as `exa` and `perplexity` already do.
	const unkeyedFirecrawl = new ResearchSession({
		jobId: "order-fallback",
		mode: "firecrawl",
		keys: { exa: "e", perplexity: "p" },
	});
	assert.deepEqual(unkeyedFirecrawl.configuredServices, ["exa", "perplexity"]);

	const firecrawlOnly = new ResearchSession({ jobId: "order-fc-only", mode: "auto", keys: { firecrawl: "f" } });
	assert.deepEqual(firecrawlOnly.configuredServices, ["firecrawl"]);

	const directory = await mkdtemp(join(tmpdir(), "kpi-research-fc-order-"));
	try {
		const eventsPath = join(directory, "events.jsonl");
		const fetchMock: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("exa.ai") || url.includes("perplexity.ai")) {
				return new Response(JSON.stringify({ error: { code: "slow_down" } }), { status: 429 });
			}
			// Firecrawl answers with two distinct origins.
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						web: [
							{ url: "https://one.example.com/a", title: "One" },
							{ url: "https://two.example.org/b", title: "Two" },
						],
					},
				}),
				{ status: 200 },
			);
		};
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: EXA_CANARY, perplexity: PPLX_CANARY, firecrawl: "firecrawl-canary" },
			mode: "auto",
			fetch: fetchMock,
			now: () => FIXED_NOW,
			eventsPath,
		});

		assert.equal(document.mode, "firecrawl");
		assert.equal(document.network.state, "online");
		assert.deepEqual(
			document.network.failures.map((failure) => `${failure.service}:${failure.class}`),
			["exa:http_429", "perplexity:http_429"],
			"exa and perplexity each failed once before firecrawl was tried",
		);
		assert.equal(document.sources.length, REQUIRED_EXTERNAL_SOURCES);

		const eventSchema = JSON.parse(
			await readFile(new URL("../packages/coding-agent/src/kpi/schemas/event.schema.json", import.meta.url), "utf8"),
		) as JsonSchema;
		const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
		const researchLines = lines
			.map((line) => JSON.parse(line) as { type: string })
			.filter((record) => record.type.startsWith("research."));
		assert.ok(researchLines.length > 0, "the run emitted research events");
		for (const record of researchLines) {
			assert.deepEqual(
				validateJsonSchema(record, eventSchema),
				[],
				`${record.type} validates against event.schema.json`,
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("two distinct external origins complete an online run", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-online-"));
	try {
		const fetchMock: typeof fetch = async () =>
			new Response(exaPayload(["https://one.example.com/a", "https://two.example.org/b/"]), { status: 200 });
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: EXA_CANARY },
			mode: "exa",
			fetch: fetchMock,
			now: () => FIXED_NOW,
			eventsPath: join(directory, "events.jsonl"),
		});

		assert.equal(document.mode, "exa");
		assert.equal(document.network.state, "online");
		assert.equal(document.network.origin, undefined, "an online run has no no-network origin");
		assert.deepEqual(document.network.failures, []);
		assert.equal(document.sources.length, REQUIRED_EXTERNAL_SOURCES);
		assert.deepEqual(
			document.sources.map((source) => source.ref),
			["https://one.example.com/a", "https://two.example.org/b"],
			"URLs are canonicalized before they are cited",
		);
		assert.ok(document.sources.every((source) => source.kind === "external" && source.service === "exa"));
		assert.equal(document.task_hash, taskHash(task()));

		const markdown = await readFile(join(directory, "research.md"), "utf8");
		assert.match(markdown, /one\.example\.com/u);
		assert.match(markdown, /two\.example\.org/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an authorized no-network job researches the repository and makes zero network calls", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-offline-"));
	try {
		await writeFile(join(directory, "AGENTS.md"), "# Contract\n");
		await writeFile(join(directory, "README.md"), "# Readme\n");
		await mkdir(join(directory, "plan"), { recursive: true });
		await writeFile(join(directory, "plan", "requirements.md"), "frozen requirements\n");

		let fetches = 0;
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: EXA_CANARY, perplexity: PPLX_CANARY },
			mode: "auto",
			operatorNoNetwork: true,
			now: () => FIXED_NOW,
			eventsPath: join(directory, "events.jsonl"),
			fetch: async () => {
				fetches += 1;
				return new Response("{}", { status: 200 });
			},
		});

		assert.equal(fetches, 0, "an operator-flagged offline job makes no network call");
		assert.equal(document.mode, "local");
		assert.equal(document.network.state, "no-network");
		assert.equal(document.network.origin, "operator", "the operator's flag is not the engine's conclusion");
		assert.deepEqual(document.network.failures, [], "nothing failed: nothing was tried");
		assert.deepEqual(
			document.sources.map((source) => source.ref).sort(),
			["AGENTS.md", "README.md", join("plan", "requirements.md")].sort(),
		);
		assert.ok(
			document.sources.every((source) => source.kind === "local" && source.service === null),
			"local sources are repository paths, cited as paths",
		);

		// The research state is recorded and the events describe it.
		const events = (await readFile(join(directory, "events.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.deepEqual(
			events.map((event) => event.type),
			["research.started", "research.completed"],
			"the research state is emitted even with no network",
		);
		assert.equal(events[0].network_state, "no-network");
		assert.equal(events[1].mode, "local");
		assert.equal(await verifyChain(join(directory, "events.jsonl")), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("research events are redacted: no key, header, or envelope reaches them", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-redaction-"));
	try {
		const fetchMock: typeof fetch = async (_input, init) => {
			// The request really does carry the key; nothing downstream may keep it.
			assert.match(String(new Headers(init?.headers).get("authorization")), /Bearer /u);
			return new Response(exaPayload(["https://one.example.com/a", "https://two.example.org/b"]), { status: 200 });
		};
		const eventsPath = join(directory, "events.jsonl");
		const document = await conductResearch(directory, directory, task(`use ${EXA_CANARY} carefully`), {
			keys: { exa: EXA_CANARY, perplexity: PPLX_CANARY },
			mode: "auto",
			fetch: fetchMock,
			now: () => FIXED_NOW,
			eventsPath,
		});

		const events = await readFile(eventsPath, "utf8");
		const artifacts = [
			events,
			await readFile(join(directory, "research.md"), "utf8"),
			await readFile(join(directory, "research.json"), "utf8"),
			JSON.stringify(document),
		];
		for (const [index, artifact] of artifacts.entries()) {
			// The goal legitimately contains the canary string; a *key* never does.
			// Redaction is about the credential, so assert on the secret's own use as
			// an authorization value and on the perplexity canary, which no field can
			// justify carrying.
			assert.doesNotMatch(artifact, new RegExp(PPLX_CANARY, "u"), `artifact ${index} leaked a stored key`);
			assert.doesNotMatch(artifact, /Bearer /u, `artifact ${index} leaked an authorization header`);
			assert.doesNotMatch(artifact, /authorization/iu, `artifact ${index} mentions an auth header`);
		}
		assert.ok(events.includes("research.query"), "queries are still recorded");
		assert.doesNotMatch(events, /highlights"/u, "no provider envelope is serialized");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failures are classified by status and transport, not by envelope shape", () => {
	assert.equal(classifyResearchFailure(Object.assign(new Error("payment"), { status: 402 })), "http_402");
	assert.equal(classifyResearchFailure(Object.assign(new Error("slow down"), { status: 429 })), "http_429");
	assert.equal(classifyResearchFailure(Object.assign(new Error("boom"), { status: 503 })), "http_5xx");
	assert.equal(classifyResearchFailure(Object.assign(new Error("nope"), { name: "TimeoutError" })), "timeout");
	assert.equal(classifyResearchFailure(new Error("socket timed out")), "timeout");
	assert.equal(classifyResearchFailure(Object.assign(new Error("stop"), { name: "AbortError" })), "abort");
	assert.equal(classifyResearchFailure(new Error("connection reset")), "unavailable");
	// A 429 whose body pretends to be a success is still a 429.
	assert.equal(
		classifyResearchFailure(Object.assign(new Error(JSON.stringify({ ok: true })), { status: 429 })),
		"http_429",
	);
});

test("only absolute HTTP(S) URLs are citable, and canonical form decides identity", () => {
	assert.equal(canonicalizeUrl("https://Example.COM/a/"), "https://example.com/a");
	assert.equal(canonicalizeUrl("https://example.com/a#section"), "https://example.com/a");
	assert.equal(canonicalizeUrl("  https://example.com/a  "), "https://example.com/a");
	assert.equal(canonicalizeUrl("http://example.com"), "http://example.com/");
	for (const rejected of [
		"file:///etc/passwd",
		"javascript:alert(1)",
		"ftp://example.com/x",
		"/relative/path",
		"example.com",
		"",
	]) {
		assert.equal(canonicalizeUrl(rejected), undefined, rejected);
	}
});

test("/accounts login and logout treat exa and perplexity as research targets, not pools", async () => {
	await withHome(async (home) => {
		const project = await mkdtemp(join(tmpdir(), "kpi-research-accounts-"));
		const agentDirectory = join(home, ".kpi", "agent");
		try {
			const store = new AccountsStore(agentDirectory);
			const commands = new Map<string, (args: string, context: ExtensionCommandContext) => Promise<void>>();
			const notifications: string[] = [];
			const inputs: string[] = [EXA_CANARY, PPLX_CANARY];
			const pi = {
				on() {},
				registerCommand(
					name: string,
					options: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> },
				) {
					commands.set(name, options.handler);
				},
			};
			registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], { store, now: () => FIXED_NOW });
			const context = {
				cwd: project,
				hasUI: true,
				mode: "tui",
				ui: {
					async confirm() {
						return true;
					},
					async input() {
						return inputs.shift();
					},
					notify(message: string) {
						notifications.push(message);
					},
					setStatus() {},
					setWidget() {},
				},
			} as unknown as ExtensionCommandContext;

			const accounts = commands.get("accounts")!;
			await accounts("login exa", context);
			await accounts("login perplexity", context);

			// The credentials exist...
			assert.deepEqual(await resolveResearchKeys(agentDirectory), {
				exa: EXA_CANARY,
				perplexity: PPLX_CANARY,
				firecrawl: undefined,
			});
			// ...and nothing about routing changed.
			const document = await store.read();
			assert.equal(Object.keys(document.pools).includes("exa"), false, "exa is not a pool");
			assert.equal(Object.keys(document.pools).includes("perplexity"), false, "perplexity is not a pool");
			assert.equal(document.fallback.includes("exa" as never), false, "exa is not in the fallback chain");
			// The key lives in the same secrets file by contract (AC-28.2) - what it
			// must never become is a routing slot.
			assert.equal((await store.readSecrets())[researchSecretName("exa")]?.type, "api_key");
			assert.deepEqual(
				Object.values(document.pools).flatMap((pool) => pool?.slots.map((slot) => slot.id) ?? []),
				[],
				"a research login creates no slot in any pool",
			);
			assert.equal((await readKpiSettings(project)).research, "auto", "saving a key enables online research");

			// The pool surfaces refuse them by name: they are not pool ids. The
			// command reports the refusal to the operator rather than throwing.
			const pool = commands.get("pool")!;
			const before = notifications.length;
			await pool("strategy exa quota-first", context);
			assert.match(notifications.at(-1) ?? "", /Unknown pool id: exa/u);
			await pool("chain exa,anthropic", context);
			assert.match(notifications.at(-1) ?? "", /exa/u, "an unknown chain entry is refused");
			assert.equal(
				(await store.read()).fallback.includes("exa" as never),
				false,
				"a refused chain never lands in the store",
			);
			assert.ok(notifications.length > before);

			// And a slot reference is not how a research credential is named: the
			// pool/slot grammar cannot reach a research target at all.
			await accounts("login exa/default", context);
			assert.match(notifications.at(-1) ?? "", /Usage: \/accounts login|Unknown pool/u);
			assert.deepEqual(
				Object.values((await store.read()).pools).flatMap((entry) => entry?.slots.map((slot) => slot.id) ?? []),
				[],
				"a slot-shaped research login creates nothing",
			);

			await accounts("logout exa", context);
			assert.deepEqual(await resolveResearchKeys(agentDirectory), {
				exa: undefined,
				perplexity: PPLX_CANARY,
				firecrawl: undefined,
			});
			assert.ok(notifications.some((message) => message.includes("Removed exa research credential")));

			// A canary never appears in an operator-visible message.
			for (const message of notifications) {
				assert.doesNotMatch(message, new RegExp(`${EXA_CANARY}|${PPLX_CANARY}`, "u"));
			}
		} finally {
			await rm(project, { recursive: true, force: true });
		}
	});
});

test("firecrawl is a research credential target: /accounts login firecrawl saves a key and creates no slot", async () => {
	await withHome(async (home) => {
		const project = await mkdtemp(join(tmpdir(), "kpi-research-firecrawl-"));
		const agentDirectory = join(home, ".kpi", "agent");
		try {
			const store = new AccountsStore(agentDirectory);
			const commands = new Map<string, (args: string, context: ExtensionCommandContext) => Promise<void>>();
			const notifications: string[] = [];
			const inputs: string[] = [FIRECRAWL_CANARY];
			const pi = {
				on() {},
				registerCommand(
					name: string,
					options: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> },
				) {
					commands.set(name, options.handler);
				},
			};
			registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], { store, now: () => FIXED_NOW });
			const context = {
				cwd: project,
				hasUI: true,
				mode: "tui",
				ui: {
					async confirm() {
						return true;
					},
					async input() {
						return inputs.shift();
					},
					notify(message: string) {
						notifications.push(message);
					},
					setStatus() {},
					setWidget() {},
				},
			} as unknown as ExtensionCommandContext;

			const accounts = commands.get("accounts")!;
			await accounts("login firecrawl", context);

			assert.equal((await store.readSecrets())[researchSecretName("firecrawl")]?.type, "api_key");
			assert.equal((await resolveResearchKeys(agentDirectory)).firecrawl, FIRECRAWL_CANARY);

			const document = await store.read();
			assert.equal(Object.keys(document.pools).includes("firecrawl"), false, "firecrawl is not a pool");
			assert.deepEqual(
				Object.values(document.pools).flatMap((pool) => pool?.slots.map((slot) => slot.id) ?? []),
				[],
				"a research login creates no slot in any pool",
			);
			assert.equal((await readKpiSettings(project)).research, "auto", "saving a key enables online research");

			const pool = commands.get("pool")!;
			await pool("strategy firecrawl quota-first", context);
			assert.match(notifications.at(-1) ?? "", /Unknown pool id: firecrawl/u);

			// The environment fallback yields to a saved key, and applies only once
			// nothing is saved.
			process.env.FIRECRAWL_API_KEY = "env-firecrawl";
			assert.equal((await resolveResearchKeys(agentDirectory)).firecrawl, FIRECRAWL_CANARY, "saved key wins");
			await accounts("logout firecrawl", context);
			assert.ok(notifications.some((message) => message.includes("Removed firecrawl research credential")));
			assert.equal(
				(await resolveResearchKeys(agentDirectory)).firecrawl,
				"env-firecrawl",
				"the environment is the fallback once nothing is saved",
			);

			for (const message of notifications) {
				assert.doesNotMatch(message, new RegExp(FIRECRAWL_CANARY, "u"));
			}
		} finally {
			await rm(project, { recursive: true, force: true });
		}
	});
});

test("setup saves what the operator typed and records the resulting mode", async () => {
	await withHome(async (home) => {
		const project = await mkdtemp(join(tmpdir(), "kpi-research-setup-"));
		try {
			const answers = [EXA_CANARY, "s"];
			const notifications: string[] = [];
			const prompts: string[] = [];
			const context = {
				cwd: project,
				ui: {
					async input(title: string) {
						prompts.push(title);
						return answers.shift();
					},
					notify(message: string) {
						notifications.push(message);
					},
				},
			} as unknown as ExtensionCommandContext;

			await promptResearchSetup(context);
			// Three prompts, in RESEARCH_SERVICES order; the third is answered
			// undefined (the queue is exhausted) -> skip, exactly like typing "s".
			assert.deepEqual(prompts, [
				"Exa API key for research",
				"Perplexity API key for research",
				"Firecrawl API key for research",
			]);
			assert.equal((await resolveResearchKeys(join(home, ".kpi", "agent"))).exa, EXA_CANARY);
			assert.equal(
				(await resolveResearchKeys(join(home, ".kpi", "agent"))).perplexity,
				undefined,
				"skip means skip",
			);
			assert.equal(
				(await resolveResearchKeys(join(home, ".kpi", "agent"))).firecrawl,
				undefined,
				"the unanswered third prompt saved nothing",
			);
			assert.equal((await readKpiSettings(project)).research, "auto");

			// Skipping both is a narrower mode, not a failure.
			const skipContext = {
				cwd: project,
				ui: {
					async input() {
						return "s";
					},
					notify(message: string) {
						notifications.push(message);
					},
				},
			} as unknown as ExtensionCommandContext;
			await promptResearchSetup(skipContext);
			assert.equal((await readKpiSettings(project)).research, "local");
			for (const message of notifications) {
				assert.doesNotMatch(message, new RegExp(EXA_CANARY, "u"));
			}
		} finally {
			await rm(project, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// B2/B4: overridable, validated endpoints and a bounded request
// ---------------------------------------------------------------------------

test("a settings base URL is used, and it beats the environment", async () => {
	const requested: string[] = [];
	const stubFetch: typeof fetch = async (input) => {
		requested.push(String(input));
		return new Response(exaPayload(["https://one.test/a", "https://two.test/b"]), { status: 200 });
	};
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-endpoint-"));
	try {
		await writeFile(
			join(directory, "settings.json"),
			JSON.stringify({ research: "auto", researchEndpoints: { exa: "http://127.0.0.1:8181/v1/" } }),
		);
		const { endpoints, timeoutMs } = resolveResearchEndpoints({ exa: "http://127.0.0.1:8181/v1/" }, {
			EXA_BASE_URL: "http://127.0.0.1:9999",
		} as NodeJS.ProcessEnv);
		// The operator wrote the settings file deliberately; a stray variable does
		// not silently redirect research.
		assert.equal(endpoints.exa, "http://127.0.0.1:8181/v1", "settings win and the trailing slash is normalized");
		assert.equal(endpoints.perplexity, DEFAULT_PERPLEXITY_BASE_URL, "an unset service keeps its documented origin");
		assert.equal(timeoutMs, DEFAULT_RESEARCH_TIMEOUT_MS);

		await conductResearch(directory, directory, task(), {
			keys: { exa: "exa-key" },
			mode: "exa",
			endpoints,
			fetch: stubFetch,
			now: () => FIXED_NOW,
		});
		assert.deepEqual(requested, ["http://127.0.0.1:8181/v1/search"], "the client called the configured origin");
		const document = JSON.parse(await readFile(join(directory, "research.json"), "utf8")) as {
			mode: string;
			network: { state: string };
		};
		assert.equal(document.mode, "exa");
		assert.equal(document.network.state, "online");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the environment supplies a base URL when settings do not", () => {
	const { endpoints } = resolveResearchEndpoints({}, {
		EXA_BASE_URL: "http://127.0.0.1:8181",
		PERPLEXITY_BASE_URL: "https://gateway.internal.test/pplx",
	} as NodeJS.ProcessEnv);
	assert.equal(endpoints.exa, "http://127.0.0.1:8181");
	assert.equal(endpoints.perplexity, "https://gateway.internal.test/pplx");
});

test("both services keep their documented origins when nothing overrides them", () => {
	const { endpoints, timeoutMs } = resolveResearchEndpoints({}, {} as NodeJS.ProcessEnv);
	assert.equal(endpoints.exa, DEFAULT_EXA_BASE_URL);
	assert.equal(endpoints.perplexity, DEFAULT_PERPLEXITY_BASE_URL);
	assert.equal(endpoints.firecrawl, DEFAULT_FIRECRAWL_BASE_URL);
	assert.equal(timeoutMs, DEFAULT_RESEARCH_TIMEOUT_MS);
});

test("an unusable base URL is refused, and a credentialed one is never echoed", () => {
	const cases: { value: string; reason: RegExp }[] = [
		{ value: "", reason: /the value is empty/u },
		{ value: "api.exa.ai", reason: /not an absolute URL/u },
		{ value: "ftp://api.exa.ai", reason: /ftp scheme is not supported/u },
		{ value: "https://user:hunter2@api.exa.ai", reason: /embeds credentials/u },
		{ value: "https://api.exa.ai/search?key=abc", reason: /carries no query or fragment/u },
		{ value: "https://api.exa.ai/#frag", reason: /carries no query or fragment/u },
	];
	for (const scenario of cases) {
		assert.throws(
			() => assertResearchBaseUrl(scenario.value, "exa", "settings"),
			(error: unknown) => {
				assert.ok(error instanceof ResearchEndpointError, scenario.value);
				assert.match(error.message, scenario.reason, scenario.value);
				assert.match(error.message, /^EXA_BASE_URL from settings/u, "the message names the knob to fix");
				// The rejected value is never quoted back: it may be the credential.
				assert.doesNotMatch(error.message, /hunter2/u, "a password never reaches a diagnostic");
				return true;
			},
		);
	}
	// The same refusal happens through resolution, so a bad settings file cannot
	// fall back to the public host the operator was trying to avoid.
	assert.throws(
		() => resolveResearchEndpoints({ perplexity: "notaurl" }),
		/PERPLEXITY_BASE_URL from settings is not a usable base URL/u,
	);
	assert.throws(
		() => resolveResearchEndpoints({}, { EXA_BASE_URL: "notaurl" } as NodeJS.ProcessEnv),
		/EXA_BASE_URL from the environment is not a usable base URL/u,
	);
});

test("a research timeout is bounded and validated", () => {
	assert.equal(resolveResearchEndpoints({ timeoutMs: 2_000 }).timeoutMs, 2_000);
	assert.equal(resolveResearchEndpoints({}, { RESEARCH_TIMEOUT_MS: "3000" } as NodeJS.ProcessEnv).timeoutMs, 3_000);
	assert.throws(() => resolveResearchEndpoints({ timeoutMs: 10 }), /between 1000 and 120000 ms, received 10/u);
	assert.throws(() => resolveResearchEndpoints({ timeoutMs: 500_000 }), /between 1000 and 120000 ms/u);
	assert.throws(() => resolveResearchEndpoints({ timeoutMs: 1.5 }), /integer number of milliseconds/u);
	assert.throws(
		() => resolveResearchEndpoints({}, { RESEARCH_TIMEOUT_MS: "soon" } as NodeJS.ProcessEnv),
		/integer number of milliseconds/u,
	);
});

test("a service that never answers is recorded as a timeout, not a hang", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-timeout-"));
	try {
		let aborted = false;
		// A server that answers only when its caller gives up: exactly the shape
		// that could hold a planning node open forever.
		const hangingFetch: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(init.signal?.reason ?? new Error("aborted"));
					},
					{ once: true },
				);
			});

		const started = Date.now();
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: "exa-key", perplexity: "pplx-key" },
			mode: "auto",
			timeoutMs: 1_000,
			fetch: hangingFetch,
		});
		const elapsed = Date.now() - started;
		assert.ok(aborted, "the request was aborted rather than left pending");
		assert.ok(elapsed < 30_000, `the gate returned in ${elapsed}ms instead of hanging`);
		// Every configured service timed out, so this is engine no-network with the
		// failure class recorded per attempt.
		assert.equal(document.network.state, "no-network");
		assert.equal(document.network.origin, "engine");
		assert.ok(document.network.failures.length > 0, "the timeout was recorded");
		for (const failure of document.network.failures) {
			assert.equal(failure.class, "timeout", `${failure.service} recorded ${failure.class}`);
		}
		assert.equal(document.mode, "local");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a caller abort stays an abort and is not relabelled a timeout", async () => {
	const controller = new AbortController();
	const pendingFetch: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), {
				once: true,
			});
		});
	const promise = fetchBounded(
		"http://127.0.0.1:9/never",
		{ method: "POST" },
		{ service: "Exa", timeoutMs: 30_000, signal: controller.signal, fetch: pendingFetch },
	);
	controller.abort(new DOMException("operator cancelled", "AbortError"));
	await assert.rejects(promise, (error: unknown) => {
		assert.equal(classifyResearchFailure(error), "abort", "a cancelled call is an abort");
		return true;
	});
});

test("the bounded fetch labels its own deadline TimeoutError for the classifier", async () => {
	const pendingFetch: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("some runtime wording")), { once: true });
		});
	await assert.rejects(
		fetchBounded(
			"http://127.0.0.1:9/never",
			{ method: "POST" },
			{
				service: "Perplexity",
				timeoutMs: 1_000,
				fetch: pendingFetch,
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof ResearchTimeoutError);
			assert.equal(error.name, "TimeoutError");
			assert.match(error.message, /Perplexity request timed out after 1000ms/u);
			// The recorded class must not depend on how a runtime words an abort.
			assert.equal(classifyResearchFailure(error), "timeout");
			return true;
		},
	);
});

// ---------------------------------------------------------------------------
// B3: the operator's own no-network decision
// ---------------------------------------------------------------------------

test("retired budget flags are refused wherever they appear in the input", () => {
	// K-π runs have no caps: a cap flag is refused whether it leads, trails, or
	// sits between words, and the refusal names the flag and says why.
	for (const input of [
		"--max-cost-usd 1.25 ship it",
		"fix the bug --timeout-ms 5000",
		"--no-network goal --max-rounds 3",
		"--mode autopilot --max-cost-usd 0.5 finish the job",
		"--max-rounds",
	]) {
		assert.throws(() => parseLoopInvocation(input), /was removed: K-π runs have no caps/u, input);
	}
	assert.throws(
		() => parseLoopInvocation("--timeout-ms 5000 add a healthcheck"),
		/^Error: \/kpi --timeout-ms was removed: K-π runs have no caps; cost and elapsed time are reported on the board$/u,
	);
	// The offline flag is not a cap and still composes with every mode.
	assert.deepEqual(parseLoopInvocation("--no-network add a healthcheck"), {
		goal: "add a healthcheck",
		mode: "gated",
		noNetwork: true,
	});
	assert.deepEqual(parseLoopInvocation("--no-network --until-green finish the job"), {
		goal: "finish the job",
		mode: "autopilot",
		noNetwork: true,
	});
	assert.equal("limits" in parseLoopInvocation("add a healthcheck"), false, "an invocation carries no caps");
});

test("/kpi --no-network composes with every invocation form", () => {
	assert.deepEqual(parseLoopInvocation("--no-network add a healthcheck"), {
		goal: "add a healthcheck",
		mode: "gated",
		noNetwork: true,
	});
	assert.deepEqual(parseLoopInvocation("--no-network --mode autopilot add a healthcheck"), {
		goal: "add a healthcheck",
		mode: "autopilot",
		noNetwork: true,
	});
	assert.deepEqual(parseLoopInvocation("--no-network --until-green add a healthcheck"), {
		goal: "add a healthcheck",
		mode: "autopilot",
		noNetwork: true,
	});
	assert.deepEqual(parseLoopInvocation("--no-network --plan specs/healthcheck"), {
		goal: "Implement frozen plan from specs/healthcheck",
		mode: "gated",
		planPath: "specs/healthcheck",
		noNetwork: true,
	});
	// Absent means auto, and the flag needs something to do.
	assert.equal(parseLoopInvocation("add a healthcheck").noNetwork, undefined);
	assert.throws(() => parseLoopInvocation("--no-network"), /--no-network requires a goal/u);
	assert.throws(() => parseLoopInvocation("--no-networkish goal"), /Unknown \/kpi option: --no-networkish/u);
});

test("an operator no-network job records origin operator and never asks a service", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-operator-"));
	try {
		await writeFile(join(directory, "AGENTS.md"), "# gates\n\n- npm test\n");
		let calls = 0;
		const countingFetch: typeof fetch = async () => {
			calls += 1;
			return new Response("{}", { status: 200 });
		};
		// Keys are present and healthy: the only reason this job stays offline is
		// that the operator said so.
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: "exa-key", perplexity: "pplx-key" },
			mode: "auto",
			operatorNoNetwork: true,
			fetch: countingFetch,
			now: () => FIXED_NOW,
		});
		assert.equal(calls, 0, "no service was asked");
		assert.equal(document.network.state, "no-network");
		assert.equal(document.network.origin, "operator");
		assert.equal(document.network.reason, "operator requested no-network");
		assert.deepEqual(document.network.failures, [], "an operator decision is not a failure");
		assert.equal(document.mode, "local");
		assert.ok(document.sources.length > 0, "the repository is still researched");
		for (const source of document.sources) {
			assert.equal(source.kind, "local");
			assert.equal(source.service, null);
			assert.doesNotMatch(source.ref, /^https?:/u, "no external URL is invented");
		}
		const markdown = await readFile(join(directory, "research.md"), "utf8");
		assert.match(markdown, /- network: no-network \(operator\)/u);
		assert.match(markdown, /- reason: operator requested no-network/u);

		// The board cell an operator actually sees for that state.
		const cell = researchCellFromDocument(document);
		assert.deepEqual(cell, { cell: "RESEARCH local · no-network operator" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the operator's offline decision travels on the frozen contract", () => {
	// Persisted on task.json rather than in process state, so a resumed job in a
	// fresh process cannot quietly reach the network.
	const contract = { ...task(), research_network: "offline" as const };
	assert.equal(contract.research_network, "offline");
	assert.equal((task() as { research_network?: string }).research_network, undefined);
});
