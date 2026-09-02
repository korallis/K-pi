# START HERE — K-π

> **The contract is [`AGENTS.md`](AGENTS.md).** The active work queue and the only completion authority is `docs/remediation-plan.md`, which names the current package itself. `docs/roadmap.md` and `docs/implementation-plan.md` are historical; their `[x]` boxes are not evidence.

This repository *is* the harness: a standalone coding-agent harness maintained as a fork of Pi.

Brand cell: **K-π** (never bare `π`). Executable: `kpi` (alias `k-pi`). Config: `.kpi/` and `~/.kpi/agent/`.

The forked Pi base lives under `packages/`; K-π's own runtime lives in `packages/coding-agent/src/kpi/`; K-π's node tests live in root `test/`. There is no Pi to install, no package to trust, and no peer dependency. Build it and run `kpi`. Fork base, sync policy, and the patched-file register are in `UPSTREAM.md`.

## What you are building

A user types a task or points at a frozen plan. K-π runs a graph-engineered loop:

```
research → specify → plan (stack.json, vertical slices) → implement → test → bounds → isolated review → ship
```

Default mode is **gated** (human before commit). **Autopilot** only when every required acceptance criterion is a command the machine can run.

The operator always sees an Oh My Pi-style footer branded `K-π` and the Avid industrial boards (amber running, blue protocol pause). LLM chat stays short; the board carries state.

## Build and run

```bash
git clone https://github.com/korallis/K-pi.git
cd K-pi
npm install          # npm workspaces; not pnpm
npm run build
node packages/coding-agent/dist/bundle/cli.js
```

`npm link --workspace @earendil-works/pi-coding-agent` puts `kpi` and `k-pi` on your `PATH`. `./kpi-test.sh` runs the harness straight from source without a build.

## How to pick up work

1. Read [`AGENTS.md`](AGENTS.md).
2. Open `docs/remediation-plan.md`, take the lowest incomplete package whose dependencies are complete, and read only the files in its `Read first` list.
3. Implement that package. Run its scoped verification, not the whole suite.

Dependency-ready packages run in parallel with one writer per file — the plan's dependency map and shared-file list say which. Full gates run once before a pull request; feature acceptance (`docs/uat.md`) runs last, after every package is complete.

Everything else in `docs/` is read on demand. The question-to-file table is in [`AGENTS.md`](AGENTS.md).

Visual source for the boards: https://x.com/av1dlive/status/2092622516544270781

Paste-ready agent prompt: `docs/BUILD-PROMPT.md`.
