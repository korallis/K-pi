# PRD — k-pi

**Status:** Draft for implementation  
**Product:** K-π — a standalone coding-agent harness, maintained as a fork of Pi `v0.84.4` (base commit `b79e4cc`)  
**Brand cell:** `K-π` (never bare `π`)  
**Audience:** Coding agents and the humans who review them  
**Contract:** [`../AGENTS.md`](../AGENTS.md) is the only normative project contract.  
**Companion docs, read on demand:** `../START-HERE.md`, `BUILD-PROMPT.md`, `../UPSTREAM.md`, `spec.md`, `kstack.md`, `model-ladder.md`, `research.md`, `dune-architecture.md`, `minimalist.md`, `agents-bus.md`, `visual-targets.md`, `uat.md`  
**Active queue:** [`docs/remediation-plan.md`](remediation-plan.md) is the only active implementation queue and names the current package itself; start at the lowest incomplete `RP-##` whose dependencies are complete. Research and gap register: [`remediation-research.md`](remediation-research.md).  
**Feature acceptance:** [`uat.md`](uat.md), after every package and the full gates.  
**Historical, non-authoritative:** `roadmap.md` and `implementation-plan.md` are historical build records. Their checked boxes are not completion evidence.  
**Visual sources:** https://x.com/av1dlive/status/2092622516544270781 · `visual/omp-statusbar-codemod.jpg` · `visual/omp-statusbar-collab.jpg`  
**ID prefix:** `PRD-1`

---

## 1. Problem

Most agent setups fail because nobody owns the return path, the shared state, or the approval boundary. The user wants one Pi harness that:

- Takes a **task** or a **finished plan**
- Runs a full engineering loop with graph-engineering control (not a swarm)
- Bakes in software-engineering primitives so the user does not have to remember to ask
- Keeps the user informed via a control-board TUI
- Can run **without a human** when acceptance criteria are executable
- Stacks Anthropic / OpenAI / Grok / Cursor subscriptions and fails over when one hits a limit
- Is built by us on the forked harness's own plugin APIs so new official models appear automatically

## 2. Goals

| ID | Goal |
|---|---|
| G-01 | A user can start from a task and get specify → plan → implement → test → review → ship |
| G-02 | A user can start from a frozen plan and skip specify |
| G-03 | Gated mode is the default; human confirms commit |
| G-04 | Explicit autopilot delegates initial non-weakening intent refinement and release; `DONE` still requires every protected AC, quality and journey goal verified for the exact candidate |
| G-05 | Autopilot pauses before engineering when refined required AC lack executable checks/bounds or product decisions remain unresolved |
| G-06 | TUI always shows stage, round, mode, gate, run files, and account route |
| G-07 | Assistant replies are short; the board carries state |
| G-08 | Multiple Anthropic / OpenAI / Codex / xAI / Cursor seats can be pooled and failed over |
| G-09 | Official Anthropic, OpenAI, Codex, and xAI model catalogs are never replaced by a static list |
| G-10 | First-party code only. Everything under `packages/` is our forked source; no Oh My Pi / Atomic / community multi-account / community Cursor at runtime |
| G-11 | Anthropic subscription login shows the extra-usage warning once per new slot |
| G-12 | Footer matches Oh My Pi’s status bar; leftmost brand is `K-π` |
| G-13 | Jobs-first terminal home with retained graph detail and widget; cool machine work, warm human intervention |
| G-14 | K-stack (forked pstack) is embedded: `/setup-kstack` + `/k-mode` |
| G-15 | K-stack workers use only k-pi-wired models. No Cursor Cloud agents |
| G-16 | z.ai, Kimi Coding, and local llama/Ollama/LM Studio are first-class pools |
| G-17 | Optional Exa, Perplexity, and Firecrawl research. Research.md required before implement |
| G-18 | Explicit feature/path ownership with vertical slices by default, preserving existing language and layout |
| G-19 | `/setup-kstack` suggests a role map; frontend prefers Kimi K3 |
| G-20 | Background Pi workers + communicate. No subagents |

## 3. Non-goals

| ID | Non-goal |
|---|---|
| NG-01 | Being installable into another harness, or shipping as a Pi package. K-π is a fork with its own executable; upstream stays upstream |
| NG-02 | Depending on Oh My Pi, Atomic, pi-graph, pi-multi-account, pi-multi-pass, or community Cursor packages |
| NG-03 | A native knowledge-graph database. File-backed JSONL is the v1 store |
| NG-04 | OS sandboxing. Isolation is documented Docker/Gondolin, not promised in-process |
| NG-05 | Blanket autopilot permission for external effects, deploy, production migrate, spend or secret access; the narrowly approved job-branch delivery path is not general authority |
| NG-06 | 128-way swarms or unbounded fan-out |
| NG-07 | Pretending extra Anthropic usage is the in-app Max 5-hour bar |
| NG-08 | Replacing Pi’s default system prompt via `SYSTEM.md` |
| NG-09 | Installing or wrapping Cursor pstack, open-pstack, or pi-pstack |
| NG-10 | Cursor Cloud agents, Graphite `gt` land, Bugbot as a required step |

## 4. Users and jobs

| Actor | Job |
|---|---|
| Operator | Starts a loop, watches the board, approves gated ships, attaches subscription seats |
| Implementer node | Writes the smallest change that can go green |
| Host verifier | Executes exact protected AC/quality commands, seals full-output receipts and derives candidate-bound goal coverage |
| Reviewer node | Isolated, read-only, schema-validated verdict |
| Autopilot release | Deterministic `set` node, not a model |
| Human | Gated initial intent consent and release; unresolved product decisions, changed accepted success, credential access and external authority |

## 5. Modes

| Mode | Entry | Ship gate | When allowed |
|---|---|---|---|
| `gated` | Default | Human confirm | Always |
| `autopilot` | Explicit `--mode autopilot` or `--until-green` | Deterministic `release.set`, after final host verification | Derived required AC executable with bounds, no unresolved product questions, retained policy authority |

Print/CI uses the auto graph's `policy.allowNonInteractive` and `allowNonInteractiveMutations`; these do not authorize arbitrary external actions. Ship makes the one job commit and, when `origin` exists and the scoped release/policy conditions allow it, delivers only the job branch and its pull request. Missing delivery prerequisites remain operator-visible rather than a successful `DONE`.

## 6. User stories and acceptance criteria

Each AC is written so a later agent can turn it into a check. IDs are stable.

RP-22 migrates the criteria below to rigid accepted intent and fluid execution. These descriptions are not checked completion claims for the full mandate. Scoped records in `.kpi/proof/RP-22` include successful offline build and built-harness startup smoke; they do not establish live provider/credential, external delivery or end-user journey proofs.

### US-01 — Build and run the harness

**Story.** As an operator, I build this repository from source and run `kpi`; K-π's commands, theme, and skills are present at startup with no install step.

