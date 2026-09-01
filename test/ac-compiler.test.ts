import assert from "node:assert/strict";
import test from "node:test";

import {
  compileAcceptanceCriteria,
  scoreAcceptanceCriteria,
  type CompiledAcceptanceCriterion,
} from "../extensions/graph/ac-compiler.ts";

test("command and write bounds compile as executable acceptance criteria", () => {
  const result = compileAcceptanceCriteria(
    "add healthcheck; cmd pnpm test exits 0; writes only src/health.ts and tests/health.test.ts",
  );

  assert.equal(result.quality, "executable");
  assert.deepEqual(result.missingChecks, []);
  assert.deepEqual(result.acceptance[0]?.check, {
    kind: "command",
    cmd: "pnpm test",
    expect: { exit: 0 },
  });
  assert.deepEqual(result.acceptance[0]?.bounds, {
    write_allow: ["src/health.ts", "tests/health.test.ts"],
  });
});

test("labeled acceptance lines compile independently", () => {
  const result = compileAcceptanceCriteria(
    [
      "AC-01: endpoint returns 200; cmd npm test exits 0; writes only src/server.js",
      "AC-02: body is healthy; cmd npm test exits 0; writes only src/server.js",
    ].join("\n"),
  );

  assert.equal(result.quality, "executable");
  assert.deepEqual(
    result.acceptance.map((criterion) => criterion.id),
    ["AC-01", "AC-02"],
  );
});

test("narrative requests remain narrative", () => {
  const result = compileAcceptanceCriteria("make auth nicer");

  assert.equal(result.quality, "narrative");
  assert.deepEqual(result.missingChecks, [
    {
      id: "AC-01",
      statement: "make auth nicer",
      missing: ["check", "bounds"],
    },
  ]);
});

test("mixed acceptance criteria are partial and identify missing checks", () => {
  const complete: CompiledAcceptanceCriterion = {
    id: "AC-01",
    statement: "tests pass within the allowed files",
    required: true,
    check: {
      kind: "command",
      cmd: "pnpm test",
      expect: { exit: 0 },
    },
    bounds: { write_allow: ["src/**", "test/**"] },
  };
  const unchecked: CompiledAcceptanceCriterion = {
    id: "AC-02",
    statement: "make auth nicer",
    required: true,
    bounds: { write_allow: ["src/auth.ts"] },
  };

  assert.deepEqual(scoreAcceptanceCriteria([complete, unchecked]), {
    quality: "partial",
    missingChecks: [
      {
        id: "AC-02",
        statement: "make auth nicer",
        missing: ["check"],
      },
    ],
  });
});
