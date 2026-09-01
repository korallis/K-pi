import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);

const forbiddenDependencies = [
  "oh-my-pi",
  "pi-status-bar",
  "pi-vitals",
  "pi-powerline-footer",
  "atomic",
  "pi-graph",
  "pi-multi-account",
  "pi-multi-pass",
  "pi-cursor-oauth",
  "pi-cursor-provider",
  "exa-js",
  "@perplexity-ai/perplexity_ai",
  "pstack",
  "open-pstack",
  "pi-pstack",
  "pi-intercom",
  "pi-mesh",
  "pi-agents-talk-to-each-other",
  "pi-bus",
  "pi-side-agents",
] as const;

type Manifest = {
  version?: string;
  keywords?: string[];
  files?: string[];
  dependencies?: Record<string, string>;
  pi?: Record<string, string[]>;
};

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(new URL("package.json", repoRoot), "utf8")) as Manifest;
}

test("package manifest exposes the Pi package contract", async () => {
  const manifest = await readManifest();

  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi, {
    extensions: ["./extensions"],
    skills: ["./skills", "./kstack/generated/skills"],
    prompts: ["./prompts"],
    themes: ["./themes"],
  });

  for (const name of forbiddenDependencies) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
  }
});

/**
 * Exact `package.json#files` allowlist: runtime resources plus K-stack provenance.
 * Widened to `readonly string[]` because the literal tuple type would turn every
 * comparison against another literal list into a compile-time "no overlap" error
 * instead of the runtime check these tests exist to perform.
 */
const publishAllowlist: readonly string[] = [
  "README.md",
  "AGENTS.md",
  "extensions/",
  "graphs/",
  "prompts/",
  "schemas/",
  "skills/",
  "templates/",
  "themes/",
  "kstack/generated/",
  "kstack/overlay/",
  "kstack/mode.ts",
  "kstack/models.ts",
  "kstack/NOTICE",
  "kstack/UPSTREAM.md",
];

/**
 * Maintainer trees, local state, and the hand-written K-stack inputs that compete with
 * `kstack/generated/`, which is the sole runtime truth.
 */
const excludedPublishPaths: readonly string[] = [
  "docs/",
  "test/",
  "fixtures/",
  "design/",
  ".pi/",
  ".github/",
  "kstack/upstream/",
  "kstack/scripts/",
  "kstack/playbooks/",
  "kstack/k-agent.md",
  "kstack/principles.md",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
];

/**
 * Every path the published tarball is meant to contain, sorted, each listed once.
 * `package.json` is here because npm always ships the manifest and it cannot be declared
 * through `files`; every other entry is covered by a root in `publishAllowlist`.
 *
 * This literal is the oracle, and it is deliberately hand-maintained: nothing in it is
 * derived from the working tree or from `npm pack` output, so a new file dropped inside an
 * already allowlisted root - a maintainer note under `extensions/`, a scratch fixture under
 * `skills/` - fails the payload test until someone either lists it here on purpose or keeps
 * it out of the package. Deleting a shipped resource fails the same way.
 */
