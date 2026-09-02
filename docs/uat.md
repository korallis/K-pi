# uat.md — feature acceptance for K-π

> **AUTHORITY.** This is the feature-acceptance contract. It is not a work queue and it does not schedule anything: [`remediation-plan.md`](remediation-plan.md) remains the only active queue and the only package-completion authority.
>
> **WHEN.** UAT runs **after** every `RP-##` is complete and `npm run check`, `npm test`, `npm run test:kpi`, `npm run kstack:sync:check`, and `npm run upstream:check` all exit 0. Running a row earlier tells you nothing you can trust.
>
> **STOP CONDITION.** The product is finished when all thirty rows below and the seven PRD metrics pass, and a human can decide each row from its evidence **without reading source code**. A row whose evidence requires reading source is a FAIL — the feature is not observable to a real user.

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
- **Pass evidence:** Version reads K-π's own `0.1.0`, not a Pi version. `/kpi`, `/loop`, `/accounts`, `/specify`, `/plan`, `/review`, `/verify`, `/ship`, `/statusbar` all appear with no `/trust` and no install command. Theme `loop-amber` is selectable. No manifest declares `keywords:["pi-package"]`, a `pi` key, or `@earendil-works/pi-*` peer dependencies.
- **ACs:** AC-01.1–01.6 · **Owner:** RP-01A, re-proved by RP-19

### UAT-02 — US-02 Start from a task (gated)
- **Real-user question:** If I type a goal, does it plan, implement, test, review, and then ask me before committing?
- **Action:** In `fixtures/healthcheck-gated/`, run `/kpi add a healthcheck endpoint and verify it` and answer the confirm dialog.
- **Pass evidence:** `.kpi/runs/<job>/` holds `task.json` (with `goal`, `acceptance[]`, `nongoals`, `constraints`, `quality_gates`), `context.md`, `events.jsonl`. A human confirm dialog carrying a real diff stat appears before any commit. The board shows `MODE gated`, the current stage, `ROUND n/max`, and which run files exist. `git push` never runs.
- **ACs:** AC-02.1–02.7 · **Owner:** RP-02, RP-05

### UAT-03 — US-03 Start from a frozen plan
- **Real-user question:** Can I hand it a plan I already wrote and have it skip the spec step?
- **Action:** `/kpi --plan fixtures/healthcheck-gated/specs/healthcheck/`, then edit an acceptance criterion mid-run and continue.
- **Pass evidence:** The specify stage never lights. Plan files appear in the run store and are hashed into `fingerprints.json`. A `plan-check` stage runs. The mid-run AC edit stops autopilot as a mode violation, or prompts replan in gated.
- **ACs:** AC-03.1–03.4 · **Owner:** RP-05, RP-11

### UAT-04 — US-04 Autopilot when AC are executable
- **Real-user question:** With fully executable criteria, can I walk away and come back to a finished commit?
- **Action:** In `fixtures/healthcheck-auto/`, run `/kpi --mode autopilot <goal>`, leave, then inspect `git log -1` and `git status`.
- **Pass evidence:** No human node on the happy path. Terminal state `DONE`. Exactly one Conventional Commits commit on the job branch. `evidence.json` is bound to the `git rev-parse HEAD` it was produced against. The implementer wrote neither `verdict.json` nor `release.approved`. Any push, deploy, delete, or new-dependency attempt shows `NEEDS_HUMAN` or `UNSAFE` and did not execute.
- **ACs:** AC-04.1–04.6 · **Owner:** RP-02, RP-05, RP-14

### UAT-05 — US-05 Autopilot stop states
- **Real-user question:** When it cannot succeed, does it stop and tell me why instead of looping?
- **Action:** Run four cases: identical output twice; `maxRounds` exhaustion; `fixtures/bounds-violation/`; a reviewer issue with no test. Then retry a transient 429.
- **Pass evidence:** Stop states are exactly `NO_PROGRESS`, `EXHAUSTED`, `UNSAFE`, `NEEDS_HUMAN` respectively, with no other vocabulary. The retried 429 did not increment the round counter.
- **ACs:** AC-05.1–05.6 · **Owner:** RP-04, RP-05

