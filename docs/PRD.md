# PRD — k-pi

**Status:** Draft for implementation  
**Product:** k-pi — first-party Pi coding-agent package  
**Brand cell:** `K-π` (never bare `π`)  
**Audience:** Coding agents and the humans who review them  
**Companion docs:** `START-HERE.md`, `BUILD-PROMPT.md`, `spec.md`, `kstack.md`, `model-ladder.md`, `research.md`, `dune-architecture.md`, `minimalist.md`, `agents-bus.md`, `visual-targets.md`  
**Active queue:** [`docs/remediation-plan.md`](remediation-plan.md) is the only active implementation queue; start at the lowest incomplete `RP-##`. Research and gap register: [`remediation-research.md`](remediation-research.md).  
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
- Is built by us on official Pi plugin APIs so new official models appear automatically

## 2. Goals

| ID | Goal |
|---|---|
| G-01 | A user can start from a task and get specify → plan → implement → test → review → ship |
| G-02 | A user can start from a frozen plan and skip specify |
| G-03 | Gated mode is the default; human confirms commit |
| G-04 | Autopilot mode reaches `DONE` without a human when every required AC is executable |
| G-05 | Autopilot refuses to start when AC are narrative or partial |
| G-06 | TUI always shows stage, round, mode, gate, run files, and account route |
| G-07 | Assistant replies are short; the board carries state |
| G-08 | Multiple Anthropic / OpenAI / Codex / xAI / Cursor seats can be pooled and failed over |
| G-09 | Official Anthropic, OpenAI, Codex, and xAI model catalogs are never replaced by a static list |
| G-10 | First-party package only. No Oh My Pi / Atomic / community multi-account / community Cursor at runtime |
| G-11 | Anthropic subscription login shows the extra-usage warning once per new slot |
| G-12 | Footer matches Oh My Pi’s status bar; leftmost brand is `K-π` |
| G-13 | Always-on graph TUI matches the Avid boards so the operator is never guessing |
| G-14 | K-stack (forked pstack) is embedded: `/setup-kstack` + `/k-mode` |
| G-15 | K-stack workers use only k-pi-wired models. No Cursor Cloud agents |
| G-16 | z.ai, Kimi Coding, and local llama/Ollama/LM Studio are first-class pools |
| G-17 | Optional Exa and Perplexity research. Research.md required before implement |
| G-18 | Folder-as-map + vertical slices. Auth lives in auth/ |
| G-19 | `/setup-kstack` suggests a role map; frontend prefers Kimi K3 |
| G-20 | Background Pi workers + communicate. No subagents |

## 3. Non-goals

| ID | Non-goal |
|---|---|
| NG-01 | Forking Pi or shipping a rebranded Pi binary |
| NG-02 | Depending on Oh My Pi, Atomic, pi-graph, pi-multi-account, pi-multi-pass, or community Cursor packages |
| NG-03 | A native knowledge-graph database. File-backed JSONL is the v1 store |
| NG-04 | OS sandboxing. Isolation is documented Docker/Gondolin, not promised in-process |
| NG-05 | Autopilot push, deploy, production migrate, spend, or secret access |
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
| Tester node | Runs executable AC commands against HEAD |
| Reviewer node | Isolated, read-only, schema-validated verdict |
| Autopilot release | Deterministic `set` node, not a model |
| Human | Irreversible external effects; untestable review issues; AC changes mid-run |

## 5. Modes

| Mode | Entry | Ship gate | When allowed |
|---|---|---|---|
| `gated` | Default | Human confirm | Always |
| `autopilot` | `--mode autopilot` or `--until-green` | Deterministic `release.set` | `ac.quality == executable` and risk class `repo-local` |

Print/CI may run the auto graph only with `policy.allowNonInteractive` and `allowNonInteractiveMutations` set on that graph file, and only for repo-local commit.

## 6. User stories and acceptance criteria

Each AC is written so a later agent can turn it into a check. IDs are stable.

### US-01 — Install the package

**Story.** As an operator, I install one local Pi package and the commands, theme, and skills appear after project trust.

