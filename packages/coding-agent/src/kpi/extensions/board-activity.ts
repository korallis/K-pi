/**
 * Folds events.jsonl's node.started / node.finished / tool.request records
 * into per-node live activity, and reads the log incrementally so the board's
 * 1 s ticker never re-parses what it already saw. Pure and file-scoped: no
 * model access, no writes.
 */

import type { FileHandle } from "node:fs/promises";
import { open, stat } from "node:fs/promises";

import type { EventRecord } from "./append-log.ts";
import { BOARD_STAGES, formatCost, formatElapsed, type StageActivity, shortTool, stageIndex } from "./board.ts";

export interface NodeActivity {
	node: string;
	status: "pending" | "running" | "completed" | "failed";
	runs: number;
	startedAtMs?: number;
	elapsedMs?: number;
	costUsd?: number;
	model?: string;
	toolCalls: number;
	toolsByName: Record<string, number>;
	lastTool?: string;
	result?: string;
	session?: string;
	error?: string;
}

function stringField(record: EventRecord, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: EventRecord, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Folds a node.started/node.finished/tool.request stream into one activity
 * record per node. A node.started resets the current run's tool count and
 * last tool — a resumed `running` node re-emits it with the same run number,
 * so a kill-and-resume restarts counting rather than double-counting — but
 * never resets accumulated cost, which sums every node.finished the node
 * ever produced. A running node's `elapsedMs` is computed against `nowMs`
 * after every record is folded, not stored per record.
 */
export function foldActivity(records: Iterable<EventRecord>, nowMs: number): Map<string, NodeActivity> {
	const byNode = new Map<string, NodeActivity>();
	for (const record of records) {
		if (record.type === "node.started") {
			const existing = byNode.get(record.node);
			byNode.set(record.node, {
				node: record.node,
				status: "running",
				runs: numberField(record, "run") ?? existing?.runs ?? 0,
				startedAtMs: Date.parse(record.ts),
				elapsedMs: undefined,
				costUsd: existing?.costUsd,
				model: stringField(record, "model"),
				toolCalls: 0,
				toolsByName: {},
				lastTool: undefined,
				result: existing?.result,
				session: existing?.session,
				error: undefined,
			});
			continue;
		}
		if (record.type === "node.finished") {
			const existing = byNode.get(record.node);
			const status = record.status === "failed" ? "failed" : "completed";
			const delta = numberField(record, "cost_usd");
			const costUsd = delta === undefined ? existing?.costUsd : (existing?.costUsd ?? 0) + delta;
			byNode.set(record.node, {
				node: record.node,
				status,
				runs: numberField(record, "run") ?? existing?.runs ?? 0,
				startedAtMs: existing?.startedAtMs,
				elapsedMs: numberField(record, "elapsed_ms") ?? existing?.elapsedMs,
				costUsd,
				model: existing?.model,
				toolCalls: existing?.toolCalls ?? 0,
				toolsByName: existing?.toolsByName ?? {},
				lastTool: existing?.lastTool,
				result: stringField(record, "result") ?? existing?.result,
				session: stringField(record, "session") ?? existing?.session,
				error: stringField(record, "error"),
			});
			continue;
		}
		if (record.type === "tool.request") {
			const existing = byNode.get(record.node);
			// Attribution needs an open node.started; a tool call before one (or on
			// a node the board never tracks) has nowhere to go.
			if (existing === undefined) continue;
			const tool = stringField(record, "tool");
			if (tool === undefined) continue;
			existing.toolCalls += 1;
			existing.toolsByName[tool] = (existing.toolsByName[tool] ?? 0) + 1;
			existing.lastTool = shortTool(tool, stringField(record, "path"));
		}
	}
	for (const activity of byNode.values()) {
		if (activity.status === "running" && activity.startedAtMs !== undefined) {
			activity.elapsedMs = Math.max(0, nowMs - activity.startedAtMs);
		}
	}
	return byNode;
}

/**
 * Folds per-node activity onto the board's eight stages. A stage with no
 * agent node (stageIndex -1) is dropped; several nodes on one stage sum their
 * tool calls and cost and merge their tool tallies, and the node that started
 * most recently supplies the rest (status, elapsed, last tool, model, ...).
 * Both shipped graphs run one agent node per superstep, so this merge is a
 * safety net, not the common case.
 */
export function stageActivities(byNode: Map<string, NodeActivity>, nowMs: number): Record<string, StageActivity> {
	const stages: Record<string, StageActivity> = {};
	const latestStartedAtMs = new Map<string, number>();
	for (const activity of byNode.values()) {
		const index = stageIndex(activity.node);
		if (index === -1) continue;
		const key = BOARD_STAGES[index].key;
		const elapsedMs =
			activity.status === "running" && activity.startedAtMs !== undefined
				? Math.max(0, nowMs - activity.startedAtMs)
				: activity.elapsedMs;
		const existing = stages[key];
		if (existing === undefined) {
			stages[key] = {
				status: activity.status,
				runs: activity.runs,
				...(elapsedMs === undefined ? {} : { elapsedMs }),
				...(activity.costUsd === undefined ? {} : { costUsd: activity.costUsd }),
				toolCalls: activity.toolCalls,
				toolsByName: { ...activity.toolsByName },
				...(activity.lastTool === undefined ? {} : { lastTool: activity.lastTool }),
				...(activity.model === undefined ? {} : { model: activity.model }),
				node: activity.node,
				...(activity.result === undefined ? {} : { result: activity.result }),
				...(activity.session === undefined ? {} : { session: activity.session }),
				...(activity.error === undefined ? {} : { error: activity.error }),
			};
			latestStartedAtMs.set(key, activity.startedAtMs ?? Number.NEGATIVE_INFINITY);
			continue;
		}
		const toolsByName: Record<string, number> = { ...existing.toolsByName };
		for (const [name, count] of Object.entries(activity.toolsByName)) {
			toolsByName[name] = (toolsByName[name] ?? 0) + count;
		}
		const costUsd =
			existing.costUsd === undefined && activity.costUsd === undefined
				? undefined
				: (existing.costUsd ?? 0) + (activity.costUsd ?? 0);
		const later =
			(activity.startedAtMs ?? Number.NEGATIVE_INFINITY) >= (latestStartedAtMs.get(key) ?? Number.NEGATIVE_INFINITY);
		const from = later ? activity : existing;
		const fromElapsed = later ? elapsedMs : existing.elapsedMs;
		stages[key] = {
			status: from === activity ? activity.status : existing.status,
			runs: from === activity ? activity.runs : existing.runs,
			...(fromElapsed === undefined ? {} : { elapsedMs: fromElapsed }),
			...(costUsd === undefined ? {} : { costUsd }),
			toolCalls: existing.toolCalls + activity.toolCalls,
			toolsByName,
			...(from.lastTool === undefined ? {} : { lastTool: from.lastTool }),
			...(from.model === undefined ? {} : { model: from.model }),
			node: from.node,
			...(from.result === undefined ? {} : { result: from.result }),
			...(from.session === undefined ? {} : { session: from.session }),
			...(from.error === undefined ? {} : { error: from.error }),
		};
		if (later) latestStartedAtMs.set(key, activity.startedAtMs ?? Number.NEGATIVE_INFINITY);
	}
	return stages;
}

export interface ActivitySnapshot {
	records: readonly EventRecord[];
	nodes: Map<string, NodeActivity>;
	stages: Record<string, StageActivity>;
	unreadableLines: number;
	readError?: string;
}

export interface ActivityReader {
	read(eventsPath: string, nowMs: number): Promise<ActivitySnapshot>;
	last(): ActivitySnapshot | undefined;
}

/**
 * Reads one events.jsonl incrementally: only the bytes appended since the
 * last read are parsed, so a widget tick on a long-running job is O(what
 * changed), not O(the log). Concurrent callers (the widget tick, a status
 * overlay build) coalesce onto one in-flight read rather than racing the
 * shared byte offset.
 */
export function createActivityReader(): ActivityReader {
	let path: string | undefined;
	let offset = 0;
	let records: EventRecord[] = [];
	let unreadableLines = 0;
	let partial = "";
	let lastSnapshot: ActivitySnapshot | undefined;
	let inflight: Promise<ActivitySnapshot> | undefined;

	function resetTo(nextPath: string): void {
		path = nextPath;
		offset = 0;
		records = [];
		unreadableLines = 0;
		partial = "";
	}

	function snapshot(nowMs: number, readError?: string): ActivitySnapshot {
		const nodes = foldActivity(records, nowMs);
		const result: ActivitySnapshot = {
			records: [...records],
			nodes,
			stages: stageActivities(nodes, nowMs),
			unreadableLines,
			...(readError === undefined ? {} : { readError }),
		};
		lastSnapshot = result;
		return result;
	}

	async function doRead(eventsPath: string, nowMs: number): Promise<ActivitySnapshot> {
		if (path !== eventsPath) {
			resetTo(eventsPath);
		}
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(eventsPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				resetTo(eventsPath);
				return snapshot(nowMs);
			}
			return snapshot(nowMs, (error as NodeJS.ErrnoException).code ?? String(error));
		}
		if (info.isDirectory()) {
			// A directory swapped in for the log is a read error, never a
			// truncation: report it without touching the offset or records.
			return snapshot(nowMs, "EISDIR");
		}
		const size = info.size;
		if (size < offset) {
			// Truncated or rotated under us: the old offset no longer means
			// anything, so start over rather than skip or misread bytes.
			resetTo(eventsPath);
		}
		if (size === offset) {
			return snapshot(nowMs);
		}
		let handle: FileHandle | undefined;
		try {
			handle = await open(eventsPath, "r");
			const length = size - offset;
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, offset);
			const chunk = partial + buffer.toString("utf8");
			const lines = chunk.split("\n");
			// The last split element is either "" (the chunk ended on a newline) or
			// an unterminated tail; neither is a complete line yet. Every byte just
			// read from disk has now been seen — either folded into a parsed line or
			// carried forward in `partial` — so the offset always advances to the
			// full new size, and the next read never re-reads these bytes.
			const tail = lines.pop() ?? "";
			for (const line of lines) {
				if (line.length === 0) continue;
				try {
					records.push(JSON.parse(line) as EventRecord);
				} catch {
					unreadableLines += 1;
				}
			}
			partial = tail;
			offset += length;
			return snapshot(nowMs);
		} catch (error) {
			return snapshot(nowMs, (error as NodeJS.ErrnoException).code ?? String(error));
		} finally {
			await handle?.close();
		}
	}

	return {
		read(eventsPath: string, nowMs: number): Promise<ActivitySnapshot> {
			if (inflight !== undefined) {
				return inflight;
			}
			const promise = doRead(eventsPath, nowMs).finally(() => {
				if (inflight === promise) {
					inflight = undefined;
				}
			});
			inflight = promise;
			return promise;
		},
		last(): ActivitySnapshot | undefined {
			return lastSnapshot;
		},
	};
}

