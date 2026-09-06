import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, realpath, stat, truncate, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { attachBoundedJsonlReader, writeRecordBounded } from "./framing.ts";
import type { WorkerDescriptor } from "./identity.ts";
import { defaultIsProcessAlive, WorkspaceBusyError, withLeaseLock } from "./leases.ts";
import type { DeliverAs } from "./protocol.ts";

const MAX_RECORD = 128_000;
const MAX_EVENTS = 100_000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_PENDING = 64;
const REQUEST_TIMEOUT = 30_000;
export const PEER_ENDPOINT_ENV = "KPI_PEER_ENDPOINT";
export interface PeerEndpoint {
	socketPath: string;
	agentId: string;
	incarnation: string;
	capability: string;
}
export interface PeerRecord {
	agentId: string;
	descriptor: WorkerDescriptor;
	sessionPath: string;
	model?: string;
	taskId?: string;
	prompt: string;
	incarnation: string;
	rooms: string[];
	cursor: number;
	pid?: number;
}
export interface PeerMessage {
	sequence: number;
	id: string;
	sender: string;
	recipients: string[];
	room?: string;
	taskId?: string;
	replyTo?: string;
	text: string;
	createdAt: string;
	deliverAs?: DeliverAs;
}
type PeerEvent =
	| { type: "peer"; peer: PeerRecord }
	| { type: "message"; message: PeerMessage }
	| { type: "rooms"; agentId: string; rooms: string[] }
	| { type: "cursor"; agentId: string; cursor: number };

/** Bounded journal recovery; a torn final append is discarded, not a valid event. */
async function readEvents(runDirectory: string, repairTail = false): Promise<PeerEvent[]> {
	const events: PeerEvent[] = [];
	let validBytes = 0;
	let torn = false;
	const stream = createReadStream(join(runDirectory, "peer-events.jsonl"));
	await new Promise<void>((done, reject) => {
		const detach = attachBoundedJsonlReader(stream, {
			maxRecordCharacters: MAX_RECORD,
			onLine(line) {
				try {
					const event = JSON.parse(line) as PeerEvent;
					if (!["peer", "message", "rooms", "cursor"].includes(event.type)) throw new Error("unknown peer event");
					if (events.length >= MAX_EVENTS) throw new Error("peer journal capacity exceeded");
					events.push(event);
					validBytes += Buffer.byteLength(`${line}\n`);
					if (validBytes > MAX_JOURNAL_BYTES) throw new Error("peer journal byte capacity exceeded");
				} catch (error) {
					stream.destroy(error as Error);
				}
			},
			onReject(rejection) {
				if (rejection.kind === "unterminated") torn = true;
				if (rejection.kind !== "unterminated") stream.destroy(new Error("invalid peer journal framing"));
			},
		});
		stream.once("end", () => {
			detach();
			done();
		});
		stream.once("error", (error: NodeJS.ErrnoException) => {
			detach();
			error.code === "ENOENT" ? done() : reject(error);
		});
	});
	if (torn && repairTail) await truncate(join(runDirectory, "peer-events.jsonl"), validBytes);
	return events;
}

/** Read-only context projection. Never exposes credentials or another peer's inbox. */
export async function readPeerMessages(runDirectory: string, agentId: string, taskId?: string): Promise<PeerMessage[]> {
	return (await readEvents(runDirectory)).flatMap((event) =>
		event.type === "message" &&
		event.message.recipients.includes(agentId) &&
		(taskId === undefined || event.message.taskId === undefined || event.message.taskId === taskId)
			? [event.message]
			: [],
	);
}

