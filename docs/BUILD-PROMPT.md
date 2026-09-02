# Agent kickoff prompt

> **The contract is [`AGENTS.md`](../AGENTS.md).** The active work queue and the only completion authority is [`remediation-plan.md`](remediation-plan.md), which names the current package itself — this prompt deliberately does not repeat that pointer, so it cannot go stale.

Paste the block below as the first message in a new coding-agent session that has this repository on disk. Paths are repository-root-relative because the agent's working directory is the repository root.

---

You are building **K-π**, a standalone coding-agent harness maintained as a fork of Pi. Brand cell **K-π**. Executable `kpi` (alias `k-pi`). Config `.kpi/` and `~/.kpi/agent/`.

This repository *is* the harness. Everything under `packages/` is our forked Pi source — K-π source, not a dependency. K-π's own runtime is `packages/coding-agent/src/kpi/`; K-π's node tests are in root `test/`. There is no `pi install`, no `package.json#pi` manifest, no peer dependency on `@earendil-works/pi-*`, and no trust gate on K-π's own commands. The control plane is a built-in extension compiled into the binary.

Read, in this order, and nothing else up front:

1. `AGENTS.md` — the contract, the read-on-demand table, the gates.
2. `docs/remediation-plan.md` — take the lowest incomplete package whose dependencies are complete.
3. Only the files that package's own `Read first` list names.

Then implement **only that package**. Load any other document when the current node needs it; the question-to-file table in `AGENTS.md` says which file answers what. `docs/roadmap.md` and `docs/implementation-plan.md` are historical and describe an architecture that no longer exists — read them only if a `Read first` list names them.

Hard rules:

- Use the harness's own extension surface (`registerCommand`, extensions, skills, themes, `registerProvider`, `refreshModels`, OAuth hooks, provider events) instead of rewriting its loaders, catalogs, sessions, or RPC. Forking is not a licence to rebuild the base.
- Prefer `packages/coding-agent/src/kpi/**`. Patching an upstream file is a recurring merge cost: justify it and record it in the `UPSTREAM.md` patched-file register.
- No runtime deps on oh-my-pi, atomic, pi-pstack, open-pstack, research SDKs, or community kimi/zai/ollama packages. Never reintroduce `pi install`, a `pi` manifest key, peer dependencies, or publish/release automation.
- Never freeze official model catalogs with a static `models` array.
- Footer brand is `K-π`. Boards match the Avid JPEGs in `docs/visual/` (information-complete, not pixel-perfect).
- Vertical slices. Folder-as-map. `research.md` before implement. Exa or Perplexity only when a key exists.
- K-stack overlay only: edit `kstack/overlay/`, never hand-edit `upstream/` or `generated/`.
- No Cursor-style subagents. Background K-π sessions + `communicate`. One writer per file. `claim_path` before edits.
- Autopilot never pushes, deploys, force-pushes, `rm -rf`s, or adds runtime deps.
- Answers stay short. Evidence goes in files, not essays.
- Run only that package's scoped `Verification` block while work is in flight. `npm run check && npm test && npm run test:kpi` runs once before a pull request. `docs/uat.md` runs last, after every package is complete.

If the PRD and the spec disagree, stop and open a `NEEDS_HUMAN` gate in `docs/remediation-plan.md` with both citations. Do not pick a winner and do not skip a package.

Visual reference: https://x.com/av1dlive/status/2092622516544270781

---
