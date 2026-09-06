import { join, relative, resolve } from "node:path";
import { getKpiResourceDir } from "../../config.ts";
import type { ExtensionAPI, ResourcesDiscoverResult } from "../../core/extensions/types.ts";
import { registerAccounts } from "./accounts/index.ts";
import { AccountsStore } from "./accounts/store.ts";
import { registerAppendSystem } from "./append-system.ts";
import { registerBackgroundBus } from "./bus/communicate.ts";
import { registerCursorProvider } from "./cursor/provider.ts";
import { registerKnowledgeGraph } from "./kg/index.ts";
import { type LocalProviderId, registerLocalProviders } from "./local/providers.ts";
import { registerPolicy } from "./policy.ts";
import { registerResearchTools } from "./research/index.ts";
import { readLiveJob, readTaskForJob, writeAllowForTask } from "./run-store.ts";
export async function resolveActiveWriteAllow(cwd: string): Promise<string[]> {
	const job = await readLiveJob(cwd);
	if (job === undefined) {
		return [];
	}
	const task = await readTaskForJob(cwd, job.jobId);
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

/** Native session capabilities, shared without installing another control plane. */
export function registerRuntime(pi: ExtensionAPI, options: { graphSession?: boolean } = {}): void {
	pi.on("resources_discover", discoverBundledResources);
	registerAccounts(pi);
	registerAppendSystem(pi);
	if (typeof pi.registerTool === "function") {
		registerBackgroundBus(pi, options);
		registerKnowledgeGraph(pi);
		registerResearchTools(pi);
	}
	if (typeof pi.registerProvider === "function") {
		registerCursorProvider(pi);
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
	registerPolicy(pi, { resolveWriteAllow: resolveActiveWriteAllow });
}
