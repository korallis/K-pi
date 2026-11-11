#!/usr/bin/env node
/** Unattended native-runtime acceptance. Synthetic loopback provider grants do
 * not establish vendor subscription eligibility or attended OAuth compatibility. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startRebuildProvider } from "./metric-fixtures/rebuild-provider.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const driverPath = join(root, "scripts/metric-fixtures/rebuild-driver.mjs");
const guardPath = join(root, "uat/egress-guard.cjs");
const peerNames = ["alpha", "beta", "gamma"];
const digest = (data) => createHash("sha256").update(data).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const messages = (observation) => observation.events.filter((event) => event.type === "message").map((event) => event.message);

function launch(mode, project, baseUrl, env, evidence) {
	const child = spawn(process.execPath, [driverPath, mode, project, baseUrl], { cwd: project, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	const log = join(evidence, `${mode}-process.jsonl`);
	const pending = new Map();
	let readyResolve;
	let readyReject;
	const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
	const bootTimer = setTimeout(() => readyReject(new Error(`${mode} native runtime did not become ready in 60s`)), 60000);
	const exited = new Promise((resolveExit) => child.once("close", (code, signal) => resolveExit({ code, signal })));
	const fail = (error) => {
		clearTimeout(bootTimer);
		readyReject(error);
		for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
		pending.clear();
	};
	child.stdout.on("data", (chunk) => appendFileSync(join(evidence, `${mode}.stdout`), chunk));
	child.stderr.on("data", (chunk) => appendFileSync(join(evidence, `${mode}.stderr`), chunk));
	child.on("error", fail);
	child.on("exit", (code, signal) => fail(new Error(`${mode} native owner exited (${code ?? signal})`)));
	child.on("message", (message) => {
		appendFileSync(log, `${JSON.stringify(message)}\n`);
		if (message.type === "ready") { clearTimeout(bootTimer); readyResolve(message.value); }
		else if (message.type === "fatal") fail(new Error(message.error));
		else {
			const request = pending.get(message.id);
			if (!request) return;
			pending.delete(message.id);
			clearTimeout(request.timer);
			message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
		}
	});
	return {
		child, ready, exited,
		request(method, params) {
			return new Promise((resolveRequest, rejectRequest) => {
				const id = randomUUID();
				const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`${mode}/${method} exceeded 40s`)); }, 40000);
				pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
				child.send({ id, method, params }, (error) => { if (error) fail(error); });
			});
		},
		async terminate(signal = "SIGTERM") {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return exited;
			child.kill(signal);
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			try { return await exited; } finally { clearTimeout(timer); }
		},
	};
}

export async function collectRebuildRuntime(proofRoot) {
	const evidenceRoot = join(resolve(proofRoot), "RP-22-runtime");
	await mkdir(evidenceRoot, { recursive: true });
	const evidence = await mkdtemp(join(evidenceRoot, "run-"));
	const checks = [];
	const processes = [];
	let sandbox;
	let provider;
	let failure;
	const record = async (name, value) => { const path = join(evidence, name); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); return path; };
	const check = (id, ok, observed, artifact) => checks.push({ id, ok: Boolean(ok), observed: typeof observed === "string" ? observed : JSON.stringify(observed), artifact: join(evidence, artifact) });
	try {
		const enginePath = join(root, "packages/coding-agent/dist/kpi/extensions/graph/engine.js");
		const packagePath = join(root, "packages/coding-agent/package.json");
		await record("artifact.json", { version: JSON.parse(await readFile(packagePath, "utf8")).version, enginePath, engineSha256: digest(await readFile(enginePath)), driverPath, provider: "controlled loopback OpenAI transport", credentials: "synthetic local grant; no vendor eligibility assertion" });
		sandbox = await mkdtemp(join(tmpdir(), "kpi-rebuild-native-"));
		const project = join(sandbox, "project");
		const home = join(sandbox, "home");
		const agentDir = join(home, ".kpi", "agent");
		await mkdir(project, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		provider = await startRebuildProvider(join(evidence, "provider.jsonl"));
		const configs = {
			"settings.json": { defaultProvider: "local-openai", defaultModel: "rebuild-local" },
			"accounts.json": { version: 1, pools: { "local-openai": { strategy: "round-robin", slots: [{ id: "synthetic", kind: "local", label: "synthetic loopback", baseUrl: provider.baseUrl }] } }, fallback: ["local-openai"], stickiness: "session-until-exhausted" },
			"local-openai-models.json": { version: 2, origins: { "rebuild-local": provider.baseUrl }, models: [{ id: "rebuild-local", name: "rebuild-local", baseUrl: provider.baseUrl, contextWindow: 128000, maxTokens: 4096, metadataSources: { contextWindow: "operator", maxTokens: "operator" } }] },
			"auth.json": { "local-openai": { type: "api_key", key: "rebuild-synthetic-local-grant" } },
		};
		for (const [name, value] of Object.entries(configs)) await writeFile(join(agentDir, name), `${JSON.stringify(value, null, 2)}\n`);
		// Whitelist environment rather than inheriting real grants, proxy settings,
		// extension paths or user NODE_OPTIONS into this isolated native process.
		const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), KPI_CODING_AGENT_DIR: agentDir, CI: "1", PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1", NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`, UAT_EGRESS_LOG: join(evidence, "egress.jsonl") };
		const start = (mode) => { const process = launch(mode, project, provider.baseUrl, env, evidence); processes.push(process); return process; };
		const first = start("initial");
		await first.ready;
		const initial = await first.request("settled", peerNames.map((peer) => ({ peer, id: `initial-${peer}` })));
		await record("initial.json", initial);
		const initialState = initial.state;
		check("RP22-native-three", initial.peers.length === 3 && initialState.status === "interrupted" && peerNames.every((name) => initialState.nodes[name].runs === 1 && initial.peers.find((peer) => peer.agentId === `rebuild-native/${name}`)?.rooms.includes("rebuild-room")) && new Set(peerNames.map((name) => initialState.nodes[name].sessionId)).size === 3, { peers: initial.peers, nodes: initialState.nodes, status: initialState.status }, "initial.json");
		const toolResults = initial.sessions.filter(({ record }) => record.type === "message" && record.message?.role === "toolResult");
		check("RP22-native-readonly", toolResults.some(({ path, record }) => path.startsWith("gamma/") && record.message.toolName === "write" && record.message.isError === true) && !existsSync(join(project, "forbidden.txt")) && peerNames.every((name) => toolResults.some(({ path, record }) => path.startsWith(`${name}/`) && record.message.toolName === "read" && !record.message.isError && JSON.stringify(record.message.content).includes("REBUILD_CANDIDATE"))), "Each real session read candidate.txt; reviewer write attempt produced a native error and no file", "initial.json");

		await first.request("send", { to: "rebuild-native/alpha", id: "host-direct", text: "REBUILD_DIRECT" });
		const direct = await first.request("settled", [{ peer: "alpha", id: "host-direct" }, { peer: "beta", id: "native-direct" }, { peer: "alpha", id: "receipt-native-direct-beta" }]);
		await record("direct.json", direct);
		const directMessage = messages(direct).find((message) => message.id === "native-direct");
		check("RP22-native-direct", directMessage?.sender === "rebuild-native/alpha" && same(directMessage.recipients, ["rebuild-native/beta"]) && messages(direct).some((message) => message.id === "receipt-native-direct-beta" && message.sender === "rebuild-native/beta" && message.replyTo === "native-direct") && peerNames.every((name) => direct.state.nodes[name].runs === 1 && direct.state.nodes[name].sessionId === initialState.nodes[name].sessionId), { directMessage, assignmentsRetained: direct.state.nodes }, "direct.json");

		await first.request("send", { to: "rebuild-native/alpha", id: "host-room", text: "REBUILD_ROOM" });
		const room = await first.request("settled", [{ peer: "alpha", id: "host-room" }, ...["beta", "gamma"].flatMap((peer) => [{ peer, id: "native-room" }, { peer: "alpha", id: `receipt-native-room-${peer}` }])]);
		await record("room.json", room);
		const roomMessage = messages(room).find((message) => message.id === "native-room");
		check("RP22-native-room", roomMessage?.sender === "rebuild-native/alpha" && roomMessage.room === "rebuild-room" && same([...roomMessage.recipients].sort(), ["rebuild-native/beta", "rebuild-native/gamma"]) && ["beta", "gamma"].every((peer) => messages(room).some((message) => message.id === `receipt-native-room-${peer}` && message.sender === `rebuild-native/${peer}` && message.replyTo === "native-room")), { roomMessage, receipts: messages(room).filter((message) => message.replyTo === "native-room") }, "room.json");
		const negative = [];
		for (const params of [{ to: "missing-peer", text: "must fail" }, { to: "rebuild-native/alpha", text: "must fail", sender: "rebuild-native/beta" }, { to: "rebuild-native/alpha", id: "host-direct", text: "conflicting duplicate" }]) {
			try { await first.request("send", params); negative.push({ params, rejected: false }); }
			catch (error) { negative.push({ params, rejected: true, error: error.message }); }
		}
		await record("rejected-envelopes.json", negative);
		check("RP22-native-failure-boundaries", negative.every((result, index) => result.rejected && [/unknown peer/u, /unsupported peer request field/u, /different envelope/u][index].test(result.error)), negative, "rejected-envelopes.json");

		const death = await first.terminate("SIGKILL");
		await record("owner-death.json", { pid: first.child.pid, ...death });
		const offlineOwner = start("offline");
		const offline = await offlineOwner.ready;
		await record("offline.json", offline);
		await offlineOwner.terminate();
		const replayMessage = messages(offline).find((message) => message.id === "offline-replay");
		check("RP22-native-offline", death.signal === "SIGKILL" && replayMessage?.recipients[0] === "rebuild-native/beta" && offline.peers.find((peer) => peer.agentId === "rebuild-native/beta").cursor < replayMessage.sequence && !messages(offline).some((message) => message.id === "receipt-offline-replay-beta"), { ownerDeath: death, queued: replayMessage, peers: offline.peers }, "offline.json");
		const restarted = start("restart");
		const restored = await restarted.ready;
		await record("restored.json", restored);
		check("RP22-native-restart", restarted.child.pid !== first.child.pid && peerNames.every((name) => {
			const previous = initial.peers.find((peer) => peer.agentId === `rebuild-native/${name}`);
			const current = restored.peers.find((peer) => peer.agentId === previous.agentId);
			return current && current.incarnation !== previous.incarnation && current.sessionPath === previous.sessionPath && current.taskId === previous.taskId && same(current.descriptor, previous.descriptor) && same(current.rooms, previous.rooms) && restored.state.nodes[name].runs === 1 && restored.state.nodes[name].sessionId === initialState.nodes[name].sessionId;
		}), { oldPid: first.child.pid, newPid: restarted.child.pid, peers: restored.peers, nodes: restored.state.nodes }, "restored.json");
		const replay = await restarted.request("settled", [{ peer: "beta", id: "offline-replay" }, { peer: "alpha", id: "receipt-offline-replay-beta" }]);
		await record("replay.json", replay);
		check("RP22-native-replay", messages(replay).filter((message) => message.id === "offline-replay").length === 1 && messages(replay).filter((message) => message.id === "receipt-offline-replay-beta" && message.sender === "rebuild-native/beta" && message.replyTo === "offline-replay").length === 1 && replay.peers.find((peer) => peer.agentId === "rebuild-native/beta").cursor >= replayMessage.sequence, { messages: messages(replay), peers: replay.peers }, "replay.json");
		check("RP22-native-protected-intent", [direct, room, offline, restored, replay].every((value) => value.taskHash === initial.taskHash && same(value.intent, initial.intent)) && same(replay.state.definition, initialState.definition) && replay.state.status === "interrupted" && replay.state.values.operator?.approved !== true && peerNames.every((name) => replay.state.nodes[name].runs === 1), { hash: replay.taskHash, intent: replay.intent, status: replay.state.status, values: replay.state.values }, "replay.json");
		await restarted.request("stop");
	} catch (error) {
		failure = error.stack ?? String(error);
		await record("failure.json", { error: failure });
		check("RP22-native-completion", false, failure, "failure.json");
	} finally {
		const cleanupErrors = [];
		for (const process of processes) {
			try { await process.terminate(); } catch (error) { cleanupErrors.push(error.stack ?? String(error)); }
		}
		if (provider) {
			try { await provider.close(); } catch (error) { cleanupErrors.push(error.stack ?? String(error)); }
		}
		if (sandbox) {
			try {
				await cp(sandbox, join(evidence, "sandbox"), { recursive: true });
				await rm(sandbox, { recursive: true, force: true });
			} catch (error) { cleanupErrors.push(`Raw sandbox retained at ${sandbox}: ${error.stack ?? String(error)}`); }
		}
		if (cleanupErrors.length) {
			failure = [failure, ...cleanupErrors].filter(Boolean).join("\n");
			await record("cleanup-failure.json", { errors: cleanupErrors });
			check("RP22-native-cleanup", false, cleanupErrors, "cleanup-failure.json");
		}
	}
	const egressPath = join(evidence, "egress.jsonl");
	const egress = existsSync(egressPath) ? readFileSync(egressPath, "utf8") : "";
	if (!existsSync(egressPath)) await writeFile(egressPath, "");
	check("RP22-native-loopback-only", egress.trim() === "", egress || "All native processes preloaded the deny-nonloopback guard; no forbidden connection attempts", "egress.jsonl");
	const result = { pass: checks.length >= 10 && checks.every((entry) => entry.ok), scope: { kind: "automated", vendor_authentication: "not_exercised" }, checks, evidence, detail: failure ?? "Built native AgentSession peers: real read/communicate/peers tools, idle direct wake, room fanout, persisted acknowledgements, killed owner, offline queue, restored identities and sessions, protected intent and read-only refusal. Controlled loopback provider with synthetic grants; vendor eligibility and attended login are not proven." };
	await record("result.json", result);
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	let jsonPath;
	let proofRoot = join(root, ".kpi", "proof");
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--json" && args[index + 1]) jsonPath = resolve(args[++index]);
		else if (args[index] === "--proof-root" && args[index + 1]) proofRoot = resolve(args[++index]);
		else throw new Error(`Usage: node scripts/rebuild-runtime-smoke.mjs [--json path] [--proof-root directory]; unknown or incomplete argument ${args[index]}`);
	}
	const result = await collectRebuildRuntime(proofRoot);
	if (jsonPath) { await mkdir(dirname(jsonPath), { recursive: true }); await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`); }
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	process.exitCode = result.pass ? 0 : 1;
}
