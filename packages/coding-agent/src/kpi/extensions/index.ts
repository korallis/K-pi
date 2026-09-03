import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { getKpiResourceDir } from "../../config.ts";
import type { ExtensionAPI, ResourcesDiscoverResult } from "../../core/extensions/types.ts";
import { registerKMode } from "../kstack/mode.ts";
import { registerKStackSetup } from "../kstack/models.ts";
import { registerAccounts } from "./accounts/index.ts";
import { AccountsStore } from "./accounts/store.ts";
import { registerAppendSystem } from "./append-system.ts";

import { registerBackgroundBus } from "./bus/communicate.ts";
import { registerControlPlane } from "./control-plane.ts";
import { registerCursorProvider } from "./cursor/provider.ts";
import { registerKnowledgeGraph } from "./kg/index.ts";
import { type LocalProviderId, registerLocalProviders } from "./local/providers.ts";
import { registerOnboarding } from "./onboarding.ts";
import { registerPing } from "./ping.ts";
import { registerPolicy } from "./policy.ts";
import { registerPrintProfile } from "./print-profile.ts";
import { registerEventRenderers } from "./renderers.ts";
import { registerResearchTools } from "./research/index.ts";
import { registerRouting } from "./routing.ts";
import { readLiveJob, type Task, writeAllowForTask } from "./run-store.ts";
import { registerStatusLine } from "./status-line/index.ts";

export async function resolveActiveWriteAllow(cwd: string): Promise<string[]> {
	const job = await readLiveJob(cwd);
	if (job === undefined) {
		return [];
	}
	const task = JSON.parse(await readFile(join(job.directory, "task.json"), "utf8")) as Task;
	const allow = [...writeAllowForTask(task)];
	const runRelative = relative(resolve(cwd), resolve(job.directory)).replaceAll("\\", "/");
	if (runRelative.length > 0 && !runRelative.startsWith("..")) {
		allow.push(`${runRelative}/candidate.json`);
	}
	return allow;
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
	registerAppendSystem(pi);
	registerRouting(pi);
	if (typeof pi.registerTool === "function") {
		registerBackgroundBus(pi);
		registerKnowledgeGraph(pi);
		registerResearchTools(pi);
	}
	if (typeof pi.registerProvider === "function") {
		registerCursorProvider(pi);
		// Local pools discover live against the origin their own slot persisted.
		registerLocalProviders(pi, {
			resolveSlots: async (poolId: LocalProviderId) => {
				const slots = (await new AccountsStore().read()).pools[poolId]?.slots ?? [];
				return slots.flatMap((slot) =>
					slot.kind === "local" && slot.baseUrl !== undefined
						? [{ slotId: slot.id, baseUrl: slot.baseUrl, secretRef: slot.secretRef }]
						: [],
				);
			},
			resolveToken: async (poolId: LocalProviderId, slotId: string) => {
				const store = new AccountsStore();
				const slot = (await store.read()).pools[poolId]?.slots.find((candidate) => candidate.id === slotId);
				const reference = slot?.kind === "local" ? slot.secretRef : undefined;
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
	// Registered last: its session_start hook must run after the accounts
	// credential import and the footer install above.
	registerOnboarding(pi);
}