/** The stage label a narration line names the node by: `03 plan`, or the bare node id off the rail. */
function narrationLabel(node: string): string {
	const index = stageIndex(node);
	return index === -1 ? node : `${BOARD_STAGES[index].id} ${BOARD_STAGES[index].label}`;
}

const NARRATED_ERROR_CHARS = 80;

/**
 * One chat line for a node start, finish, or route change — never for a
 * tool.request. Everything else narrates nothing.
 */
export function narrateRecord(record: EventRecord): { text: string; level: "info" | "warning" } | undefined {
	if (record.type === "node.started") {
		const label = narrationLabel(record.node);
		const run = numberField(record, "run");
		const model = stringField(record, "model");
		const parts = [`K-π ▶ ${label}`];
		if (run !== undefined) parts.push(`· run ${run}`);
		if (model !== undefined) parts.push(`· ${model}`);
		return { text: parts.join(" "), level: "info" };
	}
	if (record.type === "node.finished") {
		const label = narrationLabel(record.node);
		const elapsed = formatElapsed(numberField(record, "elapsed_ms") ?? 0);
		if (record.status === "failed") {
			const error = stringField(record, "error") ?? "unknown error";
			const clipped = error.length > NARRATED_ERROR_CHARS ? error.slice(0, NARRATED_ERROR_CHARS) : error;
			return { text: `K-π ✕ ${label} failed · ${elapsed} · ${clipped}`, level: "warning" };
		}
		const parts = [`K-π ■ ${label} done · ${elapsed}`];
		const cost = numberField(record, "cost_usd");
		if (cost !== undefined) parts.push(`· ${formatCost(cost)}`);
		const result = stringField(record, "result");
		if (result !== undefined) parts.push(`· ${result}`);
		return { text: parts.join(" "), level: "info" };
	}
	if (record.type === "accounts.failover") {
		const from = stringField(record, "from") ?? "?";
		const to = stringField(record, "to") ?? "?";
		return { text: `K-π ⇄ route ${from} → ${to}`, level: "warning" };
	}
	return undefined;
}
