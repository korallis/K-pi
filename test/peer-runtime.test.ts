import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolExecutionEndEvent,
} from "../packages/coding-agent/src/core/extensions/types.ts";
import { registerBackgroundBus } from "../packages/coding-agent/src/kpi/extensions/bus/communicate.ts";
import { mintWorkerDescriptor } from "../packages/coding-agent/src/kpi/extensions/bus/identity.ts";
import {
	assertWriterAuthority,
	bindSessionWriterAuthority,
	claimLease,
	type LeaseOwner,
	leaseLockPath,
	readLeasesFile,
	releaseLease,
	releaseWriterAuthority,
	reserveWriterAuthority,
	workspaceOwnershipDirectory,
} from "../packages/coding-agent/src/kpi/extensions/bus/leases.ts";
import {
	PeerClient,
	type PeerMessage,
	type PeerRecord,
	PeerRuntime,
	readPeerMessages,
} from "../packages/coding-agent/src/kpi/extensions/bus/peer-runtime.ts";
import { WorkerProtocol } from "../packages/coding-agent/src/kpi/extensions/bus/protocol.ts";
import { isWriterToolSet, ROLE_TOOLS, type WorkerRole } from "../packages/coding-agent/src/kpi/extensions/bus/roles.ts";
import { BackgroundBus, createWorkerAdmission } from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import { createJob } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

function peer(directory: string, role: WorkerRole): Omit<PeerRecord, "incarnation" | "rooms" | "cursor"> {
	const agentId = `${role}-stable`;
	return {
		agentId,
		descriptor: mintWorkerDescriptor({
			agentId,
			role,
			jobId: "job-peers",
			runDirectory: directory,
			tools: ROLE_TOOLS[role],
			capabilityId: "publication-bearer-not-a-transport-key",
		}),
		sessionPath: join(directory, "agents", `${agentId}.jsonl`),
		taskId: "task-one",
		prompt: "work",
	};
}

