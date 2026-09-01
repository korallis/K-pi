# AGENTS.md

> **AUTHORITY — ACTIVE QUEUE: [`docs/remediation-plan.md`](remediation-plan.md).** That file is the sole active work queue and the only completion authority. Start at **RP-00**, then take the lowest incomplete `RP-##` whose dependencies are complete, and check a DoD box only from that package's own scoped evidence.
>
> **Historical baseline only.** [`docs/roadmap.md`](roadmap.md) and [`docs/implementation-plan.md`](implementation-plan.md) are a build record. Their `[x]` checkboxes are not completion evidence and never authorize skipping a package.
>
> **Paths.** Every path shown in this file is repository-root-relative; links in this `docs/` copy point at the sibling file. `AGENTS.md` and `docs/AGENTS.md` are mirrored copies of one contract, as are `START-HERE.md` and `docs/START-HERE.md`; if copies disagree, the repository-root copy wins.

This directory is the source of truth for **k-pi**, a first-party Pi coding-agent package.

Read in this order before writing code:

1. [`START-HERE.md`](../START-HERE.md) then [`docs/BUILD-PROMPT.md`](BUILD-PROMPT.md)
2. [`docs/PRD.md`](PRD.md) — stories US-01–US-30
3. [`docs/spec.md`](spec.md) — architecture, file contracts, schemas, APIs
4. [`docs/visual-targets.md`](visual-targets.md) + `docs/visual/*.jpg`
5. [`docs/kstack.md`](kstack.md) + [`docs/model-ladder.md`](model-ladder.md)
6. [`docs/research.md`](research.md) + [`docs/dune-architecture.md`](dune-architecture.md)
7. [`docs/minimalist.md`](minimalist.md) + [`docs/agents-bus.md`](agents-bus.md)
8. [`docs/roadmap.md`](roadmap.md) then [`docs/implementation-plan.md`](implementation-plan.md) — historical baseline only; their checkboxes are a build record, not completion evidence
9. [`docs/remediation-research.md`](remediation-research.md)
10. [`docs/remediation-plan.md`](remediation-plan.md) — active queue, RP-00 first

Do not invent requirements that are not in those files. If a story and the spec disagree, stop and flag `NEEDS_HUMAN`. If a check is missing from an AC, the AC is not executable — do not pretend it is.

## Product in one paragraph

k-pi is a Pi package we own. A user gives a **task** or a **frozen plan**. The package runs a graph-engineered coding loop (specify → plan → implement → test → bounds → isolated review → ship) with software-engineering primitives already on the path. Default mode is **gated** (human before commit). **Autopilot** is allowed only when every required acceptance criterion is machine-executable. Subscriptions for Anthropic, OpenAI/Codex, xAI, z.ai, Kimi Coding, and Cursor can be stacked and failed over. Local llama.cpp / Ollama / LM Studio are first-class pools but off the default cloud chain. Official Pi model catalogs are never frozen. K-stack (forked Cursor pstack) supplies playbooks and principles inside those nodes. Oh My Pi, Atomic, pi-pstack, open-pstack, and community Cursor packages are references, not dependencies.

## Hard rules for agents building this repo

- First-party code only. No runtime dependency on oh-my-pi, atomic, pi-multi-account, pi-multi-pass, pi-graph, pi-cursor-oauth, pi-code, cursor pstack, open-pstack, or pi-pstack.
- K-stack is a vendored overlay on Cursor pstack. Commands: `/setup-kstack`, `/k-mode`. No Cursor Cloud agents. Models only from the k-pi pool. Edit `kstack/overlay/`, never `kstack/upstream/` or by-hand `kstack/generated/`. Refresh with `pnpm kstack:sync`. See [`docs/kstack.md`](kstack.md) §2.
- Official Pi APIs only: extensions, skills, prompt templates, themes, packages, `registerProvider`, `refreshModels`, OAuth `{login,refreshToken,getApiKey}`, events (`before_provider_headers`, `after_provider_response`, `tool_call`, …).
- Never `registerProvider("anthropic"|"openai"|"openai-codex"|"xai"|"zai"|"zai-coding-cn"|"kimi-coding", { models: [...] })`. That freezes the official catalog.
- Cursor is not built-in. Register `cursor` ourselves with `refreshModels`.
- z.ai and Kimi Coding are official Pi key providers (`zai`, `zai-coding-cn`, `kimi-coding`). Do not install `pi-kimi-coder`, `pi-moonshot`, or community z.ai packages.
- Local: official llama.cpp (`LLAMA_BASE_URL`) plus first-party `refreshModels` for Ollama / LM Studio / OpenAI-compat. No `pi-ollama` community packages. No frozen local model lists.
- Exa and Perplexity research are optional and first-party REST integrations. See [`docs/research.md`](research.md). No runtime SDK or community research package. Specify/plan cannot finish without the run's `research.md` artifact.
- Plan writes `stack.json` (dune modules). Implement stays inside the current module. Vertical slices by default. See [`docs/dune-architecture.md`](dune-architecture.md).
- Implementer never writes `verdict.json` or `release.approved`.
- No Cursor-style subagents. Workers are background Pi sessions. They talk only via `communicate` (`sendUserMessage` / RPC prompt). One writer at a time. `claim_path` before edits. See [`docs/agents-bus.md`](agents-bus.md).
- Bare non-slash text with no active job is gated `/kpi` + sticky `/k-mode`. Commands are never auto-wrapped. `/kpi off` disables wrap.
- Implementer walks the minimalist ladder and records `candidate.json.ladder` before writing files. See [`docs/minimalist.md`](minimalist.md).
- Autopilot never push, deploy, force-push, `rm -rf`, production migrate, or add runtime dependencies.
- Anthropic subscription login must show the extra-usage warning once per new slot before OAuth starts.
- Answers in this repo’s own agent sessions stay short. Paths and commands, not essays.
- Footer brand is `K-π`, never bare `π`. Status bar copies Oh My Pi’s segment order. Loop overlay copies the Avid boards. See [`docs/visual-targets.md`](visual-targets.md) and https://x.com/av1dlive/status/2092622516544270781.

## Quality gates for this repo

A slice is not done until:

```bash
pnpm test
pnpm lint
pnpm typecheck
```

Plus the slice's own AC and scoped verification in [`docs/remediation-plan.md`](remediation-plan.md). Store command output in the slice's evidence, not in chat.

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
