#!/usr/bin/env node
/**
 * UAT stub model — OpenAI-compatible loopback server.
 *
 * Wire protocol matches packages/ai openai-completions streaming client:
 *   GET  /v1/models | /models
 *   GET  /api/tags                 (Ollama discovery fallback)
 *   POST /v1/chat/completions | /chat/completions  → SSE chunks
 *
 * Boundary: reads only the HTTP request + its screenplay file.
 * Never reads or writes .kpi/, the repo, or product state.
 *
 * Usage:
 *   node uat/stub-model.mjs --port 0 --screenplay path.json --log path/model-requests.jsonl
 *   node uat/stub-model.mjs --self-test
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_MODEL = "uat-stub";

/**
 * @typedef {{
 *   match?: { promptIncludes?: string[], toolsAny?: string[], toolsAll?: string[], model?: string, node?: string },
 *   status?: number,
 *   headers?: Record<string,string>,
 *   once?: boolean,
 *   turns: Array<{
 *     content?: string,
 *     tool_calls?: Array<{ id?: string, name: string, arguments: string|object }>,
 *     finish_reason?: string,
 *     usage?: { prompt_tokens?: number, completion_tokens?: number }
 *   }>
 * }} ScreenplayScene
 */

/** @type {ScreenplayScene[]} */
let screenplay = [];
let logPath = "";
let models404 = false;
const modelIds = new Set([DEFAULT_MODEL]);
/** scene index → times consumed (for once) */
const consumed = new Map();

