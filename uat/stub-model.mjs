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


function extractJobId(blob) {
	const m = /\bJob:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/i.exec(blob);
	return m ? m[1] : "uat-job";
}

function flattenContent(content) {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) {
		if (content && typeof content === "object") {
			const parts = [];
			if (typeof content.text === "string") parts.push(content.text);
			if (typeof content.content === "string") parts.push(content.content);
			if (typeof content.stdout === "string") parts.push(content.stdout);
			if (typeof content.output === "string") parts.push(content.output);
			return parts;
		}
		return [];
	}
	const out = [];
	for (const c of content) {
		if (typeof c === "string") out.push(c);
		else if (c && typeof c === "object") {
			if (typeof c.text === "string") out.push(c.text);
			if (typeof c.content === "string") out.push(c.content);
			if (typeof c.stdout === "string") out.push(c.stdout);
			if (c.type === "text" && typeof c.text === "string") out.push(c.text);
			// nested details from agent tools
			if (c.details && typeof c.details === "object") {
				if (typeof c.details.stdout === "string") out.push(c.details.stdout);
				if (typeof c.details.output === "string") out.push(c.details.output);
			}
		}
	}
	return out;
}

function toolResultTexts(body) {
	const out = [];
	for (const msg of body?.messages ?? []) {
		const role = String(msg?.role ?? "");
		if (role === "tool" || role === "toolResult" || role === "function") {
			out.push(...flattenContent(msg.content));
			if (typeof msg.output === "string") out.push(msg.output);
			if (typeof msg.stdout === "string") out.push(msg.stdout);
			if (msg.details) out.push(...flattenContent(msg.details));
		}
		// some clients embed tool results as user messages
		if (role === "user") {
			const texts = flattenContent(msg.content);
			for (const text of texts) {
				if (/exit code|stdout|rev-parse|[0-9a-f]{40}/i.test(text)) out.push(text);
			}
		}
	}
	return out;
}

function findSha(texts) {
	for (const t of texts) {
		const s = String(t ?? "");
		// Prefer a lone 40-hex line (git rev-parse HEAD).
		for (const line of s.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.toLowerCase();
		}
		const m = /\b([0-9a-f]{40})\b/i.exec(s);
		if (m) return m[1].toLowerCase();
	}
	return null;
}

