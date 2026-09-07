import { randomUUID } from "node:crypto";
import type { ClientHttp2Stream } from "node:http2";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "../../../core/extensions/types.ts";
import type { CursorModelConfig } from "./discovery.ts";
import { buildCursorHistory, type CursorRunRequest, encodeCursorRun } from "./history.ts";
import { CURSOR_BASE_URL, cursorHttp } from "./http2.ts";
import {
	bytes,
	ConnectFrames,
	decode,
	type Field,
	frame,
	message,
	number,
	parseJsonValue,
	repeated,
	text,
	type WireMessage,
} from "./protocol.ts";

function execReply(request: ClientHttp2Stream, exec: WireMessage, field: number, result: Uint8Array): void {
	request.write(frame(message([2, message([1, number(exec, 1)], [15, text(exec, 15)], [field, result])])));
}

function rejectExec(request: ClientHttp2Stream, exec: WireMessage, reason: string): void {
	const id = number(exec, 1);
	request.write(frame(message([5, message([2, message([1, id], [2, reason], [4, "KPI_NATIVE_TOOLS_ONLY"])])])));
	request.write(frame(message([5, message([1, message([1, id])])])));
}

/** Translate requests, not executions. The native agent loop owns validation and permission. */
function nativeTool(exec: WireMessage, field: number, context: Context): ToolCall | undefined {
	const args = decode(bytes(exec, field));
	let name: string;
	let id = "";
	let input: Record<string, unknown>;
	if (field === 11) {
		const provider = text(args, 4);
		if (provider && provider !== "kpi-agent")
			throw new Error(`Cursor requested an unadvertised MCP provider: ${provider}`);
		name = text(args, 5) || text(args, 1);
		id = text(args, 3);
		input = Object.fromEntries(
			repeated(args, 2).map((entry) => {
				const pair = decode(entry);
				return [text(pair, 1), parseJsonValue(bytes(pair, 2))];
			}),
		);
	} else if (field === 7 || field === 45) {
		name = "read";
		id = field === 7 ? text(args, 2) : "";
		const offset = field === 7 ? 4 : 2;
		const limit = field === 7 ? 5 : 3;
		input = {
			path: text(args, 1),
			...(args.has(offset) ? { offset: number(args, offset) } : {}),
			...(args.has(limit) ? { limit: number(args, limit) } : {}),
		};
	} else if (field === 3 || field === 48) {
		if (field === 3 && args.has(5))
			throw new Error("Cursor binary writes are unsupported; use the advertised native write tool");
		name = "write";
		id = field === 3 ? text(args, 3) : "";
		input = { path: text(args, 1), content: text(args, 2) };
	} else if (field === 2 || field === 14 || field === 46 || field === 52) {
		name = "bash";
		id = field === 46 ? "" : text(args, 4);
		if (field !== 46 && number(args, 11))
			throw new Error("Cursor background shells are disabled; use native K-π tools");
		const cwd = field === 46 ? "" : text(args, 2);
		const command = text(args, 1);
		input = { command: cwd ? `cd -- '${cwd.replace(/'/gu, "'\\''")}' && ${command}` : command };
		if (field !== 46 && number(args, 3) > 0) input.timeout = number(args, 3);
		if (field === 46 && args.has(2)) {
			const raw = bytes(args, 2);
			if (raw.length !== 8) throw new Error("Invalid Cursor bash timeout");
			const timeout = new DataView(raw.buffer, raw.byteOffset, raw.length).getFloat64(0, true);
			if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid Cursor bash timeout");
			if (timeout > 0) input.timeout = timeout;
		}
	} else if (field === 47) {
		name = "edit";
		input = {
			path: text(args, 1),
			edits: repeated(args, 2).map((entry) => {
				const pair = decode(entry);
				return { oldText: text(pair, 1), newText: text(pair, 2) };
			}),
		};
	} else if (field === 5) {
		const outputMode = text(args, 4);
		if ((outputMode && outputMode !== "content") || [5, 6, 9, 11, 12, 13, 16].some((key) => args.has(key))) {
			throw new Error(
				"Cursor requested grep options not supported by the native grep schema; use the advertised MCP tool",
			);
		}
		name = "grep";
		id = text(args, 14);
		input = {
			pattern: text(args, 1),
			...(args.has(2) ? { path: text(args, 2) } : {}),
			...(args.has(3) ? { glob: text(args, 3) } : {}),
			...(args.has(7) ? { context: number(args, 7) } : {}),
			...(args.has(8) ? { ignoreCase: number(args, 8) !== 0 } : {}),
			...(args.has(10) ? { limit: number(args, 10) } : {}),
		};
	} else if (field === 49) {
		name = "grep";
		input = {
			pattern: text(args, 1),
			...(args.has(2) ? { path: text(args, 2) } : {}),
			...(args.has(3) ? { glob: text(args, 3) } : {}),
			...(args.has(4) ? { ignoreCase: number(args, 4) !== 0 } : {}),
			...(args.has(5) ? { literal: number(args, 5) !== 0 } : {}),
			...(args.has(6) ? { context: number(args, 6) } : {}),
			...(args.has(7) ? { limit: number(args, 7) } : {}),
		};
	} else if (field === 50) {
		name = "find";
		input = {
			pattern: text(args, 1),
			...(args.has(2) ? { path: text(args, 2) } : {}),
			...(args.has(3) ? { limit: number(args, 3) } : {}),
		};
	} else if (field === 51 || field === 8) {
		if (field === 8 && repeated(args, 2).length)
			throw new Error("Cursor listing ignore filters are unsupported; use the native ls tool");
		name = "ls";
		id = field === 8 ? text(args, 3) : "";
		input = { path: text(args, 1), ...(field === 51 && args.has(2) ? { limit: number(args, 2) } : {}) };
	} else if (field === 4) {
		name = "delete";
		id = text(args, 2);
		input = { path: text(args, 1) };
	} else {
		return undefined;
	}
	if (!context.tools?.some((tool) => tool.name === name))
		throw new Error(`Cursor requested unavailable native tool: ${name}`);
	return { type: "toolCall", id: id || randomUUID(), name, arguments: input };
}