- **AC-01.1** `pi install -l ./` writes this package into `.pi/settings.json`.
- **AC-01.2** After `/trust`, `/kpi`, `/loop` (alias of `/kpi`), `/accounts`, `/specify`, `/plan`, `/review`, `/verify`, `/ship`, `/statusbar` exist in command completion.
- **AC-01.3** Theme `loop-amber` is selectable in `/settings`.
- **AC-01.4** Package `package.json` contains `"keywords": ["pi-package"]` and a `pi` key listing extensions, skills, prompts, themes.
- **AC-01.5** `package.json` does not list oh-my-pi, atomic, pi-graph, pi-multi-account, pi-multi-pass, or pi-cursor-* as dependencies.

### US-02 — Start from a task (gated)

**Story.** As an operator, I type `/kpi <goal>` (or `/loop <goal>`) and the system compiles AC, specifies if needed, plans, implements, tests, reviews, then asks me before commit.

- **AC-02.1** A directory `.pi/runs/<job_id>/` is created containing `task.json`, `context.md`, `events.jsonl`.
- **AC-02.2** `task.json` has `goal`, `acceptance[]`, `nongoals`, `constraints`, `quality_gates`.
- **AC-02.3** If `ac.quality != executable`, mode stays `gated` even if autopilot was requested without `--mode autopilot` force.
- **AC-02.4** Implementer tools include write/edit/bash. Planner, reviewer, and tester hold no general `write` or `edit`; their product tools are read-only (`read`,`grep`,`find`,`ls`). A read-only node publishes its run contract only through `write_contract` (`spec.md` §5 REQ-RS-06).
- **AC-02.5** After isolated review `approved: true`, a human confirm dialog is shown before `git commit`.
- **AC-02.6** `git push` is never run by the ship node in v1.
- **AC-02.7** Board widget shows `MODE gated`, current `STAGE`, `ROUND n/max`, and which run files exist.

### US-03 — Start from a frozen plan

**Story.** As an operator, I already have `specs/<id>/{requirements,design,tasks}.md` and I run `/kpi --plan specs/<id>/`.

- **AC-03.1** Specify node is skipped.
- **AC-03.2** Plan files are copied into the run store and hashed into `fingerprints.json`.
- **AC-03.3** A `plan-check` node verifies the plan still matches the repo; if not, status is `NEEDS_HUMAN` in autopilot and a replan prompt in gated.
- **AC-03.4** Changing acceptance criteria mid-run is a mode violation and stops autopilot.

### US-04 — Autopilot when AC are executable

**Story.** As an operator, I run `/kpi --mode autopilot` with fully executable AC and walk away.

- **AC-04.1** Autopilot is refused if any required AC lacks `check` and `bounds`. Refusal writes `ac.quality` of `partial` or `narrative` and does not load `coding-loop.auto.json`.
- **AC-04.2** Happy path has no `human` node. `release.approved` is written by a deterministic set node only when `test.passed && review.approved && bounds.held && fingerprints.fresh`.
- **AC-04.3** Implementer does not write `verdict.json` or `release.approved`. `write_contract` is pinned to the calling agent, job, role, and declared contract path, so no other node can publish either file.
- **AC-04.4** Tester binds `evidence.json` to `git rev-parse HEAD`.
- **AC-04.5** On success, status is `DONE` and a conventional commit is created on the job feature branch.
- **AC-04.6** Push/deploy/delete/new-dependency attempts set `NEEDS_HUMAN` or `UNSAFE` and do not execute.

### US-05 — Autopilot stop states

**Story.** As an operator, I need the loop to stop instead of “keep going.”

- **AC-05.1** Terminal states are exactly `DONE`, `BLOCKED`, `EXHAUSTED`, `NO_PROGRESS`, `UNSAFE`, `NEEDS_HUMAN`.
- **AC-05.2** Same `output_fingerprint` twice → `NO_PROGRESS`.
- **AC-05.3** `round >= maxRounds` (default 3) → `EXHAUSTED`.
- **AC-05.4** Write outside `write_allow` → `UNSAFE`.
- **AC-05.5** Untestable reviewer issue → `NEEDS_HUMAN`.
- **AC-05.6** Retry of a transient 429 is not a new round. A new round requires new verifier evidence.

### US-06 — Control-board TUI

**Story.** As an operator, I always know stage, mode, gate, files, and account route without reading model prose.

