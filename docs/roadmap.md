> **STATUS: HISTORICAL.** Preserved as the original milestone record. Its checked boxes are not current completion evidence. Active work is in [`remediation-plan.md`](remediation-plan.md).
>
> **Superseded architecture.** This record was written when K-π shipped as a Pi package installed with `pi install -l ./`. K-π is now a standalone harness — a fork of Pi `v0.84.4`, executable `kpi`, config `.kpi/`, control plane compiled in as a built-in. Every `pi install`, package-trust, peer-dependency, and `pnpm` reference below is history, not instruction. See [`../UPSTREAM.md`](../UPSTREAM.md) and RP-01A in [`remediation-plan.md`](remediation-plan.md).

# roadmap.md — k-pi

**How to read this.** Each milestone has an exit gate. Do not start the next milestone until the gate commands and stories pass. Dates are sequence, not calendar.

Trace: stories live in `PRD.md`. Contracts live in `spec.md`. Tasks live in `implementation-plan.md`.

---

## Milestone map

```
M0 scaffold
 → M1 package + voice + amber theme + K-π status bar
 → M2 run store + log + policy + Avid status overlay
 → M3 gated loop (task + plan entry + primitives)
 → M4 autopilot graph + stop states + fixtures 2–4
 → M5 accounts + cursor + official-catalog rule + warning
 → M6 knowledge graph + board polish
 → M7 harden (resume, print profile, container notes)
 → M8 K-stack fork (setup-kstack, k-mode, playbooks, no cloud)
 → M9 minimalist + agent bus + research setup prompt
```

---

## M0 — Repo exists

**Intent.** Empty package that Pi can see.

**Exit**

- [x] `package.json` matches spec §2
- [x] `pnpm install` works
- [x] `extensions/index.ts` exports default function and registers a no-op `/kpi-ping` command that notifies `ok`
- [x] `pi install -l ./` in a scratch repo + `/trust` loads the ping command
- [x] This docs folder is copied or linked into the repo as `docs/` or `specs/000-k-pi/`

**Stories:** none yet  
**WP:** WP-00 in implementation-plan

---

## M1 — Installable product shell

**Intent.** Operator can install the package and see our theme, skills, and brevity rules. No loop yet.

**Exit**

- [x] US-01 AC-01.1–01.5
- [x] US-07 AC-07.1–07.2
- [x] Themes `loop-amber` and `protocol-blue` load
- [x] Footer idle brand is `K-π` (US-15 AC-15.1–15.3)
- [x] Templates `AGENTS.md` and `APPEND_SYSTEM.md` exist
- [x] `pnpm test && pnpm lint && pnpm typecheck` green (even if tests are thin)

**Not in M1:** graphs, accounts, widgets beyond a static “k-pi loaded” status and the K-π footer.

---

## M2 — Control plane files

**Intent.** A manual three-step job can write the run directory, hash-chain events, and deny `git push` without any graph engine.

**Exit**

- [x] US-14 AC-14.1–14.3
- [x] US-13 AC-13.1 (deny list live)
- [x] `/kpi status` reads files and does not call a model (US-06 AC-06.6 partial)
- [x] Overlay lists stages 01–08 and the six file lamps (US-16 start)
- [x] Field presence tests, not pixel tests (US-25)
- [x] Atomic write helper unit tests pass
- [x] Hash-chain unit tests pass

**Not in M2:** agent nodes.

---

## M3 — Gated coding loop

**Intent.** `/kpi <task>` and `/kpi --plan <path>` run specify/plan/implement/test/bounds/review/human/ship.

**Exit**

- [x] US-02 all AC
- [x] US-03 all AC
- [x] US-05 AC-05.3, AC-05.6 (round cap + retry≠round)
- [x] US-08 all AC
- [x] Fixture `healthcheck-gated` reaches human confirm with green gates (M-01)
- [x] Reviewer cannot write files
- [x] Implementer never writes `verdict.json`
- [x] Bare text auto-wraps to gated `/kpi` + `/k-mode` (US-24) — superseded 2026-09-02 by agent-decided routing (`kpi_start_job`, `kpi.routing`); see `fixes.md` FX-03
- [x] Specify/plan write research.md (US-29)
- [x] Plan writes stack.json (US-30)

