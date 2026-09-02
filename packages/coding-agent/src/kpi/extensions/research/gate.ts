import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonObject } from "../graph/schema.ts";
import { atomicWrite, contractHash, type Task } from "../run-store.ts";
import type { ResearchMode } from "../settings.ts";
import { DEFAULT_RESEARCH_ENDPOINTS, type ResearchEndpoints } from "./endpoints.ts";
import { exaSearch } from "./exa.ts";
import { perplexitySearch } from "./perplexity.ts";
import {
	clampField,
	MAX_RESULTS_PER_REQUEST,
	type ResearchKeys,
	ResearchSession,
	ResearchShortfallError,
	type ResearchSource,
} from "./session.ts";

/** Two distinct external origins, per AC-29.2. */
export const REQUIRED_EXTERNAL_SOURCES = 2;

export interface ResearchDocument {
	job_id: string;
	task_hash: string;
	mode: ResearchMode;
	network: {
		state: "online" | "no-network";
		origin?: "operator" | "engine";
		reason?: string;
		failures: { service: string; class: string; at: string }[];
	};
	sources: ResearchSource[];
}

export interface ResearchDependencies {
	/** Resolved once by the control plane; saved keys already beat the environment. */
	keys?: ResearchKeys;
	mode?: ResearchMode;
	fetch?: typeof fetch;
	now?: () => Date;
	eventsPath?: string;
	round?: number;
	node?: string;
	operatorNoNetwork?: boolean;
	maxExternalCalls?: number;
	signal?: AbortSignal;
	/** Resolved origins. Absent means each service's documented default. */
	endpoints?: ResearchEndpoints;
	/** Per-request deadline, resolved by the control plane. */
	timeoutMs?: number;
}

/** Research binds to what the job must achieve, not to which slice is current. */
export function taskHash(task: Task): string {
	return contractHash(task);
}

/**
 * Files a planning node reads when there is no network: the repository's own
 * contract and plan, cited by repository-relative path.
 */
const LOCAL_RESEARCH_CANDIDATES = [
	"AGENTS.md",
	"README.md",
	"package.json",
	"docs/spec.md",
	"specs/requirements.md",
	"specs/design.md",
	"specs/tasks.md",
];

