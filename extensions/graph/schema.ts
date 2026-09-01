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

export type GraphRunStatus =
  | "running"
  | "interrupted"
  | "completed"
  | "failed";

export type GraphNodeRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "interrupted"
  | "failed";

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

export interface GraphRunState {
  graphId: string;
  jobId: string;
  status: GraphRunStatus;
  superstep: number;
  active: string[];
  values: JsonObject;
  nodes: Record<string, GraphNodeRunState>;
  pendingHuman?: PendingHumanInput;
}
