# AGENTS.md

> **AUTHORITY — ACTIVE QUEUE: `docs/remediation-plan.md`.** That file is the sole active work queue and the only completion authority. Start at the lowest incomplete `RP-##` whose dependencies are complete — currently **RP-01A**, the architecture reset every later package depends on — and check a DoD box only from that package's own scoped evidence.
>
> **Historical baseline only.** `docs/roadmap.md` and `docs/implementation-plan.md` are a build record. Their `[x]` checkboxes are not completion evidence and never authorize skipping a package.
>
> **Paths.** Every path in this file is repository-root-relative. `AGENTS.md` and `docs/AGENTS.md` are mirrored copies of one contract, as are `START-HERE.md` and `docs/START-HERE.md`; if copies disagree, the repository-root copy wins.

This directory is the source of truth for **K-π**, a standalone coding-agent harness maintained as a fork of Pi. The whole harness lives in this repository under `packages/`; K-π's own runtime lives in `packages/coding-agent/src/kpi/`. K-π is not a Pi package, is not installed into Pi, and has no Pi peer dependency. Fork policy: `UPSTREAM.md`.

Read in this order before writing code:

1. `START-HERE.md` then `docs/BUILD-PROMPT.md`
2. `UPSTREAM.md` — fork base, sync policy, patched-file register
3. `docs/PRD.md` — stories US-01–US-30
4. `docs/spec.md` — architecture, file contracts, schemas, APIs
5. `docs/visual-targets.md` + `docs/visual/*.jpg`
6. `docs/kstack.md` + `docs/model-ladder.md`
7. `docs/research.md` + `docs/dune-architecture.md`
8. `docs/minimalist.md` + `docs/agents-bus.md`
9. `docs/roadmap.md` then `docs/implementation-plan.md` — historical baseline only; their checkboxes are a build record, not completion evidence
10. `docs/remediation-research.md`
11. `docs/remediation-plan.md` — active queue, RP-01A first

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

## Quality gates for this repo

A slice is not done until:

```bash
npm run check          # biome, pinned deps, ts imports, tsgo --noEmit, browser smoke
npm test               # script tests + workspace tests
npm run test:kpi       # node --test --experimental-strip-types test/*.test.ts
```

Plus the slice's own AC and scoped verification in `docs/remediation-plan.md`. Store command output in the slice's evidence, not in chat.

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
