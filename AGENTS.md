# AGENTS.md

> **AUTHORITY.** `docs/remediation-plan.md` is the only active work queue and the only completion authority. It names the current package in its own `Ordering` line; no other file repeats that pointer, so no other file can go stale. Check a DoD box only from that package's own scoped evidence.
>
> **ARCHIVE.** `docs/roadmap.md`, `docs/implementation-plan.md`, and `docs/remediation-research.md` are historical. Their `[x]` checkboxes are never completion evidence. Read them only when a package's `Read first` list names them.
>
> **ONE COPY.** This file is the only copy of this contract. `docs/AGENTS.md` and `docs/START-HERE.md` are pointers and carry no rules of their own. Every path here is repository-root-relative.

This file is the source of truth for **K-π**, a standalone coding-agent harness maintained as a fork of Pi. The whole harness lives in this repository under `packages/`; K-π's own runtime lives in `packages/coding-agent/src/kpi/`. K-π is not a Pi package, is not installed into Pi, and has no Pi peer dependency. Fork policy: `UPSTREAM.md`.

## Read order

1. This file.
2. `docs/remediation-plan.md` — find the current package, then read only the files in its own `Read first` list.

Everything else is read on demand, by question:

| Question | File |
|---|---|
| What must the product do? Which AC? | `docs/PRD.md` — stories US-01–US-30 |
| What is the contract, schema, or requirement ID? | `docs/spec.md` |
| What may I change in the fork? | `UPSTREAM.md` |
| What must the operator see? | `docs/visual-targets.md` + `docs/visual/*.jpg` |
| K-stack and model roles | `docs/kstack.md`, `docs/model-ladder.md` |
| Research, folder map, worker bus | `docs/research.md`, `docs/dune-architecture.md`, `docs/agents-bus.md` |
| Anti-over-engineering ladder | `docs/minimalist.md` |
| How a finished feature is accepted | `docs/uat.md` |

Nothing else is in the default path. Read the ranges you need; a blanket read of the document set is not diligence.

Do not invent requirements that are not in those files. If a story and the spec disagree, stop and flag `NEEDS_HUMAN`. If a check is missing from an AC, the AC is not executable — do not pretend it is.

## Product in one paragraph

K-π is a coding-agent harness we own outright — a fork of Pi `v0.84.4`, base commit `b79e4cc`, tracked through the `upstream` git remote. A user gives a **task** or a **frozen plan**. K-π runs a graph-engineered coding loop (specify → plan → implement → test → bounds → isolated review → ship) with software-engineering primitives already on the path, driven by a built-in extension inside its own executable. Default mode is **gated** (human before commit). **Autopilot** is allowed only when every required acceptance criterion is machine-executable. Subscriptions for Anthropic, OpenAI/Codex, xAI, z.ai, Kimi Coding, and Cursor can be stacked and failed over. Local llama.cpp / Ollama / LM Studio are first-class pools but off the default cloud chain. Official model catalogs are never frozen. K-stack (forked Cursor pstack) supplies playbooks and principles inside those nodes. Oh My Pi, Atomic, pi-pstack, open-pstack, and community Cursor packages are references, not dependencies.

## Hard rules for agents building this repo