- **AC-01.1** `npm install && npm run build` at the repository root produces the harness bundle; `node packages/coding-agent/dist/bundle/cli.js --version` runs it.
- **AC-01.2** `packages/coding-agent/package.json` declares exactly the bins `kpi` and `k-pi` (no `pi` bin) and `piConfig` `{ name: "kpi", title: "K-π", configDir: ".kpi" }`, so config resolves to `.kpi/` and `~/.kpi/agent/`.
- **AC-01.3** On a first start in an untrusted scratch repository, `/kpi`, `/loop` (alias of `/kpi`), `/accounts`, `/specify`, `/plan`, `/review`, `/verify`, `/ship`, and `/statusbar` exist in command completion without `/trust` and without any install command.
- **AC-01.4** Theme `loop-amber` is selectable in `/settings`, and K-π's prompts, skills, themes, and graphs are present in `dist` because the built-in extension declares them — not because a `package.json#pi` manifest was loaded.
- **AC-01.5** No manifest in the repository declares `keywords: ["pi-package"]`, a `pi` key, or `peerDependencies` on `@earendil-works/pi-*`; K-π is never installable into another harness.
- **AC-01.6** No manifest lists oh-my-pi, atomic, pi-graph, pi-multi-account, pi-multi-pass, or pi-cursor-* as dependencies.

### US-02 — Start from a task (gated)

**Story.** As an operator, I type `/kpi <goal>` (or `/loop <goal>`), explicitly accept the derived desired state, and let execution adapt through planning, implementation, host verification and isolated review before I approve the exact candidate for release.

- **AC-02.1** A directory `.kpi/runs/<job_id>/` contains `task.json`, `intent.json`, `intent-history/revision-1.json`, `context.md` and `events.jsonl`. The host protects the original request before execution.
- **AC-02.2** The task snapshot carries `goal`, `acceptance[]`, `nongoals`, `constraints` and `quality_gates`. Its protected intent hash excludes only the execution slice `current_module_id`; editing the snapshot cannot redefine completion.
- **AC-02.3** Before planning/implementation, specify or plan-check proposes additive users, journeys, requirements, engineering constraints, testing criteria and definition of done. Existing acceptance and bounds cannot be weakened. Explicit autopilot may accept a question-free executable refinement by delegation; unresolved decisions or non-executable required AC pause rather than becoming green.
- **AC-02.4** Implementer tools include write/edit/bash. Planner, specify/plan-check and reviewer are product-read-only. The engine publishes schema-validated proposal/plan responses; the review worker publishes only its declared `verdict.json` through `write_contract`. Host `verify` nodes, not a tester model, own trusted evidence and goal publication (`spec.md` §5 REQ-RS-06).
- **AC-02.5** After isolated review approval and final host verification, gated release asks the operator to approve the exact candidate. `release-approval.json` binds the accepted intent and candidate tree hashes; changed candidate bytes cannot reuse the previous approval.
- **AC-02.6** Ship creates exactly one conventional job commit on `kpi/<job_id>` with the job trailer. When `origin` exists, scoped release authorization permits pushing only that branch and opening its pull request; delivery is verified before `DONE`. It never authorizes another branch, force-push, tags, branch deletion or merging.
- **AC-02.7** Board widget shows `MODE gated`, current `STAGE`, `ROUND n` (a count, never `n/max`), and which run files exist.
- **AC-02.8** Gated mode presents the derived desired-state summary before plan/implement and requires explicit **Accept intent / Request changes / Stop**; unresolved questions require **Provide decisions / Stop** instead. Acceptance records `approval.result` on `intent` and publishes a new protected revision. Routine plan changes do not require a new `plan-approval` gate.
- **AC-02.9** Desired-state change requests or unresolved decisions collect non-empty clarification and rerun specify or plan-check. After detailed intent is accepted, planner repair may change the execution map and current slice but cannot replace the accepted desired state.
- **AC-02.10** Execution revisions are unbounded and audited. Only planner/diagnostic roles may create, replace, split, supersede or reroute admissible tasks with revision compare-and-swap, a reason, real run-local evidence and affected task/goal/assumption IDs. Mutations cannot expand tools, roles or artifact authority, remove protected gates or redefine success.
- **AC-02.11** Missing UI or dismissed gated intent/release confirmation pauses `NEEDS_HUMAN` (`approval`) with the resume command, never an invented answer. Checkpoints retain answered human gates, but release authority remains exact-candidate-bound and is rechecked before ship.

### US-03 — Start from a frozen plan

**Story.** As an operator, I already have `specs/<id>/{requirements,design,tasks}.md` and I run `/kpi --plan specs/<id>/`.

- **AC-03.1** Specify node is skipped.
- **AC-03.2** Plan files are copied into the run store and hashed into `fingerprints.json`.
- **AC-03.3** `plan-check` reads the frozen plan and repository to produce the same additive desired-state proposal as specify. The host resolves initial intent consent/delegation before planning and implementation; supplied plans do not prohibit execution repair.
- **AC-03.4** Changing accepted criteria, bounds, constraints or quality commands is not a repair operation. Protected-intent mismatch pauses for operator authority; the implemented initial refinement API cannot replace an already accepted detailed intent.

### US-04 — Autopilot when AC are executable

**Story.** As an operator, I run `/kpi --mode autopilot` with fully executable AC and walk away.

- **AC-04.1** Autopilot may perform initial desired-state discovery, but required acceptance must have executable checks and explicit bounds before engineering. Missing quality pauses as `ac_quality`; unresolved product questions pause as `contract`.
- **AC-04.2** The auto graph has no human release node. Final host verification precedes deterministic `release.set`, reached only with passed tests, approved review, held bounds and fresh receipts. It sets `release.approved`, not `DONE`.
- **AC-04.3** Implementer cannot publish verdict, host evidence, goal statuses or release authority. Planner graph mutation preserves safety-node reachability, protected goal identity and existing capability/artifact boundaries.
- **AC-04.4** The host seals exact command/expectation, job, intent, candidate tree, verifier, cwd, timestamps, actual exit/signal and full stdout/stderr hashes. Re-reading validates immutable records and recomputes results; `HEAD` is metadata, not freshness authority. Missing, forged, stale, unsupported or blocked evidence cannot satisfy required goals.
- **AC-04.5** `DONE` requires every required AC and quality gate plus every declared journey's linked AC to pass for the current accepted intent/candidate, release approval, and verified one-commit/delivery finalization. Cached graph/goal/run completion and graph exhaustion are not proof.
- **AC-04.6** Policy hard denies, protected credential access and unavailable external authority remain boundaries. Only the scoped approved job-branch delivery path is permitted; broader push/deploy/delete or unauthorized new-dependency attempts cannot be laundered through autopilot.

### US-05 — Self-healing loop and the operator stop

**Story.** As an operator, I need the loop to keep delivering my intent — retrying, re-planning — and to wait for me rather than end on its own; only I stop it.

