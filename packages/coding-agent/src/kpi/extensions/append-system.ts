import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, getKpiResourceDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { atomicWriteSync } from "./run-store.ts";

/**
 * The file name the resource loader looks for. K-π's brevity rule is an
 * *append*, never a replacement: `SYSTEM.md` would displace the harness's own
 * coding prompt, and the rule is one paragraph about how to answer, not a
 * different agent.
 */
export const APPEND_SYSTEM_FILE = "APPEND_SYSTEM.md";

export function shippedAppendSystemPath(): string {
	return join(getKpiResourceDir(), "templates", APPEND_SYSTEM_FILE);
}

export function installedAppendSystemPath(agentDirectory: string = getAgentDir()): string {
	return join(agentDirectory, APPEND_SYSTEM_FILE);
}

export type AppendSystemOutcome = "installed" | "current" | "operator-owned" | "replaced" | "kept" | "unavailable";

export interface AppendSystemStatus {
	outcome: AppendSystemOutcome;
	path: string;
}

function readIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Installs the shipped brevity prompt on first run, and only then.
 *
 * A rule that ships in `dist` but is never loaded is not in force, so a fresh
 * agent directory gets it without being asked. An existing file is the
 * operator's, whether they wrote it or edited ours: it is reported, never
 * touched. Replacing it is a separate, confirmed decision.
 *
 * Synchronous on purpose. The resource loader discovers this file while it
 * assembles the system prompt, and it loads extensions first - so an install
 * that runs during registration is on disk in time for the very first turn,
 * while anything awaited later would only reach the second session in a fresh
 * agent directory.
 */
export function ensureAppendSystemInstalled(agentDirectory: string = getAgentDir()): AppendSystemStatus {
	const target = installedAppendSystemPath(agentDirectory);
	const shipped = readIfPresent(shippedAppendSystemPath());
	if (shipped === undefined) {
		// A source tree without a built resource directory is not a failure to
		// report at every session start.
		return { outcome: "unavailable", path: target };
	}
	const existing = readIfPresent(target);
	if (existing !== undefined) {
		return { outcome: existing === shipped ? "current" : "operator-owned", path: target };
	}
	atomicWriteSync(target, shipped);
	return { outcome: "installed", path: target };
}

/**
 * The explicit surface. Reinstalling over an operator's own file requires their
 * confirmation at the point of risk, and a decline leaves the file exactly as it
 * was.
 */
export async function installAppendSystemCommand(
	ctx: ExtensionCommandContext,
	agentDirectory: string = getAgentDir(),
): Promise<AppendSystemStatus> {
	const status = ensureAppendSystemInstalled(agentDirectory);
	if (status.outcome === "unavailable") {
		ctx.ui.notify(`No shipped ${APPEND_SYSTEM_FILE} found at ${shippedAppendSystemPath()}`, "warning");
		return status;
	}
	if (status.outcome === "installed") {
		ctx.ui.notify(`Installed K-π ${APPEND_SYSTEM_FILE} at ${status.path}`, "info");
		return status;
	}
	if (status.outcome === "current") {
		ctx.ui.notify(`${status.path} already matches the shipped ${APPEND_SYSTEM_FILE}`, "info");
		return status;
	}
	const approved = await ctx.ui.confirm(
		`Replace ${APPEND_SYSTEM_FILE}?`,
		`${status.path} differs from the shipped prompt. Replace your version with K-π's?`,
	);
	if (!approved) {
		ctx.ui.notify(`Kept your ${status.path}`, "info");
		return { outcome: "kept", path: status.path };
	}
	const shipped = readIfPresent(shippedAppendSystemPath());
	if (shipped === undefined) {
		return { outcome: "unavailable", path: status.path };
	}
	atomicWriteSync(status.path, shipped);
	ctx.ui.notify(`Replaced ${status.path} with the shipped ${APPEND_SYSTEM_FILE}`, "info");
	return { outcome: "replaced", path: status.path };
}

/** Reports whether the installed prompt is in force, without changing it. */
export function appendSystemInstalled(agentDirectory: string = getAgentDir()): boolean {
	try {
		return statSync(installedAppendSystemPath(agentDirectory)).isFile();
	} catch {
		return false;
	}
}

export function registerAppendSystem(pi: ExtensionAPI): void {
	// Installed here, not on `session_start`: the resource loader loads
	// extensions before it discovers the append file, so registration is the
	// last moment that still lands ahead of the first system prompt. First run
	// installs it; every later run leaves whatever is there alone.
	ensureAppendSystemInstalled();
	pi.registerCommand("append-system", {
		description: "Install K-π's concise-output system prompt, or report the file already in place",
		handler: async (_args, ctx) => {
			await installAppendSystemCommand(ctx);
		},
	});
}
