> **STATUS: HISTORICAL.** Preserved as the original build record. Its checked boxes are not current completion evidence. Do not execute this queue; use [`remediation-plan.md`](remediation-plan.md).
>
> **Superseded architecture.** This record was written when K-π shipped as a Pi package installed with `pi install -l ./`. K-π is now a standalone harness — a fork of Pi `v0.84.4`, executable `kpi`, config `.kpi/`, control plane compiled in as a built-in. Every `pi install`, package-trust, peer-dependency, and `pnpm` reference below is history, not instruction. See [`../UPSTREAM.md`](../UPSTREAM.md) and RP-01A in [`remediation-plan.md`](remediation-plan.md).

# implementation-plan.md — k-pi

**How agents use this file.** Pick the lowest incomplete WP. Implement only that WP. Run its tests. Do not start the next WP until its DoD checklist is checked. Update this file’s checkboxes in the same change.

IDs: `WP-##`. Stories: `US-##` in `PRD.md`. Contracts: `spec.md`.

---

## WP-00 — Scaffold

**Milestone:** M0  
**Stories:** —

### Create

- `package.json` per spec §2
- `tsconfig.json` strict
- `extensions/index.ts` default export
- `extensions/ping.ts` command `/kpi-ping`
- `pnpm` scripts: `test`, `lint`, `typecheck`
- Copy `docs/` from this folder into the repo

### Tests

- Load extension factory without throwing
- `package.json` parse: has `pi` key, has `pi-package` keyword, forbidden deps absent

### DoD

- [x] `pi install -l ./` in a temp dir + ping command works
- [x] Quality gates green

---

## WP-01 — Templates, theme, voice

**Milestone:** M1  
**Stories:** US-01, US-07

### Create

- `templates/AGENTS.md`
- `templates/APPEND_SYSTEM.md` (brevity + extra-usage pointer + no SYSTEM.md replacement)
- `templates/context-pack/{product,structure,tech}.md`
- `themes/loop-amber.json` tokens from spec §11
- `themes/protocol-blue.json`
- `skills/concise-output/SKILL.md`
- `prompts/specify.md` stub is fine

### Tests

- Theme JSON matches required keys `accent`, `success`, `error`, `warning`
- Amber accent equals `#ff6a1a`
- Blue accent equals `#3da9fc`
- `APPEND_SYSTEM.md` does not say it replaces the default system prompt
- Forbidden: a `SYSTEM.md` in templates/

### DoD

- [x] AC-01.3, AC-07.1, AC-07.2
- [x] `/settings` can select `loop-amber`

---

## WP-01b — K-π status bar

**Milestone:** M1  
**Stories:** US-15  
**Look at first:** `visual-targets.md`, `visual/omp-statusbar-codemod.jpg`, `visual/omp-statusbar-collab.jpg`

### Create

- `extensions/status-line/index.ts`
- `extensions/status-line/segments.ts` — brand, model, thinking, path, git, context_pct, cost, request
- `extensions/status-line/brand.ts` — idle `K-π`, working spinner + timer
- Command `/statusbar`

### Tests

- Brand renderer idle unicode === `K-π`
- Brand renderer does not return bare `π`
- Default segment order matches spec
- Subscription slot formats cost as `(sub)`
- Package does not depend on oh-my-pi or pi-*-footer packages

### DoD

- [x] AC-15.1–15.5, AC-15.8, AC-15.9
- [x] Footer visible after `pi install -l ./` in a scratch repo

---

## WP-02 — Run store + hash chain

**Milestone:** M2  
**Stories:** US-14

### Create

- `extensions/run-store.ts` — createJob, atomicWrite, readJob
- `extensions/append-log.ts` — appendEvent, verifyChain
- `schemas/{task,evidence,verdict,event}.schema.json`

### Tests

- atomicWrite: crash between write and rename leaves no half `candidate.json` (tmp allowed)
- hash chain: three events verify; mutating event 2 fails verify
- redaction: string containing `sk-ant-` is not stored raw

### DoD

- [x] AC-14.1, AC-14.2, AC-14.3
- [x] Types exported for task/evidence/verdict

---

## WP-03 — Policy hook

**Milestone:** M2  
**Stories:** US-13

### Create

- `extensions/policy.ts`
- `templates/policy.json` copied to consumer `.pi/policy.json`

### Tests

- `git push origin main` denied
- `rm -rf /` denied
- `git status` allowed
- write to `.env` denied
- write inside fixture `write_allow` allowed

### DoD

- [x] AC-13.1
- [x] Hook registered in `extensions/index.ts` on `tool_call`

---

## WP-04 — Status overlay (files only)

**Milestone:** M2  
**Stories:** US-06 partial

### Create

