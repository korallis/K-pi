import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { isJsonObject, type JsonObject } from "./graph/schema.ts";
import { atomicWrite } from "./run-store.ts";

/**
 * `kpi.routing`. How a bare (non-slash) message reaches the K-π loop.
 *
 * - `auto`: bare text is ordinary harness input; the agent starts a job for
 *   substantial work through the `kpi_start_job` tool.
 * - `always`: every bare message is wrapped into a gated `/kpi` job.
 * - `off`: nothing starts a job automatically; only `/kpi`, `/loop`, `/k-mode`.
 */
export const ROUTING_MODES = ["auto", "always", "off"] as const;

export type RoutingMode = (typeof ROUTING_MODES)[number];

export function isRoutingMode(value: unknown): value is RoutingMode {
	return typeof value === "string" && (ROUTING_MODES as readonly string[]).includes(value);
}

/** Session override set by `/kpi auto|always|off`; `undefined` means "use settings". */
export const routingState: { override?: RoutingMode } = {};

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

/**
 * Where research services are reached and how long a request may take.
 *
 * Present so an operator can point the clients at a self-hosted gateway or a
 * contained origin. Validated on read: a base URL that cannot be used is a
 * configuration error the operator must see, not a silent fall back to the
 * public host they were trying to avoid.
 */
export interface KpiResearchEndpointSettings {
	exa?: string;
	perplexity?: string;
	timeoutMs?: number;
}

export interface KpiSettings {
	research: ResearchMode;
	researchEndpoints: KpiResearchEndpointSettings;
	routing: RoutingMode;
}

const DEFAULT_SETTINGS: KpiSettings = { research: "auto", researchEndpoints: {}, routing: "auto" };

function readEndpointSettings(value: unknown): KpiResearchEndpointSettings {
	if (!isJsonObject(value)) {
		return {};
	}
	return {
		...(typeof value.exa === "string" ? { exa: value.exa } : {}),
		...(typeof value.perplexity === "string" ? { perplexity: value.perplexity } : {}),
		...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
	};
}

export function settingsPath(projectRoot: string): string {
	return join(projectRoot, CONFIG_DIR_NAME, "settings.json");
}

/** The operator's own settings file; the harness keeps unknown top-level keys such as `kpi`. */
export function userSettingsPath(agentDirectory: string = getAgentDir()): string {
	return join(agentDirectory, "settings.json");
}

async function readJsonObject(path: string): Promise<JsonObject | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isJsonObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Settings. A missing or unreadable file is not a failure: every setting is
 * optional, so an absent value means the default rather than a broken run.
 *
 * Research settings are project-only. Routing is read from the project file
 * (top-level `routing`) first and from the user file (`kpi.routing`) second, so
 * a repository can pin how its operators enter the loop while a person keeps a
 * default for everywhere else.
 */
export async function readKpiSettings(
	projectRoot: string,
	agentDirectory: string = getAgentDir(),
): Promise<KpiSettings> {
	const project = (await readJsonObject(settingsPath(projectRoot))) ?? {};
	const user = (await readJsonObject(userSettingsPath(agentDirectory))) ?? {};
	const userKpi = isJsonObject(user.kpi) ? user.kpi : {};
	return {
		research: isResearchMode(project.research) ? project.research : DEFAULT_SETTINGS.research,
		researchEndpoints: readEndpointSettings(project.researchEndpoints),
		routing: isRoutingMode(project.routing)
			? project.routing
			: isRoutingMode(userKpi.routing)
				? userKpi.routing
				: DEFAULT_SETTINGS.routing,
	};
}

/** Effective routing for this session: the `/kpi` override, else settings. */
export async function resolveRoutingMode(
	projectRoot: string,
	agentDirectory: string = getAgentDir(),
): Promise<RoutingMode> {
	return routingState.override ?? (await readKpiSettings(projectRoot, agentDirectory)).routing;
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
