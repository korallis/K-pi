import { randomUUID } from "node:crypto";
import { type ClientHttp2Stream, connect, constants, type IncomingHttpHeaders } from "node:http2";
import type { ProviderHeaders, ProviderResponse } from "@earendil-works/pi-ai";

export const CURSOR_BASE_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";
const RESERVED: Record<string, true> = Object.fromEntries(
	[
		"connection",
		"keep-alive",
		"proxy-connection",
		"transfer-encoding",
		"upgrade",
		"http2-settings",
		"host",
		"content-length",
		"content-type",
		"connect-protocol-version",
		"te",
		"authorization",
		"x-ghost-mode",
		"x-cursor-client-version",
		"x-cursor-client-type",
		"x-request-id",
	].map((name) => [name, true]),
);

export interface CursorHttpOptions {
	baseUrl: string;
	path: string;
	apiKey: string;
	signal?: AbortSignal;
	timeoutMs: number;
	headers?: ProviderHeaders;
	streaming: boolean;
	onResponse?: (response: ProviderResponse) => void | Promise<void>;
}

/** Owns one HTTP/2 session, never pools credentials or leaves a suspended tool connection. */
export async function cursorHttp(
	options: CursorHttpOptions,
	run: (request: ClientHttp2Stream, response: Promise<void>) => Promise<void>,
): Promise<void> {
	options.signal?.throwIfAborted();
	const url = new URL(options.baseUrl);
	if (url.username || url.password || !["http:", "https:"].includes(url.protocol))
		throw new Error("Invalid Cursor origin");
	if (!options.apiKey) throw new Error("Cursor access token is required");
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
		throw new Error("Cursor timeout must be positive");
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(options.headers ?? {})) {
		const lower = key.toLowerCase();
		if (
			value !== null &&
			value !== undefined &&
			!lower.startsWith(":") &&
			!lower.startsWith("x-kpi-cursor-") &&
			!RESERVED[lower]
		)
			headers[lower] = value;
	}
	const session = connect(url.origin);
	let request: ClientHttp2Stream | undefined;
	let rejectFailure!: (error: unknown) => void;
	const failure = new Promise<never>((_resolve, reject) => {
		rejectFailure = reject;
	});
	const abort = () => rejectFailure(options.signal?.reason ?? new Error("Cursor request aborted"));
	const timer = setTimeout(
		() => rejectFailure(new Error(`Cursor request timed out after ${options.timeoutMs}ms`)),
		options.timeoutMs,
	);
	options.signal?.addEventListener("abort", abort, { once: true });
	session.on("error", rejectFailure);
	try {
		request = session.request({
			...headers,
			":method": "POST",
			":path": `${url.pathname.replace(/\/$/u, "")}${options.path}`,
			"content-type": options.streaming ? "application/connect+proto" : "application/proto",
			"connect-protocol-version": "1",
			te: "trailers",
			authorization: `Bearer ${options.apiKey}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": CURSOR_CLIENT_VERSION,
			"x-cursor-client-type": "cli",
			"x-request-id": randomUUID(),
		});
		request.on("error", rejectFailure);
		request.on("aborted", () => rejectFailure(new Error("Cursor HTTP/2 stream aborted")));
		const inspectTrailers = (trailers: IncomingHttpHeaders) => {
			if (trailers["grpc-status"] && trailers["grpc-status"] !== "0") {
				rejectFailure(
					new Error(`Cursor gRPC ${trailers["grpc-status"]}: ${trailers["grpc-message"] ?? "request failed"}`),
				);
			}
		};
		request.on("trailers", inspectTrailers);
		const response = new Promise<void>((resolve, reject) => {
			request!.once("response", (received) => {
				request!.pause();
				const status = Number(received[":status"] ?? 0);
				const responseHeaders = Object.fromEntries(
					Object.entries(received)
						.filter(([key, value]) => !key.startsWith(":") && value !== undefined)
						.map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]),
				);
				Promise.resolve()
					.then(() => options.onResponse?.({ status, headers: responseHeaders }))
					.then(() => {
						inspectTrailers(received);
						if (status < 200 || status >= 300) reject(new Error(`Cursor HTTP ${status}`));
						else resolve();
					}, reject);
			});
		});
		// Start writing before response headers arrive, but do not consume response data
		// until the native response hook has completed (including asynchronous hooks).
		const activeRequest = request;
		await Promise.race([failure, run(activeRequest, response)]);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		request?.close(constants.NGHTTP2_CANCEL);
		session.destroy();
	}
}