- `extensions/control-plane.ts` commands `/kpi`, `/kpi status`, `/kpi stop`, `/loop` alias
- `extensions/renderers.ts` stub for event types
- Widget factory reading `state.json` if present else “no job”

### Tests

- `/kpi status` with no job: message “no active job”, no provider request
- `/kpi stop` writes terminal `BLOCKED` event
- overlay string includes `K-π` and stage labels 01–08 when a job exists

### DoD

- [x] AC-06.6 for the no-model rule
- [x] Widget does not call `setModel` or start an agent

---

## WP-05 — AC compiler

**Milestone:** M3  
**Stories:** US-02, US-04

### Create

- `extensions/graph/ac-compiler.ts` (pure functions + optional agent node later)
- Quality scoring: executable / partial / narrative

### Tests

- Input “add healthcheck; cmd pnpm test exits 0; writes only src/health.ts and tests/health.test.ts” → `executable`
- Input “make auth nicer” → `narrative`
- Input mixed → `partial` and lists missing checks

### DoD

- [x] AC-04.1 scoring works as a unit, even before the auto graph exists

---

## WP-06 — Graph engine v1

**Milestone:** M3  
**Stories:** US-02

### Create

- `extensions/graph/schema.ts` types
- `extensions/graph/engine.ts` superstep, set nodes, human confirm, agent node via `createAgentSession`
- `graphs/coding-loop.gated.json`

### Tests

- set node writes state path
- human node pauses and resume with `true` continues
- isolated reviewer session is not the coder thread
- readOnly agent cannot register write tools

### DoD

- [x] Engine loads gated graph
- [x] Checkpoints written under `.pi/runs/<id>/graph/`

---

## WP-07 — Gated loop wiring

**Milestone:** M3  
**Stories:** US-02, US-03, US-08

### Create

- `/kpi` and `/kpi --plan` (`/loop` alias)
- `graphs/spec-first.json` optional
- skills: spec-first, tdd-cycle, isolated-review, quality-gates, conventional-commit, context-pack
- prompts: specify, plan, implement, review, verify, ship
- fixture `fixtures/healthcheck-gated/`

### Tests

- Integration: loop on fixture reaches human confirm
- `--plan` skips specify (assert specify node not in executed list)
- Reviewer output validates against verdict schema or retries
- Ship commit message matches `^(feat|fix|docs|refactor|test|chore)(\(.+\))?: `

### DoD

- [x] US-02, US-03, US-08
- [x] Metric M-01

---

## WP-08 — Stop rules shared by both modes

**Milestone:** M3–M4  
**Stories:** US-05

### Create

- `extensions/graph/stop.ts`

### Tests

- fingerprint repeat → `NO_PROGRESS`
- round 3 fail → `EXHAUSTED`
- retry after fake 429 does not increment round

### DoD

- [x] AC-05.2, AC-05.3, AC-05.6

---

## WP-09 — Autopilot graph

**Milestone:** M4  
**Stories:** US-04, US-05

### Create

- `graphs/coding-loop.auto.json`
- `release.set` node
- mode picker in `/kpi --mode`
- fixtures `healthcheck-auto`, `narrative-ac`, `bounds-violation`

### Tests

- narrative + `--mode autopilot` does not start auto graph; writes `ac.refused`
- auto happy path: no human node executed; `DONE`; one commit
- edit outside allow → `UNSAFE`, no commit
- implementer process cannot write `verdict.json` (file writer guard)

### DoD

- [x] US-04, remaining US-05
- [x] Metrics M-02, M-03, M-04

---

## WP-10 — Accounts store + warning

**Milestone:** M5  
**Stories:** US-10, US-12

### Create

- `extensions/accounts/store.ts`
- `extensions/accounts/index.ts` commands `/accounts`, `/accounts login`, `/accounts logout`
- Anthropic warning copy exact from spec §13
- secrets file 0600

### Tests

- login cancel → no slot
- login accept → `warningAcceptedAt` set; second login same slot does not confirm again
- two anthropic slots coexist
- store file mode is 0600 on posix

### DoD

- [x] AC-10.1, AC-10.2
- [x] US-12 all AC

---

## WP-11 — Balancer + classifier

**Milestone:** M5  
**Stories:** US-10, US-11, US-26

### Create

- `extensions/accounts/errors.ts`
- `extensions/accounts/balancer.ts`
- `extensions/accounts/usage/{anthropic,openai-codex,xai,cursor}.ts` (stub usage readers allowed if they fail open to round-robin)
- hooks `before_provider_headers`, `after_provider_response`
- fixture `accounts-failover`

### Tests

- classifier: 429 + “usage limit” → cooldown
- two slots, A cooling, B healthy → B selected 100/100 times
- official provider register overlays in this WP MUST NOT include `models`
- static unit: fallback chain default anthropic → openai-codex → xai → zai → kimi-coding → cursor

### DoD

