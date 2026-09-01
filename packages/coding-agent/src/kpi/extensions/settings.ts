import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "../../config.ts";
import { isJsonObject, type JsonObject } from "./graph/schema.ts";
import { atomicWrite } from "./run-store.ts";

export const autoWrapState = { enabled: true };

/**
 * `kpi.research`. `auto` prefers Exa for developer research and keeps Perplexity
 * as the live fallback; a named service without a key falls back through `auto`
 * and then to local research.
 */
export const RESEARCH_MODES = ["auto", "exa", "perplexity", "local"] as const;

export type ResearchMode = (typeof RESEARCH_MODES)[number];

export function isResearchMode(value: unknown): value is ResearchMode {
	return typeof value === "string" && (RESEARCH_MODES as readonly string[]).includes(value);
}

export interface KpiSettings {
	research: ResearchMode;
}

const DEFAULT_SETTINGS: KpiSettings = { research: "auto" };

export function settingsPath(projectRoot: string): string {
	return join(projectRoot, CONFIG_DIR_NAME, "settings.json");
}

/**
 * Project settings. A missing or unreadable file is not a failure: research is
 * optional, so an absent setting means the default rather than a broken run.
 */
export async function readKpiSettings(projectRoot: string): Promise<KpiSettings> {
	try {
		const parsed: unknown = JSON.parse(await readFile(settingsPath(projectRoot), "utf8"));
		if (!isJsonObject(parsed)) {
			return { ...DEFAULT_SETTINGS };
		}
		return { research: isResearchMode(parsed.research) ? parsed.research : DEFAULT_SETTINGS.research };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** Persists the research mode, preserving any other setting already written. */
export async function writeResearchMode(projectRoot: string, mode: ResearchMode): Promise<void> {
	let existing: JsonObject = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(settingsPath(projectRoot), "utf8"));
		if (isJsonObject(parsed)) {
			existing = { ...parsed };
		}
	} catch {
		existing = {};
	}
	existing.research = mode;
	await atomicWrite(settingsPath(projectRoot), `${JSON.stringify(existing, null, 2)}\n`);
}
