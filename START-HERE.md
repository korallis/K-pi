# START HERE — K-π

> **AUTHORITY — ACTIVE QUEUE: `docs/remediation-plan.md`.** That file is the sole active work queue and the only completion authority. Start at the lowest incomplete `RP-##` whose dependencies are complete — currently **RP-01A**, the architecture reset every later package depends on — and check a DoD box only from that package's own scoped evidence.
>
> **Historical baseline only.** `docs/roadmap.md` and `docs/implementation-plan.md` are a build record. Their `[x]` checkboxes are not completion evidence and never authorize skipping a package.
>
> **Paths.** Every path in this file is repository-root-relative. `AGENTS.md` and `docs/AGENTS.md` are mirrored copies of one contract, as are `START-HERE.md` and `docs/START-HERE.md`; if copies disagree, the repository-root copy wins.

This folder is the build contract for **K-π**, a standalone coding-agent harness maintained as a fork of Pi.

Brand cell: **K-π** (never bare `π`). Executable: `kpi` (alias `k-pi`). Config: `.kpi/` and `~/.kpi/agent/`.

This repository *is* the harness. The forked Pi base lives under `packages/`; K-π's own runtime lives in `packages/coding-agent/src/kpi/`; K-π's node tests live in root `test/`. There is no Pi to install, no package to trust, and no peer dependency. Build it and run `kpi`. Fork base, sync policy, and the patched-file register are in `UPSTREAM.md`.

## What you are building

A harness you own end to end. A user types a task or points at a frozen plan. K-π runs a graph-engineered loop:

```
research → specify → plan (stack.json, vertical slices) → implement → test → bounds → isolated review → ship
```

Default mode is **gated** (human before commit). **Autopilot** only when every required acceptance criterion is a command the machine can run.

The operator always sees:

- Oh My Pi-style footer, brand `K-π`
- Avid industrial boards (amber running / blue protocol pause)

LLM chat stays short. The board carries state.

## Non-negotiables

1. First-party only. Everything under `packages/` is our forked source, not a dependency. No Oh My Pi, Atomic, pi-pstack, open-pstack, third-party research clients, or community kimi/zai/ollama packages at runtime. Never reintroduce `pi install`, a `package.json#pi` manifest, or `@earendil-works/pi-*` peer dependencies.
2. Official catalogs stay live. Never `registerProvider("anthropic"|…|{ models })`.
3. Pools: anthropic, openai, openai-codex, xai, zai, zai-coding-cn, kimi-coding, cursor, llama, ollama, lmstudio, local-openai. Research services: exa, perplexity.
4. K-stack is a vendored overlay of Cursor pstack. Commands `/setup-kstack` and `/k-mode`. No cloud agents. Models only from wired pools. Upstream replay via `npm run kstack:sync`.
5. `/setup-kstack` suggests a role map from `docs/model-ladder.md` (apply or tweak), then offers Exa and Perplexity keys (save either, both, or skip).
6. Frontend role: Kimi K3 first, then Fable 5. Implementer default is still Sol / GLM-5.3.
7. Specify/plan cannot finish without the run's `research.md` artifact. Use Exa or Perplexity if a key exists; otherwise local research.
8. Plan writes `stack.json`. Folder-as-map. Auth in `auth/`. One feature, one folder. **Vertical slices** by default.
9. No Cursor-style subagents. Background Pi sessions + `communicate`. One writer. `claim_path`.
10. Minimalist ladder before new files. Anthropic extra-usage warning once per new slot.

## Read order (agents)

1. This file
2. `UPSTREAM.md` — fork base, sync policy, patched-file register
3. `docs/AGENTS.md`
4. `docs/PRD.md` — stories US-01–US-30
5. `docs/spec.md`
6. `docs/visual-targets.md` + `docs/visual/*.jpg`
7. `docs/kstack.md` + `docs/model-ladder.md`
8. `docs/research.md` + `docs/dune-architecture.md`
9. `docs/minimalist.md` + `docs/agents-bus.md`
10. `docs/roadmap.md` + `docs/implementation-plan.md` — historical baseline only; their checkboxes are a build record, not completion evidence
11. `docs/remediation-research.md`
12. `docs/remediation-plan.md` — active queue, RP-01A first

If PRD and spec disagree, stop. If an AC has no check, it is not executable.

## How to start building

```bash
git clone https://github.com/korallis/K-pi.git
cd K-pi
npm install          # npm workspaces; not pnpm
npm run build
node packages/coding-agent/dist/bundle/cli.js
```

`npm link --workspace @earendil-works/pi-coding-agent` puts `kpi` and `k-pi` on your `PATH`. `./kpi-test.sh` runs the harness straight from source without a build.

Do **one work package at a time**: the lowest incomplete dependency-ready `RP-##` in `docs/remediation-plan.md`, starting at RP-01A — the architecture reset that makes this repository a fork rather than a Pi package. Do not skip to K-stack or external research before the graph exists.

Visual source for the boards: https://x.com/av1dlive/status/2092622516544270781

Paste-ready agent prompt: `docs/BUILD-PROMPT.md`.
