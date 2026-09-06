import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "../../../core/extensions/types.ts";
import { CURSOR_BASE_URL, cursorHttp } from "./http2.ts";
import { bytes, ConnectFrames, decode, number, repeated, text } from "./protocol.ts";

export interface CursorModelConfig extends ProviderModelConfig {
	cursorModelDetails?: {
		maxMode?: boolean;
		/** Only explicit operator/protocol parameters; never derived from a model slug. */
		parameters?: { id: string; value: string }[];
	};
}

export interface CursorDiscoveryOptions {
	/** Explicit endpoint override, useful for operator-owned gateways and loopback fixtures. */
	baseUrl?: string;
	timeoutMs?: number;
}

/** GetUsableModels has no price/capacity/image fields; zeros mean unknown, not free. */
export async function refreshCursorModels(
	context: RefreshModelsContext,
	options: CursorDiscoveryOptions = {},
): Promise<ProviderModelConfig[]> {
	context.signal.throwIfAborted();
	const cached = (context.stored?.models ?? []).filter(
		(model) => model.provider === "cursor" && model.api === "kpi-cursor",
	);
	if (!context.allowNetwork) return [...cached];
	const credential = context.credential;
	const apiKey = credential?.type === "oauth" ? credential.access : credential?.key;
	if (!apiKey) throw new Error("Cursor discovery requires a native configured credential");
	const baseUrl = options.baseUrl ?? CURSOR_BASE_URL;
	let payload: Uint8Array = new Uint8Array();
	let framed = false;
	await cursorHttp(
		{
			baseUrl,
			path: "/agent.v1.AgentService/GetUsableModels",
			apiKey,
			signal: context.signal,
			timeoutMs: options.timeoutMs ?? 5_000,
			streaming: false,
			onResponse: ({ headers }) => {
				framed = headers["content-type"]?.includes("connect+") ?? false;
			},
		},
		async (request, response) => {
			request.end(); // Empty GetUsableModelsRequest: no fabricated custom IDs.
			await response;
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request.iterator({ destroyOnReturn: false })) {
				size += chunk.length;
				if (size > 16 * 1024 * 1024) throw new Error("Cursor model response exceeds 16 MiB");
				chunks.push(chunk);
			}
			payload = Buffer.concat(chunks);
		},
	);
	if (framed || (payload.length >= 5 && (payload[0] === 0 || payload[0] === 2))) {
		const parser = new ConnectFrames();
		const messages = parser.push(payload).filter((entry) => !entry.end);
		parser.finish();
		if (messages.length !== 1) throw new Error("Cursor discovery expected one protobuf response");
		payload = messages[0].payload;
	}
	const catalog = new Map<string, Model<Api> & CursorModelConfig>();
	for (const entry of repeated(decode(payload), 1)) {
		const details = decode(entry);
		const id = text(details, 1);
		if (!id) throw new Error("Cursor discovery returned a model without an ID");
		// Validate the nested message even though ThinkingDetails has no declared fields.
		if (details.has(2)) decode(bytes(details, 2));
		catalog.set(id, {
			id,
			name: text(details, 4) || text(details, 5) || id,
			provider: "cursor",
			api: "kpi-cursor",
			baseUrl,
			reasoning: details.has(2),
			input: ["text"],
			contextWindow: 0,
			maxTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			cursorModelDetails: { maxMode: number(details, 7) !== 0 },
		});
	}
	const models = [...catalog.values()];
	context.signal.throwIfAborted();
	if (!(await context.publish({ persist: { models, checkedAt: Date.now() } }))) {
		throw new Error("Cursor catalog refresh was superseded before publication");
	}
	return models;
}
