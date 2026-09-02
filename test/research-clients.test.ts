import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exaContents, exaSearch, ResearchHttpError } from "../packages/coding-agent/src/kpi/extensions/research/exa.ts";
import { conductResearch } from "../packages/coding-agent/src/kpi/extensions/research/gate.ts";
import {
	registerResearchTools,
	resetResearchSessions,
} from "../packages/coding-agent/src/kpi/extensions/research/index.ts";
import {
	DEFAULT_MAX_TOKENS,
	DEFAULT_MAX_TOKENS_PER_PAGE,
	perplexitySearch,
} from "../packages/coding-agent/src/kpi/extensions/research/perplexity.ts";
import {
	classifyResearchFailure,
	MAX_CONTENTS_URLS,
	MAX_FIELD_CHARACTERS,
	MAX_RESULTS_PER_REQUEST,
	ResearchSession,
	ResearchShortfallError,
} from "../packages/coding-agent/src/kpi/extensions/research/session.ts";
import type { Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

const KEY_CANARY = "provider-key-canary-4f1a2b";
/** Sits at the very end of an oversized field: if it survives, nothing was capped. */
const TAIL_CANARY = "TAIL-CANARY-a91c37";
const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");

/** The registered-tool surface this suite drives. */
interface ResearchTool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		context: { cwd: string },
	) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

function task(goal = "current api contracts"): Task {
	return {
		job_id: "2026-09-01-clients",
		mode: "gated",
		goal,
		nongoals: [],
		acceptance: [{ id: "AC-01", statement: "researched", required: true }],
		constraints: [],
		quality_gates: ["npm test"],
		ac: { quality: "executable" },
	} as unknown as Task;
}

interface Captured {
	url: string;
	body: Record<string, unknown>;
	headers: Headers;
	signal?: AbortSignal | null;
}

function capturing(respond: (captured: Captured) => Response): { fetch: typeof fetch; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const captured: Captured = {
			url: String(input),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			headers: new Headers(init?.headers),
			signal: init?.signal,
		};
		calls.push(captured);
		return respond(captured);
	};
	return { fetch: fetchImpl, calls };
}

function exaBody(urls: readonly string[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		requestId: "req-1",
		results: urls.map((url, index) => ({
			id: url,
			url,
			title: `Result ${index}`,
			publishedDate: "2026-08-01T00:00:00.000Z",
			highlights: [`highlight ${index}`],
			highlightScores: [0.9],
		})),
		...extra,
	});
}