- K-π ships as its own executable. `bin` is `kpi` + `k-pi`; the upstream `pi` bin is gone. Config dir is `.kpi/` (project) and `~/.kpi/agent/` (user). Env overrides are `KPI_CODING_AGENT_DIR` and `KPI_CODING_AGENT_SESSION_DIR`.
- K-π's control plane is a **built-in extension** compiled into the binary, and its prompts, skills, themes, and graphs are discovered by that built-in and copied into `dist`. There is no `pi install`, no `package.json#pi` manifest, no peer dependency, and no trust gate on K-π's own commands. `/kpi`, `/accounts`, `/k-mode`, and `/setup-kstack` exist at startup.
- Everything under `packages/` is K-π source, not a dependency. Workspace packages keep their upstream `@earendil-works/pi-*` names purely so upstream releases merge cleanly; never describe them as external requirements.
- Upstream changes come only through the `upstream` remote, reviewed per `UPSTREAM.md`. Prefer `packages/coding-agent/src/kpi/**` over patching upstream files; every upstream file you must patch goes in the `UPSTREAM.md` patched-file register.
- First-party code only. No runtime dependency on oh-my-pi, atomic, pi-multi-account, pi-multi-pass, pi-graph, pi-cursor-oauth, pi-code, cursor pstack, open-pstack, or pi-pstack.
- K-stack is a vendored overlay on Cursor pstack. Commands: `/setup-kstack`, `/k-mode`. No Cursor Cloud agents. Models only from the K-π pool. Edit `kstack/overlay/`, never `kstack/upstream/` or by-hand `kstack/generated/`. Refresh with `npm run kstack:sync`. See `docs/kstack.md` §2.
- Use the harness's own extension surface rather than rebuilding it: extensions, skills, prompt templates, themes, `registerProvider`, `refreshModels`, OAuth `{login,refreshToken,getApiKey}`, events (`before_provider_headers`, `after_provider_response`, `tool_call`, …). Forking the harness is not a licence to rewrite its loaders, catalogs, sessions, or RPC.
- Never `registerProvider("anthropic"|"openai"|"openai-codex"|"xai"|"zai"|"zai-coding-cn"|"kimi-coding", { models: [...] })`. That freezes the official catalog.
- Cursor is not built-in. Register `cursor` ourselves with `refreshModels`.
- z.ai and Kimi Coding are built-in key providers (`zai`, `zai-coding-cn`, `kimi-coding`). Do not vendor `pi-kimi-coder`, `pi-moonshot`, or community z.ai packages.
- Local: built-in llama.cpp (`LLAMA_BASE_URL`) plus first-party `refreshModels` for Ollama / LM Studio / OpenAI-compat. No `pi-ollama` community packages. No frozen local model lists.
- Exa and Perplexity research are optional and first-party REST integrations. See `docs/research.md`. No runtime SDK or community research package. Specify/plan cannot finish without the run's `research.md` artifact.
- Plan writes `stack.json` (dune modules). Implement stays inside the current module. Vertical slices by default. See `docs/dune-architecture.md`.
- Implementer never writes `verdict.json` or `release.approved`.
- No Cursor-style subagents. Workers are background K-π sessions. They talk only via `communicate` (`sendUserMessage` / RPC prompt). One writer at a time. `claim_path` before edits. See `docs/agents-bus.md`.
- Bare non-slash text with no active job is gated `/kpi` + sticky `/k-mode`. Commands are never auto-wrapped. `/kpi off` restores plain harness input.
- Implementer walks the minimalist ladder and records `candidate.json.ladder` before writing files. See `docs/minimalist.md`.
- Autopilot never push, deploy, force-push, `rm -rf`, production migrate, or add runtime dependencies.
- Anthropic subscription login must show the extra-usage warning once per new slot before OAuth starts.
- Answers in this repo’s own agent sessions stay short. Paths and commands, not essays.
- Footer brand is `K-π`, never bare `π`. Status bar copies Oh My Pi’s segment order. Loop overlay copies the Avid boards. See `docs/visual-targets.md` and https://x.com/av1dlive/status/2092622516544270781.

## Gates

While a package is in flight, run **only** that package's `Verification` block. Concurrent writers make the full suite report other people's half-landed edits.

Once, before opening a pull request:

```bash
npm run check          # biome, pinned deps, ts imports, tsgo --noEmit, browser smoke
npm test               # script tests + workspace tests
npm run test:kpi       # node --test --experimental-strip-types test/*.test.ts
```

CI is the fail-closed authority. `check` and `Grok review` are required checks and nothing merges without both. The required-check set, its `Active` enforcement, and its bypass list are part of the gate: a bypass entry defeats it silently.

Evidence is a command, its exit code, its output, and the `git rev-parse HEAD` it ran against. It lives in the package's evidence, never in chat.

Feature acceptance is separate from gates and comes last: `docs/uat.md` runs only after every `RP-##` is complete and the gates above are green.

## How to work

These are the only process rules. There is no principle preamble to read first.

1. **Reproduce before you fix.** A bug fix without a failing reproduction is a guess.
2. **Prove it against the real artifact.** Run the built binary, exercise the path, read the actual value. "It compiles" and "tests should pass" are not evidence.
3. **Smallest correct change.** Prefer deletion and reuse over new structure. A wrong-place small diff is still a bug.
4. **Migrate every caller, then delete the old path.** No shims, aliases, or deprecated re-exports.
5. **Handle the failures your contracts name.** `docs/spec.md` and the ACs enumerate the failure modes; each one gets a real path, a recorded reason, and a bound. Silence is a defect.
6. **One writer per file.** Coordinate before touching a file another package owns. Shared-file list: `docs/remediation-plan.md`.
7. **Stop, do not improvise.** A contract conflict opens a `NEEDS_HUMAN` gate in `docs/remediation-plan.md` with both citations. Do not pick a winner.
8. **Load context on demand.** Read the ranges you need, when the current node needs them.

