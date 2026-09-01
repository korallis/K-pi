import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "../../../config.ts";
import { appendEvent, type ResearchEventType, type ResearchPayload } from "../append-log.ts";
import { isJsonObject } from "../graph/schema.ts";
import type { ResearchMode } from "../settings.ts";

/** Services that can answer an external research call. */
export const RESEARCH_SERVICES = ["exa", "perplexity"] as const;

export type ResearchService = (typeof RESEARCH_SERVICES)[number];

/** `research.md` §Caps. Every one of these is a hard bound, not a hint. */
export const MAX_EXTERNAL_CALLS_PER_JOB = 20;
export const MAX_RESULTS_PER_REQUEST = 10;
export const MAX_CONTENTS_URLS = 10;
export const MAX_FIELD_CHARACTERS = 10_000;
/** Attempts per service before it counts as failed for this job. */
export const MAX_ATTEMPTS_PER_SERVICE = 1;

export type ResearchFailureClass = "http_402" | "http_429" | "http_5xx" | "timeout" | "abort" | "unavailable";

export interface ResearchFailure {
	service: ResearchService;
	class: ResearchFailureClass;
	at: string;
}

export type ResearchNetworkState = "online" | "no-network";

export interface ResearchNetwork {
	state: ResearchNetworkState;
	origin?: "operator" | "engine";
	reason?: string;
	failures: ResearchFailure[];
}

export interface ResearchKeys {
	exa?: string;
	perplexity?: string;
}

/**
 * A saved key wins over the environment.
 *
 * The operator wrote the saved one deliberately through setup or
 * `/accounts login`; an environment variable is a fallback for a machine that
 * has one lying around, and must never quietly outrank a stored credential.
 */
export async function resolveResearchKeys(
	agentDirectory: string = getAgentDir(),
	environment: NodeJS.ProcessEnv = process.env,
): Promise<ResearchKeys> {
	const saved = await readSavedResearchKeys(agentDirectory);
	const fromEnvironment = (value: string | undefined): string | undefined => {
		const trimmed = value?.trim();
		return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
	};
	return {
		exa: saved.exa ?? fromEnvironment(environment.EXA_API_KEY),
		perplexity: saved.perplexity ?? fromEnvironment(environment.PERPLEXITY_API_KEY),
	};
}

export function researchSecretName(service: ResearchService): string {
	return `${service}/default`;
}

async function readSavedResearchKeys(agentDirectory: string): Promise<ResearchKeys> {
	let payload: unknown;
	try {
		payload = JSON.parse(await readFile(join(agentDirectory, "accounts.secrets.json"), "utf8"));
	} catch {
		return {};
	}
	if (!isJsonObject(payload)) {
		return {};
	}
	const keyFor = (service: ResearchService): string | undefined => {
		const credential = payload[researchSecretName(service)];
		if (!isJsonObject(credential) || credential.type !== "api_key") {
			return undefined;
		}
		return typeof credential.key === "string" && credential.key.length > 0 ? credential.key : undefined;
	};
	return { exa: keyFor("exa"), perplexity: keyFor("perplexity") };
}

/** Raised when a call would cross this job's external-call budget. */
export class ResearchBudgetError extends Error {
	constructor(limit: number) {
		super(`Research call budget of ${limit} external calls for this job is spent`);
		this.name = "ResearchBudgetError";
	}
}

/** Raised when a service answered but the job still lacks two distinct sources. */
export class ResearchShortfallError extends Error {
	readonly service: ResearchService;
	readonly origins: string[];
	constructor(service: ResearchService, origins: readonly string[]) {
		super(
			`${service} answered but supplied ${origins.length} distinct external source${
				origins.length === 1 ? "" : "s"
			}; two are required`,
		);
		this.name = "ResearchShortfallError";
		this.service = service;
		this.origins = [...origins];
	}
}

export interface ResearchSource {
	kind: "external" | "local";
	ref: string;
	title: string;
	service: ResearchService | null;
	observed_at: string;
	excerpt?: string;
}

export type ResearchEmitter = (type: ResearchEventType, payload: ResearchPayload) => Promise<void>;

