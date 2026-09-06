import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { summarizeRefreshFailure } from "../packages/coding-agent/src/kpi/extensions/accounts/errors.ts";
import { createCursorOAuth } from "../packages/coding-agent/src/kpi/extensions/cursor/oauth.ts";

const NOW = Date.UTC(2026, 8, 6);
const EXPIRY = NOW + 3_600_000;
const REFRESH = "fixture-secret-refresh";
const jwt = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
const ACCESS = jwt({ exp: EXPIRY / 1000 });
const previous: OAuthCredentials = { access: ACCESS, refresh: REFRESH, expires: NOW - 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const callbackDefaults: OAuthLoginCallbacks = {
	onAuth() {},
	onDeviceCode() {},
	onPrompt: async () => {
		throw new Error("Cursor must not request a pasted credential");
	},
	onSelect: async () => {
		throw new Error("Cursor must not select an alternate flow");
	},
};

function fixture(fetch: typeof globalThis.fetch) {
	return createCursorOAuth({ fetch, now: () => NOW, sleep: async () => {} });
}

async function rejection(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		assert.ok(error instanceof Error);
		return error;
	}
	assert.fail("Expected authentication to reject");
}

test("Cursor pending polling binds fresh browser PKCE to the grant without publishing the verifier", async () => {
	const links: URL[] = [];
	const verifiers: string[] = [];
	let pending = true;
	const oauth = fixture(async (input, init) => {
		const poll = new URL(String(input));
		const browser = links.at(-1)!;
		assert.equal(poll.origin + poll.pathname, "https://api2.cursor.sh/auth/poll");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal(poll.searchParams.get("uuid"), browser.searchParams.get("uuid"));
		const verifier = poll.searchParams.get("verifier")!;
		assert.match(verifier, /^[A-Za-z0-9_-]{128}$/u);
		assert.equal(createHash("sha256").update(verifier).digest("base64url"), browser.searchParams.get("challenge"));
		assert.equal(browser.searchParams.has("verifier"), false);
		assert.equal(browser.toString().includes(verifier), false);
		if (pending) {
			pending = false;
			return new Response(null, { status: 404 });
		}
		verifiers.push(verifier);
		return json({ accessToken: ACCESS, refreshToken: REFRESH });
	});
	for (let flow = 0; flow < 2; flow++) {
		pending = true;
		const grant = await oauth.login({ ...callbackDefaults, onAuth: ({ url }) => links.push(new URL(url)) });
		assert.deepEqual(grant, { access: ACCESS, refresh: REFRESH, expires: EXPIRY });
	}
	for (const link of links) {
		assert.equal(link.origin + link.pathname, "https://cursor.com/loginDeepControl");
		assert.equal(link.searchParams.get("mode"), "login");
		assert.equal(link.searchParams.get("redirectTarget"), "cli");
		assert.match(
			link.searchParams.get("uuid")!,
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
		);
	}
	assert.notEqual(links[0].searchParams.get("uuid"), links[1].searchParams.get("uuid"));
	assert.notEqual(verifiers[0], verifiers[1]);
});

test("Cursor cancellation before browser launch never exposes a link or calls transport", async () => {
	const controller = new AbortController();
	controller.abort(new Error(REFRESH));
	const oauth = fixture(async () => assert.fail("No request after cancellation"));
	const error = await rejection(
		oauth.login({
			...callbackDefaults,
			signal: controller.signal,
			onAuth: () => assert.fail("No browser after cancellation"),
		}),
	);
	assert.equal(error.name, "AbortError");
	assert.equal(error.message.includes(REFRESH), false);
});

test("Cursor cancellation interrupts the native pending-poll timer", async () => {
	const controller = new AbortController();
	const oauth = createCursorOAuth({ fetch: async () => assert.fail("No request after cancelled wait") });
	const operation = oauth.login({ ...callbackDefaults, signal: controller.signal });
	controller.abort(new Error(REFRESH));
	const error = await rejection(operation);
	assert.equal(error.name, "AbortError");
	assert.equal(error.message.includes(REFRESH), false);
});

test("Cursor cancellation aborts an in-flight request and redacts the transport error", async () => {
	const controller = new AbortController();
	const oauth = fixture(async (input, init) => {
		assert.ok(init?.signal);
		const result = new Promise<Response>((_resolve, reject) => {
			init.signal!.addEventListener("abort", () => reject(new Error(`${input} ${REFRESH}`)), { once: true });
		});
		controller.abort(new Error(REFRESH));
		return result;
	});
	const error = await rejection(oauth.login({ ...callbackDefaults, signal: controller.signal }));
	assert.equal(error.name, "AbortError");
	assert.equal(error.message.includes(REFRESH), false);
	assert.equal(error.message.includes("verifier="), false);
});