- **AC-05.1** Run states are exactly `RUNNING`, `NEEDS_HUMAN`, `DONE`, `STOPPED`; `NEEDS_HUMAN` carries a `recovery` reason and the resume command; `NEEDS_HUMAN` and `STOPPED` resume with `/kpi <job>`. Only `RUNNING` is live. A run an earlier release wrote as `BLOCKED`, `EXHAUSTED`, `NO_PROGRESS`, or `UNSAFE` reads as `NEEDS_HUMAN`, is finished, and keeps that token on disk until it is resumed.
- **AC-05.2** A repeated failed-test or review witness routes to plan with `repair.json` (round, reason, failing AC, evidence reference, witness, recovery decision and optional guidance). Contract/stack/routing defects use `execution-repair.json` and the authorized repair planner. Approved review is progress even when its fingerprint repeats.
- **AC-05.3** Rounds and repair attempts are unbounded; there is no two-replan allowance or mandatory no-progress approval prompt. Recovery decisions advance through diagnosis, replanning, decomposition and reconsideration, asking for new diagnostic evidence or materially changed strategy. These briefs and audited mutations do not guarantee that a model's diagnosis is correct. The former allowance is explicitly superseded by the operator's [Architectural rebuild decision — 2026-09-05](remediation-plan.md#architectural-rebuild-decision--2026-09-05) and `spec.md` §6; counts are diagnostic history, not renewed product-consent gates.
- **AC-05.4** A write outside accepted bounds routes to an `unsafe` blocker without ship. Its tasks and dependency descendants wait while independent ready work drains; resume re-runs test after compliant writes are restored. Editing `task.json` to widen bounds is not recovery.
- **AC-05.5** Ordinary blocked/repeated review or approval over failed/stale receipts routes to planner repair. Stale release evidence or previously delivered proof still requires the named operator recovery. Branch-local graph blockers preserve independent work, but driver-level credential, research and intent refusals are not promised to be branch-local.
- **AC-05.6** Retry of a transient 429 is not a new round. A new round requires new verifier evidence. A provider refusal that cannot fail over pauses `NEEDS_HUMAN` (`provider`) with the real reason and the exact resume command.
- **AC-05.7** Transient failures (http 408/429/5xx, timeout, transport) retry the same node run for as long as it takes, with a backoff of 1 s doubling to a 60 s ceiling; every retry writes a checkpoint before the wait, appends one `node.retry` event, and notifies once (`K-π <job> retry <attempt> on <node>: <reason>; next in <s>s (/kpi stop stops it)`). A process killed mid-backoff resumes by finishing the wait, not by restarting the node.
- **AC-05.8** No spend cap, clock, step, node-run, or round counter ends a run: `cost_usd` and `elapsed_ms` are report-only estimates, `maxConcurrency` is the only graph limit, a `/kpi` invocation naming a retired cap flag is refused with `K-π runs have no caps`, and a checkpoint written under a retired cap resumes with its recorded spend.
- **AC-05.9** `/kpi stop` writes `stop.json` and `STOPPED`: a loop live in this process stops at once and issues no further prompt, a loop in another process stops at its next checkpoint or wait, and a stop before the run directory exists creates nothing. Stop inside an intent/release gate is `STOPPED`, not loop failure. Resume uses the recorded topology and interrupted work.

### US-06 — Control-board TUI

**Story.** As an operator, I always know stage, mode, gate, files, and account route without reading model prose.

- **AC-06.1** Historical theme registrations `loop-amber` and `protocol-blue` retain a dark, restrained palette; machine activity uses cool cyan (`#70ced1`), not amber-running semantics. See `visual-targets.md` §2.
- **AC-06.2** Genuine human intervention uses warm peach (`#e9ad86`): a parked `NEEDS_HUMAN` run or an attended `RUNNING` gate with graph interruption and an explicit pending question. Resuming returns to cool machine emphasis. Automatic interruption/retry/repair, stale question/paused metadata on a running graph, and terminal DONE/STOPPED do not show human oversight.
- **AC-06.3** Widget above the editor shows LOOP name, MODE, ROUND, STAGE, NODE, GATE, STOP, FILES.
- **AC-06.4** Accounts widget shows per-slot remaining %, not one unlabeled aggregate. A `local` slot has no quota and shows no percentage.
- **AC-06.5** Protocol events render as custom entries (`handoff.created`, `checkpoint`, `verdict`, `accounts.failover`), not as assistant markdown tables.
- **AC-06.6** `/kpi status` draws the board from `state.json` + `events.jsonl`, not from a model call.
- **AC-06.7** While a job runs, the chat shows one line when a node starts (`K-π ▶ NN node · run n · model`), one when it finishes (`K-π ■ NN node done · <elapsed> · <cost> · <result>` or `K-π ✕ NN node failed · <elapsed> · <error>`), one per retry (`K-π ↻ NN node retry <attempt> · <reason> · next <s>s`), and one on a route change (`K-π ⇄ route <from> → <to>`); never a line per tool call. The lines are read from `events.jsonl` by the widget's 1 s ticker, each record narrated once — a widget reinstall or `/kpi status` never re-narrates.

### US-07 — Concise model output

**Story.** As an operator, I want verdict / evidence / next action, not a diary.

- **AC-07.1** `APPEND_SYSTEM.md` (not `SYSTEM.md`) contains the brevity rule.
- **AC-07.2** Skill `concise-output` description matches “Use whenever writing to the user.”
- **AC-07.3** A fixture session with a structured verdict produces an assistant message whose visible body is under 800 characters.

### US-08 — Best-practice primitives on the path

**Story.** As an operator, spec, TDD, isolated review, gates, and conventional commits happen because the graph says so.

- **AC-08.1** Non-trivial tasks (not a one-line fix) write `specs/<id>/requirements.md`, `design.md`, `tasks.md` before implement.
- **AC-08.2** Implementer on non-trivial work writes or updates a failing test and captures red output before production code. This is development evidence, never permission to overwrite host-owned `evidence.json` or claim final verification.
- **AC-08.3** Exact quality commands are discovered from the repository and frozen into protected intent (`task.json.quality_gates` mirrors it); a model cannot substitute easier commands to pass.
- **AC-08.4** Reviewer runs in `context.mode: isolated`, read-only against product files. Its only mutation path is `write_contract` to the declared `verdict.json`.
- **AC-08.5** Ship commit message matches Conventional Commits.

### US-09 — Knowledge graph

**Story.** As an operator, surviving decisions become source-backed claims, not chat sentences.

- **AC-09.1** Store is `.kpi/kg/{nodes,edges,sources}.jsonl` plus `inbox/` and `snapshots/`.
- **AC-09.2** One writer: the control-plane extension. Workers only drop patches in `inbox/`.
- **AC-09.3** Minimum fields: `id`, `kind`, `source_ids`, `status`, `rev`, `observed_at`.
- **AC-09.4** Status enum: `proposed | verified | rejected | superseded`.

### US-10 — Stacked subscriptions and failover

**Story.** As an operator, I attach multiple Anthropic / OpenAI / Codex / xAI / z.ai / Kimi / Cursor seats and work continues when one window dies.

- **AC-10.1** `~/.kpi/agent/accounts.json` holds pools and slots. Secrets are not in the repo.
- **AC-10.2** `/login anthropic` and `/accounts login anthropic` add a slot without deleting existing Anthropic slots; the `/login` subscription path activates the newly authenticated slot. Each pool has at most one official slot, whose grant is the one `auth.json` holds and which the base runtime refreshes; every other slot refreshes independently in K-π; no grant is ever held by two refreshers, and a slot's credential is never substituted by another slot's.
- **AC-10.3** Official `/model` ids stay `anthropic/<official-id>`. No `anthropic-account-2/claude-…` duplicate catalog.
- **AC-10.4** On classified usage-limit (429/402/403-quota or a finalized quota-shaped 400 assistant error), the slot cools until parsed reset (else default 5h) and the next healthy sibling of the same family is used with the same model and thinking level.
- **AC-10.5** Cross-family fallback happens only when the whole family is cooling. `/setup-kstack` derives an exact live-model fallback order from `model-ladder.md`, lets the operator edit it, and persists it; the default provider chain applies until setup writes one.
- **AC-10.6** An exhausted sibling is never selected while a healthy sibling exists (regression of the known Oh My Pi Codex bug).
- **AC-10.7** Widget lists remaining % per slot, including Codex subscription used-percent windows converted to remaining percent.
- **AC-10.8** Session stickiness yields at 5% remaining to preserve the current provider/model on a healthier sibling; otherwise it holds until exhaustion (prompt-cache friendly).
- **AC-10.9** A `claude_code_version_too_old` refusal is explained once per session — K-π's version, the Claude Code version it sent, the floor Anthropic requires, and the update command `npm install -g @korallis/k-pi@latest` — and never cools a slot or changes route.
- **AC-10.10** An `invalid_grant` refresh — K-π's own on a non-official slot, or the runtime's on the official `auth.json` grant — marks that slot `needs login` (persisted in `accounts.json` as `needsLogin`, unselectable, shown in the widget) with one plain-language notification naming `/accounts login <pool> <slot>`; never a cooldown, never a stack trace. A transient refresh failure (http/transport) cools the slot 5h with a plain reason and no login demand.

### US-11 — Official catalogs stay live

**Story.** As an operator, a new Anthropic/OpenAI/xAI model appears without a k-pi release.

- **AC-11.1** Extensions do not pass a `models` array when touching official ids `anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, `kimi-coding`.
- **AC-11.2** Cursor uses a first-party adapter for Cursor's CLI protocol: authenticated `GetUsableModels` discovery and `AgentService/Run`, not Cloud Agent provisioning or an OpenAI-compatible guess. Only discovered model ids or their native cached entries are selectable; an empty successful discovery clears stale entries and failed discovery is reported without inventing replacements. Missing capacities remain zero/unknown, modalities and reasoning are not inferred from names, and subscription price is unknown rather than advertised as free. Native `models.json` may supply explicit operator metadata. Browser PKCE login and real token renewal preserve account-pool ownership. Tools execute only through K-π's native tool/permission path; Cursor Cloud/subagent execution is forbidden. Protocol fixtures and built-artifact proof are required; authenticated live proof is recorded separately and an empty catalog is not completed integration.
- **AC-11.3** README documents `kpi update --models` as the operator command for official refresh. There is no `pi` bin (AC-01.2), so no operator command is spelled `pi …`.

### US-12 — Anthropic extra-usage warning

**Story.** As an operator, I am told once that Pro/Max in this harness bills extra usage, same as stock Pi and Atomic.

- **AC-12.1** Before the Anthropic OAuth window, `ctx.ui.confirm` shows the warning in `spec.md` §Accounts.
- **AC-12.2** On accept, slot field `warningAcceptedAt` is set. Later sessions do not re-prompt that slot.
- **AC-12.3** Cancel aborts login and creates no slot.
- **AC-12.4** Warning text states extra usage is billed per token and is not the in-app Max bar.

### US-13 — Policy layers

**Story.** As an operator, irreversible external actions cannot happen because a prompt “remembered” not to.

- **AC-13.1** `tool_call` hook denies every push except `git push [-u] origin kpi/<branch>` inside a job after `release.approved` (so `main`, force-push, tag pushes, branch deletion, and other remotes are denied), `gh pr merge`, `rm -rf`, production deploy, and writes outside `write_allow`.
- **AC-13.2** In gated mode, `git commit` on the job branch asks confirm with diff stat.
- **AC-13.3** In autopilot, `git commit` is allowed only after `release.approved == true`.
- **AC-13.4** Unknown commands: confirm in gated, deny in autopilot.
- **AC-13.5** With no live job (chat scope), reads, writes, unknown commands and `git commit` never confirm; AC-13.1 denials, secret-shaped paths and reserved artifacts still deny. Inside a job, any command whose every segment is read-only (pipes, `;`, `$(…)` included) runs without a prompt.
- **AC-13.6** A gated confirm offers "Allow for this session", "Always allow in this project" and "Deny". *Always* persists the exact command to `.kpi/policy.json` `allow[]` and later sessions do not re-prompt; a session approval is not asked again in the same process; neither can launder a hard deny.

### US-14 — Observability

**Story.** As an operator, I can reconstruct a run from files after a crash.

- **AC-14.1** `events.jsonl` is append-only and hash-chained (`prev_hash`, `record_hash`).
- **AC-14.2** State files are written `*.tmp` → fsync → rename.
- **AC-14.3** No tokens, cookies, or raw secrets in events.
- **AC-14.4** Kill mid-implementer leaves a checkpoint with actual topology, revision audit, superseded-task history, blockers, recoveries and pending result routes. Resume uses that definition and retains unresolved node/retry state, never reconstructing today's named template. Legacy intent needs explicit operator adoption; a checkpoint missing its original topology requires a trusted backup or a newly confirmed job.
- **AC-14.5** Every agent node run appends `node.started` {`run`, `model`?} and `node.finished` {`run`, `status` `completed | failed`, `elapsed_ms`, `cost_usd`?, `result`?, `session`?, `error`?} to `events.jsonl`, hash-chained and validated by `event.schema.json`; cost sums every attempt of the run and is omitted, never zeroed, when the node's session has no billing. Transient retries inside a run repeat neither event; each retry appends `node.retry` {`attempt`, `reason`, `delay_ms`, `status`?, `message`?} instead.

### US-15 — Oh My Pi status bar with K-π brand

**Story.** As an operator, the footer looks like Oh My Pi’s status bar. The brand is `K-π`.

Reference files: `visual/omp-statusbar-codemod.jpg`, `visual/omp-statusbar-collab.jpg`. Written spec: `visual-targets.md`.

- **AC-15.1** Idle leftmost cell is `K-π` in the unicode preset. Not `π`. Not `omp`.
- **AC-15.2** Default segments left-to-right: brand, model, thinking, path, git (if repo), context_pct, cost-or-(sub).
- **AC-15.3** Powerline-thin chevron separators between segments.
- **AC-15.4** Context % is color-coded: green <50, yellow 50–70, orange 70–90, red >90.
- **AC-15.5** Subscription slots render `(sub)` instead of a fake dollar figure when the active slot kind is `oauth`.
- **AC-15.6** During a turn the brand cell shows a spinner and elapsed seconds, same idea as OMP.
- **AC-15.7** Last user request can appear right-aligned, truncated.
- **AC-15.8** No runtime dependency on oh-my-pi or community footer packages.
- **AC-15.9** `/statusbar` toggles the custom footer. Off restores Pi’s default footer.
- **AC-15.10** A `local` active slot renders one cost cell `(local) $0`. Never `(sub)`, never an estimated dollar figure, and no quota percentage.

### US-16 — Jobs-first terminal with graph detail

**Story.** As an operator, I see which real jobs need me and what each is doing, then open technical detail when useful. The operator's RP-22 terminal decision preserves the styling and mentality of imported `visual/k-pi-design/K-pi Command Center Wireframes.dc.html` (4b–4k): Jobs first, cool machine work, warm human intervention. The Avid reconstructions (`visual/kpi-board-amber-running.jpg`, `visual/kpi-board-protocol-pause.jpg`) guide retained widget/detail geometry, not home layout or status colors. See [RP-22](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild) and `visual-targets.md` §Command Centre; this contract migration is not runtime acceptance.

- **AC-16.1** While a job is active, the compact above-editor widget retains header (`K-π`, MODE, JOB, ROUND), context-layer lamps, stages 01–08 with current stage identified, iteration PASS/FAIL, six file lamps and STOP state. Machine work is cool; completed stages require recorded completed activity, never just an earlier position in the rail.
- **AC-16.2** `/kpi status` opens the K-π Command Centre over that widget (AC-16.8); in print/rpc mode it prints the full board as text. No model call.
- **AC-16.3** Authoritative human intervention uses warm emphasis and shows the pending question with WAITING ON OPERATOR, SHARED RUN STATE and STOP STATES with derived APPROVAL lit; the printed board also shows THREE LAWS. Automatic repair/retry stays cool and must not appear as a human-action job merely because a pause flag is stale.
- **AC-16.4** File lamps light only when the named file exists and is non-empty.
- **AC-16.5** The assistant does not reprint the board as a markdown table. The TUI carries the state.
- **AC-16.6** Pixel matching is not required. The widget/printed board retain US-25's required fields, with current stage and STOP visible at narrow widths. Jobs home retains Now/Next/Done at the imported 80-column floor and at 108/120 columns; 60-column fallback and 160/200-column rendering must not overflow. Width coverage is acceptance to prove, not implied by imported HTML.
- **AC-16.7** The widget carries a `NOW` row naming the running node, its run number, tool-call count, last tool and target, elapsed and cost (`NOW <node>  run <n>  <k> tools  ▸ <tool> <target>  <elapsed>  <cost>  MODEL <m>`; `no node.started yet` before the first record), refreshed from `state.json` + `events.jsonl` every second with no model call; optional spans drop before anything truncates. Stage cells carry a detail line in both layouts: DONE `<elapsed> · <n> calls · $<cost> est.`, CURRENT `<tool> <target>  <elapsed>`, PENDING `—`; the widget adds a `RETRY <attempt> · <reason> · next <s>s` row while a node backs off and shows `ROUND n` with no maximum. Elapsed reads `12s`, `3m12s`, `1h02m`, `4d04h`; cost is an estimate, never a bill, and is never fabricated.
- **AC-16.8** `/kpi status` opens a full-width, model-free Command Centre: HOME groups actual Jobs as NEEDS YOU (`NEEDS_HUMAN`), RUNNING, DONE and separately STOPPED, with selected-job Now/Next/Done. Missing summaries or telemetry stay unknown; cancelled work is not done. Enter opens DETAILS (STAGES 01–08, LIVE transcript, TELEMETRY without run caps, SHARED RUN STATE, CONTEXT LAYER, EVENTS), then a stage's SESSION and NODE panel (status, elapsed, estimated cost, model, route). `j/k` or arrows navigate jobs on home and stages in details/session; `1`–`8` and `[ ]` select stages in details/session. Tab/shift-tab chooses the next/previous real human-action job in every view; `?` opens help that intercepts navigation; esc clears input, dismisses help, returns one level, then closes. `q`/ctrl+c closes; `r` refreshes. Empty-input shortcuts must not consume typed text. Labelled `command ›` accepts `/kpi stop` exactly once and `/kpi verify` for the opened job only; another selected job must first be opened. Other `/kpi …` and shell commands are refused. Labelled `chat ›` closes before sending ordinary text to the existing chat source. Direct steering, approval, new-job creation and bounds recovery from this input are not claimed.
- **AC-16.9** The Command Centre refreshes on the 1 s ticker (run-file metadata every fifth tick), serializes slow reads and surfaces read errors without throwing; later ticks or `r` can recover. Native fleet discovery keeps refreshing after the opened job ends or disappears, preserving selection by job id across reordered snapshots. Without a fleet source, only the actual opened job appears and its terminal/gone result stops the ticker; closing always stops it. Opening another job closes the old overlay before its source opens the selected job and surfaces open failures. The detached loop leaves `/kpi status`, `/agents` and chat usable during work.

### US-17 — K-stack ships as built-in first-party skills

**Story.** As an operator, I get pstack rigor without installing Cursor pstack, open-pstack, or pi-pstack.

- **AC-17.1** `/setup-kstack` and `/k-mode` exist at startup, with no install or trust step.
- **AC-17.2** No manifest declares a dependency on `pstack`, `open-pstack`, `@oh-my-pi/*`, or `pi-pstack`.
- **AC-17.3** `kstack/` contains rewritten skills and playbooks, and the root `NOTICE` credits Lauren Tan / Cursor MIT pstack.
- **AC-17.4** Operator chrome says **K-stack** / **K-mode**, not poteto-mode.

### US-18 — Setup maps only wired models

**Story.** As an operator, `/setup-kstack` only offers models my k-pi pools can actually run.

- **AC-18.1** Offered slugs ⊆ `ctx.modelRegistry.getAvailable()` ∩ configured pools.
- **AC-18.2** A slug not in that set cannot be written to `~/.kpi/agent/kstack/models.json`.
- **AC-18.3** No Cursor Cloud Agent target is listed.
- **AC-18.4** Re-running setup overwrites the file idempotently.
- **AC-18.5** Setup prints an auto role map and ordered `fallback_models` from `model-ladder.md` against the live set. Operator applies or edits both before write. The saved order is exact: same-provider slots are exhausted first, then cross-provider failover follows that model order.
- **AC-18.6** Suggestion never writes a slug absent from the live filter.

### US-19 — K-mode follows a playbook and the graph

**Story.** As an operator, I type `/k-mode add a healthcheck and verify it` and get feature-playbook steps that cannot skip graph gates.

- **AC-19.1** The first todo names the four graph principles in `kstack.md` §6, which are always in force, plus only the principle skills whose frontmatter `description` matches the current node. No fixed principle count is asserted, and no todo list opens by reading the whole principle index.
- **AC-19.2** Matched playbook name is stored on `task.json.playbook`.
- **AC-19.3** Ship todo cannot complete from a verdict alone: required host goal coverage, fresh candidate proof, release authority and verified delivery are necessary.
- **AC-19.4** Skipped steps remain listed with `skip: <reason>`.
- **AC-19.5** `/k-mode` stays on for the session until `/k-mode off`.

### US-20 — No cloud owners

**Story.** As an operator, K-stack never launches a Cursor Cloud agent or a Graphite cloud sleeper.

- **AC-20.1** Autopilot-full / autopilot-stack rewrites spawn only local isolated K-π sessions.
- **AC-20.2** These playbooks cannot merge to origin or bypass the graph's release and host-verification boundaries. `DONE` requires the same verified one-commit/delivery contract as any K-π run, not a local-commit-only exemption. `spec.md` §7 **Local blockers and operator gates** defines checkpointed host delivery; §12 retains exact job-branch release authority. The [RP-22 mandate](remediation-plan.md#architectural-rebuild-decision--2026-09-05) does not itself authorize external actions.
- **AC-20.3** Source tree grep of runtime `kstack/` has no `cloud agent`, `gt submit`, `subagent_type`, or `cursor-team-kit` calls.
- **AC-20.4** Swarm/arena honor the configured graph concurrency and native worker admission limits, with one mutating owner per checkout. Static playbook wording cannot create a separate fixed-two-worker gate.

### US-21 — Upstream pstack stays the source; overlay replays

**Story.** As a maintainer, when Cursor pstack moves, I run one command and our K-stack edits re-apply. I do not hand-merge the tree.

- **AC-21.1** `kstack/UPSTREAM.md` records repo, path `pstack/`, commit sha, upstream version.
- **AC-21.2** `npm run kstack:sync -- --pin <sha>` fetches that tree into `kstack/upstream/`, runs transforms + patches, writes `kstack/generated/`.
- **AC-21.3** If a patch fails, sync exits non-zero and does not overwrite `generated/`.
- **AC-21.4** `npm run kstack:sync:check` fails when generated would drift or when HEAD ≠ pin.
- **AC-21.5** Weekly CI (documented) fetches `cursor/plugins` `main` and opens a PR if `pstack/` changed. It does not merge.
- **AC-21.6** Operators running K-π do not hit the network for this. Sync is maintainer/CI only.

### US-22 — Minimalist skill stops over-engineering

**Story.** As an operator, agents do not invent helpers, packages, or abstractions I did not ask for.

- **AC-22.1** `skills/minimalist/SKILL.md` is present and credited (Alireza Rezvani, MIT).
- **AC-22.2** Implementer writes `candidate.json.ladder` before the first file change.
- **AC-22.3** A new runtime dependency outside protected intent fails bounds and cannot ship; declaring one in a mutable candidate/task artifact is not authorization.
- **AC-22.4** Fixture: “add a helper class for one string concat” produces a one-liner, no new file.

Source: https://github.com/alirezarezvani/claude-skills/blob/main/engineering/minimalist/SKILL.md

### US-23 — Background K-π agents communicate asynchronously

**Story.** As an operator, review/arena/swarm work runs as background K-π sessions that message each other. Not subagents.

- **AC-23.1** `spawn_background` starts a `kpi --mode rpc` (or SDK session) with its own session file under `.kpi/runs/<job>/agents/`. Explorer workers may use `bash` only when the shared classifier proves every segment read-only; mutation and project-code execution remain denied.
- **AC-23.2** `communicate` delivers via `sendUserMessage` / RPC `prompt` with `deliverAs` steer|followUp.
- **AC-23.3** Parent reads `verdict.json` / `evidence.json`, not the worker transcript.
- **AC-23.4** Max 2 live workers. Third spawn is denied.
- **AC-23.5** package.json has no pi-intercom, pi-mesh, pi-agents-talk-to-each-other, pi-bus, pi-side-agents.
- **AC-23.6** Board can show `AGENTS n`. Worker chat is not printed as assistant markdown.
- **AC-23.7** At most one live worker has `write`/`edit`. A second writer spawn is denied.
- **AC-23.8** `claim_path` is exclusive. A second claim on the same path is denied until release or the holder pid dies.
- **AC-23.9** `write_contract` is not `write`/`edit`. A reviewer or tester holding only `write_contract` is not a writer, does not consume the single-writer slot, and can publish nothing but its own declared run-contract file.
- **AC-23.10** `/agents` lists every live session this kpi process owns — the main session, in-process graph node sessions (node id, context mode, model, elapsed, tool calls) and worker processes (agent id, role, pid, alive, node, job) — under the columns `KIND ID ROLE MODEL PID ALIVE ELAPSED TOOLS LAST NODE JOB`, followed by `caps (this process): workers <w>/2 · writers <n>/1` and the mechanism line stating that graph nodes are in-process sessions while `workerRole` nodes and `spawn_background` are separate `kpi --mode rpc` processes over `bus.jsonl`, with no sub-agent API. With no job it still prints the main row and `no active job`; it reads files and memory only, never a model.
- **AC-23.11** The board's `AGENTS n` cell is nodes + workers for the live job with the breakdown `· k nodes · w workers`, and it repaints when a node session or worker starts or ends, not only per superstep.

### US-24 — Bare message is plain chat; the agent starts a K-π job for substantial work

**Story.** As an operator, I type what I want with no slash. A question, a greeting, or a quick edit is answered directly; a real engineering task becomes a K-π job without my having to remember `/kpi`.

- **AC-24.1** With `kpi.routing = auto` (default) a bare message is ordinary harness input. For substantial engineering work the agent calls `kpi_start_job`, which queues a gated `/kpi` for that goal after the current turn and sets sticky `/k-mode`. Greetings, questions, pasted logs, and goals under 12 characters are refused by the tool and answered directly; no run directory is created for them.
- **AC-24.2** Commands (`/kpi`, `/k-mode`, `/accounts`, `/setup-kstack`, …) are never wrapped. `kpi.routing = always` (or `/kpi always`) wraps every bare message into a gated `/kpi` with that text, on one line.
- **AC-24.3** While a job is live, a bare follow-up is steer/followUp into the parent session and `kpi_start_job` refuses to start a second job. A finished run (`DONE`, `NEEDS_HUMAN`, `STOPPED`, or a legacy token that reads as `NEEDS_HUMAN`) owns no follow-up and is not drawn as live.
- **AC-24.4** `/kpi off` or `kpi.routing = off` disables automatic starts: only explicit `/kpi`, `/loop`, `/k-mode` start a job. Bus worker sessions never hold `kpi_start_job`.

### US-25 — TUI is information-complete, not pixel-perfect

**Story.** As an operator, the retained widget and printed board expose every required graph lamp and label. Jobs home prioritizes Now/Next/Done with technical detail one level deeper; required information is not deleted to make the home simpler. Layout may wrap.

- **AC-25.1** The active-job widget and printed board retain brand `K-π`, MODE, JOB, ROUND, stages 01–08, PASS/FAIL, six file lamps and STOP. Jobs home/detail placement follows US-16, not an all-panels-on-home requirement.
- **AC-25.2** Paused human node shows WAITING ON OPERATOR plus the pending question.
- **AC-25.3** Narrow terminals may wrap or stack rows. Truncation keeps the current stage and STOP visible.
- **AC-25.4** Matching JPEG pixels is not required. Missing a required field fails the story.

### US-26 — z.ai and Kimi Coding pools

**Story.** As an operator, I stack GLM Coding Plan and Kimi Code subscriptions the same way I stack Anthropic.

- **AC-26.1** Official pool ids only: `zai` (global, `ZAI_API_KEY`), `zai-coding-cn` (`ZAI_CODING_CN_API_KEY`), `kimi-coding` (`KIMI_API_KEY`).
- **AC-26.2** `/accounts login zai` and `/accounts login kimi-coding` add slots without freezing catalogs.
- **AC-26.3** Same-family failover on 429/402/403-quota. z.ai default cool-off uses the 5-hour window when reset is unknown.
- **AC-26.4** Model ids stay `zai/<official>`, `kimi-coding/<official>`. New GLM or Kimi coding models appear via `kpi update --models`.
- **AC-26.5** Do not hand-roll `api.z.ai/api/coding/paas/v4` in models.json. Use Pi’s built-in `zai` path (z.ai bans unofficial SDK use of the coding plan).
- **AC-26.6** Kimi Coding Plan is `kimi-coding`, not Moonshot Open Platform (`moonshot` / `api.moonshot.ai`). Pay-per-token Moonshot is out of v1.
- **AC-26.7** Footer shows `(sub)` for these slots. No runtime dep on `pi-kimi-coder`, `pi-moonshot`, or `@czottmann/pi-zai-api`.
- **AC-26.8** First `/accounts login zai` shows a one-line note: Coding Plan is personal-use and official-tool-only; k-pi uses Pi’s supported provider.

### US-27 — Local models

**Story.** As an operator, I run k-pi on llama.cpp, Ollama, LM Studio, or any OpenAI-compat local server, with live model discovery.

- **AC-27.1** Official llama.cpp path: `LLAMA_BASE_URL` (default `http://127.0.0.1:8080`), optional `LLAMA_API_KEY`. Pool id `llama`. Load via Pi’s `/llama`. Only loaded models appear in `/model`.
- **AC-27.2** First-party `ollama`, `lmstudio`, `local-openai` use `registerProvider` + `refreshModels` against `/v1/models` (Ollama falls back to `/api/tags`). No frozen models array.
- **AC-27.3** `/accounts login ollama` stores base URL (default `http://127.0.0.1:11434/v1`). LM Studio default `http://127.0.0.1:1234/v1`. `local-openai` asks for the URL. Each writes a `kind: "local"` slot that persists that base URL and requires no credential; an optional credential may be referenced, never a dummy secret.
- **AC-27.4** Unreachable server cools that slot. Failover stays in the local family first.
- **AC-27.5** Default cloud chain does not include `local` slots. Add with `/pool chain …,llama` or pin a local slot.
- **AC-27.6** Footer renders one cost cell `(local) $0` for an active `local` slot, and the accounts widget shows no quota percentage for it.
- **AC-27.7** No runtime dep on `pi-ollama`, `@jamesjfoong/pi-ollama`, `pi-ollama-keyring`, or `pi-ollama-cloud-provider`.
- **AC-27.8** Local traffic stays on the configured base URL. No silent cloud proxy.

### US-28 — Optional Exa, Perplexity, and Firecrawl research

**Story.** As an operator, I can give k-pi an Exa key, a Perplexity key, a Firecrawl key, or any combination at setup. Planning then searches the live web by default through the first-party research tools.

- **AC-28.1** `/setup-kstack` offers Exa, Perplexity, and Firecrawl keys with save or skip. Saving any subset, or none, is valid.
- **AC-28.2** Keys live in `accounts.secrets.json` at `exa/default`, `perplexity/default`, and `firecrawl/default`, mode 0600. `EXA_API_KEY`, `PERPLEXITY_API_KEY`, and `FIRECRAWL_API_KEY` are fallbacks.
- **AC-28.3** First-party REST tools cover Exa search and contents, Perplexity Search, and Firecrawl Search. No provider SDK is a runtime dependency.
- **AC-28.4** package.json has no `exa-js` or `@perplexity-ai/perplexity_ai` runtime dependency.
- **AC-28.5** A 429, timeout, or unavailable service cools that research service and tries the next configured service. k-pi treats a 402 the same way, as defensive handling on our side rather than a documented Perplexity or Firecrawl response. Attempts per service are bounded and recorded; the graph does not hang.
- **AC-28.6** Footer / board can show `EXA`, `PPLX`, `FC`, or any of them when keys are present.
- **AC-28.7** `exa`, `perplexity`, and `firecrawl` are research credential targets, not pool ids. None appears in `accounts.json.pools`, `/pool strategy`, `/pool chain`, or the fallback chain, and none registers a provider or grants a model provider-native web search.
- **AC-28.8** Firecrawl is a third research credential target: first-party `firecrawl_search` over `POST /v2/search` with Bearer auth, `limit` ≤ 10, `sources: [{type: "web"}]`, never scrape options, the same 10,000-character clamp, failure classes and bounded attempts as AC-28.5; `auto` order is Exa, then Perplexity, then Firecrawl.

### US-29 — Research before implement

**Story.** As an operator, the agent does not write product code until it has researched the stack and current practice.

- **AC-29.1** Specify and plan cannot leave their nodes without `.kpi/runs/<job>/research.md` and `research.json`.
- **AC-29.2** With an Exa, Perplexity, or Firecrawl key and `network.state: "online"`, `research.json` records at least two **distinct** external sources — different origins, deduplicated — from `exa_search`, `exa_contents`, `pplx_search`, or `firecrawl_search`.
- **AC-29.3** Without a usable key, or under `no-network` from either origin, mode is `local` and sources are repository and frozen-plan files cited by repo-relative path. The lamp still lights. No external URL is recorded that this job did not fetch.
- **AC-29.4** Research must bind to the accepted task/intent hash. The driver refreshes it before specification/planning and checks it before implement; missing or stale files cannot be used as current research. The current slice does not change the protected hash.
- **AC-29.5** Assistant prose does not dump raw crawl pages. Citations live in research.md.
- **AC-29.6** A healthy configured service that answers but supplies fewer than two distinct external sources ends the node `NEEDS_HUMAN`. Online shortfall is never downgraded to local research.
- **AC-29.7** The engine may set effective `no-network` only after every configured service has failed its bounded attempts, writing `network.origin: "engine"`, a `network.reason` naming those services, and one recorded failure per attempt. An operator-flagged job uses `network.origin: "operator"`. `no-network` is a research state, never a stop state.

### US-30 — Feature ownership preserving existing layouts

**Story.** As an operator, I can find the responsible feature and its exact writable paths without reorganizing a working repository. The operator's RP-22 **Preserve existing layouts** decision replaces folder=id, auth-home, nested-only-layer, mandatory interface/test scaffold and consumer-count restrictions. See [RP-22](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild), `spec.md` §5 **SCH-stack**, and `dune-architecture.md` §§Ownership contract / Scaffold only what is needed. This migration preserves ownership safety, not the superseded layout ceremony.

- **AC-30.1** Plan writes version-1 `stack.json` with `shape: "dune"`, root, delivery and modules declaring `id`, non-empty `purpose`, `folder`, `interface`, `allowed_paths` and `depends_on`. Current module selection is explicit and frozen before implement; `scaffold_first` is optional stack metadata, not a per-module scaffold requirement.
- **AC-30.2** Only the selected module's explicit `allowed_paths` grants writes or `claim_path`; a folder label or inferred test twin grants nothing. Claims and implement bounds share canonical segment/glob matching, reject traversal/prefix/symlink escapes, and stay inside protected task write bounds. An actual out-of-bounds write cannot ship and routes to the bounds blocker.
- **AC-30.3** Feature work requires a fresh valid ownership map before writes. Only the named typo, unslop and comment-strip playbooks are exempt; planner repair cannot silently change the accepted playbook to gain exemption.
- **AC-30.4** Every feature, including one mapped to an existing generic folder, declares a non-empty purpose and explicit ownership prefix. Empty purposes and catch-all ownership without a literal path prefix are rejected; directory names alone neither fail admission nor grant authority.
- **AC-30.5** Optional `module.scaffold` creates only exact authorized directories needed by the task, preserving existing contents. It never manufactures interface source, a test twin, empty tests or placeholder behavior; real source/tests are written only as needed in project conventions.
- **AC-30.6** Module identity need not equal folder name. Existing Python/Go/Rust, layered, `services/`, `lib/` and root-level layouts remain valid; `root` and `folder` may be `.` without granting the whole repository.
- **AC-30.7** Existing top-level or nested layers and test locations are permitted. The interface must lie inside its declared folder and be admitted by `allowed_paths`; tests need their own explicit admitted paths, not a matching feature-folder name.
- **AC-30.8** Shared code is owned explicitly, not inferred from a `shared/` label or consumer count. Dependencies name declared module identities; unknown dependencies, self-dependencies and cycles are rejected.
- **AC-30.9** Vertical feature delivery remains the planning default. Each implement invocation owns its explicitly selected slice, never the union of every module; missing or conflicting selection blocks writes and cannot fall back to `modules[0]`.
- **AC-30.10** Horizontal delivery is permitted only with `delivery: "horizontal"` and a non-empty reason. A plan that intentionally schedules all APIs before all UI must declare that choice rather than label it vertical.
- **AC-30.11** Existing shared abstractions and necessary task-scoped changes are not forced through a second-consumer threshold or a folder migration. Shared ownership/dependencies remain explicit and selected-slice writes remain bounded; the minimalist ladder and accepted constraints still govern whether new abstraction is justified.

### US-31 — Onboarding

**Story.** As a new operator, I run one guided setup on first launch or with `/onboarding`, and get from a clean install to a working K-π without reading the manual.

- **AC-31.1** `/onboarding` exists at startup and walks welcome → model accounts → research keys (Exa, Perplexity, Firecrawl) → K-stack roles; each step is skippable and the wizard is re-runnable any time.
- **AC-31.2** A TUI startup with no configured slot in any pool and no harness-available model opens the wizard; print/rpc/json sessions never do. "Not now" closes it for that launch; nothing is persisted to record the choice, so it returns next launch until a slot exists.
- **AC-31.3** Model login reuses the pooled `/accounts login` path (same provider notices, slots, secrets); a cancelled or failed login is reported by pool name (`<pool> login not completed: …`) and the wizard continues.
- **AC-31.4** A skipped step writes nothing; the wizard writes no project `.kpi/settings.json` and no `~/.kpi/agent/settings.json`.
- **AC-31.5** The research step saves Exa/Perplexity/Firecrawl keys through the same writer as `/setup-kstack` (`accounts.secrets.json`, 0600) without writing the project research mode, and the K-stack step runs the same role-map function as `/setup-kstack`.

## 7. Workflows

### WF-00 Bare goal

```
operator types: hi                                   → answered directly; no run directory
operator types: why does npm test fail?              → investigated with tools; no run directory
operator types: add a healthcheck and verify it
  → routing auto, no live job
  → agent judges it substantial → kpi_start_job
  → turn ends → /k-mode on + /kpi --mode gated <goal>
  → same as WF-01
```

### WF-01 Task, gated

```
operator /kpi <goal>
  → ac-compiler → specify/plan-check → host desired-state consent → plan (stack.json)
  → implement → test (host) → review → verify (host) → human → ship + verified delivery
  repair: repeated/blocked/stale outcomes and execution defects → diagnosis/plan; bounds → local blocker
```

### WF-02 Plan entry

```
operator /kpi --plan specs/<id>/
  → copy+hash plan → plan-check → host desired-state consent → plan → … (same as WF-01)
```

### WF-03 Autopilot

```
operator /kpi --mode autopilot <goal with executable AC>
  → load coding-loop.auto.json → specify/plan-check → additive intent refinement
  → unresolved decisions or non-executable required AC: NEEDS_HUMAN before engineering
  → delegated intent acceptance → plan → … → review → host verify → release.set → verified ship
```

### WF-04 Account failover mid-loop

```
request → pick slot → before_provider_headers
  → 429/usage-limit → cooldown slot → sibling same model
  → else fallback family → setModel
  → widget + events.jsonl accounts.failover
```

### WF-06 K-mode + graph

```
operator /setup-kstack
  → list live k-pi models → write kstack/models.json
operator /k-mode <goal>
  → match playbook → write task.json.playbook
  → /kpi starts or attaches
  → playbook steps tagged to graph nodes
  → ship still gated or release.set
```

### WF-05 Anthropic slot add

```
/accounts login anthropic
  → extra-usage confirm
  → official OAuth
  → new slot in accounts.json
  → primary catalog unchanged
```

## 8. Success metrics

| ID | Metric | Target |
|---|---|---|
| M-01 | Gated fixture: healthcheck feature reaches human confirm with green gates | 1/1 |
| M-02 | Autopilot fixture with 5 executable AC reaches `DONE` and a commit | 1/1 |
| M-03 | Narrative/unresolved required AC cannot enter autopilot engineering or count as verified success | 1/1 |
| M-04 | Bounds-violation fixture pauses `NEEDS_HUMAN` (`bounds`) with zero commits | 1/1 |
| M-05 | Two Anthropic slots: exhausted slot never selected while sibling healthy | 1/1 |
| M-06 | Assistant visible reply on fixture verdict < 800 chars | 1/1 |
| M-07 | `npm run check && npm test && npm run test:kpi` green on main | always |

## 9. Constraints

- Node `>= 22.22`.
- Upstream base: Pi `v0.84.4`, commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`, tracked via the `upstream` remote. Moving to a newer upstream release is a reviewed merge per `../UPSTREAM.md`, never an automated bump.
- No peer dependencies. Workspace packages keep upstream `@earendil-works/pi-*` names for merge hygiene only; nothing is resolved from a registry under those names.
- Secrets: `0600` files under `~/.kpi/agent/`, never in git.
- English UI strings in v1. Operator-facing text stays short.

## 10. Open questions (do not block M1–M3)

| ID | Question | Default until answered |
|---|---|---|
| Q-01 | Distribution beyond a source build | `@korallis/k-pi` on npm, tag-driven release; install with `npm i -g @korallis/k-pi` or `bun add -g @korallis/k-pi`, or keep building from source |
| Q-02 | Cursor integration transport | Resolved by operator, 2026-09-06: implement the Cursor CLI-protocol adapter using OMP as a source reference, not a runtime dependency. Keep native K-π sessions, tools and approvals; no Cursor Cloud Agents. See spec §Cursor provider and RP-22. |
| Q-03 | Worktree isolation per job | v1 same tree + one writer + `claim_path` (US-23.7/8) |
| Q-04 | Cross-process in-flight cap across two K-π processes | v1 in-process only |

## 11. Traceability

| Story | Primary spec sections | Phase |
|---|---|---|
| US-01 | spec §Distribution and layout | M1 |
| US-02 | spec §Graphs, §Run store | M2–M3 |
| US-03 | spec §Entry points | M3 |
| US-04 | spec §Modes, §Graphs auto | M4 |
| US-05 | spec §Run states, §Recovery, §Graph engine | M3–M4 |
| US-06 | spec §UI | M2, M5 |
| US-07 | spec §Voice | M1 |
| US-08 | spec §Skills | M3 |
| US-09 | spec §Knowledge graph | M6 |
| US-10 | spec §Accounts | M5 |
| US-11 | spec §Providers | M5 |
| US-12 | spec §Accounts warning | M5 |
| US-13 | spec §Policy | M2 |
| US-14 | spec §Log | M2 |
| US-15 | spec §Status bar, visual-targets.md | M1–M2 |
| US-16 | spec §UI, visual-targets.md | M2, M6 |
| US-17 | kstack.md | M3, M8 |
| US-18 | kstack.md §Models | M5, M8 |
| US-19 | kstack.md §Playbooks | M8 |
| US-20 | kstack.md §Cloud strip | M8 |
| US-21 | kstack.md §Upstream | M8 |
| US-22 | minimalist.md | M9 |
| US-23 | agents-bus.md | M9 |
| US-24 | spec §Entry points | M3 |
| US-25 | visual-targets.md §honesty | M2 |
| US-26 | spec §Accounts | M5 |
| US-27 | spec §Accounts local | M5 |
| US-28 | research.md | M3, M8 |
| US-29 | research.md | M3 |
| US-30 | dune-architecture.md | M3 |
| US-31 | spec §Entry points, research.md, kstack.md | M5 |