function lastAssistantHadToolCalls(body) {
	const msgs = body?.messages ?? [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m?.role === "assistant") {
			return Boolean(m.tool_calls?.length || (Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_call")));
		}
	}
	return false;
}

function hasToolResult(body) {
	return (body?.messages ?? []).some((m) => {
		const role = String(m?.role ?? "");
		return role === "tool" || role === "toolResult" || role === "function";
	}) || toolResultTexts(body).length > 0;
}

/**
 * Drive a minimal happy-path coding loop against fixtures that already contain
 * a green healthcheck. Uses only the request transcript (no filesystem).
 */
function dynamicLoopTurns(body) {
	const blob = promptBlob(body);
	const tools = toolNames(body);
	const jobId = extractJobId(blob);
	const texts = toolResultTexts(body);
	const sha = findSha(texts);

	// Reviewer worker: must publish via write_contract
	if (
		tools.has("write_contract") ||
		/write_contract/i.test(blob) ||
		/isolated-review skill/i.test(blob) ||
		/Publish the verdict only/i.test(blob)
	) {
		if (!hasToolResult(body) || !lastAssistantHadToolCalls(body)) {
			const fingerprint =
				"sha256:" +
				createHash("sha256")
					.update(`verdict-${jobId}-${sha || "seed"}`)
					.digest("hex");
			const verdict = {
				status: "PASS",
				approved: true,
				blockingIssues: [],
				nonBlockingIssues: [],
				evidence: ["npm test exits 0", "acceptance criteria covered by fixture"],
				round: 0,
				output_fingerprint: fingerprint,
			};
			return [
				{
					tool_calls: [
						{
							name: "write_contract",
							arguments: { path: "verdict.json", content: verdict },
						},
					],
					finish_reason: "tool_calls",
				},
			];
		}
		return [{ content: "verdict published", finish_reason: "stop" }];
	}

	// Ship node: one empty commit with KPI-Job trailer (policy allows standalone git commit after release)
	if (/conventional-commit skill/i.test(blob) || (/KPI-Job:/i.test(blob) && /Create exactly one approved commit/i.test(blob))) {
		if (!hasToolResult(body)) {
			const subject = "feat: healthcheck endpoint";
			const trailer = `KPI-Job: ${jobId}`;
			const command = `git commit --allow-empty -m ${JSON.stringify(subject)} -m ${JSON.stringify(trailer)}`;
			return [
				{
					tool_calls: [{ name: "bash", arguments: { command } }],
					finish_reason: "tool_calls",
				},
			];
		}
		return [{ content: "shipped", finish_reason: "stop" }];
	}

	
		// Test node: gather head + npm test then emit evidence JSON (finite)
	if (/evidence\.schema\.json/i.test(blob) || /quality-gates skill/i.test(blob) || /Return only JSON matching evidence/i.test(blob)) {
		const assistantToolTurns = (body?.messages ?? []).filter(
			(m) => m?.role === "assistant" && (m.tool_calls?.length || (Array.isArray(m.content) && m.content.some((c) => c?.type === "tool_call"))),
		).length;
		if (assistantToolTurns === 0) {
			return [
				{
					tool_calls: [{ name: "bash", arguments: { command: "git rev-parse HEAD" } }],
					finish_reason: "tool_calls",
				},
			];
		}
		if (assistantToolTurns === 1) {
			return [
				{
					tool_calls: [{ name: "bash", arguments: { command: "npm test" } }],
					finish_reason: "tool_calls",
				},
			];
		}
		const head = sha || "0".repeat(40);
		const blobTexts = texts.join("\n");
		const failed =
			/✖/.test(blobTexts) ||
			/ERR_ASSERTION/.test(blobTexts) ||
			/\bfail\s+[1-9]/.test(blobTexts) ||
			/not ok\b/i.test(blobTexts);
		const passed = /✔/.test(blobTexts) || /\bpass\s+[1-9]/.test(blobTexts);
		const testExit = failed ? 1 : passed ? 0 : 0;
		const ac_results = ["AC-01", "AC-02", "AC-03", "AC-04", "AC-05"].map((id) => ({
			id,
			passed: testExit === 0,
		}));
		const evidence = {
			head,
			commands: [
				{ cmd: "git rev-parse HEAD", exit: sha ? 0 : 1, excerpt: sha || "unavailable" },
				{ cmd: "npm test", exit: testExit, excerpt: testExit === 0 ? "ok" : "failed" },
			],
			ac_results,
		};
		return [{ content: JSON.stringify(evidence), finish_reason: "stop" }];
	}

// Implement: candidate.json + green /health under write bounds
	if (
		/tdd-cycle skill/i.test(blob) ||
		/Implement only the current stack/i.test(blob) ||
		(tools.has("write") && /candidate\.json/i.test(blob))
	) {
		const wroteCandidate = texts.some((t) => /candidate\.json/i.test(t));
		const wroteServer = texts.some((t) => /server\.js/i.test(t) && /Successfully wrote|wrote/i.test(t));
		const denied = texts.some((t) => /Policy denied/i.test(t));
		if (tools.has("write") && !wroteCandidate && !denied) {
			const candidate = {
				ladder: "minimum-code",
				used: "node:http createServer handleRequest for GET /health",
				skipped: "frameworks routers and extra modules",
			};
			return [
				{
					tool_calls: [
						{
							name: "write",
							arguments: {
								path: `.kpi/runs/${jobId}/candidate.json`,
								content: JSON.stringify(candidate, null, 2) + "\n",
							},
						},
					],
					finish_reason: "tool_calls",
				},
			];
		}
		if (tools.has("write") && wroteCandidate && !wroteServer && !denied) {
			const server = `import { createServer } from "node:http";

export function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

export function createApp() {
  return createServer(handleRequest);
}
`;
			return [
				{
					tool_calls: [
						{
							name: "write",
							arguments: {
								path: "src/health/server.js",
								content: server,
							},
						},
					],
					finish_reason: "tool_calls",
				},
			];
		}
		return [
			{
				content:
					"Implemented GET /health returning {status:\"ok\"} under src/health/server.js and recorded the ladder decision.",
				finish_reason: "stop",
			},
		];
	}

// Plan: engine response contract requires JSON matching stack.schema.json.
	// The graph engine writes stack.json; assistant text is the only source.
	if (
		/Check the frozen task contract/i.test(blob) ||
		/Produce an implementation plan/i.test(blob) ||
		/stack\.schema\.json/i.test(blob) ||
		(/stack\.json/i.test(blob) && /Return only JSON matching/i.test(blob))
	) {
		const stack = {
			version: 1,
			shape: "dune",
			delivery: "vertical",
			root: "src",
			scaffold_first: true,
			current_module_id: "health",
			modules: [
				{
					id: "health",
					purpose: "HTTP healthcheck endpoint returning {status:\"ok\"} and its tests",
					folder: "src/health",
					interface: "src/health/server.js",
					allowed_paths: ["src/health/**", "test/health/**"],
					depends_on: [],
				},
			],
		};
		return [
			{
				content: JSON.stringify(stack),
				finish_reason: "stop",
			},
		];
	}
	// Specify / ac-compiler prose (no stack response contract)
	if (/specification/i.test(blob) || /acceptance criteria/i.test(blob)) {
		return [
			{
				content:
					"Spec: GET /health returns {status:\"ok\"}; npm test green; writes only src/health/** and test/health/**.",
				finish_reason: "stop",
			},
		];
	}

	return [{ content: "loop-agent default", finish_reason: "stop" }];
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
	let effective = scene;
	if (scene?.dynamic === "loop-agent") {
		effective = { ...scene, turns: dynamicLoopTurns(body) };
	}
	const msgRoles = (body?.messages ?? []).map((m) => m?.role);
	const toolTexts = toolResultTexts(body).map((s) => String(s).slice(0, 120));
	logRequest({
		at: new Date().toISOString(),
		matched_node,
		model: body?.model ?? null,
		tools,
		prompt_sha256: sha256(promptBlob(body)),
		auth_token_sha256: authHash,
		response_status: effective.status && effective.status >= 400 ? effective.status : 200,
		dynamic: scene?.dynamic || null,
		msg_roles: msgRoles,
		tool_text_samples: toolTexts.slice(0, 4),
		has_tool_result: hasToolResult(body),
	});
	streamCompletion(res, body, effective, { matched_node });
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