const expectedPublishedFiles: readonly string[] = [
  "AGENTS.md",
  "README.md",
  "extensions/accounts/balancer.ts",
  "extensions/accounts/errors.ts",
  "extensions/accounts/index.ts",
  "extensions/accounts/store.ts",
  "extensions/accounts/usage/anthropic.ts",
  "extensions/accounts/usage/cursor.ts",
  "extensions/accounts/usage/openai-codex.ts",
  "extensions/accounts/usage/types.ts",
  "extensions/accounts/usage/xai.ts",
  "extensions/accounts/widget.ts",
  "extensions/append-log.ts",
  "extensions/auto-wrap.ts",
  "extensions/bus/communicate.ts",
  "extensions/bus/spawn.ts",
  "extensions/control-plane.ts",
  "extensions/cursor/oauth.ts",
  "extensions/cursor/provider.ts",
  "extensions/gated-loop.ts",
  "extensions/graph/ac-compiler.ts",
  "extensions/graph/engine.ts",
  "extensions/graph/json-schema.ts",
  "extensions/graph/schema.ts",
  "extensions/graph/stop.ts",
  "extensions/index.ts",
  "extensions/kg/index.ts",
  "extensions/kg/store.ts",
  "extensions/minimalist.ts",
  "extensions/ping.ts",
  "extensions/policy.ts",
  "extensions/print-profile.ts",
  "extensions/renderers.ts",
  "extensions/research/exa.ts",
  "extensions/research/gate.ts",
  "extensions/research/index.ts",
  "extensions/research/perplexity.ts",
  "extensions/research/setup.ts",
  "extensions/run-store.ts",
  "extensions/settings.ts",
  "extensions/stack.ts",
  "extensions/status-line/brand.ts",
  "extensions/status-line/index.ts",
  "extensions/status-line/segments.ts",
  "graphs/coding-loop.auto.json",
  "graphs/coding-loop.gated.json",
  "graphs/spec-first.json",
  "kstack/NOTICE",
  "kstack/UPSTREAM.md",
  "kstack/generated/.cursor-plugin/plugin.json",
  "kstack/generated/LICENSE",
  "kstack/generated/README.md",
  "kstack/generated/agents/comment-sicko.md",
  "kstack/generated/agents/k-agent.md",
  "kstack/generated/automations/benny/FOR_AGENTS.md",
  "kstack/generated/automations/benny/README.md",
  "kstack/generated/automations/benny/skills/reproduce-and-fix-issues/SKILL.md",
  "kstack/generated/automations/benny/skills/reproduce-and-fix-issues/references/control-adapter.md",
  "kstack/generated/automations/benny/skills/reproduce-and-fix-issues/references/feature-map.example.md",
  "kstack/generated/automations/benny/skills/reproduce-and-fix-issues/references/verify-existing-fix.md",
  "kstack/generated/automations/benny/skills/setup-benny/SKILL.md",
  "kstack/generated/automations/benny/skills/triage-issue-reports/SKILL.md",
  "kstack/generated/automations/benny/skills/triage-issue-reports/references/routing.example.md",
  "kstack/generated/automations/benny/templates/configuration.example.yaml",
  "kstack/generated/automations/benny/templates/reproduce-automation-prompt.md",
  "kstack/generated/automations/benny/templates/triage-automation-prompt.md",
  "kstack/generated/docs/guide/01-setup.md",
  "kstack/generated/docs/guide/02-k-mode.md",
  "kstack/generated/docs/guide/03-understand.md",
  "kstack/generated/docs/guide/04-design.md",
  "kstack/generated/docs/guide/05-build-and-clean.md",
  "kstack/generated/docs/guide/06-verify-and-ship.md",
  "kstack/generated/docs/guide/07-overnight.md",
  "kstack/generated/docs/guide/08-principles.md",
  "kstack/generated/docs/guide/09-make-it-yours.md",
  "kstack/generated/docs/guide/10-recipes-and-pitfalls.md",
  "kstack/generated/docs/guide/README.md",
  "kstack/generated/docs/guide/images/design.jpg",
  "kstack/generated/docs/guide/images/overnight.jpg",
  "kstack/generated/docs/guide/images/recipes.jpg",
  "kstack/generated/docs/guide/images/router.jpg",
  "kstack/generated/docs/guide/images/understanding.jpg",
  "kstack/generated/docs/guide/images/verification.jpg",
  "kstack/generated/skills/architect/SKILL.md",
  "kstack/generated/skills/architect/references/design-red-flags.md",
  "kstack/generated/skills/architect/references/rationale-template.md",
  "kstack/generated/skills/architect/references/runner-prompt.md",
  "kstack/generated/skills/arena/SKILL.md",
  "kstack/generated/skills/automate-me/SKILL.md",
  "kstack/generated/skills/blast-radius/SKILL.md",
  "kstack/generated/skills/bro/SKILL.md",
  "kstack/generated/skills/create-verification-skill/SKILL.md",
  "kstack/generated/skills/create-verification-skill/references/feature-map-example/README.md",
  "kstack/generated/skills/create-verification-skill/references/feature-map-example/create-note.md",
  "kstack/generated/skills/create-verification-skill/references/feature-map-example/search.md",
  "kstack/generated/skills/figure-it-out/SKILL.md",
  "kstack/generated/skills/how/SKILL.md",
  "kstack/generated/skills/how/references/critic-prompt.md",
  "kstack/generated/skills/how/references/critique-rubric.md",
  "kstack/generated/skills/how/references/explainer-prompt.md",
  "kstack/generated/skills/how/references/explorer-prompt.md",
  "kstack/generated/skills/interrogate/SKILL.md",
  "kstack/generated/skills/interrogate/references/code-quality-review.md",
  "kstack/generated/skills/interrogate/references/lead-judgment.md",
  "kstack/generated/skills/interrogate/references/reviewer-prompt.md",
  "kstack/generated/skills/interrogate/references/rubric.md",
  "kstack/generated/skills/k-mode/SKILL.md",
  "kstack/generated/skills/k-mode/playbooks/authoring-a-skill.md",
  "kstack/generated/skills/k-mode/playbooks/autonomous-run.md",
  "kstack/generated/skills/k-mode/playbooks/autopilot-full.md",
  "kstack/generated/skills/k-mode/playbooks/autopilot-stack.md",
  "kstack/generated/skills/k-mode/playbooks/babysit.md",
  "kstack/generated/skills/k-mode/playbooks/bug-fix.md",
  "kstack/generated/skills/k-mode/playbooks/eval.md",
  "kstack/generated/skills/k-mode/playbooks/feature.md",
  "kstack/generated/skills/k-mode/playbooks/hillclimb.md",
  "kstack/generated/skills/k-mode/playbooks/investigation.md",
  "kstack/generated/skills/k-mode/playbooks/multi-phase-plan.md",
  "kstack/generated/skills/k-mode/playbooks/opening-a-pr.md",
  "kstack/generated/skills/k-mode/playbooks/orchestrate.md",
  "kstack/generated/skills/k-mode/playbooks/pause-safely.md",
  "kstack/generated/skills/k-mode/playbooks/perf-issue.md",
  "kstack/generated/skills/k-mode/playbooks/prototype.md",
  "kstack/generated/skills/k-mode/playbooks/refactoring.md",
  "kstack/generated/skills/k-mode/playbooks/runtime-forensics.md",
  "kstack/generated/skills/k-mode/playbooks/session-pickup.md",
  "kstack/generated/skills/k-mode/playbooks/shipping.md",
  "kstack/generated/skills/k-mode/playbooks/trace-forensics.md",
  "kstack/generated/skills/k-mode/playbooks/visual-parity.md",
  "kstack/generated/skills/k-mode/playbooks/worktree-cleanup.md",
  "kstack/generated/skills/k-mode/references/bugbot-triage.md",
  "kstack/generated/skills/k-mode/scripts/bootstrap.ts",
  "kstack/generated/skills/k-mode/scripts/bun.lock",
  "kstack/generated/skills/k-mode/scripts/check-plan.mjs",
  "kstack/generated/skills/k-mode/scripts/orch/orch.test.ts",
  "kstack/generated/skills/k-mode/scripts/orch/orch.ts",
  "kstack/generated/skills/k-mode/scripts/orch/store.ts",
  "kstack/generated/skills/k-mode/scripts/package.json",
  "kstack/generated/skills/k-mode/scripts/watch-pr/cli.test.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/cli.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/fakes.test-helper.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/github.test.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/github.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/policy.test.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/policy.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/render.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/tsconfig.json",
  "kstack/generated/skills/k-mode/scripts/watch-pr/types.compile.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/types.ts",
  "kstack/generated/skills/k-mode/scripts/watch-pr/watch-pr",
  "kstack/generated/skills/k-mode/scripts/worktree-audit.sh",
  "kstack/generated/skills/maintain-verification-skill/SKILL.md",
  "kstack/generated/skills/make-bot-ui/SKILL.md",
  "kstack/generated/skills/no-comments/SKILL.md",
  "kstack/generated/skills/principle-boundary-discipline/SKILL.md",
  "kstack/generated/skills/principle-build-the-lever/SKILL.md",
  "kstack/generated/skills/principle-encode-lessons-in-structure/SKILL.md",
  "kstack/generated/skills/principle-exhaust-the-design-space/SKILL.md",
  "kstack/generated/skills/principle-experience-first/SKILL.md",
  "kstack/generated/skills/principle-fix-root-causes/SKILL.md",
  "kstack/generated/skills/principle-foundational-thinking/SKILL.md",
  "kstack/generated/skills/principle-guard-the-context-window/SKILL.md",
  "kstack/generated/skills/principle-laziness-protocol/SKILL.md",
  "kstack/generated/skills/principle-make-operations-idempotent/SKILL.md",
  "kstack/generated/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md",
  "kstack/generated/skills/principle-minimize-reader-load/SKILL.md",
  "kstack/generated/skills/principle-model-the-domain/SKILL.md",
  "kstack/generated/skills/principle-never-block-on-the-human/SKILL.md",
  "kstack/generated/skills/principle-outcome-oriented-execution/SKILL.md",
  "kstack/generated/skills/principle-prove-it-works/SKILL.md",
  "kstack/generated/skills/principle-redesign-from-first-principles/SKILL.md",
  "kstack/generated/skills/principle-separate-before-serializing-shared-state/SKILL.md",
  "kstack/generated/skills/principle-sequence-verifiable-units/SKILL.md",
  "kstack/generated/skills/principle-subtract-before-you-add/SKILL.md",
  "kstack/generated/skills/principle-type-system-discipline/SKILL.md",
  "kstack/generated/skills/recall/SKILL.md",
  "kstack/generated/skills/reflect/SKILL.md",
  "kstack/generated/skills/reflect/references/divergent-reviewer.md",
  "kstack/generated/skills/reflect/references/judgment-reviewer.md",
  "kstack/generated/skills/reflect/references/synthesizer.md",
  "kstack/generated/skills/reflect/references/tooling-reviewer.md",
  "kstack/generated/skills/setup-kstack/SKILL.md",
  "kstack/generated/skills/show-me-your-work/SKILL.md",
  "kstack/generated/skills/show-me-your-work/references/decision-log-template.tsv",
  "kstack/generated/skills/show-me-your-work/scripts/log.sh",
  "kstack/generated/skills/swarm/SKILL.md",
  "kstack/generated/skills/tdd/SKILL.md",
  "kstack/generated/skills/teach/SKILL.md",
  "kstack/generated/skills/technical-writing/SKILL.md",
  "kstack/generated/skills/typescript-best-practices/SKILL.md",
  "kstack/generated/skills/typescript-best-practices/references/patterns.md",
  "kstack/generated/skills/unslop/SKILL.md",
  "kstack/generated/skills/why/SKILL.md",
  "kstack/generated/skills/why/references/epistemics.md",
  "kstack/generated/skills/why/references/investigator-prompt.md",
  "kstack/generated/skills/why/references/source-playbook.md",
  "kstack/generated/skills/why/references/sources/code-archaeology.md",
  "kstack/generated/skills/why/references/sources/databricks.md",
  "kstack/generated/skills/why/references/sources/datadog.md",
  "kstack/generated/skills/why/references/sources/incident-postmortem.md",
  "kstack/generated/skills/why/references/sources/linear.md",
  "kstack/generated/skills/why/references/sources/notion.md",
  "kstack/generated/skills/why/references/sources/sentry.md",
  "kstack/generated/skills/why/references/sources/slack.md",
  "kstack/generated/skills/why/references/synthesizer-prompt.md",
  "kstack/mode.ts",
  "kstack/models.ts",
  "kstack/overlay/forbidden.txt",
  "kstack/overlay/rename-map.json",
  "kstack/overlay/transforms.ts",
  "package.json",
  "prompts/implement.md",
  "prompts/plan.md",
  "prompts/review.md",
  "prompts/ship.md",
  "prompts/specify.md",
  "prompts/verify.md",
  "schemas/event.schema.json",
  "schemas/evidence.schema.json",
  "schemas/task.schema.json",
  "schemas/verdict.schema.json",
  "skills/concise-output/SKILL.md",
  "skills/context-pack/SKILL.md",
  "skills/conventional-commit/SKILL.md",
  "skills/isolated-review/SKILL.md",
  "skills/minimalist/SKILL.md",
  "skills/quality-gates/SKILL.md",
  "skills/spec-first/SKILL.md",
  "skills/tdd-cycle/SKILL.md",
  "templates/AGENTS.md",
  "templates/APPEND_SYSTEM.md",
  "templates/context-pack/product.md",
  "templates/context-pack/structure.md",
  "templates/context-pack/tech.md",
  "templates/policy.json",
  "themes/loop-amber.json",
  "themes/protocol-blue.json",
];

