# uat.md — feature acceptance for K-π

> **AUTHORITY.** This is the feature-acceptance contract. It is not a work queue and it does not schedule anything: [`remediation-plan.md`](remediation-plan.md) remains the only active queue and the only package-completion authority.
>
> **WHEN.** UAT runs **after** every `RP-##` is complete and `npm run check`, `npm test`, `npm run test:kpi`, `npm run kstack:sync:check`, and `npm run upstream:check` all exit 0. Running a row earlier tells you nothing you can trust.
>
> **STOP CONDITION.** The product is finished when all thirty-one rows below and the seven PRD metrics pass, and a human can decide each row from its evidence **without reading source code**. A row whose evidence requires reading source is a FAIL — the feature is not observable to a real user.

## How to run a row

Build first, then drive the built harness — not the source tree, not a unit test:

```bash
npm run build:offline
KPI_CODING_AGENT_DIR="$(mktemp -d)" node packages/coding-agent/dist/bundle/cli.js
```

`./kpi-test.sh` is acceptable where a row does not depend on the bundle itself. Every row runs against a scratch Git repository, never against this one.

Each row writes `.kpi/uat/<UAT-ID>/`:

| File | Contents |
|---|---|
| `cmd.txt` | the exact command or keystrokes |
| `exit` | exit code |
| `stdout.log` | captured output |
| `frame.txt` | captured terminal frame, for TUI rows |
| `head.txt` | `git rev-parse HEAD` of the subject repository |

Rows roll up into `.kpi/remediation-proof.json` beside M-01–M-07. Evidence is secret-free: planted token and cookie canaries must appear in no artifact.

Grader discipline: prefer a deterministic check — exit code, exact string, file present and non-empty — over judgement, wherever a command can decide. Model judgement is a last resort and is recorded as such.

---

## Rows

### UAT-01 — US-01 Build and run the harness
- **Real-user question:** Can I clone this, build it, and run it with no install step?
- **Action:** Clean clone → `npm install && npm run build:offline` → `node packages/coding-agent/dist/bundle/cli.js --version` → start it in an untrusted scratch repo and type `/` to list commands → open `/settings`.
- **Pass evidence:** Version reads K-π's own `0.3.0`, not a Pi version. `/kpi`, `/loop`, `/accounts`, `/specify`, `/plan`, `/review`, `/verify`, `/ship`, `/statusbar` all appear with no `/trust` and no install command. Theme `loop-amber` is selectable. No manifest declares `keywords:["pi-package"]`, a `pi` key, or `@earendil-works/pi-*` peer dependencies.
- **ACs:** AC-01.1–01.6 · **Owner:** RP-01A, re-proved by RP-19

