import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { serializeJsonLine } from "../../../modes/rpc/jsonl.ts";
import { redactJson } from "../append-log.ts";
import { isJsonObject } from "../graph/schema.ts";
import { attachBoundedJsonlReader, MAX_DRAIN_WAIT_MS, MAX_RECORD_CHARACTERS, writeRecordBounded } from "./framing.ts";

/**
 * Bounds. Every one of them is a refusal rather than an unbounded wait, so a
 * worker that stops answering cannot hold the parent open.
 */
export const WORKER_STARTUP_TIMEOUT_MS = 30_000;
export const WORKER_ACCEPTANCE_TIMEOUT_MS = 30_000;
export const WORKER_RESULT_TIMEOUT_MS = 600_000;
export const WORKER_SHUTDOWN_TIMEOUT_MS = 5_000;
/** Diagnostics are kept for the operator, so they are kept bounded. */
export const MAX_DIAGNOSTIC_CHARACTERS = 10_000;

export { MAX_DRAIN_WAIT_MS, MAX_RECORD_CHARACTERS };

export type DeliverAs = "steer" | "followUp";

/** What the parent is waiting for when it speaks to a worker. */
export type CommunicateExpectation = "none" | "ack" | "result";

export interface WorkerDiagnostics {
	/** Whatever the worker last said, redacted and kept only for an operator. */
	lastAssistantText?: string;
	/** Real stderr from the child, bounded, redacted, never parsed as protocol. */
	stderr: string;
	/** Records this client refused: oversized, CRLF, unparseable, or not an object. */
	rejectedRecords: number;
	/** Protocol-level complaints worth surfacing. */
	notes: string[];
}

