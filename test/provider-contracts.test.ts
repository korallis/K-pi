import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../packages/coding-agent/src/core/extensions/types.ts";
import { getApiKey, login, refreshToken } from "../packages/coding-agent/src/kpi/extensions/cursor/oauth.ts";
import {
	CURSOR_FALLBACK_MODELS,
	readStoredCursorModels,
	refreshCursorModels,
	registerCursorProvider,
	storedCursorModelsPath,
} from "../packages/coding-agent/src/kpi/extensions/cursor/provider.ts";

/**
 * Ids Pi owns. REQ-PR-01: K-π must never hand any of these a `models` array,
 * because that freezes the official catalog at our release date.
 */
const OFFICIAL_POOL_IDS = [
	"anthropic",
	"openai",
	"openai-codex",
	"xai",
	"zai",
	"zai-coding-cn",
	"kimi-coding",
] as const;

const kpiSourceDir = fileURLToPath(new URL("../packages/coding-agent/src/kpi/", import.meta.url));

interface RegisteredProvider {
	id: string;
	config: Record<string, unknown>;
}

function captureProviders(register: (pi: ExtensionAPI) => void): RegisteredProvider[] {
	const registered: RegisteredProvider[] = [];
	register({
		registerProvider(id: string, config: Record<string, unknown>) {
			registered.push({ id, config });
		},
	} as unknown as ExtensionAPI);
	return registered;
}

test("no official provider id is registered, so none can receive a models array", () => {
	const registered = captureProviders(registerCursorProvider);

	assert.deepEqual(
		registered.map((provider) => provider.id),
		["cursor"],
		"cursor is the only provider K-π registers",
	);
	for (const official of OFFICIAL_POOL_IDS) {
		assert.equal(
			registered.some((provider) => provider.id === official),
			false,
			`${official} must stay Pi-owned`,
		);
	}
});

test("no source file passes a models array to an official provider id", async () => {
	const files: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!/kstack\/(generated|upstream)$/u.test(path)) {
					await walk(path);
				}
			} else if (entry.name.endsWith(".ts")) {
				files.push(path);
			}
		}
	};
	await walk(kpiSourceDir);
	assert.ok(files.length > 0, "the K-π source tree was not scanned");

	for (const file of files) {
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(/registerProvider\(\s*"([^"]+)"/gu)) {
			assert.equal(
				(OFFICIAL_POOL_IDS as readonly string[]).includes(match[1]),
				false,
				`${file} registers the official id ${match[1]}`,
			);
		}
	}
});

test("Cursor keeps a bounded bootstrap list and Pi-compatible login callbacks", () => {
	const [cursor] = captureProviders(registerCursorProvider);

	assert.ok(cursor);
	assert.equal(cursor.config.name, "Cursor");
	assert.equal(cursor.config.api, "openai-completions");
	const models = cursor.config.models as Array<{ id: string }>;
	assert.ok(Array.isArray(models) && models.length > 0, "the bootstrap list must not be empty");
	assert.ok(models.length <= 8, `the bootstrap list must stay bounded, got ${models.length}`);
	assert.equal(typeof cursor.config.refreshModels, "function", "the live list replaces the bootstrap");

	const oauth = cursor.config.oauth as Record<string, unknown>;
	assert.equal(oauth.login, login, "Pi's own login callback");
	assert.equal(oauth.refreshToken, refreshToken);
	assert.equal(oauth.getApiKey, getApiKey);
	assert.equal(oauth.isSubscription, true);
});

test("a live refresh replaces the bootstrap list and stores the last known catalog", async () => {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	const directory = await mkdtemp(join(tmpdir(), "k-pi-cursor-"));
	try {
		process.env.KPI_CODING_AGENT_DIR = directory;
		process.env.HOME = directory;
		process.env.USERPROFILE = directory;

		assert.equal(readStoredCursorModels(directory), undefined, "nothing is stored before the first sync");

		const response = new Response(JSON.stringify({ data: [{ id: "cursor-live", name: "Cursor Live" }] }), {
			status: 200,
		});
		const context = { allowNetwork: true, signal: new AbortController().signal } as RefreshModelsContext;
		const models = await refreshCursorModels(context, async () => response);

		assert.deepEqual(
			models.map((entry) => entry.id),
			["cursor-live"],
			"the live list is what the provider returns",
		);
		assert.notDeepEqual(
			models.map((entry) => entry.id),
			CURSOR_FALLBACK_MODELS.map((entry) => entry.id),
			"the live list replaces the bootstrap",
		);

		const stored = readStoredCursorModels(directory);
		assert.deepEqual(
			stored?.map((entry) => entry.id),
			["cursor-live"],
			"the catalog is stored for the next start",
		);
		assert.match(await readFile(storedCursorModelsPath(directory), "utf8"), /cursor-live/u);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.KPI_CODING_AGENT_DIR;
		} else {
			process.env.KPI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousHome !== undefined) process.env.HOME = previousHome;
		if (previousUserProfile !== undefined) process.env.USERPROFILE = previousUserProfile;
		await rm(directory, { recursive: true, force: true });
	}
});

test("an offline refresh with nothing stored falls back to the bounded list", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-cursor-offline-"));
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	try {
		process.env.KPI_CODING_AGENT_DIR = directory;
		process.env.HOME = directory;

		const context = { allowNetwork: false, signal: new AbortController().signal } as RefreshModelsContext;
		const models = await refreshCursorModels(context, async () => {
			throw new Error("the network must not be touched");
		});

		assert.deepEqual(
			models.map((entry) => entry.id),
			CURSOR_FALLBACK_MODELS.map((entry) => entry.id),
		);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.KPI_CODING_AGENT_DIR;
		} else {
			process.env.KPI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousHome !== undefined) process.env.HOME = previousHome;
		await rm(directory, { recursive: true, force: true });
	}
});