const secretShapedPath =
  /(^|\/)(\.env(\.[^/]+)?|\.netrc|\.npmrc|\.pgpass|id_[a-z]+|[^/]*(secret|credential|password|token)[^/]*|[^/]+\.(pem|key|p12|pfx|jks|keystore|asc))$/i;

type PackReport = { files: { path: string }[] };

let inventory: Promise<string[]> | undefined;

/** `--dry-run` reports the publish inventory without ever writing a tarball. */
function publishInventory(): Promise<string[]> {
  inventory ??= execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(repoRoot),
    maxBuffer: 64 * 1024 * 1024,
  }).then(({ stdout }) => {
    const [report] = JSON.parse(stdout) as PackReport[];
    return report.files.map((file) => file.path.replace(/^\.\//, "")).sort();
  });
  return inventory;
}

test("package.json declares the explicit publish allowlist", async () => {
  const manifest = await readManifest();
  const declaredFiles: string[] = manifest.files ?? [];

  assert.deepEqual(declaredFiles, [...publishAllowlist]);
  assert.equal(new Set(declaredFiles).size, publishAllowlist.length);

  for (const excluded of excludedPublishPaths) {
    const declared = declaredFiles.filter(
      (entry) => entry === excluded || entry.startsWith(excluded) || excluded.startsWith(entry),
    );
    assert.deepEqual(declared, [], `${excluded} must not be declared publishable`);
  }
});

test("the expected publish inventory stays a usable oracle", () => {
  const listed: string[] = [...expectedPublishedFiles];
  assert.deepEqual([...listed].sort(), listed, "expected inventory must stay sorted");
  assert.equal(new Set(listed).size, listed.length, "expected inventory must list every path once");

  const unallowlisted = listed.filter(
    (path) =>
      path !== "package.json" &&
      !publishAllowlist.some((entry) =>
        entry.endsWith("/") ? path.startsWith(entry) : path === entry,
      ),
  );
  assert.deepEqual(unallowlisted, [], "expected inventory lists paths outside the declared allowlist");

  for (const entry of publishAllowlist) {
    const shipped = entry.endsWith("/")
      ? listed.some((path) => path.startsWith(entry))
      : listed.includes(entry);
    assert.ok(shipped, `${entry} contributes nothing to the publish payload`);
  }
});

test("npm pack ships exactly the expected inventory", async () => {
  const packed = await publishInventory();

  assert.deepEqual(packed, [...expectedPublishedFiles]);

  const { version } = await readManifest();
  await assert.rejects(stat(new URL(`k-pi-${version}.tgz`, repoRoot)), { code: "ENOENT" });
});

test("every declared pi resource root ships files", async () => {
  const packed = await publishInventory();

  const { pi } = await readManifest();
  for (const [slot, roots] of Object.entries(pi ?? {})) {
    for (const root of roots) {
      const prefix = `${root.replace(/^\.\//, "").replace(/\/$/, "")}/`;
      assert.ok(
        packed.some((path) => path.startsWith(prefix)),
        `pi.${slot} root ${root} ships no files`,
      );
    }
  }
});

test("excluded roots and secret-shaped paths cannot enter the tarball", async () => {
  const packed = await publishInventory();

  for (const excluded of excludedPublishPaths) {
    await assert.doesNotReject(
      stat(new URL(excluded, repoRoot)),
      `${excluded} no longer exists; update the exclusion list`,
    );
    const leaked = packed.filter((path) => path === excluded || path.startsWith(excluded));
    assert.deepEqual(leaked, [], `${excluded} must stay out of the publish payload`);
  }

  const secrets = packed.filter((path) => secretShapedPath.test(path));
  assert.deepEqual(secrets, [], "secret-shaped paths must never publish");

  for (const canary of [
    "themes/.env",
    "extensions/.env.local",
    "skills/id_rsa",
    "prompts/.npmrc",
    "graphs/api-token.txt",
    "templates/service-account.pem",
    "kstack/overlay/credentials.json",
    "schemas/private.key",
  ]) {
    assert.ok(secretShapedPath.test(canary), `${canary} must be treated as secret-shaped`);
  }
});

type Theme = {
  name: string;
  colors: Record<string, string>;
};

async function readTheme(name: string): Promise<Theme> {
  return JSON.parse(
    await readFile(new URL(`../themes/${name}.json`, import.meta.url), "utf8"),
  ) as Theme;
}

test("themes expose required semantic colors", async () => {
  for (const name of ["loop-amber", "protocol-blue"]) {
    const theme = await readTheme(name);
    for (const color of ["accent", "success", "error", "warning"]) {
      assert.ok(theme.colors[color], `${name} must define ${color}`);
    }
  }
});

test("themes use the required protocol accents", async () => {
  const amber = await readTheme("loop-amber");
  const blue = await readTheme("protocol-blue");

  assert.equal(amber.name, "loop-amber");
  assert.equal(amber.colors.accent, "#ff6a1a");
  assert.equal(amber.colors.borderAccent, "#ff6a1a");
  assert.equal(blue.name, "protocol-blue");
  assert.equal(blue.colors.accent, "#3da9fc");
  assert.equal(blue.colors.borderAccent, "#3da9fc");
});

test("APPEND_SYSTEM is additive and concise-output is progressive", async () => {
  const appendSystem = await readFile(
    new URL("../templates/APPEND_SYSTEM.md", import.meta.url),
    "utf8",
  );
  const skill = await readFile(
    new URL("../skills/concise-output/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(appendSystem, /Keep user-visible answers short/);
  assert.doesNotMatch(appendSystem, /\breplac\w*\b[^\n]*\bsystem prompt\b/i);
  assert.match(skill, /^description: Use whenever writing to the user\.$/m);
});

test("templates do not contain SYSTEM.md", async () => {
  await assert.rejects(
    readFile(new URL("../templates/SYSTEM.md", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
});
