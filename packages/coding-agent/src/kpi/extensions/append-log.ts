import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { TerminalStatus } from "./graph/stop.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const EVENT_TYPES = [
	"handoff.created",
	"tool.request",
	"approval.result",
	"tool.result",
	"checkpoint",
	"handoff.completed",
	"recovery.started",
	"recovery.completed",
	"kg.patch.proposed",
	"kg.patch.accepted",
	"accounts.failover",
	"ac.refused",
	"loop.terminal",
	"review.verdict",
	"research.started",
	"research.query",
	"research.call",
	"research.result",
	"research.fallback",
	"research.completed",
	"agent.spawned",
	"agent.message",
	"agent.denied",
	"node.started",
	"node.finished",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Fields every event carries, whatever its type. */
export interface EventBase {
	ts: string;
	job_id: string;
	round: number;
	node: string;
}

type Event<T extends EventType, P = Record<never, never>> = EventBase & {
	type: T;
} & P;

/** Types whose whole meaning is the base envelope. */
type BareEventType =
	| "tool.result"
	| "handoff.completed"
	| "recovery.started"
	| "recovery.completed"
	| "kg.patch.proposed"
	| "kg.patch.accepted";

export type ResearchEventType =
	| "research.started"
	| "research.query"
	| "research.call"
	| "research.result"
	| "research.fallback"
	| "research.completed";

/**
 * Normalized research telemetry. Never a vendor envelope: a call is described
 * by which service was asked what, how it went, and what it resolved to.
 */
export interface ResearchPayload {
	service?: string;
	query?: string;
	attempt?: number;
	result_count?: number;
	source_refs?: string[];
	from?: string;
	to?: string;
	reason?: string;
	mode?: "exa" | "perplexity" | "firecrawl" | "auto" | "local";
	network_state?: "online" | "no-network";
}

export type EventInput =
	| Event<BareEventType>
	| Event<"checkpoint", { detail?: string }>
	| Event<"handoff.created", { mode: "gated" | "autopilot" }>
	| Event<"approval.result", { approved: boolean; question?: string; feedback?: string }>
	| Event<"ac.refused", { quality: "executable" | "partial" | "narrative"; reason: string }>
	| Event<"accounts.failover", { from: string; to: string; reason?: string }>
	| Event<"loop.terminal", { status: TerminalStatus; reason?: string }>
	| Event<
			"tool.request",
			{
				/** The tool the session asked to run. */
				tool: string;
				/** What the policy layer decided, before the tool could act. */
				decision: "allow" | "confirm" | "deny";
				/** Repository-relative target, for the tools that name one. */
				path?: string;
				reason?: string;
			}
	  >
	| Event<
			"agent.denied",
			{
				/**
				 * Why the bus refused. A code rather than prose so a grader can match
				 * it, and never a capability id: the reason a worker was refused is
				 * not a place to publish the bearer that would have let it through.
				 */
				reason: "worker-limit" | "writer-live" | "admission-held" | "claim-held" | "role-tool";
				role?: string;
				agent_id?: string;
				/** Canonical claim key, for a refused path claim. */
				key?: string;
				/** The agent already holding the thing that was refused. */
				holder?: string;
				limit?: number;
			}
	  >
	| Event<
			"review.verdict",
			{
				status: "PASS" | "REVISE" | "BLOCKED";
				approved: boolean;
				blocking_count: number;
				nonblocking_count?: number;
				fingerprint?: string;
			}
	  >
	| Event<ResearchEventType, ResearchPayload>
	| Event<
			"agent.spawned",
			{
				agent_id: string;
				role: string;
				pid: number;
				session_path?: string;
				status?: string;
			}
	  >
	| Event<
			"agent.message",
			{
				agent_id: string;
				message_id?: string;
				deliver_as?: "steer" | "followUp";
				expect?: string;
				status?: string;
			}
	  >
	| Event<"node.started", { run: number; model?: string }>
	| Event<
			"node.finished",
			{
				run: number;
				status: "completed" | "failed";
				elapsed_ms: number;
				cost_usd?: number;
				result?: string;
				session?: string;
				error?: string;
			}
	  >;

/** One graph node run starting or settling, as the board reads it back. */
export type NodeLifecycleEvent = Extract<EventInput, { type: "node.started" | "node.finished" }>;

/**
 * A line read back from an event log: the base envelope plus the chain hashes.
 * Stays open because a log outlives the union that wrote it.
 */
export type EventRecord = {
	ts: string;
	type: EventType;
	job_id: string;
	round: number;
	node: string;
	prev_hash: string;
	record_hash: string;
} & Record<string, JsonValue>;

/** The predecessor of a log's first record. */

