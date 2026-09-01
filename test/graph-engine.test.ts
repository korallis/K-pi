import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GraphEngine,
  loadNamedGraph,
  type GraphAgentSessionFactory,
} from "../extensions/graph/engine.ts";
import type {
  AgentGraphNode,
  GraphDefinition,
  GraphEdge,
  GraphNode,
} from "../extensions/graph/schema.ts";

const limits = {
  maxSteps: 12,
  maxNodeRuns: 16,
  maxConcurrency: 2,
  maxCostUsd: 5,
  timeoutMs: 1_800_000,
};

const policy = {
  allowNonInteractive: false,
  allowNonInteractiveMutations: false,
  confirmProjectGraph: true,
  confirmMutatingNodes: true,
};

function graph(
  id: string,
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
): GraphDefinition {
  return {
    schemaVersion: 2,
    id,
    entry: nodes[0]?.id ?? "missing",
    nodes,
    edges,
    limits,
    policy,
  };
}

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "k-pi-graph-"));
}

test("set nodes write nested state and checkpoint the superstep", async () => {
  const projectRoot = await fixture();
  try {
    const engine = new GraphEngine(
      graph("set-test", [
        {
          id: "release",
          type: "set",
          assignments: { "release.approved": true },
        },
      ]),
      { projectRoot, jobId: "set-job" },
    );

    const state = await engine.runUntilPause();
    assert.equal(state.status, "completed");
    assert.deepEqual(state.values, { release: { approved: true } });
    assert.deepEqual(
      await readdir(join(projectRoot, ".pi", "runs", "set-job", "graph")),
      ["checkpoint-000001.json"],
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("human nodes pause and a restored true response continues", async () => {
  const projectRoot = await fixture();
  const definition = graph(
    "human-test",
    [
      {
        id: "approval",
        type: "human",
        title: "Approve",
        question: "Continue?",
        statePath: "release.approved",
      },
      {
        id: "continued",
        type: "set",
        assignments: { continued: true },
      },
    ],
    [
      {
        from: "approval",
        to: "continued",
        when: { path: "release.approved", equals: true },
      },
      {
        from: "approval",
        to: "__end__",
        when: { path: "release.approved", equals: false },
      },
    ],
  );

  try {
    const engine = new GraphEngine(definition, {
      projectRoot,
      jobId: "human-job",
    });
    const paused = await engine.runUntilPause();
    assert.equal(paused.status, "interrupted");
    assert.equal(paused.pendingHuman?.nodeId, "approval");

    const restored = await GraphEngine.restore(definition, {
      projectRoot,
      jobId: "human-job",
    });
    const completed = await restored.resume(true);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.values, {
      release: { approved: true },
      continued: true,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("reviewer sessions are persisted separately from the coder thread", async () => {
  const projectRoot = await fixture();
  const calls: Parameters<GraphAgentSessionFactory>[0][] = [];
  let sessionNumber = 0;
  const createSession: GraphAgentSessionFactory = async (options) => {
    calls.push(options);
    sessionNumber += 1;
    return {
      session: {
        sessionId: `session-${sessionNumber}`,
        async prompt() {},
        getActiveToolNames: () => [...(options.tools ?? [])],
        dispose() {},
      },
    };
  };
  const coder: AgentGraphNode = {
    id: "implement",
    type: "agent",
    prompt: "implement",
    context: { mode: "thread", threadKey: "coder" },
    tools: ["read", "write"],
    readOnly: false,
  };
  const reviewer: AgentGraphNode = {
    id: "review",
    type: "agent",
    prompt: "review",
    context: { mode: "isolated" },
    tools: ["read"],
    readOnly: true,
  };

  try {
    const engine = new GraphEngine(
      graph("session-test", [coder, reviewer], [
        { from: "implement", to: "review" },
      ]),
      {
        projectRoot,
        jobId: "session-job",
        createAgentSession: createSession,
      },
    );
    const state = await engine.runUntilPause();

    assert.equal(state.status, "completed");
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0]?.sessionManager, calls[1]?.sessionManager);
    assert.equal(calls[0]?.sessionManager?.isPersisted(), true);
    assert.equal(calls[1]?.sessionManager?.isPersisted(), true);
    assert.notEqual(
      state.nodes.implement.sessionId,
      state.nodes.review.sessionId,
    );
    engine.dispose();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("read-only agents reject write tools registered by their session", async () => {
  const projectRoot = await fixture();
  let prompted = false;
  const createSession: GraphAgentSessionFactory = async () => ({
    session: {
      sessionId: "unsafe-session",
      async prompt() {
        prompted = true;
      },
      getActiveToolNames: () => ["read", "write"],
      dispose() {},
    },
  });

  try {
    const engine = new GraphEngine(
      graph("read-only-test", [
        {
          id: "review",
          type: "agent",
          prompt: "review",
          context: { mode: "isolated" },
          tools: ["read"],
          readOnly: true,
        },
      ]),
      {
        projectRoot,
        jobId: "read-only-job",
        createAgentSession: createSession,
      },
    );

    await assert.rejects(
      engine.runSuperstep(),
      /read-only agent node review registered forbidden tool write/,
    );
    assert.equal(prompted, false);
    assert.equal(engine.state.status, "failed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the packaged gated graph loads as schema version 2", async () => {
  const projectRoot = await fixture();
  try {
    const definition = await loadNamedGraph(projectRoot, "coding-loop.gated");
    assert.equal(definition.schemaVersion, 2);
    assert.equal(definition.entry, "ac-compiler");
    assert.ok(definition.nodes.some((node) => node.id === "human"));
    assert.equal(definition.policy.allowNonInteractive, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
