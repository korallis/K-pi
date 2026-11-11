import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const JOB = "rebuild-native";
const text = (content) => typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");

// Only provider transport is scripted. Every tool request below is executed by
// the built native AgentSession; no fixture touches the job or peer journal.
function response(body) {
	const messages = body.messages ?? [];
	const userIndex = messages.findLastIndex((message) => message.role === "user" && /^(?:REBUILD_INITIAL:|Peer message)/.test(text(message.content)));
	const prompt = text(messages[userIndex]?.content);
	const results = messages.slice(userIndex + 1).filter((message) => message.role === "tool");
	const step = results.length;
	const call = (name, args) => ({ name, args });
	if (prompt.startsWith("Peer message")) {
		const envelope = JSON.parse(prompt.split("\n")[1]);
		const marker = `REBUILD_DONE:${envelope.id}`;
		let actions;
		if (envelope.text === "REBUILD_DIRECT") {
			actions = [call("peers", { action: "discover" }), call("communicate", { to: `${JOB}/beta`, message: "REBUILD_PAYLOAD:direct", id: "native-direct" }), call("peers", { action: "ack", id: envelope.id })];
		} else if (envelope.text === "REBUILD_ROOM") {
			actions = [call("communicate", { room: "rebuild-room", message: "REBUILD_PAYLOAD:room", id: "native-room" }), call("peers", { action: "ack", id: envelope.id })];
		} else if (envelope.text.startsWith("REBUILD_PAYLOAD:")) {
			const ownId = envelope.recipients.length === 1 ? envelope.recipients[0] : undefined;
			// Discover is deliberately real. Its result identifies this conversation's
			// peer by the original assignment marker retained in the transcript.
			const initial = messages.filter((message) => message.role === "user").map((message) => text(message.content)).join("\n").match(/REBUILD_INITIAL:(alpha|beta|gamma)/)?.[1];
			const peerId = ownId ?? `${JOB}/${initial}`;
			actions = [call("read", { path: "candidate.txt" }), call("communicate", { to: `${JOB}/alpha`, message: `REBUILD_RECEIPT:${envelope.id}:${peerId}`, id: `receipt-${envelope.id}-${peerId.split("/").at(-1)}`, replyTo: envelope.id }), call("peers", { action: "ack", id: envelope.id })];
		} else if (envelope.text.startsWith("REBUILD_RECEIPT:")) {
			actions = [call("peers", { action: "ack", id: envelope.id })];
		} else {
			throw new Error(`Unknown peer transport instruction: ${envelope.text}`);
		}
		return step < actions.length ? { tool: actions[step] } : { content: marker };
	}
	const peer = prompt.match(/REBUILD_INITIAL:(alpha|beta|gamma)/)?.[1];
	if (!peer) throw new Error("Provider received an unexpected assignment");
	const actions = [call("read", { path: "candidate.txt" }), call("peers", { action: "join", room: "rebuild-room" }), call("peers", { action: "discover" })];
	if (peer === "gamma") actions.push(call("write", { path: "forbidden.txt", content: "must not be written" }));
	return step < actions.length ? { tool: actions[step] } : { content: `REBUILD_DONE:initial-${peer}` };
}

export async function startRebuildProvider(logPath) {
	let serial = 0;
	const server = createServer(async (req, res) => {
		try {
			if (req.method === "GET" && req.url === "/v1/models") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "rebuild-local", object: "model" }] }));
				return;
			}
			if (req.method !== "POST" || req.url !== "/v1/chat/completions") throw new Error(`Unexpected provider route ${req.method} ${req.url}`);
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			appendFileSync(logPath, `${JSON.stringify({ route: req.url, request: body })}\n`);
			const reply = response(body);
			const id = `rebuild-${++serial}`;
			appendFileSync(logPath, `${JSON.stringify({ id, route: req.url, model: body.model, request: body, response: reply })}\n`);
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {}) })}\n\n`);
			chunk(reply.tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${serial}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] } : { role: "assistant", content: reply.content });
			chunk({}, reply.tool ? "tool_calls" : "stop");
			res.end("data: [DONE]\n\n");
		} catch (error) {
			appendFileSync(logPath, `${JSON.stringify({ error: error.stack })}\n`);
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: error.message } }));
		}
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