- [x] AC-10.4–10.8
- [x] AC-11.1
- [x] Metric M-05

---

## WP-12 — Cursor provider

**Milestone:** M5  
**Stories:** US-10, US-11

### Create

- `extensions/cursor/oauth.ts`
- `extensions/cursor/provider.ts` with `refreshModels`
- fallback model list documented as fallback

### Tests

- provider id is `cursor`
- `refreshModels` returns an array (mock HTTP)
- no import of `pi-cursor-oauth` or `@pi-stef/cursor`

### DoD

- [x] AC-11.2
- [x] `/login` lists Cursor after package load (manual note in README if OAuth cannot be unit-tested)

---

## WP-13 — Accounts widget + failover event

**Milestone:** M5–M6  
**Stories:** US-06, US-10

### Create

- widget lines per spec §11
- EVT `accounts.failover` renderer

### Tests

- widget string includes two slot names when two exist
- widget string does not contain a single unlabeled combined percent as the only percent
- failover appends event type `accounts.failover`

### DoD

- [x] AC-10.7
- [x] AC-06.4

---

## WP-14 — Knowledge graph

**Milestone:** M6  
**Stories:** US-09

### Create

- `extensions/kg/store.ts`
- `extensions/kg/index.ts` tools + `/kg query` `/kg propose`
- inbox accept path snapshots first

### Tests

- two parallel propose files do not interleave corrupt JSONL (lock or serialize)
- accepted patch bumps `rev`
- worker cannot write `nodes.jsonl` directly through the public tool (inbox only)

### DoD

- [x] US-09

---

## WP-15 — Board complete + concise fixture

**Milestone:** M6  
**Stories:** US-06, US-07

### Create

- theme switch on human pause
- full `/kpi status` overlay (Avid board geometry)
- remaining event renderers
- fixture asserting assistant message length if harness allows; else a renderer unit that prefers verdict fields

### Tests

- human pause → active theme name `protocol-blue`
- resume → `loop-amber`
- overlay fields include MODE, ROUND, STAGE, GATE, FILES

### DoD

- [x] US-06 complete
- [x] AC-07.3 or documented equivalent unit

---

## WP-16 — Resume + idempotent ship

**Milestone:** M7  
**Stories:** US-14

### Create

- resume path `/loop` on existing job_id
- ship node checks job marker in latest commit message or `state.json.status == DONE`

### Tests

- kill after implementer checkpoint; resume does not re-run completed plan node
- ship twice → one commit

### DoD

- [x] AC-14.4
- [x] README unattended / container paragraph

---

## WP-17 — Print profile + docs freeze

**Milestone:** M7  
**Stories:** G-10

### Create

- documented `pi -p` profile that sets active tools to read-only
- README: install, `/kpi` examples, accounts warning, `pi update --models`, non-goals, X post link, `K-π` brand
- Keep `AGENTS.md` at package root in sync with `docs/AGENTS.md`

### Tests

- print profile tool list excludes `write`, `edit` unless job is already in an approved implementer context (v1: exclude always in print)

### DoD

- [x] README examples match PRD WF-01–WF-05
- [x] All M7 roadmap boxes can be ticked
- [x] Quality gates green on main

---

## WP-18 — K-stack fork

**Milestone:** M8  
**Stories:** US-17–US-20  
**Read first:** `kstack.md`, https://github.com/cursor/plugins/tree/main/pstack

### Create

- `kstack/NOTICE` (MIT upstream credit)
- `kstack/models.ts` + `/setup-kstack` command
- `kstack/mode.ts` + `/k-mode` sticky flag
- Rewritten playbooks under `kstack/playbooks/` (feature, bug-fix, investigation, shipping, autonomous-run minimum)
- Rewritten principles including the four graph principles
- `k-agent` isolated agent definition
- Cloud-stripped stubs for autopilot-full / autopilot-stack that cannot merge

### Tests

- setup writes only slugs from a fake registry
- setup rejects an unknown slug
- k-mode feature match + first todo is principles
- ship todo blocked without verdict.approved
- `rg -n "cloud agent|gt submit|subagent_type|cursor-team-kit" kstack/` empty except NOTICE
- package.json forbidden-dep test includes pstack, open-pstack, pi-pstack

### DoD

- [x] US-17–US-20
- [x] Operator strings say K-stack / K-mode

---

## WP-19 — Upstream sync overlay

**Milestone:** M8  
**Stories:** US-21  
**Read first:** `kstack.md` §2

### Create

- `kstack/UPSTREAM.md`
- `kstack/overlay/rename-map.json`
- `kstack/overlay/transforms.ts`
- `kstack/overlay/forbidden.txt`
- `kstack/overlay/patches/` (may start empty)
- `kstack/scripts/sync-kstack.ts`
- package scripts `kstack:sync` and `kstack:sync:check`
- fixture: a patch that does not apply

