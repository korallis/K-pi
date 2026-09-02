import type { ExtensionAPI } from "../../core/extensions/types.ts";

import { EVENT_TYPES, type EventRecord, type EventType } from "./append-log.ts";

function field(event: EventRecord | undefined, key: string): string | undefined {
	const value = event?.[key];
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	return undefined;
}

/**
 * One-line operator-visible event text. Field-aware for research, accounts,
 * bus, checkpoint, and terminal/verdict-shaped payloads. Never a markdown table.
 */
export function formatEventEntry(type: EventType, event: EventRecord | undefined): string {
	const job = event?.job_id === undefined ? "" : ` job=${event.job_id}`;
	const round = event?.round === undefined ? "" : ` r${event.round}`;

	if (type.startsWith("research.")) {
		const mode = field(event, "mode");
		const service = field(event, "service");
		const network = field(event, "network_state");
		const count = field(event, "result_count");
		const reason = field(event, "reason");
		const query = field(event, "query");
		const parts = [`K-π ${type}${job}${round}`];
		if (mode) parts.push(`mode=${mode}`);
		if (service) parts.push(`svc=${service}`);
		if (network) parts.push(`net=${network}`);
		if (count) parts.push(`n=${count}`);
		if (reason) parts.push(reason);
		if (query) parts.push(`q=${query.length > 40 ? `${query.slice(0, 39)}…` : query}`);
		return parts.join(" ");
	}

	if (type === "accounts.failover") {
		const from = field(event, "from") ?? "?";
		const to = field(event, "to") ?? "?";
		const reason = field(event, "reason");
		return `K-π accounts.failover${job}${round} ${from} → ${to}${reason ? ` (${reason})` : ""}`;
	}

	if (type === "agent.spawned") {
		const agent = field(event, "agent_id") ?? "?";
		const role = field(event, "role") ?? "worker";
		const pid = field(event, "pid");
		return `K-π agent.spawned${job}${round} ${role} ${agent}${pid ? ` pid=${pid}` : ""}`;
	}

	if (type === "agent.message") {
		const agent = field(event, "agent_id") ?? "?";
		const deliver = field(event, "deliver_as");
		const status = field(event, "status");
		return `K-π agent.message${job}${round} ${agent}${deliver ? ` as=${deliver}` : ""}${status ? ` ${status}` : ""}`;
	}

	if (type === "checkpoint") {
		const detail = field(event, "detail");
		return `K-π checkpoint${job}${round}${detail ? ` ${detail}` : ""}`;
	}

	if (type === "loop.terminal") {
		const status = field(event, "status") ?? "DONE";
		const reason = field(event, "reason");
		return `K-π loop.terminal${job}${round} ${status}${reason ? ` — ${reason}` : ""}`;
	}

	const status = typeof event?.status === "string" ? ` status=${event.status}` : "";
	return `K-π ${type}${job}${round}${status}`;
}

/**
 * Structured verdict → visible assistant protocol reply (M-06).
 * Lead with verdict, then paths/issues/next action. No board dump.
 */
export function formatVerdictReply(verdict: {
	status: string;
	approved?: boolean;
	blockingIssues?: readonly string[];
	nonBlockingIssues?: readonly string[];
	evidence?: readonly string[];
	round?: number;
}): string {
	const lines: string[] = [];
	const approved = verdict.approved === true ? "approved" : verdict.approved === false ? "not approved" : undefined;
	lines.push(approved === undefined ? `Verdict: ${verdict.status}` : `Verdict: ${verdict.status} (${approved})`);
	if (verdict.round !== undefined) {
		lines.push(`Round ${verdict.round}`);
	}
	const blocking = verdict.blockingIssues ?? [];
	if (blocking.length > 0) {
		lines.push(`Blocking: ${blocking.slice(0, 5).join("; ")}`);
	}
	const nonBlocking = verdict.nonBlockingIssues ?? [];
	if (nonBlocking.length > 0) {
		lines.push(`Notes: ${nonBlocking.slice(0, 3).join("; ")}`);
	}
	const evidence = verdict.evidence ?? [];
	if (evidence.length > 0) {
		lines.push(`Evidence: ${evidence.slice(0, 4).join(", ")}`);
	}
	if (verdict.status === "PASS" && verdict.approved === true) {
		lines.push("Next: ship when the human gate allows.");
	} else if (verdict.status === "REVISE") {
		lines.push("Next: address blocking issues and re-run review.");
	} else if (verdict.status === "BLOCKED") {
		lines.push("Next: resolve blockers or stop.");
	} else {
		lines.push("Next: continue the loop.");
	}
	return lines.join("\n");
}

export function registerEventRenderers(pi: ExtensionAPI): void {
	for (const type of EVENT_TYPES) {
		pi.registerEntryRenderer<EventRecord>(type, (entry) => {
			const line = formatEventEntry(type, entry.data);
			return {
				invalidate() {},
				render() {
					return [line];
				},
			};
		});
	}
}
