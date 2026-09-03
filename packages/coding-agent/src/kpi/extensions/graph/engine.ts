import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import { CONFIG_DIR_NAME, getAgentDir, getKpiResourceDir } from "../../../config.ts";
import type { ExtensionUIContext, InlineExtension } from "../../../core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { AccountsStore } from "../accounts/store.ts";
import { appendEvent, buildReviewVerdictEventFields, type NodeLifecycleEvent } from "../append-log.ts";
import { ROLE_CONTRACT_FILE } from "../bus/roles.ts";
import { registerLiveBus, registerLiveNodeSession } from "../bus/sessions-snapshot.ts";
import { BackgroundBus, type BusDependencies } from "../bus/spawn.ts";
import { type LocalProviderId, registerLocalProviders } from "../local/providers.ts";
import { registerPolicy } from "../policy.ts";
import { atomicWrite, LOOP_RECOVERIES, readLiveJob, type Task, writeAllowForTask } from "../run-store.ts";
import { assertDuneStack, DuneStackError } from "../stack.ts";
import { batchReadyNodes, isBudgetState } from "./budget.ts";
import { type JsonSchema, validateJsonSchema } from "./json-schema.ts";
import {
	type AgentGraphNode,
	type AgentWorkerRole,
	type GraphDefinition,
	type GraphEdge,
	type GraphNode,
	type GraphPauseState,
	type GraphRunState,
	type HumanAnswer,
	isJsonObject,
	type JsonObject,
	type JsonValue,
	type PauseGraphNode,
} from "./schema.ts";
import {
	classifyTransientFailure,
	DEFAULT_RETRY_BASE_MS,
	retryDelayMs,
	type Sleeper,
	type TransientReason,
} from "./stop.ts";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);
const END_NODE_ID = "__end__";

export interface GraphAgentSession {
	readonly sessionId: string;
	prompt(text: string): Promise<void>;
	/** Interrupts the prompt in flight. The core AgentSession has it; test fakes may omit it. */
	abort?(): Promise<void> | void;
	getLastAssistantText?(): string | undefined;
	getLastAssistantError?(): string | undefined;
	/**
	 * Session-billed USD so far (provider usage × model.cost). The run's cost
	 * accumulates deltas after each node; optional so test fakes stay thin.
	 */
	getSessionStats?(): { cost: number; toolCalls?: number };
	getActiveToolNames(): string[];
	dispose(): void;
}

export type GraphAgentSessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: GraphAgentSession }>;

/** What the driver is told before every backoff wait. */
export interface NodeRetry {
	nodeId: string;
	/** 1 for the first retry of this run of the node. */
	attempt: number;
	reason: TransientReason;
	/** The HTTP status when the provider answered with one. */
	status?: number;
	delayMs: number;
	message: string;
}

export interface GraphEngineOptions {
	projectRoot: string;
	jobId: string;
	createAgentSession?: GraphAgentSessionFactory;
	/**
	 * RP-13 bus injections for nodes that declare `workerRole`. Tests supply a
	 * fake launcher; production uses the default process launcher.
	 */
	busDependencies?: BusDependencies;
	/** Test/DI wall clock. Production uses Date.now. */
	now?: () => number;
	/**
	 * Test/DI additive cost meter. When omitted, spend is checkpoint baseline +
	 * session usage×rates. Never invent spend; clamp external readings at 0.
	 */
	accumulatedCostUsd?: () => number;
	/**
	 * Facts only the caller can establish, merged into run state before routing.
	 * Keys are state paths, so `{ "bounds.held": false }` is what an edge tests.
	 */
	resolveFacts?: () => Promise<JsonObject>;
	/**
	 * Sink for the one product terminal event a paused run produces. Defaults to
	 * appending `loop.terminal` NEEDS_HUMAN with the pause's reason and recovery.
	 */
	emitTerminal?: (pause: GraphPauseState) => Promise<void>;
	/** Injected backoff. Tests record the delays instead of waiting them out. */
	sleep?: Sleeper;
	/** First backoff step; each further retry doubles it up to the ceiling. */
	retryBaseDelayMs?: number;
	/** Told before every backoff wait, after the checkpoint that records it. */
	onRetry?: (retry: NodeRetry) => Promise<void>;
	/** Asked after every backoff wait; true unwinds the run as OperatorStopError. */
	stopRequested?: () => Promise<boolean>;
	/** The operator's immediate stop: aborts every in-flight session and wait at once. */
	signal?: AbortSignal;
	/** Host UI so nested agent policy confirms reach the operator. */
	uiContext?: ExtensionUIContext;
	/** Parent-session routing inherited by every graph and worker node. */
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	/** Fired (fire-and-forget) whenever a live node/worker session registers or releases. */
	onSessionsChange?: () => void | Promise<void>;
}

/** The production backoff: a timer the operator's stop clears at once. */
function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(done, milliseconds);
	function done(): void {
		clearTimeout(timer);
		signal?.removeEventListener("abort", done);
		resolve();
	}
	signal?.addEventListener("abort", done, { once: true });
	return promise;
}

/** The HTTP status a failure carries, on the error or one level down. */
function httpStatus(error: unknown): number | undefined {
	for (const candidate of [
		error,
		typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined,
	]) {
		if (typeof candidate !== "object" || candidate === null) {
			continue;
		}
		if ("status" in candidate && typeof candidate.status === "number") {
			return candidate.status;
		}
		if ("statusCode" in candidate && typeof candidate.statusCode === "number") {
			return candidate.statusCode;
		}
	}
	return undefined;
}

/**
 * A defect in a node's own output or configuration: a response that will not
 * validate, a read-only node that registered a mutating tool. Retrying only
 * repeats it, so it is never transient.
 */
export class GraphNodeContractError extends Error {
	readonly nodeId: string;

	constructor(nodeId: string, message: string) {
		super(message);
		this.name = "GraphNodeContractError";
		this.nodeId = nodeId;
	}
}

/** A provider refusal recorded by the assistant message rather than thrown by prompt(). */
export class GraphNodeProviderError extends Error {
	readonly nodeId: string;
	readonly status?: number;

	constructor(nodeId: string, reason: string) {
		super(`agent node ${nodeId} provider failed: ${reason}`);
		this.name = "GraphNodeProviderError";
		this.nodeId = nodeId;
		const status = /^(\d{3})\b/u.exec(reason.trim());
		if (status !== null) this.status = Number(status[1]);
	}
}

/**
 * The operator stopped the run. Thrown out of the engine untouched, with a
 * checkpoint already written that leaves the stopped node `running` so a
 * restore continues it; the driver records STOPPED.
 */
export class OperatorStopError extends Error {
	constructor() {
		super("operator stop");
		this.name = "OperatorStopError";
	}
}