export interface ResearchSessionOptions {
	jobId: string;
	mode: ResearchMode;
	keys: ResearchKeys;
	/** Where redacted research events are appended. Omit with `emit` in tests. */
	eventsPath?: string;
	emit?: ResearchEmitter;
	now?: () => Date;
	round?: number;
	node?: string;
	/** An operator-flagged offline job. */
	operatorNoNetwork?: boolean;
	/** Raised only by an operator; the default is the normative cap. */
	maxExternalCalls?: number;
}

/**
 * The one owner of a job's research: which key is used, which mode applies, what
 * the network state is and why, how many external calls are left, which services
 * are cooling, which sources have been collected, and which events were emitted.
 *
 * Nothing else resolves a key, counts a call, or decides that a service is done.
 */
export class ResearchSession {
	readonly mode: ResearchMode;
	private readonly jobId: string;
	private readonly keys: ResearchKeys;
	private readonly eventsPath?: string;
	private readonly emitter?: ResearchEmitter;
	private readonly now: () => Date;
	private readonly round: number;
	private readonly node: string;
	private readonly maxCalls: number;
	private readonly attempts = new Map<ResearchService, number>();
	private readonly cooling = new Set<ResearchService>();
	private readonly failures: ResearchFailure[] = [];
	private readonly sources: ResearchSource[] = [];
	private readonly origins = new Set<string>();
	private externalCalls = 0;
	private networkState: ResearchNetworkState;
	private networkOrigin?: "operator" | "engine";
	private networkReason?: string;

	constructor(options: ResearchSessionOptions) {
		this.jobId = options.jobId;
		this.mode = options.mode;
		this.keys = options.keys;
		this.eventsPath = options.eventsPath;
		this.emitter = options.emit;
		this.now = options.now ?? (() => new Date());
		this.round = options.round ?? 0;
		this.node = options.node ?? "research";
		this.maxCalls = Math.max(0, options.maxExternalCalls ?? MAX_EXTERNAL_CALLS_PER_JOB);
		// An operator-flagged offline job is offline from the start, and its origin
		// is the operator - never the engine, which may only conclude exhaustion.
		this.networkState = options.operatorNoNetwork === true ? "no-network" : "online";
		this.networkOrigin = options.operatorNoNetwork === true ? "operator" : undefined;
		this.networkReason = options.operatorNoNetwork === true ? "operator requested no-network" : undefined;
	}

	get network(): ResearchNetwork {
		return {
			state: this.networkState,
			...(this.networkOrigin === undefined ? {} : { origin: this.networkOrigin }),
			...(this.networkReason === undefined ? {} : { reason: this.networkReason }),
			failures: this.failures.map((failure) => ({ ...failure })),
		};
	}

	get callsSpent(): number {
		return this.externalCalls;
	}

	get callsRemaining(): number {
		return Math.max(0, this.maxCalls - this.externalCalls);
	}

	get collected(): ResearchSource[] {
		return this.sources.map((source) => ({ ...source }));
	}

	get distinctOrigins(): string[] {
		return [...this.origins];
	}

	/** A key for this service, resolved once for the whole job. */
	keyFor(service: ResearchService): string | undefined {
		return this.keys[service];
	}

	isCooling(service: ResearchService): boolean {
		return this.cooling.has(service);
	}

	/**
	 * Services this job may ask, in the order the mode implies. A named service
	 * without a key falls back through `auto`; `local` asks nobody.
	 */
	get configuredServices(): ResearchService[] {
		if (this.mode === "local" || this.networkState === "no-network") {
			return [];
		}
		const keyed = RESEARCH_SERVICES.filter((service) => this.keyFor(service) !== undefined);
		if (this.mode === "exa" || this.mode === "perplexity") {
			const named = keyed.filter((service) => service === this.mode);
			// A selected service without a key falls back through `auto`.
			return named.length > 0 ? named : keyed;
		}
		return keyed;
	}

	/** The services still worth asking: configured, keyed, not cooling, attempts left. */
	get availableServices(): ResearchService[] {
		return this.configuredServices.filter(
			(service) => !this.isCooling(service) && (this.attempts.get(service) ?? 0) < MAX_ATTEMPTS_PER_SERVICE,
		);
	}