/** Concise fields for a receipt-backed reviewer verdict event. No issue text. */
export function buildReviewVerdictEventFields(document: Record<string, unknown>):
	| {
			status: "PASS" | "REVISE" | "BLOCKED";
			approved: boolean;
			blocking_count: number;
			nonblocking_count?: number;
			fingerprint?: string;
	  }
	| undefined {
	const statusRaw = document.status;
	const status = statusRaw === "PASS" || statusRaw === "REVISE" || statusRaw === "BLOCKED" ? statusRaw : undefined;
	if (status === undefined || typeof document.approved !== "boolean") {
		return undefined;
	}
	const blocking = Array.isArray(document.blockingIssues) ? document.blockingIssues.length : 0;
	const nonblocking = Array.isArray(document.nonBlockingIssues) ? document.nonBlockingIssues.length : undefined;
	const fingerprint = typeof document.output_fingerprint === "string" ? document.output_fingerprint : undefined;
	return {
		status,
		approved: document.approved,
		blocking_count: blocking,
		...(nonblocking === undefined ? {} : { nonblocking_count: nonblocking }),
		...(fingerprint === undefined ? {} : { fingerprint }),
	};
}

export const FIRST_HASH = "0".repeat(64);
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Raw header keys and containers. Rejected outright, at any value type. */
const REJECTED_KEYS: Record<string, true> = {
	headers: true,
	header: true,
	rawheaders: true,
	requestheaders: true,
	responseheaders: true,
	httpheaders: true,
	authorization: true,
	proxyauthorization: true,
	wwwauthenticate: true,
	cookie: true,
	cookies: true,
	setcookie: true,
};

/** Vendor envelope keys. Rejected when they carry an object or an array. */
const REJECTED_CONTAINER_KEYS: Record<string, true> = {
	request: true,
	response: true,
	body: true,
	envelope: true,
	vendor: true,
	raw: true,
	rawrequest: true,
	rawresponse: true,
	rawbody: true,
};

const SENSITIVE_KEY_PATTERN =
	/authorization|cookie|password|passwd|passphrase|credential|secret|token|bearer|api[-_]?key|access[-_]?key|private[-_]?key|session[-_]?key/i;
const SECRET_VALUE_PATTERNS = [
	/\bBearer\s+[^\s,;]+/gi,
	/\b(?:sk|oat01|pplx|xai|exa)-[A-Za-z0-9_-]+/gi,
	/\bgh[pousr]_[A-Za-z0-9]+/g,
	/\bgithub_pat_[A-Za-z0-9_]+/g,
	/\bxox[a-z]-[A-Za-z0-9-]+/gi,
	/\bAKIA[0-9A-Z]{12,}/g,
	/\b(?:cookie|password|passwd|token|secret|credential|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi,
] as const;
const REDACTED = "[REDACTED]";

export class ForbiddenEventPayloadError extends Error {
	readonly key: string;
	readonly path: string;

	constructor(key: string, path: string) {
		super(`Forbidden event payload key ${JSON.stringify(key)} at ${path}`);
		this.name = "ForbiddenEventPayloadError";
		this.key = key;
		this.path = path;
	}
}

function redactString(value: string): string {
	let redacted = value;
	for (const pattern of SECRET_VALUE_PATTERNS) {
		redacted = redacted.replace(pattern, REDACTED);
	}
	return redacted;
}

/** Scrubs secrets from values and from keys, at every depth. */
export function redactJson(value: JsonValue): JsonValue {
	if (typeof value === "string") {
		return redactString(value);
	}
	if (Array.isArray(value)) {
		return value.map(redactJson);
	}
	if (value !== null && typeof value === "object") {
		const redacted: { [key: string]: JsonValue } = {};
		for (const [key, child] of Object.entries(value)) {
			redacted[redactString(key)] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactJson(child);
		}
		return redacted;
	}
	return value;
}

function assertPayloadAllowed(value: JsonValue, path: string): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			assertPayloadAllowed(item, `${path}[${index}]`);
		}
		return;
	}
	if (value === null || typeof value !== "object") {
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		const normalized = key.toLowerCase().replaceAll(/[-_\s]/gu, "");
		const isContainer = child !== null && typeof child === "object";
		if (REJECTED_KEYS[normalized] === true || (isContainer && REJECTED_CONTAINER_KEYS[normalized] === true)) {
			throw new ForbiddenEventPayloadError(key, `${path}.${key}`);
		}
		assertPayloadAllowed(child, `${path}.${key}`);
	}
}

/**
 * Rejects raw vendor envelopes and header fields, then redacts what remains.
 * Runs before hashing, so the chain covers exactly the bytes on disk.
 */
export function sanitizeEvent(event: EventInput): { [key: string]: JsonValue } {
	const payload: { [key: string]: JsonValue } = {};
	const source = event as unknown as Record<string, JsonValue | undefined>;
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined || key === "prev_hash" || key === "record_hash") {
			continue;
		}
		payload[key] = value;
	}

	assertPayloadAllowed(payload, "$");
	return redactJson(payload) as { [key: string]: JsonValue };
}

