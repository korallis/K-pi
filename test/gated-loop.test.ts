import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { registerControlPlane } from "../extensions/control-plane.ts";
import {
  CONVENTIONAL_COMMIT_PATTERN,
  verifyShippedCommit,
} from "../extensions/gated-loop.ts";
import {
  GraphEngine,
  type GraphAgentSessionFactory,
} from "../extensions/graph/engine.ts";
import type { GraphDefinition } from "../extensions/graph/schema.ts";

const execFile = promisify(execFileCallback);
const fixtureSource = fileURLToPath(
  new URL("../fixtures/healthcheck-gated/", import.meta.url),
);
const validVerdict = JSON.stringify({
  status: "PASS",
  approved: true,
  blockingIssues: [],
  nonBlockingIssues: [],
  evidence: ["evidence.json"],
  round: 1,
  output_fingerprint: `sha256:${"a".repeat(64)}`,
});
const commandEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
};
delete commandEnvironment.NODE_TEST_CONTEXT;
const implementedServer = `import { createServer } from "node:http";

export function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
}

export function createApp() {
  return createServer(handleRequest);
}
`;

type CommandHandler = (
  args: string,
  context: ExtensionCommandContext,
) => Promise<void>;

async function git(directory: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: directory });
  return stdout.trim();
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-gated-"));
  await rm(directory, { recursive: true, force: true });
  await cp(fixtureSource, directory, { recursive: true });
  await git(directory, "init");
  await git(directory, "config", "user.email", "fixture@example.test");
  await git(directory, "config", "user.name", "Fixture");
  await git(directory, "add", "-A");
  await git(directory, "commit", "-m", "chore: seed fixture");
  return directory;
}

function nodeId(prompt: string): string {
  if (prompt.includes("Check the frozen task")) return "ac-compiler";
  if (prompt.includes("spec-first skill")) return "specify";
  if (prompt.includes("implementation plan and stack.json")) return "plan";
  if (prompt.includes("frozen plan still matches")) return "plan-check";
  if (prompt.includes("tdd-cycle skill")) return "implement";
  if (prompt.includes("quality-gates skill")) return "test";
  if (prompt.includes("isolated-review skill")) return "review";
  if (prompt.includes("conventional-commit skill")) return "ship";
  return "retry";
}

function loopSessions(
  directory: string,
  executed: string[],
  options: { validateCommands?: boolean; reviewResponses?: string[] } = {},
): GraphAgentSessionFactory {
  let sessionNumber = 0;
  let reviewAttempt = 0;
  return async (sessionOptions) => {
  let implementationAttempt = 0;
    sessionNumber += 1;
    let currentNode = "";
    let lastAssistantText: string | undefined;
    return {
      session: {
        sessionId: `fixture-session-${sessionNumber}`,
        async prompt(prompt) {
          const detected = nodeId(prompt);
          if (detected !== "retry") currentNode = detected;
          executed.push(currentNode || detected);

          if (currentNode === "implement") {
            if (
              options.validateCommands === true &&
              implementationAttempt === 0
            ) {
              await assert.rejects(
                execFile("npm", ["test"], {
                  cwd: directory,
                  env: commandEnvironment,
                }),
              );
            }
            implementationAttempt += 1;
            await writeFile(join(directory, "src", "server.js"), implementedServer);
          } else if (currentNode === "test") {
            if (options.validateCommands === true) {
              await execFile("npm", ["test"], {
                cwd: directory,
                env: commandEnvironment,
              });
              await execFile("npm", ["run", "lint"], {
                cwd: directory,
                env: commandEnvironment,
              });
            }
            lastAssistantText = JSON.stringify({
              head: await git(directory, "rev-parse", "HEAD"),
              commands: [
                { cmd: "npm test", exit: 1, excerpt: "expected 200, received 404" },
                { cmd: "npm test", exit: 0, excerpt: "pass 1" },
                { cmd: "npm run lint", exit: 0 },
              ],
              ac_results: [{ id: "AC-01", passed: true }],
            });
          } else if (currentNode === "review") {
            lastAssistantText =
              options.reviewResponses?.[reviewAttempt] ?? validVerdict;
            reviewAttempt += 1;
          } else if (currentNode === "ship") {
            await git(directory, "add", "-A");
            await git(directory, "commit", "-m", "feat(health): add healthcheck endpoint");
          }
        },
        getLastAssistantText: () => lastAssistantText,
        getActiveToolNames: () => [...(sessionOptions.tools ?? [])],
        dispose() {},
      },
    };
  };
}

function commandHarness(
  directory: string,
  factory: GraphAgentSessionFactory,
  jobId: string,
  confirmations: string[],
): {
  commands: Map<string, CommandHandler>;
  context: ExtensionCommandContext;
  notifications: string[];
} {
  const commands = new Map<string, CommandHandler>();
  const notifications: string[] = [];
  const pi = {
    on() {},
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
  };
  registerControlPlane(
    pi as unknown as Parameters<typeof registerControlPlane>[0],
    { createAgentSession: factory, jobId },
  );
  const context = {
    cwd: directory,
    hasUI: true,
    mode: "tui",
    ui: {
      async confirm(title: string) {
        confirmations.push(title);
        return true;
      },
      notify(message: string) {
        notifications.push(message);
      },
      setWidget() {},
    },
  } as unknown as ExtensionCommandContext;
  return { commands, context, notifications };
}

async function latestCheckpoint(
  directory: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const graphDirectory = join(directory, ".pi", "runs", jobId, "graph");
  const names = (await readdir(graphDirectory)).sort();
  return JSON.parse(
    await readFile(join(graphDirectory, names.at(-1)!), "utf8"),
  ) as Record<string, unknown>;
}

