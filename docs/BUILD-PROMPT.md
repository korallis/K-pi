# Agent kickoff prompt

> **AUTHORITY — ACTIVE QUEUE: [`docs/remediation-plan.md`](remediation-plan.md).** That file is the sole active work queue and the only completion authority. Start at **RP-00**, then take the lowest incomplete `RP-##` whose dependencies are complete, and check a DoD box only from that package's own scoped evidence.
>
> **Historical baseline only.** [`docs/roadmap.md`](roadmap.md) and [`docs/implementation-plan.md`](implementation-plan.md) are a build record. Their `[x]` checkboxes are not completion evidence and never authorize skipping a package.
>
> **Paths.** Every path in the prompt below is repository-root-relative, because the prompt is pasted into an agent whose working directory is the repository root. Links in this `docs/` copy point at the sibling file.

Paste this as the first message in a new Pi / k-pi / coding-agent session that has this repo (or this unzipped pack) on disk.

---

You are building **k-pi**, a first-party Pi coding-agent package. Brand cell **K-π**. Package id `k-pi`.

`docs/remediation-plan.md` is the sole active queue and the only completion authority. `docs/roadmap.md` and `docs/implementation-plan.md` are historical baseline only; their `[x]` boxes are not completion evidence.

Read, in order, and do not invent requirements outside them:

1. `docs/START-HERE.md`
2. `docs/AGENTS.md`
3. `docs/PRD.md`
4. `docs/spec.md`
5. `docs/visual-targets.md` and every JPEG in `docs/visual/`
6. `docs/kstack.md`
7. `docs/model-ladder.md`
8. `docs/research.md`
9. `docs/dune-architecture.md`
10. `docs/minimalist.md`
11. `docs/agents-bus.md`
12. `docs/roadmap.md` and `docs/implementation-plan.md` — historical baseline only; their checkboxes are a build record, not completion evidence
13. `docs/remediation-research.md`
14. `docs/remediation-plan.md` — the active queue; start at RP-00

Then implement **only the lowest incomplete dependency-ready work package** in `docs/remediation-plan.md`, starting at RP-00.

Hard rules:

- Official Pi APIs only (`pi.registerCommand`, extensions, skills, themes, `registerProvider`, `refreshModels`, OAuth hooks, provider events).
- No runtime deps on oh-my-pi, atomic, pi-pstack, open-pstack, research SDKs, or community kimi/zai/ollama packages.
- Never freeze official model catalogs with a static `models` array.
- Footer brand is `K-π`. Boards match the Avid JPEGs in `docs/visual/` (information-complete, not pixel-perfect).
- Vertical slices. Folder-as-map. Research.md before implement. Exa or Perplexity only when a key exists.
- K-stack overlay only: edit `kstack/overlay/`, never hand-edit `upstream/` or `generated/`.
- No Cursor-style subagents. Background Pi + communicate. One writer. claim_path.
- Autopilot never push, deploy, force-push, `rm -rf`, or add runtime deps.
- Answers stay short. Evidence goes in files, not in essays.
- After the WP: `pnpm test && pnpm lint && pnpm typecheck`, plus that package's scoped verification in `docs/remediation-plan.md`. Check the WP DoD boxes in the same change, and only from the observed result.

If PRD and spec disagree, stop and write `NEEDS_HUMAN`. Do not skip milestones.

Visual reference: https://x.com/av1dlive/status/2092622516544270781

---