- **AC-06.1** Theme `loop-amber` uses accent `#ff6a1a` on a dark board.
- **AC-06.2** While a human node is paused, theme switches to `protocol-blue` accent `#3da9fc`.
- **AC-06.3** Widget above the editor shows LOOP name, MODE, ROUND, STAGE, NODE, GATE, STOP, FILES.
- **AC-06.4** Accounts widget shows per-slot remaining %, not one unlabeled aggregate. A `local` slot has no quota and shows no percentage.
- **AC-06.5** Protocol events render as custom entries (`handoff.created`, `checkpoint`, `verdict`, `accounts.failover`), not as assistant markdown tables.
- **AC-06.6** `/kpi status` draws the board from `state.json` + `events.jsonl`, not from a model call.

### US-07 — Concise model output

**Story.** As an operator, I want verdict / evidence / next action, not a diary.

- **AC-07.1** `APPEND_SYSTEM.md` (not `SYSTEM.md`) contains the brevity rule.
- **AC-07.2** Skill `concise-output` description matches “Use whenever writing to the user.”
- **AC-07.3** A fixture session with a structured verdict produces an assistant message whose visible body is under 800 characters.

### US-08 — Best-practice primitives on the path

**Story.** As an operator, spec, TDD, isolated review, gates, and conventional commits happen because the graph says so.

- **AC-08.1** Non-trivial tasks (not a one-line fix) write `specs/<id>/requirements.md`, `design.md`, `tasks.md` before implement.
- **AC-08.2** Implementer on non-trivial work writes or updates a failing test and stores the red output in `evidence.json` before production code.
- **AC-08.3** Quality gates are exact commands from project `AGENTS.md` (or `task.json.quality_gates`).
- **AC-08.4** Reviewer runs in `context.mode: isolated`, read-only against product files. Its only mutation path is `write_contract` to the declared `verdict.json`.
- **AC-08.5** Ship commit message matches Conventional Commits.

### US-09 — Knowledge graph

**Story.** As an operator, surviving decisions become source-backed claims, not chat sentences.

- **AC-09.1** Store is `.pi/kg/{nodes,edges,sources}.jsonl` plus `inbox/` and `snapshots/`.
- **AC-09.2** One writer: the control-plane extension. Workers only drop patches in `inbox/`.
- **AC-09.3** Minimum fields: `id`, `kind`, `source_ids`, `status`, `rev`, `observed_at`.
- **AC-09.4** Status enum: `proposed | verified | rejected | superseded`.

### US-10 — Stacked subscriptions and failover

**Story.** As an operator, I attach multiple Anthropic / OpenAI / Codex / xAI / z.ai / Kimi / Cursor seats and work continues when one window dies.

- **AC-10.1** `~/.pi/agent/accounts.json` holds pools and slots. Secrets are not in the repo.
- **AC-10.2** `/accounts login anthropic` adds a slot without deleting existing Anthropic slots.
- **AC-10.3** Official `/model` ids stay `anthropic/<official-id>`. No `anthropic-account-2/claude-…` duplicate catalog.
- **AC-10.4** On classified usage-limit (429/402/403-quota), the slot cools until parsed reset (else default 5h) and the next healthy sibling of the same family is used with the same model and thinking level.
- **AC-10.5** Cross-family fallback happens only when the whole family is cooling. Default order: anthropic → openai-codex → xai → zai → kimi-coding → cursor.
- **AC-10.6** An exhausted sibling is never selected while a healthy sibling exists (regression of the known Oh My Pi Codex bug).
- **AC-10.7** Widget lists remaining % per slot.
- **AC-10.8** Session stickiness holds until the pinned slot is exhausted, then releases (prompt-cache friendly).

### US-11 — Official catalogs stay live

**Story.** As an operator, a new Anthropic/OpenAI/xAI model appears without a k-pi release.

