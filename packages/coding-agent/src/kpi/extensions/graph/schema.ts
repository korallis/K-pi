export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GraphNodeType = "agent" | "set" | "human";
export type AgentContextMode = "isolated" | "thread";

export interface AgentResponseContract {
	path: string;
	schema: string;
	retries: number;
	state: Record<string, string>;
}

export interface AgentGraphNode {
	id: string;
	type: "agent";
	prompt: string;
	context: {
		mode: AgentContextMode;
		threadKey?: string;
	};
	tools: string[];
	readOnly: boolean;
	response?: AgentResponseContract;
}

export interface SetGraphNode {
	id: string;
	type: "set";
	assignments: Record<string, JsonValue>;
}

export interface HumanGraphNode {
	id: string;
	type: "human";
	title: string;
	question: string;
	statePath: string;
}

export type GraphNode = AgentGraphNode | SetGraphNode | HumanGraphNode;

export interface GraphCondition {
	path: string;
	equals: JsonValue;
}

export interface GraphEdge {
	from: string;
	to: string;
	when?: GraphCondition;
}

export interface GraphLimits {
	maxSteps: number;
	maxNodeRuns: number;
	maxConcurrency: number;
	maxCostUsd: number;
	timeoutMs: number;
}

/**
 * Graph limits plus the round cap. A graph file does not carry `maxRounds`
 * because a round belongs to the job contract, not to the topology.
 */
export interface GraphBudgetLimits extends GraphLimits {
	maxRounds: number;
}

/** The caps a validated task/job contract may override. */
export type GraphBudgetOverrides = Partial<GraphBudgetLimits>;

/** Every cap whose exhaustion is the product terminal `EXHAUSTED`. */
export const BUDGET_LIMIT_NAMES = ["maxSteps", "maxNodeRuns", "maxRounds", "maxCostUsd", "timeoutMs"] as const;

export type BudgetLimitName = (typeof BUDGET_LIMIT_NAMES)[number];

export interface GraphPolicy {
	allowNonInteractive: boolean;
	allowNonInteractiveMutations: boolean;
	confirmProjectGraph: boolean;
	confirmMutatingNodes: boolean;
}

export interface GraphDefinition {
	schemaVersion: 2;
	id: string;
	entry: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	limits: GraphLimits;
	policy: GraphPolicy;
}

export type GraphRunStatus = "running" | "interrupted" | "completed" | "failed" | "exhausted";

export type GraphNodeRunStatus = "pending" | "running" | "completed" | "interrupted" | "failed" | "exhausted";

export interface GraphNodeRunState {
	status: GraphNodeRunStatus;
	runs: number;
	sessionId?: string;
	error?: string;
}

export interface PendingHumanInput {
	nodeId: string;
	title: string;
	question: string;
}

/**
 * Durable budget counters. Every field survives a checkpoint so a resumed run
 * keeps its clock, its spend, and its round instead of restarting them.
 */
export interface GraphBudgetState {
	limits: GraphBudgetLimits;
	/** Epoch ms the run started, read from the injected clock. */
	startedAtMs: number;
	/** Elapsed wall time at the last budget reading. */
	elapsedMs: number;
	/** Accumulated job cost in USD at the last budget reading. */
	costUsd: number;
	/** Completed rounds: how many times the busiest node has run. */
	round: number;
	/** Bounded batches executed across every superstep. */
	batches: number;
}

/** The one durable product terminal the engine itself can reach. */
export interface GraphTerminalState {
	status: "EXHAUSTED";
	limit: BudgetLimitName;
	reason: string;
	round: number;
	superstep: number;
	/** The nodes the exhausted superstep was holding. */
	nodes: string[];
}

export interface GraphRunState {
	graphId: string;
	jobId: string;
	status: GraphRunStatus;
	superstep: number;
	active: string[];
	values: JsonObject;
	nodes: Record<string, GraphNodeRunState>;
	pendingHuman?: PendingHumanInput;
	budget: GraphBudgetState;
	/** Written exactly once, when a cap ends the run. */
	terminal?: GraphTerminalState;
}
