import assert from "node:assert/strict";
import {
	constants,
	createServer,
	type IncomingHttpHeaders,
	type ServerHttp2Session,
	type ServerHttp2Stream,
} from "node:http2";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import type { Api, Context, Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Agent } from "../packages/agent/src/agent.ts";
import {
	type CursorModelConfig,
	refreshCursorModels,
} from "../packages/coding-agent/src/kpi/extensions/cursor/discovery.ts";
import type { CursorRunRequest } from "../packages/coding-agent/src/kpi/extensions/cursor/history.ts";
import {
	bytes,
	ConnectFrames,
	decode,
	frame,
	jsonValue,
	message,
	number,
	parseJsonValue,
	repeated,
	text,
	type WireMessage,
} from "../packages/coding-agent/src/kpi/extensions/cursor/protocol.ts";
import { streamCursor } from "../packages/coding-agent/src/kpi/extensions/cursor/stream.ts";

const baseModel: Model<Api> = {
	id: "fixture-model",
	name: "Fixture",
	provider: "cursor",
	api: "kpi-cursor",
	baseUrl: "http://127.0.0.1",
	input: ["text"],
	reasoning: false,
	contextWindow: 0,
	maxTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const prompt: Context = {
	systemPrompt: "KPI_SYSTEM: never write without permission",
	messages: [{ role: "user", content: "fixture question", timestamp: 1 }],
};

type Handler = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => Promise<void>;
async function service(handler: Handler, exercise: (baseUrl: string) => Promise<void>): Promise<void> {
	const server = createServer();
	const sessions = new Set<ServerHttp2Session>();
	const errors: unknown[] = [];
	server.on("session", (session) => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
		session.on("error", () => undefined);
	});
	server.on("stream", (stream, headers) => {
		stream.on("error", () => undefined);
		void handler(stream, headers).catch((error) => {
			errors.push(error);
			stream.close();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		await exercise(`http://127.0.0.1:${address.port}`);
	} finally {
		for (const session of sessions) session.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	assert.deepEqual(errors, []);
}

async function* clientMessages(stream: ServerHttp2Stream): AsyncGenerator<WireMessage> {
	const parser = new ConnectFrames();
	try {
		for await (const chunk of stream)
			for (const item of parser.push(chunk)) {
				if (!item.end) yield decode(item.payload);
			}
	} catch (error) {
		if (!stream.destroyed && !stream.closed) throw error;
	}
}

function complete(stream: ServerHttp2Stream, answer: string): void {
	stream.end(
		Buffer.concat([
			frame(message([1, message([1, message([1, answer])])])),
			frame(message([1, message([14, message()])])),
			frame(Buffer.from("{}"), 2),
		]),
	);
}

test("Cursor HTTP/2 handshakes preserve rules, schemas, payload replacement and fragmented text/thinking", async () => {
	let hookFinished = false;
	const tool = {
		name: "fixture_read",
		description: "Read through native permissions",
		parameters: Type.Object({ path: Type.String() }),
	};
	await service(
		async (stream, headers) => {
			assert.equal(headers[":path"], "/agent.v1.AgentService/Run");
			assert.equal(headers.authorization, "Bearer fixture-access");
			assert.equal(headers["x-request-id"] === "forged", false);
			assert.equal(headers["x-fixture-trace"], "retained");
			assert.equal(headers["x-kpi-cursor-model-details"], undefined);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			for await (const incoming of clientMessages(stream)) {
				if (incoming.has(1)) {
					const request = decode(bytes(incoming, 1));
					assert.equal(text(request, 8), "hook replacement reaches the wire");
					assert.equal(text(decode(bytes(request, 9)), 1), "fixture-model");
					stream.write(frame(message([2, message([1, 12], [10, message()])])));
				} else if (incoming.has(2)) {
					const reply = decode(bytes(incoming, 2));
					assert.equal(number(reply, 1), 12);
					const ctx = decode(bytes(decode(bytes(decode(bytes(reply, 10)), 1)), 1));
					const rules = repeated(ctx, 2).map((rule) => text(decode(rule), 2));
					assert.ok(rules.includes(prompt.systemPrompt!));
					assert.ok(rules.some((rule) => rule.includes("permission hooks")));
					const advertised = decode(repeated(ctx, 7)[0]);
					assert.equal(text(advertised, 5), tool.name);
					assert.deepEqual(parseJsonValue(bytes(advertised, 3)), JSON.parse(JSON.stringify(tool.parameters)));
					const response = Buffer.concat([
						frame(message([1, message([4, message([1, "considering"])])])),
						frame(message([1, message([5, message()])])),
						frame(message([1, message([1, message([1, "h\u00e9llo \u03c0"])])])),
						frame(message([1, message([8, message([1, 3])])])),
						frame(message([1, message([14, message()])])),
						frame(Buffer.from("{}"), 2),
					]);
					for (let offset = 0; offset < response.length; offset += 2) {
						stream.write(response.subarray(offset, offset + 2));
						await nextTick();
					}
					stream.end();
				}
			}
		},
		async (baseUrl) => {
			const output = streamCursor(
				{ ...baseModel, baseUrl },
				{ ...prompt, tools: [tool] },
				{
					apiKey: "fixture-access",
					headers: {
						Authorization: "forged",
						"x-request-id": "forged",
						"x-fixture-trace": "retained",
						"x-kpi-cursor-model-details": "private",
					},
					onPayload: (payload) => ({
						...(payload as CursorRunRequest),
						customSystemPrompt: "hook replacement reaches the wire",
					}),
					onResponse: async (response) => {
						assert.equal(response.status, 200);
						await nextTick();
						hookFinished = true;
					},
				},
			);
			const events = [];
			for await (const event of output) {
				assert.equal(hookFinished, true);
				events.push(event.type);
			}
			const result = await output.result();
			assert.equal(result.stopReason, "stop");
			assert.deepEqual(result.content, [
				{ type: "thinking", thinking: "considering" },
				{ type: "text", text: "h\u00e9llo \u03c0" },
			]);
			assert.equal(result.usage.output, 3);
			assert.equal(result.usage.input, 0, "unknown input usage is not estimated from output");
			assert.ok(events.includes("thinking_end") && events.includes("text_end"));
		},
	);
});

test("Cursor yields native tools and replays genuine results across the native permission hook", async () => {
	for (const blocked of [true, false]) {
		let calls = 0;
		let permissionChecks = 0;
		let executions = 0;
		const observedResults: unknown[] = [];
		await service(
			async (stream) => {
				const turn = ++calls;
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				let pendingBlobs = 0;
				for await (const incoming of clientMessages(stream)) {
					if (incoming.has(1)) {
						const request = decode(bytes(incoming, 1));
						if (turn === 1) {
							stream.write(frame(message([2, message([1, 1], [10, message()])])));
						} else {
							assert.equal(
								decode(bytes(request, 2)).has(2),
								true,
								"continuation is ResumeAction, not a fabricated user turn",
							);
							const ids = repeated(decode(bytes(request, 1)), 1);
							pendingBlobs = ids.length;
							ids.forEach((id, index) => {
								stream.write(frame(message([4, message([1, index + 1], [2, message([1, id])])])));
							});
						}
					} else if (incoming.has(2)) {
						assert.equal(turn, 1, "no synthetic success handoff is sent");
						const exec = decode(bytes(incoming, 2));
						assert.equal(exec.has(10), true);
						stream.write(
							frame(
								message([
									2,
									message(
										[1, 2],
										[
											11,
											message(
												[1, "fixture_write"],
												[2, message([1, "path"], [2, jsonValue("blocked.txt")])],
												[3, "native_call_1"],
												[4, "kpi-agent"],
												[5, "fixture_write"],
											),
										],
									),
								]),
							),
						);
					} else if (incoming.has(3)) {
						const kv = decode(bytes(incoming, 3));
						const root = JSON.parse(Buffer.from(bytes(decode(bytes(kv, 2)), 1)).toString("utf8"));
						if (root.role === "tool") observedResults.push(root.content[0]);
						if (--pendingBlobs === 0) complete(stream, "genuine native result received");
					}
				}
			},
			async (baseUrl) => {
				const agent = new Agent({
					initialState: {
						model: { ...baseModel, baseUrl },
						systemPrompt: prompt.systemPrompt,
						tools: [
							{
								name: "fixture_write",
								label: "Fixture write",
								description: "Native fixture",
								parameters: Type.Object({ path: Type.String() }),
								execute: async () => {
									executions++;
									return { content: [{ type: "text", text: "fixture execution succeeded" }], details: {} };
								},
							},
						],
					},
					streamFn: (model, context, options) =>
						streamCursor(model, context, { ...options, apiKey: "fixture-access" }),
					beforeToolCall: async () => {
						permissionChecks++;
						return blocked ? { block: true, reason: "fixture policy denied this write" } : undefined;
					},
				});
				await agent.prompt("request a write");
				assert.equal(calls, 2);
				assert.equal(permissionChecks, 1);
				assert.equal(executions, blocked ? 0 : 1);
				assert.deepEqual(observedResults, [
					{
						type: "tool-result",
						toolName: "fixture_write",
						toolCallId: "native_call_1",
						result: blocked ? "fixture policy denied this write" : "fixture execution succeeded",
						isError: blocked,
					},
				]);
				assert.ok(agent.state.messages.some((entry) => entry.role === "toolResult" && entry.isError === blocked));
			},
		);
	}
});

test("Cursor native shell requests remain native tool calls and carry working directory and timeout", async () => {
	await service(
		async (stream) => {
			stream.respond({ ":status": 200 });
			for await (const incoming of clientMessages(stream))
				if (incoming.has(1)) {
					stream.write(
						frame(
							message([
								2,
								message([1, 1], [14, message([1, "pwd"], [2, "/tmp/with'quote"], [3, 2], [4, "shell_1"])]),
							]),
						),
					);
				}
		},
		async (baseUrl) => {
			const result = await streamCursor(
				{ ...baseModel, baseUrl },
				{
					...prompt,
					tools: [
						{ name: "bash", description: "Native bash", parameters: Type.Object({ command: Type.String() }) },
					],
				},
				{ apiKey: "fixture" },
			).result();
			assert.equal(result.stopReason, "toolUse");
			assert.deepEqual(result.content, [
				{
					type: "toolCall",
					id: "shell_1",
					name: "bash",
					arguments: { command: "cd -- '/tmp/with'\\''quote' && pwd", timeout: 2 },
				},
			]);
		},
	);
});

test("Cursor preserves catalog identity while serializing evidenced OpenAI effort siblings", async () => {
	await service(
		async (stream) => {
			stream.respond({ ":status": 200 });
			for await (const incoming of clientMessages(stream))
				if (incoming.has(1)) {
					const request = decode(bytes(incoming, 1));
					const requested = decode(bytes(request, 9));
					assert.equal(text(requested, 1), "gpt-fixture-fast");
					assert.deepEqual(
						repeated(requested, 3).map((entry) => {
							const parameter = decode(entry);
							return [text(parameter, 1), text(parameter, 2)];
						}),
						[
							["context", "explicit-value"],
							["reasoning", "high"],
						],
					);
					assert.equal(text(decode(bytes(request, 3)), 3), "gpt-fixture-high-fast");
					complete(stream, "ok");
				}
		},
		async (baseUrl) => {
			const model: Model<Api> & CursorModelConfig = {
				...baseModel,
				baseUrl,
				id: "gpt-fixture-high-fast",
				cursorModelDetails: { parameters: [{ id: "context", value: "explicit-value" }] },
			};
			const result = await streamCursor(model, prompt, { apiKey: "fixture" }).result();
			assert.equal(result.model, model.id);
			assert.equal(result.stopReason, "stop");
		},
	);
});

test("Cursor reports non-2xx through native response hook before refusing the body", async () => {
	let observed = 0;
	await service(
		async (stream) => {
			stream.respond({ ":status": 429, "retry-after": "1" });
			stream.end("not protobuf");
		},
		async (baseUrl) => {
			const result = await streamCursor({ ...baseModel, baseUrl }, prompt, {
				apiKey: "fixture",
				onResponse: async ({ status, headers }) => {
					observed = status;
					assert.equal(headers["retry-after"], "1");
				},
			}).result();
			assert.equal(observed, 429);
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage!, /HTTP 429/u);
		},
	);
});

for (const [name, reply, expected] of [
	["truncated frame", Buffer.from([0, 0, 0, 0, 9, 10]), /Truncated/u],
	["malformed protobuf", frame(Buffer.from([0])), /protobuf field zero/u],
	["abrupt normal EOF", frame(message([1, message([1, message([1, "unfinished"])])])), /before turnEnded/u],
	[
		"Connect error",
		frame(Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message: "fixture quota" } })), 2),
		/resource_exhausted.*fixture quota/u,
	],
	["compression refused", frame(message(), 1), /compression/u],
] as const)
	test(`Cursor fails honestly on ${name}`, async () => {
		await service(
			async (stream) => {
				stream.respond({ ":status": 200 });
				stream.end(reply);
			},
			async (baseUrl) => {
				const result = await streamCursor({ ...baseModel, baseUrl }, prompt, { apiKey: "fixture" }).result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage!, expected);
			},
		);
	});