### UAT-06 — US-06 Control-board TUI
- **Real-user question:** Do I know what is happening without reading model prose?
- **Action:** Start a job and capture the widget; let it pause on a human node and capture again; run `/kpi status` with the model provider unreachable.
- **Pass evidence:** Amber `#ff6a1a` while running, `protocol-blue #3da9fc` while paused. Widget shows LOOP, MODE, ROUND, STAGE, NODE, GATE, STOP, FILES. The accounts widget shows remaining % per slot, and no percentage for a `local` slot. Protocol events render as custom entries, not assistant markdown. `/kpi status` still draws with the provider unreachable, which proves no model call.
- **ACs:** AC-06.1–06.6 · **Owner:** RP-18

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
- **Action:** `/accounts login anthropic` twice; drive the first slot to a classified 429 using `fixtures/accounts-failover/`; run 100 selections.
- **Pass evidence:** Both slots persist in `~/.kpi/agent/accounts.json` and the second login deleted nothing. Model ids stay `anthropic/<official-id>`. The cooling slot is selected 0 times out of 100 while a healthy sibling exists, with the same model and thinking level carried over. Cross-family fallback happens only once the whole family cools, in order anthropic → openai-codex → xai → zai → kimi-coding → cursor. The widget lists remaining % per slot. Stickiness holds until exhaustion, then releases.
- **ACs:** AC-10.1–10.8 · **Owner:** RP-06, RP-07