test("Exa Search nests bounded content options and caps the result count", async () => {
	const { fetch: fetchImpl, calls } = capturing(
		() => new Response(exaBody(["https://a.example.com/x"]), { status: 200 }),
	);
	const results = await exaSearch("how does exa search work", KEY_CANARY, {
		numResults: 99,
		fetch: fetchImpl,
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.exa.ai/search");
	assert.equal(calls[0].headers.get("authorization"), `Bearer ${KEY_CANARY}`);
	const body = calls[0].body;
	assert.equal(body.query, "how does exa search work");
	assert.equal(body.type, "auto");
	assert.equal(body.numResults, MAX_RESULTS_PER_REQUEST, "a request over the cap is capped, never sent as asked");
	// Search content options are nested under `contents`.
	assert.deepEqual(body.contents, { highlights: { numSentences: 3, highlightsPerUrl: 2, maxCharacters: 10_000 } });
	assert.equal("text" in body, false, "full text is opt-in and never requested by search");
	assert.equal("highlights" in body, false, "search content options are not top-level");
	assert.deepEqual(results, [
		{
			title: "Result 0",
			url: "https://a.example.com/x",
			publishedDate: "2026-08-01T00:00:00.000Z",
			text: "highlight 0",
		},
	]);

	// A caller may narrow the bound but never widen it past the cap.
	const { fetch: narrowed, calls: narrowedCalls } = capturing(() => new Response(exaBody([]), { status: 200 }));
	await exaSearch("q", KEY_CANARY, { maxCharacters: 500_000, fetch: narrowed });
	assert.equal(
		(narrowedCalls[0].body.contents as { highlights: { maxCharacters: number } }).highlights.maxCharacters,
		MAX_FIELD_CHARACTERS,
	);
	const { fetch: smaller, calls: smallerCalls } = capturing(() => new Response(exaBody([]), { status: 200 }));
	await exaSearch("q", KEY_CANARY, { maxCharacters: 250, fetch: smaller });
	assert.equal(
		(smallerCalls[0].body.contents as { highlights: { maxCharacters: number } }).highlights.maxCharacters,
		250,
	);
});

test("Exa Contents puts content options top level, sends at most ten URLs, and reads per-URL status", async () => {
	const requested = Array.from({ length: 14 }, (_, index) => `https://host${index}.example.com/page`);
	const { fetch: fetchImpl, calls } = capturing(
		() =>
			new Response(
				exaBody(["https://host0.example.com/page", "https://host1.example.com/page"], {
					statuses: [
						{ id: "https://host0.example.com/page", status: "success" },
						{
							id: "https://host1.example.com/page",
							status: "error",
							error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
						},
					],
				}),
				{ status: 200 },
			),
	);

	const response = await exaContents([...requested, "not-a-url", "javascript:alert(1)"], KEY_CANARY, {
		fetch: fetchImpl,
	});

	const body = calls[0].body;
	assert.equal(calls[0].url, "https://api.exa.ai/contents");
	assert.equal((body.urls as string[]).length, MAX_CONTENTS_URLS, "at most ten URLs are sent");
	assert.ok(
		(body.urls as string[]).every((url) => url.startsWith("https://host")),
		"unusable URLs never reach the provider",
	);
	// Contents content options are top-level, not nested.
	assert.deepEqual(body.highlights, { numSentences: 3, highlightsPerUrl: 2, maxCharacters: 10_000 });
	assert.equal("contents" in body, false);
	assert.equal("text" in body, false, "full text stays opt-in");

	// HTTP 200 with a per-URL failure yields only the successful citation.
	assert.deepEqual(
		response.results.map((result) => result.url),
		["https://host0.example.com/page"],
	);
	assert.deepEqual(response.failures, [
		{ url: "https://host1.example.com/page", status: 404, error: "CRAWL_NOT_FOUND" },
	]);

	// Opting into text bounds it at request time.
	const { fetch: withText, calls: textCalls } = capturing(() => new Response(exaBody([]), { status: 200 }));
	await exaContents(["https://a.example.com/x"], KEY_CANARY, {
		includeText: true,
		maxCharacters: 99_999,
		fetch: withText,
	});
	assert.deepEqual(textCalls[0].body.text, { maxCharacters: MAX_FIELD_CHARACTERS });
});

test("Perplexity sends hard token bounds and never a qualitative context size", async () => {
	const { fetch: fetchImpl, calls } = capturing(
		() =>
			new Response(
				JSON.stringify({
					results: [
						{
							title: "Doc",
							url: "https://docs.example.com/a",
							snippet: "snippet",
							date: "2026-07-01",
							last_updated: "2026-08-30",
						},
					],
				}),
				{ status: 200 },
			),
	);

	const results = await perplexitySearch("current perplexity search contract", KEY_CANARY, {
		maxResults: 50,
		fetch: fetchImpl,
	});

	const body = calls[0].body;
	assert.equal(calls[0].url, "https://api.perplexity.ai/search");
	assert.equal(body.max_results, MAX_RESULTS_PER_REQUEST, "max_results is capped");
	assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS);
	assert.equal(body.max_tokens_per_page, DEFAULT_MAX_TOKENS_PER_PAGE);
	assert.equal("search_context_size" in body, false, "a qualitative knob is not a hard bound");
	assert.deepEqual(results, [
		{ title: "Doc", url: "https://docs.example.com/a", publishedDate: "2026-07-01", text: "snippet" },
	]);

	// Explicit bounds are honoured.
	const { fetch: tight, calls: tightCalls } = capturing(
		() => new Response(JSON.stringify({ results: [] }), { status: 200 }),
	);
	await perplexitySearch("q", KEY_CANARY, { maxTokens: 10, maxTokensPerPage: 5, fetch: tight });
	assert.equal(tightCalls[0].body.max_tokens, 10);
	assert.equal(tightCalls[0].body.max_tokens_per_page, 5);
});

test("both clients forward the abort signal and classify failures by status and transport", async () => {
	// The caller's cancellation is honoured alongside the client's own deadline, so
	// the request carries a signal that answers to both rather than the caller's
	// object itself.
	const controller = new AbortController();
	const { fetch: fetchImpl, calls } = capturing(() => new Response(exaBody([]), { status: 200 }));
	await exaSearch("q", KEY_CANARY, { signal: controller.signal, fetch: fetchImpl });
	assert.ok(calls[0].signal instanceof AbortSignal, "Exa sends a signal");
	assert.equal(calls[0].signal?.aborted, false);

	const { fetch: pplxFetch, calls: pplxCalls } = capturing(
		() => new Response(JSON.stringify({ results: [] }), { status: 200 }),
	);
	await perplexitySearch("q", KEY_CANARY, { signal: controller.signal, fetch: pplxFetch });
	assert.ok(pplxCalls[0].signal instanceof AbortSignal, "Perplexity sends a signal");

	// Aborting the caller's own controller aborts the request that is in flight.
	const live = new AbortController();
	let observed: AbortSignal | undefined;
	const holdingFetch: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			observed = init?.signal ?? undefined;
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted by caller")));
		});
	const inFlight = exaSearch("q", KEY_CANARY, { signal: live.signal, fetch: holdingFetch });
	live.abort();
	await assert.rejects(inFlight);
	assert.equal(observed?.aborted, true, "the caller's abort reached the request");

	// Status decides, whatever the envelope claims.
	for (const status of [402, 429, 500, 503, 422]) {
		const failing: typeof fetch = async () =>
			new Response(JSON.stringify({ ok: true, message: "looks fine" }), { status });
		await assert.rejects(
			exaSearch("q", KEY_CANARY, { fetch: failing }),
			(error: unknown) => error instanceof ResearchHttpError && error.status === status,
			`Exa ${status}`,
		);
		await assert.rejects(
			perplexitySearch("q", KEY_CANARY, { fetch: failing }),
			(error: unknown) => error instanceof ResearchHttpError && error.status === status,
			`Perplexity ${status}`,
		);
	}
	assert.equal(classifyResearchFailure(new ResearchHttpError(402, "Perplexity")), "http_402");
	assert.equal(classifyResearchFailure(new ResearchHttpError(429, "Exa")), "http_429");
	assert.equal(classifyResearchFailure(new ResearchHttpError(503, "Exa")), "http_5xx");

	// A real abort reaches the caller as an abort, not as a transport mystery.
	const aborted = new AbortController();
	aborted.abort();
	const abortingFetch: typeof fetch = async (_input, init) => {
		init?.signal?.throwIfAborted();
		return new Response("{}", { status: 200 });
	};
	const failure = await new ResearchSession({ jobId: "abort", mode: "exa", keys: { exa: KEY_CANARY } }).call(
		"exa",
		"q",
		async (key) => exaSearch("q", key, { signal: aborted.signal, fetch: abortingFetch }),
	);
	assert.equal(failure.ok, false);
	assert.equal(failure.ok === false ? failure.class : undefined, "abort");
});

