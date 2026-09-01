import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("package manifest exposes the Pi package contract", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    keywords?: string[];
    dependencies?: Record<string, string>;
    pi?: Record<string, string[]>;
  };

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
