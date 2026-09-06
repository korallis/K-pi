// Conversation/blob and request-context construction adapted from the pinned
// OMP cursor.ts; state is deliberately reconstructed from the native transcript.
import { createHash, randomUUID } from "node:crypto";
import type { Context, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Field, jsonValue, message } from "./protocol.ts";

export interface CursorRunRequest {
	conversationState: { rootPromptMessagesJson: Uint8Array[]; turns: Uint8Array[] };
	action:
		| { userMessageAction: { userMessage: { text: string; messageId: string } } }
		| { resumeAction: Record<string, never> };
	modelDetails: { modelId: string; displayModelId: string; displayName: string; maxMode: boolean };
	requestedModel: { modelId: string; maxMode: boolean; parameters: { id: string; value: string }[] };
	conversationId: string;
	customSystemPrompt?: string;
}

/** Cursor tool IDs have a stricter alphabet; hash only incompatible native IDs to avoid collisions. */
function wireId(id: string): string {
	return /^[a-zA-Z0-9_-]+$/u.test(id) ? id : `kpi_${createHash("sha256").update(id).digest("hex")}`;
}

function resultText(result: ToolResultMessage): string {
	if (result.content.some((part) => part.type !== "text"))
		throw new Error("Cursor text-only provider cannot replay image tool results");
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function callStep(call: ToolCall, result: ToolResultMessage | undefined): Buffer {
	const args = message(
		[1, call.name],
		...Object.entries(call.arguments).map(([key, value]): Field => [2, message([1, key], [2, jsonValue(value)])]),
		[3, wireId(call.id)],
		[4, "kpi-agent"],
		[5, call.name],
	);
	const encodedResult = result
		? result.isError
			? message([2, message([1, resultText(result)])])
			: message([
					1,
					message(
						...result.content.map(
							(part): Field => [
								1,
								message([1, message([1, part.type === "text" ? part.text : resultText(result)])]),
							],
						),
					),
				])
		: undefined;
	return message([2, message([15, message([1, args], [2, encodedResult])], [57, wireId(call.id)])]);
}

export function buildCursorHistory(
	context: Context,
	targetModelId: string,
): {
	blobs: Map<string, Uint8Array>;
	conversationState: CursorRunRequest["conversationState"];
	action: CursorRunRequest["action"];
	requestContext: Uint8Array;
} {
	const blobs = new Map<string, Uint8Array>();
	const store = (data: Uint8Array) => {
		const id = createHash("sha256").update(data).digest();
		blobs.set(id.toString("hex"), data);
		return id;
	};
	const root: Uint8Array[] = [];
	const pushJson = (value: unknown) => {
		root.push(store(Buffer.from(JSON.stringify(value))));
	};
	const policy =
		"Only the tools advertised by K-π may be requested. K-π executes tools through its own permission hooks. Use these MCP tools rather than Cursor-hosted tools. Never spawn Cursor subagents, provision cloud agents or VMs, or execute hosted tools. A tool request is not approval; wait for the genuine native result.";
	const rules = [context.systemPrompt, policy].filter(
		(value): value is string => value !== undefined && value.length > 0,
	);
	for (const content of rules) pushJson({ role: "system", content });
	const requestContext = message(
		...rules.map(
			(content, index): Field => [
				2,
				message([1, `/kpi/system-prompt/${index}.mdc`], [2, content], [3, message([1, message()])], [4, 2]),
			],
		),
		...[...(context.tools ?? [])].map(
			(tool): Field => [
				7,
				message(
					[1, tool.name],
					[2, tool.description],
					[3, jsonValue(JSON.parse(JSON.stringify(tool.parameters)))],
					[4, "kpi-agent"],
					[5, tool.name],
					[6, JSON.stringify(tool.parameters)],
				),
			],
		),
		[17, false],
	);
	const last = context.messages.at(-1);
	const activeIndex = last?.role === "user" ? context.messages.length - 1 : -1;
	const results = new Map<string, ToolResultMessage>();
	const calls = new Map<string, ToolCall>();
	for (const entry of context.messages) {
		if (entry.role === "toolResult") results.set(entry.toolCallId, entry);
		if (entry.role === "assistant")
			for (const part of entry.content) if (part.type === "toolCall") calls.set(part.id, part);
	}
	for (const [id, result] of results) {
		if (!calls.has(id) || calls.get(id)!.name !== result.toolName)
			throw new Error(`Cursor history has an unpaired tool result: ${id}`);
	}
	for (const [id] of calls) {
		if (!results.has(id)) throw new Error(`Cursor history is missing the genuine native result for tool ${id}`);
	}
	const userText = (content: string | { type: string; text?: string }[]) => {
		if (typeof content === "string") return content;
		if (content.some((part) => part.type !== "text"))
			throw new Error("Cursor model catalog advertises text-only input; image input is unsupported");
		return content.map((part) => part.text ?? "").join("\n");
	};
	const turns: Uint8Array[] = [];
	let user: Uint8Array | undefined;
	let steps: Uint8Array[] = [];
	const finishTurn = () => {
		if (user) turns.push(store(message([1, message([1, user], ...steps.map((step): Field => [2, step]))])));
		user = undefined;
		steps = [];
	};
	for (let index = 0; index < context.messages.length; index++) {
		if (index === activeIndex) break;
		const entry = context.messages[index];
		if (entry.role === "user") {
			finishTurn();
			const content = userText(entry.content);
			user = store(message([1, content], [2, wireId(`user_${index}_${entry.timestamp}`)]));
			pushJson({ role: "user", content: [{ type: "text", text: content }] });
		} else if (entry.role === "assistant") {
			const replayK3 = /^kimi-k3(?:-|$)/u.test(targetModelId);
			if (replayK3 && (entry.provider !== "cursor" || entry.api !== "kpi-cursor" || entry.model !== targetModelId)) {
				throw new Error(`Cursor ${targetModelId} cannot replay another model's reasoning; start a new session`);
			}
			const content: unknown[] = [];
			for (const part of entry.content) {
				if (part.type === "text") {
					content.push({ type: "text", text: part.text });
					steps.push(store(message([1, message([1, part.text])])));
				} else if (part.type === "thinking") {
					if (replayK3) {
						content.push({
							type: "reasoning",
							text: part.thinking,
							providerOptions: { cursor: { modelName: entry.model } },
							...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}),
						});
						steps.push(store(message([3, message([1, part.thinking])])));
					} else {
						// Preserve visible history without forging a foreign reasoning signature.
						const thinking = `[Prior assistant reasoning]\n${part.thinking}`;
						content.push({ type: "text", text: thinking });
						steps.push(store(message([1, message([1, thinking])])));
					}
				} else {
					content.push({
						type: "tool-call",
						toolCallId: wireId(part.id),
						toolName: part.name,
						args: part.arguments,
					});
					steps.push(store(callStep(part, results.get(part.id))));
				}
			}
			pushJson({ role: "assistant", content });
		} else {
			pushJson({
				role: "tool",
				id: wireId(entry.toolCallId),
				content: [
					{
						type: "tool-result",
						toolName: entry.toolName,
						toolCallId: wireId(entry.toolCallId),
						result: resultText(entry),
						isError: entry.isError,
					},
				],
			});
		}
	}
	finishTurn();
	const action: CursorRunRequest["action"] =
		last?.role === "user"
			? { userMessageAction: { userMessage: { text: userText(last.content), messageId: randomUUID() } } }
			: { resumeAction: {} };
	return { blobs, conversationState: { rootPromptMessagesJson: root, turns }, action, requestContext };
}

