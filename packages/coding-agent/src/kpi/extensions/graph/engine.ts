import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { CONFIG_DIR_NAME, getKpiResourceDir } from "../../../config.ts";

import { type CreateAgentSessionOptions, createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";

import { appendEvent } from "../append-log.ts";
import { atomicWrite } from "../run-store.ts";
import {
	batchReadyNodes,
	type BudgetExhaustion,
	findExhaustedNodeLimit,
	findExhaustedRunLimit,
	isBudgetState,
	resolveGraphBudgetLimits,
	type RunBudgetReading,
} from "./budget.ts";
import { type JsonSchema, validateJsonSchema } from "./json-schema.ts";
import {
	type AgentGraphNode,
	type GraphBudgetLimits,
	type GraphBudgetOverrides,
	type GraphDefinition,
	type GraphEdge,
	type GraphNode,
	type GraphRunState,
	type GraphTerminalState,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./schema.ts";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FORBIDDEN_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);
const END_NODE_ID = "__end__";

export interface GraphAgentSession {
	readonly sessionId: string;
	prompt(text: string): Promise<void>;
	getLastAssistantText?(): string | undefined;
	getActiveToolNames(): string[];
	dispose(): void;
}

export type GraphAgentSessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: GraphAgentSession }>;

export interface GraphEngineOptions {
	projectRoot: string;
	jobId: string;
	createAgentSession?: GraphAgentSessionFactory;
	/** Injected wall clock in epoch milliseconds. */
	now?: () => number;
	/** Injected accumulated job cost in USD. */
	accumulatedCostUsd?: () => number;
	/** Cap overrides from the validated task/job contract. */
	limits?: GraphBudgetOverrides;
	/**
	 * Sink for the one product terminal event a cap produces. Defaults to
	 * appending `loop.terminal` to the run's event log.
	 */
	emitTerminal?: (terminal: GraphTerminalState) => Promise<void>;
}

export interface GraphHumanUI {
	confirm(title: string, message: string): Promise<boolean>;
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

	if (value.type === "human") {
		assertString(value.title, `human node ${value.id}.title`);
		assertString(value.question, `human node ${value.id}.question`);
		assertString(value.statePath, `human node ${value.id}.statePath`);
		assertStatePath(value.statePath, `human node ${value.id}`);
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
	if (value.readOnly) {
		const mutatingTool = value.tools.find((tool) => !READ_ONLY_TOOLS.has(tool));
		if (mutatingTool !== undefined) {
			throw new Error(`read-only agent node ${value.id} cannot enable tool ${mutatingTool}`);
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

function validateLimits(value: unknown): void {
	if (!isJsonObject(value)) {
		throw new Error("graph limits must be an object");
	}
	for (const key of ["maxSteps", "maxNodeRuns", "maxConcurrency", "maxCostUsd", "timeoutMs"]) {
		const limit = value[key];
		if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
			throw new Error(`graph limits.${key} must be a positive number`);
		}
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
			if (!isJsonObject(edge.when)) {
				throw new Error(`edges[${index}].when must be an object`);
			}
			assertString(edge.when.path, `edges[${index}].when.path`);
			assertStatePath(edge.when.path, `edges[${index}].when`);
			if (!("equals" in edge.when)) {
				throw new Error(`edges[${index}].when must define equals`);
			}
		}
	}

	validateLimits(value.limits);
	validatePolicy(value.policy);
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

export class GraphEngine {
	private readonly graph: GraphDefinition;
	private readonly options: GraphEngineOptions;
	private readonly nodes: Map<string, GraphNode>;
	private readonly sessionFactory: GraphAgentSessionFactory;
	private readonly threadSessions = new Map<string, GraphAgentSession>();
	private readonly now: () => number;
	private readonly accumulatedCostUsd: () => number;
	private runState: GraphRunState;

	constructor(graph: GraphDefinition, options: GraphEngineOptions, initialState?: GraphRunState) {
		validateGraphDefinition(graph);
		this.graph = graph;
		this.options = options;
		this.nodes = new Map(graph.nodes.map((node) => [node.id, node]));
		this.sessionFactory = options.createAgentSession ?? createAgentSession;
		this.now = options.now ?? Date.now;
		this.accumulatedCostUsd = options.accumulatedCostUsd ?? (() => 0);

		if (initialState === undefined) {
			const limits = resolveGraphBudgetLimits(graph.limits, options.limits);
			this.runState = {
				graphId: graph.id,
				jobId: options.jobId,
				status: "running",
				superstep: 0,
				active: [graph.entry],
				values: {},
				nodes: Object.fromEntries(graph.nodes.map((node) => [node.id, { status: "pending" as const, runs: 0 }])),
				budget: {
					limits,
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
			// A restored run keeps the caps it was started under unless the
			// caller supplies a freshly validated contract.
			this.runState.budget.limits = resolveGraphBudgetLimits(
				graph.limits,
				options.limits ?? initialState.budget.limits,
			);
		}

		if (this.runState.graphId !== graph.id || this.runState.jobId !== options.jobId) {
			throw new Error("checkpoint does not match graph and job");
		}
	}

	get state(): Readonly<GraphRunState> {
		return this.runState;
	}

	get limits(): Readonly<GraphBudgetLimits> {
		return this.runState.budget.limits;
	}

	private runDirectory(): string {
		return join(this.options.projectRoot, CONFIG_DIR_NAME, "runs", this.options.jobId);
	}

	private nodePrompt(node: AgentGraphNode): string {
		const lines = [
			node.prompt,
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
		return lines.join("\n");
	}

	private checkpointDirectory(): string {
		return join(this.runDirectory(), "graph");
	}

	private async writeCheckpoint(): Promise<void> {
		const name = `checkpoint-${String(this.runState.superstep).padStart(6, "0")}.json`;
		await atomicWrite(join(this.checkpointDirectory(), name), `${JSON.stringify(this.runState, null, 2)}\n`);
	}

	private outgoing(nodeId: string): GraphEdge[] {
		return this.graph.edges.filter((edge) => edge.from === nodeId);
	}

	private nextNodes(nodeIds: readonly string[], values: JsonObject): string[] {
		const targets = new Set<string>();
		for (const nodeId of nodeIds) {
			for (const edge of this.outgoing(nodeId)) {
				if (edge.when === undefined || isDeepStrictEqual(getStatePath(values, edge.when.path), edge.when.equals)) {
					targets.add(edge.to);
				}
			}
		}
		targets.delete(END_NODE_ID);
		return [...targets];
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

		const result = await this.sessionFactory({
			cwd: this.options.projectRoot,
			sessionManager,
			tools: [...node.tools],
			excludeTools: node.readOnly ? ["bash", "edit", "write"] : undefined,
		});
		const unexpectedTool = node.readOnly
			? result.session.getActiveToolNames().find((tool) => !node.tools.includes(tool))
			: undefined;
		if (unexpectedTool !== undefined) {
			result.session.dispose();
			throw new Error(`read-only agent node ${node.id} registered forbidden tool ${unexpectedTool}`);
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

		const { session, disposeAfter } = await this.createSessionForNode(node);
		this.runState.nodes[node.id].sessionId = session.sessionId;
		try {
			if (node.response === undefined) {
				await session.prompt(this.nodePrompt(node));
				return { nodeId: node.id, assignments: {} };
			}

			const schema = await loadResponseSchema(this.options.projectRoot, node.response.schema);
			let validationErrors: string[] = [];
			for (let attempt = 0; attempt <= node.response.retries; attempt += 1) {
				const prompt =
					attempt === 0
						? this.nodePrompt(node)
						: `Your previous response failed ${node.response.schema}: ${validationErrors.join("; ")}. Return corrected JSON only.`;
				await session.prompt(prompt);
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

				await atomicWrite(join(this.runDirectory(), node.response.path), `${JSON.stringify(output, null, 2)}\n`);
				return { nodeId: node.id, assignments };
			}
			throw new Error(
				`agent node ${node.id} failed response validation after ${node.response.retries + 1} attempts: ${validationErrors.join("; ")}`,
			);
		} finally {
			if (disposeAfter) {
				session.dispose();
			}
		}
	}

	private async fail(message: string, nodeIds: readonly string[]): Promise<never> {
		this.runState.status = "failed";
		for (const nodeId of nodeIds) {
			this.runState.nodes[nodeId].status = "failed";
			this.runState.nodes[nodeId].error = message;
		}
		this.runState.superstep += 1;
		await this.writeCheckpoint();
		throw new Error(message);
	}

	/**
	 * Folds the injected clock and cost source into the durable counters and
	 * returns what the run-wide caps are checked against.
	 */
	private readBudget(): RunBudgetReading {
		const budget = this.runState.budget;
		budget.elapsedMs = Math.max(0, this.now() - budget.startedAtMs);
		budget.costUsd = this.accumulatedCostUsd();
		return {
			superstep: this.runState.superstep,
			elapsedMs: budget.elapsedMs,
			costUsd: budget.costUsd,
		};
	}

	/**
	 * A crossed cap is a product outcome, not a crash. The run becomes durably
	 * `exhausted`, the checkpoint records which cap ended it, and exactly one
	 * terminal event leaves the engine. `active` is preserved so a run resumed
	 * under raised caps still knows what it owed.
	 */
	private async exhaust(
		exhaustion: BudgetExhaustion,
		nodeIds: readonly string[],
	): Promise<Readonly<GraphRunState>> {
		this.runState.status = "exhausted";
		for (const nodeId of nodeIds) {
			this.runState.nodes[nodeId].status = "exhausted";
		}
		const terminal: GraphTerminalState = {
			status: "EXHAUSTED",
			limit: exhaustion.limit,
			reason: exhaustion.reason,
			round: this.runState.budget.round,
			superstep: this.runState.superstep,
			nodes: [...nodeIds],
		};
		this.runState.terminal = terminal;
		this.runState.superstep += 1;
		await this.writeCheckpoint();

		if (this.options.emitTerminal !== undefined) {
			await this.options.emitTerminal(terminal);
			return this.runState;
		}
		await appendEvent(join(this.runDirectory(), "events.jsonl"), {
			ts: new Date(this.now()).toISOString(),
			type: "loop.terminal",
			job_id: this.options.jobId,
			round: terminal.round,
			node: terminal.nodes[0] ?? "graph",
			status: terminal.status,
			reason: terminal.reason,
		});
		return this.runState;
	}

	async runSuperstep(): Promise<Readonly<GraphRunState>> {
		if (this.runState.status === "interrupted") {
			throw new Error("graph is interrupted and must be resumed");
		}
		if (this.runState.status !== "running") {
			return this.runState;
		}

		const limits = this.runState.budget.limits;
		const runExhaustion = findExhaustedRunLimit(limits, this.readBudget());
		if (runExhaustion !== undefined) {
			return this.exhaust(runExhaustion, this.runState.active);
		}

		const activeNodes = this.runState.active.map((id) => {
			const node = this.nodes.get(id);
			if (node === undefined) {
				throw new Error(`active graph node does not exist: ${id}`);
			}
			return node;
		});

		for (const node of activeNodes) {
			const nodeExhaustion = findExhaustedNodeLimit(limits, node.id, this.runState.nodes[node.id].runs);
			if (nodeExhaustion !== undefined) {
				return this.exhaust(nodeExhaustion, [node.id]);
			}
		}

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

		for (const node of activeNodes) {
			const nodeState = this.runState.nodes[node.id];
			nodeState.runs += 1;
			nodeState.status = "running";
			delete nodeState.error;
		}
		this.countRound();

		const results: NodeResult[] = [];
		for (const [index, batch] of batchReadyNodes(activeNodes, limits.maxConcurrency).entries()) {
			if (index > 0) {
				const batchExhaustion = findExhaustedRunLimit(limits, this.readBudget());
				if (batchExhaustion !== undefined) {
					// A superstep commits its writes together, so batches that already
					// ran are discarded instead of half-committed.
					return this.exhaust(
						batchExhaustion,
						activeNodes.map((node) => node.id),
					);
				}
			}
			try {
				results.push(...(await Promise.all(batch.map((node) => this.executeNode(node)))));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return this.fail(message, this.runState.active);
			}
			this.runState.budget.batches += 1;
		}

		const seenPaths = new Set<string>();
		const values = structuredClone(this.runState.values);
		for (const result of results) {
			for (const [path, value] of Object.entries(result.assignments)) {
				if (seenPaths.has(path)) {
					return this.fail(`multiple nodes wrote state path ${path} in one superstep`, this.runState.active);
				}
				seenPaths.add(path);
				setStatePath(values, path, value);
			}
		}

		const completedNodeIds = activeNodes.map((node) => node.id);
		for (const nodeId of completedNodeIds) {
			this.runState.nodes[nodeId].status = "completed";
		}
		this.readBudget();
		this.runState.values = values;
		this.runState.active = this.nextNodes(completedNodeIds, values);
		this.runState.status = this.runState.active.length === 0 ? "completed" : "running";
		this.runState.superstep += 1;
		await this.writeCheckpoint();
		return this.runState;
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

	async submitHuman(approved: boolean): Promise<Readonly<GraphRunState>> {
		const pending = this.runState.pendingHuman;
		if (this.runState.status !== "interrupted" || pending === undefined) {
			throw new Error("graph has no pending human node");
		}
		const node = this.nodes.get(pending.nodeId);
		if (node?.type !== "human") {
			throw new Error(`pending human node does not exist: ${pending.nodeId}`);
		}

		const values = structuredClone(this.runState.values);
		setStatePath(values, node.statePath, approved);
		this.runState.values = values;
		this.runState.nodes[node.id].status = "completed";
		this.runState.active = this.nextNodes([node.id], values);
		this.runState.status = this.runState.active.length === 0 ? "completed" : "running";
		delete this.runState.pendingHuman;
		this.runState.superstep += 1;
		await this.writeCheckpoint();
		return this.runState;
	}

	async resume(approved: boolean): Promise<Readonly<GraphRunState>> {
		await this.submitHuman(approved);
		return this.runUntilPause();
	}

	async resumeWithUI(ui: GraphHumanUI): Promise<Readonly<GraphRunState>> {
		const pending = this.runState.pendingHuman;
		if (pending === undefined) {
			throw new Error("graph has no pending human node");
		}
		return this.resume(await ui.confirm(pending.title, pending.question));
	}

	dispose(): void {
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