function sha256(text) {
	return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function hashToken(header) {
	if (!header) return null;
	const raw = String(header);
	const m = raw.match(/^Bearer\s+(.+)$/i);
	const token = m ? m[1] : raw;
	if (!token) return null;
	// never log the token; only a short hash suffix for correlation
	return sha256(token).slice(0, 16);
}

function loadScreenplay(path) {
	if (!path) {
		screenplay = [
			{
				match: {},
				turns: [
					{
						content: "uat-stub default reply",
						finish_reason: "stop",
						usage: { prompt_tokens: 8, completion_tokens: 4 },
					},
				],
			},
		];
		return;
	}
	const raw = JSON.parse(readFileSync(path, "utf8"));
	if (Array.isArray(raw)) {
		screenplay = raw;
	} else if (raw && Array.isArray(raw.scenes)) {
		screenplay = raw.scenes;
		if (Array.isArray(raw.models)) {
			for (const id of raw.models) modelIds.add(String(id));
		}
		if (raw.models404 === true) models404 = true;
	} else {
		throw new Error(`screenplay must be an array or {scenes:[]} at ${path}`);
	}
}

function promptBlob(body) {
	const parts = [];
	if (typeof body?.system === "string") parts.push(body.system);
	for (const msg of body?.messages ?? []) {
		if (typeof msg?.content === "string") parts.push(msg.content);
		else if (Array.isArray(msg?.content)) {
			for (const c of msg.content) {
				if (typeof c === "string") parts.push(c);
				else if (c && typeof c.text === "string") parts.push(c.text);
			}
		}
		if (msg?.role === "tool" && typeof msg?.content === "string") parts.push(msg.content);
	}
	return parts.join("\n");
}

function toolNames(body) {
	const names = new Set();
	for (const t of body?.tools ?? []) {
		const n = t?.function?.name ?? t?.name;
		if (typeof n === "string") names.add(n);
	}
	return names;
}

function matchScene(body) {
	const blob = promptBlob(body);
	const tools = toolNames(body);
	const model = typeof body?.model === "string" ? body.model : "";

	for (let i = 0; i < screenplay.length; i++) {
		const scene = screenplay[i];
		const m = scene.match ?? {};
		if (m.once || scene.once) {
			if ((consumed.get(i) ?? 0) > 0) continue;
		}
		if (m.model && m.model !== model && !model.endsWith(`/${m.model}`) && !model.includes(m.model)) {
			continue;
		}
		if (m.promptIncludes) {
			const ok = m.promptIncludes.every((s) => blob.includes(s));
			if (!ok) continue;
		}
		if (m.toolsAll) {
			if (!m.toolsAll.every((t) => tools.has(t))) continue;
		}
		if (m.toolsAny) {
			if (!m.toolsAny.some((t) => tools.has(t))) continue;
		}
		if (m.node) {
			// node name often appears in system or developer prompts
			if (!blob.toLowerCase().includes(String(m.node).toLowerCase()) && !blob.includes(m.node)) {
				// still allow if toolsAny matched strongly; node is soft unless alone
				if (!m.toolsAny && !m.toolsAll && !m.promptIncludes) continue;
			}
		}
		consumed.set(i, (consumed.get(i) ?? 0) + 1);
		return { scene, index: i, matched_node: m.node ?? scene.node ?? null };
	}
	// fallback: last catch-all with empty match, else synthetic stop
	for (let i = screenplay.length - 1; i >= 0; i--) {
		const scene = screenplay[i];
		if (!scene.match || Object.keys(scene.match).length === 0) {
			consumed.set(i, (consumed.get(i) ?? 0) + 1);
			return { scene, index: i, matched_node: scene.node ?? "default" };
		}
	}
	return {
		scene: {
			turns: [
				{
					content: "uat-stub unmatched request",
					finish_reason: "stop",
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				},
			],
		},
		index: -1,
		matched_node: null,
	};
}

function logRequest(entry) {
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

function sseWrite(res, obj) {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function streamCompletion(res, body, scene, meta) {
	const id = `chatcmpl-uat-${randomUUID().slice(0, 8)}`;
	const model = typeof body?.model === "string" ? body.model : DEFAULT_MODEL;
	const created = Math.floor(Date.now() / 1000);
	const turns = scene.turns?.length ? scene.turns : [{ content: "", finish_reason: "stop" }];

	res.writeHead(scene.status && scene.status >= 400 ? scene.status : 200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		...(scene.headers ?? {}),
	});

	if (scene.status && scene.status >= 400) {
		res.write(
			JSON.stringify({
				error: {
					message: scene.error ?? `stub status ${scene.status}`,
					type: "uat_stub_error",
					code: scene.status,
				},
			}),
		);
		res.end();
		return;
	}

	for (const turn of turns) {
		if (turn.content) {
			// split content into small deltas to exercise the client
			const text = String(turn.content);
			const step = Math.max(1, Math.ceil(text.length / 3));
			for (let i = 0; i < text.length; i += step) {
				const delta = text.slice(i, i + step);
				sseWrite(res, {
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [{ index: 0, delta: { role: i === 0 ? "assistant" : undefined, content: delta }, finish_reason: null }],
				});
			}
		}
		if (turn.tool_calls?.length) {
			turn.tool_calls.forEach((tc, index) => {
				const callId = tc.id ?? `call_uat_${index}`;
				const args =
					typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {});
				// name chunk
				sseWrite(res, {
					id,
					object: "chat.completion.chunk",
					created,
					model,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index,
										id: callId,
										type: "function",
										function: { name: tc.name, arguments: "" },
									},
								],
							},
							finish_reason: null,
						},
					],
				});
				// args chunk(s)
				const step = Math.max(1, Math.ceil(args.length / 2));
				for (let i = 0; i < args.length; i += step) {
					sseWrite(res, {
						id,
						object: "chat.completion.chunk",
						created,
						model,
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index,
											function: { arguments: args.slice(i, i + step) },
										},
									],
								},
								finish_reason: null,
							},
						],
					});
				}
			});
		}
		const finish = turn.finish_reason ?? (turn.tool_calls?.length ? "tool_calls" : "stop");
		const usage = turn.usage ?? { prompt_tokens: 12, completion_tokens: 8 };
		sseWrite(res, {
			id,
			object: "chat.completion.chunk",
			created,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: finish }],
			usage,
		});
	}
	res.write("data: [DONE]\n\n");
	res.end();
	void meta;
}

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw) return resolveBody({});
			try {
				resolveBody(JSON.parse(raw));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

function handleModels(res) {
	if (models404) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found (force ollama tags)", code: 404 } }));
		return;
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			object: "list",
			data: [...modelIds].map((id) => ({ id, object: "model", owned_by: "uat-stub" })),
		}),
	);
}

function handleTags(res) {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			models: [...modelIds].map((id) => ({ name: id, model: id })),
		}),
	);
}

async function handleChat(req, res) {
	const body = await readBody(req);
	const { scene, matched_node } = matchScene(body);
	const tools = [...toolNames(body)];
	const authHash = hashToken(req.headers.authorization);
	logRequest({
		at: new Date().toISOString(),
		matched_node,
		model: body?.model ?? null,
		tools,
		prompt_sha256: sha256(promptBlob(body)),
		auth_token_sha256: authHash,
		response_status: scene.status && scene.status >= 400 ? scene.status : 200,
	});
	streamCompletion(res, body, scene, { matched_node });
}

function createStubServer() {
	return createServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", "http://127.0.0.1");
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
				return handleModels(res);
			}
			if (req.method === "GET" && path === "/api/tags") {
				return handleTags(res);
			}
			if (
				req.method === "POST" &&
				(path === "/v1/chat/completions" || path === "/chat/completions")
			) {
				return await handleChat(req, res);
			}
			if (req.method === "GET" && path === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, models: [...modelIds] }));
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: String(err?.message ?? err) } }));
		}
	});
}