/**
 * An unpaired UTF-16 surrogate, which RFC 8785 §3.2.2 makes an error rather than
 * something to escape.
 *
 * `JSON.stringify` emits well-formed output for a lone surrogate by escaping it,
 * which is valid JSON but is not the canonical form: two callers disagreeing on
 * whether to escape or reject would compute different hashes for the same input.
 * Refusing here is what keeps this function exactly the documented scheme.
 */
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * RFC 8785 (JSON Canonicalization Scheme).
 *
 * Object keys are sorted by UTF-16 code unit, which is JavaScript's default
 * string order; numbers use ECMAScript number-to-string, which is what
 * `JSON.stringify` produces for a finite number; strings use JSON's own minimal
 * escaping. Non-finite numbers and unpaired surrogates are errors, not values.
 */
function canonicalize(value: JsonValue): string {
	if (typeof value === "string") {
		if (LONE_SURROGATE_PATTERN.test(value)) {
			throw new TypeError("Events cannot contain an unpaired surrogate");
		}
		return JSON.stringify(value);
	}
	if (value === null || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("Events cannot contain non-finite numbers");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}

	return `{${Object.keys(value)
		.sort()
		.map((key) => `${canonicalize(key)}:${canonicalize(value[key])}`)
		.join(",")}}`;
}

function hashRecord(record: { [key: string]: JsonValue }): string {
	return createHash("sha256").update(canonicalize(record), "utf8").digest("hex");
}

async function previousHash(path: string): Promise<string> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return FIRST_HASH;
		}
		throw error;
	}

	const lines = source.split("\n").filter((line) => line.length > 0);
	if (lines.length === 0) {
		return FIRST_HASH;
	}

	const last = JSON.parse(lines.at(-1)!) as { record_hash?: unknown };
	if (typeof last.record_hash !== "string" || !HASH_PATTERN.test(last.record_hash)) {
		throw new Error("Cannot append to an event log with an invalid tail hash");
	}
	return last.record_hash;
}

/**
 * One append at a time per log. Reading the tail hash and writing the record
 * that chains to it is check-then-act: two concurrent appends would both read
 * the same tail and produce two records claiming the same predecessor, breaking
 * the chain the log exists to provide. The lock is per resolved path, so
 * unrelated logs never wait on each other.
 */
const appendLocks = new Map<string, Promise<unknown>>();

function withAppendLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const key = resolve(path);
	const previous = appendLocks.get(key) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	// Keep the chain alive even when one append fails: the next writer still has
	// to wait for this one to finish touching the file.
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	appendLocks.set(key, settled);
	void settled.then(() => {
		if (appendLocks.get(key) === settled) {
			appendLocks.delete(key);
		}
	});
	return result;
}

export async function appendEvent(path: string, event: EventInput): Promise<EventRecord> {
	// Sanitize first: a forbidden payload must fail before the log is opened, and
	// before a concurrent writer is made to wait for it.
	const payload = sanitizeEvent(event);
	return withAppendLock(path, async () => {
		const prev_hash = await previousHash(path);
		const recordWithoutHash = { ...payload, prev_hash };
		const record_hash = hashRecord(recordWithoutHash);
		const record = {
			...recordWithoutHash,
			record_hash,
		} as EventRecord;

		const file = await open(path, "a", 0o600);
		try {
			await file.writeFile(`${canonicalize(record)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}

		return record;
	});
}

/**
 * The outcome of verifying one log, in the form an operator can act on.
 *
 * A boolean says a log is broken; it does not say where, which is the only part
 * that helps. `line` is 1-based so it matches what an editor shows.
 */
export interface ChainReport {
	ok: boolean;
	path: string;
	records: number;
	/** 1-based line of the first record that failed, when one did. */
	line?: number;
	reason?: string;
}

export async function inspectChain(path: string): Promise<ChainReport> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: false, path, records: 0, reason: "no event log at this path" };
		}
		throw error;
	}

	let expectedPreviousHash = FIRST_HASH;
	let records = 0;
	let line = 0;
	for (const text of source.split("\n")) {
		line += 1;
		if (text.length === 0) {
			continue;
		}
		let record: Record<string, JsonValue>;
		try {
			record = JSON.parse(text) as Record<string, JsonValue>;
		} catch {
			return { ok: false, path, records, line, reason: "record is not valid JSON" };
		}
		const { record_hash, ...recordWithoutHash } = record;
		if (typeof record_hash !== "string" || !HASH_PATTERN.test(record_hash)) {
			return { ok: false, path, records, line, reason: "record_hash is missing or malformed" };
		}
		if (recordWithoutHash.prev_hash !== expectedPreviousHash) {
			return {
				ok: false,
				path,
				records,
				line,
				reason: `prev_hash does not chain to the previous record (expected ${String(expectedPreviousHash).slice(0, 12)})`,
			};
		}
		let computed: string;
		try {
			computed = hashRecord(recordWithoutHash);
		} catch (error) {
			return { ok: false, path, records, line, reason: error instanceof Error ? error.message : String(error) };
		}
		if (computed !== record_hash) {
			return { ok: false, path, records, line, reason: "record_hash does not match the record's own bytes" };
		}
		records += 1;
		expectedPreviousHash = record_hash;
	}

	return { ok: true, path, records };
}

export async function verifyChain(path: string): Promise<boolean> {
	return (await inspectChain(path)).ok;
}
