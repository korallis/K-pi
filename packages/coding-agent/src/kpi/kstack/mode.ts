import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "../../core/extensions/types.ts";

export type PlaybookName = "feature" | "bug-fix" | "investigation" | "shipping" | "autonomous-run";

export interface KModePlan {
	playbook: PlaybookName;
	todos: string[];
}

export interface KModeState {
	enabled: boolean;
	plan?: KModePlan;
}

export const kModeState: KModeState = { enabled: false };

export function matchPlaybook(task: string): PlaybookName {
	if (/bug|fix|broken|regression/iu.test(task)) return "bug-fix";
	if (/investigate|research|diagnose|why/iu.test(task)) return "investigation";
	if (/ship|release/iu.test(task)) return "shipping";
	if (/autonomous|autopilot/iu.test(task)) return "autonomous-run";
	return "feature";
}

const STEPS: Record<PlaybookName, string[]> = {
	feature: ["read Principles", "specify", "plan", "implement", "test", "review", "ship"],
	"bug-fix": ["read Principles", "reproduce", "plan", "implement", "test", "review", "ship"],
	investigation: ["read Principles", "research", "collect evidence", "report"],
	shipping: ["read Principles", "verify evidence", "review", "ship"],
	"autonomous-run": ["read Principles", "verify executable AC", "plan", "implement", "test", "review", "ship"],
};

export function createKModePlan(task: string): KModePlan {
	const playbook = matchPlaybook(task);
	return { playbook, todos: [...STEPS[playbook]] };
}

export async function assertShipApproved(runDirectory: string): Promise<void> {
	const verdict = JSON.parse(await readFile(join(runDirectory, "verdict.json"), "utf8")) as { approved?: unknown };
	if (verdict.approved !== true) throw new Error("Ship is blocked until verdict.approved is true");
}

export function registerKMode(pi: ExtensionAPI): void {
	pi.registerCommand("k-mode", {
		description: "Enable sticky K-mode rigor and select a K-stack playbook",
		handler: async (args, context) => {
			const task = args.trim();
			if (task === "off") {
				kModeState.enabled = false;
				delete kModeState.plan;
				context.ui.notify("K-mode off", "info");
				return;
			}
			kModeState.enabled = true;
			if (task.length > 0) kModeState.plan = createKModePlan(task);
			context.ui.notify(
				kModeState.plan === undefined
					? "K-mode on"
					: `K-mode on · K-stack ${kModeState.plan.playbook} · ${kModeState.plan.todos.join(" → ")}`,
				"info",
			);
		},
	});
}
