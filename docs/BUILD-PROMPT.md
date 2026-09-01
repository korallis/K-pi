# Agent kickoff prompt

> **AUTHORITY — ACTIVE QUEUE: [`docs/remediation-plan.md`](remediation-plan.md).** That file is the sole active work queue and the only completion authority. Start at the lowest incomplete `RP-##` whose dependencies are complete — currently **RP-01A**, the architecture reset every later package depends on — and check a DoD box only from that package's own scoped evidence.
>
> **Historical baseline only.** [`docs/roadmap.md`](roadmap.md) and [`docs/implementation-plan.md`](implementation-plan.md) are a build record. Their `[x]` checkboxes are not completion evidence and never authorize skipping a package.
>
> **Paths.** Every path in the prompt below is repository-root-relative, because the prompt is pasted into an agent whose working directory is the repository root. Links in this `docs/` copy point at the sibling file.

Paste this as the first message in a new coding-agent session that has this repository on disk.

---

You are building **K-π**, a standalone coding-agent harness maintained as a fork of Pi. Brand cell **K-π**. Executable `kpi` (alias `k-pi`). Config `.kpi/` and `~/.kpi/agent/`.

This repository *is* the harness. Everything under `packages/` is our forked Pi source — K-π source, not a dependency. K-π's own runtime is `packages/coding-agent/src/kpi/`; K-π's node tests are in root `test/`. K-π is not a Pi package: there is no `pi install`, no `package.json#pi` manifest, no peer dependency on `@earendil-works/pi-*`, and no trust gate on K-π's own commands. The control plane is a built-in extension compiled into the binary.

`docs/remediation-plan.md` is the sole active queue and the only completion authority. `docs/roadmap.md` and `docs/implementation-plan.md` are historical baseline only; their `[x]` boxes are not completion evidence.

Read, in order, and do not invent requirements outside them:

1. `docs/START-HERE.md`
2. `UPSTREAM.md` — fork base, sync policy, patched-file register
3. `docs/AGENTS.md`
4. `docs/PRD.md`
5. `docs/spec.md`
6. `docs/visual-targets.md` and every JPEG in `docs/visual/`
7. `docs/kstack.md`
8. `docs/model-ladder.md`
9. `docs/research.md`
10. `docs/dune-architecture.md`
11. `docs/minimalist.md`
12. `docs/agents-bus.md`
13. `docs/roadmap.md` and `docs/implementation-plan.md` — historical baseline only; their checkboxes are a build record, not completion evidence
14. `docs/remediation-research.md`
15. `docs/remediation-plan.md` — the active queue; start at RP-01A

Then implement **only the lowest incomplete dependency-ready work package** in `docs/remediation-plan.md`, starting at RP-01A.

Hard rules:

- Use the harness's own extension surface (`registerCommand`, extensions, skills, themes, `registerProvider`, `refreshModels`, OAuth hooks, provider events) instead of rewriting its loaders, catalogs, sessions, or RPC. Forking is not a licence to rebuild the base.
- Prefer `packages/coding-agent/src/kpi/**`. Patching an upstream file is a recurring merge cost: justify it and record it in the `UPSTREAM.md` patched-file register.
- No runtime deps on oh-my-pi, atomic, pi-pstack, open-pstack, research SDKs, or community kimi/zai/ollama packages. Never reintroduce `pi install`, a `pi` manifest key, peer dependencies, or publish/release automation.
- Never freeze official model catalogs with a static `models` array.
- Footer brand is `K-π`. Boards match the Avid JPEGs in `docs/visual/` (information-complete, not pixel-perfect).
- Vertical slices. Folder-as-map. Research.md before implement. Exa or Perplexity only when a key exists.
- K-stack overlay only: edit `kstack/overlay/`, never hand-edit `upstream/` or `generated/`.
- No Cursor-style subagents. Background K-π sessions + communicate. One writer. claim_path.
- Autopilot never push, deploy, force-push, `rm -rf`, or add runtime deps.
- Answers stay short. Evidence goes in files, not in essays.
- After the WP: `npm run check && npm test && npm run test:kpi`, plus that package's scoped verification in `docs/remediation-plan.md`. Check the WP DoD boxes in the same change, and only from the observed result.

If PRD and spec disagree, stop and write `NEEDS_HUMAN`. Do not skip milestones.

Visual reference: https://x.com/av1dlive/status/2092622516544270781

---