**Not in M3:** autopilot graph file loaded for real jobs.

---

## M4 — Autopilot

**Intent.** Executable AC can finish without a human. Bad AC cannot.

**Exit**

- [x] US-04 all AC
- [x] US-05 all AC
- [x] Fixtures `healthcheck-auto`, `narrative-ac`, `bounds-violation` (M-02, M-03, M-04)
- [x] `release.approved` written only by set node
- [x] Push still denied

**Not in M4:** multi-account.

---

## M5 — Accounts, Cursor, catalogs

**Intent.** Stack seats. Fail over. New official models still appear. Warning once per Anthropic slot.

**Exit**

- [x] US-10 all AC
- [x] US-11 all AC
- [x] US-12 all AC
- [x] Fixture `accounts-failover` (M-05)
- [x] `registerProvider` for official ids never includes `models`
- [x] Cursor `refreshModels` implemented (live or clearly stubbed behind a flag with fallback list)
- [x] Accounts widget shows per-slot %

**Not in M5:** knowledge graph.

---

## M6 — Knowledge graph + board complete

**Intent.** Screenshot-faithful board. Claims persist.

**Exit**

- [x] US-06 all remaining AC (theme switch on human pause, custom event renderers)
- [x] US-09 all AC
- [x] US-07 AC-07.3 (800 char fixture)
- [x] `/kpi status` overlay matches the widget fields and the Avid boards

---

## M7 — Harden

**Intent.** Crash safety and unattended notes.

**Exit**

- [x] US-14 AC-14.4 resume after kill mid-implementer
- [x] Read-only print profile documented and tested (`pi -p` cannot take write tools)
- [x] README section: Docker / Gondolin is the sandbox; we do not pretend otherwise
- [x] Idempotent ship: second ship does not create a second commit if job marker exists

---

## M8 — K-stack

**Intent.** Vendored fork of Cursor pstack. Branded K-stack. Models only from k-pi pools. No cloud agents.

**Exit**

- [x] US-17, US-18, US-19, US-20, US-21
- [x] `/setup-kstack` and `/k-mode` work after `pi install -l ./`
- [x] Feature playbook cannot complete ship without a fresh approved verdict
- [x] Runtime `kstack/` grep clean of cloud agent / `gt submit` / `subagent_type`
- [x] Board shows `K-STACK on` when mode is sticky
- [x] NOTICE credits Lauren Tan / Cursor MIT pstack
- [x] `kstack/UPSTREAM.md` pin present
- [x] `pnpm kstack:sync --check` exists and is in CI
- [x] `/setup-kstack` offers Exa and Perplexity keys with skip (US-28)
- [x] Broken-patch fixture fails the sync without touching generated/

**Depends on:** M3 graph + M5 registry. Skill text rewrite can start after M1.

---

## M9 — Minimalist + agent bus

**Intent.** Stop over-engineering. Replace subagents with background Pi + communicate.

**Exit**

- [x] US-22, US-23
- [x] `skills/minimalist/SKILL.md` present with NOTICE
- [x] `spawn_background` + `communicate` tools exist
- [x] Third worker spawn denied
- [x] Forbidden-dep test includes community bus packages

**Depends on:** M2 events + M3 implementer node.

---

## Explicitly later / out of roadmap v1

- Worktree-per-job
- Cross-process in-flight caps
- Obsidian vault projection as source of truth
- Auto push to origin
- Swarm fan-out > 2

---

## Dependency rules

- M4 must not start until M3 fixture is boring.
- M5 balancer must not ship if official `models` arrays are being overwritten. That is a release blocker.
- M7 resume depends on M3 checkpoints existing.
- UI polish in M6 may start in parallel with M5 after M3 widgets exist.
- M8 must not ship if it `pi install`s pstack, open-pstack, or pi-pstack.