- **AC-11.1** Extensions do not pass a `models` array when touching official ids `anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, `kimi-coding`.
- **AC-11.2** Cursor provider implements `refreshModels` and a short fallback list only for pre-sync emptiness.
- **AC-11.3** README documents `pi update --models` as the operator command for official refresh.

### US-12 — Anthropic extra-usage warning

**Story.** As an operator, I am told once that Pro/Max in this harness bills extra usage, same as stock Pi and Atomic.

- **AC-12.1** Before the Anthropic OAuth window, `ctx.ui.confirm` shows the warning in `spec.md` §Accounts.
- **AC-12.2** On accept, slot field `warningAcceptedAt` is set. Later sessions do not re-prompt that slot.
- **AC-12.3** Cancel aborts login and creates no slot.
- **AC-12.4** Warning text states extra usage is billed per token and is not the in-app Max bar.

### US-13 — Policy layers

**Story.** As an operator, irreversible external actions cannot happen because a prompt “remembered” not to.

- **AC-13.1** `tool_call` hook denies `git push`, force-push, `rm -rf`, production deploy, and writes outside `write_allow`.
- **AC-13.2** In gated mode, `git commit` on the job branch asks confirm with diff stat.
- **AC-13.3** In autopilot, `git commit` is allowed only after `release.approved == true`.
- **AC-13.4** Unknown commands: confirm in gated, deny in autopilot.

### US-14 — Observability

**Story.** As an operator, I can reconstruct a run from files after a crash.

- **AC-14.1** `events.jsonl` is append-only and hash-chained (`prev_hash`, `record_hash`).
- **AC-14.2** State files are written `*.tmp` → fsync → rename.
- **AC-14.3** No tokens, cookies, or raw secrets in events.
- **AC-14.4** Kill mid-implementer leaves a checkpoint that `/kpi status` can read. Resume is in scope for M7.

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

### US-16 — Graph-engineering TUI (Avid boards)

**Story.** As an operator, I always know what the graph is doing. The industrial boards from https://x.com/av1dlive/status/2092622516544270781 are the TUI. In-repo reconstructions: `visual/kpi-board-amber-running.jpg`, `visual/kpi-board-protocol-pause.jpg`.

- **AC-16.1** While a job is active, a widget above the editor shows the amber board: header (`K-π`, MODE, JOB, ROUND), context-layer lamps, stages 01–08 with current stage lit, iteration PASS/FAIL, six file lamps, STOP state.
- **AC-16.2** `/kpi status` expands that widget into the full board. No model call.
- **AC-16.3** When a human node is paused, the board flips to protocol-blue and shows SHARED RUN STATE, STOP STATES with APPROVAL lit, THREE LAWS, and WAITING ON OPERATOR with the pending question.
- **AC-16.4** File lamps light only when the named file exists and is non-empty.
- **AC-16.5** The assistant does not reprint the board as a markdown table. The TUI carries the state.
- **AC-16.6** Pixel match to the JPEGs is not required. Required fields in US-25 are. Narrow terminals may wrap. See `visual-targets.md` §honesty.

### US-17 — Install K-stack as first-party skills

**Story.** As an operator, I get pstack rigor without installing Cursor pstack, open-pstack, or pi-pstack.

- **AC-17.1** After package trust, `/setup-kstack` and `/k-mode` exist.
- **AC-17.2** `package.json` has no dependency on `pstack`, `open-pstack`, `@oh-my-pi/*`, or `pi-pstack`.
- **AC-17.3** `kstack/` contains rewritten skills and playbooks plus `NOTICE` crediting Lauren Tan / Cursor MIT pstack.
- **AC-17.4** Operator chrome says **K-stack** / **K-mode**, not poteto-mode.

### US-18 — Setup maps only wired models

**Story.** As an operator, `/setup-kstack` only offers models my k-pi pools can actually run.

- **AC-18.1** Offered slugs ⊆ `ctx.modelRegistry.getAvailable()` ∩ configured pools.
- **AC-18.2** A slug not in that set cannot be written to `~/.pi/agent/kstack/models.json`.
- **AC-18.3** No Cursor Cloud Agent target is listed.
- **AC-18.4** Re-running setup overwrites the file idempotently.
- **AC-18.5** Setup prints an auto map from `model-ladder.md` against the live set. Operator applies or edits before write.
- **AC-18.6** Suggestion never writes a slug absent from the live filter.

### US-19 — K-mode follows a playbook and the graph

**Story.** As an operator, I type `/k-mode add a healthcheck and verify it` and get feature-playbook steps that cannot skip graph gates.

- **AC-19.1** First todo is “read Principles” (21 upstream + 4 graph principles in `kstack.md`).
- **AC-19.2** Matched playbook name is stored on `task.json.playbook`.
- **AC-19.3** Ship todo cannot complete unless `verdict.json.approved == true` and evidence is fresh.
- **AC-19.4** Skipped steps remain listed with `skip: <reason>`.
- **AC-19.5** `/k-mode` stays on for the session until `/k-mode off`.

### US-20 — No cloud owners

**Story.** As an operator, K-stack never launches a Cursor Cloud agent or a Graphite cloud sleeper.

- **AC-20.1** Autopilot-full / autopilot-stack rewrites spawn only local isolated Pi sessions.
- **AC-20.2** Those playbooks do not merge to origin. Terminal is `DONE` + local commit per k-pi mode.
- **AC-20.3** Source tree grep of runtime `kstack/` has no `cloud agent`, `gt submit`, `subagent_type`, or `cursor-team-kit` calls.
- **AC-20.4** Swarm/arena honor `maxConcurrency = 2`.

### US-21 — Upstream pstack stays the source; overlay replays

**Story.** As a maintainer, when Cursor pstack moves, I run one command and our K-stack edits re-apply. I do not hand-merge the tree.

- **AC-21.1** `kstack/UPSTREAM.md` records repo, path `pstack/`, commit sha, upstream version.
- **AC-21.2** `pnpm kstack:sync --pin <sha>` fetches that tree into `kstack/upstream/`, runs transforms + patches, writes `kstack/generated/`.
- **AC-21.3** If a patch fails, sync exits non-zero and does not overwrite `generated/`.
- **AC-21.4** `pnpm kstack:sync --check` fails when generated would drift or when HEAD ≠ pin.
- **AC-21.5** Weekly CI (documented) fetches `cursor/plugins` `main` and opens a PR if `pstack/` changed. It does not merge.
- **AC-21.6** Operators running k-pi do not hit the network for this. Sync is maintainer/CI only.

### US-22 — Minimalist skill stops over-engineering

**Story.** As an operator, agents do not invent helpers, packages, or abstractions I did not ask for.

- **AC-22.1** `skills/minimalist/SKILL.md` is present and credited (Alireza Rezvani, MIT).
- **AC-22.2** Implementer writes `candidate.json.ladder` before the first file change.
- **AC-22.3** A new runtime dependency not named in `task.json` fails bounds and cannot ship.
- **AC-22.4** Fixture: “add a helper class for one string concat” produces a one-liner, no new file.

Source: https://github.com/alirezarezvani/claude-skills/blob/main/engineering/minimalist/SKILL.md

### US-23 — Background Pi agents communicate asynchronously

**Story.** As an operator, review/arena/swarm work runs as background Pi sessions that message each other. Not subagents.

- **AC-23.1** `spawn_background` starts a `pi --mode rpc` (or SDK session) with its own session file under `.pi/runs/<job>/agents/`.
- **AC-23.2** `communicate` delivers via `pi.sendUserMessage` / RPC `prompt` with `deliverAs` steer|followUp.
- **AC-23.3** Parent reads `verdict.json` / `evidence.json`, not the worker transcript.
- **AC-23.4** Max 2 live workers. Third spawn is denied.
- **AC-23.5** package.json has no pi-intercom, pi-mesh, pi-agents-talk-to-each-other, pi-bus, pi-side-agents.
- **AC-23.6** Board can show `AGENTS n`. Worker chat is not printed as assistant markdown.
- **AC-23.7** At most one live worker has `write`/`edit`. A second writer spawn is denied.
- **AC-23.8** `claim_path` is exclusive. A second claim on the same path is denied until release or the holder pid dies.
- **AC-23.9** `write_contract` is not `write`/`edit`. A reviewer or tester holding only `write_contract` is not a writer, does not consume the single-writer slot, and can publish nothing but its own declared run-contract file.

### US-24 — Bare message starts gated K-mode

**Story.** As an operator, I type a goal with no slash and k-pi still runs the harness.

- **AC-24.1** Package enabled, no active job, message does not start with `/` → sticky `/k-mode` + gated `/kpi` with that text.
- **AC-24.2** Commands (`/kpi`, `/k-mode`, `/accounts`, `/setup-kstack`, …) are never auto-wrapped.
- **AC-24.3** While a job is active, a bare follow-up is steer/followUp into the parent session. It does not start a second job.
- **AC-24.4** `/kpi off` or setting `kpi.autoWrap = false` restores plain Pi for bare messages.

### US-25 — TUI is information-complete, not pixel-perfect

**Story.** As an operator, every lamp and label from the Avid boards is visible. Layout may wrap.

- **AC-25.1** Required fields always present when a job is active: brand `K-π`, MODE, JOB, ROUND, stages 01–08, PASS/FAIL, six file lamps, STOP.
- **AC-25.2** Paused human node shows WAITING ON OPERATOR plus the pending question.
- **AC-25.3** Narrow terminals may wrap or stack rows. Truncation keeps the current stage and STOP visible.
- **AC-25.4** Matching JPEG pixels is not required. Missing a required field fails the story.

### US-26 — z.ai and Kimi Coding pools

**Story.** As an operator, I stack GLM Coding Plan and Kimi Code subscriptions the same way I stack Anthropic.

- **AC-26.1** Official pool ids only: `zai` (global, `ZAI_API_KEY`), `zai-coding-cn` (`ZAI_CODING_CN_API_KEY`), `kimi-coding` (`KIMI_API_KEY`).
- **AC-26.2** `/accounts login zai` and `/accounts login kimi-coding` add slots without freezing catalogs.
- **AC-26.3** Same-family failover on 429/402/403-quota. z.ai default cool-off uses the 5-hour window when reset is unknown.
- **AC-26.4** Model ids stay `zai/<official>`, `kimi-coding/<official>`. New GLM or Kimi coding models appear via `pi update --models`.
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

### US-28 — Optional Exa and Perplexity research

**Story.** As an operator, I can give k-pi an Exa key, a Perplexity key, or both at setup. Planning then searches the live web by default through the first-party research tools.

- **AC-28.1** `/setup-kstack` offers Exa and Perplexity keys with save or skip. Saving either, both, or neither is valid.
- **AC-28.2** Keys live in `accounts.secrets.json` at `exa/default` and `perplexity/default`, mode 0600. `EXA_API_KEY` and `PERPLEXITY_API_KEY` are fallbacks.
- **AC-28.3** First-party REST tools cover Exa search and contents plus Perplexity Search. No provider SDK is a runtime dependency.
- **AC-28.4** package.json has no `exa-js` or `@perplexity-ai/perplexity_ai` runtime dependency.
- **AC-28.5** A 429, timeout, or unavailable service cools that research service and tries the other configured service. k-pi treats a 402 the same way, as defensive handling on our side rather than a documented Perplexity Search response. Attempts per service are bounded and recorded; the graph does not hang.
- **AC-28.6** Footer / board can show `EXA`, `PPLX`, or both when keys are present.
- **AC-28.7** `exa` and `perplexity` are research credential targets, not pool ids. Neither appears in `accounts.json.pools`, `/pool strategy`, `/pool chain`, or the fallback chain, and neither registers a provider or grants a model provider-native web search.

### US-29 — Research before implement

**Story.** As an operator, the agent does not write product code until it has researched the stack and current practice.

- **AC-29.1** Specify and plan cannot leave their nodes without `.pi/runs/<job>/research.md` and `research.json`.
- **AC-29.2** With an Exa or Perplexity key and `network.state: "online"`, `research.json` records at least two **distinct** external sources — different origins, deduplicated — from `exa_search`, `exa_contents`, or `pplx_search`.
- **AC-29.3** Without a usable key, or under `no-network` from either origin, mode is `local` and sources are repository and frozen-plan files cited by repo-relative path. The lamp still lights. No external URL is recorded that this job did not fetch.
- **AC-29.4** Implement is `UNSAFE` if research files are missing or older than the current `task.json` hash.
- **AC-29.5** Assistant prose does not dump raw crawl pages. Citations live in research.md.
- **AC-29.6** A healthy configured service that answers but supplies fewer than two distinct external sources ends the node `NEEDS_HUMAN`. Online shortfall is never downgraded to local research.
- **AC-29.7** The engine may set effective `no-network` only after every configured service has failed its bounded attempts, writing `network.origin: "engine"`, a `network.reason` naming those services, and one recorded failure per attempt. An operator-flagged job uses `network.origin: "operator"`. `no-network` is a research state, never a stop state.

### US-30 — Dune modular stack

**Story.** As an operator, I can find auth in `auth/` and a feature in that feature’s folder. Agents use the same map.

- **AC-30.1** Plan writes `stack.json` with `folder`, `interface`, `allowed_paths`, `scaffold_first` per module.
- **AC-30.2** Implement `claim_path` outside the current module folder + test twin is `UNSAFE`.
- **AC-30.3** Feature playbooks copy the dune checklist. `no-stack` playbooks (typo, unslop) are exempt.
- **AC-30.4** Top-level `utils`, `helpers`, `common`, or `misc` without a tight purpose fails the plan gate.
- **AC-30.5** Scaffold creates the feature folder, interface file, and test twin before behaviour.
- **AC-30.6** Folder name equals module `id`. Auth code is not written under `services/` or `lib/` as the home.
- **AC-30.7** Layer folders (`components`, `hooks`) may exist inside a feature folder, not as the top-level map.
- **AC-30.8** A file that only one feature uses cannot live in `shared/`.
- **AC-30.9** Default `delivery` is `vertical`. One implement round = one slice through that feature folder.
- **AC-30.10** A plan that schedules “all APIs then all UI” without `delivery: "horizontal"` and a reason fails the plan gate.
- **AC-30.11** Shared abstractions are extracted only when a second slice needs them.

## 7. Workflows

### WF-00 Bare goal

```
operator types: add a healthcheck and verify it
  → autoWrap on, no job
  → /k-mode on + /kpi --mode gated <text>
  → same as WF-01
```

### WF-01 Task, gated

```
operator /kpi <goal>
  → ac-compiler → specify? → research → plan (stack.json) → implement → test → bounds → review
  → human confirm → ship commit
  fail edges: test/review/bounds → implement or terminal state
```

### WF-02 Plan entry

```
operator /kpi --plan specs/<id>/
  → copy+hash plan → plan-check → implement → … (same as WF-01 from implement)
```

### WF-03 Autopilot

```
operator /kpi --mode autopilot <goal with executable AC>
  → ac-compiler must return executable else refuse
  → load coding-loop.auto.json
  → … → review pass → release.set → ship commit
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
| M-03 | Narrative AC fixture is refused for autopilot | 1/1 |
| M-04 | Bounds-violation fixture ends `UNSAFE` | 1/1 |
| M-05 | Two Anthropic slots: exhausted slot never selected while sibling healthy | 1/1 |
| M-06 | Assistant visible reply on fixture verdict < 800 chars | 1/1 |
| M-07 | `pnpm test && pnpm lint && pnpm typecheck` green on main | always |

## 9. Constraints

- Node `>= 22.19`.
- Pi peer: `@earendil-works/pi-coding-agent` **>= 0.84.0**. Tested pin: **0.84.4**. CI installs that pin. Newer 0.84.x is allowed; 0.85+ needs an explicit bump PR.
- Peer-only on `@earendil-works/pi-*`.
- Secrets: `0600` files under `~/.pi/agent/`, never in git.
- English UI strings in v1. Operator-facing text stays short.

## 10. Open questions (do not block M1–M3)

| ID | Question | Default until answered |
|---|---|---|
| Q-01 | Publish scope/name | `k-pi` |
| Q-02 | Cursor stream transport: OpenAI-shaped vs `streamSimple` | try OpenAI-compatible first, fall back to `streamSimple` |
| Q-03 | Worktree isolation per job | v1 same tree + one writer + `claim_path` (US-23.7/8) |
| Q-04 | Cross-process in-flight cap across two Pi processes | v1 in-process only |

## 11. Traceability

| Story | Primary spec sections | Phase |
|---|---|---|
| US-01 | spec §Package | M1 |
| US-02 | spec §Graphs, §Run store | M2–M3 |
| US-03 | spec §Entry points | M3 |
| US-04 | spec §Modes, §Graphs auto | M4 |
| US-05 | spec §Stop states | M3–M4 |
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