test("Cursor catches HTTP/2 resets and error trailers even after turnEnded", async () => {
	for (const reset of [true, false])
		await service(
			async (stream) => {
				stream.respond({ ":status": 200 }, { waitForTrailers: !reset });
				if (reset) stream.close(constants.NGHTTP2_INTERNAL_ERROR);
				else {
					stream.on("wantTrailers", () =>
						stream.sendTrailers({ "grpc-status": "7", "grpc-message": "fixture denied" }),
					);
					stream.end(frame(message([1, message([14, message()])])));
				}
			},
			async (baseUrl) => {
				const result = await streamCursor({ ...baseModel, baseUrl }, prompt, { apiKey: "fixture" }).result();
				assert.equal(result.stopReason, "error");
				if (!reset) assert.match(result.errorMessage!, /gRPC 7/u);
			},
		);
});

test("Cursor abort and timeout close the actual HTTP/2 session", async () => {
	for (const abort of [true, false]) {
		let closed!: () => void;
		const closure = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const controller = new AbortController();
		await service(
			async (stream) => {
				stream.on("close", closed);
				stream.respond({ ":status": 200 });
				if (abort) controller.abort(new Error("fixture operator stop"));
			},
			async (baseUrl) => {
				const result = await streamCursor({ ...baseModel, baseUrl }, prompt, {
					apiKey: "fixture",
					signal: controller.signal,
					timeoutMs: abort ? 2_000 : 30,
				}).result();
				assert.equal(result.stopReason, abort ? "aborted" : "error");
				assert.match(result.errorMessage!, abort ? /fixture operator stop/u : /timed out/u);
				await closure;
			},
		);
	}
});