async function collectLocalSources(projectRoot: string, runDirectory: string, session: ResearchSession): Promise<void> {
	for (const path of LOCAL_RESEARCH_CANDIDATES) {
		try {
			const content = await readFile(join(projectRoot, path), "utf8");
			session.addLocalSource(path, path, clampField(content, 1_000));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}
	// A frozen plan is local research too, and it is the most specific source a
	// planning node has.
	for (const name of ["requirements.md", "design.md", "tasks.md"]) {
		const path = join("plan", name);
		try {
			const content = await readFile(join(runDirectory, path), "utf8");
			session.addLocalSource(path, path, clampField(content, 1_000));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}
}

/**
 * One bounded alternate query, used only to reach the two-source contract when a
 * first answer was thin. Never a loop: one extra shape, once.
 */
function alternateQuery(goal: string): string {
	return `${goal} official documentation reference`;
}

/**
 * Runs the research gate for a planning node and writes `research.md` and
 * `research.json`.
 *
 * The outcomes are distinct on purpose, per NH-02:
 * - a configured service answers with two distinct origins -> online success;
 * - a healthy service answers with fewer -> `NEEDS_HUMAN`, never a downgrade;
 * - every configured service fails its bounded attempts -> effective no-network
 *   with local sources only.
 */
export async function conductResearch(
	projectRoot: string,
	runDirectory: string,
	task: Task,
	dependencies: ResearchDependencies = {},
): Promise<ResearchDocument> {
	const session = new ResearchSession({
		jobId: task.job_id,
		mode: dependencies.mode ?? "auto",
		keys: dependencies.keys ?? {},
		eventsPath: dependencies.eventsPath,
		now: dependencies.now,
		round: dependencies.round,
		node: dependencies.node,
		operatorNoNetwork: dependencies.operatorNoNetwork,
		maxExternalCalls: dependencies.maxExternalCalls,
	});
	await session.started();

	let servedBy: "exa" | "perplexity" | undefined;
	let answered: "exa" | "perplexity" | undefined;
	// Each configured service gets its bounded attempts, in mode order. The
	// alternate service is tried once, exactly as AC-28.5 requires.
	for (const service of session.configuredServices) {
		if (session.callsRemaining === 0) {
			break;
		}
		const queries = [task.goal, alternateQuery(task.goal)];
		for (const [index, query] of queries.entries()) {
			const endpoints = dependencies.endpoints ?? DEFAULT_RESEARCH_ENDPOINTS;
			const outcome = await session.call(service, query, async (key) =>
				service === "exa"
					? exaSearch(query, key, {
							numResults: MAX_RESULTS_PER_REQUEST,
							baseUrl: endpoints.exa,
							timeoutMs: dependencies.timeoutMs,
							fetch: dependencies.fetch,
							signal: dependencies.signal,
						})
					: perplexitySearch(query, key, {
							maxResults: MAX_RESULTS_PER_REQUEST,
							baseUrl: endpoints.perplexity,
							timeoutMs: dependencies.timeoutMs,
							fetch: dependencies.fetch,
							signal: dependencies.signal,
						}),
			);
			if (!outcome.ok) {
				break;
			}
			answered = service;
			const origins = await session.addExternalResults(service, outcome.value);
			if (origins >= REQUIRED_EXTERNAL_SOURCES) {
				servedBy = service;
				break;
			}
			// One bounded follow-up only, and only because the contract is unmet.
			if (index === queries.length - 1) {
				break;
			}
		}
		if (servedBy !== undefined) {
			break;
		}
	}

	if (servedBy === undefined && answered !== undefined) {
		// A healthy service that answered thinly is a shortfall, never a downgrade
		// to local research and never a fabricated citation.
		await session.completed(session.mode);
		throw new ResearchShortfallError(answered, session.distinctOrigins);
	}

	let mode: ResearchMode = "local";
	if (servedBy !== undefined) {
		mode = servedBy;
	} else {
		// Nobody answered. If services were configured, this is exhaustion; if none
		// were, the job was local from the start.
		if (session.configuredServices.length > 0) {
			await session.exhaust();
		}
		session.clearExternalSources();
		await collectLocalSources(projectRoot, runDirectory, session);
	}

	const document: ResearchDocument = {
		job_id: task.job_id,
		task_hash: taskHash(task),
		mode,
		network: session.network,
		sources: session.collected,
	};
	await session.completed(mode);
	await writeResearchArtifacts(runDirectory, document);
	return document;
}

export async function writeResearchArtifacts(runDirectory: string, document: ResearchDocument): Promise<void> {
	await atomicWrite(join(runDirectory, "research.json"), `${JSON.stringify(document, null, 2)}\n`);
	const lines = [
		`# Research (${document.mode})`,
		"",
		`- network: ${document.network.state}${
			document.network.origin === undefined ? "" : ` (${document.network.origin})`
		}`,
		...(document.network.reason === undefined ? [] : [`- reason: ${document.network.reason}`]),
		"",
		"## Sources",
		"",
		...document.sources.map((source) =>
			source.kind === "external"
				? `- [${source.title}](${source.ref})${
						source.excerpt === undefined ? "" : ` — ${source.excerpt.replaceAll("\n", " ")}`
					}`
				: `- \`${source.ref}\`${source.excerpt === undefined ? "" : ` — ${source.excerpt.replaceAll("\n", " ")}`}`,
		),
		...(document.network.failures.length === 0
			? []
			: [
					"",
					"## Recorded failures",
					"",
					...document.network.failures.map((failure) => `- ${failure.service}: ${failure.class} at ${failure.at}`),
				]),
	];
	await atomicWrite(join(runDirectory, "research.md"), `${lines.join("\n")}\n`);
}

export async function assertResearchFresh(runDirectory: string, task: Task): Promise<void> {
	const document: unknown = JSON.parse(await readFile(join(runDirectory, "research.json"), "utf8"));
	if (!isJsonObject(document) || document.task_hash !== taskHash(task)) {
		throw new Error("research artifacts are missing or stale for task.json");
	}
	await readFile(join(runDirectory, "research.md"), "utf8");
}