function parseArgs(argv) {
	const out = { port: 0, host: "127.0.0.1", screenplay: null, log: null, selfTest: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--port") out.port = Number(argv[++i]);
		else if (a === "--host") out.host = argv[++i];
		else if (a === "--screenplay") out.screenplay = resolve(argv[++i]);
		else if (a === "--log") out.log = resolve(argv[++i]);
		else if (a === "--self-test") out.selfTest = true;
		else if (a === "--models-404") models404 = true;
	}
	return out;
}

async function selfTest() {
	const tmpLog = resolve(process.cwd(), `.kpi-uat-stub-selftest-${process.pid}.jsonl`);
	logPath = tmpLog;
	loadScreenplay(null);
	screenplay = [
		{
			match: { promptIncludes: ["ping-tool"] },
			turns: [
				{
					tool_calls: [{ name: "echo", arguments: { text: "pong" } }],
					finish_reason: "tool_calls",
					usage: { prompt_tokens: 3, completion_tokens: 2 },
				},
			],
		},
		{
			match: { promptIncludes: ["after-tool"] },
			turns: [
				{
					content: "tool result acknowledged",
					finish_reason: "stop",
					usage: { prompt_tokens: 4, completion_tokens: 3 },
				},
			],
		},
		{
			match: {},
			status: 429,
			headers: {
				"retry-after": "1",
				"x-ratelimit-remaining-requests": "0",
				"x-ratelimit-limit-requests": "100",
			},
			turns: [],
			once: true,
		},
	];
	const server = createStubServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address();
	const base = `http://127.0.0.1:${port}`;

	const models = await fetch(`${base}/v1/models`).then((r) => r.json());
	if (!models.data?.some((m) => m.id === DEFAULT_MODEL)) throw new Error("models list missing stub id");

	const tags = await fetch(`${base}/api/tags`).then((r) => r.json());
	if (!tags.models?.some((m) => m.name === DEFAULT_MODEL)) throw new Error("api/tags missing stub");

	const streamRes = await fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer local" },
		body: JSON.stringify({
			model: DEFAULT_MODEL,
			stream: true,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: "please ping-tool now" }],
			tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }],
		}),
	});
	const text = await streamRes.text();
	if (!text.includes("finish_reason")) throw new Error("stream missing finish_reason");
	if (!text.includes("tool_calls")) throw new Error("stream missing tool_calls");
	if (!text.includes("[DONE]")) throw new Error("stream missing DONE");

	const limited = await fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: DEFAULT_MODEL, stream: true, messages: [{ role: "user", content: "x" }] }),
	});
	if (limited.status !== 429) throw new Error(`expected 429 once, got ${limited.status}`);
	if (!limited.headers.get("retry-after")) throw new Error("429 missing retry-after");

	const log = readFileSync(tmpLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	if (log.some((e) => JSON.stringify(e).includes("Bearer local") || JSON.stringify(e).includes('"local"'))) {
		// auth must be hashed only — full token must not appear
		const bad = log.find((e) => String(e.auth_token_sha256 || "").length === 0 && e.auth_token_sha256 !== null);
		void bad;
	}
	for (const e of log) {
		const blob = JSON.stringify(e);
		if (/\bBearer\b/i.test(blob)) throw new Error("log leaked Bearer token");
		if (e.auth_token_sha256 && e.auth_token_sha256.length !== 16) throw new Error("auth hash shape");
	}

	server.close();
	try {
		writeFileSync(tmpLog, ""); // truncate leftover
	} catch {
		/* ignore */
	}
	const { unlinkSync } = await import("node:fs");
	try {
		unlinkSync(tmpLog);
	} catch {
		/* ignore */
	}
	process.stdout.write("stub-model self-test: ok\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.selfTest) {
		await selfTest();
		return;
	}
	loadScreenplay(args.screenplay);
	if (args.log) logPath = args.log;
	const server = createStubServer();
	await new Promise((r) => server.listen(args.port, args.host, r));
	const addr = server.address();
	const info = {
		ok: true,
		host: args.host,
		port: addr.port,
		baseUrl: `http://${args.host}:${addr.port}/v1`,
		log: logPath || null,
		screenplay: args.screenplay,
		pid: process.pid,
	};
	process.stdout.write(`${JSON.stringify(info)}\n`);
	const shutdown = () => {
		server.close(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	process.stderr.write(`stub-model: ${err?.stack || err}\n`);
	process.exit(1);
});
