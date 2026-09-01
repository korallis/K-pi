import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAccounts } from "./accounts/index.ts";
import { registerAutoWrap } from "./auto-wrap.ts";
import { registerBackgroundBus } from "./bus/communicate.ts";
import { registerCursorProvider } from "./cursor/provider.ts";
import { registerKnowledgeGraph } from "./kg/index.ts";
import { readActiveJob, registerControlPlane } from "./control-plane.ts";
import { registerPing } from "./ping.ts";
import { registerPolicy } from "./policy.ts";
import { registerPrintProfile } from "./print-profile.ts";
import { registerEventRenderers } from "./renderers.ts";
import { registerResearchTools } from "./research/index.ts";
import { registerStatusLine } from "./status-line/index.ts";
import { writeAllowForTask, type Task } from "./run-store.ts";
import { registerKMode } from "../kstack/mode.ts";
import { registerKStackSetup } from "../kstack/models.ts";

export async function resolveActiveWriteAllow(cwd: string): Promise<string[]> {
  const job = await readActiveJob(cwd);
  if (job === undefined) {
    return [];
  }
  const task = JSON.parse(
    await readFile(join(job.directory, "task.json"), "utf8"),
  ) as Task;
  return writeAllowForTask(task);
}

export default function kPi(pi: ExtensionAPI): void {
  registerAccounts(pi);
  registerAutoWrap(pi);
  if (typeof pi.registerTool === "function") {
    registerBackgroundBus(pi);
    registerKnowledgeGraph(pi);
    registerResearchTools(pi);
  }
  if (typeof pi.registerProvider === "function") registerCursorProvider(pi);
  registerControlPlane(pi);
  registerPing(pi);
  registerKMode(pi);
  registerKStackSetup(pi);

  registerPrintProfile(pi);
  registerPolicy(pi, { resolveWriteAllow: resolveActiveWriteAllow });
  registerEventRenderers(pi);
  registerStatusLine(pi);
}