/** Payload hook sees this named request; replacement is serialized, never ignored. */
export function encodeCursorRun(request: CursorRunRequest): Buffer {
	if (!request || typeof request !== "object" || !request.requestedModel?.modelId || !request.modelDetails?.modelId)
		throw new Error("Invalid Cursor Run payload replacement");
	const state = request.conversationState;
	const model = request.modelDetails;
	const requested = request.requestedModel;
	const action =
		"userMessageAction" in request.action
			? message([
					1,
					message([
						1,
						message(
							[1, request.action.userMessageAction.userMessage.text],
							[2, request.action.userMessageAction.userMessage.messageId],
						),
					]),
				])
			: message([2, message()]);
	return message([
		1,
		message(
			[
				1,
				message(
					...state.rootPromptMessagesJson.map((id): Field => [1, id]),
					...state.turns.map((id): Field => [8, id]),
				),
			],
			[2, action],
			[3, message([1, model.modelId], [3, model.displayModelId], [4, model.displayName], [7, model.maxMode])],
			[5, request.conversationId],
			[8, request.customSystemPrompt],
			[
				9,
				message(
					[1, requested.modelId],
					[2, requested.maxMode],
					...requested.parameters.map((parameter): Field => [3, message([1, parameter.id], [2, parameter.value])]),
				),
			],
		),
	]);
}
