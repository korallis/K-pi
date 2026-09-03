import type { LoopRecovery } from "../run-store.ts";
import type { TransientReason } from "./stop.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GraphNodeType = "agent" | "set" | "human" | "pause";
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
	/**
	 * State path a human gate writes the operator's change request to. When the
	 * run state holds a non-empty string there, it is appended to this node's
	 * prompt, so a re-run in an isolated session still sees what to change.
	 */
	feedbackPath?: string;
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
	/**
	 * The run file whose summary the driver shows with the question. Only
	 * stack.json has a renderer, so only it is allowed here; a second file widens
	 * this union together with its renderer.
	 */
	detail?: "stack.json";
	/**
	 * State path the operator's change request is written to on denial. A gate
	 * with one requires non-empty feedback to deny; one without takes none.
	 */
	feedbackPath?: string;
}

/** What the operator answered at a human gate. */
export interface HumanAnswer {
	approved: boolean;
	/** The change request, required to deny a gate with a feedbackPath. */
	feedback?: string;
}

/**
 * A parking spot the topology routes to when the loop needs the operator. The
 * run pauses NEEDS_HUMAN with the stated recovery, and `/kpi <job>` continues
 * at `resume`. Having it as a node keeps the branch in graph data: why a run
 * paused, and where it picks up, are readable in the topology instead of
 * buried in the driver.
 */
export interface PauseGraphNode {
	id: string;
	type: "pause";
	recovery: LoopRecovery;
	reason: string;
	/** The nodes a resume schedules; each is an existing non-pause node. */
	resume: string[];
}

export type GraphNode = AgentGraphNode | SetGraphNode | HumanGraphNode | PauseGraphNode;

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

/**
 * The only limit a graph carries. K-π runs have no caps: cost, time, steps and
 * node runs are reported, never enforced, so a checkpoint from a release that
 * still enforced them is read with those keys ignored.
 */
export interface GraphLimits {
	maxConcurrency: number;
}

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
 * `paused` is a topology-chosen park: the run stopped because an edge said the
 * operator is needed, not because it finished or crashed. A resume re-arms it.
 */
export type GraphRunStatus = "running" | "interrupted" | "completed" | "paused";

export type GraphNodeRunStatus = "pending" | "running" | "completed" | "interrupted" | "failed";

export interface GraphNodeRunState {
	status: GraphNodeRunStatus;
	runs: number;
	sessionId?: string;
	/** Background worker agent id when this node ran via the bus. */
	agentId?: string;
	error?: string;
	/**
	 * Transient retries already spent on this run of the node. Unbounded, and
	 * durable on purpose: a kill during a backoff resumes with the count it had.
	 */
	transientRetries?: number;
	/**
	 * The `runs` value those retries belong to. Retries are same-run, so a new
	 * legitimate run counts from zero while a resumed run keeps its count and
	 * its place in the backoff sequence.
	 */
	retryRun?: number;
	/** The backoff actually waited on this node, in order. */
	retryDelaysMs?: number[];
	/** Why the current backoff is being waited. */
	retryReason?: TransientReason;
	/** Epoch ms the current backoff ends; a resume sleeps the remainder. */
	retryAtMs?: number;
}

export interface PendingHumanInput {
	nodeId: string;
	title: string;
	question: string;
}

/**
 * Durable counters. Every field survives a checkpoint so a resumed run keeps
 * its clock, its spend, and its round instead of restarting them. None of
 * them ends a run: they are what the board reports.
 */
export interface GraphBudgetState {
	limits: GraphLimits;
	/** Epoch ms the run started, read from the injected clock. */
	startedAtMs: number;
	/** Elapsed wall time at the last reading. */
	elapsedMs: number;
	/** Accumulated job cost in USD at the last reading. */
	costUsd: number;
	/** Completed rounds: how many times the busiest node has run. */
	round: number;
	/** Bounded batches executed across every superstep. */
	batches: number;
}

/**
 * The durable record of why a run paused: a pause node the topology routed to,
 * or a contract defect the engine refused to continue past. Written exactly
 * once per pause; a resume re-arms `resume`.
 */
export interface GraphPauseState {
	recovery: LoopRecovery;
	reason: string;
	round: number;
	superstep: number;
	/** The nodes the pause names: the pause node, or the nodes that failed. */
	nodes: string[];
	/** The nodes a resume schedules. */
	resume: string[];
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
	/** Present exactly while the run is paused. */
	pause?: GraphPauseState;
}