test("three authenticated peers discover, address rooms, replay offline messages and retain identity after owner restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-peer-replay-"));
	let runtime: PeerRuntime | undefined;
	const clients: PeerClient[] = [];
	try {
		runtime = await PeerRuntime.open(directory);
		const peers = [peer(directory, "implementer"), peer(directory, "tester"), peer(directory, "reviewer")];
		const endpoints = [];
		for (const record of peers) endpoints.push(await runtime.activate(record));
		for (const endpoint of endpoints) clients.push(await PeerClient.connect(endpoint));
		const discovered = (await clients[0].request("discover")) as Array<{ agentId: string; presence: string }>;
		assert.deepEqual(discovered.map((record) => record.agentId).sort(), peers.map((record) => record.agentId).sort());
		assert.ok(discovered.every((record) => record.presence === "online"));
		await Promise.all(clients.map((client) => client.request("join", { room: "review" })));
		const delivered = Promise.withResolvers<PeerMessage>();
		runtime.attachDelivery(peers[1].agentId, async (message) => {
			delivered.resolve(message);
		});
		await clients[0].request("send", { id: "direct-1", to: peers[1].agentId, text: "run gate" });
		assert.equal((await delivered.promise).sender, peers[0].agentId);
		assert.deepEqual(
			(await readPeerMessages(directory, peers[2].agentId)).map((message) => message.id),
			[],
		);
		await clients[1].request("ack", { id: "direct-1" });

		clients[2].close();
		runtime.deactivate(peers[2].agentId);
		const first = (await clients[0].request("send", { id: "room-1", room: "review", text: "new revision" })) as {
			message: PeerMessage;
		};
		const duplicate = (await clients[0].request("send", { id: "room-1", room: "review", text: "new revision" })) as {
			message: PeerMessage;
			duplicate: boolean;
		};
		assert.equal(duplicate.duplicate, true);
		assert.equal(duplicate.message.sequence, first.message.sequence);
		await assert.rejects(
			clients[0].request("send", { id: "room-1", room: "review", text: "different bytes" }),
			/different envelope/u,
		);
		await assert.rejects(
			clients[0].request("send", { sender: peers[2].agentId, to: peers[1].agentId, text: "forged" }),
			/unsupported.*field/u,
		);
		await assert.rejects(clients[0].request("publish", { path: "verdict.json", content: {} }), /cannot publish/u);
		await assert.rejects(clients[2].request("heartbeat"), /closed|timeout/u);
		await assert.rejects(PeerClient.connect({ ...endpoints[0], agentId: endpoints[1].agentId }), /authentication/u);
		await assert.rejects(clients[0].request("ack", { id: "room-1" }), /outside peer inbox/u);

		for (const client of clients) client.close();
		await runtime.close();
		await appendFile(join(directory, "peer-events.jsonl"), '{"type":"message","torn":');
		runtime = await PeerRuntime.open(directory);
		const recovered = runtime.get(peers[2].agentId)!;
		assert.equal(recovered.agentId, peers[2].agentId);
		assert.equal(recovered.sessionPath, peers[2].sessionPath);
		assert.equal(recovered.taskId, "task-one");
		assert.deepEqual(recovered.rooms, ["review"]);
		const endpoint = await runtime.activate(peers[2]);
		assert.notEqual(endpoint.incarnation, endpoints[2].incarnation);
		await assert.rejects(PeerClient.connect(endpoints[2]), /authentication/u);
		const restored = await PeerClient.connect(endpoint);
		clients.push(restored);
		const inbox = (await restored.request("inbox")) as { messages: PeerMessage[] };
		assert.deepEqual(
			inbox.messages.map((message) => message.id),
			["room-1"],
		);
		await restored.request("ack", { id: "room-1" });
		assert.deepEqual(((await restored.request("inbox")) as { messages: PeerMessage[] }).messages, []);
		assert.deepEqual(
			((await restored.request("inbox", { after: 0 })) as { messages: PeerMessage[] }).messages.map(
				(message) => message.id,
			),
			["room-1"],
		);
		const journal = await readFile(join(directory, "peer-events.jsonl"), "utf8");
		assert.ok(!journal.includes("publication-bearer-not-a-transport-key"));
		assert.ok(!journal.includes(endpoints[0].capability));
		assert.deepEqual(
			(await readPeerMessages(directory, peers[2].agentId, "other-task")).map((message) => message.id),
			[],
		);
	} finally {
		for (const client of clients) client.close();
		try {
			await runtime?.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("inbox acknowledgements cannot skip unhandled messages or change another peer's cursor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-peer-cursors-"));
	let runtime: PeerRuntime | undefined;
	const clients: PeerClient[] = [];
	try {
		runtime = await PeerRuntime.open(directory);
		const writer = peer(directory, "implementer");
		const reader = peer(directory, "reviewer");
		const a = await PeerClient.connect(await runtime.activate(writer));
		clients.push(a);
		const b = await PeerClient.connect(await runtime.activate(reader));
		clients.push(b);
		await a.request("send", { id: "one", to: reader.agentId, text: "first" });
		await a.request("send", { id: "two", to: reader.agentId, text: "second", replyTo: "one" });
		await assert.rejects(b.request("ack", { id: "two" }), /in order/u);
		await assert.rejects(b.request("ack", { id: "one", agentId: writer.agentId }), /unsupported.*field/u);
		await b.request("ack", { id: "one" });
		await b.request("ack", { id: "one" });
		assert.deepEqual(
			((await b.request("inbox")) as { messages: PeerMessage[] }).messages.map((message) => message.id),
			["two"],
		);
		await assert.rejects(PeerRuntime.open(directory), /already owned|EEXIST/u);
		await assert.rejects(a.request("send", { to: reader.agentId, text: "x".repeat(32_001) }), /invalid message/u);
	} finally {
		for (const client of clients) client.close();
		try {
			await runtime?.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("one shell-capable writer plus two readonly peers fit configurable admission and ownership survives failed stop", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-peer-ownership-"));
	const admission = createWorkerAdmission({ maxWorkers: 3 });
	const exiting = Promise.withResolvers<void>();
	const enteredStop = Promise.withResolvers<void>();
	const job = await createJob(directory, {
		goal: "ownership",
		mode: "gated",
		job_id: "job-peers",
		nongoals: [],
		acceptance: [],
		constraints: [],
		quality_gates: [],
		ac: { quality: "executable" },
	});
	let nextPid = 10_000;
	const alive = new Set<number>();
	let failStop = true;
	const bus = new BackgroundBus(directory, job.directory, job.jobId, {
		admission,
		isProcessAlive: (pid) => alive.has(pid),
		launcher: async () => {
			const pid = nextPid++;
			alive.add(pid);
			const stdin = new PassThrough();
			const stdout = new PassThrough();
			const protocol = new WorkerProtocol({ stdin, stdout });
			stdin.on("data", (chunk: Buffer) => {
				const command = JSON.parse(chunk.toString("utf8"));
				stdout.write(`${JSON.stringify({ id: command.id, type: "response", success: true })}\n`);
			});
			return {
				pid,
				argv: [],
				protocol,
				isAlive: () => alive.has(pid),
				stop: async () => {
					enteredStop.resolve();
					await exiting.promise;
					if (failStop) throw new Error("exit not confirmed");
					alive.delete(pid);
					protocol.close();
					stdin.destroy();
					stdout.destroy();
				},
			};
		},
	});
	try {
		assert.equal(isWriterToolSet(["read", "bash"], "implementer"), true);
		const writer = await bus.spawn({ role: "implementer", prompt: "write", tools: ["read", "bash"] });
		await bus.spawn({ role: "reviewer", prompt: "review" });
		await bus.spawn({ role: "tester", prompt: "test" });
		assert.deepEqual(admission.counts(), { workers: 3, writers: 1 });
		const stopping = bus.stop(writer.agentId);
		await enteredStop.promise;
		assert.deepEqual(admission.counts(), { workers: 3, writers: 1 });
		exiting.resolve();
		await assert.rejects(stopping, /exit not confirmed/u);
		assert.equal(bus.get(writer.agentId)?.agentId, writer.agentId);
		assert.deepEqual(admission.counts(), { workers: 3, writers: 1 });
		failStop = false;
		await bus.stop(writer.agentId);
		assert.deepEqual(admission.counts(), { workers: 2, writers: 0 });
		const reopened = await bus.restart(writer.agentId);
		assert.equal(reopened.agentId, writer.agentId);
		assert.equal(reopened.sessionPath, writer.sessionPath);
		assert.notEqual(reopened.pid, writer.pid);
		assert.equal(admission.counts().writers, 1);
	} finally {
		failStop = false;
		exiting.resolve();
		await bus.stopAll();
		await rm(directory, { recursive: true, force: true });
	}
});

interface LeaseProcess {
	owner: LeaseOwner;
	child: ChildProcess;
	request(action: string, input?: { paths?: string[]; path?: string; pid?: number }): Promise<void>;
	kill(): Promise<void>;
}

/** Real independent owners; RPC here controls only test setup, never model output. */
async function leaseProcess(cwd: string, jobId: string): Promise<LeaseProcess> {
	const module = new URL("../packages/coding-agent/src/kpi/extensions/bus/leases.ts", import.meta.url).href;
	const incarnation = randomUUID();
	const script = `
		import { join } from "node:path";
		import { reserveWriterAuthority, transferWriterAuthority, claimLease, assertWriterAuthority } from ${JSON.stringify(module)};
		const cwd = ${JSON.stringify(cwd)};
		const run = join(cwd, ".kpi", "runs", ${JSON.stringify(jobId)});
		let owner = {jobId: ${JSON.stringify(jobId)}, agentId: "implementer-stable", pid: process.pid, incarnation: ${JSON.stringify(incarnation)}};
		process.on("message", async ({id, action, paths, path, pid}) => {
			try {
				if (action === "reserve") await reserveWriterAuthority(cwd, owner, paths);
				else if (action === "claim") await claimLease(run, {...owner, key: path});
				else if (action === "assert") await assertWriterAuthority(cwd, owner, path);
				else if (action === "transfer") owner = await transferWriterAuthority(cwd, owner, pid);
				else throw new Error("unknown test action");
				process.send({id, ok:true});
			} catch (error) { process.send({id, error:String(error)}); }
		});
		process.send({ready:true});
	`;
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	const ready = Promise.withResolvers<void>();
	const exited = Promise.withResolvers<void>();
	const requests = new Map<string, PromiseWithResolvers<void>>();
	let errors = "";
	child.stderr?.on("data", (bytes: Buffer) => {
		errors += bytes.toString();
	});
	child.on("message", (value: { ready?: boolean; id?: string; error?: string }) => {
		if (value.ready) {
			ready.resolve();
			return;
		}
		if (!value.id) return;
		const request = requests.get(value.id);
		requests.delete(value.id);
		if (value.error) request?.reject(new Error(value.error));
		else request?.resolve();
	});
	child.on("error", (error) => {
		ready.reject(error);
		for (const request of requests.values()) request.reject(error);
		requests.clear();
	});
	child.on("close", () => {
		const error = new Error(`lease owner exited: ${errors}`);
		ready.reject(error);
		for (const request of requests.values()) request.reject(error);
		requests.clear();
		exited.resolve();
	});
	// Only watchdogs use the platform clock; progress is driven by actual IPC/exit events.
	const timer = setTimeout(() => {
		ready.reject(new Error("lease process startup timeout"));
		child.kill("SIGKILL");
	}, 10_000);
	const kill = async (): Promise<void> => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited.promise;
	};
	try {
		await ready.promise;
	} catch (error) {
		await kill();
		throw error;
	} finally {
		clearTimeout(timer);
	}
	const owner: LeaseOwner = { jobId, agentId: "implementer-stable", pid: child.pid!, incarnation };
	return {
		owner,
		child,
		async request(action: string, input: { paths?: string[]; path?: string; pid?: number } = {}) {
			const id = randomUUID();
			const result = Promise.withResolvers<void>();
			requests.set(id, result);
			const timeout = setTimeout(() => {
				requests.delete(id);
				result.reject(new Error("lease process request timeout"));
			}, 10_000);
			try {
				child.send({ id, action, ...input }, (error) => {
					if (error) {
						requests.delete(id);
						result.reject(error);
					}
				});
				await result.promise;
			} finally {
				clearTimeout(timeout);
				requests.delete(id);
			}
		},
		kill,
	};
}

test("independent job owners fence canonical directory descendants while disjoint scopes remain writable", {
	timeout: 30_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-checkout-scopes-"));
	const owners: LeaseProcess[] = [];
	t.after(async () => {
		try {
			await Promise.all(owners.map((owner) => owner.kill()));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	await mkdir(join(directory, "src", "a"), { recursive: true });
	await mkdir(join(directory, "src", "b"), { recursive: true });
	await symlink(join(directory, "src", "a"), join(directory, "alias"));
	await symlink(tmpdir(), join(directory, "escape"));
	const a = await leaseProcess(directory, "job-a");
	owners.push(a);
	const b = await leaseProcess(directory, "job-b");
	owners.push(b);
	try {
		await Promise.all([a.request("reserve", { paths: ["src/a"] }), b.request("reserve", { paths: ["src/b"] })]);
		await Promise.all([a.request("claim", { path: "src/a" }), b.request("claim", { path: "src/b" })]);
		await Promise.all([a.request("assert", { path: "alias/new.ts" }), b.request("assert", { path: "src/b/new.ts" })]);
		await assert.rejects(b.request("claim", { path: "./src/a/../a/new.ts" }));
		await assert.rejects(b.request("reserve", { paths: ["alias"] }));
		await assert.rejects(b.request("reserve", { paths: ["."] }));
		await assert.rejects(a.request("assert"), /writer authority/u);
		await assert.rejects(a.request("claim", { path: "escape/kpi-escape.ts" }), /escape/u);
		await assert.rejects(b.request("assert", { path: "src/a/new.ts" }));
	} finally {
		await Promise.all(owners.map((owner) => owner.kill()));
	}
});

test("SIGSTOP never releases writer authority; verified death permits restart but not stale release", {
	timeout: 30_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-checkout-restart-"));
	const owners: LeaseProcess[] = [];
	t.after(async () => {
		try {
			await Promise.all(owners.map((owner) => owner.kill()));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	let writer = await leaseProcess(directory, "job-a");
	owners.push(writer);
	const contender = await leaseProcess(directory, "job-b");
	owners.push(contender);
	try {
		await writer.request("reserve", { paths: ["."] });
		await writer.request("claim", { path: "src/a.ts" });
		const stale = writer.owner;
		writer.child.kill("SIGSTOP");
		await assert.rejects(contender.request("reserve", { paths: ["."] }));
		await writer.kill();
		writer = await leaseProcess(directory, "job-a");
		owners.push(writer);
		await writer.request("reserve", { paths: ["."] });
		await writer.request("claim", { path: "src/a.ts" });
		assert.equal(await releaseWriterAuthority(directory, stale), false);
		assert.equal(await releaseWriterAuthority(directory, { ...writer.owner, incarnation: stale.incarnation }), false);
		assert.equal(await releaseLease(join(directory, ".kpi", "runs", "job-a"), { ...stale, key: "src/a.ts" }), false);
		await writer.request("assert", { path: "src/a.ts" });
		await assert.rejects(contender.request("reserve", { paths: ["."] }));
	} finally {
		await Promise.all(owners.map((owner) => owner.kill()));
	}
});

test("owner death cannot reclaim authority transferred to its surviving process", { timeout: 30_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-checkout-orphan-"));
	const owners: LeaseProcess[] = [];
	t.after(async () => {
		try {
			await Promise.all(owners.map((owner) => owner.kill()));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	const owner = await leaseProcess(directory, "job-owner");
	owners.push(owner);
	const child = await leaseProcess(directory, "job-child");
	owners.push(child);
	const contender = await leaseProcess(directory, "job-next");
	owners.push(contender);
	try {
		await owner.request("reserve", { paths: ["."] });
		await owner.request("transfer", { pid: child.owner.pid });
		await owner.kill();
		await assert.rejects(contender.request("reserve", { paths: ["."] }));
		await child.kill();
		await contender.request("reserve", { paths: ["."] });
		await contender.request("assert");
	} finally {
		await Promise.all(owners.map((owner) => owner.kill()));
	}
});

test("simultaneous dead-lock reapers cannot unlink the winning checkout owner", { timeout: 30_000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-checkout-reapers-"));
	const owners: LeaseProcess[] = [];
	t.after(async () => {
		try {
			await Promise.all(owners.map((owner) => owner.kill()));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	const dead = await leaseProcess(directory, "job-dead");
	owners.push(dead);
	await dead.kill();
	const ownership = await workspaceOwnershipDirectory(directory);
	await writeFile(
		leaseLockPath(ownership),
		JSON.stringify({ pid: dead.owner.pid, nonce: "abandoned", at: new Date().toISOString() }),
	);
	// Also exercise a crash while a prior owner was recovering the dead lock.
	await writeFile(
		`${leaseLockPath(ownership)}.recovery`,
		JSON.stringify({ pid: dead.owner.pid, nonce: "abandoned-reaper", at: new Date().toISOString() }),
	);
	const a = await leaseProcess(directory, "job-a");
	owners.push(a);
	const b = await leaseProcess(directory, "job-b");
	owners.push(b);
	try {
		const outcomes = await Promise.allSettled([
			a.request("reserve", { paths: ["."] }),
			b.request("reserve", { paths: ["."] }),
		]);
		assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
		const winner = outcomes[0].status === "fulfilled" ? a : b;
		const loser = winner === a ? b : a;
		await winner.request("assert");
		await assert.rejects(loser.request("reserve", { paths: ["."] }));
	} finally {
		await Promise.all(owners.map((owner) => owner.kill()));
	}
});

test("parent tools hold checkout authority through execution and session bindings never authorize siblings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-parent-fence-"));
	let guard:
		| ((event: ToolCallEvent, context: ExtensionContext) => Promise<ToolCallEventResult | undefined>)
		| undefined;
	let ended: ((event: ToolExecutionEndEvent) => Promise<void>) | undefined;
	const api = {
		registerCommand() {},
		registerTool() {},
		on(name: string, handler: unknown) {
			if (name === "tool_call") guard = handler as typeof guard;
			if (name === "tool_execution_end") ended = handler as typeof ended;
		},
	};
	registerBackgroundBus(api as unknown as ExtensionAPI, { env: {} });
	const context = (sessionId: string) =>
		({ cwd: directory, sessionManager: { getSessionId: () => sessionId } }) as ExtensionContext;
	const event = (toolCallId: string, path: string) =>
		({ type: "tool_call", toolCallId, toolName: "write", input: { path, content: "x" } }) as ToolCallEvent;
	const owner: LeaseOwner = {
		jobId: "job-host",
		agentId: "implementer-host",
		pid: process.pid,
		incarnation: randomUUID(),
	};
	let unbind: (() => void) | undefined;
	try {
		assert.equal(await guard!(event("one", "src/a.ts"), context("one")), undefined);
		assert.equal((await guard!(event("two", "src/a.ts"), context("two")))?.block, true);
		await assert.rejects(reserveWriterAuthority(directory, owner, ["."]), { code: "WORKSPACE_BUSY" });
		assert.equal(await guard!(event("three", "src/b.ts"), context("two")), undefined);
		await ended!({ toolCallId: "one" } as ToolExecutionEndEvent);
		await ended!({ toolCallId: "three" } as ToolExecutionEndEvent);
		await reserveWriterAuthority(directory, owner, ["."]);
		unbind = bindSessionWriterAuthority("bound", owner);
		assert.equal(await guard!(event("host", "src/a.ts"), context("bound")), undefined);
		assert.equal((await guard!(event("other", "src/a.ts"), context("other")))?.block, true);
		await assertWriterAuthority(directory, owner);
		unbind();
		assert.equal((await guard!(event("former", "src/a.ts"), context("bound")))?.block, true);
	} finally {
		unbind?.();
		await releaseWriterAuthority(directory, owner);
		await rm(directory, { recursive: true, force: true });
	}
});

test("recovered peer owner refuses a live recorded process before rotating its incarnation", {
	timeout: 30_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-peer-owner-restart-"));
	let processOwner: LeaseProcess | undefined;
	let runtime: PeerRuntime | undefined;
	try {
		processOwner = await leaseProcess(directory, "job-peer");
		runtime = await PeerRuntime.open(directory);
		const record = peer(directory, "implementer");
		const first = await runtime.activate(record);
		await runtime.recordPid(record.agentId, processOwner.owner.pid);
		await runtime.close();
		runtime = await PeerRuntime.open(directory);
		await assert.rejects(runtime.activate(record), /previous peer process/u);
		await processOwner.kill();
		const restarted = await runtime.activate(record);
		assert.equal(restarted.agentId, first.agentId);
		assert.notEqual(restarted.incarnation, first.incarnation);
		await assert.rejects(PeerClient.connect(first), /authentication/u);
	} finally {
		try {
			await processOwner?.kill();
		} finally {
			try {
				await runtime?.close();
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	}
});

test("prototype-shaped path names are persisted and fenced like ordinary candidate paths", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-lease-key-"));
	const run = join(directory, ".kpi", "runs", "job-a");
	const owner: LeaseOwner = { jobId: "job-a", agentId: "implementer-a", pid: process.pid, incarnation: randomUUID() };
	try {
		await claimLease(run, { ...owner, key: "__proto__" });
		assert.equal(
			Object.getOwnPropertyDescriptor(await readLeasesFile(run), "__proto__")?.value.agent_id,
			owner.agentId,
		);
		await assert.rejects(reserveWriterAuthority(directory, { ...owner, jobId: "job-b" }, ["."]), {
			code: "WORKSPACE_BUSY",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