test("oversized upstream data never reaches tool output, events, research.md, or research.json", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-canary-"));
	try {
		const huge = (label: string): string => `${label} ${"x".repeat(60_000)} ${TAIL_CANARY}`;
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					results: [
						{
							url: "https://one.example.com/a",
							title: huge("title"),
							highlights: [huge("highlight-a"), huge("highlight-b")],
							text: huge("text"),
							publishedDate: `2026-08-01 ${TAIL_CANARY}`,
						},
						{
							url: "https://two.example.org/b",
							title: huge("second"),
							highlights: [huge("highlight-c")],
						},
					],
					debug: { rawHeaders: { authorization: `Bearer ${KEY_CANARY}` }, envelope: huge("raw") },
				}),
				{ status: 200 },
			);

		const eventsPath = join(directory, "events.jsonl");
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: KEY_CANARY },
			mode: "exa",
			fetch: fetchImpl,
			now: () => FIXED_NOW,
			eventsPath,
		});

		const artifacts: [string, string][] = [
			["research.json", await readFile(join(directory, "research.json"), "utf8")],
			["research.md", await readFile(join(directory, "research.md"), "utf8")],
			["events.jsonl", await readFile(eventsPath, "utf8")],
			["returned document", JSON.stringify(document)],
		];
		for (const [name, content] of artifacts) {
			assert.doesNotMatch(content, new RegExp(TAIL_CANARY, "u"), `${name} kept the tail of an oversized field`);
			assert.doesNotMatch(content, new RegExp(KEY_CANARY, "u"), `${name} leaked the key`);
			assert.doesNotMatch(content, /rawHeaders|Bearer /u, `${name} serialized a raw provider response`);
		}

		// The client itself caps, not only the artifact writer: a widened provider
		// bound must not be able to hand 15,000 characters to anything downstream.
		const direct = await exaSearch("q", KEY_CANARY, { fetch: fetchImpl });
		for (const result of direct) {
			assert.ok(
				(result.text ?? "").length <= MAX_FIELD_CHARACTERS,
				`the client returned ${(result.text ?? "").length} characters, over the cap`,
			);
			assert.ok(result.title.length <= 300, "a title is bounded at the client boundary too");
			assert.ok((result.publishedDate ?? "").length <= 64);
			assert.doesNotMatch(result.text ?? "", new RegExp(TAIL_CANARY, "u"));
		}

		// Every stored field is inside its own cap.
		for (const source of document.sources) {
			assert.ok(source.title.length <= 300, "a title is a title, not a page");
			assert.ok((source.excerpt ?? "").length <= MAX_FIELD_CHARACTERS);
			assert.ok(source.ref.length <= MAX_FIELD_CHARACTERS);
		}
		// The date field is bounded too, and stays one field.
		const sources = document.sources.filter((source) => source.kind === "external");
		assert.equal(sources.length, 2, "two distinct origins still complete the run");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("duplicate and one-origin result sets deduplicate, retry once, then report a shortfall", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-dedupe-"));
	try {
		const queries: string[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { query: string };
			queries.push(body.query);
			// The same host over and over, in several spellings.
			return new Response(
				exaBody([
					"https://docs.example.com/guide",
					"https://docs.example.com/guide/",
					"https://DOCS.example.com/guide#frag",
					"https://docs.example.com/other",
				]),
				{ status: 200 },
			);
		};

		await assert.rejects(
			conductResearch(directory, directory, task(), {
				keys: { exa: KEY_CANARY },
				mode: "exa",
				fetch: fetchImpl,
				now: () => FIXED_NOW,
			}),
			(error: unknown) => error instanceof ResearchShortfallError && error.origins.length === 1,
			"one origin is a shortfall, however many paths it has",
		);
		assert.equal(queries.length, 2, "exactly one bounded alternate query");
		assert.notEqual(queries[0], queries[1], "the follow-up is a different query, not a repeat");

		// A second origin on the follow-up completes the contract instead.
		let call = 0;
		const improving: typeof fetch = async () => {
			call += 1;
			return new Response(
				call === 1
					? exaBody(["https://docs.example.com/guide", "https://docs.example.com/guide/"])
					: exaBody(["https://other.example.org/reference"]),
				{ status: 200 },
			);
		};
		const document = await conductResearch(directory, directory, task(), {
			keys: { exa: KEY_CANARY },
			mode: "exa",
			fetch: improving,
			now: () => FIXED_NOW,
		});
		assert.equal(call, 2);
		assert.deepEqual(
			document.sources.map((source) => source.ref),
			["https://docs.example.com/guide", "https://other.example.org/reference"],
			"duplicates collapsed to one canonical ref per source",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("results without a usable absolute URL are never cited", async () => {
	const fetchImpl: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				results: [
					{ url: "/relative/path", title: "relative" },
					{ url: "javascript:alert(1)", title: "script" },
					{ url: "file:///etc/passwd", title: "local file" },
					{ url: "", title: "empty" },
					{ title: "missing url" },
					{ url: "https://good.example.com/a", title: "   " },
				],
			}),
			{ status: 200 },
		);
	const results = await exaSearch("q", KEY_CANARY, { fetch: fetchImpl });
	assert.deepEqual(results, [{ title: "https://good.example.com/a", url: "https://good.example.com/a" }]);

	const pplx: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				results: [
					{ url: "ftp://example.com/x", title: "ftp" },
					{ url: "https://ok.example.com/b", title: "ok" },
				],
			}),
			{ status: 200 },
		);
	assert.deepEqual(await perplexitySearch("q", KEY_CANARY, { fetch: pplx }), [
		{ title: "ok", url: "https://ok.example.com/b" },
	]);
});