	private timestamp(): string {
		return this.now().toISOString();
	}

	/**
	 * Emits one redacted research event. Only normalized fields travel: a query,
	 * a service name, counts, and canonical source refs. No key, header, envelope,
	 * or provider text ever reaches an event.
	 */
	async emit(type: ResearchEventType, payload: ResearchPayload = {}): Promise<void> {
		const redacted: ResearchPayload = {
			...payload,
			...(payload.query === undefined ? {} : { query: clampField(payload.query) }),
			...(payload.reason === undefined ? {} : { reason: clampField(payload.reason) }),
			...(payload.source_refs === undefined ? {} : { source_refs: payload.source_refs.map(clampField) }),
		};
		if (this.emitter !== undefined) {
			await this.emitter(type, redacted);
			return;
		}
		if (this.eventsPath === undefined) {
			return;
		}
		await appendEvent(this.eventsPath, {
			ts: this.timestamp(),
			type,
			job_id: this.jobId,
			round: this.round,
			node: this.node,
			...redacted,
		});
	}

	async started(): Promise<void> {
		await this.emit("research.started", {
			mode: this.mode,
			network_state: this.networkState,
			...(this.networkReason === undefined ? {} : { reason: this.networkReason }),
		});
	}

	async completed(mode: ResearchMode | "local"): Promise<void> {
		await this.emit("research.completed", {
			mode,
			network_state: this.networkState,
			result_count: this.sources.length,
			source_refs: this.sources.map((source) => source.ref),
			...(this.networkReason === undefined ? {} : { reason: this.networkReason }),
		});
	}

	/**
	 * Spends one external call. The budget is checked before the request is built,
	 * so the call that would cross it never reaches the network.
	 */
	private spend(): void {
		if (this.externalCalls >= this.maxCalls) {
			throw new ResearchBudgetError(this.maxCalls);
		}
		this.externalCalls += 1;
	}

	/**
	 * Runs one external call through the control plane: budget, attempt count,
	 * events, and failure classification in one place.
	 *
	 * `run` receives the resolved key. A thrown failure cools the service and is
	 * recorded; it never propagates as a crash, because a failing research service
	 * is a bounded outcome rather than a broken run.
	 */
	async call<T>(
		service: ResearchService,
		query: string,
		run: (key: string) => Promise<T>,
	): Promise<{ ok: true; value: T } | { ok: false; class: ResearchFailureClass }> {
		const key = this.keyFor(service);
		if (key === undefined) {
			await this.recordFailure(service, "unavailable");
			return { ok: false, class: "unavailable" };
		}
		if (this.networkState === "no-network") {
			await this.recordFailure(service, "unavailable");
			return { ok: false, class: "unavailable" };
		}
		this.spend();
		const attempt = (this.attempts.get(service) ?? 0) + 1;
		this.attempts.set(service, attempt);
		await this.emit("research.query", { service, query, attempt });
		try {
			const value = await run(key);
			await this.emit("research.call", { service, attempt, query });
			return { ok: true, value };
		} catch (error) {
			const failure = classifyResearchFailure(error);
			await this.recordFailure(service, failure);
			return { ok: false, class: failure };
		}
	}

	/** Records a bounded failure and cools that service for this job. */
	private async recordFailure(service: ResearchService, failureClass: ResearchFailureClass): Promise<void> {
		this.cooling.add(service);
		this.failures.push({ service, class: failureClass, at: this.timestamp() });
		await this.emit("research.fallback", {
			service,
			from: service,
			reason: failureClass,
			attempt: this.attempts.get(service) ?? 1,
		});
	}

