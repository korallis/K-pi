import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";

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
	"research.started",
	"research.query",
	"research.call",
	"research.result",
	"research.fallback",
	"research.completed",
	"agent.spawned",
	"agent.message",
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
	| "tool.request"
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
	mode?: "exa" | "perplexity" | "auto" | "local";
	network_state?: "online" | "no-network";
}

export type EventInput =
	| Event<BareEventType>
	| Event<"checkpoint", { detail?: string }>
	| Event<"handoff.created", { mode: "gated" | "autopilot" }>
	| Event<"approval.result", { approved: boolean; question?: string }>
	| Event<"ac.refused", { quality: "executable" | "partial" | "narrative"; reason: string }>
	| Event<"accounts.failover", { from: string; to: string; reason?: string }>
	| Event<"loop.terminal", { status: TerminalStatus; reason?: string }>
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
	  >;

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

const FIRST_HASH = "0".repeat(64);
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

function canonicalize(value: JsonValue): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
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
		.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
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

export async function appendEvent(path: string, event: EventInput): Promise<EventRecord> {
	// Sanitize first: a forbidden payload must fail before the log is opened.
	const payload = sanitizeEvent(event);
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
}

export async function verifyChain(path: string): Promise<boolean> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}

	let expectedPreviousHash = FIRST_HASH;
	for (const line of source.split("\n")) {
		if (line.length === 0) {
			continue;
		}

		try {
			const record = JSON.parse(line) as Record<string, JsonValue>;
			const { record_hash, ...recordWithoutHash } = record;
			if (
				typeof record_hash !== "string" ||
				!HASH_PATTERN.test(record_hash) ||
				recordWithoutHash.prev_hash !== expectedPreviousHash ||
				hashRecord(recordWithoutHash) !== record_hash
			) {
				return false;
			}
			expectedPreviousHash = record_hash;
		} catch {
			return false;
		}
	}

	return true;
}