test("a malformed or empty envelope is an empty result set, not a crash", async () => {
	for (const payload of ["{}", "[]", '{"results":null}', '{"results":[1,2,3]}', '{"results":[{}]}', "null"]) {
		const fetchImpl: typeof fetch = async () => new Response(payload, { status: 200 });
		assert.deepEqual(await exaSearch("q", KEY_CANARY, { fetch: fetchImpl }), [], payload);
		assert.deepEqual(await perplexitySearch("q", KEY_CANARY, { fetch: fetchImpl }), [], payload);
		const contents = await exaContents(["https://a.example.com/x"], KEY_CANARY, { fetch: fetchImpl });
		assert.deepEqual(contents.results, [], payload);
	}
});

test("an Exa Contents response that fails every URL yields citations for none", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-allfail-"));
	try {
		await writeFile(join(directory, "AGENTS.md"), "# Contract\n");
		const fetchImpl: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					results: [],
					statuses: [
						{
							id: "https://a.example.com/x",
							status: "error",
							error: { tag: "CRAWL_TIMEOUT", httpStatusCode: 408 },
						},
						{ id: "https://b.example.com/y", status: "error", error: { tag: "SOURCE_NOT_AVAILABLE" } },
					],
				}),
				{ status: 200 },
			);
		const response = await exaContents(["https://a.example.com/x", "https://b.example.com/y"], KEY_CANARY, {
			fetch: fetchImpl,
		});
		assert.deepEqual(response.results, [], "nothing was fetched, so nothing is citable");
		assert.deepEqual(response.failures, [
			{ url: "https://a.example.com/x", status: 408, error: "CRAWL_TIMEOUT" },
			{ url: "https://b.example.com/y", error: "SOURCE_NOT_AVAILABLE" },
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("tool output is bounded and carries no provider envelope", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-tool-"));
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	const previousExa = process.env.EXA_API_KEY;
	try {
		process.env.HOME = directory;
		delete process.env.KPI_CODING_AGENT_DIR;
		process.env.EXA_API_KEY = KEY_CANARY;
		resetResearchSessions();

		const huge = `${"y".repeat(60_000)} ${TAIL_CANARY}`;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					results: [
						{ id: "https://a.example.com/x", url: "https://a.example.com/x", title: huge, highlights: [huge] },
						{
							id: "https://b.example.com/y",
							url: "https://b.example.com/y",
							title: "second",
							highlights: [huge],
						},
					],
					statuses: [
						{ id: "https://a.example.com/x", status: "success" },
						{ id: "https://b.example.com/y", status: "success" },
						{
							id: "https://c.example.com/z",
							status: "error",
							error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
						},
					],
				}),
				{ status: 200 },
			)) as typeof fetch;

		const tools = new Map<string, ResearchTool>();
		registerResearchTools({
			registerTool(tool: ResearchTool) {
				tools.set(tool.name, tool);
			},
		} as unknown as Parameters<typeof registerResearchTools>[0]);

		const context = { cwd: directory } as { cwd: string };
		for (const name of ["exa_search", "exa_contents"]) {
			const tool = tools.get(name);
			assert.ok(tool !== undefined, `${name} is registered`);
			const output = await tool.execute(
				"call-1",
				name === "exa_search"
					? { query: "q" }
					: { urls: ["https://a.example.com/x", "https://b.example.com/y", "https://c.example.com/z"] },
				undefined,
				undefined,
				context,
			);
			const text = output.content.map((block) => block.text).join("\n");
			assert.ok(text.length <= 10_000, `${name} output is bounded, saw ${text.length}`);
			assert.doesNotMatch(text, new RegExp(TAIL_CANARY, "u"), `${name} output kept an oversized tail`);
			assert.doesNotMatch(text, new RegExp(KEY_CANARY, "u"), `${name} output leaked the key`);
			assert.doesNotMatch(text, /highlightScores|statuses|requestId|Bearer /u, `${name} dumped a provider envelope`);
			if (name === "exa_contents") {
				assert.match(
					text,
					/unavailable https:\/\/c\.example\.com\/z \(CRAWL_NOT_FOUND\)/u,
					"bounded diagnostics only",
				);
			}
		}
	} finally {
		globalThis.fetch = previousFetch;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.KPI_CODING_AGENT_DIR;
		else process.env.KPI_CODING_AGENT_DIR = previousAgentDir;
		if (previousExa === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = previousExa;
		resetResearchSessions();
		await rm(directory, { recursive: true, force: true });
	}
});