test("a malformed stored catalog is ignored instead of trusted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-cursor-bad-"));
	try {
		await writeFile(storedCursorModelsPath(directory), "{ not json");
		assert.equal(readStoredCursorModels(directory), undefined);

		await writeFile(storedCursorModelsPath(directory), "[]");
		assert.equal(readStoredCursorModels(directory), undefined, "an empty catalog is no catalog");

		await writeFile(storedCursorModelsPath(directory), JSON.stringify([{ name: "no id" }]));
		assert.equal(readStoredCursorModels(directory), undefined, "an entry without an id is unusable");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the global response classifier never reads a body", async () => {
	const source = await readFile(
		new URL("../packages/coding-agent/src/kpi/extensions/accounts/index.ts", import.meta.url),
		"utf8",
	);
	const hook = source.slice(source.indexOf('pi.on("after_provider_response"'));

	assert.match(hook, /classifyProviderFailure\(/u, "the hook classifies status and headers");
	assert.doesNotMatch(hook, /classifyProviderBodyFailure/u, "the global hook must not reach the body classifier");
	assert.doesNotMatch(hook.slice(0, hook.indexOf("session_start")), /\bbody\b/u, "no body is consumed in the hook");
});

test("an offline or empty refresh returns the stored catalog and never overwrites it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-cursor-keep-"));
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	try {
		process.env.KPI_CODING_AGENT_DIR = directory;
		process.env.HOME = directory;

		// A live sync stores a catalog.
		const live = new Response(JSON.stringify({ data: [{ id: "cursor-live", name: "Cursor Live" }] }), {
			status: 200,
		});
		await refreshCursorModels(
			{ allowNetwork: true, signal: new AbortController().signal } as RefreshModelsContext,
			async () => live,
		);
		const stored = await readFile(storedCursorModelsPath(directory), "utf8");
		assert.match(stored, /cursor-live/u);

		// Offline: the stored catalog is returned and left untouched.
		const offline = await refreshCursorModels(
			{ allowNetwork: false, signal: new AbortController().signal } as RefreshModelsContext,
			async () => {
				throw new Error("the network must not be touched");
			},
		);
		assert.deepEqual(
			offline.map((entry) => entry.id),
			["cursor-live"],
			"offline prefers the last known catalog over a bootstrap guess",
		);
		assert.equal(await readFile(storedCursorModelsPath(directory), "utf8"), stored, "offline wrote nothing");

		// An empty live answer is not a catalog and must not replace one.
		const empty = new Response(JSON.stringify({ data: [] }), { status: 200 });
		const afterEmpty = await refreshCursorModels(
			{ allowNetwork: true, signal: new AbortController().signal } as RefreshModelsContext,
			async () => empty,
		);
		assert.deepEqual(
			afterEmpty.map((entry) => entry.id),
			["cursor-live"],
			"an empty answer keeps what was known",
		);
		assert.equal(await readFile(storedCursorModelsPath(directory), "utf8"), stored, "an empty answer wrote nothing");
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.KPI_CODING_AGENT_DIR;
		} else {
			process.env.KPI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousHome !== undefined) process.env.HOME = previousHome;
		await rm(directory, { recursive: true, force: true });
	}
});

test("the stored catalog is rehydrated through current defaults, not trusted wholesale", async () => {
	const directory = await mkdtemp(join(tmpdir(), "k-pi-cursor-rehydrate-"));
	try {
		await writeFile(
			storedCursorModelsPath(directory),
			JSON.stringify([
				{
					id: "cursor-live",
					name: "Cursor Live",
					// Stale fields from an older release that must not survive.
					contextWindow: 1,
					maxTokens: 1,
					api: "anthropic-messages",
					cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
					reasoning: false,
				},
				{ name: "no id" },
			]),
		);

		const [rehydrated, ...rest] = readStoredCursorModels(directory) ?? [];

		assert.equal(rest.length, 0, "an entry without an id is dropped");
		assert.equal(rehydrated.id, "cursor-live");
		assert.equal(rehydrated.name, "Cursor Live", "the display name is kept");
		const [fresh] = CURSOR_FALLBACK_MODELS;
		assert.equal(rehydrated.api, fresh.api, "the api comes from this release");
		assert.equal(rehydrated.contextWindow, fresh.contextWindow);
		assert.equal(rehydrated.maxTokens, fresh.maxTokens);
		assert.deepEqual(rehydrated.cost, fresh.cost, "a cached cost never outlives its release");
		assert.equal(rehydrated.reasoning, fresh.reasoning);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the catalog cache creates its directory and is written atomically", async () => {
	const parent = await mkdtemp(join(tmpdir(), "k-pi-cursor-mkdir-"));
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const directory = join(parent, "missing", "agent");
	try {
		process.env.KPI_CODING_AGENT_DIR = directory;
		process.env.HOME = directory;

		const live = new Response(JSON.stringify({ data: [{ id: "cursor-live" }] }), { status: 200 });
		await refreshCursorModels(
			{ allowNetwork: true, signal: new AbortController().signal } as RefreshModelsContext,
			async () => live,
		);

		assert.match(await readFile(storedCursorModelsPath(directory), "utf8"), /cursor-live/u);
		assert.deepEqual(
			(await readdir(directory)).filter((name) => name.includes(".tmp")),
			[],
			"no temporary file is left behind",
		);
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.KPI_CODING_AGENT_DIR;
		} else {
			process.env.KPI_CODING_AGENT_DIR = previousAgentDir;
		}
		if (previousHome !== undefined) process.env.HOME = previousHome;
		await rm(parent, { recursive: true, force: true });
	}
});