## Stack (this repo)

- TypeScript, Node `>= 22.19`. npm workspaces. Not pnpm.
- Repository: `k-pi-monorepo` (private, never published). Executable: `kpi` / `k-pi`. Brand cell: **K-π**.
- Everything under `packages/` is forked Pi source owned here. K-π's own runtime is `packages/coding-agent/src/kpi/`; K-π's node tests stay in root `test/` and import that path.
- Upstream base: Pi `v0.84.4`, commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`, remote `upstream` → `https://github.com/earendil-works/pi.git`. Machine-readable pin: `upstream.json`; drift report: `npm run upstream:check`.
- Build: `npm install` then `npm run build` (`npm run build:offline` for the offline path). Run: `node packages/coding-agent/dist/bundle/cli.js`, or `npm link --workspace @earendil-works/pi-coding-agent` then `kpi`. From source without building: `./kpi-test.sh`.
- Moving to a newer upstream release is a reviewed merge per `UPSTREAM.md`, never an automated bump.

## Do not

- Rewrite unrelated files while implementing one work package
- Hard-code official model ids
- Skip the Anthropic extra-usage confirm dialog
- Mark autopilot DONE because an LLM said the tests passed
- Commit secrets, `.env`, `accounts.secrets.json`, or `auth.json`
- Reintroduce `pi install`, a `package.json#pi` manifest, peer dependencies on `@earendil-works/pi-*`, or publish/release automation
- Describe K-π as a Pi package, or Pi as the host process

## Best practices, with sources

Primary sources, fetched and read on 2026-09-01. They inform the rules above; they are not a second rulebook and they do not override `docs/PRD.md` or `docs/spec.md`. Re-read a source before quoting it — one of them dates itself.

| Source | What we took from it |
|---|---|
| Anthropic, *Building effective agents*, published 2024-12-19 — https://www.anthropic.com/engineering/building-effective-agents (page notes its tooling section is stale after 2024-12 and points at `anthropic.com/engineering/managed-agents`) | Add complexity only when it demonstrably improves outcomes. Prioritise simplicity and transparency, and show planning steps — this is why the board is a product surface, not garnish. Agents must take ground truth from the environment at each step (tool results, code execution), pause at checkpoints, and carry stopping conditions such as a maximum iteration count. Automated tests verify function, but human review still decides whether the change fits the system — which is why gated is the default and UAT ends with a human. |
| GitHub, *Secure use reference* — https://docs.github.com/en/actions/reference/security/secure-use | Grant `GITHUB_TOKEN` least privilege and raise it per job, not per workflow. A self-hosted runner has no ephemeral-VM guarantee and must never execute untrusted pull-request code. Full-length commit SHAs are the only immutable way to pin a third-party action, and SHA-pinned actions no longer produce Dependabot alerts, so pin and subscribe to action version updates together. `CODEOWNERS` over `.github/workflows` makes gate configuration reviewable. Delivery follow-ups belong to the CI work, not to this document set. |
| GitHub, *Use GITHUB_TOKEN for authentication in workflows* — https://docs.github.com/en/actions/tutorials/authenticate-with-github_token | An action reaches `GITHUB_TOKEN` through the `github.token` context even when a workflow never passes it. Blanking the environment variable is defence in depth; the `permissions:` block is the control. |
| GitHub, *About rulesets* — https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets · *Automatically merging a pull request* — https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request | Rulesets aggregate and the most restrictive rule wins, so protection can be added without a migration. Anyone with read access can read the active rulesets, which makes the gate itself auditable evidence. Auto-merge only queues a pull request that cannot already merge: with no required check there is nothing to hold, so a required-check set is what makes a review gate a gate. |
| OpenAI, *Working with evals* — https://developers.openai.com/api/docs/guides/evals | Declare the evidence schema separately from the pass criterion, and prefer deterministic graders (exit code, exact string) over model judgement wherever a command exists. The same page states OpenAI's hosted Evals platform goes read-only 2026-10-31 and shuts down 2026-11-30, so K-π keeps fixtures, graders, and evidence local under `.kpi/`. |
| Cucumber, *Behaviour-Driven Development* — https://cucumber.io/docs/bdd/ | Write acceptance examples in a medium both a human and a machine can read, and drive implementation from a test that fails first. This is the shape of `docs/uat.md`: a human question beside a runnable action. |

No source in this set recommends mutation testing, and this repository does not use it. Adding it would need evidence that it improves outcomes here, measured against the behavioural suites the packages already owe.