test("loop on healthcheck fixture reaches human confirm with green gates", async () => {
  const directory = await fixture();
  const jobId = "20260831-healthcheck-gated";
  const executed: string[] = [];
  const confirmations: string[] = [];
  try {
    assert.ok(
      (await readFile(join(directory, "test", "health.test.js"), "utf8")).includes(
        "GET /health",
      ),
    );
    const task = await readFile(join(directory, "task.txt"), "utf8");
    const red = await execFile("npm", ["test"], {
      cwd: directory,
      env: commandEnvironment,
    }).then(
      (result) => ({ failed: false, output: result.stdout }),
      (error: { stdout?: string }) => ({ failed: true, output: error.stdout ?? "" }),
    );
    assert.equal(red.failed, true, red.output);
    const harness = commandHarness(
      directory,
      loopSessions(directory, executed, { validateCommands: true }),
      jobId,
      confirmations,
    );

    await harness.commands.get("loop")!(task, harness.context);
    assert.equal(
      harness.notifications.some((message) => message.includes("failed")),
      false,
      `${harness.notifications.join("\n")}\nexecuted: ${executed.join(", ")}`,
    );

    assert.deepEqual(confirmations, ["Approve gated release"]);
    assert.ok(executed.includes("specify"));
    const state = JSON.parse(
      await readFile(join(directory, ".pi", "runs", jobId, "state.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(state.status, "DONE");
    assert.equal(state.passed, true);
    assert.deepEqual(state.bounds, { held: true });
    assert.match(await git(directory, "log", "-1", "--pretty=%s"), CONVENTIONAL_COMMIT_PATTERN);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("kpi --plan freezes and hashes plan files without executing specify", async () => {
  const directory = await fixture();
  const jobId = "20260831-healthcheck-plan";
  const executed: string[] = [];
  try {
    const harness = commandHarness(
      directory,
      loopSessions(directory, executed),
      jobId,
      [],
    );

    await harness.commands.get("kpi")!("--plan specs/healthcheck", harness.context);

    assert.ok(executed.includes("plan-check"));
    assert.equal(executed.includes("specify"), false);
    const checkpoint = await latestCheckpoint(directory, jobId);
    const nodes = checkpoint.nodes as Record<string, { runs: number }>;
    assert.equal(nodes.specify.runs, 0);
    for (const name of ["requirements.md", "design.md", "tasks.md"]) {
      assert.ok(
        (await readFile(join(directory, ".pi", "runs", jobId, "plan", name), "utf8"))
          .length > 0,
      );
    }
    const fingerprints = JSON.parse(
      await readFile(
        join(directory, ".pi", "runs", jobId, "fingerprints.json"),
        "utf8",
      ),
    ) as { plan: Record<string, string> };
    assert.deepEqual(Object.keys(fingerprints.plan).sort(), [
      "plan/design.md",
      "plan/requirements.md",
      "plan/tasks.md",
    ]);
    assert.ok(Object.values(fingerprints.plan).every((hash) => /^sha256:[0-9a-f]{64}$/u.test(hash)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reviewer output retries until it validates against verdict schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-review-response-"));
  const prompts: string[] = [];
  const responses = [JSON.stringify({ approved: true }), validVerdict];
  let responseIndex = 0;
  const factory: GraphAgentSessionFactory = async (options) => {
    let last: string | undefined;
    return {
      session: {
        sessionId: "review-session",
        async prompt(prompt) {
          prompts.push(prompt);
          last = responses[responseIndex];
          responseIndex += 1;
        },
        getLastAssistantText: () => last,
        getActiveToolNames: () => [...(options.tools ?? [])],
        dispose() {},
      },
    };
  };
  const graph: GraphDefinition = {
    schemaVersion: 2,
    id: "review-contract",
    entry: "review",
    nodes: [
      {
        id: "review",
        type: "agent",
        prompt: "Review candidate",
        context: { mode: "isolated" },
        tools: ["read"],
        readOnly: true,
        response: {
          path: "verdict.json",
          schema: "verdict.schema.json",
          retries: 2,
          state: { "review.approved": "approved" },
        },
      },
    ],
    edges: [{ from: "review", to: "__end__" }],
    limits: {
      maxSteps: 3,
      maxNodeRuns: 3,
      maxConcurrency: 1,
      maxCostUsd: 1,
      timeoutMs: 10_000,
    },
    policy: {
      allowNonInteractive: false,
      allowNonInteractiveMutations: false,
      confirmProjectGraph: true,
      confirmMutatingNodes: true,
    },
  };

  try {
    const engine = new GraphEngine(graph, {
      projectRoot: directory,
      jobId: "review-job",
      createAgentSession: factory,
    });
    const state = await engine.runUntilPause();

    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /failed verdict\.schema\.json/u);
    assert.deepEqual(state.values.review, { approved: true });
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(directory, ".pi", "runs", "review-job", "verdict.json"),
          "utf8",
        ),
      ),
      JSON.parse(validVerdict),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ship commit subject matches the conventional commit contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-ship-"));
  try {
    await git(directory, "init");
    await git(directory, "config", "user.email", "fixture@example.test");
    await git(directory, "config", "user.name", "Fixture");
    await writeFile(join(directory, "file.txt"), "seed\n");
    await git(directory, "add", "file.txt");
    await git(directory, "commit", "-m", "chore: seed");
    const previousHead = await git(directory, "rev-parse", "HEAD");
    await writeFile(join(directory, "file.txt"), "changed\n");
    await git(directory, "add", "file.txt");
    await git(directory, "commit", "-m", "fix(ship): validate commit subject");

    const subject = await verifyShippedCommit(directory, previousHead);
    assert.equal(subject, "fix(ship): validate commit subject");
    assert.match(subject, CONVENTIONAL_COMMIT_PATTERN);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