export const streamCursor: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "kpi-cursor",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	let openIndex: number | undefined;
	const endBlock = () => {
		if (openIndex === undefined) return;
		const part = output.content[openIndex];
		if (part.type === "text")
			stream.push({ type: "text_end", contentIndex: openIndex, content: part.text, partial: output });
		if (part.type === "thinking")
			stream.push({ type: "thinking_end", contentIndex: openIndex, content: part.thinking, partial: output });
		openIndex = undefined;
	};
	void (async () => {
		try {
			options?.signal?.throwIfAborted();
			if (options?.fetch) throw new Error("Cursor requires Node HTTP/2; custom fetch is unsupported");
			const history = buildCursorHistory(context, model.id);
			const details = (model as typeof model & CursorModelConfig).cursorModelDetails;
			const maxMode = details?.maxMode === true;
			// Pinned CLI wire convention: OpenAI effort siblings are catalog IDs,
			// not Run model IDs. This is serialization, never capability inference.
			const effort = /^(gpt-.+|o[134](?:-.+)?)-(minimal|low|medium|high|xhigh|max)(-fast)?$/u.exec(model.id);
			const wireModelId = effort ? `${effort[1]}${effort[3] ?? ""}` : model.id;
			const parameters = [...(details?.parameters ?? [])];
			if (effort && !parameters.some((parameter) => parameter.id === "reasoning")) {
				parameters.push({ id: "reasoning", value: effort[2] });
			}
			let payload: CursorRunRequest = {
				conversationState: history.conversationState,
				action: history.action,
				conversationId: randomUUID(),
				modelDetails: { modelId: wireModelId, displayModelId: model.id, displayName: model.name, maxMode },
				requestedModel: { modelId: wireModelId, maxMode, parameters },
			};
			const replacement = await options?.onPayload?.(payload, model);
			if (replacement !== undefined) payload = replacement as CursorRunRequest;
			const body = encodeCursorRun(payload);
			let sawTurnEnded = false;
			let sawTool = false;
			let pendingToolAnnouncement = false;
			await cursorHttp(
				{
					baseUrl: model.baseUrl || CURSOR_BASE_URL,
					path: "/agent.v1.AgentService/Run",
					apiKey: options?.apiKey ?? "",
					signal: options?.signal,
					timeoutMs: options?.timeoutMs ?? 600_000,
					streaming: true,
					headers: options?.headers,
					onResponse: (response) => options?.onResponse?.(response, model),
				},
				async (request, response) => {
					const parser = new ConnectFrames();
					request.write(frame(body));
					await response;
					stream.push({ type: "start", partial: output });
					const heartbeat = setInterval(() => {
						if (!request.destroyed && !request.closed && !request.writableEnded)
							request.write(frame(message([7, message()])));
					}, 5_000);
					try {
						// cursorHttp owns closure; iterator teardown must not race a tool handoff
						// or replace a decoded protocol error with a locally generated abort.
						for await (const chunk of request.iterator({ destroyOnReturn: false })) {
							for (const envelope of parser.push(chunk)) {
								if (envelope.end) continue;
								const server = decode(envelope.payload);
								if (server.has(4)) {
									const kv = decode(bytes(server, 4));
									const id = number(kv, 1);
									if (kv.has(2)) {
										const key = Buffer.from(bytes(decode(bytes(kv, 2)), 1)).toString("hex");
										const data = history.blobs.get(key);
										request.write(frame(message([3, message([1, id], [2, message([1, data])])])));
									} else if (kv.has(3)) {
										const blob = decode(bytes(kv, 3));
										history.blobs.set(Buffer.from(bytes(blob, 1)).toString("hex"), bytes(blob, 2));
										request.write(frame(message([3, message([1, id], [3, message()])])));
									} else throw new Error("Unsupported Cursor KV request");
								} else if (server.has(2)) {
									const exec = decode(bytes(server, 2));
									const fields = [...exec.keys()].filter((key) => ![1, 15, 19, 55].includes(key));
									if (fields.length !== 1) throw new Error("Malformed Cursor exec request");
									const field = fields[0];
									if (field === 10) {
										execReply(request, exec, 10, message([1, message([1, history.requestContext])]));
										continue;
									}
									if ([41, 42, 43].includes(field)) {
										execReply(request, exec, field, message([1, false])); // No native permission is pre-approved.
										continue;
									}
									if (field === 36) {
										const definitions = repeated(decode(history.requestContext), 7);
										execReply(
											request,
											exec,
											field,
											message([
												1,
												message([
													1,
													message(
														[1, "K-π native tools"],
														[2, "kpi-agent"],
														[7, "connected"],
														...definitions.map((tool): Field => [5, tool]),
													),
												]),
											]),
										);
										continue;
									}
									if ([16, 28, 30, 31, 37].includes(field))
										throw new Error(
											"Cursor cloud, background execution and subagents are disabled; K-π owns execution",
										);
									if (field === 11 && number(decode(bytes(exec, field)), 7)) {
										execReply(
											request,
											exec,
											11,
											message([
												3,
												message([1, "Permission is owned by K-π; request the native tool for approval."]),
											]),
										);
										continue;
									}
									const tool = nativeTool(exec, field, context);
									if (!tool) {
										rejectExec(
											request,
											exec,
											`Cursor exec field ${field} is unavailable. Use the advertised K-π native MCP tools.`,
										);
										continue;
									}
									endBlock();
									const index = output.content.length;
									output.content.push(tool);
									stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
									stream.push({
										type: "toolcall_delta",
										contentIndex: index,
										delta: JSON.stringify(tool.arguments),
										partial: output,
									});
									stream.push({ type: "toolcall_end", contentIndex: index, toolCall: tool, partial: output });
									sawTool = true;
									// No success is sent to Cursor. Close now; the next native turn's
									// resumeAction contains the actual tool result from Context.
									return;
								} else if (server.has(1)) {
									const update = decode(bytes(server, 1));
									if (update.has(1) || update.has(4)) {
										const thinking = update.has(4);
										const delta = text(decode(bytes(update, thinking ? 4 : 1)), 1);
										const kind = thinking ? "thinking" : "text";
										if (openIndex === undefined || output.content[openIndex].type !== kind) {
											endBlock();
											openIndex = output.content.length;
											output.content.push(
												thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
											);
											stream.push({
												type: thinking ? "thinking_start" : "text_start",
												contentIndex: openIndex,
												partial: output,
											});
										}
										const part = output.content[openIndex];
										if (part.type === "thinking") part.thinking += delta;
										if (part.type === "text") part.text += delta;
										stream.push({
											type: thinking ? "thinking_delta" : "text_delta",
											contentIndex: openIndex,
											delta,
											partial: output,
										});
									} else if (update.has(5)) endBlock();
									else if (update.has(8)) {
										output.usage.output += number(decode(bytes(update, 8)), 1);
										output.usage.totalTokens = output.usage.output;
									} else if (update.has(14)) {
										sawTurnEnded = true;
										request.end();
									} else if (update.has(2) || update.has(3)) {
										const call = decode(bytes(decode(bytes(update, update.has(2) ? 2 : 3)), 2));
										const toolKinds = [...call.keys()].filter((key) => ![54, 57, 59, 60].includes(key));
										if (toolKinds.length !== 1) throw new Error("Malformed Cursor tool announcement");
										pendingToolAnnouncement = true;
										if (
											toolKinds.some(
												(key) => ![1, 3, 4, 5, 8, 12, 13, 14, 15, 61, 62, 63, 64, 65, 66, 67].includes(key),
											)
										)
											throw new Error(
												"Cursor attempted a hosted tool; only native K-π execution is allowed",
											);
										if (update.has(3))
											throw new Error("Cursor reported a tool completion without a genuine native result");
									} else if (update.has(7) || update.has(15)) pendingToolAnnouncement = true;
									else if (![6, 9, 10, 11, 13, 16, 17].some((key) => update.has(key)))
										throw new Error("Unsupported Cursor interaction update");
								} else if (server.has(7))
									throw new Error("Cursor hosted interaction is disabled; use native K-π tools");
								else if (server.has(5)) throw new Error("Cursor server aborted native execution");
								else if (server.has(3))
									decode(bytes(server, 3)); // Validate checkpoint wire; native transcript owns replay.
								else throw new Error("Unsupported Cursor server message");
							}
						}
						parser.finish();
						if (!sawTurnEnded) throw new Error("Cursor stream ended before turnEnded");
						if (pendingToolAnnouncement) throw new Error("Cursor announced a tool without a native exec request");
					} finally {
						clearInterval(heartbeat);
					}
				},
			);
			endBlock();
			output.stopReason = sawTool ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			endBlock();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end(output);
		}
	})();
	return stream;
};