### UAT-02 — US-02 Start from a task (gated)
- **Real-user question:** If I give it a goal, does it confirm the desired outcome before engineering and ask before releasing the verified candidate, without asking me to approve every repair strategy?
- **Action:** In `fixtures/healthcheck-gated/`, run `/kpi add a healthcheck endpoint and verify it`, inspect the derived intent, choose Accept intent, then answer release confirmation. Repeat with Request changes and non-empty clarification, with unresolved product questions, with dismissal, and under `--print` without dialog UI. Resume the dismissed run; introduce an ordinary repair after accepted intent and confirm it does not request plan approval again.
- **Pass evidence:** The run holds `task.json` with goal, required acceptance, non-goals, constraints and quality gates, protected `intent.json` and revision history, `context.md` and `events.jsonl`. Before plan/implement, the desired-state dialog offers Accept intent / Request changes / Stop, or requests decisions for unresolved questions. Clarification reaches a fresh specify proposal before implementation and cannot weaken existing acceptance/bounds; acceptance records `approval.result` on `intent` and a new protected revision. No routine `plan-approval` gate appears for execution repair. Missing UI/dismissal parks `NEEDS_HUMAN` (`approval`) with the resume command and no implementation; resume retains accepted authority. The release dialog offers Approve / Request changes / Stop with real candidate information; `release-approval.json` binds the accepted intent and verified candidate, so changed bytes cannot reuse it. The board retains MODE, current stage, uncapped ROUND and truthful file lamps. After approval, exactly one job commit lands on `kpi/<job>`, only that branch is delivered to `origin`, and a pull request is opened; `main` is never pushed. This replaces the old plan-summary approval requirement under the [RP-22 architectural decision](remediation-plan.md#architectural-rebuild-decision--2026-09-05), PRD AC-02.8–02.11 and `spec.md` §5 Protected desired state / §7.
- **ACs:** AC-02.1–02.11 · **Owner:** RP-02, RP-05

### UAT-03 — US-03 Start from a frozen plan
- **Real-user question:** Can I supply a frozen plan, skip specification, and still repair execution without changing the outcome I accepted?
- **Action:** Run `/kpi --plan fixtures/healthcheck-gated/specs/healthcheck/` in gated mode and explicitly delegated autopilot. Inspect the plan-check proposal and accepted intent; cause an ordinary failed-verifier repair. Separately edit a protected acceptance criterion, bounds or quality command in mutable `task.json` after detailed intent acceptance and resume.
- **Pass evidence:** Specify is not executed; supplied plan files are copied to the run store and hashed into `fingerprints.json`. Plan-check proposes additive desired-state detail; gated mode requires initial intent acceptance, and autopilot delegation requires executable required checks with bounds and no unresolved decisions. Repair may change current slice/topology without renewed plan consent, but the accepted intent, required checks and bounds stay unchanged. Manual protected-contract edits are refused for explicit operator authority, not silently adopted or treated as an ordinary replan; no general mid-run intent editor is implied. See PRD AC-03.1–03.4, `spec.md` §5 Protected desired state and the [RP-22 architectural decision](remediation-plan.md#architectural-rebuild-decision--2026-09-05).
- **ACs:** AC-03.1–03.4 · **Owner:** RP-05, RP-11

### UAT-04 — US-04 Autopilot when AC are executable
- **Real-user question:** With fully executable criteria, can I walk away and come back to a finished commit?
- **Action:** In `fixtures/healthcheck-auto/`, run `/kpi --mode autopilot <goal>`, leave, then inspect `git log -1` and `git status`.
- **Pass evidence:** No human node on the happy path. Terminal state `DONE`. Exactly one Conventional Commits commit on the job branch. `evidence.json` is bound to the `git rev-parse HEAD` it was produced against. The implementer wrote neither `verdict.json` nor `release.approved`. The job branch `kpi/<job>` is pushed to `origin` and a pull request is open for it; a push of any other branch, a force-push, a deploy, a delete, or a new-dependency attempt is denied, did not execute, and the job shows `NEEDS_HUMAN` with its recovery.
- **ACs:** AC-04.1–04.6 · **Owner:** RP-02, RP-05, RP-14

### UAT-05 — US-05 Self-healing loop and the operator stop
- **Real-user question:** When it cannot succeed yet, does it keep trying and re-plan, and wait for me instead of dying?
- **Action:** Run repeated identical failed-review and failed-test witnesses through more than two automatic replans and through diagnose/replan/decompose/reconsider decisions; also repeat an approved review. Exercise `fixtures/bounds-violation/` with an independent ready branch, an ordinary blocked/untestable review, stale release proof, a stub provider answering 429 then 503 then hanging past the idle timeout, and `/kpi stop` from a second session during backoff followed by `/kpi <job>`. Resume a legacy `EXHAUSTED` run and a process interrupted mid-backoff.
- **Pass evidence:** Repeated failure writes `repair.json` with round, reason, failing AC, evidence reference, witness and recovery decision and returns to plan without a two-replan stop or renewed plan-approval prompt. Success remains the same protected contract; later decisions demand new diagnosis or materially changed strategy, not a model-correctness claim. Approved review is progress even when its fingerprint repeats. Ordinary execution/review defects use repair; stale release proof still requires named recovery. Bounds violations cannot ship; affected work/dependants wait while independent ready work drains, and compliant restoration resumes at test without widening task bounds. Transient failures write checkpointed `node.retry` events with delays 1000, 2000, … capped at 60000, one notification each, a truthful RETRY board row, no terminal due to attempt count and no round increment; restart finishes the recorded backoff. `/kpi stop` records `stop.json`, `loop.terminal STOPPED` and the resume command, and resume uses recorded topology/interrupted work without replaying completed actions. Legacy normalization preserves recorded cost. New run-status writes use only RUNNING, NEEDS_HUMAN, DONE or STOPPED. The former third-repeat `no_progress` approval requirement is explicitly superseded by the [RP-22 architectural decision](remediation-plan.md#architectural-rebuild-decision--2026-09-05), PRD AC-05.3 and `spec.md` §6; retained authority/security/release pauses remain meaningful.
- **ACs:** AC-05.1–05.9 · **Owner:** RP-21

### UAT-06 — US-06 Control-board TUI
- **Real-user question:** Do I know what is happening without reading model prose?
- **Action:** Start a job and capture the widget; watch the widget and the chat while a node runs; let it pause on a human node and capture again; run `/kpi status` with the model provider unreachable.
- **Pass evidence:** Machine work, including automatic retries/repairs, uses the imported cool emphasis; genuine human intervention uses restrained warm emphasis, returning to cool on resume. Historical theme names do not determine status colors. Widget shows LOOP, MODE, ROUND, STAGE, NODE, GATE, STOP and FILES; its NOW row changes without a keypress. Chat shows one start, finish, retry and route-change entry per actual event and none per tool call; reinstall/status does not repeat history. Accounts shows known remaining % per slot and none for local slots. Protocol events render as custom entries, not assistant markdown. With the provider unreachable, status still reads run files without inference. An attended human dialog may be RUNNING with an interrupted graph and an explicit pending question; an automatic interruption or stale question alone must not show human oversight, and DONE/STOPPED must not retain it.
- **ACs:** AC-06.1–06.7 · **Owner:** RP-18

### UAT-07 — US-07 Concise model output
- **Real-user question:** Does it answer in a few lines instead of a diary?
- **Action:** Run the structured-verdict fixture and measure the visible assistant body with `wc -c`.
- **Pass evidence:** Under 800 characters. The brevity rule lives in `APPEND_SYSTEM.md`, not `SYSTEM.md`. Skill `concise-output` description reads "Use whenever writing to the user."
- **ACs:** AC-07.1–07.3 · **Owner:** RP-18

### UAT-08 — US-08 Best-practice primitives on the path
- **Real-user question:** Do spec, TDD, isolated review, and conventional commits happen without me asking?
- **Action:** Run a non-trivial gated job in a fixture whose `AGENTS.md` names quality gates.
- **Pass evidence:** `specs/<id>/{requirements,design,tasks}.md` exist before implement. A failing test and its red output are in `evidence.json` before production code. The gate commands executed are byte-identical to the fixture `AGENTS.md` commands. The reviewer ran isolated and read-only. The commit subject matches Conventional Commits.
- **ACs:** AC-08.1–08.5 · **Owner:** RP-05, RP-14

### UAT-09 — US-09 Knowledge graph
- **Real-user question:** Do decisions survive as claims I can query rather than chat I lose?
- **Action:** Emit a `kg-claim`; drop a worker patch in `inbox/`; kill the process immediately after a snapshot.
- **Pass evidence:** `.kpi/kg/{nodes,edges,sources}.jsonl` plus `inbox/` and `snapshots/` exist. Every record carries `id`, `kind`, `source_ids`, `status`, `rev`, `observed_at`, with status in `proposed | verified | rejected | superseded`. Only the control plane wrote the authoritative files. After the injected crash the prior state is still readable.
- **ACs:** AC-09.1–09.4 · **Owner:** RP-12

### UAT-10 — US-10 Stacked subscriptions and failover
- **Real-user question:** When one subscription hits its limit, does work continue on another without me noticing?
- **Action:** `/accounts login anthropic` twice; drive the first slot to a classified 429 using `fixtures/accounts-failover/`; run 100 selections. Then rotate the `auth.json` grant out from under the official slot and start a session; break a non-official slot's refresh token and start a turn; send a request with a below-floor Claude Code identity.
- **Pass evidence:** Both slots persist in `~/.kpi/agent/accounts.json` and the second login deleted nothing; the second login's notice reads `Added account anthropic/<slot> (anthropic/<previous> keeps its previous grant)`. Model ids stay `anthropic/<official-id>`. The cooling slot is selected 0 times out of 100 while a healthy sibling exists, with the same model and thinking level carried over. Cross-family fallback happens only once the whole family cools, in order anthropic → openai-codex → xai → zai → kimi-coding → cursor. The widget lists remaining % per slot. Stickiness holds until exhaustion, then releases. After the rotation no `could not refresh` warning appears, `accounts.json` shows `official: true` on that slot, and `accounts.secrets.json` has no entry for it. The broken slot produces exactly one `K-π accounts: anthropic/<slot> needs a new login: Anthropic rejected its refresh token (invalid_grant). Run /accounts login anthropic <slot>` notification, the widget shows `<slot> … needs login`, and no stack trace is printed. The below-floor identity produces one `K-π <version> identifies to Anthropic as Claude Code …` notification and the slot is not cooled.
- **ACs:** AC-10.1–10.10 · **Owner:** RP-06, RP-07

### UAT-11 — US-11 Official catalogs stay live
- **Real-user question:** Will a brand-new model show up without me updating this app?
- **Action:** Run `kpi update --models`; inspect official catalogs before and after built-in registration. With an authorised Cursor seat, run `/accounts login cursor`, refresh models, select a discovered model and ask it to read a scratch file through a native tool; exercise cancellation and token renewal. Repeat discovery offline, with an empty successful response, and with a protocol failure using the scoped fixture.
- **Pass evidence:** No extension passes a `models` array for `anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, or `kimi-coding`. Cursor uses real browser PKCE/token renewal and CLI-protocol discovery/streaming; selected ids come from discovery or its native cache, missing metadata stays unknown, empty discovery clears stale entries and failures invent nothing. The read passes native tool hooks and returns the actual file content; no Cloud/subagent or bypass executor runs. Cancellation closes the request. Keep authenticated evidence separate from fixture proof; a testing release alone does not accept these live rows. README documents `kpi update --models`.
- **ACs:** AC-11.1–11.3 · **Owner:** RP-07

### UAT-12 — US-12 Anthropic extra-usage warning
- **Real-user question:** Was I warned before a subscription started billing me extra?
- **Action:** `/accounts login anthropic` on a fresh slot; read the dialog; cancel once; accept once; then log in again.
- **Pass evidence:** The warning appears before the OAuth window and states that extra usage is billed per token and is not the in-app Max bar. Cancel creates no slot. Accept sets `warningAcceptedAt` and later sessions do not re-prompt that slot.
- **ACs:** AC-12.1–12.4 · **Owner:** RP-07

### UAT-13 — US-13 Policy layers
- **Real-user question:** Can it do something irreversible to my repository, and does it stop asking me about things that cannot?
- **Action:** Attempt `git push origin main`, force-push, `rm -rf`, a production deploy, a write outside `write_allow`, and an unknown command — in gated and again in autopilot; then, after release approval, `git push -u origin kpi/<job>` and `gh pr create --head kpi/<job> --fill`. Then, in plain chat with no job, run `ls -la /etc`, a compound read-only command (`printf '%s\n' "$HOME"; command -v node || true`), `node --version | head -n 1` and `git commit`; then, inside a gated job, run an unknown command, choose *Always allow in this project*, restart the harness, and run it again.
- **Pass evidence:** All five are denied by the `tool_call` hook and never execute; the job-branch push and `gh pr create` are denied before release approval and run silently after it. Gated `git commit` asks for confirmation with files changed, insertions, and deletions. Autopilot `git commit` is denied without fresh `release.approved === true`. An unknown command asks in gated and is denied in autopilot. Chat never prompts and `git push` is still denied there. The confirm offers three choices; after *Always allow* `.kpi/policy.json` `allow[]` holds the exact command and the restarted session runs it silently.
- **ACs:** AC-13.1–13.6 · **Owner:** RP-02

### UAT-14 — US-14 Observability
- **Real-user question:** If my laptop dies mid-run, can I reconstruct what happened?
- **Action:** `kill -9` mid-implementer; verify the hash chain; run `/kpi status`; grep every artifact for planted secret canaries.
- **Pass evidence:** `events.jsonl` verifies as an unbroken `prev_hash`/`record_hash` chain. No state file is left partial, because writes are `*.tmp` → fsync → rename. `/kpi status` reads the checkpoint and names the interrupted stage. Zero canary hits.
- **ACs:** AC-14.1–14.4 · **Owner:** RP-01, re-proved by RP-19

### UAT-15 — US-15 Status bar with K-π brand
- **Real-user question:** Does the footer look right, and does it tell me the truth about cost?
- **Action:** Capture the footer idle, during a turn, inside a repo and outside one, with an `oauth` slot active and a `local` slot active, and at context 40, 60, 80, and 95 percent.
- **Pass evidence:** The leftmost cell is exactly `K-π`, never `π` and never `omp`. Segments run brand, model, thinking, path, git, context_pct, cost-or-`(sub)`, with powerline-thin chevrons. Context colour is green below 50, yellow 50–70, orange 70–90, red above 90. An `oauth` slot renders `(sub)`; a `local` slot renders exactly `(local) $0` with no quota percentage. The brand cell spins with elapsed seconds during a turn. `/statusbar` off restores the default footer.
- **ACs:** AC-15.1–15.10 · **Owner:** RP-18

### UAT-16 — US-16 Jobs-first terminal with graph detail
- **Real-user question:** Can I see what real jobs are doing and which need me, then inspect useful technical detail without losing the imported wireframes' styling and mentality?
- **Action:** In the built terminal capture Jobs home at 80, 108 and 120 columns with genuine RUNNING, NEEDS_HUMAN, DONE and STOPPED jobs. Select jobs with `j/k` and arrows, inspect Now/Next/Done, tab/shift-tab through human-action jobs, open details then a stage session, navigate stages, open help and attempt navigation, then back out with esc. Exercise labelled verify/stop/chat input, including stop with a different fleet job selected but not opened. Capture DETAILS at 140×50 and 140×40; render all views at retained 60/160/200-column cases. Watch refresh without keys, end/remove the opened job while another remains, reorder discovery, and exercise a read failure/recovery and failed job open. Capture widget/printed board during machine work, retry/repair and a genuine attended or parked human gate; empty/delete a run file and include a stale pause flag on automatic work.
- **Pass evidence:** HOME remains the dark Jobs list at every width, grouping NEEDS YOU, RUNNING, DONE and separately STOPPED; Now/Next/Done uses only genuine snapshots and recorded completion. Machine work stays cool, genuine intervention warm, and an automatic interruption/stale pause is not human oversight. An attended dialog can be RUNNING with graph interruption and an explicit pending question; it remains genuine intervention, unlike interruption alone. Required widget/printed-board fields remain: K-π, MODE, JOB, ROUND, current stage among 01–08, PASS/FAIL, six non-empty-file lamps and STOP; actual human intervention includes WAITING ON OPERATOR/question, shared files and APPROVAL lamp, plus THREE LAWS on the printed board. Empty/missing-file lamps are dark and stage position never invents completion. No assistant markdown redraw or model call.
- **Pass evidence (interaction/detail):** Enter opens DETAILS then SESSION/NODE; keys and help obey PRD AC-16.8. Tab visits real human-action jobs, not stages. Commands cannot act on an unopened fleet selection; opened-job stop runs once, verify stays in the overlay, refused shell/other kpi commands do not execute, ordinary chat closes before sending. At 140×50 DETAILS shows STAGES, LIVE, TELEMETRY, SHARED RUN STATE, CONTEXT LAYER and EVENTS; at 140×40 STAGES compacts while shared state/context remain. NODE shows actual status, elapsed, estimated cost/model/route and transcript; unknown telemetry is never invented and no run-cap token appears. The 80-column home retains Now/Next/Done, no framed line overflows at any named width, and narrow widget/printed board retain current stage/STOP.
- **Pass evidence (lifecycle):** NOW/stage detail/events refresh without keys; read errors are visible and later refresh recovers without concurrent slow reads. Fleet discovery continues after the opened job ends or disappears and selection remains stable by id across reorder; source-open errors are visible and the old overlay closes before switching. A local-only source shows only its real job and stops its ticker at terminal/gone; closing always disposes it. The detached loop leaves status, agents and chat usable. Imported HTML/fixture renders are not terminal or authenticated live acceptance.
- **ACs:** AC-16.1–16.9 · **Owner:** RP-22 terminal migration (historical RP-18 geometry retained); decision in [RP-22](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild), `spec.md` §11 and `visual-targets.md` §Command Centre

### UAT-17 — US-17 K-stack ships as built-in first-party skills
- **Real-user question:** Do I get the vendored engineering rigor without installing anything?
- **Action:** Fresh start in a scratch repo: type `/setup-kstack` and `/k-mode`; grep manifests; read the root `NOTICE`; grep operator chrome for `poteto`.
- **Pass evidence:** Both commands exist with no install and no trust step. No manifest depends on `pstack`, `open-pstack`, `@oh-my-pi/*`, or `pi-pstack`. `kstack/` carries the rewritten skills and playbooks and the root `NOTICE` carries the upstream MIT attribution. Operator chrome says K-stack and K-mode; `poteto-mode` appears at most as a one-time redirect notice.
- **ACs:** AC-17.1–17.4 · **Owner:** RP-16

### UAT-18 — US-18 Setup maps only wired models
- **Real-user question:** Does setup only offer me models I can actually run?
- **Action:** Run `/setup-kstack` with exactly one pool configured; try to write an unavailable slug; re-run setup twice.
- **Pass evidence:** Offered slugs are a subset of the live registry intersected with configured pools. A slug outside that set cannot be written to `~/.kpi/agent/kstack/models.json`. No Cursor Cloud Agent target is listed. A proposed map from `model-ladder.md` prints before any write, and the operator applies or edits it. Two consecutive writes are byte-identical under `cmp`.
- **ACs:** AC-18.1–18.6 · **Owner:** RP-16

### UAT-19 — US-19 K-mode follows a playbook and the graph
- **Real-user question:** Does K-mode give me real playbook steps that cannot skip the gates?
- **Action:** `/k-mode add a healthcheck and verify it`; attempt the ship todo with a stale or unapproved verdict; skip a step; send a new prompt in the same session.
- **Pass evidence:** The first todo names the four graph principles plus only the node-matched principle skills — no whole-index read. The matched playbook name is on `task.json.playbook`. The ship todo refuses unless `verdict.json.approved == true` and evidence is fresh. Skipped steps stay listed as `skip: <reason>`. `/k-mode` stays on until `/k-mode off`.
- **ACs:** AC-19.1–19.5 · **Owner:** RP-16

### UAT-20 — US-20 No cloud owners
- **Real-user question:** Will this ever start a cloud agent or push to origin behind my back?
- **Action:** Run the autopilot-full and autopilot-stack playbooks in scratch repositories with authorized delivery configured; inspect their native sessions and final commit/delivery records, then exercise missing delivery authority and attempt one more worker than the configured native admission limit.
- **Pass evidence:** Only native K-π sessions execute work; no Cursor Cloud or Graphite agent path executes. Neither playbook merges to origin or bypasses host verification/release approval. Completion requires the same verified one-commit/job-branch delivery record as other runs; missing external authority parks at the named prerequisite, not a false local-only DONE. Worker admission enforces configured capacity while independent branches may proceed and mutating checkout ownership stays exclusive. AC-20.2 has no local-commit-only exemption: see `spec.md` §7 Local blockers and operator gates / §12 and the [RP-22 architectural decision](remediation-plan.md#architectural-rebuild-decision--2026-09-05). This acceptance scenario does not authorize pushing this repository.
- **ACs:** AC-20.1–20.4 · **Owner:** RP-16

### UAT-21 — US-21 Upstream stays the source; overlay replays
- **Real-user question:** When upstream moves, is it one command and no hand-merging?
- **Action:** `npm run kstack:sync -- --pin <sha>` twice with the same pin; then with `fixtures/kstack-broken-patch/`; then `npm run kstack:sync:check`; then hand-edit a file in `generated/` and re-check.
- **Pass evidence:** `kstack/UPSTREAM.md` records repo, path `pstack/`, commit sha, upstream version, and the resolved tree id. The same pin twice is a byte no-op. The broken patch exits non-zero, leaves `generated/` byte-identical, and creates no `.rej`. `sync:check` fails on the hand edit. Operators never hit the network for this.
- **ACs:** AC-21.1–21.6 · **Owner:** RP-17

### UAT-22 — US-22 Minimalist stops over-engineering
- **Real-user question:** Does it stop inventing helpers and packages I never asked for?
- **Action:** Run the one-concat fixture — "add a helper class for one string concat" — then a task that needs an undeclared runtime dependency.
- **Pass evidence:** `skills/minimalist/SKILL.md` is present and credited. `candidate.json.ladder` is written before the first file change, with a known rung and non-empty `used` and `skipped`. The one-concat task produces a one-line change and zero new files. A runtime dependency not named in `task.json` fails bounds and cannot ship. Required error handling named by an AC is still present — minimalism did not delete it.
- **ACs:** AC-22.1–22.4 · **Owner:** RP-15

### UAT-23 — US-23 Background agents communicate asynchronously
- **Real-user question:** Do background agents work in parallel without corrupting my files?
- **Action:** Spawn two workers, then a third; spawn a second write-capable worker; claim the same path twice; kill a claim holder; check where the parent's decision came from. Run `/agents` while the review node is live and again after the run.
- **Pass evidence:** Each worker is a `kpi --mode rpc` session with its own session file under `.kpi/runs/<job>/agents/`. The third spawn is denied. The second writer is denied. A second `claim_path` on the same path is denied until release or holder-pid death. The parent decides from `verdict.json` and `evidence.json`, never a worker transcript. The board can show `AGENTS n`. No `pi-intercom`, `pi-mesh`, `pi-agents-talk-to-each-other`, `pi-bus`, or `pi-side-agents` in any manifest. A reviewer holding only `write_contract` does not consume the single-writer slot. `/agents` lists the main session, the in-process node sessions with context mode and model, and the reviewer worker with its pid and node under `KIND ID ROLE MODEL PID ALIVE ELAPSED TOOLS LAST NODE JOB`, then `caps (this process): …` and the mechanism line stating that nodes are in-process sessions and workers are separate `kpi --mode rpc` processes; the board reads `AGENTS 1 · 0 nodes · 1 worker` while the reviewer runs and repaints when it ends; after the run `/agents` still prints the main row and `no active job`.
- **ACs:** AC-23.1–23.11 · **Owner:** RP-13, RP-14

### UAT-24 — US-24 Bare message is plain chat; the agent starts a K-π job for substantial work
- **Real-user question:** Can I just type what I want, with no slash command, and get a job only when it is really a job?
- **Action:** With no live job type `hi`, then `why is the build red?`, then `add a healthcheck endpoint with a test and ship it`; with that job live type a bare follow-up; then `/kpi off` and repeat the goal; then `/kpi always` and type `add a metrics endpoint`.
- **Pass evidence:** The first two messages create no run directory and are answered in chat. The third produces a `kpi_start_job` call, a one-sentence reply, and exactly one run directory whose `task.json` has that goal and quality gates that match the repository's package manager. The follow-up steers the existing job and creates none. After `/kpi off` the goal is answered as chat with no run directory. After `/kpi always` the bare goal becomes `/kpi --mode gated add a metrics endpoint` directly.
- **ACs:** AC-24.1–24.4 · **Owner:** RP-05

### UAT-25 — US-25 TUI is information-complete, not pixel-perfect
- **Real-user question:** At 80 columns, can I still see the stage and the stop state?
- **Action:** Capture the above-editor widget and printed board at `COLUMNS=200`, `120`, `80` and `60`; exercise both actual human intervention and automatic work. Jobs home/detail navigation is exercised separately in UAT-16.
- **Pass evidence:** Every named widget/printed-board width keeps brand `K-π`, MODE, JOB, ROUND, stages 01–08, PASS/FAIL, six file lamps and STOP. Genuine human intervention keeps WAITING ON OPERATOR and the pending question, not a stale automatic pause. Truncation keeps current stage and STOP visible. Pixel match is not required; a missing required field fails. Moving technical detail behind Jobs home is not permission to remove these retained board fields.
- **ACs:** AC-25.1–25.4 · **Owner:** RP-18

### UAT-26 — US-26 z.ai and Kimi Coding pools
- **Real-user question:** Can I stack GLM and Kimi plans the same way I stack Anthropic?
- **Action:** `/accounts login zai` and read the first-run note; `/accounts login kimi-coding`; force a 429 on each; check the footer; grep manifests and `models.json`.
- **Pass evidence:** Pool ids are exactly `zai`, `zai-coding-cn`, `kimi-coding` with their documented env fallbacks, and no catalog is frozen. Same-family failover fires on 429/402/403-quota, with z.ai's 5-hour default cool-off when reset is unknown. Ids stay `zai/<official>` and `kimi-coding/<official>`, refreshed by `kpi update --models`. No hand-rolled `api.z.ai/api/coding/paas/v4`; no `moonshot` or `api.moonshot.ai`. The footer shows `(sub)`. No `pi-kimi-coder`, `pi-moonshot`, or `@czottmann/pi-zai-api` dependency. The first zai login shows the personal-use note.
- **ACs:** AC-26.1–26.8 · **Owner:** RP-07

### UAT-27 — US-27 Local models
- **Real-user question:** Can I run this fully local, and does it tell me honestly that it costs nothing?
- **Action:** Start llama.cpp, Ollama, LM Studio, and a bare OpenAI-compatible server; run `/llama`; log in to `ollama`, `lmstudio`, `local-openai`; check `/model`; stop one server mid-run; dump the default chain; capture the footer; capture outbound traffic.
- **Pass evidence:** `LLAMA_BASE_URL` defaults to `http://127.0.0.1:8080` under pool `llama`, and only loaded models appear in `/model`. The three first-party providers discover via `/v1/models`, with Ollama falling back to `/api/tags`, and no frozen models array. Each login writes a credential-free `kind: "local"` slot persisting its base URL. The stopped server's slot cools and failover stays inside the local family. Local slots are absent from the default cloud chain until `/pool chain` or a pin. The footer shows exactly one `(local) $0` cell with no quota percentage. Zero requests reach any cloud host. No `pi-ollama` family dependency.
- **ACs:** AC-27.1–27.8 · **Owner:** RP-08

### UAT-28 — US-28 Optional Exa, Perplexity, and Firecrawl research
- **Real-user question:** Can I add a research key, or none, and have it behave sensibly either way?
- **Action:** Run `/setup-kstack` five times — Exa only, Perplexity only, Firecrawl only, all three, none. Then force a 429, a timeout, and a 402 on one service. Then run a plan with only a Firecrawl key and read `research.json`. Then grep manifests and `accounts.json`.
- **Pass evidence:** All five combinations are valid. Keys live in `accounts.secrets.json` at `exa/default`, `perplexity/default`, and `firecrawl/default` with mode `0600`, and env vars are fallbacks only. Exa search and contents, Perplexity Search, and Firecrawl Search work as first-party REST with no SDK dependency. Each failure cools that service, tries the next configured service, records bounded attempts, and the graph does not hang. The Firecrawl-only plan records `firecrawl_search` calls to `POST /v2/search` with a Bearer header, `limit` ≤ 10, `sources: [{type: "web"}]` and no scrape options, and `research.json` reads `mode: "firecrawl"`, `network.state: "online"`. The footer or board can show `EXA`, `PPLX`, `FC`, or any of them. None of the three ids appears in `accounts.json.pools`, `/pool strategy`, `/pool chain`, or the fallback chain, and none registers a provider.
- **ACs:** AC-28.1–28.8 · **Owner:** RP-09, RP-10, RP-20

### UAT-29 — US-29 Research before implement
- **Real-user question:** Does it actually research before writing my code, and does it ever fake a citation?
- **Action:** Six runs: online with a key; no key; operator-set `no-network`; every configured service failing its bounded attempts; a healthy service returning one source; and `research.md` deleted before implement.
- **Pass evidence:** Specify and plan cannot exit without `research.md` and `research.json`. Online with a key records at least two sources with distinct canonical origins after dedup. With no key or under `no-network`, mode is `local`, sources are repository-relative paths, the RESEARCH lamp still lights, and no external URL appears that this job did not fetch. Missing or stale research pauses implement `NEEDS_HUMAN` with `recovery: research` and the resume command. A healthy service returning one source ends `NEEDS_HUMAN` and is never downgraded to local. Engine-set `no-network` writes `network.origin: "engine"`, a non-empty `network.reason` naming the services, and one recorded failure per attempt, and `no-network` never appears in a persisted stop-state field. Assistant prose contains no raw crawl dump.
- **ACs:** AC-29.1–29.7 · **Owner:** RP-09, RP-10

### UAT-30 — US-30 Feature ownership and canonical context
- **Real-user question:** Can I recover the task after reset, find the responsible feature and real symbols, and safely extend my existing project without invented TypeScript scaffolding?
- **Action:** Run valid existing Python/layered and root-level projects with differing feature ids/folder names, nonmatching test locations and an existing shared module with one consumer. Reject empty purpose, implicit catch-all ownership, unknown/cyclic dependencies, missing/stale stacks, conflicting selection, prefix/symlink escapes and task-bound expansion. Exercise optional scaffold with existing source bytes and explicit directories, plus vertical delivery and horizontal delivery with/without a reason. Reset a role session and retrieve protected intent, all required criteria, repairs, decisions, raw evidence and only its addressed peer messages. Refresh one changed repository file, then navigate a real symbol with an explicitly configured installed language server.
- **Pass evidence:** Explicit selected-module `allowed_paths` alone grants ownership; `modules[0]`, folder labels and inferred test twins never select or widen it. Invalid map/selection blocks writes and ordinary defects route to planner repair without new product consent. Unsafe ownership, empty purpose and cycles are refused. Existing language/layout/source and justified shared abstractions remain intact; no folder=id, auth-home, nested-only-layer or second-consumer gate is invented. Scaffold creates only declared authorized directories, no fake interface/tests; source and regression checks are added only as needed under accepted intent and the minimalist ladder. Horizontal delivery requires its declared reason; vertical remains the planning default. Product Feature Map and Repository Map stay distinct content-versioned projections; affected-file refresh preserves untouched entries. Mandatory intent/task/acceptance survives reset without truncation and raw artifacts remain retrievable; overflow is actionable. Real LSP results are distinguished from unsupported tooling. Fixtures and source inspection do not replace authenticated live reset/small-window and semantic-navigation proof. This follows the operator's Preserve existing layouts decision in [RP-22](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild), PRD US-30, `spec.md` §5 SCH-stack and `dune-architecture.md`.
- **ACs:** AC-30.1–30.11 · **Owner:** RP-22 migration (historical RP-11 fixture names retained as compatibility scenarios)

### UAT-31 — US-31 Onboarding
- **Real-user question:** Can I get from a clean install to a working K-π without reading the manual?
- **Action:** With a clean `HOME` (no `~/.kpi/agent/`), start the TUI in a scratch repo and walk the wizard once, choosing Not now first, then restarting and completing it with one model login, one research key, and the K-stack step skipped; restart again; run `/onboarding`; then start the harness under `--print` with the same clean `HOME`.
- **Pass evidence:** The empty install opens `Welcome to K-π` with Start setup / Not now before any prompt; Not now closes it, writes nothing under `~/.kpi/agent/` or the project, and the wizard returns on the next launch. The completed walk shows `Research keys (Exa, Perplexity, Firecrawl)` with Enter API keys / Skip and `K-stack roles` with Map roles now / Skip, ends with the `accounts: … / research keys: … / K-stack roles: skipped` summary, leaves the slot in `accounts.json`, the key in `accounts.secrets.json` (mode `0600`), no `~/.kpi/agent/settings.json`, no project `.kpi/settings.json`, and no trust prompt on relaunch. After a slot exists the wizard does not open by itself; `/onboarding` re-runs it, and a cancelled login is reported as `<pool> login not completed: …` while the wizard continues. Under `--print` the wizard never appears.
- **ACs:** AC-31.1–31.5 · **Owner:** RP-20

---

## PRD metrics

Run alongside the rows. Targets are `PRD.md` §8.

| ID | Metric | Pass evidence | Target |
|---|---|---|---|
| M-01 | Gated healthcheck fixture | Reaches human confirmation with green receipts | 1/1 |
| M-02 | Autopilot fixture, five executable AC | `DONE`, no human node, exactly one job-marked commit | 1/1 |
| M-03 | `fixtures/narrative-ac/` | Autopilot refused, `ac.refused` written, `coding-loop.auto.json` never loaded | 1/1 |
| M-04 | `fixtures/bounds-violation/` | `NEEDS_HUMAN` with `recovery: bounds`, zero commits created | 1/1 |
| M-05 | `fixtures/accounts-failover/`, 100 selections | Exhausted sibling selected 0 times while a healthy sibling exists | 1/1 |
| M-06 | Verdict fixture | Visible assistant reply under 800 characters | 1/1 |
| M-07 | `npm run check && npm test && npm run test:kpi && npm run kstack:sync:check && npm run upstream:check -- --offline` | All exit 0 | always |

---

## Sign-off

Record the decision per row as PASS or FAIL with the evidence path, and roll the set into `.kpi/remediation-proof.json`. A FAIL returns to the owning RP; it is never waived here, and this file never marks a package complete — only [`remediation-plan.md`](remediation-plan.md) does that.

Acceptance is a human judgement made from machine evidence. Anthropic's own guidance is the reason the human stays in the loop: automated tests verify that a change functions, while human review decides whether it fits the system (*Building effective agents*, published 2024-12-19, https://www.anthropic.com/engineering/building-effective-agents, read 2026-09-01). The dual human-question / runnable-action shape of each row follows the executable-example practice in Cucumber's *Behaviour-Driven Development* (https://cucumber.io/docs/bdd/, read 2026-09-01).
