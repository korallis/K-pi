# START HERE — k-pi

This folder is the build contract for **k-pi**, a first-party Pi coding-agent package.

Brand cell: **K-π** (never bare `π`). Package id: `k-pi`.

Drop the whole `k-pi/` tree into an empty repo. Keep `docs/` as `docs/` or copy it to `specs/000-k-pi/`. Then give an agent `docs/BUILD-PROMPT.md`.

## What you are building

A Pi package you own. A user types a task or points at a frozen plan. k-pi runs a graph-engineered loop:

```
research → specify → plan (stack.json, vertical slices) → implement → test → bounds → isolated review → ship
```

Default mode is **gated** (human before commit). **Autopilot** only when every required acceptance criterion is a command the machine can run.

The operator always sees:

- Oh My Pi-style footer, brand `K-π`
- Avid industrial boards (amber running / blue protocol pause)

LLM chat stays short. The board carries state.

## Non-negotiables

1. First-party only. Official Pi APIs. No Oh My Pi, Atomic, pi-pstack, open-pstack, third-party research clients, or community kimi/zai/ollama packages at runtime.
2. Official catalogs stay live. Never `registerProvider("anthropic"|…|{ models })`.
3. Pools: anthropic, openai, openai-codex, xai, zai, zai-coding-cn, kimi-coding, cursor, llama, ollama, lmstudio, local-openai. Research services: exa, perplexity.
4. K-stack is a vendored overlay of Cursor pstack. Commands `/setup-kstack` and `/k-mode`. No cloud agents. Models only from wired pools. Upstream replay via `pnpm kstack:sync`.
5. `/setup-kstack` suggests a role map from `model-ladder.md` (apply or tweak), then offers Exa and Perplexity keys (save either, both, or skip).
6. Frontend role: Kimi K3 first, then Fable 5. Implementer default is still Sol / GLM-5.3.
7. Specify/plan cannot finish without `research.md`. Use Exa or Perplexity if a key exists; otherwise local research.
8. Plan writes `stack.json`. Folder-as-map. Auth in `auth/`. One feature, one folder. **Vertical slices** by default.
9. No Cursor-style subagents. Background Pi sessions + `communicate`. One writer. `claim_path`.
10. Minimalist ladder before new files. Anthropic extra-usage warning once per new slot.

## Read order (agents)

1. This file
2. `docs/AGENTS.md`
3. `docs/PRD.md` — stories US-01–US-30
4. `docs/spec.md`
5. `docs/visual-targets.md` + `docs/visual/*.jpg`
6. `docs/kstack.md` + `docs/model-ladder.md`
7. `docs/research.md` + `docs/dune-architecture.md`
8. `docs/minimalist.md` + `docs/agents-bus.md`
9. `docs/roadmap.md` + `docs/implementation-plan.md` — historical baseline only
10. `docs/remediation-research.md`
11. `docs/remediation-plan.md` — active queue, RP-00 first

If PRD and spec disagree, stop. If an AC has no check, it is not executable.

## How to start building

```bash
# empty repo
git init
# unzip this pack at repo root
pnpm init   # empty repo only; this repo resumes at RP-00 in docs/remediation-plan.md
```

Do **one work package at a time**. Do not skip to K-stack or external research before the graph exists.

Visual source for the boards: https://x.com/av1dlive/status/2092622516544270781

Paste-ready agent prompt: `docs/BUILD-PROMPT.md`.
