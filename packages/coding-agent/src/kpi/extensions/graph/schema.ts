export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GraphNodeType = "agent" | "set" | "human" | "terminal";
export type AgentContextMode = "isolated" | "thread";

export interface AgentResponseContract {
	path: string;
	schema: string;
	retries: number;
	state: Record<string, string>;
}

/**
 * Optional RP-13 worker role. When set, the graph engine spawns a background
 * worker instead of an in-process session and collects a receipt-backed contract
 * file rather than parsing assistant transcript.
 */
export type AgentWorkerRole = "reviewer";

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
	/** When set, run as an RP-13 background worker of this role. */
	workerRole?: AgentWorkerRole;
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

/**
 * A product terminal the topology itself routes to. `EXHAUSTED` is not one of
 * these: a cap is crossed by the engine, never chosen by an edge, and `DONE`
 * belongs to a completed release rather than a branch.
 */
export type GraphRoutedTerminal = "UNSAFE" | "NEEDS_HUMAN" | "BLOCKED" | "NO_PROGRESS";

export const GRAPH_ROUTED_TERMINALS: readonly GraphRoutedTerminal[] = [
	"UNSAFE",
	"NEEDS_HUMAN",
	"BLOCKED",
	"NO_PROGRESS",
];

/**
 * A sink that ends the run with a stated product terminal. Having it as a node
 * keeps the branch in graph data: the reason a run stopped is readable in the
 * topology instead of buried in the driver.
 */
export interface TerminalGraphNode {
	id: string;
	type: "terminal";
	status: GraphRoutedTerminal;
	reason: string;
}

export type GraphNode = AgentGraphNode | SetGraphNode | HumanGraphNode | TerminalGraphNode;

export interface GraphCondition {
	path: string;
	equals: JsonValue;
}

export interface GraphEdge {
	from: string;
	to: string;
	/** A list is a conjunction: every condition must hold for the edge to fire. */
	when?: GraphCondition | GraphCondition[];
}

export interface GraphLimits {
	maxSteps: number;
	maxNodeRuns: number;
	maxConcurrency: number;
	maxCostUsd: number;
	timeoutMs: number;
}

/**
 * Graph limits plus the caps a graph file does not carry: a round and a
 * transient-retry allowance both belong to the job contract, not the topology.
 */
export interface GraphBudgetLimits extends GraphLimits {
	maxRounds: number;
	/** Transient transport/429/timeout retries allowed per node. */
	maxTransientRetries: number;
}

/** The caps a validated task/job contract may override. */
export type GraphBudgetOverrides = Partial<GraphBudgetLimits>;

/** Every cap whose exhaustion is the product terminal `EXHAUSTED`. */
export const BUDGET_LIMIT_NAMES = [
	"maxSteps",
	"maxNodeRuns",
	"maxRounds",
	"maxCostUsd",
	"timeoutMs",
	"maxTransientRetries",
] as const;

export type BudgetLimitName = (typeof BUDGET_LIMIT_NAMES)[number];

export interface GraphPolicy {
	allowNonInteractive: boolean;
	allowNonInteractiveMutations: boolean;
	confirmProjectGraph: boolean;
	confirmMutatingNodes: boolean;
	/**
	 * What a denied human release does. Seeded into run state as
	 * `policy.onHumanDeny`, so the branch is an edge condition rather than a
	 * decision the driver makes on the graph's behalf.
	 */
	onHumanDeny?: "revise" | "end";
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

/**
 * `terminated` is a topology-chosen product terminal: the run stopped because an
 * edge said so, not because it finished, crashed, or spent a cap.
 */
export type GraphRunStatus = "running" | "interrupted" | "completed" | "failed" | "exhausted" | "terminated";

export type GraphNodeRunStatus = "pending" | "running" | "completed" | "interrupted" | "failed" | "exhausted";

export interface GraphNodeRunState {
	status: GraphNodeRunStatus;
	runs: number;
	sessionId?: string;
	/** Background worker agent id when this node ran via the bus. */
	agentId?: string;
	error?: string;
	/**
	 * Transient retries already spent on this node. Durable on purpose: a kill
	 * during a backoff must not hand the node a fresh allowance on resume.
	 */
	transientRetries?: number;
	/**
	 * The `runs` value those retries belong to. Retries are same-run, so a new
	 * legitimate run gets a fresh allowance while a resumed run keeps what it
	 * spent. Without this key the allowance would be lifetime-per-node.
	 */
	retryRun?: number;
	/** The backoff actually waited on this node, in order. */
	retryDelaysMs?: number[];
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

/**
 * The durable product terminal a run reached: a cap the engine crossed, or a
 * terminal node the topology routed to. Written exactly once either way.
 */
export interface GraphTerminalState {
	status: "EXHAUSTED" | GraphRoutedTerminal;
	/** Only a cap has one. */
	limit?: BudgetLimitName;
	reason: string;
	round: number;
	superstep: number;
	/** The nodes the stopped superstep was holding. */
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
