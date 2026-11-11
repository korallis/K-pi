import { watch } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GraphEngine } from "../../packages/coding-agent/dist/kpi/extensions/graph/engine.js";
import { getOrCreateBackgroundBus } from "../../packages/coding-agent/dist/kpi/extensions/bus/spawn.js";
import { PeerRuntime } from "../../packages/coding-agent/dist/kpi/extensions/bus/peer-runtime.js";
import { contractHash, createJob, readTaskForJob } from "../../packages/coding-agent/dist/kpi/extensions/run-store.js";

const [mode, projectRoot, baseUrl] = process.argv.slice(2);
const jobId = "rebuild-native";
const runDirectory = join(projectRoot, ".kpi", "runs", jobId);
const roles = { alpha: "researcher", beta: "diagnostic", gamma: "reviewer" };
const task = { job_id: jobId, mode: "gated", goal: "Inspect candidate.txt without changing the checkout or the accepted objective", nongoals: ["Do not publish a release"], acceptance: [], constraints: ["Read-only peer assignments"], quality_gates: [], ac: { quality: "narrative" } };
const model = { id: "rebuild-local", name: "rebuild-local", provider: "local-openai", api: "openai-completions", baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const options = { projectRoot, jobId, model, intentHash: contractHash(task) };
let engine;
let bus;
let runtime;

async function sessionRecords() {
	const directory = join(runDirectory, "agents");
	const records = [];
	let paths;
	try { paths = await readdir(directory, { recursive: true }); } catch (error) { if (error.code === "ENOENT") return records; throw error; }
	for (const path of paths.filter((name) => name.endsWith(".jsonl"))) {
		const source = await readFile(join(directory, path), "utf8");
		for (const line of source.split("\n").filter(Boolean)) {
			try { records.push({ path, record: JSON.parse(line) }); } catch { /* A current append is observed again on its next filesystem event. */ }
		}
	}
	return records;
}

async function snapshot() {
	const events = (await readFile(join(runDirectory, "peer-events.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
	return { pid: process.pid, state: engine?.state, peers: runtime.list(), events, sessions: await sessionRecords(), taskHash: contractHash(await readTaskForJob(projectRoot, jobId)), intent: JSON.parse(await readFile(join(runDirectory, "intent.json"), "utf8")) };
}

// No sleeps or echoed delivery callbacks: completion is a persisted assistant
// result plus the broker's real acknowledgement cursor. Watch before reading
// so an append between registration and the first inspection is not lost.
async function awaitSettled(markers) {
	return new Promise((resolve, reject) => {
		let checking = false;
		let dirty = true;
		let finished = false;
		const finish = (error, value) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			watcher.close();
			error ? reject(error) : resolve(value);
		};
		const inspect = async () => {
			dirty = true;
			if (checking || finished) return;
			checking = true;
			try {
				while (dirty && !finished) {
					dirty = false;
					const observed = await snapshot();
					const done = markers.every(({ peer, id }) => observed.sessions.some(({ path, record }) => path.startsWith(`${peer}/`) && record.type === "message" && record.message?.role === "assistant" && record.message.content?.some((part) => part.type === "text" && part.text === `REBUILD_DONE:${id}`)));
					const acknowledged = observed.events.filter((event) => event.type === "message").every(({ message }) => message.recipients.every((id) => observed.peers.find((peer) => peer.agentId === id)?.cursor >= message.sequence));
					if (done && acknowledged) finish(null, observed);
				}
			} catch (error) { finish(error); }
			finally { checking = false; }
		};
		const watcher = watch(runDirectory, { recursive: true }, () => void inspect());
		watcher.on("error", (error) => finish(error));
		const timer = setTimeout(() => finish(new Error(`Native peer results did not settle within 30s: ${JSON.stringify(markers)}`)), 30000);
		void inspect();
	});
}

async function boot() {
	if (process.env.UAT_EGRESS_GUARD !== "1") throw new Error("Built runtime must run under the loopback egress guard");
	if (mode === "offline") {
		runtime = await PeerRuntime.open(runDirectory);
		const before = runtime.list();
		const sent = await runtime.send("host", { to: `${jobId}/beta`, id: "offline-replay", text: "REBUILD_PAYLOAD:replay" });
		const observation = await snapshot();
		await runtime.close();
		process.send({ type: "ready", value: { before, sent, ...observation } });
		return;
	}
	if (mode === "initial") {
		await mkdir(projectRoot, { recursive: true });
		await writeFile(join(projectRoot, "candidate.txt"), "REBUILD_CANDIDATE: immutable native peer evidence\n");
		await createJob(projectRoot, task);
		const definition = {
			schemaVersion: 2, id: "rebuild-runtime", entry: "alpha", intentHash: contractHash(task), limits: { maxConcurrency: 3 },
			policy: { allowNonInteractive: false, allowNonInteractiveMutations: false, confirmProjectGraph: true, confirmMutatingNodes: true },
			nodes: [...Object.entries(roles).map(([id, role]) => ({ id, type: "agent", role, prompt: `REBUILD_INITIAL:${id}\nRead candidate.txt; join rebuild-room; discover peers. Never change accepted intent.`, readOnly: true, tools: ["read"], context: { mode: "thread", threadKey: id } })), { id: "wait", type: "human", title: "Retained operator authority", question: "Continue?", statePath: "operator.approved" }],
			edges: [{ from: "alpha", to: "beta" }, { from: "beta", to: "gamma" }, { from: "gamma", to: "wait" }],
		};
		engine = new GraphEngine(definition, options);
	} else if (mode === "restart") {
		engine = await GraphEngine.restore(options);
	} else throw new Error(`Unknown driver mode ${mode}`);
	bus = getOrCreateBackgroundBus(projectRoot, runDirectory, jobId);
	runtime = await bus.peers();
	await engine.runUntilPause();
	process.send({ type: "ready", value: await snapshot() });
}

process.on("message", async ({ id, method, params }) => {
	try {
		let value;
		if (method === "snapshot") value = await snapshot();
		else if (method === "send") value = await runtime.send("host", params);
		else if (method === "settled") value = await awaitSettled(params);
		else if (method === "stop") {
			engine?.dispose();
			if (bus) await bus.stopAll();
			else await runtime?.close();
			process.send({ id, value: { stopped: true } }, () => process.exit(0));
			return;
		} else throw new Error(`Unknown driver command ${method}`);
		process.send({ id, value });
	} catch (error) {
		let observation;
		try { observation = await snapshot(); } catch (snapshotError) { observation = { error: snapshotError.stack }; }
		process.send({ id, error: error.stack, observation });
	}
});

boot().catch((error) => {
	process.send?.({ type: "fatal", error: error.stack });
	process.exitCode = 1;
});