interface NodeResult {
	nodeId: string;
	assignments: Record<string, JsonValue>;
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${label} must be a string array`);
	}
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
}

function assertStatePath(path: string, label: string): void {
	const parts = path.split(".");
	if (parts.some((part) => part.length === 0 || FORBIDDEN_PATH_PARTS.has(part))) {
		throw new Error(`${label} contains an invalid state path: ${path}`);
	}
}

function validateNode(value: unknown, index: number): asserts value is GraphNode {
	if (!isJsonObject(value)) {
		throw new Error(`nodes[${index}] must be an object`);
	}
	assertString(value.id, `nodes[${index}].id`);
	assertString(value.type, `nodes[${index}].type`);

	if (value.type === "set") {
		if (!isJsonObject(value.assignments)) {
			throw new Error(`set node ${value.id} must define assignments`);
		}
		for (const path of Object.keys(value.assignments)) {
			assertStatePath(path, `set node ${value.id}`);
		}
		return;
	}

	if (value.type === "pause") {
		if (!(LOOP_RECOVERIES as readonly unknown[]).includes(value.recovery)) {
			throw new Error(`pause node ${value.id}.recovery must be one of ${LOOP_RECOVERIES.join(" | ")}`);
		}
		assertString(value.reason, `pause node ${value.id}.reason`);
		assertStringArray(value.resume, `pause node ${value.id}.resume`);
		if (value.resume.length === 0) {
			throw new Error(`pause node ${value.id}.resume must name at least one node`);
		}
		return;
	}

	if (value.type === "human") {
		assertString(value.title, `human node ${value.id}.title`);
		assertString(value.question, `human node ${value.id}.question`);
		assertString(value.statePath, `human node ${value.id}.statePath`);
		assertStatePath(value.statePath, `human node ${value.id}`);
		if (value.detail !== undefined && value.detail !== "stack.json") {
			throw new Error(`human node ${value.id}.detail must be stack.json, the only run file with a summary renderer`);
		}
		if (value.feedbackPath !== undefined) {
			assertString(value.feedbackPath, `human node ${value.id}.feedbackPath`);
			assertStatePath(value.feedbackPath, `human node ${value.id}`);
		}
		return;
	}

	if (value.type !== "agent") {
		throw new Error(`node ${value.id} has unsupported type ${value.type}`);
	}
	assertString(value.prompt, `agent node ${value.id}.prompt`);
	assertBoolean(value.readOnly, `agent node ${value.id}.readOnly`);
	assertStringArray(value.tools, `agent node ${value.id}.tools`);
	if (!isJsonObject(value.context)) {
		throw new Error(`agent node ${value.id} must define context`);
	}
	if (value.context.mode !== "isolated" && value.context.mode !== "thread") {
		throw new Error(`agent node ${value.id} has invalid context mode`);
	}
	if (
		value.context.threadKey !== undefined &&
		(typeof value.context.threadKey !== "string" || value.context.threadKey.length === 0)
	) {
		throw new Error(`agent node ${value.id}.context.threadKey must be non-empty`);
	}
	if (value.feedbackPath !== undefined) {
		assertString(value.feedbackPath, `agent node ${value.id}.feedbackPath`);
		assertStatePath(value.feedbackPath, `agent node ${value.id}`);
	}
	if (value.readOnly) {
		const mutatingTool = value.tools.find((tool) => !READ_ONLY_TOOLS.has(tool));
		if (mutatingTool !== undefined) {
			throw new Error(`read-only agent node ${value.id} cannot enable tool ${mutatingTool}`);
		}
	}
	if (value.workerRole !== undefined) {
		if (value.workerRole !== "reviewer") {
			throw new Error(
				`agent node ${value.id}.workerRole must be a known contract-publishing role (got ${String(value.workerRole)})`,
			);
		}
		const contract = ROLE_CONTRACT_FILE[value.workerRole as AgentWorkerRole];
		if (contract === undefined) {
			throw new Error(`agent node ${value.id}.workerRole ${value.workerRole} has no contract file`);
		}
		if (value.response === undefined) {
			throw new Error(`agent node ${value.id} with workerRole requires a response contract`);
		}
		if (!isJsonObject(value.response)) {
			throw new Error(`agent node ${value.id}.response must be an object`);
		}
		if (value.response.path !== contract.file) {
			throw new Error(
				`agent node ${value.id}.response.path must be ${contract.file} for workerRole ${value.workerRole}`,
			);
		}
		if (value.response.schema !== contract.schema) {
			throw new Error(
				`agent node ${value.id}.response.schema must be ${contract.schema} for workerRole ${value.workerRole}`,
			);
		}
	}
	if (value.response !== undefined) {
		if (!isJsonObject(value.response)) {
			throw new Error(`agent node ${value.id}.response must be an object`);
		}
		assertString(value.response.path, `agent node ${value.id}.response.path`);
		if (isAbsolute(value.response.path) || value.response.path.split(/[\\/]/u).some((part) => part === "..")) {
			throw new Error(`agent node ${value.id}.response.path must stay in the run directory`);
		}
		assertString(value.response.schema, `agent node ${value.id}.response.schema`);
		if (basename(value.response.schema) !== value.response.schema) {
			throw new Error(`agent node ${value.id}.response.schema must be a file name`);
		}
		if (
			typeof value.response.retries !== "number" ||
			!Number.isInteger(value.response.retries) ||
			value.response.retries < 0
		) {
			throw new Error(`agent node ${value.id}.response.retries must be a non-negative integer`);
		}
		if (!isJsonObject(value.response.state)) {
			throw new Error(`agent node ${value.id}.response.state must be an object`);
		}
		for (const [statePath, responsePath] of Object.entries(value.response.state)) {
			assertStatePath(statePath, `agent node ${value.id}.response.state`);
			assertString(responsePath, `agent node ${value.id}.response.state.${statePath}`);
			assertStatePath(responsePath, `agent node ${value.id}.response.state`);
		}
	}
}

/**
 * A graph carries exactly one limit. One still declaring a cap is refused
 * rather than silently uncapped: K-π runs have no caps, and the file must say so.
 */
function validateLimits(value: unknown): void {
	if (!isJsonObject(value)) {
		throw new Error("graph limits must be an object");
	}
	const concurrency = value.maxConcurrency;
	if (typeof concurrency !== "number" || !Number.isFinite(concurrency) || concurrency <= 0) {
		throw new Error("graph limits.maxConcurrency must be a positive number");
	}
	const retired = Object.keys(value).find((key) => key !== "maxConcurrency");
	if (retired !== undefined) {
		throw new Error(
			`graph limits.${retired} was retired: K-π runs have no caps, a graph carries only maxConcurrency`,
		);
	}
}

function validatePolicy(value: unknown): void {
	if (!isJsonObject(value)) {
		throw new Error("graph policy must be an object");
	}
	for (const key of [
		"allowNonInteractive",
		"allowNonInteractiveMutations",
		"confirmProjectGraph",
		"confirmMutatingNodes",
	]) {
		assertBoolean(value[key], `graph policy.${key}`);
	}
	if (value.onHumanDeny !== undefined && value.onHumanDeny !== "revise" && value.onHumanDeny !== "end") {
		throw new Error("graph policy.onHumanDeny must be revise | end");
	}
}

export function validateGraphDefinition(value: unknown): asserts value is GraphDefinition {
	if (!isJsonObject(value)) {
		throw new Error("graph must be an object");
	}
	if (value.schemaVersion !== 2) {
		throw new Error("graph schemaVersion must be 2");
	}
	assertString(value.id, "graph id");
	assertString(value.entry, "graph entry");
	if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
		throw new Error("graph nodes must be a non-empty array");
	}
	const nodes: GraphNode[] = [];
	for (const [index, node] of value.nodes.entries()) {
		validateNode(node, index);
		nodes.push(node);
	}

	const nodeIds = new Set<string>();
	for (const node of nodes) {
		if (nodeIds.has(node.id)) {
			throw new Error(`duplicate graph node id: ${node.id}`);
		}
		nodeIds.add(node.id);
	}
	if (!nodeIds.has(value.entry)) {
		throw new Error(`graph entry does not exist: ${value.entry}`);
	}

	if (!Array.isArray(value.edges)) {
		throw new Error("graph edges must be an array");
	}
	for (const [index, edge] of value.edges.entries()) {
		if (!isJsonObject(edge)) {
			throw new Error(`edges[${index}] must be an object`);
		}
		assertString(edge.from, `edges[${index}].from`);
		assertString(edge.to, `edges[${index}].to`);
		if (!nodeIds.has(edge.from)) {
			throw new Error(`edge source does not exist: ${edge.from}`);
		}
		if (edge.to !== END_NODE_ID && !nodeIds.has(edge.to)) {
			throw new Error(`edge target does not exist: ${edge.to}`);
		}
		if (edge.when !== undefined) {
			const conditions = Array.isArray(edge.when) ? edge.when : [edge.when];
			if (conditions.length === 0) {
				throw new Error(`edges[${index}].when must not be empty`);
			}
			for (const condition of conditions) {
				if (!isJsonObject(condition)) {
					throw new Error(`edges[${index}].when must be a condition or a list of conditions`);
				}
				assertString(condition.path, `edges[${index}].when.path`);
				assertStatePath(condition.path, `edges[${index}].when`);
				if (!("equals" in condition)) {
					throw new Error(`edges[${index}].when must define equals`);
				}
			}
		}
	}

	// A pause is a sink: an edge leaving one would claim the run continues after
	// it parked, and a resume that lands on another pause would never run.
	for (const node of nodes) {
		if (node.type !== "pause") {
			continue;
		}
		for (const target of node.resume) {
			const resumed = nodes.find((candidate) => candidate.id === target);
			if (resumed === undefined) {
				throw new Error(`pause node ${node.id} resumes at ${target}, which does not exist`);
			}
			if (resumed.type === "pause") {
				throw new Error(`pause node ${node.id} cannot resume at pause node ${target}`);
			}
		}
		if (value.edges.some((edge) => isJsonObject(edge) && edge.from === node.id)) {
			throw new Error(`pause node ${node.id} cannot have outgoing edges`);
		}
	}

	validateLimits(value.limits);
	validatePolicy(value.policy);

	// A non-interactive graph that contains a human node would either stall or
	// have to be answered by the harness on the operator's behalf. Refused here,
	// before a job starts, rather than discovered at the node.
	if (isJsonObject(value.policy) && value.policy.allowNonInteractive === true) {
		const humanNode = nodes.find((node) => node.type === "human");
		if (humanNode !== undefined) {
			throw new Error(`non-interactive graph ${value.id} cannot contain human node ${humanNode.id}`);
		}
	}
}

export async function loadGraph(path: string | URL): Promise<GraphDefinition> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	validateGraphDefinition(value);
	return value;
}

export async function loadNamedGraph(projectRoot: string, name: string): Promise<GraphDefinition> {
	const fileName = basename(name.endsWith(".json") ? name : `${name}.json`);
	if (fileName !== name && `${fileName.slice(0, -5)}` !== name) {
		throw new Error(`Invalid graph name: ${name}`);
	}

	const projectPath = join(projectRoot, CONFIG_DIR_NAME, "graphs", fileName);
	try {
		return await loadGraph(projectPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	return loadGraph(join(getKpiResourceDir(), "graphs", fileName));
}

function getStatePath(values: JsonObject, path: string): JsonValue | undefined {
	let current: JsonValue = values;
	for (const part of path.split(".")) {
		if (!isJsonObject(current) || !(part in current)) {
			return undefined;
		}
		current = current[part] as JsonValue;
	}
	return current;
}

function setStatePath(values: JsonObject, path: string, value: JsonValue): void {
	const parts = path.split(".");
	let current: JsonObject = values;
	for (const part of parts.slice(0, -1)) {
		const next = current[part];
		if (!isJsonObject(next)) {
			current[part] = {};
		}
		current = current[part] as JsonObject;
	}
	current[parts.at(-1) as string] = structuredClone(value);
}

function safeThreadKey(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

async function loadResponseSchema(projectRoot: string, name: string): Promise<JsonSchema> {
	const projectPath = join(projectRoot, CONFIG_DIR_NAME, "schemas", name);
	try {
		return JSON.parse(await readFile(projectPath, "utf8")) as JsonSchema;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	return JSON.parse(await readFile(join(getKpiResourceDir(), "schemas", name), "utf8")) as JsonSchema;
}

/**
 * Graph agent sessions are not the operator CLI: they need local model catalogs
 * and policy, not control-plane widgets/status that bind a parent ExtensionRunner
 * context. Loading full k-pi here previously crashed the host with stale ctx.
 */
async function resolveActiveWriteAllow(cwd: string): Promise<string[]> {
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

function graphAgentExtensionFactories(): InlineExtension[] {
	return [
		{
			name: "k-pi-graph-agent",
			factory: (pi) => {
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
				registerPolicy(pi, { resolveWriteAllow: resolveActiveWriteAllow });
			},
		},
	];
}

export class GraphEngine {
	private readonly graph: GraphDefinition;
	private readonly options: GraphEngineOptions;
	private readonly nodes: Map<string, GraphNode>;
	private readonly sessionFactory: GraphAgentSessionFactory;
	private readonly uiContext?: ExtensionUIContext;
	private readonly threadSessions = new Map<string, GraphAgentSession>();
	private readonly now: () => number;
	private readonly accumulatedCostUsd: () => number;
	/**
	 * Durable spend already on the checkpoint (prior process). Restored runs
	 * keep it so the reported cost never forgets what was already billed.
	 */
	private readonly baselineCostUsd: number;
	/** USD billed by agent sessions in this process (provider usage × model.cost). */
	private sessionCostUsd = 0;
	/** Last getSessionStats().cost observed per live session (for deltas). */
	private readonly sessionCostBaseline = new WeakMap<object, number>();
	/** Cost summed across every attempt of a node's current run, reset at node.started. */
	private readonly nodeRunCostUsd = new Map<string, number>();
	/** Sessions inside prompt() right now; the operator's stop aborts each of them. */
	private readonly inFlight = new Set<GraphAgentSession>();
	private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	private readonly retryBaseDelayMs: number;
	private checkpointWrites: Promise<void> = Promise.resolve();
	private runState: GraphRunState;
	/**
	 * Limit keys the checkpoint carried that no longer mean anything, in
	 * checkpoint order: the caps a retired release enforced. Empty for a new
	 * run. The driver tells the operator they were ignored.
	 */
	readonly retiredLimits: string[];

	/**
	 * The operator's stop reaches every in-flight session at once. A session
	 * whose abort itself fails is logged, not thrown: the stop still lands
	 * when its prompt settles.
	 */
	private readonly onAbort = (): void => {
		for (const session of this.inFlight) {
			let aborting: Promise<void> | void;
			try {
				aborting = session.abort?.();
			} catch (error) {
				console.warn(`K-π graph: session abort failed: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (aborting instanceof Promise) {
				aborting.catch((error: unknown) => {
					console.warn(
						`K-π graph: session abort failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			}
		}
	};

	constructor(graph: GraphDefinition, options: GraphEngineOptions, initialState?: GraphRunState) {
		validateGraphDefinition(graph);
		this.graph = graph;
		this.options = options;
		this.uiContext = options.uiContext;
		this.nodes = new Map(graph.nodes.map((node) => [node.id, node]));
		this.sessionFactory = options.createAgentSession ?? createAgentSession;
		this.now = options.now ?? Date.now;
		this.sessionCostUsd = 0;
		// Checkpoint cost is durable product state. An injected meter is additive
		// test/DI only and must never cancel real spend (clamp at zero).
		const checkpointCost =
			initialState !== undefined &&
			typeof initialState.budget?.costUsd === "number" &&
			Number.isFinite(initialState.budget.costUsd)
				? Math.max(0, initialState.budget.costUsd)
				: 0;
		const externalMeter = options.accumulatedCostUsd;
		if (externalMeter !== undefined) {
			// Tests own the prior-spend story via the meter; do not also double-count
			// the checkpoint baseline they already encoded there.
			this.baselineCostUsd = 0;
			this.accumulatedCostUsd = () => Math.max(0, externalMeter()) + this.sessionCostUsd;
		} else {
			this.baselineCostUsd = checkpointCost;
			this.accumulatedCostUsd = () => this.baselineCostUsd + this.sessionCostUsd;
		}
		this.sleep = options.sleep ?? defaultSleep;
		this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;

		if (initialState === undefined) {
			this.retiredLimits = [];
			this.runState = {
				graphId: graph.id,
				jobId: options.jobId,
				status: "running",
				superstep: 0,
				active: [graph.entry],
				// The graph's own configuration, readable by its edges: a denied human
				// release routes by policy rather than by a decision baked into code.
				values: { policy: { onHumanDeny: graph.policy.onHumanDeny ?? "revise" } },
				nodes: Object.fromEntries(graph.nodes.map((node) => [node.id, { status: "pending" as const, runs: 0 }])),
				budget: {
					limits: { maxConcurrency: graph.limits.maxConcurrency },
					startedAtMs: this.now(),
					elapsedMs: 0,
					costUsd: 0,
					round: 0,
					batches: 0,
				},
			};
		} else {
			if (!isBudgetState(initialState.budget)) {
				throw new Error("checkpoint is missing budget counters");
			}
			this.runState = initialState;
			// Caps a checkpoint still carries are read, never enforced: the run they
			// stopped resumes, and the driver tells the operator which were ignored.
			this.retiredLimits = Object.keys(initialState.budget.limits).filter((key) => key !== "maxConcurrency");
			this.runState.budget.limits = { maxConcurrency: graph.limits.maxConcurrency };
			// A checkpoint written before this configuration existed still routes,
			// and one written before a node existed still schedules it.
			if (!isJsonObject(this.runState.values.policy)) {
				this.runState.values.policy = { onHumanDeny: graph.policy.onHumanDeny ?? "revise" };
			}
			for (const node of graph.nodes) {
				this.runState.nodes[node.id] ??= { status: "pending", runs: 0 };
			}
			// A paused run, or one a retired terminal ended (exhausted, failed,
			// terminated), is re-armed: only the operator ends a run, and the
			// operator restoring one is the operator continuing it.
			if (
				this.runState.status !== "running" &&
				this.runState.status !== "interrupted" &&
				this.runState.status !== "completed"
			) {
				this.rearm();
			}
		}

		if (this.runState.graphId !== graph.id || this.runState.jobId !== options.jobId) {
			throw new Error("checkpoint does not match graph and job");
		}
		options.signal?.addEventListener("abort", this.onAbort);
	}

	get state(): Readonly<GraphRunState> {
		return this.runState;
	}

	/**
	 * Re-arms a parked run so the next superstep continues it: status running,
	 * the pause's resume targets (or the active set) scheduled, and every
	 * scheduled node that is not mid-run reset to pending. A node a kill left
	 * `running` continues its own run with its retry count and backoff deadline
	 * intact. Public because the operator's "keep going" is exactly this.
	 */
	rearm(): void {
		this.runState.status = "running";
		this.runState.active = [...(this.runState.pause?.resume ?? this.runState.active)];
		for (const nodeId of this.runState.active) {
			const nodeState = this.runState.nodes[nodeId];
			if (nodeState !== undefined && nodeState.status !== "running") {
				nodeState.status = "pending";
			}
		}
		delete this.runState.pause;
		// A checkpoint from the release that enforced caps carries the terminal
		// record of the cap or status that ended it; it goes with the status.
		const legacy: GraphRunState & { terminal?: unknown } = this.runState;
		delete legacy.terminal;
	}

	private runDirectory(): string {
		return join(this.options.projectRoot, CONFIG_DIR_NAME, "runs", this.options.jobId);
	}

	private nodePrompt(node: AgentGraphNode): string {
		const lines = [
			// The run's own identity, substituted so a prompt can state the exact
			// trailer or path a node must produce instead of describing it.
			node.prompt.replaceAll("{{job_id}}", this.options.jobId),
			"",
			`Job: ${this.options.jobId}`,
			`Run directory: ${this.runDirectory()}`,
			"Read task.json and context.md from the run directory before acting.",
		];
		if (node.response !== undefined) {
			lines.push(
				`Return only JSON matching ${node.response.schema}; the graph engine writes ${node.response.path}.`,
			);
		}
		// An isolated re-run has no memory of the answer the operator sent back,
		// so the change request travels in the prompt. `runs` already counts this
		// run, so the first re-run reads "node run 2".
		const feedback =
			node.feedbackPath === undefined ? undefined : getStatePath(this.runState.values, node.feedbackPath);
		if (typeof feedback === "string" && feedback.length > 0) {
			lines.push(
				"",
				`Operator feedback on your previous response (node run ${this.runState.nodes[node.id].runs}):`,
				feedback,
				"Address every point, then return the corrected JSON only.",
			);
		}
		return lines.join("\n");
	}

	/**
	 * Prompt for an RP-13 contract-publishing worker. Never claims the graph
	 * engine will write the contract file: the worker must call write_contract.
	 */
	private workerNodePrompt(node: AgentGraphNode): string {
		const lines = [
			node.prompt.replaceAll("{{job_id}}", this.options.jobId),
			"",
			`Job: ${this.options.jobId}`,
			`Run directory: ${this.runDirectory()}`,
			"Read task.json, context.md, candidate.json, and evidence from the run directory before acting.",
			"Inspect the candidate and quality-gate results against every required acceptance criterion.",
			"Do not change repository product files.",
		];
		if (node.response !== undefined) {
			lines.push(
				`Publish the verdict only by calling write_contract with path ${node.response.path} and a payload matching ${node.response.schema}.`,
				"write_contract is pinned to this worker, job, role, and path; it is the only authoritative publication.",
				"Assistant transcript text is never the verdict and never authorizes release.",
			);
		}
		return lines.join("\n");
	}

	private checkpointDirectory(): string {
		return join(this.runDirectory(), "graph");
	}

	/**
	 * Snapshots the state now and queues the write. Nodes in one bounded batch
	 * can each be waiting out a retry, and `atomicWrite` derives its temporary
	 * path from the target, so two concurrent writers would share it.
	 */
	private writeCheckpoint(): Promise<void> {
		const name = `checkpoint-${String(this.runState.superstep).padStart(6, "0")}.json`;
		const snapshot = `${JSON.stringify(this.runState, null, 2)}\n`;
		const write = this.checkpointWrites.then(() => atomicWrite(join(this.checkpointDirectory(), name), snapshot));
		this.checkpointWrites = write.catch(() => undefined);
		return write;
	}

	private outgoing(nodeId: string): GraphEdge[] {
		return this.graph.edges.filter((edge) => edge.from === nodeId);
	}

	/**
	 * An edge fires when every one of its conditions holds. A list is a
	 * conjunction so a branch like "review red and untestable" stays one edge in
	 * graph data instead of a decision the driver makes.
	 */
	private edgeFires(edge: GraphEdge, values: JsonObject): boolean {
		if (edge.when === undefined) {
			return true;
		}
		const conditions = Array.isArray(edge.when) ? edge.when : [edge.when];
		return conditions.every((condition) => isDeepStrictEqual(getStatePath(values, condition.path), condition.equals));
	}

	/**
	 * Routes the nodes that just ran. A pause node wins over any sibling
	 * target: the run is parking, so scheduling more work would be a
	 * contradiction. Priority among pauses is graph edge order, which makes an
	 * ambiguous topology resolve the same way every replay.
	 */
	private route(
		nodeIds: readonly string[],
		values: JsonObject,
	): { targets: string[]; pause?: PauseGraphNode; gap?: string } {
		const targets = new Set<string>();
		let pause: PauseGraphNode | undefined;
		let gap: string | undefined;
		for (const nodeId of nodeIds) {
			const outgoing = this.outgoing(nodeId);
			let fired = false;
			for (const edge of outgoing) {
				if (!this.edgeFires(edge, values)) {
					continue;
				}
				fired = true;
				const target = this.nodes.get(edge.to);
				if (target?.type === "pause") {
					pause ??= target;
					continue;
				}
				targets.add(edge.to);
			}
			// A node whose branches all missed has not finished the run: treating
			// that as completion would report success for a state the topology never
			// accounted for.
			if (!fired && outgoing.length > 0) {
				gap ??= nodeId;
			}
		}
		targets.delete(END_NODE_ID);
		return { targets: [...targets], pause, gap };
	}

	/**
	 * Fold session-billed cost into the job meter. Uses deltas so threaded
	 * sessions that keep running across nodes are not double-counted. Returns
	 * the delta applied, or undefined when the session carries no finite cost
	 * (never a fabricated zero).
	 */
	private recordSessionCost(session: GraphAgentSession): number | undefined {
		const stats = session.getSessionStats?.();
		if (stats === undefined || typeof stats.cost !== "number" || !Number.isFinite(stats.cost)) {
			return undefined;
		}
		const previous = this.sessionCostBaseline.get(session) ?? 0;
		const delta = Math.max(0, stats.cost - previous);
		this.sessionCostBaseline.set(session, stats.cost);
		this.sessionCostUsd += delta;
		return delta;
	}

	/** The one source of the model label: bus.spawn, node.started, and LiveNodeSession all read it here. */
	private modelLabel(): string | undefined {
		return this.options.model === undefined ? undefined : `${this.options.model.provider}/${this.options.model.id}`;
	}

	/**
	 * Fire-and-forget notice that the live sessions registry changed (a node or
	 * worker session registered or released). Never blocks node execution; a
	 * rejecting hook is logged, not thrown.
	 */
	private noteSessionsChange(): void {
		let result: void | Promise<void>;
		try {
			result = this.options.onSessionsChange?.();
		} catch (error) {
			console.warn(
				`[kpi/graph] sessions change hook failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (result instanceof Promise) {
			result.catch((error: unknown) => {
				console.warn(
					`[kpi/graph] sessions change hook failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}
	}

	/** Appends a node.started or node.finished record to the run's event log. */
	private async appendNodeEvent(event: NodeLifecycleEvent): Promise<void> {
		// node.started can be the very first write of a fresh run, before any
		// checkpoint (whose atomicWrite otherwise creates the directory) has run.
		await mkdir(this.runDirectory(), { recursive: true });
		await appendEvent(join(this.runDirectory(), "events.jsonl"), event);
	}

	private async createSessionForNode(
		node: AgentGraphNode,
	): Promise<{ session: GraphAgentSession; disposeAfter: boolean }> {
		const threadKey = node.context.threadKey ?? node.id;
		if (node.context.mode === "thread") {
			const existing = this.threadSessions.get(threadKey);
			if (existing !== undefined) {
				return { session: existing, disposeAfter: false };
			}
		}

		const sessionDirectory = join(
			this.options.projectRoot,
			CONFIG_DIR_NAME,
			"runs",
			this.options.jobId,
			"agents",
			safeThreadKey(threadKey),
		);
		await mkdir(sessionDirectory, { recursive: true });
		const sessionManager = SessionManager.continueRecent(this.options.projectRoot, sessionDirectory);

		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(this.options.projectRoot, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.options.projectRoot,
			agentDir,
			settingsManager,
			extensionFactories: graphAgentExtensionFactories(),
		});
		await resourceLoader.reload();
		const result = await this.sessionFactory({
			cwd: this.options.projectRoot,
			agentDir,
			sessionManager,
			settingsManager,
			resourceLoader,
			model: this.options.model,
			thinkingLevel: this.options.thinkingLevel,
			tools: [...node.tools],
			excludeTools: node.readOnly ? ["bash", "edit", "write"] : undefined,
		});
		if (this.uiContext !== undefined) {
			const session = result.session as GraphAgentSession & {
				bindExtensions?: (b: {
					uiContext?: ExtensionUIContext;
					mode?: "rpc" | "print" | "interactive";
				}) => Promise<void>;
			};
			if (typeof session.bindExtensions === "function") {
				await session.bindExtensions({
					uiContext: this.uiContext,
					mode: "rpc",
				});
			}
		}
		const unexpectedTool = node.readOnly
			? result.session.getActiveToolNames().find((tool) => !node.tools.includes(tool))
			: undefined;
		if (unexpectedTool !== undefined) {
			result.session.dispose();
			throw new GraphNodeContractError(
				node.id,
				`read-only agent node ${node.id} registered forbidden tool ${unexpectedTool}`,
			);
		}

		if (node.context.mode === "thread") {
			this.threadSessions.set(threadKey, result.session);
		}
		return {
			session: result.session,
			disposeAfter: node.context.mode === "isolated",
		};
	}

	private async executeNode(node: GraphNode): Promise<NodeResult> {
		if (node.type === "set") {
			return { nodeId: node.id, assignments: node.assignments };
		}
		if (node.type === "human") {
			throw new Error(`human node ${node.id} must interrupt before execution`);
		}
		if (node.type === "pause") {
			// Routing parks at a pause node, so reaching execution would mean the
			// run was scheduled past its own park.
			throw new Error(`pause node ${node.id} must pause the run before execution`);
		}

		if (node.workerRole !== undefined) {
			return this.executeWorkerAgentNode(node);
		}

		const { session, disposeAfter } = await this.createSessionForNode(node);
		this.runState.nodes[node.id].sessionId = session.sessionId;
		const releaseSession = registerLiveNodeSession({
			kind: "node",
			jobId: this.options.jobId,
			nodeId: node.id,
			sessionId: session.sessionId,
			contextMode: node.context.mode,
			threadKey: node.context.threadKey ?? node.id,
			model: this.modelLabel(),
			startedAt: new Date(this.now()).toISOString(),
			stats: () => session.getSessionStats?.(),
		});
		this.noteSessionsChange();
		this.inFlight.add(session);
		try {
			if (node.response === undefined) {
				this.assertNotAborted();
				await session.prompt(this.nodePrompt(node));
				const providerError = session.getLastAssistantError?.();
				if (providerError !== undefined) {
					throw new GraphNodeProviderError(node.id, providerError);
				}
				return { nodeId: node.id, assignments: {} };
			}

			const schema = await loadResponseSchema(this.options.projectRoot, node.response.schema);
			let validationErrors: string[] = [];
			for (let attempt = 0; attempt <= node.response.retries; attempt += 1) {
				const prompt =
					attempt === 0
						? this.nodePrompt(node)
						: `Your previous response failed ${node.response.schema}: ${validationErrors.join("; ")}. Return corrected JSON only.`;
				// A stop that landed while the session was idle (creating it, or
				// between validation attempts) has no run to abort: refuse the next prompt.
				this.assertNotAborted();
				await session.prompt(prompt);
				const providerError = session.getLastAssistantError?.();
				if (providerError !== undefined) {
					throw new GraphNodeProviderError(node.id, providerError);
				}
				const source = session.getLastAssistantText?.();
				if (source === undefined) {
					validationErrors = ["assistant response text is unavailable"];
					continue;
				}

				let output: unknown;
				try {
					output = JSON.parse(source);
				} catch {
					validationErrors = ["response is not valid JSON"];
					continue;
				}
				validationErrors = validateJsonSchema(output, schema);
				if (validationErrors.length > 0) {
					continue;
				}
				if (!isJsonObject(output)) {
					validationErrors = ["response must be a JSON object"];
					continue;
				}

				const assignments: Record<string, JsonValue> = {};
				for (const [statePath, responsePath] of Object.entries(node.response.state)) {
					const value = getStatePath(output, responsePath);
					if (value === undefined) {
						validationErrors = [`response state path ${responsePath} does not exist`];
						break;
					}
					assignments[statePath] = structuredClone(value);
				}
				if (validationErrors.length > 0) {
					continue;
				}

				// stack.json is not only JSON-shaped: Dune semantic rules refuse layer
				// maps, missing twins, and folder/id mismatches before implement can read them.
				if (node.response.path === "stack.json") {
					try {
						assertDuneStack(output);
					} catch (error) {
						validationErrors = [
							error instanceof DuneStackError || error instanceof Error ? error.message : String(error),
						];
						continue;
					}
				}

				await atomicWrite(join(this.runDirectory(), node.response.path), `${JSON.stringify(output, null, 2)}\n`);
				return { nodeId: node.id, assignments };
			}
			throw new GraphNodeContractError(
				node.id,
				`agent node ${node.id} failed response validation after ${node.response.retries + 1} attempts: ${validationErrors.join("; ")}`,
			);
		} finally {
			this.inFlight.delete(session);
			releaseSession();
			this.noteSessionsChange();
			const delta = this.recordSessionCost(session);
			if (delta !== undefined) {
				this.nodeRunCostUsd.set(node.id, (this.nodeRunCostUsd.get(node.id) ?? 0) + delta);
			}
			if (disposeAfter) {
				session.dispose();
			}
		}
	}

	/**
	 * Runs an agent node as an RP-13 background worker.
	 *
	 * Spawns once, waits for the settlement promise captured before the initial
	 * prompt, then requires a fresh receipt-backed contract publication. The
	 * worker already wrote the file through write_contract; this path never
	 * rewrites it and never treats transcript text as the result.
	 */
	private async executeWorkerAgentNode(node: AgentGraphNode): Promise<NodeResult> {
		if (node.workerRole === undefined || node.response === undefined) {
			throw new GraphNodeContractError(
				node.id,
				`worker-role agent node ${node.id} requires workerRole and a response contract`,
			);
		}

		const bus = new BackgroundBus(
			this.options.projectRoot,
			this.runDirectory(),
			this.options.jobId,
			this.options.busDependencies ?? {},
		);
		const releaseBus = registerLiveBus(bus);
		let agentId: string | undefined;
		try {
			this.assertNotAborted();
			const worker = await bus.spawn({
				role: node.workerRole,
				prompt: this.workerNodePrompt(node),
				model: this.modelLabel(),
				node: node.id,
			});
			agentId = worker.agentId;
			this.noteSessionsChange();
			const nodeState = this.runState.nodes[node.id];
			nodeState.sessionId = worker.sessionPath;
			nodeState.agentId = worker.agentId;

			let published: {
				receipt: { declared_path: string };
				document: Record<string, unknown>;
			};
			try {
				// The operator's stop lands here at once; `finally` stops the worker.
				published = await this.abortable(bus.awaitInitialContract(worker.agentId));
			} catch (error) {
				if (error instanceof OperatorStopError) {
					throw error;
				}
				throw new GraphNodeContractError(
					node.id,
					`worker-role agent node ${node.id} failed closed without a receipt-backed ${node.response.path}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}

			if (published.receipt.declared_path !== node.response.path) {
				throw new GraphNodeContractError(
					node.id,
					`worker published ${published.receipt.declared_path}, expected ${node.response.path}`,
				);
			}

			const output = published.document;
			if (!isJsonObject(output)) {
				throw new GraphNodeContractError(node.id, `published ${node.response.path} is not a JSON object`);
			}
			const assignments: Record<string, JsonValue> = {};
			for (const [statePath, responsePath] of Object.entries(node.response.state)) {
				const value = getStatePath(output, responsePath);
				if (value === undefined) {
					throw new GraphNodeContractError(
						node.id,
						`published ${node.response.path} is missing state path ${responsePath}`,
					);
				}
				assignments[statePath] = structuredClone(value);
			}
			// File bytes stay as the worker published them. GraphEngine does not rewrite.
			await this.emitReviewVerdictIfNeeded(node, output);
			return { nodeId: node.id, assignments };
		} finally {
			if (agentId !== undefined) {
				await bus.stop(agentId).catch(() => undefined);
			}
			releaseBus();
			this.noteSessionsChange();
		}
	}

	/**
	 * Concise review.verdict event when a receipt-backed reviewer contract is accepted.
	 * Counts and status only — never transcript text or full verdict bytes.
	 */
	private async emitReviewVerdictIfNeeded(node: AgentGraphNode, output: Record<string, unknown>): Promise<void> {
		const path = node.response?.path;
		const isReviewer =
			node.workerRole === "reviewer" || path === "verdict.json" || path?.endsWith("/verdict.json") === true;
		if (!isReviewer) return;

		const fields = buildReviewVerdictEventFields(output);
		if (fields === undefined) return;

		await appendEvent(join(this.runDirectory(), "events.jsonl"), {
			ts: new Date().toISOString(),
			type: "review.verdict",
			job_id: this.options.jobId,
			round: this.runState.budget.round,
			node: node.id,
			...fields,
		});
	}

	/**
	 * Runs one node, retrying a transient failure (http 408/429/5xx, timeout,
	 * transport) for as long as it takes: the backoff doubles from the base to
	 * the ceiling and the loop has no bound. A retry is neither a round nor a
	 * run. Before every wait the count, reason and deadline are checkpointed and
	 * `onRetry` is told, so a kill mid-wait resumes into the same wait and the
	 * operator sees every attempt. The only ways out are success, a
	 * non-transient failure, and the operator's stop.
	 */
	private async executeWithRetries(node: GraphNode): Promise<NodeResult> {
		const nodeState = this.runState.nodes[node.id];
		// Retries are same-run. A new legitimate run counts from zero; a run
		// resumed after a kill keeps its count and its place in the sequence.
		if (nodeState.retryRun !== nodeState.runs) {
			nodeState.retryRun = nodeState.runs;
			nodeState.transientRetries = 0;
			nodeState.retryDelaysMs = [];
			delete nodeState.retryReason;
			delete nodeState.retryAtMs;
		}
		// A run resumed mid-backoff finishes the wait it was in rather than
		// restarting the node, and the stop checks apply to that wait too.
		if (nodeState.retryAtMs !== undefined) {
			const remainder = nodeState.retryAtMs - this.now();
			if (remainder > 0) {
				await this.backoff(remainder);
			} else {
				await this.assertNotStopped();
			}
			delete nodeState.retryAtMs;
		}
		for (;;) {
			this.assertNotAborted();
			let result: NodeResult;
			try {
				result = await this.executeNode(node);
			} catch (error) {
				// Whatever an aborted session threw, the operator's stop is the reason.
				this.assertNotAborted();
				if (error instanceof GraphNodeContractError) {
					throw error;
				}
				const reason = classifyTransientFailure(error);
				if (reason === undefined) {
					throw error;
				}
				const spent = nodeState.transientRetries ?? 0;
				const delayMs = retryDelayMs(spent, this.retryBaseDelayMs);
				const message = error instanceof Error ? error.message : String(error);
				nodeState.transientRetries = spent + 1;
				nodeState.retryReason = reason;
				nodeState.retryAtMs = this.now() + delayMs;
				nodeState.retryDelaysMs = [...(nodeState.retryDelaysMs ?? []), delayMs];
				nodeState.error = `transient ${reason}: ${message}`;
				await this.writeCheckpoint();
				const status = httpStatus(error);
				await this.options.onRetry?.({
					nodeId: node.id,
					attempt: spent + 1,
					reason,
					...(status === undefined ? {} : { status }),
					delayMs,
					message,
				});
				await this.backoff(delayMs);
				delete nodeState.retryAtMs;
				continue;
			}
			// The attempt returned, but the operator's stop came first: the result
			// is not committed, and the node continues on resume.
			this.assertNotAborted();
			return result;
		}
	}

	/**
	 * Waits one backoff. The wait races the operator's signal so a stop lands
	 * at once, and the stop marker is consulted after it, so `/kpi stop` from
	 * another session lands here rather than after the next attempt.
	 */
	private async backoff(delayMs: number): Promise<void> {
		await this.abortable(this.sleep(delayMs, this.options.signal));
		await this.assertNotStopped();
	}

	/** The operator's stop, checked before any work an aborted signal could not otherwise interrupt. */
	private assertNotAborted(): void {
		if (this.options.signal?.aborted) {
			throw new OperatorStopError();
		}
	}

	private async assertNotStopped(): Promise<void> {
		if (this.options.signal?.aborted || (await this.options.stopRequested?.()) === true) {
			throw new OperatorStopError();
		}
	}

	/** Settles with the promise, or rejects with OperatorStopError the moment the operator aborts. */
	private abortable<T>(promise: Promise<T>): Promise<T> {
		const signal = this.options.signal;
		if (signal === undefined) {
			return promise;
		}
		if (signal.aborted) {
			return Promise.reject(new OperatorStopError());
		}
		const settled = Promise.withResolvers<T>();
		const onAbort = (): void => {
			settled.reject(new OperatorStopError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(settled.resolve, settled.reject).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
		return settled.promise;
	}

	/**
	 * A contract defect — a routing gap, two writers of one path, a node that
	 * will not validate — is neither the operator's stop nor a retry: the run
	 * parks NEEDS_HUMAN (contract) with the nodes marked failed. A resume
	 * re-runs those nodes and every active node the pause left unexecuted, so
	 * a sibling in a later batch is never dropped from the topology's schedule.
	 */
	private fail(message: string, nodeIds: readonly string[]): Promise<Readonly<GraphRunState>> {
		for (const nodeId of nodeIds) {
			this.runState.nodes[nodeId].status = "failed";
			this.runState.nodes[nodeId].error = message;
		}
		const pending = this.runState.active.filter(
			(id) => !nodeIds.includes(id) && this.runState.nodes[id]?.status === "pending",
		);
		return this.pause({
			recovery: "contract",
			reason: message,
			round: this.runState.budget.round,
			superstep: this.runState.superstep,
			nodes: [...nodeIds],
			resume: [...nodeIds, ...pending],
		});
	}

	/** Folds the injected clock and cost source into the durable, report-only counters. */
	private readBudget(): void {
		const budget = this.runState.budget;
		budget.elapsedMs = Math.max(0, this.now() - budget.startedAtMs);
		budget.costUsd = this.accumulatedCostUsd();
	}

	/**
	 * Parks the run: durable status, one checkpoint, one `loop.terminal`.
	 * `active` is left as the record of what was running; `rearm()` schedules
	 * `resume`.
	 */
	private async pause(pause: GraphPauseState): Promise<Readonly<GraphRunState>> {
		this.runState.status = "paused";
		this.runState.pause = pause;
		this.runState.superstep += 1;
		await this.writeCheckpoint();
		await this.emitTerminal(pause);
		return this.runState;
	}

	/** Parks at a pause node the topology routed to. The pause node itself never runs. */
	private routedPause(node: PauseGraphNode): Promise<Readonly<GraphRunState>> {
		return this.pause({
			recovery: node.recovery,
			reason: node.reason,
			round: this.runState.budget.round,
			superstep: this.runState.superstep,
			nodes: [node.id],
			resume: [...node.resume],
		});
	}

	/** The single terminal event a paused run is allowed to emit. */
	private async emitTerminal(pause: GraphPauseState): Promise<void> {
		if (this.options.emitTerminal !== undefined) {
			await this.options.emitTerminal(pause);
			return;
		}
		await appendEvent(join(this.runDirectory(), "events.jsonl"), {
			ts: new Date(this.now()).toISOString(),
			type: "loop.terminal",
			job_id: this.options.jobId,
			round: pause.round,
			node: pause.nodes[0] ?? "graph",
			status: "NEEDS_HUMAN",
			reason: pause.reason,
			recovery: pause.recovery,
		});
	}

	async runSuperstep(): Promise<Readonly<GraphRunState>> {
		if (this.runState.status === "interrupted") {
			throw new Error("graph is interrupted and must be resumed");
		}
		if (this.runState.status !== "running") {
			return this.runState;
		}
		this.readBudget();

		const activeNodes = this.runState.active.map((id) => {
			const node = this.nodes.get(id);
			if (node === undefined) {
				throw new Error(`active graph node does not exist: ${id}`);
			}
			return node;
		});

		const humanNode = activeNodes.find((node) => node.type === "human");
		if (humanNode !== undefined) {
			if (activeNodes.length !== 1 || humanNode.type !== "human") {
				return this.fail("human nodes cannot share a superstep", this.runState.active);
			}
			const nodeState = this.runState.nodes[humanNode.id];
			nodeState.runs += 1;
			nodeState.status = "interrupted";
			this.countRound();
			this.runState.status = "interrupted";
			this.runState.pendingHuman = {
				nodeId: humanNode.id,
				title: humanNode.title,
				question: humanNode.question,
			};
			this.runState.superstep += 1;
			await this.writeCheckpoint();
			return this.runState;
		}

		// Bookkeeping happens per batch, immediately around the work it describes.
		// Counting a whole superstep up front and then stopping between batches
		// would leave a checkpoint claiming runs for nodes that never started, and
		// a resume would repeat the side effects of the batches that did.
		const results: NodeResult[] = [];
		const executed: GraphNode[] = [];
		for (const batch of batchReadyNodes(activeNodes, this.runState.budget.limits.maxConcurrency)) {
			for (const node of batch) {
				const nodeState = this.runState.nodes[node.id];
				// A node whose checkpoint already says `running` was killed mid-run;
				// continuing it is the same run, so neither its run count nor the
				// graph's round moves again.
				if (nodeState.status !== "running") {
					nodeState.runs += 1;
				}
				nodeState.status = "running";
				delete nodeState.error;
			}
			this.countRound();

			// Bracket every agent node in the batch with node.started/node.finished on
			// events.jsonl; a resumed `running` node re-emits node.started with the
			// same run number since its runs count did not move above. Transient
			// retries inside executeWithRetries never repeat either event.
			const startedAt = new Map<string, number>();
			for (const node of batch) {
				if (node.type !== "agent") {
					continue;
				}
				const t = this.now();
				startedAt.set(node.id, t);
				this.nodeRunCostUsd.delete(node.id);
				const model = this.modelLabel();
				await this.appendNodeEvent({
					ts: new Date(t).toISOString(),
					type: "node.started",
					job_id: this.options.jobId,
					round: this.runState.budget.round,
					node: node.id,
					run: this.runState.nodes[node.id].runs,
					...(model === undefined ? {} : { model }),
				});
			}

			// Settled, not fail-fast. A sibling that finished has already had its
			// side effects, so discarding its result would make a resumed run repeat
			// them; it is committed exactly once here and never reruns.
			const settled = await Promise.allSettled(batch.map((node) => this.executeWithRetries(node)));
			const rejected: { node: GraphNode; error: unknown }[] = [];
			for (const [index, outcome] of settled.entries()) {
				const node = batch[index];
				if (outcome.status === "fulfilled") {
					results.push(outcome.value);
					executed.push(node);
					continue;
				}
				rejected.push({ node, error: outcome.reason });
				// A stopped node is not finished: it keeps its retry record and
				// continues on resume, so it is neither marked nor reported failed.
				if (outcome.reason instanceof OperatorStopError) {
					continue;
				}
				this.runState.nodes[node.id].status = "failed";
				this.runState.nodes[node.id].error =
					outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
			}

			for (const [index, outcome] of settled.entries()) {
				const node = batch[index];
				if (
					node.type !== "agent" ||
					(outcome.status === "rejected" && outcome.reason instanceof OperatorStopError)
				) {
					continue;
				}
				const nodeStartedAt = startedAt.get(node.id);
				if (nodeStartedAt === undefined) {
					continue;
				}
				const t = this.now();
				const elapsedMs = Math.max(0, t - nodeStartedAt);
				const costUsd = this.nodeRunCostUsd.get(node.id);
				this.nodeRunCostUsd.delete(node.id);
				const nodeState = this.runState.nodes[node.id];
				if (outcome.status === "fulfilled") {
					await this.appendNodeEvent({
						ts: new Date(t).toISOString(),
						type: "node.finished",
						job_id: this.options.jobId,
						round: this.runState.budget.round,
						node: node.id,
						run: nodeState.runs,
						status: "completed",
						elapsed_ms: elapsedMs,
						...(costUsd === undefined ? {} : { cost_usd: costUsd }),
						...(node.response !== undefined ? { result: node.response.path } : {}),
						...(nodeState.sessionId === undefined ? {} : { session: nodeState.sessionId }),
					});
				} else {
					const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
					await this.appendNodeEvent({
						ts: new Date(t).toISOString(),
						type: "node.finished",
						job_id: this.options.jobId,
						round: this.runState.budget.round,
						node: node.id,
						run: nodeState.runs,
						status: "failed",
						elapsed_ms: elapsedMs,
						...(costUsd === undefined ? {} : { cost_usd: costUsd }),
						...(nodeState.sessionId === undefined ? {} : { session: nodeState.sessionId }),
						error,
					});
				}
			}

			if (rejected.length > 0) {
				const conflict = this.commitResults(results, executed);
				if (conflict !== undefined) {
					return this.fail(conflict, this.runState.active);
				}
				this.runState.active = activeNodes.filter((node) => !executed.includes(node)).map((node) => node.id);
				// The operator's stop wins over any sibling's failure; otherwise batch
				// order decides, and every rejection is already recorded on its node.
				const first =
					rejected.find((entry) => entry.error instanceof OperatorStopError)?.error ?? rejected[0].error;
				if (first instanceof OperatorStopError || first instanceof GraphNodeProviderError) {
					// Both are the driver's to record: STOPPED, or NEEDS_HUMAN (provider).
					// The checkpoint keeps a stopped node `running` with its retry count
					// and deadline so a restore continues it, and a refused node
					// `failed` with the refusal so a restore re-runs it.
					await this.writeCheckpoint();
					throw first;
				}
				return this.fail(
					first instanceof Error ? first.message : String(first),
					rejected.map((entry) => entry.node.id),
				);
			}
			this.runState.budget.batches += 1;
		}

		const conflict = this.commitResults(results, executed);
		if (conflict !== undefined) {
			return this.fail(conflict, this.runState.active);
		}
		this.readBudget();
		// Environment facts are refreshed before routing, never after: an edge
		// that tests bounds or evidence freshness must see the state the batch
		// just produced, not the state it started from.
		await this.refreshFacts();
		const routed = this.route(
			executed.map((node) => node.id),
			this.runState.values,
		);
		if (routed.pause !== undefined) {
			return this.routedPause(routed.pause);
		}
		if (routed.gap !== undefined) {
			return this.fail(`no graph edge from ${routed.gap} matched the run state`, [routed.gap]);
		}
		this.runState.active = routed.targets;
		this.runState.status = this.runState.active.length === 0 ? "completed" : "running";
		this.runState.superstep += 1;
		await this.writeCheckpoint();
		return this.runState;
	}

	/**
	 * Merges the injected fact source into run state. Facts are things only the
	 * caller can know - whether writes stayed inside the task's bounds, whether
	 * evidence still matches HEAD, whether this job already shipped - and they
	 * are data, so the topology can route on them instead of the driver.
	 */
	private async refreshFacts(): Promise<void> {
		const facts = await this.options.resolveFacts?.();
		if (facts === undefined) {
			return;
		}
		const values = structuredClone(this.runState.values);
		for (const [path, value] of Object.entries(facts)) {
			setStatePath(values, path, value);
		}
		this.runState.values = values;
	}

	/**
	 * Applies the batches' assignments and marks their nodes completed. Returns a
	 * message instead when two nodes wrote the same state path, which is a graph
	 * defect rather than a budget outcome.
	 */
	private commitResults(results: readonly NodeResult[], executed: readonly GraphNode[]): string | undefined {
		const seenPaths = new Set<string>();
		const values = structuredClone(this.runState.values);
		for (const result of results) {
			for (const [path, value] of Object.entries(result.assignments)) {
				if (seenPaths.has(path)) {
					return `multiple nodes wrote state path ${path} in one superstep`;
				}
				seenPaths.add(path);
				setStatePath(values, path, value);
			}
		}
		this.runState.values = values;
		for (const node of executed) {
			this.runState.nodes[node.id].status = "completed";
		}
		return undefined;
	}

	/** A round is one more run of the busiest node in the graph. */
	private countRound(): void {
		this.runState.budget.round = Object.values(this.runState.nodes).reduce(
			(round, node) => Math.max(round, node.runs),
			0,
		);
	}

	async runUntilPause(): Promise<Readonly<GraphRunState>> {
		while (this.runState.status === "running") {
			await this.runSuperstep();
		}
		return this.runState;
	}

	async submitHuman(answer: HumanAnswer): Promise<Readonly<GraphRunState>> {
		const pending = this.runState.pendingHuman;
		if (this.runState.status !== "interrupted" || pending === undefined) {
			throw new Error("graph has no pending human node");
		}
		const node = this.nodes.get(pending.nodeId);
		if (node?.type !== "human") {
			throw new Error(`pending human node does not exist: ${pending.nodeId}`);
		}
		// Every refusal happens before any state moves, so a refused answer leaves
		// the gate pending and the caller asks again.
		if (answer.feedback !== undefined && node.feedbackPath === undefined) {
			throw new Error(`human node ${node.id} accepts no feedback`);
		}
		const feedback = answer.feedback?.trim() ?? "";
		if (node.feedbackPath !== undefined && !answer.approved && feedback.length === 0) {
			throw new Error(`human node ${node.id} was denied without feedback`);
		}

		const values = structuredClone(this.runState.values);
		setStatePath(values, node.statePath, answer.approved);
		if (node.feedbackPath !== undefined && !answer.approved) {
			setStatePath(values, node.feedbackPath, feedback);
		}
		this.runState.values = values;
		this.runState.nodes[node.id].status = "completed";
		await this.refreshFacts();
		const routed = this.route([node.id], this.runState.values);
		delete this.runState.pendingHuman;
		if (routed.pause !== undefined) {
			return this.routedPause(routed.pause);
		}
		if (routed.gap !== undefined) {
			return this.fail(`no graph edge from ${routed.gap} matched the run state`, [routed.gap]);
		}
		this.runState.active = routed.targets;
		this.runState.status = this.runState.active.length === 0 ? "completed" : "running";
		this.runState.superstep += 1;
		await this.writeCheckpoint();
		return this.runState;
	}

	async resume(answer: HumanAnswer): Promise<Readonly<GraphRunState>> {
		await this.submitHuman(answer);
		return this.runUntilPause();
	}

	dispose(): void {
		this.options.signal?.removeEventListener("abort", this.onAbort);
		for (const session of this.threadSessions.values()) {
			session.dispose();
		}
		this.threadSessions.clear();
	}

	static async restore(graph: GraphDefinition, options: GraphEngineOptions): Promise<GraphEngine> {
		const directory = join(options.projectRoot, CONFIG_DIR_NAME, "runs", options.jobId, "graph");
		const checkpointNames = (await readdir(directory)).filter((name) => /^checkpoint-\d{6}\.json$/.test(name)).sort();
		const latest = checkpointNames.at(-1);
		if (latest === undefined) {
			throw new Error(`No graph checkpoint found for job ${options.jobId}`);
		}
		const state = JSON.parse(await readFile(join(directory, latest), "utf8")) as GraphRunState;
		return new GraphEngine(graph, options, state);
	}
}
