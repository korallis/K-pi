import type { BackgroundBus, LiveWorker } from "./spawn.ts";

/**
 * The process-local registry of live K-π sessions.
 *
 * Two kinds of session exist in one kpi process: graph nodes, which run as
 * in-process agent sessions, and workers, which are separate `kpi --mode rpc`
 * processes owned by a `BackgroundBus`. Nothing here reads disk or starts
 * anything: the graph engine registers a node session for the life of the node,
 * and whoever constructs a bus registers it until it shuts the bus down. Every
 * registration returns its own idempotent remover, so unrelated buses never
 * appear and a test seam (`resetSessionsRegistry`) clears both tables.
 *
 * Worker liveness is the bus's own answer (`bus.liveWorkers()`, its injected
 * pid predicate, never reaping): a worker whose launch or pid is dead is listed
 * with `alive: false` and is never counted.
 */

export interface LiveNodeSession {
	kind: "node";
	jobId: string;
	nodeId: string;
	sessionId: string;
	contextMode: "isolated" | "thread";
	threadKey: string;
	model?: string;
	/** ISO timestamp of when the node session started. */
	startedAt: string;
	/** The session's own counters, read lazily; a throwing reader yields no tool count. */
	stats?: () => { cost: number; toolCalls?: number } | undefined;
}

export interface LiveWorkerSession extends LiveWorker {
	kind: "worker";
	jobId: string;
}

export interface SessionRow {
	kind: "main" | "node" | "worker";
	id: string;
	role: string;
	model?: string;
	pid: number;
	alive: boolean;
	startedAt?: string;
	elapsedMs?: number;
	lastActivity?: string;
	job?: string;
	node?: string;
	toolCalls?: number;
}

export interface SessionsSnapshot {
	rows: SessionRow[];
	/** `workers` counts alive workers only; `liveTotal` is nodes + workers. */
	counts: { nodes: number; workers: number; liveTotal: number };
	mechanism: string;
}

export const MECHANISM_SENTENCE =
	"K-π runs graph nodes as in-process sessions in this kpi process; a node with workerRole (the reviewer) and the spawn_background tool start separate kpi --mode rpc processes that talk over .kpi/runs/<job>/bus.jsonl. No sub-agent API is used.";

const nodeSessions = new Set<LiveNodeSession>();
const buses = new Set<BackgroundBus>();

/** Adds a node session; the returned remover is idempotent. */
export function registerLiveNodeSession(record: LiveNodeSession): () => void {
	nodeSessions.add(record);
	return () => {
		nodeSessions.delete(record);
	};
}

/** Adds a bus; the returned remover is idempotent. Owners release at shutdown. */
export function registerLiveBus(bus: BackgroundBus): () => void {
	buses.add(bus);
	return () => {
		buses.delete(bus);
	};
}

/** Test seam: forgets every registration. */
export function resetSessionsRegistry(): void {
	nodeSessions.clear();
	buses.clear();
}

export function liveNodeSessions(jobId?: string): LiveNodeSession[] {
	const rows: LiveNodeSession[] = [];
	for (const record of nodeSessions) {
		if (jobId === undefined || record.jobId === jobId) {
			rows.push(record);
		}
	}
	return rows;
}

/**
 * Every worker of every registered, still-open bus. Dead-but-unreaped workers
 * are returned with `alive: false`; the bus is never asked to reap.
 */
export function liveWorkerSessions(jobId?: string): LiveWorkerSession[] {
	const rows: LiveWorkerSession[] = [];
	for (const bus of buses) {
		if (bus.isClosing) {
			continue;
		}
		if (jobId !== undefined && bus.jobId !== jobId) {
			continue;
		}
		for (const worker of bus.liveWorkers()) {
			rows.push({ kind: "worker", jobId: bus.jobId, ...worker });
		}
	}
	return rows;
}

export function liveWorkerCount(jobId?: string): number {
	return liveWorkerSessions(jobId).filter((worker) => worker.alive).length;
}

function nodeToolCalls(record: LiveNodeSession): number | undefined {
	try {
		return record.stats?.()?.toolCalls;
	} catch {
		// A session mid-teardown may refuse its stats; the row still lists without a count.
		return undefined;
	}
}

/**
 * A pure, synchronous picture of the sessions this process owns.
 *
 * With `jobId` the rows are scoped to that job (what the board counts); without
 * it every session is listed with its job (what `/agents` prints). The main row
 * appears only when the caller describes it, and is never counted.
 */
export function sessionsSnapshot(options: {
	jobId?: string;
	main?: { sessionId?: string; model?: string; pid: number };
	now?: () => Date;
}): SessionsSnapshot {
	const now = (options.now ?? (() => new Date()))().getTime();
	const rows: SessionRow[] = [];
	if (options.main !== undefined) {
		rows.push({
			kind: "main",
			id: options.main.sessionId ?? "main",
			role: "main",
			...(options.main.model === undefined ? {} : { model: options.main.model }),
			pid: options.main.pid,
			alive: true,
		});
	}
	const nodes = liveNodeSessions(options.jobId);
	for (const record of nodes) {
		const started = Date.parse(record.startedAt);
		const toolCalls = nodeToolCalls(record);
		rows.push({
			kind: "node",
			id: record.nodeId,
			role: `node:${record.contextMode}`,
			...(record.model === undefined ? {} : { model: record.model }),
			pid: process.pid,
			alive: true,
			startedAt: record.startedAt,
			elapsedMs: Number.isNaN(started) ? 0 : Math.max(0, now - started),
			job: record.jobId,
			...(toolCalls === undefined ? {} : { toolCalls }),
		});
	}
	let workers = 0;
	for (const worker of liveWorkerSessions(options.jobId)) {
		if (worker.alive) {
			workers += 1;
		}
		rows.push({
			kind: "worker",
			id: worker.agentId,
			role: worker.role,
			pid: worker.pid,
			alive: worker.alive,
			startedAt: worker.spawnedAt,
			lastActivity: worker.lastEvent,
			job: worker.jobId,
			...(worker.node === undefined ? {} : { node: worker.node }),
		});
	}
	return {
		rows,
		counts: { nodes: nodes.length, workers, liveTotal: nodes.length + workers },
		mechanism: MECHANISM_SENTENCE,
	};
}