	/**
	 * Adds normalized results as sources, deduplicated by canonical URL, and
	 * reports how many distinct origins the job now holds.
	 *
	 * Two paths on one host are one source: the two-source contract is about
	 * independent origins, so counting them here is the only place that decides.
	 */
	async addExternalResults(
		service: ResearchService,
		results: readonly { title: string; url: string; text?: string; publishedDate?: string }[],
	): Promise<number> {
		const observedAt = this.timestamp();
		const accepted: string[] = [];
		for (const result of results.slice(0, MAX_RESULTS_PER_REQUEST)) {
			const canonical = canonicalizeUrl(result.url);
			if (canonical === undefined) {
				continue;
			}
			if (this.sources.some((source) => source.ref === canonical)) {
				continue;
			}
			this.sources.push({
				kind: "external",
				ref: canonical,
				title: clampField(result.title.length > 0 ? result.title : canonical),
				service,
				observed_at: observedAt,
				...(result.text === undefined ? {} : { excerpt: clampField(result.text) }),
			});
			this.origins.add(originOf(canonical) ?? canonical);
			accepted.push(canonical);
		}
		await this.emit("research.result", {
			service,
			result_count: accepted.length,
			source_refs: accepted,
		});
		return this.origins.size;
	}

	/** Adds a repository source. Local research cites paths, never invented URLs. */
	addLocalSource(ref: string, title: string, excerpt?: string): void {
		if (this.sources.some((source) => source.ref === ref)) {
			return;
		}
		this.sources.push({
			kind: "local",
			ref,
			title: clampField(title),
			service: null,
			observed_at: this.timestamp(),
			...(excerpt === undefined ? {} : { excerpt: clampField(excerpt) }),
		});
	}

	/**
	 * Every configured service has failed its bounded attempts, so the engine -
	 * not the operator - concludes no-network. Only reachable through exhaustion:
	 * a shortfall from a healthy service must never land here.
	 */
	async exhaust(): Promise<void> {
		if (this.networkState === "no-network") {
			return;
		}
		const exhausted = [...new Set(this.failures.map((failure) => failure.service))];
		this.networkState = "no-network";
		this.networkOrigin = "engine";
		this.networkReason = `${exhausted.join(" and ")} each failed their bounded attempts`;
		await this.emit("research.fallback", {
			service: "local",
			from: exhausted.join("+"),
			to: "local",
			reason: this.networkReason,
			network_state: this.networkState,
		});
	}

	/** Drops external sources collected before an exhaustion downgrade. */
	clearExternalSources(): void {
		for (let index = this.sources.length - 1; index >= 0; index -= 1) {
			if (this.sources[index].kind === "external") {
				this.sources.splice(index, 1);
			}
		}
		this.origins.clear();
	}
}

/**
 * Classifies a research failure on HTTP status and transport, never on the
 * error envelope: providers disagree about envelope shape, especially on 429.
 */
export function classifyResearchFailure(error: unknown): ResearchFailureClass {
	const status = statusOf(error);
	if (status === 402) {
		// Defensive on our side, not a documented Perplexity Search response.
		return "http_402";
	}
	if (status === 429) {
		return "http_429";
	}
	if (status !== undefined && status >= 500) {
		return "http_5xx";
	}
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	if (name === "TimeoutError" || /timed? ?out/iu.test(message)) {
		return "timeout";
	}
	if (name === "AbortError" || /\babort(?:ed)?\b/iu.test(message)) {
		return "abort";
	}
	return "unavailable";
}

function statusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	if ("status" in error && typeof error.status === "number") {
		return error.status;
	}
	return undefined;
}

/** Clamps any field that could carry provider text to the normative cap. */
export function clampField(value: string, limit = MAX_FIELD_CHARACTERS): string {
	return value.length <= limit ? value : value.slice(0, limit);
}

/**
 * The comparable form of an external source: an absolute HTTP(S) URL without a
 * fragment, default port, or trailing-slash noise. Anything else is not a URL
 * this job can cite.
 */
export function canonicalizeUrl(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return undefined;
	}
	url.hash = "";
	url.username = "";
	url.password = "";
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		url.pathname = url.pathname.replace(/\/+$/u, "");
	}
	url.hostname = url.hostname.toLowerCase();
	return clampField(url.toString());
}

/** The origin two sources must differ in to count as two. */
export function originOf(value: string): string | undefined {
	try {
		return new URL(value).origin.toLowerCase();
	} catch {
		return undefined;
	}
}