### Tests

- sync --pin of a recorded sha produces generated/ with `/k-mode` and no `cloud agent`
- second sync of the same sha is a no-op
- failing patch leaves generated/ bytes unchanged
- --check fails if generated/ is hand-edited

### DoD

- [x] US-21
- [x] AGENTS.md says do not edit upstream/ or generated/ by hand

---

## WP-20 — Minimalist skill

**Milestone:** M9  
**Stories:** US-22  
**Read first:** `minimalist.md`

### Create

- `skills/minimalist/SKILL.md` (adapted from Rezvani, MIT NOTICE)
- implementer writes `candidate.json.ladder`
- bounds check: new runtime dep not in task.json fails

### Tests

- fixture “helper class for one concat” → no new file
- missing ladder field fails implementer DoD

### DoD

- [x] US-22

---

## WP-21 — Background Pi + communicate

**Milestone:** M9  
**Stories:** US-23  
**Read first:** `agents-bus.md`

### Create

- `extensions/bus/spawn.ts`
- `extensions/bus/communicate.ts`
- `.pi/runs/<job>/bus.jsonl` + `agents/`
- replace isolated reviewer with spawned reviewer session

### Tests

- spawn two workers, third denied
- communicate followUp appears in worker session
- parent test reads verdict.json not transcript
- package.json excludes pi-intercom, pi-mesh, pi-agents-talk-to-each-other, pi-bus, pi-side-agents
- second writer spawn denied
- second claim_path on same file denied; released after holder exit

### DoD

- [x] US-23 including AC-23.7/8
- [x] kstack swarm/arena call these tools

---

## WP-22 — Default wrap + version pin + TUI honesty

**Milestone:** M2–M3  
**Stories:** US-24, US-25

### Create

- session_start hook: bare text → gated `/kpi` + `/k-mode` when autoWrap and no job
- `/kpi off` clears autoWrap
- `package.json` peerDependencies `>=0.84.0`; CI installs `0.84.4`
- visual-targets honesty note already in docs; widget tests assert field presence, not pixels

### Tests

- bare "add healthcheck" starts a gated job
- `/accounts` is not wrapped
- follow-up during a job does not start a second job
- `/kpi off` then bare text does not start a job

### DoD

- [x] US-24, US-25
- [x] peer + CI pin documented in README

---

## WP-23 — External research gate + dune stack

**Milestone:** M3 (gates), M8 (setup prompt)  
**Stories:** US-28, US-29, US-30  
**Read first:** `research.md`, `dune-architecture.md`

### Create

- `extensions/research/exa.ts` — first-party Search and Contents REST client
- `extensions/research/perplexity.ts` — first-party Search REST client
- tools: `exa_search`, `exa_contents`, `pplx_search`
- specify/plan refuse to complete without research.md
- plan writes stack.json; implement bound to current module
- `/setup-kstack` Exa and Perplexity save/skip steps

### Tests

- no key → research.mode local, implement still blocked until research.md exists
- Exa key → `exa_search` called before plan completes (mock HTTP)
- Perplexity-only key → `pplx_search` called before plan completes (mock HTTP)
- 402/429 from the preferred service tries the other configured service, then local
- result cap 10 enforced
- claim_path outside module → UNSAFE
- top-level utils/helpers/common/misc without purpose → plan gate fail
- auth written under src/lib instead of src/auth → UNSAFE
- scaffold creates folder + interface + test twin before behaviour
- package.json excludes Exa and Perplexity SDK runtime dependencies

### DoD

- [x] US-28, US-29, US-30

---

## Suggested agent batching

If one agent session should do more than one WP, only combine inside a milestone:

- M1: WP-00 + WP-01 + WP-01b
- M2: WP-02 + WP-03 + WP-04 (+ US-25 field checks)
- M3: WP-05 + WP-06 + WP-07 + WP-08 + WP-22 wrap + WP-23 gates
- M9: WP-20 + WP-21 (leases in WP-21)
- M4: WP-09
- M5: WP-10 + WP-11 + WP-12
- M6: WP-13 + WP-14 + WP-15
- M7: WP-16 + WP-17
- M8: WP-18 + WP-19
- M9: WP-20 + WP-21

Do not combine M3 and M4 in one session.

---

## Definition of done for the whole product

All of:

1. Roadmap M0–M7 exit boxes checked
2. PRD metrics M-01–M-07
3. `pnpm test && pnpm lint && pnpm typecheck` green
4. No forbidden runtime deps
5. No official provider `models` overlay in source (`rg 'registerProvider\\(\"(anthropic|openai|openai-codex|xai)\"' -n` reviewed)
6. Anthropic warning string present verbatim
7. Autopilot cannot `git push`
8. Docs in this folder still match the code; if they drift, update docs in the same PR