test("Cursor refuses cloud/subagent execution and hosted tool completions", async () => {
	for (const reply of [
		message([2, message([1, 1], [28, message()])]),
		message([7, message([1, 1], [8, message()])]),
		message([1, message([2, message([1, "cloud"], [2, message([33, message()])])])]),
	]) {
		await service(
			async (stream) => {
				stream.respond({ ":status": 200 });
				stream.write(frame(reply));
			},
			async (baseUrl) => {
				const result = await streamCursor({ ...baseModel, baseUrl }, prompt, { apiKey: "fixture" }).result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage!, /disabled|hosted tool/u);
				assert.equal(
					result.content.some((part) => part.type === "toolCall"),
					false,
				);
			},
		);
	}
});

test("Cursor live discovery publishes only usable IDs with unknown metadata and preserves native cache offline", async () => {
	let stored: ModelsStoreEntry | undefined;
	let requests = 0;
	await service(
		async (stream, headers) => {
			assert.equal(headers[":path"], "/agent.v1.AgentService/GetUsableModels");
			assert.equal(headers.authorization, "Bearer fixture-oauth-access");
			requests++;
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(
				message(
					[1, message([1, "unrecognised-high-image-1m"], [4, "Unknown model"])],
					[1, message([1, "explicit-thinking"], [2, message()], [7, true])],
				),
			);
		},
		async (baseUrl) => {
			const context: RefreshModelsContext = {
				allowNetwork: true,
				signal: new AbortController().signal,
				credential: {
					type: "oauth",
					access: "fixture-oauth-access",
					refresh: "fixture-not-read",
					expires: Date.now() + 10000,
				},
				publish: async ({ persist }) => {
					stored = persist ?? undefined;
					return true;
				},
			};
			const models = await refreshCursorModels(context, { baseUrl });
			assert.deepEqual(
				models.map((model) => [model.id, model.contextWindow, model.maxTokens, model.input, model.reasoning]),
				[
					["unrecognised-high-image-1m", 0, 0, ["text"], false],
					["explicit-thinking", 0, 0, ["text"], true],
				],
			);
			assert.equal((models[1] as CursorModelConfig).cursorModelDetails?.maxMode, true);
			const offline = await refreshCursorModels(
				{ ...context, credential: undefined, allowNetwork: false, stored },
				{ baseUrl },
			);
			assert.deepEqual(offline, models);
			assert.equal(requests, 1);
		},
	);
});

