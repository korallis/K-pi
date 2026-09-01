# AGENTS.md

This directory is the source of truth for **k-pi**, a first-party Pi coding-agent package.

Read in this order before writing code:

1. `START-HERE.md` then `BUILD-PROMPT.md`
2. `PRD.md` — stories US-01–US-30
3. `spec.md` — architecture, file contracts, schemas, APIs
4. `visual-targets.md` + `visual/*.jpg`
5. `kstack.md` + `model-ladder.md`
6. `research.md` + `dune-architecture.md`
7. `minimalist.md` + `agents-bus.md`
8. Historical baseline: `roadmap.md` then `implementation-plan.md`. Active queue: `remediation-research.md` then `remediation-plan.md` (RP-00 first).

Do not invent requirements that are not in those files. If a story and the spec disagree, stop and flag `NEEDS_HUMAN`. If a check is missing from an AC, the AC is not executable — do not pretend it is.

## Product in one paragraph

k-pi is a Pi package we own. A user gives a **task** or a **frozen plan**. The package runs a graph-engineered coding loop (specify → plan → implement → test → bounds → isolated review → ship) with software-engineering primitives already on the path. Default mode is **gated** (human before commit). **Autopilot** is allowed only when every required acceptance criterion is machine-executable. Subscriptions for Anthropic, OpenAI/Codex, xAI, z.ai, Kimi Coding, and Cursor can be stacked and failed over. Local llama.cpp / Ollama / LM Studio are first-class pools but off the default cloud chain. Official Pi model catalogs are never frozen. K-stack (forked Cursor pstack) supplies playbooks and principles inside those nodes. Oh My Pi, Atomic, pi-pstack, open-pstack, and community Cursor packages are references, not dependencies.

## Hard rules for agents building this repo

- First-party code only. No runtime dependency on oh-my-pi, atomic, pi-multi-account, pi-multi-pass, pi-graph, pi-cursor-oauth, pi-code, cursor pstack, open-pstack, or pi-pstack.
- K-stack is a vendored overlay on Cursor pstack. Commands: `/setup-kstack`, `/k-mode`. No Cursor Cloud agents. Models only from the k-pi pool. Edit `kstack/overlay/`, never `kstack/upstream/` or by-hand `kstack/generated/`. Refresh with `pnpm kstack:sync`. See `kstack.md` §2.
- Official Pi APIs only: extensions, skills, prompt templates, themes, packages, `registerProvider`, `refreshModels`, OAuth `{login,refreshToken,getApiKey}`, events (`before_provider_headers`, `after_provider_response`, `tool_call`, …).
- Never `registerProvider("anthropic"|"openai"|"openai-codex"|"xai"|"zai"|"zai-coding-cn"|"kimi-coding", { models: [...] })`. That freezes the official catalog.
- Cursor is not built-in. Register `cursor` ourselves with `refreshModels`.
- z.ai and Kimi Coding are official Pi key providers (`zai`, `zai-coding-cn`, `kimi-coding`). Do not install `pi-kimi-coder`, `pi-moonshot`, or community z.ai packages.
- Local: official llama.cpp (`LLAMA_BASE_URL`) plus first-party `refreshModels` for Ollama / LM Studio / OpenAI-compat. No `pi-ollama` community packages. No frozen local model lists.
- Exa and Perplexity research are optional and first-party REST integrations. See `research.md`. No runtime SDK or community research package. Specify/plan cannot finish without `research.md`.
- Plan writes `stack.json` (dune modules). Implement stays inside the current module. Vertical slices by default. See `dune-architecture.md`.
- Implementer never writes `verdict.json` or `release.approved`.
- No Cursor-style subagents. Workers are background Pi sessions. They talk only via `communicate` (`sendUserMessage` / RPC prompt). One writer at a time. `claim_path` before edits. See `agents-bus.md`.
- Bare non-slash text with no active job is gated `/kpi` + sticky `/k-mode`. Commands are never auto-wrapped. `/kpi off` disables wrap.
- Implementer walks the minimalist ladder and records `candidate.json.ladder` before writing files. See `minimalist.md`.
- Autopilot never push, deploy, force-push, `rm -rf`, production migrate, or add runtime dependencies.
- Anthropic subscription login must show the extra-usage warning once per new slot before OAuth starts.
- Answers in this repo’s own agent sessions stay short. Paths and commands, not essays.
- Footer brand is `K-π`, never bare `π`. Status bar copies Oh My Pi’s segment order. Loop overlay copies the Avid boards. See `visual-targets.md` and https://x.com/av1dlive/status/2092622516544270781.

## Quality gates for this repo

A slice is not done until:

```bash
pnpm test
pnpm lint
pnpm typecheck
```

Plus the slice's own AC in `remediation-plan.md`. Store command output in the slice's evidence, not in chat.

## Stack (this repo)

- TypeScript, Node `>= 22.19`
- Package name: `k-pi` (npm/pi package id). Display name: **k-pi**. Brand cell: **K-π**.
- Peer: `@earendil-works/pi-coding-agent` `>=0.84.0`, plus `pi-tui`, `pi-agent-core`, `pi-ai`
- Tested pin: `pi-coding-agent@0.84.4`. CI uses that pin. 0.85+ needs a bump PR.
- Install target: `pi install -l ./` from the package root

## Do not

- Rewrite unrelated files while implementing one work package
- Hard-code official model ids
- Skip the Anthropic extra-usage confirm dialog
- Mark autopilot DONE because an LLM said the tests passed
- Commit secrets, `.env`, `accounts.secrets.json`, or `auth.json`