interface PendingRequest {
	resolve: (response: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

function clamp(value: string): string {
	return value.length <= MAX_DIAGNOSTIC_CHARACTERS ? value : value.slice(0, MAX_DIAGNOSTIC_CHARACTERS);
}

/**
 * Diagnostics go through the harness's own redactor before anyone can read them.
 *
 * A worker's stderr and its assistant text are the two places a provider key, a
 * bearer header or a session cookie can surface without anyone intending it, and
 * `agents_status` is read by an operator and by the board.
 */
function scrub(value: string): string {
	return clamp(redactJson(value) as string);
}

/** Text carried by an authoritative assistant message. */
function assistantMessageText(message: unknown): string | undefined {
	if (!isJsonObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const entry of message.content) {
		if (isJsonObject(entry) && entry.type === "text" && typeof entry.text === "string") {
			parts.push(entry.text);
		}
	}
	return parts.length === 0 ? undefined : parts.join("");
}

/**
 * One worker's side of the RPC protocol.
 *
 * Framing is this module's own bounded LF-only reader: bounded while streaming,
 * CR-rejecting, and transparent to U+2028/U+2029, which are legal inside a JSON
 * string and are why `readline` cannot be used.
 *
 * Every command carries an `id` and every response is matched by it, so responses
 * may arrive in any order. A `prompt` response means the work was accepted;
 * `agent_settled` means it finished. Nothing here treats assistant text as a
 * result: contract files are the only answer, and text is a diagnostic.
 */
export class WorkerProtocol {
	private readonly stdin: Writable;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly settledWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	private readonly diagnostics: WorkerDiagnostics = { stderr: "", rejectedRecords: 0, notes: [] };
	private readonly drainTimeoutMs: number;
	private detachStdout: () => void;
	private detachStderr: () => void;
	private closed = false;
	private closeReason?: Error;
	/** Streaming text deltas for the turn in flight. */
	private streamingText = "";
	/** Rises on every settle, so a waiter can tell a new one from an old one. */
	private settleCount = 0;
	constructor(streams: { stdin: Writable; stdout: Readable; stderr?: Readable; drainTimeoutMs?: number }) {
		this.stdin = streams.stdin;
		this.drainTimeoutMs = streams.drainTimeoutMs ?? MAX_DRAIN_WAIT_MS;
		this.detachStdout = attachBoundedJsonlReader(streams.stdout, {
			onLine: (line) => this.handleLine(line),
			onReject: (rejection) => {
				this.diagnostics.rejectedRecords += 1;
				this.note(
					rejection.kind === "oversized"
						? `refused a ${rejection.characters} character record`
						: rejection.kind === "carriage-return"
							? "refused a record terminated with CRLF"
							: `refused a ${rejection.characters} character record with no newline at end of stream`,
				);
			},
		});
		this.detachStderr = () => undefined;
		if (streams.stderr !== undefined) {
			const onData = (chunk: Buffer | string): void => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				this.diagnostics.stderr = scrub(this.diagnostics.stderr + text);
			};
			streams.stderr.on("data", onData);
			this.detachStderr = () => streams.stderr?.off("data", onData);
		}
	}

	get snapshot(): WorkerDiagnostics {
		return { ...this.diagnostics, notes: [...this.diagnostics.notes] };
	}

	/** How many times the worker has settled. A waiter compares against this. */
	get settles(): number {
		return this.settleCount;
	}

	/** Records a protocol note without ever letting it grow without bound. */
	private note(message: string): void {
		if (this.diagnostics.notes.length < 32) {
			this.diagnostics.notes.push(clamp(message));
		}
	}

	private handleLine(line: string): void {
		if (line.length === 0) {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.diagnostics.rejectedRecords += 1;
			this.note("refused an unparseable record");
			return;
		}
		if (!isJsonObject(parsed)) {
			this.diagnostics.rejectedRecords += 1;
			this.note("refused a record that is not an object");
			return;
		}

		const record: Record<string, unknown> = parsed;
		if (record.type === "response") {
			const id = typeof record.id === "string" ? record.id : undefined;
			if (id === undefined) {
				this.note("refused a response with no id");
				this.diagnostics.rejectedRecords += 1;
				return;
			}
			const waiter = this.pending.get(id);
			if (waiter === undefined) {
				// A response to a request this client is no longer waiting for is not a
				// fault; it is late. It is recorded and dropped.
				this.note(`late response for ${id}`);
				return;
			}
			this.pending.delete(id);
			clearTimeout(waiter.timer);
			waiter.resolve(record);
			return;
		}

		if (record.type === "agent_settled") {
			// Completion. `agent_end` is not: a retry or a queued continuation may
			// still follow it.
			this.settleCount += 1;
			const waiters = this.settledWaiters.splice(0, this.settledWaiters.length);
			for (const waiter of waiters) {
				waiter.resolve();
			}
			return;
		}

		// Real streaming shape: `message_update` carries an `assistantMessageEvent`
		// with deltas and no cumulative snapshot, and `message_end` carries the
		// authoritative message. Both are diagnostics.
		if (record.type === "message_update") {
			const event = record.assistantMessageEvent;
			if (isJsonObject(event)) {
				if (event.type === "text_delta" && typeof event.delta === "string") {
					this.streamingText = clamp(this.streamingText + event.delta);
					this.diagnostics.lastAssistantText = scrub(this.streamingText);
				} else if (event.type === "text_end" && typeof event.content === "string") {
					this.streamingText = clamp(event.content);
					this.diagnostics.lastAssistantText = scrub(this.streamingText);
				} else if (event.type === "start") {
					this.streamingText = "";
				}
			}
			return;
		}
		if (record.type === "message_end") {
			const text = assistantMessageText(record.message);
			if (text !== undefined) {
				this.diagnostics.lastAssistantText = scrub(text);
			}
			this.streamingText = "";
		}
	}

	/** Sends one record, bounded in size and waiting for the stream to take it. */
	private async write(record: Record<string, unknown>): Promise<void> {
		if (this.closed) {
			throw this.closeReason ?? new Error("worker protocol is closed");
		}
		await writeRecordBounded(this.stdin, serializeJsonLine(record), {
			drainTimeoutMs: this.drainTimeoutMs,
		});
	}

	/**
	 * Sends a command and waits for the response with that id. A timeout rejects
	 * rather than leaving the caller waiting on a worker that stopped answering.
	 */
	async request(
		command: Record<string, unknown>,
		timeoutMs = WORKER_ACCEPTANCE_TIMEOUT_MS,
	): Promise<Record<string, unknown>> {
		const id = typeof command.id === "string" ? command.id : randomUUID();
		const record = { ...command, id };
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`worker did not answer ${String(command.type)} within ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		try {
			await this.write(record);
		} catch (error) {
			const waiter = this.pending.get(id);
			if (waiter !== undefined) {
				this.pending.delete(id);
				clearTimeout(waiter.timer);
			}
			throw error instanceof Error ? error : new Error(String(error));
		}
		return response;
	}

	/**
	 * Delivery with nothing expected back, which still means the stream took the
	 * bytes: "fire and forget" is not "buffer without limit".
	 */
	async send(command: Record<string, unknown>): Promise<void> {
		await this.write({ ...command, id: typeof command.id === "string" ? command.id : randomUUID() });
	}

	/**
	 * The initial delivery. A successful response is acceptance, so the caller
	 * knows the work started - not that it finished.
	 */
	async prompt(message: string): Promise<void> {
		const response = await this.request({ type: "prompt", message });
		assertAccepted(response, "prompt");
	}

	/**
	 * Live delivery into a running worker. `steer` interrupts after the current
	 * tool; `followUp` waits for the turn to end. Both are their own protocol
	 * commands, and a prompt carrying `streamingBehavior` is the documented
	 * equivalent.
	 */
	async deliver(message: string, deliverAs: DeliverAs): Promise<void> {
		const response = await this.request(
			deliverAs === "steer" ? { type: "steer", message } : { type: "follow_up", message },
		);
		assertAccepted(response, deliverAs === "steer" ? "steer" : "follow_up");
	}

	/**
	 * Resolves once `settleCount` has advanced past `afterCount`, or refuses when
	 * the bound passes.
	 *
	 * Pass the count observed *before* the delivery whose settlement you care
	 * about. Registering with the default (`this.settleCount`) after a delivery
	 * can miss a settle that already happened; registering with a pre-delivery
	 * baseline cannot. A fresh protocol starts at zero, so installing
	 * `waitForSettled(ms, 0)` before the first prompt is the safe initial-turn wait.
	 */
	waitForSettled(timeoutMs = WORKER_RESULT_TIMEOUT_MS, afterCount?: number): Promise<void> {
		if (this.closed) {
			return Promise.reject(this.closeReason ?? new Error("worker protocol closed"));
		}
		const baseline = afterCount ?? this.settleCount;
		if (this.settleCount > baseline) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const entry = {
				resolve: (): void => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error: Error): void => {
					clearTimeout(timer);
					reject(error);
				},
			};
			const timer = setTimeout(() => {
				const index = this.settledWaiters.indexOf(entry);
				if (index >= 0) {
					this.settledWaiters.splice(index, 1);
				}
				reject(new Error(`worker did not settle within ${timeoutMs}ms`));
			}, timeoutMs);
			this.settledWaiters.push(entry);
		});
	}

	/**
	 * Cancels current work. The queue is cleared first: aborting with steering or
	 * follow-ups still queued would abort the current turn and then immediately
	 * start the next one.
	 */
	async cancel(): Promise<void> {
		await this.request({ type: "clear_queue" }).catch(() => undefined);
		await this.request({ type: "abort" }).catch(() => undefined);
	}

	close(reason?: Error): void {
		this.closed = true;
		this.closeReason = reason;
		this.detachStdout();
		this.detachStderr();
		for (const [, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.reject(reason ?? new Error("worker protocol closed"));
		}
		this.pending.clear();
		const settleWaiters = this.settledWaiters.splice(0, this.settledWaiters.length);
		const closed = reason ?? new Error("worker protocol closed");
		for (const waiter of settleWaiters) {
			waiter.reject(closed);
		}
	}
}

/** A response is acceptance only when the worker says it succeeded. */
export function assertAccepted(response: Record<string, unknown>, command: string): void {
	if (response.success === true) {
		return;
	}
	const reason = typeof response.error === "string" ? response.error : "worker rejected the command";
	throw new Error(`${command} was not accepted: ${reason}`);
}
