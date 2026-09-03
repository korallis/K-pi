import type { ExtensionAPI, ExtensionCommandContext } from "../../../core/extensions/types.ts";

import { truncatePlain } from "../board.ts";
import { readLiveJob } from "../run-store.ts";
import { type SessionsSnapshot, sessionsSnapshot } from "./sessions-snapshot.ts";
import { MAX_LIVE_WORKERS, MAX_LIVE_WRITERS, processWorkerAdmission, type WorkerAdmission } from "./spawn.ts";

/**
 * `/agents`: the live sessions of this kpi process.
 *
 * Files and memory only: the registry is in-process, the caps come from the
 * admission table the parent's buses use, and the only disk read is the live
 * job's progress document for its id and status. No model, no mutation.
 */

const ID_WIDTH = 28;
const COLUMNS = ["KIND", "ID", "ROLE", "MODEL", "PID", "ALIVE", "ELAPSED", "TOOLS", "LAST", "NODE", "JOB"] as const;

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** `12s`, `3m04s`, `1h02m`. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${pad(seconds % 60)}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${pad(minutes % 60)}m`;
}

function cellsFor(row: SessionsSnapshot["rows"][number]): string[] {
	return [
		row.kind,
		truncatePlain(row.id, ID_WIDTH),
		row.role,
		row.model ?? "-",
		String(row.pid),
		row.alive ? "yes" : "no",
		row.elapsedMs === undefined ? "-" : formatElapsed(row.elapsedMs),
		row.toolCalls === undefined ? "-" : String(row.toolCalls),
		row.lastActivity ?? "-",
		row.node ?? "-",
		row.job ?? "-",
	];
}

/** Fixed-column rendering: every column as wide as its widest cell, two spaces between. */
function table(rows: string[][]): string[] {
	const widths = COLUMNS.map((column, index) =>
		rows.reduce((width, row) => Math.max(width, row[index].length), column.length),
	);
	const line = (cells: readonly string[]): string =>
		cells
			.map((cell, index) => cell.padEnd(widths[index]))
			.join("  ")
			.trimEnd();
	return [line(COLUMNS), ...rows.map(line)];
}

export function formatSessionsTable(
	snapshot: SessionsSnapshot,
	caps: { workers: number; writers: number },
	job?: { jobId: string; status: string },
): string[] {
	const { nodes, workers, liveTotal } = snapshot.counts;
	const lines = [
		`K-π SESSIONS ${liveTotal} live · ${nodes} node(s) in-process · ${workers} worker process(es)`,
		...table(snapshot.rows.map(cellsFor)),
		`caps (this process): workers ${caps.workers}/${MAX_LIVE_WORKERS} · writers ${caps.writers}/${MAX_LIVE_WRITERS}`,
		snapshot.mechanism,
	];
	if (job === undefined) {
		lines.push("no active job");
		return lines;
	}
	lines.push(`job ${job.jobId} ${job.status}`);
	const hasNodeFor = snapshot.rows.some((row) => row.kind === "node" && row.job === job.jobId);
	if (job.status === "RUNNING" && !hasNodeFor) {
		lines.push(`no in-process node session for job ${job.jobId}: its loop is not running in this kpi process`);
	}
	return lines;
}

export function registerSessionsCommand(
	pi: ExtensionAPI,
	options: { admission?: WorkerAdmission; now?: () => Date } = {},
): void {
	if (typeof pi.registerCommand !== "function") {
		return;
	}
	pi.registerCommand("agents", {
		description: "Show live K-π sessions: main, in-process graph nodes, worker processes",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim() !== "") {
				ctx.ui.notify("K-π usage: /agents", "warning");
				return;
			}
			let job: { jobId: string; status: string } | undefined;
			try {
				const live = await readLiveJob(ctx.cwd);
				job =
					live === undefined ? undefined : { jobId: live.jobId, status: String(live.state.status ?? "unknown") };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`K-π /agents could not read the run store: ${message}`, "error");
				return;
			}
			const snapshot = sessionsSnapshot({
				main: {
					sessionId: ctx.sessionManager.getSessionId(),
					model: ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`,
					pid: process.pid,
				},
				now: options.now,
			});
			const caps = (options.admission ?? processWorkerAdmission).counts();
			ctx.ui.notify(formatSessionsTable(snapshot, caps, job).join("\n"), "info");
		},
	});
}
