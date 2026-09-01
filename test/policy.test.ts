import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

import {
  ensurePolicyFile,
  evaluateToolCall,
  registerPolicy,
  type PolicyConfig,
} from "../extensions/policy.ts";

const policy: PolicyConfig = {
  deny: [
    "git push",
    "git push --force",
    "git reset --hard",
    "rm -rf",
    "chmod 777",
  ],
  commit: { gated: "confirm", autopilot: "after-release" },
  unknown: { gated: "confirm", autopilot: "deny" },
};

const cwd = "/fixture";
const writeAllow = ["src/**", "test/**"];

function bash(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command },
  };
}

function write(path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "write",
    input: { path, content: "fixture" },
  };
}

function decide(event: ToolCallEvent) {
  return evaluateToolCall(event, { cwd, policy, writeAllow });
}

test("git push origin main is denied", () => {
  assert.equal(decide(bash("git push origin main")).allowed, false);
});

test("recursive forced removal is denied", () => {
  assert.equal(decide(bash("rm -rf /")).allowed, false);
  assert.equal(decide(bash("rm --recursive --force /")).allowed, false);
});

test("git status is allowed", () => {
  assert.deepEqual(decide(bash("git status")), { allowed: true });
});

test("writes to .env are denied even when the path is allowlisted", () => {
  const decision = evaluateToolCall(write("src/.env"), {
    cwd,
    policy,
    writeAllow: ["src/**"],
  });
  assert.equal(decision.allowed, false);
});

test("writes inside write_allow are allowed", () => {
  assert.deepEqual(decide(write("src/fixture.ts")), { allowed: true });
});

test("writes outside write_allow are denied", () => {
  assert.equal(decide(write("package.json")).allowed, false);
});

test("implementer tools cannot write the reviewer verdict", () => {
  const decision = evaluateToolCall(
    write("/fixture/.pi/runs/job-1/verdict.json"),
    {
      cwd,
      policy,
      writeAllow: [".pi/runs/**"],
    },
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /reserved verdict\.json for the reviewer/u);
});

test("implementer tools cannot write deterministic release approval", () => {
  const decision = evaluateToolCall(
    write("/fixture/.pi/runs/job-1/release.approved"),
    {
      cwd,
      policy,
      writeAllow: [".pi/runs/**"],
    },
  );
  assert.equal(decision.allowed, false);
  assert.match(
    decision.reason ?? "",
    /reserved release\.approved for the release\.set node/u,
  );
});

test("production deploy commands are denied", () => {
  assert.equal(decide(bash("kubectl apply -f production.yaml")).allowed, false);
  assert.equal(decide(bash("npm publish")).allowed, false);
});

test("new dependency commands are denied", () => {
  assert.equal(decide(bash("npm install left-pad")).allowed, false);
  assert.equal(decide(bash("pnpm add left-pad")).allowed, false);
});

test("the default policy is copied without replacing consumer changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-policy-"));
  try {
    const path = await ensurePolicyFile(directory);
    const copied = JSON.parse(await readFile(path, "utf8")) as PolicyConfig;
    assert.ok(copied.deny.includes("git push"));

    await writeFile(path, '{"deny":["consumer rule"]}\n');
    await ensurePolicyFile(directory);
    assert.equal(await readFile(path, "utf8"), '{"deny":["consumer rule"]}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered tool_call hook enforces resolved write bounds", async () => {
  type Hook = (
    event: ToolCallEvent,
    context: { cwd: string },
  ) => Promise<{ block?: boolean; reason?: string } | void>;

  let hook: Hook | undefined;
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "tool_call") {
        hook = handler as Hook;
      }
    },
  };
  registerPolicy(pi as unknown as Parameters<typeof registerPolicy>[0], {
    resolveWriteAllow: () => ["src/**"],
  });
  assert.ok(hook);

  const directory = await mkdtemp(join(tmpdir(), "k-pi-policy-hook-"));
  try {
    const context = { cwd: directory };
    assert.equal((await hook(bash("git push origin main"), context))?.block, true);
    assert.equal(await hook(write("src/fixture.ts"), context), undefined);
    assert.equal((await hook(write("outside.ts"), context))?.block, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
