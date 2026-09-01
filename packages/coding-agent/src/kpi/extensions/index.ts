import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getKpiResourceDir } from "../../config.ts";
import type { ExtensionAPI, ResourcesDiscoverResult } from "../../core/extensions/types.ts";
import { registerKMode } from "../kstack/mode.ts";
import { registerKStackSetup } from "../kstack/models.ts";
import { registerAccounts } from "./accounts/index.ts";
import { AccountsStore } from "./accounts/store.ts";
import { registerAutoWrap } from "./auto-wrap.ts";
import { registerBackgroundBus } from "./bus/communicate.ts";
import { registerControlPlane } from "./control-plane.ts";
import { registerCursorProvider } from "./cursor/provider.ts";
import { registerKnowledgeGraph } from "./kg/index.ts";
import { type LocalProviderId, registerLocalProviders } from "./local/providers.ts";
import { registerPing } from "./ping.ts";
import { registerPolicy } from "./policy.ts";
import { registerPrintProfile } from "./print-profile.ts";
import { registerEventRenderers } from "./renderers.ts";
import { registerResearchTools } from "./research/index.ts";
import { readActiveJob, type Task, writeAllowForTask } from "./run-store.ts";
import { registerStatusLine } from "./status-line/index.ts";

export async function resolveActiveWriteAllow(cwd: string): Promise<string[]> {
	const job = await readActiveJob(cwd);
	if (job === undefined) {
		return [];
	}
	const task = JSON.parse(await readFile(join(job.directory, "task.json"), "utf8")) as Task;
	return writeAllowForTask(task);
}

/**
 * Resource directories the K-π loop ships with the harness. Every path is always
 * declared: the resource loader must report a missing root as a diagnostic rather
 * than silently serving a harness with no skills, prompts, or themes.
 */
function bundledResourcePaths(...relativePaths: string[][]): string[] {
	const root = getKpiResourceDir();
	return relativePaths.map((segments) => join(root, ...segments));
}

function discoverBundledResources(): ResourcesDiscoverResult {
	return {
		skillPaths: bundledResourcePaths(["skills"], ["kstack", "generated", "skills"]),
		promptPaths: bundledResourcePaths(["prompts"]),
		themePaths: bundledResourcePaths(["themes"]),
	};
}

export default function kPi(pi: ExtensionAPI): void {
	pi.on("resources_discover", discoverBundledResources);
	registerAccounts(pi);
	registerAutoWrap(pi);
	if (typeof pi.registerTool === "function") {
		registerBackgroundBus(pi);
		registerKnowledgeGraph(pi);
		registerResearchTools(pi);
	}
	if (typeof pi.registerProvider === "function") {
		registerCursorProvider(pi);
		// Local pools discover live against the origin their own slot persisted.
		registerLocalProviders(pi, {
			resolveBaseUrl: async (poolId: LocalProviderId) => {
				const store = new AccountsStore();
				const slots = (await store.read()).pools[poolId]?.slots ?? [];
				const local = slots.find((slot) => slot.kind === "local");
				return local?.baseUrl;
			},
			resolveToken: async (poolId: LocalProviderId) => {
				const store = new AccountsStore();
				const slots = (await store.read()).pools[poolId]?.slots ?? [];
				const reference = slots.find((slot) => slot.kind === "local")?.secretRef;
				if (reference === undefined) return undefined;
				const credential = (await store.readSecrets())[reference];
				return credential?.type === "api_key"
					? credential.key
					: credential?.type === "oauth"
						? credential.access
						: undefined;
			},
		});
	}
	registerControlPlane(pi);
	registerPing(pi);
	registerKMode(pi);
	registerKStackSetup(pi);

	registerPrintProfile(pi);
	registerPolicy(pi, { resolveWriteAllow: resolveActiveWriteAllow });
	registerEventRenderers(pi);
	registerStatusLine(pi);
}