test("Cursor refresh rotates only a returned refresh token and preserves only an omitted rotation", async () => {
	for (const rotated of ["fixture-rotated-refresh", undefined]) {
		const oauth = fixture(async (input, init) => {
			assert.equal(String(input), "https://api2.cursor.sh/auth/exchange_user_api_key");
			assert.equal(init?.method, "POST");
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${REFRESH}`);
			assert.equal(init?.body, "{}");
			assert.equal(String(input).includes(REFRESH), false);
			return json({ accessToken: ACCESS, ...(rotated === undefined ? {} : { refreshToken: rotated }) });
		});
		assert.deepEqual(await oauth.refreshToken(previous, new AbortController().signal), {
			access: ACCESS,
			refresh: rotated ?? REFRESH,
			expires: EXPIRY,
		});
	}
});

test("Cursor rejects incomplete token pairs, malformed JWTs and missing, expired or nonnumeric expiry", async () => {
	const malformed = [
		{ accessToken: ACCESS },
		{ accessToken: "", refreshToken: REFRESH },
		{ accessToken: ACCESS, refreshToken: " " },
		{ accessToken: "fixture-secret-malformed-token", refreshToken: REFRESH },
		...[{}, { exp: "1800000000" }, { exp: NOW / 1000 }, { exp: 1e100 }].map((payload) => ({
			accessToken: jwt(payload),
			refreshToken: REFRESH,
		})),
	];
	for (const body of malformed) {
		const error = await rejection(fixture(async () => json(body)).login(callbackDefaults));
		assert.match(error.message, /token|expiry/u);
		assert.equal(error.message.includes(REFRESH), false);
		if (body.accessToken) assert.equal(error.message.includes(body.accessToken), false);
	}
	for (const refreshToken of [null, "", " "]) {
		const oauth = fixture(async () => json({ accessToken: ACCESS, refreshToken }));
		const error = await rejection(oauth.refreshToken(previous, new AbortController().signal));
		assert.match(error.message, /malformed refresh token/u);
	}
	const missing = fixture(async () => assert.fail("An access token must never substitute for refresh"));
	const error = await rejection(missing.refreshToken({ ...previous, refresh: "" }, new AbortController().signal));
	assert.deepEqual(summarizeRefreshFailure(error), { kind: "invalid_grant" });
});

test("Cursor classifies rejected grants separately from transient HTTP failures without echoing bodies", async () => {
	for (const [status, body, kind] of [
		[401, { message: REFRESH }, "invalid_grant"],
		[400, { error: "invalid_grant", error_description: REFRESH }, "invalid_grant"],
		[400, { error: { code: "invalid_grant", message: ACCESS } }, "invalid_grant"],
		[403, { error: REFRESH }, "http"],
		[429, { error: REFRESH }, "http"],
		[503, { error: ACCESS }, "http"],
	] as const) {
		const oauth = fixture(async () => json(body, status));
		const error = await rejection(oauth.refreshToken(previous, new AbortController().signal));
		const classification = summarizeRefreshFailure(error);
		assert.equal(classification.kind, kind);
		if (classification.kind === "http") assert.equal(classification.status, status);
		assert.equal(error.message.includes(REFRESH), false);
		assert.equal(error.message.includes(ACCESS), false);
		assert.equal(error.cause, undefined);
	}
	for (const status of [401, 502]) {
		const oauth = fixture(async () => new Response(`<html>${REFRESH}</html>`, { status }));
		const error = await rejection(oauth.refreshToken(previous, new AbortController().signal));
		assert.equal(summarizeRefreshFailure(error).kind, status === 401 ? "invalid_grant" : "http");
		assert.equal(error.message.includes(REFRESH), false);
	}
});

test("Cursor never includes poll verifier URLs or raw network exceptions in errors", async () => {
	const oauth = fixture(async (input) => {
		throw new Error(`Request ${input} leaked ${REFRESH}`);
	});
	const error = await rejection(oauth.login(callbackDefaults));
	assert.equal(summarizeRefreshFailure(error).kind, "transport");
	assert.equal(error.message.includes("verifier="), false);
	assert.equal(error.message.includes(REFRESH), false);
	assert.equal(error.cause, undefined);
});

test("Cursor login deadline interrupts polling with a timeout rather than an invented grant", async () => {
	const oauth = createCursorOAuth({
		loginTimeoutMs: 0,
		fetch: async () => assert.fail("Timed-out login must not poll"),
	});
	const error = await rejection(oauth.login(callbackDefaults));
	assert.equal(error.name, "TimeoutError");
});