### UAT-11 — US-11 Official catalogs stay live
- **Real-user question:** Will a brand-new model show up without me updating this app?
- **Action:** Run `kpi update --models`; grep the built bundle for a `models:` array passed to an official provider id.
- **Pass evidence:** No extension passes a `models` array for `anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, or `kimi-coding`. Cursor implements `refreshModels` with a fallback list used only before the first sync. README documents `kpi update --models`.
- **ACs:** AC-11.1–11.3 · **Owner:** RP-07

### UAT-12 — US-12 Anthropic extra-usage warning
- **Real-user question:** Was I warned before a subscription started billing me extra?
- **Action:** `/accounts login anthropic` on a fresh slot; read the dialog; cancel once; accept once; then log in again.
- **Pass evidence:** The warning appears before the OAuth window and states that extra usage is billed per token and is not the in-app Max bar. Cancel creates no slot. Accept sets `warningAcceptedAt` and later sessions do not re-prompt that slot.
- **ACs:** AC-12.1–12.4 · **Owner:** RP-07

### UAT-13 — US-13 Policy layers
- **Real-user question:** Can it do something irreversible to my repository?
- **Action:** Attempt `git push`, force-push, `rm -rf`, a production deploy, a write outside `write_allow`, and an unknown command — in gated and again in autopilot.
- **Pass evidence:** All five are denied by the `tool_call` hook and never execute. Gated `git commit` asks for confirmation with files changed, insertions, and deletions. Autopilot `git commit` is denied without fresh `release.approved === true`. An unknown command asks in gated and is denied in autopilot.
- **ACs:** AC-13.1–13.4 · **Owner:** RP-02

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

### UAT-16 — US-16 Graph-engineering TUI (Avid boards)
- **Real-user question:** Does the running board tell me everything the Avid photo promises?
- **Action:** Capture the amber board mid-run and the protocol-blue board while a human node is paused; delete one run file and capture again.
- **Pass evidence:** The amber board shows the header (`K-π`, MODE, JOB, ROUND), context-layer lamps, stages 01–08 with exactly one lit, iteration PASS/FAIL, six file lamps, and STOP. `/kpi status` expands it with no model call. The paused board shows SHARED RUN STATE, STOP STATES with APPROVAL lit, THREE LAWS, and WAITING ON OPERATOR with the pending question. The lamp for the deleted or empty file goes dark. The assistant never reprints the board as a markdown table.
- **ACs:** AC-16.1–16.6 · **Owner:** RP-18

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
- **Action:** Run the autopilot-full and autopilot-stack playbooks; grep the loaded runtime tree; try to spawn a third worker.
- **Pass evidence:** Only local isolated K-π sessions spawn. Neither playbook merges to origin; the terminal state is `DONE` plus a local commit per mode. A grep of runtime `kstack/` finds zero hits for `cloud agent`, `gt submit`, `subagent_type`, `cursor-team-kit`. The third concurrent worker is denied, and arena and swarm both cap at 2.
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
- **Action:** Spawn two workers, then a third; spawn a second write-capable worker; claim the same path twice; kill a claim holder; check where the parent's decision came from.
- **Pass evidence:** Each worker is a `kpi --mode rpc` session with its own session file under `.kpi/runs/<job>/agents/`. The third spawn is denied. The second writer is denied. A second `claim_path` on the same path is denied until release or holder-pid death. The parent decides from `verdict.json` and `evidence.json`, never a worker transcript. The board can show `AGENTS n`. No `pi-intercom`, `pi-mesh`, `pi-agents-talk-to-each-other`, `pi-bus`, or `pi-side-agents` in any manifest. A reviewer holding only `write_contract` does not consume the single-writer slot.
- **ACs:** AC-23.1–23.9 · **Owner:** RP-13, RP-14

### UAT-24 — US-24 Bare message starts gated K-mode
- **Real-user question:** Can I just type what I want, with no slash command?
- **Action:** With no active job type `add a healthcheck`; then type `/accounts`; then with a job active type a bare follow-up; then `/kpi off`.
- **Pass evidence:** The bare message starts sticky `/k-mode` plus a gated `/kpi` with that text. Commands are never auto-wrapped. The bare follow-up steers the existing job and starts no second job — the run directory count stays at one. `/kpi off`, or `kpi.autoWrap = false`, restores plain harness input.
- **ACs:** AC-24.1–24.4 · **Owner:** RP-05

### UAT-25 — US-25 TUI is information-complete, not pixel-perfect
- **Real-user question:** At 80 columns, can I still see the stage and the stop state?
- **Action:** Capture the board at `COLUMNS=200`, `120`, `80`, and `60`.
- **Pass evidence:** Every width keeps brand `K-π`, MODE, JOB, ROUND, stages 01–08, PASS/FAIL, six file lamps, and STOP. A paused board keeps WAITING ON OPERATOR and the pending question. Truncation always keeps the current stage and STOP visible. Pixel match is not required; a missing required field fails the row.
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

### UAT-28 — US-28 Optional Exa and Perplexity research
- **Real-user question:** Can I add a research key, or none, and have it behave sensibly either way?
- **Action:** Run `/setup-kstack` four times — Exa only, Perplexity only, both, neither. Then force a 429, a timeout, and a 402 on one service. Then grep manifests and `accounts.json`.
- **Pass evidence:** All four combinations are valid. Keys live in `accounts.secrets.json` at `exa/default` and `perplexity/default` with mode `0600`, and env vars are fallbacks only. Exa search and contents plus Perplexity Search work as first-party REST with no SDK dependency. Each failure cools that service, tries the other, records bounded attempts, and the graph does not hang. The footer or board can show `EXA`, `PPLX`, or both. Neither id appears in `accounts.json.pools`, `/pool strategy`, `/pool chain`, or the fallback chain, and neither registers a provider.
- **ACs:** AC-28.1–28.7 · **Owner:** RP-09, RP-10

### UAT-29 — US-29 Research before implement
- **Real-user question:** Does it actually research before writing my code, and does it ever fake a citation?
- **Action:** Six runs: online with a key; no key; operator-set `no-network`; every configured service failing its bounded attempts; a healthy service returning one source; and `research.md` deleted before implement.
- **Pass evidence:** Specify and plan cannot exit without `research.md` and `research.json`. Online with a key records at least two sources with distinct canonical origins after dedup. With no key or under `no-network`, mode is `local`, sources are repository-relative paths, the RESEARCH lamp still lights, and no external URL appears that this job did not fetch. Missing or stale research makes implement `UNSAFE`. A healthy service returning one source ends `NEEDS_HUMAN` and is never downgraded to local. Engine-set `no-network` writes `network.origin: "engine"`, a non-empty `network.reason` naming the services, and one recorded failure per attempt, and `no-network` never appears in a persisted stop-state field. Assistant prose contains no raw crawl dump.
- **ACs:** AC-29.1–29.7 · **Owner:** RP-09, RP-10

### UAT-30 — US-30 Dune modular stack
- **Real-user question:** In six months, will I still find auth in `auth/` and a feature in its own folder?
- **Action:** Run the plan node, then every invalid-stack fixture RP-11 names: missing stack, stale stack, second selected module, prefix escape (`src/auth-admin` against `src/auth`), auth under `lib/`, top-level layer folder, top-level generic folder, one-consumer `shared/`, horizontal delivery with no reason, no-stack exemption, second-slice extraction, and scaffold order.
- **Pass evidence:** `stack.json` carries `folder`, `interface`, `allowed_paths`, `scaffold_first` per module. A valid stack reaches implement. Every invalid fixture reaches `UNSAFE` before the first write, proven by write-attempt timestamps. `claim_path` outside the current module folder and its test twin is `UNSAFE`, and `modules[0]` is never an implicit current module. Folder name equals module id; auth's home is not `services/` or `lib/`; layer folders live only inside a feature folder; a single-consumer file cannot live in `shared/`; default delivery is `vertical`; an all-APIs-then-all-UI plan without `delivery: "horizontal"` and a reason fails the plan gate; scaffold creates folder, interface, and test twin before behaviour.
- **ACs:** AC-30.1–30.11 · **Owner:** RP-11

---

## PRD metrics

Run alongside the rows. Targets are `PRD.md` §8.

| ID | Metric | Pass evidence | Target |
|---|---|---|---|
| M-01 | Gated healthcheck fixture | Reaches human confirmation with green receipts | 1/1 |
| M-02 | Autopilot fixture, five executable AC | `DONE`, no human node, exactly one job-marked commit | 1/1 |
| M-03 | `fixtures/narrative-ac/` | Autopilot refused, `ac.refused` written, `coding-loop.auto.json` never loaded | 1/1 |
| M-04 | `fixtures/bounds-violation/` | `UNSAFE`, zero commits created | 1/1 |
| M-05 | `fixtures/accounts-failover/`, 100 selections | Exhausted sibling selected 0 times while a healthy sibling exists | 1/1 |
| M-06 | Verdict fixture | Visible assistant reply under 800 characters | 1/1 |
| M-07 | `npm run check && npm test && npm run test:kpi && npm run kstack:sync:check && npm run upstream:check -- --offline` | All exit 0 | always |

---

## Sign-off

Record the decision per row as PASS or FAIL with the evidence path, and roll the set into `.kpi/remediation-proof.json`. A FAIL returns to the owning RP; it is never waived here, and this file never marks a package complete — only [`remediation-plan.md`](remediation-plan.md) does that.

Acceptance is a human judgement made from machine evidence. Anthropic's own guidance is the reason the human stays in the loop: automated tests verify that a change functions, while human review decides whether it fits the system (*Building effective agents*, published 2024-12-19, https://www.anthropic.com/engineering/building-effective-agents, read 2026-09-01). The dual human-question / runnable-action shape of each row follows the executable-example practice in Cucumber's *Behaviour-Driven Development* (https://cucumber.io/docs/bdd/, read 2026-09-01).
