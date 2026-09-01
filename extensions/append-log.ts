import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventInput = {
  ts: string;
  type: EventType;
  job_id: string;
  round: number;
  node: string;
} & Record<string, JsonValue | undefined>;

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
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|secret|token|api[_-]?key/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:sk|oat01)-[A-Za-z0-9_-]+/gi,
  /\b(?:cookie|password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
] as const;
const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    const redacted: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      const redactedKey = redactString(key);
      redacted[redactedKey] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactValue(child);
    }
    return redacted;
  }
  return value;
}

function sanitizeEvent(event: EventInput): { [key: string]: JsonValue } {
  const sanitized: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || key === "prev_hash" || key === "record_hash") {
      continue;
    }
    const redactedKey = redactString(key);
    sanitized[redactedKey] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redactValue(value);
  }
  return sanitized;
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

export async function appendEvent(
  path: string,
  event: EventInput,
): Promise<EventRecord> {
  const prev_hash = await previousHash(path);
  const recordWithoutHash = {
    ...sanitizeEvent(event),
    prev_hash,
  };
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