function text(value: unknown, name: string, max = 256): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`invalid ${name}`);
	return value;
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unsupported peer request field");
}
function secretMatches(actual: unknown, expected: string): boolean {
	if (typeof actual !== "string") return false;
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Job-owned message authority. Owns no model session and schedules no graph work. */
export class PeerRuntime {
	readonly socketPath: string;
	private server?: Server;
	private readonly peers = new Map<string, PeerRecord>();
	private readonly messages: PeerMessage[] = [];
	private readonly ids = new Map<string, PeerMessage>();
	private readonly capabilities = new Map<string, string>();
	private readonly sockets = new Set<Socket>();
	private readonly presence = new Map<string, { heartbeat: number; state: string }>();
	private readonly deliveries = new Map<string, (message: PeerMessage) => Promise<void>>();
	private readonly delivering = new Map<string, Promise<void>>();
	private readonly offered = new Map<string, Set<number>>();
	private queue: Promise<unknown> = Promise.resolve();
	private eventCount = 0;
	private journalBytes = 0;
	private closed = false;
	private releaseOwner?: () => void;
	private ownerLock?: Promise<void>;
	readonly runDirectory: string;
	private readonly hooks: {
		isProcessAlive?: (pid: number) => boolean;
		publish?: (peer: PeerRecord, params: Record<string, unknown>) => Promise<unknown>;
		claim?: (peer: PeerRecord, path: string) => Promise<unknown>;
		release?: (peer: PeerRecord, path: string) => Promise<unknown>;
		authorizeMutation?: (peer: PeerRecord, path?: string) => Promise<unknown>;
	};
	private constructor(runDirectory: string, hooks: PeerRuntime["hooks"]) {
		this.runDirectory = runDirectory;
		this.hooks = hooks;
		const key = createHash("sha256").update(resolve(runDirectory)).digest("hex").slice(0, 24);
		this.socketPath = join(tmpdir(), `kpi-peer-${key}.sock`);
	}
	static async open(runDirectory: string, hooks: PeerRuntime["hooks"] = {}): Promise<PeerRuntime> {
		await mkdir(runDirectory, { recursive: true });
		const runtime = new PeerRuntime(await realpath(runDirectory), hooks);
		const ready = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		runtime.releaseOwner = stopped.resolve;
		runtime.ownerLock = withLeaseLock(
			join(runtime.runDirectory, "peer-owner"),
			async () => {
				ready.resolve();
				await stopped.promise;
			},
			{ lockTimeoutMs: 1000 },
		);
		runtime.ownerLock.catch((error) =>
			ready.reject(
				error instanceof WorkspaceBusyError
					? new WorkspaceBusyError(`peer runtime already owned: ${error.message}`)
					: error,
			),
		);
		await ready.promise;
		try {
			await runtime.listen();
			for (const event of await readEvents(runDirectory, true)) {
				runtime.apply(event);
				runtime.eventCount++;
			}
			runtime.journalBytes =
				(
					await stat(join(runDirectory, "peer-events.jsonl")).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
						return undefined;
					})
				)?.size ?? 0;
			// Recovery never reuses a bearer or assumes a recorded PID is its child.
			runtime.server!.maxConnections = 128;
			return runtime;
		} catch (error) {
			await runtime.close();
			throw error;
		}
	}
	private async listen(): Promise<void> {
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		const bind = (): Promise<void> =>
			new Promise((done, reject) => {
				server.once("error", reject);
				server.listen(this.socketPath, () => {
					server.off("error", reject);
					done();
				});
			});
		try {
			await bind();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// The durable peer-owner lock excludes every current runtime/reaper.
			// Probe legacy endpoints as well; never unlink a responsive live owner.
			const probeResult = Promise.withResolvers<void>();
			const probe = createConnection(this.socketPath);
			probe.setTimeout(1000, () => {
				probe.destroy();
				probeResult.reject(new Error("peer owner is unresponsive"));
			});
			probe.once("connect", () => {
				probe.destroy();
				probeResult.reject(new WorkspaceBusyError("peer runtime already owned"));
			});
			probe.once("error", (failure: NodeJS.ErrnoException) => {
				probe.destroy();
				if (failure.code === "ECONNREFUSED" || failure.code === "ENOENT") probeResult.resolve();
				else probeResult.reject(failure);
			});
			await probeResult.promise;
			await unlink(this.socketPath).catch((failure: NodeJS.ErrnoException) => {
				if (failure.code !== "ENOENT") throw failure;
			});
			await bind();
			// Only a refused connection is a stale socket; the owner lock remains held.
		}
		await chmod(this.socketPath, 0o600);
		server.on("error", () => {
			/* Individual requests fail closed on socket loss. */
		});
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => undefined);
		return result;
	}
	private apply(event: PeerEvent): void {
		switch (event.type) {
			case "peer":
				this.peers.set(event.peer.agentId, event.peer);
				break;
			case "message":
				this.messages.push(event.message);
				this.ids.set(event.message.id, event.message);
				break;
			case "rooms": {
				const peer = this.peers.get(event.agentId);
				if (peer) peer.rooms = event.rooms;
				break;
			}
			case "cursor": {
				const peer = this.peers.get(event.agentId);
				if (peer) peer.cursor = event.cursor;
				break;
			}
		}
	}
	private async append(event: PeerEvent): Promise<void> {
		if (this.closed) throw new Error("peer runtime closed");
		if (this.eventCount >= MAX_EVENTS)
			throw new Error("peer journal full; archive the completed run before further work");
		// Publication bearers rotate on activation and never enter the journal.
		const durable =
			event.type === "peer"
				? { ...event, peer: { ...event.peer, descriptor: { ...event.peer.descriptor, capabilityId: undefined } } }
				: event;
		const bytes = `${JSON.stringify(durable)}\n`;
		if (bytes.length > MAX_RECORD) throw new Error("peer event exceeds bounded record size");
		const byteLength = Buffer.byteLength(bytes);
		if (this.journalBytes + byteLength > MAX_JOURNAL_BYTES) throw new Error("peer journal byte capacity exceeded");
		const file = await open(join(this.runDirectory, "peer-events.jsonl"), "a", 0o600);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} catch (error) {
			// A partial/ambiguous append must be recovered before any next sequence.
			this.closed = true;
			throw error;
		} finally {
			await file.close();
		}
		this.apply(event);
		this.eventCount++;
		this.journalBytes += byteLength;
	}
	list(): PeerRecord[] {
		return [...this.peers.values()].map((peer) => ({ ...peer, rooms: [...peer.rooms] }));
	}
	get(agentId: string): PeerRecord | undefined {
		const peer = this.peers.get(agentId);
		return peer === undefined ? undefined : { ...peer, rooms: [...peer.rooms] };
	}
	async activate(
		input: Omit<PeerRecord, "incarnation" | "rooms" | "cursor">,
		incarnation: string = randomUUID(),
	): Promise<PeerEndpoint> {
		return this.serialize(async () => {
			if (this.capabilities.has(input.agentId)) throw new WorkspaceBusyError("peer incarnation still active");
			const previous = this.peers.get(input.agentId);
			if (previous?.pid !== undefined && (this.hooks.isProcessAlive ?? defaultIsProcessAlive)(previous.pid))
				throw new WorkspaceBusyError("previous peer process has not exited");
			if (previous?.incarnation === incarnation) throw new Error("peer restart requires a fresh incarnation");
			if (
				previous &&
				(previous.descriptor.role !== input.descriptor.role || previous.sessionPath !== input.sessionPath)
			) {
				throw new Error("logical peer role/session cannot change on restart");
			}
			const peer: PeerRecord = {
				...input,
				incarnation,
				rooms: previous?.rooms ?? [],
				cursor: previous?.cursor ?? 0,
			};
			await this.append({ type: "peer", peer });
			const capability = randomBytes(32).toString("hex");
			this.capabilities.set(peer.agentId, capability);
			this.presence.set(peer.agentId, { heartbeat: Date.now(), state: "starting" });
			return { socketPath: this.socketPath, agentId: peer.agentId, incarnation: peer.incarnation, capability };
		});
	}
	async recordPid(agentId: string, pid: number): Promise<void> {
		await this.serialize(async () => {
			const peer = this.requirePeer(agentId);
			await this.append({ type: "peer", peer: { ...peer, pid } });
		});
	}
	async assign(agentId: string, prompt: string, taskId?: string): Promise<void> {
		await this.serialize(async () => {
			const peer = this.requirePeer(agentId);
			await this.append({ type: "peer", peer: { ...peer, prompt, taskId: taskId ?? peer.taskId } });
		});
	}
	/** Call only after process termination is confirmed. */
	deactivate(agentId: string): void {
		this.capabilities.delete(agentId);
		this.deliveries.delete(agentId);
		this.offered.delete(agentId);
		this.presence.set(agentId, { heartbeat: Date.now(), state: "offline" });
	}
	attachDelivery(agentId: string, deliver: (message: PeerMessage) => Promise<void>): void {
		this.deliveries.set(agentId, deliver);
		this.offered.set(agentId, new Set());
		this.wake(agentId);
	}
	private wake(agentId: string): void {
		if (this.delivering.has(agentId)) return;
		const delivery = this.deliveries.get(agentId);
		if (!delivery) return;
		let failed = false;
		const pending = (async () => {
			for (const message of this.messages) {
				const peer = this.requirePeer(agentId);
				if (this.deliveries.get(agentId) !== delivery) break;
				const offered = this.offered.get(agentId);
				if (
					message.sequence <= peer.cursor ||
					!message.recipients.includes(agentId) ||
					offered?.has(message.sequence)
				)
					continue;
				await delivery(message);
				offered?.add(message.sequence);
			}
		})();
		this.delivering.set(agentId, pending);
		void pending
			.catch(() => {
				failed = true;
				this.presence.set(agentId, { heartbeat: Date.now(), state: "delivery-failed" });
			})
			.finally(() => {
				this.delivering.delete(agentId);
				if (
					!failed &&
					this.messages.some(
						(message) =>
							message.recipients.includes(agentId) &&
							message.sequence > this.requirePeer(agentId).cursor &&
							!this.offered.get(agentId)?.has(message.sequence),
					)
				)
					this.wake(agentId);
			});
	}
	private requirePeer(agentId: string): PeerRecord {
		const peer = this.peers.get(agentId);
		if (!peer) throw new Error("unknown peer");
		return peer;
	}
	private authenticate(endpoint: PeerEndpoint): PeerRecord {
		const peer = this.requirePeer(endpoint.agentId);
		const capability = this.capabilities.get(endpoint.agentId);
		if (!capability || peer.incarnation !== endpoint.incarnation || !secretMatches(endpoint.capability, capability))
			throw new Error("peer authentication failed");
		return peer;
	}
	private accept(socket: Socket): void {
		this.sockets.add(socket);
		let count = 0;
		let chain: Promise<unknown> = Promise.resolve();
		socket.on("error", () => socket.destroy());
		socket.setTimeout(90_000, () => socket.destroy());
		const detach = attachBoundedJsonlReader(socket, {
			maxRecordCharacters: MAX_RECORD,
			onReject: () => socket.destroy(),
			onLine: (line) => {
				if (++count > MAX_PENDING) {
					socket.destroy();
					return;
				}
				chain = chain
					.then(async () => {
						let id: unknown;
						try {
							const request = JSON.parse(line) as Record<string, unknown>;
							exactKeys(request, ["id", "auth", "method", "params"]);
							id = text(request.id, "request id");
							const peer = this.authenticate(request.auth as PeerEndpoint);
							const result = await this.dispatch(
								peer,
								text(request.method, "method"),
								(request.params ?? {}) as Record<string, unknown>,
							);
							await writeRecordBounded(socket, `${JSON.stringify({ id, result })}\n`, {
								maxRecordCharacters: MAX_RECORD,
							});
						} catch (error) {
							await writeRecordBounded(
								socket,
								`${JSON.stringify({ id, error: error instanceof Error ? error.message : "peer request rejected" })}\n`,
								{ maxRecordCharacters: MAX_RECORD },
							);
						} finally {
							count--;
						}
					})
					.catch(() => socket.destroy());
			},
		});
		socket.once("close", () => {
			detach();
			this.sockets.delete(socket);
		});
	}
	private async dispatch(peer: PeerRecord, method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "discover":
				exactKeys(params, []);
				return this.list().map((record) => ({
					agentId: record.agentId,
					role: record.descriptor.role,
					taskId: record.taskId,
					incarnation: record.incarnation,
					rooms: record.rooms,
					cursor: record.cursor,
					presence:
						Date.now() - (this.presence.get(record.agentId)?.heartbeat ?? 0) > 60_000
							? "offline"
							: (this.presence.get(record.agentId)?.state ?? "offline"),
				}));
			case "heartbeat":
				exactKeys(params, []);
				this.presence.set(peer.agentId, { heartbeat: Date.now(), state: "online" });
				return { online: true };
			case "send":
				return this.send(peer.agentId, params, true, peer.incarnation);
			case "join":
			case "leave":
				exactKeys(params, ["room"]);
				return this.serialize(async () => {
					const current = this.requirePeer(peer.agentId);
					const room = text(params.room, "room");
					if (current.incarnation !== peer.incarnation || !this.capabilities.has(peer.agentId))
						throw new Error("peer incarnation is no longer active");
					const rooms = new Set(current.rooms);
					method === "join" ? rooms.add(room) : rooms.delete(room);
					if (rooms.size > 64) throw new Error("peer room limit reached");
					await this.append({ type: "rooms", agentId: peer.agentId, rooms: [...rooms] });
					return { rooms: [...rooms] };
				});
			case "inbox": {
				exactKeys(params, ["after"]);
				const after = params.after ?? this.requirePeer(peer.agentId).cursor;
				if (!Number.isSafeInteger(after) || (after as number) < 0) throw new Error("invalid replay cursor");
				const messages: PeerMessage[] = [];
				let size = 0;
				for (const message of this.messages) {
					if (message.sequence <= (after as number) || !message.recipients.includes(peer.agentId)) continue;
					const bytes = JSON.stringify(message).length;
					if (size + bytes > MAX_RECORD - 1024 || messages.length >= 100) break;
					messages.push(message);
					size += bytes;
				}
				return { messages, cursor: this.requirePeer(peer.agentId).cursor };
			}
			case "ack":
				exactKeys(params, ["id"]);
				return this.serialize(async () => {
					const current = this.requirePeer(peer.agentId);
					if (current.incarnation !== peer.incarnation || !this.capabilities.has(peer.agentId))
						throw new Error("peer incarnation is no longer active");
					const next = this.messages.find(
						(message) => message.sequence > current.cursor && message.recipients.includes(peer.agentId),
					);
					const message = this.ids.get(text(params.id, "message id"));
					if (!message?.recipients.includes(peer.agentId)) throw new Error("message outside peer inbox");
					if (message.sequence <= current.cursor) return { cursor: current.cursor };
					if (next?.id !== message.id) throw new Error("ack must advance the inbox in order");
					await this.append({ type: "cursor", agentId: peer.agentId, cursor: message.sequence });
					return { cursor: message.sequence };
				});
			case "publish":
				exactKeys(params, ["path", "content"]);
				if (!peer.descriptor.tools.includes("write_contract") || !this.hooks.publish)
					throw new Error("peer cannot publish a contract");
				return this.hooks.publish(peer, params);
			case "claim":
			case "release": {
				exactKeys(params, ["path"]);
				if (!peer.descriptor.tools.includes(method === "claim" ? "claim_path" : "release_path"))
					throw new Error("peer has no path authority");
				const operation = this.hooks[method];
				if (!operation) throw new Error("path authority unavailable");
				return operation(peer, text(params.path, "path", 4096));
			}
			case "authorize_mutation":
				exactKeys(params, ["path"]);
				if (!this.hooks.authorizeMutation) throw new Error("mutation authority unavailable");
				return this.hooks.authorizeMutation(
					peer,
					params.path === undefined ? undefined : text(params.path, "path", 4096),
				);
			default:
				throw new Error("unsupported peer method");
		}
	}
	/** Parent calls use an explicit host origin; worker origin is always authenticated. */
	async send(
		sender: string,
		params: Record<string, unknown>,
		wake = true,
		incarnation?: string,
	): Promise<{ accepted: true; message: PeerMessage; duplicate: boolean }> {
		const outcome = await this.serialize(async () => {
			exactKeys(params, ["id", "to", "room", "text", "replyTo", "deliverAs"]);
			if (sender !== "host") this.requirePeer(sender);
			if (
				incarnation !== undefined &&
				(this.requirePeer(sender).incarnation !== incarnation || !this.capabilities.has(sender))
			)
				throw new Error("peer incarnation is no longer active");
			const id = params.id === undefined ? randomUUID() : text(params.id, "message id");
			const body = text(params.text, "message", 32_000);
			if ((params.to === undefined) === (params.room === undefined))
				throw new Error("send requires exactly one peer or room");
			const room = params.room === undefined ? undefined : text(params.room, "room");
			const to = params.to === undefined ? undefined : text(params.to, "recipient");
			if (to) this.requirePeer(to);
			if (room && sender !== "host" && !this.requirePeer(sender).rooms.includes(room))
				throw new Error("join the room before sending");
			const replyTo = params.replyTo === undefined ? undefined : text(params.replyTo, "reply id");
			if (replyTo && sender !== "host") {
				const prior = this.ids.get(replyTo);
				if (!prior || (prior.sender !== sender && !prior.recipients.includes(sender)))
					throw new Error("reply outside peer scope");
			}
			if (params.deliverAs !== undefined && params.deliverAs !== "steer" && params.deliverAs !== "followUp")
				throw new Error("invalid delivery mode");
			const duplicate = this.ids.get(id);
			if (duplicate) {
				if (
					duplicate.sender !== sender ||
					duplicate.text !== body ||
					duplicate.room !== room ||
					duplicate.replyTo !== replyTo ||
					duplicate.deliverAs !== params.deliverAs ||
					(to !== undefined && (duplicate.recipients.length !== 1 || duplicate.recipients[0] !== to))
				)
					throw new Error("message id already used for a different envelope");
				return { accepted: true as const, message: duplicate, duplicate: true };
			}
			const recipients = to
				? [to]
				: this.list()
						.filter((peer) => peer.rooms.includes(room!) && peer.agentId !== sender)
						.map((peer) => peer.agentId);
			const message: PeerMessage = {
				sequence: this.messages.length + 1,
				id,
				sender,
				recipients,
				room,
				taskId: to ? this.requirePeer(to).taskId : this.peers.get(sender)?.taskId,
				replyTo,
				text: body,
				createdAt: new Date().toISOString(),
				deliverAs: params.deliverAs as DeliverAs | undefined,
			};
			await this.append({ type: "message", message });
			return { accepted: true as const, message, duplicate: false };
		});
		for (const recipient of outcome.message.recipients) {
			if (wake) this.wake(recipient);
			else this.offered.get(recipient)?.add(outcome.message.sequence);
		}
		return outcome;
	}
	async close(): Promise<void> {
		await this.queue;
		this.closed = true;
		for (const socket of this.sockets) socket.destroy();
		try {
			if (this.server?.listening) {
				const closed = Promise.withResolvers<void>();
				this.server.close((error) => (error ? closed.reject(error) : closed.resolve()));
				await closed.promise;
			}
		} finally {
			this.releaseOwner?.();
			await this.ownerLock;
		}
	}
}