test("Cursor successful empty discovery clears cache; failed discovery reports error without publishing", async () => {
	for (const status of [200, 503]) {
		let publications = 0;
		let stored: ModelsStoreEntry = { models: [baseModel] };
		await service(
			async (stream) => {
				stream.respond({ ":status": status, "content-type": "application/proto" });
				stream.end();
			},
			async (baseUrl) => {
				const context: RefreshModelsContext = {
					allowNetwork: true,
					signal: new AbortController().signal,
					stored,
					credential: { type: "api_key", key: "fixture" },
					publish: async ({ persist }) => {
						publications++;
						stored = persist!;
						return true;
					},
				};
				if (status === 200) {
					assert.deepEqual(await refreshCursorModels(context, { baseUrl }), []);
					assert.deepEqual(stored.models, []);
					assert.equal(publications, 1);
				} else {
					await assert.rejects(refreshCursorModels(context, { baseUrl }), /HTTP 503/u);
					assert.equal(publications, 0);
					assert.deepEqual(stored.models, [baseModel]);
				}
			},
		);
	}
});

test("Cursor sends protocol heartbeats while awaiting model output", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let heartbeatSeen = false;
	await service(
		async (stream) => {
			stream.respond({ ":status": 200 });
			for await (const incoming of clientMessages(stream))
				if (incoming.has(7)) {
					heartbeatSeen = true;
					complete(stream, "heartbeat accepted");
				}
		},
		async (baseUrl) => {
			const result = await streamCursor({ ...baseModel, baseUrl }, prompt, {
				apiKey: "fixture",
				timeoutMs: 2000,
				onResponse: () => {
					void nextTick().then(() => t.mock.timers.tick(5000));
				},
			}).result();
			assert.equal(result.stopReason, "stop");
			assert.equal(heartbeatSeen, true);
		},
	);
});

