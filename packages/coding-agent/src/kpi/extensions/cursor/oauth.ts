import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "../../../core/extensions/types.ts";

const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_URL = "https://api2.cursor.sh/auth/poll";
const REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const MAX_POLL_ATTEMPTS = 150;

type CursorOAuth = NonNullable<ProviderConfig["oauth"]>;

/** Explicit dependencies for deterministic protocol tests; production endpoints are not configurable. */
export interface CursorOAuthOptions {
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	loginTimeoutMs?: number;
	requestTimeoutMs?: number;
}

class CursorAuthError extends Error {}

function checkAbort(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
	throw new DOMException(
		timeout ? "Cursor authentication timed out; retry login or renewal." : "Cursor authentication cancelled.",
		timeout ? "TimeoutError" : "AbortError",
	);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function token(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !/\s/u.test(value);
}

function credentials(value: unknown, now: number, previousRefresh?: string): OAuthCredentials {
	if (!record(value) || !token(value.accessToken)) {
		throw new CursorAuthError("Cursor returned a malformed access token; sign in again.");
	}
	// Only an omitted rotation may retain the existing refresh grant. Empty/null grants are malformed.
	const refresh = value.refreshToken === undefined ? previousRefresh : value.refreshToken;
	if (!token(refresh)) {
		throw new CursorAuthError("Cursor returned a missing or malformed refresh token; sign in again.");
	}
	let expires: number | undefined;
	try {
		const parts = value.accessToken.split(".");
		if (parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))) {
			const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
			if (record(payload) && typeof payload.exp === "number") expires = payload.exp * 1000;
		}
	} catch {
		// A malformed JWT is not evidence for a guessed token lifetime.
	}
	if (expires === undefined || !Number.isSafeInteger(expires) || expires <= now) {
		throw new CursorAuthError(
			"Cursor access token has no valid future JWT expiry; sign in again. If this persists, the Cursor CLI authentication protocol needs updating.",
		);
	}
	return { access: value.accessToken, refresh, expires };
}

/** First-party adaptation of OMP 18.1.11's pinned Cursor CLI browser PKCE protocol. */
export function createCursorOAuth(options: CursorOAuthOptions = {}): CursorOAuth {
	const fetch = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const pause = options.sleep ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal }));
	const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	const loginTimeoutMs = options.loginTimeoutMs ?? 20 * 60_000;

	async function request(
		url: URL | string,
		init: RequestInit,
		parent: AbortSignal,
		polling = false,
	): Promise<unknown> {
		const signal = AbortSignal.any([parent, AbortSignal.timeout(requestTimeoutMs)]);
		checkAbort(signal);
		try {
			// Redirects must not forward the poll verifier or renewal credential elsewhere.
			const response = await fetch(url, { ...init, signal, redirect: "error" });
			checkAbort(signal);
			if (polling && response.status === 404) {
				await response.body?.cancel();
				return undefined;
			}
			let data: unknown;
			try {
				data = await response.json();
			} catch {
				checkAbort(signal);
				// Preserve HTTP classification even if its error body is not JSON.
			}
			checkAbort(signal);
			const invalidGrant =
				record(data) &&
				(data.error === "invalid_grant" || (record(data.error) && data.error.code === "invalid_grant"));
			if (response.status === 401 || invalidGrant) {
				throw new CursorAuthError(`Cursor authentication invalid_grant status=${response.status}; sign in again.`);
			}
			if (!response.ok) throw new CursorAuthError(`Cursor authentication failed status=${response.status}.`);
			if (!record(data))
				throw new CursorAuthError("Cursor authentication returned malformed JSON; retry authentication.");
			return data;
		} catch (error) {
			checkAbort(signal);
			if (error instanceof CursorAuthError) throw error;
			// Fetch and JSON errors may contain request URLs, bearer tokens or response text.
			// Never attach the original error as a cause or interpolate provider response bodies.
			throw new CursorAuthError("Cursor authentication network failure; check connectivity and retry.");
		}
	}

	return {
		name: "Cursor",
		isSubscription: true,
		async login(callbacks) {
			const signal = AbortSignal.any([
				...(callbacks.signal ? [callbacks.signal] : []),
				AbortSignal.timeout(loginTimeoutMs),
			]);
			checkAbort(signal);
			const verifier = randomBytes(96).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const uuid = randomUUID();
			const loginUrl = new URL(LOGIN_URL);
			loginUrl.search = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" }).toString();
			callbacks.onAuth({ url: loginUrl.toString() });
			callbacks.onProgress?.("Waiting for Cursor browser authentication...");
			const pollUrl = new URL(POLL_URL);
			pollUrl.search = new URLSearchParams({ uuid, verifier }).toString();
			let delay = 1000;
			for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
				checkAbort(signal);
				try {
					await pause(delay, signal);
				} catch {
					checkAbort(signal);
					throw new CursorAuthError("Cursor authentication polling interrupted; retry login.");
				}
				checkAbort(signal);
				const data = await request(pollUrl, { method: "GET" }, signal, true);
				checkAbort(signal);
				if (data !== undefined) return credentials(data, now());
				delay = Math.min(delay * 1.2, 10_000);
			}
			throw new DOMException("Cursor authentication polling timed out; retry login.", "TimeoutError");
		},
		async refreshToken(previous, signal) {
			checkAbort(signal);
			if (!token(previous.refresh)) {
				throw new CursorAuthError("Cursor authentication invalid_grant: missing refresh token; sign in again.");
			}
			const data = await request(
				REFRESH_URL,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${previous.refresh}`, "Content-Type": "application/json" },
					body: "{}",
				},
				signal,
			);
			checkAbort(signal);
			return credentials(data, now(), previous.refresh);
		},
		getApiKey: (grant) => grant.access,
	};
}

export const cursorOAuth: NonNullable<ProviderConfig["oauth"]> = createCursorOAuth();