/** One bounded authenticated connection, shared by this worker's production tools. */
export class PeerClient {
	private readonly pending = new Map<
		string,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
	>();
	private readonly socket: Socket;
	private readonly endpoint: PeerEndpoint;
	private constructor(socket: Socket, endpoint: PeerEndpoint) {
		this.socket = socket;
		this.endpoint = endpoint;
		const detach = attachBoundedJsonlReader(socket, {
			maxRecordCharacters: MAX_RECORD,
			onReject: () => socket.destroy(new Error("invalid peer response framing")),
			onLine: (line) => {
				try {
					const response = JSON.parse(line);
					const pending = this.pending.get(response.id);
					if (!pending) return;
					this.pending.delete(response.id);
					clearTimeout(pending.timer);
					response.error ? pending.reject(new Error(response.error)) : pending.resolve(response.result);
				} catch {
					socket.destroy(new Error("invalid peer response"));
				}
			},
		});
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			detach();
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("peer connection closed"));
			}
			this.pending.clear();
		});
	}
	static async connect(endpoint: PeerEndpoint): Promise<PeerClient> {
		const socket = createConnection(endpoint.socketPath);
		await new Promise<void>((done, reject) => {
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("peer connect timeout"));
			}, REQUEST_TIMEOUT);
			socket.once("connect", () => {
				clearTimeout(timer);
				done();
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		const client = new PeerClient(socket, endpoint);
		try {
			await client.request("heartbeat");
			return client;
		} catch (error) {
			client.close();
			throw error;
		}
	}
	async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (this.pending.size >= MAX_PENDING) throw new Error("too many pending peer requests");
		const id = randomUUID();
		const promise = new Promise<unknown>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("peer request timeout"));
			}, REQUEST_TIMEOUT);
			this.pending.set(id, { resolve: resolvePromise, reject, timer });
		});
		try {
			await writeRecordBounded(this.socket, `${JSON.stringify({ id, auth: this.endpoint, method, params })}\n`, {
				maxRecordCharacters: MAX_RECORD,
			});
		} catch (error) {
			const pending = this.pending.get(id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(error as Error);
			}
		}
		return promise;
	}
	close(): void {
		this.socket.destroy();
	}
}