test("Cursor discovery checks framed unary trailers and cancellation without publishing a failed catalog", async () => {
	for (const error of [false, true]) {
		let published = false;
		await service(
			async (stream) => {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.end(
					Buffer.concat([
						frame(message([1, message([1, "fixture-unary-model"])])),
						frame(
							Buffer.from(
								JSON.stringify(error ? { error: { code: "permission_denied", message: "fixture" } } : {}),
							),
							2,
						),
					]),
				);
			},
			async (baseUrl) => {
				const context: RefreshModelsContext = {
					allowNetwork: true,
					signal: new AbortController().signal,
					credential: { type: "api_key", key: "fixture" },
					publish: async () => {
						published = true;
						return true;
					},
				};
				if (error) await assert.rejects(refreshCursorModels(context, { baseUrl }), /permission_denied/u);
				else
					assert.deepEqual(
						(await refreshCursorModels(context, { baseUrl })).map((model) => model.id),
						["fixture-unary-model"],
					);
				assert.equal(published, !error);
			},
		);
	}
	const controller = new AbortController();
	const reason = new Error("fixture cancelled discovery");
	controller.abort(reason);
	await assert.rejects(
		refreshCursorModels({
			allowNetwork: false,
			signal: controller.signal,
			publish: async () => assert.fail("cancelled discovery cannot publish"),
		}),
		(error) => error === reason,
	);
});

test("Cursor K3 replays same-model reasoning with its real signature through KV history", async () => {
	const model = { ...baseModel, id: "kimi-k3-fixture" };
	let reasoning: unknown;
	await service(
		async (stream) => {
			stream.respond({ ":status": 200 });
			let pending = 0;
			for await (const incoming of clientMessages(stream)) {
				if (incoming.has(1)) {
					const run = decode(bytes(incoming, 1));
					const ids = repeated(decode(bytes(run, 1)), 1);
					pending = ids.length;
					for (let index = 0; index < ids.length; index++)
						stream.write(frame(message([4, message([1, index + 1], [2, message([1, ids[index]])])])));
				} else if (incoming.has(3)) {
					const kv = decode(bytes(incoming, 3));
					const root = JSON.parse(Buffer.from(bytes(decode(bytes(kv, 2)), 1)).toString("utf8"));
					if (root.role === "assistant")
						reasoning = root.content.find((part: { type: string }) => part.type === "reasoning");
					if (--pending === 0) complete(stream, "reasoning replayed");
				}
			}
		},
		async (baseUrl) => {
			const context: Context = {
				...prompt,
				messages: [
					...prompt.messages,
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "prior thought", thinkingSignature: "genuine-fixture-signature" },
							{ type: "text", text: "prior answer" },
						],
						api: "kpi-cursor",
						provider: "cursor",
						model: model.id,
						stopReason: "stop",
						timestamp: 2,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
					{ role: "user", content: "continue", timestamp: 3 },
				],
			};
			const result = await streamCursor({ ...model, baseUrl }, context, { apiKey: "fixture" }).result();
			assert.equal(result.stopReason, "stop");
			assert.deepEqual(reasoning, {
				type: "reasoning",
				text: "prior thought",
				providerOptions: { cursor: { modelName: model.id } },
				signature: "genuine-fixture-signature",
			});
		},
	);
});
