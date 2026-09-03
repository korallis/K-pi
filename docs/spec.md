# spec.md — k-pi

**Status:** Implementable  
**Normative.** If code disagrees with this file, the code is wrong unless this file is updated in the same change.  
**IDs:** `REQ-*`, `NFR-*`, `SCH-*`, `EVT-*`

---

## 1. System context

K-π is a standalone harness: one executable, one process. It is a fork of Pi `v0.84.4` (base commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`), tracked through the `upstream` git remote per `../UPSTREAM.md`. Pi is not the host process, is not installed alongside K-π, and is not a dependency.

```
operator
  └─ kpi — interactive / print / rpc
       ├─ forked harness base          TUI, agent loop, providers, sessions, RPC
       └─ K-π built-in extension       registered in the binary, no install, no trust gate
            ├─ control-plane           /kpi commands, widgets, policy
            ├─ status-line             Oh My Pi-style footer, brand K-π
            ├─ graph                   DAG runner on the harness SDK
            ├─ accounts                multi-sub pool + failover
            ├─ cursor                  registerProvider("cursor")
            ├─ kg                      JSONL claim store
            └─ resources               skills, prompts, themes, graphs discovered by the built-in
```

K-π extends the forked base through the base's own extension surface. Forking is not a licence to rebuild resource loading, model catalogs, sessions, or RPC.

## 2. Distribution and layout

K-π is not a Pi extension package. There is no `pi install`, no `keywords: ["pi-package"]`, no `package.json#pi` manifest, and no `peerDependencies` on `@earendil-works/pi-*`. It is distributed as its own CLI: exactly one published npm package, `@korallis/k-pi` (NH-04).

Root `package.json` is `k-pi-monorepo`, private, using npm workspaces. `packages/coding-agent/package.json` MUST contain:

```json
{
  "name": "@earendil-works/pi-coding-agent",
  "bin": {
    "kpi": "dist/bundle/cli.js",
    "k-pi": "dist/bundle/cli.js"
  },
  "piConfig": {
    "name": "kpi",
    "title": "K-π",
    "configDir": ".kpi"
  }
}
```

REQ-DIST-01. The internal package name stays upstream-compatible so upstream releases merge with minimal conflict. It is merge hygiene, not a dependency: nothing is resolved from a registry under that name.

REQ-DIST-02. `bin` declares exactly `kpi` and `k-pi`. The upstream `pi` bin MUST NOT exist.

REQ-DIST-03. `piConfig` yields `APP_NAME = kpi`, `APP_TITLE = K-π`, `CONFIG_DIR_NAME = .kpi`, and env overrides `KPI_CODING_AGENT_DIR` / `KPI_CODING_AGENT_SESSION_DIR`. Every project-local runtime path derives from `CONFIG_DIR_NAME`; none hard-codes `.pi`.

REQ-DIST-04. The K-π extension factory is registered as a **visible built-in**. Its skills, prompts, themes, and graphs are declared by that built-in through resource discovery and copied into `dist` at build time. K-π's own commands are available at startup with no install and no project-trust decision. Project trust continues to govern a user's repo-local resources, unchanged from the base.

REQ-DIST-05. Exactly one artifact is published: `@korallis/k-pi`. It is assembled by `scripts/pack-kpi.mjs` from the built CLI, and its payload is `dist/bundle`, `dist/modes/interactive/{theme,assets}`, `dist/core/export-html`, `dist/kpi`, `docs`, `examples`, and `README.md` / `CHANGELOG.md` / `LICENSE` / `NOTICE`. Its runtime dependencies are only `@silvia-odwyer/photon-node` and `jiti`, with `@mariozechner/clipboard` optional; the published manifest MUST NOT depend on any `@earendil-works/*` package. It declares the bins `kpi` and `k-pi`, and carries `piConfig` and `version` verbatim from `packages/coding-agent/package.json`. Publishing happens only in `.github/workflows/release.yml`, on the tag `v<version>`, through npm trusted publishing with provenance. Every workspace manifest, including `packages/coding-agent/package.json`, still carries no publish, prepublish, or shrinkwrap script, and no workspace name ever reaches the registry.

Forbidden runtime dependencies: `oh-my-pi`, `@oh-my-pi/*`, `atomic`, `pi-graph`, `@shying/pi-graph`, `pi-multi-account`, `pi-multi-pass`, `pi-cursor-oauth`, `pi-cursor-provider`, `@pi-stef/cursor`, `pi-kimi-coder`, `pi-moonshot`, `@czottmann/pi-zai-api`, `pi-ollama`, `@jamesjfoong/pi-ollama`, `pi-ollama-keyring`, `pi-ollama-cloud-provider`, `exa-js`, `@perplexity-ai/perplexity_ai`.

## 3. Repository layout

```
K-pi/                                     k-pi-monorepo (private, npm workspaces)
├── package.json
├── upstream.json                         machine-readable Pi pin
├── UPSTREAM.md  NOTICE  LICENSE
├── AGENTS.md  README.md  START-HERE.md  docs/  design/
├── kpi-test.sh / .ps1 / .bat             run from source without building
├── test/*.test.ts                        K-π node tests, importing ../packages/coding-agent/src/kpi/...
├── fixtures/                             normative test fixtures
└── packages/                             forked Pi harness — K-π source, not a dependency
    └── coding-agent/
        ├── package.json                  bins kpi + k-pi; piConfig name/title/configDir
        └── src/
            ├── **                        upstream harness: TUI, agent loop, providers, sessions, RPC
            └── kpi/                      K-π runtime
                ├── extensions/
                │   ├── index.ts          built-in extension factory
                │   ├── control-plane.ts
                │   ├── run-store.ts
                │   ├── append-log.ts
                │   ├── policy.ts
                │   ├── renderers.ts
                │   ├── graph/{engine.ts,schema.ts}
                │   ├── accounts/{index.ts,store.ts,balancer.ts,errors.ts,usage/*.ts}
                │   ├── cursor/{provider.ts,oauth.ts}
                │   └── kg/{index.ts,store.ts}
                ├── graphs/{coding-loop.gated.json,coding-loop.auto.json,spec-first.json,hotfix.json}
                ├── skills/{spec-first,tdd-cycle,isolated-review,quality-gates,conventional-commit,context-pack,concise-output,kg-claim}/SKILL.md
                ├── prompts/{specify,plan,implement,review,verify,ship}.md
                ├── themes/{loop-amber.json,protocol-blue.json}
                ├── templates/{AGENTS.md,APPEND_SYSTEM.md,context-pack/{product,structure,tech}.md}
                ├── schemas/*.json
                └── kstack/
```

Build and run:

```sh
npm install && npm run build
node packages/coding-agent/dist/bundle/cli.js
# or: npm link --workspace @earendil-works/pi-coding-agent && kpi
```

REQ-DIST-06. The build copies K-π's graphs, skills, prompts, themes, templates, and schemas into `dist` so the built binary resolves them without the source tree.

Operator paths at runtime:

- Project: `.kpi/` settings, graphs, runs
- User secrets: `~/.kpi/agent/accounts.json`, `~/.kpi/agent/accounts.secrets.json`

REQ-DIST-07. Elsewhere in this document, bare paths `extensions/…`, `graphs/…`, `skills/…`, `prompts/…`, `themes/…`, `templates/…`, `schemas/…`, and `kstack/…` are relative to `packages/coding-agent/src/kpi/`.

Consumer repo after bootstrap:

```
AGENTS.md
.kpi/APPEND_SYSTEM.md
.kpi/graphs/
.kpi/kg/
.kpi/runs/
.kpi/context/
.kpi/policy.json
specs/
```

## 4. Entry points

| Command | Behavior |
|---|---|
| *(bare text)* | Plain harness input. Under `kpi.routing = auto` (default) the agent may call the `kpi_start_job` tool, which queues `/kpi --mode <mode> <goal>` for after the current turn and sets sticky K-mode; `always` wraps bare text into a gated `/kpi` directly; `off` never starts a job automatically. A live job owns bare follow-ups. |
| `/kpi auto\|always\|off` | Session routing override. `kpi.routing` in project `.kpi/settings.json` or user `~/.kpi/agent/settings.json` (`{"kpi":{"routing":…}}`) sets the default; project wins. |
| `kpi_start_job` | Tool. Parent session only — never a graph node, never a bus worker. Refuses greetings, questions, goals under 12 characters, and any goal while a job is live. |
| `/kpi [goal]` | Gated coding loop from a task. `/loop` is an alias. The loop runs detached from the handler: the command returns once the job is started, and a second `/kpi <goal>` is refused while it runs (`K-π job <id> is still running: /kpi status shows it, /kpi stop stops it`). A flag naming a retired cap is refused: `K-π runs have no caps; cost and elapsed time are reported on the board`. |
| `/kpi <job>` | Resume a run. Anything but `DONE` resumes — `NEEDS_HUMAN` at its recovery, `STOPPED` at the node it stopped in, a paused run at its pause node's resume targets; a `DONE` job is a no-op. |
| `/kpi --plan <path>` | Skip specify; freeze plan files |
| `/kpi --mode gated\|autopilot` | Force mode |
| `/kpi --until-green` | Alias of autopilot |
| `/kpi --no-network` | Operator-flagged offline research (`network.origin: "operator"`) |
| `/kpi status` | Opens the K-π Command Centre: a live, full-width overlay from run files, no model (§11). In print/rpc mode it prints the board as text. |
| `/kpi stop` | Immediate. Writes `<run>/stop.json` `{ reason: "operator stop", at, recorded }` and `STOPPED`: a loop live in this process is aborted at once and records its own terminal; a loop in another process stops at its next checkpoint or wait, and the control plane records `loop.terminal STOPPED reason: operator stop` itself. Notice `K-π job <id> STOPPED (resume with /kpi <id>)`. A stop before the run directory exists creates nothing. |
| `/agents` | Live sessions of this kpi process: main, in-process graph nodes, worker processes, per-process caps, and the mechanism line. Files and memory only, no model. |
| `/onboarding` | Guided first-run setup: welcome → model accounts → research keys (Exa, Perplexity, Firecrawl) → K-stack roles; every step skippable, re-runnable any time. Opens by itself on a TUI startup with no configured slot and no harness-available model, never in print/rpc/json; "Not now" closes it for that launch and nothing records the choice. Writes nothing on its own: accounts and keys go through the same writers as `/accounts login` and `/setup-kstack`, and no project file is created. |
| `/statusbar` | Toggle the K-π footer |
| `/specify [goal]` | Spec files only |
| `/plan [goal]` | Isolated plan |
| `/implement` | Implementer node only |
| `/review` | Isolated reviewer |
| `/verify` | Run gates → `evidence.json` |
| `/ship` | Gated confirm or no-op if already `DONE` |
| `/accounts` | Slot overlay |
| `/accounts login <pool>` | Add a model slot. Pools: anthropic, openai, openai-codex, xai, zai, zai-coding-cn, kimi-coding, cursor, llama, ollama, lmstudio, local-openai. |
| `/accounts login exa\|perplexity\|firecrawl` | Store a research credential. Research targets are not pools: no slot, no routing, no fallback-chain entry. See `research.md`. |
| `/accounts logout <slot>` | Drop slot. `/accounts logout exa\|perplexity\|firecrawl` clears that research credential. |
| `/accounts next` | Force sibling |
| `/accounts pin <slot>` | Stick session |
| `/pool strategy <provider> <name>` | |
| `/pool chain a,b,c` | Fallback order |
| `/kg query` `/kg propose` | Claim store |
| `/setup-kstack` | Role map from `model-ladder.md`, then Exa, Perplexity, and Firecrawl key save/skip and the project research mode. See `kstack.md`. |
| `/k-mode [task]` | Sticky rigor playbook. `/k-mode off` clears it. |
| `spawn_background` | Tool. Headless K-π worker. See `agents-bus.md`. |
| `communicate` | Tool. Deliver via `sendUserMessage` / RPC `prompt`. |

Prompt templates expand via the harness slash-template mechanism (`prompts/*.md`). Commands that need UI or side effects are extension registrations (`pi.registerCommand`, where `pi` is the `ExtensionAPI` object the harness passes to an extension factory — the name of a parameter, not a separate program).

## 5. Run store

**REQ-RS-01** Every job has `job_id` kebab-case, time-prefixed allowed.

**Path:** `.kpi/runs/<job_id>/`

| File | Writer | Role |
|---|---|---|
| `task.json` | ac-compiler / control plane | Contract |
| `context.md` | control plane at start | Frozen pack |
| `candidate.json` | implementer via contract | Semantic payload only |
| `evidence.json` | tester, via `write_contract` | HEAD-bound receipts |
| `verdict.json` | reviewer only, via `write_contract` | PASS/REVISE/BLOCKED |
| `state.json` | driver (gated loop) | Progress. See the field list under SCH-event. |
| `events.jsonl` | append-log | Hash chain |
| `research.md` / `research.json` | specify/plan research node | Mode, network state, sources + notes. Required before implement. |
| `stack.json` | plan | Dune modules. Frozen before implement. |
| `fingerprints.json` | control plane | SHA-256 of canonical JSON |
| `stop.json` | control plane / `/kpi stop` | `{ reason: "operator stop", at, recorded }`. The operator's stop marker, honoured at every checkpoint and after every backoff. `recorded` says who appended the `STOPPED` terminal: the control plane (no loop live) or the driver whose loop was aborted. |
| `repair.json` | driver, on a repeated witness | The planner's brief after no progress: `round`, `reason`, `failing_ac[]`, `evidence_ref` (`verdict.json` \| `evidence.json`), `witness`, optional `guidance` from the operator. Kept in `state.json` as `plan_repair`. |

**REQ-RS-02** Atomic write: `foo.tmp` → fsync → rename to `foo` in the same directory.

**REQ-RS-03** One writer per file. Graph workers do not write `state.json` or `kg/*.jsonl`. A read-only role publishes its own run-contract file through `write_contract` (REQ-RS-06); that capability is not a general write tool and does not make the role a writer.

### SCH-task

```json
{
  "job_id": "2026-08-31-healthcheck",
  "mode": "gated",
  "goal": "string",
  "nongoals": ["string"],
  "acceptance": [
    {
      "id": "AC-03",
      "statement": "string",
      "required": true,
      "check": {
        "kind": "command",
        "cmd": "pnpm test -- tests/health.test.ts",
        "expect": { "exit": 0, "stdout_includes": ["ok"] }
      },
      "bounds": {
        "write_allow": ["src/health.ts", "tests/health.test.ts"],
        "write_deny": [".env", "pnpm-lock.yaml"]
      }
    }
  ],
  "constraints": ["string"],
  "quality_gates": ["pnpm test", "pnpm lint"],
  "ac": { "quality": "executable" }
}
```

`check.kind` enum: `command | file_exists | file_absent | grep_empty | grep_matches | json_path | http_probe`.  
`http_probe` is local-only (localhost / 127.0.0.1).  
`ac.quality` enum: `executable | partial | narrative`.  
`task.schema.json` carries no `limits`: a task that names one is rejected. A legacy `task.json` carrying `limits` is read leniently by resume and never validated; its caps are ignored.

### SCH-verdict

```json
{
  "status": "REVISE",
  "approved": false,
  "blockingIssues": ["string"],
  "nonBlockingIssues": ["string"],
  "evidence": ["path:line"],
  "round": 2,
  "output_fingerprint": "sha256:…"
}
```

Reviewer `response.schema` MUST require `approved`, `blockingIssues`, `evidence`.

### SCH-evidence

```json
{
  "head": "<git sha>",
  "commands": [
    { "cmd": "pnpm test", "exit": 0, "excerpt": "…" }
  ],
  "ac_results": [{ "id": "AC-03", "passed": true }]
}
```

Stale if `head` ≠ current `git rev-parse HEAD`.

### SCH-research

```json
{
  "job_id": "2026-08-31-healthcheck",
  "task_hash": "sha256:…",
  "mode": "auto",
  "network": {
    "state": "no-network",
    "origin": "engine",
    "reason": "exa and perplexity each failed their bounded attempts",
    "failures": [
      { "service": "exa", "class": "http_429", "at": "2026-08-31T14:02:10.004Z" },
      { "service": "perplexity", "class": "timeout", "at": "2026-08-31T14:02:41.118Z" }
    ]
  },
  "sources": [
    { "kind": "local", "ref": "src/health.ts:22", "title": "existing healthcheck handler", "service": null, "observed_at": "2026-08-31T14:03:02.900Z" }
  ]
}
```

`mode` enum: `exa | perplexity | firecrawl | auto | local`.  
`network.state` enum: `online | no-network`.  
`network.origin` enum: `operator | engine`, present only when `state` is `no-network`.  
`failures[].class` enum: `http_402 | http_429 | http_5xx | timeout | abort | unavailable`.  
`sources[].kind` enum: `external | local`. An `external` `ref` is an absolute HTTP(S) URL this job actually fetched; a `local` `ref` is a repository-relative `path` or `path:line`.

### SCH-event

```json
{
  "ts": "2026-08-31T14:12:01.331Z",
  "type": "handoff.created",
  "job_id": "…",
  "round": 2,
  "node": "reviewer",
  "prev_hash": "…",
  "record_hash": "…"
}
```

**EVT types (26):** `handoff.created`, `tool.request`, `approval.result`, `tool.result`, `checkpoint`, `handoff.completed`, `recovery.started`, `recovery.completed`, `kg.patch.proposed`, `kg.patch.accepted`, `accounts.failover`, `ac.refused`, `loop.terminal`, `review.verdict`, `research.started`, `research.query`, `research.call`, `research.result`, `research.fallback`, `research.completed`, `agent.spawned`, `agent.message`, `agent.denied`, `node.started`, `node.finished`, `node.retry`.

Payloads beyond the common fields:

- `approval.result` — `approved` (boolean), optional `question`, optional `feedback` (the change request when a gate with a `feedbackPath` was denied). A gated run writes two: `node: plan-approval` before `node: human`.
- `loop.terminal` — `status` ∈ `DONE | NEEDS_HUMAN | STOPPED`, optional `reason`, and on `NEEDS_HUMAN` a `recovery` ∈ `approval | provider | delivery | ship | bounds | review | no_progress | research | stack | contract | ac_quality`. One per pause or stop; a run that resumes and pauses again writes another.
- `node.started` — `run` (integer ≥ 1), optional `model`. Written by the engine when an agent node's batch attempt starts; a resumed running node re-emits it with the same `run`.
- `node.finished` — `run`, `status` ∈ `completed | failed`, `elapsed_ms`, optional `cost_usd` (summed across every attempt of the run; omitted, never zeroed, when the session has no billing), optional `result`, `session`, `error`. Transient retries inside a run repeat neither `node.started` nor `node.finished`.
- `node.retry` — `attempt` (integer ≥ 1), `reason` ∈ `http | timeout | transport`, `delay_ms` (integer ≥ 0), optional `status` (HTTP status integer), optional `message`. Written by the driver's `onRetry` after the engine's checkpoint and before the wait.

`state.json` (written by the driver on every state change; the persisted run status the control plane and the board read): `job_id`, `mode`, `round`, `stage`, `node`, `passed`, `bounds`, `review`, `release`, `ac`, `status` ∈ `RUNNING | NEEDS_HUMAN | DONE | STOPPED`, optional `reason`, `recovery` (on `NEEDS_HUMAN`), `graph_status`, `superstep`, `pending_question`, `limits: { maxConcurrency }`, `started_at_ms`, the report-only counters `elapsed_ms`, `cost_usd`, `graph_round`, `batches`, the stop-safety fields `evidence_fingerprints[]`, `output_fingerprints[]`, `failing_ac_sets[]`, `last_test_evidence`, `repaired[]` (witnesses re-planned since the last operator touch), `plan_repair` (the `repair.json` brief), `retry { node, attempt, reason, delay_ms, until_ms }` while a node backs off, and `playbook` / `todos`. No cap field exists; a legacy document carrying one is read and its cap ignored.

**REQ-RS-04** Hash: serialize record without `record_hash` as RFC 8785 canonical JSON UTF-8, SHA-256 lowercase hex. Chain `prev_hash` to previous `record_hash`. First record `prev_hash` is 64 zeros.

**REQ-RS-05** Redact tokens, cookies, passwords, `sk-`, `oat01-`, bearer values from events.

**REQ-RS-06** `write_contract` is a dedicated capability, not `write` or `edit`. It is pinned at spawn to one agent id, one `job_id`, one role, and one declared contract path — `verdict.json` for the reviewer, `evidence.json` for the tester. It schema-validates the payload against `SCH-verdict` or `SCH-evidence` before touching disk, then performs the atomic write of REQ-RS-02. Any other path, any other role, any other job, or a payload that fails validation is denied and recorded; a denied call is role failure, never approval. Holding `write_contract` grants no product-file mutation and does not consume the single-writer worker slot.

**REQ-RS-07** Online research success requires at least two distinct external sources, counted by canonical origin after deduplication. A healthy configured service that answers with fewer ends the node `NEEDS_HUMAN`; it is never downgraded to local research. Only bounded, recorded failure of every configured service permits `network.origin: "engine"`, which requires a non-empty `network.reason` and one `network.failures[]` entry per attempt. `no-network` is a research state and is never written to a stop-state field.

## 6. Modes and stop states

`mode` on the job is `gated | autopilot`.

Autopilot load rule:

- Requested AND `ac.quality == executable` AND risk `repo-local` → `graphs/coding-loop.auto.json`
- Else → `graphs/coding-loop.gated.json`
- Forced autopilot with non-executable AC → do not start; write `ac.refused`; operator-visible reason

### Run states

A run is in exactly one of four states (`RUN_STATUSES` in `run-store.ts`). Only `RUNNING` is live; the other three are finished, and two of them resume.

| State | Meaning | Resumes |
|---|---|---|
| `RUNNING` | The loop is driving the graph. | — |
| `NEEDS_HUMAN` | The loop is waiting for the operator. `recovery` names what for; `reason` carries the real message and ends with the resume command. | `/kpi <job>` |
| `DONE` | Required AC receipts green + fresh, review.approved, bounds.held, shipped. | no-op |
| `STOPPED` | The operator stopped it (`/kpi stop`, or Stop at a gate or the no-progress prompt). Everything is intact for the next resume. | `/kpi <job>` |

Status tokens an earlier release wrote — `BLOCKED`, `EXHAUSTED`, `NO_PROGRESS`, `UNSAFE` — read as `NEEDS_HUMAN` (finished, resumable) and stay on disk as written until the run is resumed; nothing writes them today.

### Recovery

`recovery` on a `NEEDS_HUMAN` run (`LOOP_RECOVERIES`) says what the operator does before `/kpi <job>` continues. The reason text is worded once: `<message>. <advice>, then resume with /kpi <job>`.

| `recovery` | When | What the operator does |
|---|---|---|
| `approval` | A human gate (`plan-approval`, `human`) was reached without dialog UI, or the operator dismissed it | Answer it in an interactive K-π session |
| `provider` | Every configured account/model fallback refused; the real provider reason is kept | Select a healthy model or resolve that provider account |
| `delivery` | The ship commit exists but its job branch is not on `origin` or has no pull request (`gh` missing or signed out included) | Push the branch or open the pull request as named; resuming finalizes the same commit |
| `ship` | The one-commit contract refused, or ship finalization failed unexpectedly | Put the job branch and its commit right in the repository |
| `bounds` | A write left the task's declared bounds (`bounds.held == false`) | Revert the writes that left the declared bounds, or widen the task's bounds; the resume re-runs test |
| `review` | The review reported an untestable blocking issue, or approved over failed or stale receipts | Address the reviewer's blocking issue, or make the receipts fresh again; the resume re-runs implement |
| `no_progress` | The loop repeated the same evidence or review outcome after its automatic re-plans | Choose Give guidance, Keep going or Stop when the resume asks; the resume re-runs plan |
| `research` | Research files are missing or stale, or a healthy service supplied too few sources | Repair the research service, or run the job offline with `--no-network` |
| `stack` | `stack.json` is missing, invalid, stale, or names no valid current slice, or the plan could not produce a valid one | Repair `stack.json` so implement has a valid frozen map |
| `contract` | A routing gap, two writers of one path, or a node that will not validate | Fix the contract defect the reason names |
| `ac_quality` | Forced autopilot with non-executable AC (`ac.refused` written) | Rewrite the goal with executable acceptance criteria, or run it gated |

No caps: cost and elapsed time are reported (`state.json` `cost_usd`, `elapsed_ms`; the board's `$<cost> est.`) and never enforced; `maxConcurrency` is the only graph limit. Graphs never fail on their own: the engine never ends a run from a counter or clock, transient faults retry, no progress re-plans, and the only stops are `DONE` and the operator.

Retry ≠ round. Transient http 408/429/5xx, timeout, transport: same round, same node run, unbounded retries, backoff 1 s doubling to a 60 s ceiling, one `node.retry` event and one notification each time, checkpoint before the wait. A resume mid-backoff finishes the wait it was in. A hung provider becomes a timeout through the harness's per-request idle timeout (`httpIdleTimeoutMs`, default 300000); set to 0 that timeout is disabled and a hung request is then never retried.

No progress: a failed round that repeats a witness — a review's output fingerprint or failing-AC set seen before, or a failed test round whose evidence is identical to the previous failed test round's — routes to plan with `repair.json` (two automatic re-plans per operator touch); the same witness repeating after them pauses `NEEDS_HUMAN` (`no_progress`). A green round is progress. The operator stop: `/kpi stop`, or Stop at a gate or the no-progress prompt; both leave `STOPPED` and resume.

## 7. Graphs

Node types we implement: `agent | set | human | pause`.

Context modes for agent nodes: `isolated | thread`. Default thread key = node id. Reviewer and planner and ac-compiler and specify are `isolated` + `readOnly`. Implementer is `thread` key `coder`. A node with no explicit model inherits the parent session's provider, model id, and thinking level; it never silently resolves a different paid provider.

### coding-loop.gated.json (normative shape)

```
ac-compiler → specify? → plan → plan-approval → implement → test → bounds → review → human → ship
                          ▲          │              ▲                         │
                          │          └──────────────┘  request changes        │  REVISE / red
                          └───────────────────────────────────────────────────┘  repeated witness (repair.json)
```

Conditional (every edge is data in the graph file; facts come from the driver):

- skip specify when `--plan` present (`plan.provided`)
- `plan-approval` true → implement; `plan-approval` false → plan (feedback in `plan.feedback`, appended to the planner prompt as `Operator feedback on your previous response (node run N):`; unbounded, the operator is the bound)
- `bounds.held == false` → pause `unsafe` (recovery `bounds`, resume `test`)
- `test.passed == false` and not `progress.repeated` → implement
- `test.passed == false` and `progress.repeated` and not `plan.repair_tried` and not `plan.provided` → plan
- `test.passed == false` and `progress.repeated` and (`plan.repair_tried` or `plan.provided`) → pause `no-progress` (recovery `no_progress`, resume `plan`)
- `test.passed == true` → review
- review `REVISE` and not `progress.repeated` → implement
- review `REVISE` and `progress.repeated` and not `plan.repair_tried` and not `plan.provided` → plan
- review `REVISE` and `progress.repeated` and (`plan.repair_tried` or `plan.provided`) → pause `no-progress`
- review `BLOCKED` (untestable), or approved over `test.passed == false` or `fingerprints.fresh == false` → pause `needs-human` (recovery `review`, resume `implement`)
- review approved + test passed + fresh → human
- human true → ship; human false → implement (`policy.onHumanDeny: revise`, feedback in `release.feedback`) or `__end__` (`end`)

Facts: `progress.repeated` is true when the round just recorded repeated a witness (§6); `plan.repair_tried` is true once the automatic re-plans since the last operator touch reach two (`MAX_AUTOMATIC_REPLANS`).

### Human node fields

`title`, `question` (one line; the board shows it), `statePath` (where the answer lands), optional `detail: "stack.json"` (the driver renders that file's summary into the dialog at ask time; only `stack.json` has a renderer), optional `feedbackPath` (a gate with one requires non-empty feedback to deny, at most 4000 characters, and writes it there). The gated graph's two gates: `plan-approval` (`plan.approved`, detail `stack.json`, feedback `plan.feedback`, options Approve plan / Request changes / Stop) and `human` (`release.approved`, feedback `release.feedback`, options Approve / Request changes / Stop). An agent node may carry `feedbackPath` too: the feedback found there is appended to its prompt on the re-run.

### Pause nodes

`{ id, type: "pause", recovery ∈ LOOP_RECOVERIES, reason, resume: [existing non-pause ids] }`. A pause node never runs: routing to it parks the run `NEEDS_HUMAN` with that recovery and reason, one checkpoint and one `loop.terminal`, and `/kpi <job>` re-arms the run at `resume`. The shipped loops carry three: `unsafe` (`bounds` → `test`, "a write left the task's declared bounds"), `needs-human` (`review` → `implement`, "the review reported an untestable blocking issue, or the receipts are no longer fresh"), `no-progress` (`no_progress` → `plan`, "the loop repeated the same evidence or review outcome after its automatic re-plans").

Graph limits are `{ maxConcurrency }` and nothing else (`coding-loop.gated` and `coding-loop.auto` 2, `spec-first` 1); any other key is refused as a retired cap.

Policy on gated graph: `allowNonInteractive: false`.

### coding-loop.auto.json

Same until review, with no `plan-approval` node. Then:

- review pass + bounds + fresh receipts → `release.set` → ship
- no human node on the happy path; the same `unsafe`, `needs-human`, and `no-progress` pause nodes

Policy: `allowNonInteractive: true`, `allowNonInteractiveMutations: true`.

`release.set` assignments:

```
release.approved = true
status = DONE
```

only if all evidence flags are true. Engine evaluates this as data, not as model text.

### Node tool policy

| Node | tools | readOnly |
|---|---|---|
| ac-compiler | read, grep, find, ls | true |
| specify | read, grep, find, ls | true |
| plan | read, grep, find, ls | true |
| plan-approval | none | n/a |
| implement | read, grep, find, ls, bash, edit, write | false |
| test | read, bash (quality_gates + AC commands + read-only inspection), `write_contract` → `evidence.json` | read-only for product files; bash command-allowlisted |
| bounds | set | n/a |
| review | read, grep, find, ls, `write_contract` → `verdict.json` | read-only for product files |
| human | none | n/a |
| unsafe / needs-human / no-progress | pause — never runs | n/a |
| release.set | set | n/a |
| ship | bash: `git add`, `git commit`, `git push -u origin kpi/<job_id>`, `gh pr create --head kpi/<job_id>` on the job branch the control plane checked out | false |

Neither `test` nor `review` receives `write` or `edit`. `write_contract` (REQ-RS-06) is their only mutation path and reaches exactly one declared file.

## 8. Graph engine (ours)

**REQ-GE-01** Implement in `extensions/graph/`. Do not import `@shying/pi-graph`.

Minimum engine behavior:

- Load JSON schemaVersion 2 graphs from package `graphs/` and project `.kpi/graphs/`
- Superstep: ready nodes run, writes commit together
- Agent nodes call `createAgentSession` from the harness core (the `@earendil-works/pi-coding-agent` workspace in this repository)
- Isolated = new in-memory or fresh session; thread = persisted JSONL keyed by threadKey
- Human node: `ctx.ui.confirm` for a yes/no gate, `ctx.ui.select` + `ctx.ui.editor` for a gate with `feedbackPath`; the driver answers with `submitHuman(HumanAnswer)`; no dialog UI → `NEEDS_HUMAN` (`approval`), never auto-answered; an answered gate is in the checkpoint and is not asked again on resume
- Each agent node batch attempt is bracketed by `node.started` / `node.finished` events written to the run's `events.jsonl` before any pause handling; transient retries do not repeat them. The engine exposes nothing else — the control plane reads the log.
- Checkpoint after each superstep under `.kpi/runs/<job_id>/graph/`, and before every backoff wait
- Resume unresolved nodes only; a node a kill left `running` continues its own run with its retry count and backoff deadline intact
- Paused runs re-arm at their resume targets on restore (a contract pause also re-schedules the active siblings it left pending); the engine never ends a run from a counter or clock; retries are unbounded and checkpointed; a checkpoint that still carries retired cap keys is read with those keys ignored and re-armed
- The operator's stop is an `AbortSignal` (a loop in this process) and a run-directory marker `stop.json` (any process), honoured before every prompt, at every checkpoint and after every backoff: the engine throws `OperatorStopError` with the node left `running` so a restore continues it, and issues no prompt after the signal
- Checkpoints are at-least-once. Ship/commit must be idempotent (do not create a second commit if HEAD already has the job marker)

## 9. Context pack and voice

Load order (harness native + ours):

1. `~/.kpi/agent/APPEND_SYSTEM.md` (operator global)
2. `~/.kpi/agent/AGENTS.md`
3. Project `AGENTS.md`
4. `AGENTS.override.md` if present
5. `.kpi/context/{product,structure,tech}.md` via context-pack skill, not dumped always
6. `.kpi/runs/<id>/context.md` frozen at job start
7. Skills on demand

**REQ-CX-01** Do not ship project `SYSTEM.md` that replaces Pi’s instruction template. Use `APPEND_SYSTEM.md`.

`templates/APPEND_SYSTEM.md` MUST include:

- Outer-loop operator identity
- Short answers: verdict, paths, commands, next action
- No completion claim without verification the node ran
- Irreversible external actions require a human or an evidence-backed release.set
- Prefer run files over guessing

`templates/AGENTS.md` MUST include exact setup/test/lint commands placeholders, quality gates, do-not list, loop protocol, voice.

## 10. Skills and prompts

Each skill is a directory with `SKILL.md` frontmatter `name` + `description` (max 1024). Description MUST state when to use it so the harness's progressive disclosure works.

| Skill | When |
|---|---|
| spec-first | Non-trivial feature, no spec files yet |
| tdd-cycle | Implementer writing production code |
| isolated-review | Reviewer node |
| quality-gates | Tester / verify |
| conventional-commit | Ship |
| context-pack | Job start |
| concise-output | Any user-visible assistant message |
| kg-claim | Decision that should outlive the run |

Prompts `/specify` `/plan` `/implement` `/review` `/verify` `/ship` are templates for manual invocation. The graph supplies node prompts from graph JSON; keep them aligned.

## 11. UI

### Themes

`loop-amber.json` required tokens include:

- `accent`, `borderAccent`, `toolTitle`: `#ff6a1a`
- `success`: `#3dff6a`
- `error`: `#ff3b3b`
- `warning`: `#ffb020`

`protocol-blue.json`:

- `accent`, `borderAccent`: `#3da9fc`

Switch to protocol-blue while a human node is paused. Switch back on resume.

### Status bar (Oh My Pi layout, K-π brand)

Implement in `extensions/status-line/`. Visual contract: `visual-targets.md`. Reference frames: `visual/omp-statusbar-codemod.jpg`, `visual/omp-statusbar-collab.jpg`.

**REQ-SB-01** Idle brand cell is `K-π` (unicode). Nerd: `K-` + `U+F0D57`. Ascii: `K-pi`. Never bare `π`. Never `omp`.

**REQ-SB-02** Default left segments, OMP order: `brand, model, thinking, path, git, context_pct, cost`. Right: last request or session name.

**REQ-SB-03** Separators: powerline-thin chevrons.

**REQ-SB-04** Context color: <50 green, 50–70 yellow, 70–90 orange, >90 red.

**REQ-SB-05** OAuth subscription active slot → cost cell is `(sub)`.

**REQ-SB-06** During a turn: brand shows spinner + elapsed seconds.

**REQ-SB-07** Do not import oh-my-pi, pi-status-bar, pi-vitals, pi-powerline-footer.

**REQ-SB-08** A `local` active slot renders one cost cell `(local) $0`. Not `(sub)`, not an estimated dollar figure, and never both cells. Local slots carry no quota, so no percentage is rendered for them.

Default render (unicode):

```
K-π  >  ⬡ claude-opus · ● high  >  📁 repo  >  ⎇ main  >  ▦ 12%/200k  >  (sub)  ────  add healthcheck
```

`/statusbar` toggles. Off restores the harness default footer.

Job-aware extra slot via `ctx.ui.setStatus("kpi", …)`:

```
K-π LOOP gated r2 STAGE implement GATE human AC 4/5 ROUTE anthropic/home
```

### Overlay (Avid boards)

Canonical look: https://x.com/av1dlive/status/2092622516544270781

`/kpi status` and the above-editor widget must contain: header with `K-π`, stages 01–08, ROUND, PASS/FAIL, six file lamps, STOP state. Human pause adds the oversight box and, on the printed board, the three laws. Geometry in `visual-targets.md` §2; the Command Centre's layout in `visual-targets.md` §Command Centre and `design/claude-design/`.

### Widgets

Always-on during a live job, `setWidget` above the editor as a **component** (the string form is capped at ten lines and painted colourless). It is the compact cut of Board A / Board B, framed in the theme's colours:

```
K-π GRAPH CONTROL │ MODE gated │ JOB <id> │ ROUND <n>
┌──────────────┬──────────────┬ … 8 stage cells: "04 implement" / CURRENT|DONE|PENDING + one detail line …┐
FILES  ● task.json  ● context.md  ○ candidate.json  ● evidence.json  ○ verdict.json  ● events.jsonl
LOOP <id>  STAGE 04 implement  NODE <node>  GATE <human|machine>            ┌──────────────┐
ROUND <n>  PASS ● last verifier  FAIL ○ none  FINGERPRINT <short>             │ STOP RUNNING │
RETRY <attempt> · <reason> · next <s>s                     (while backing off)  └──────────────┘
CONTEXT product ● structure ● tech ○  AGENTS n · k nodes · w workers  BUS ●  ROUTE …  USAGE …
NOW implement  run 1  41 tools  ▸ edit board.ts  12m04s  $1.20  MODEL …
WAITING ON OPERATOR  <question>          (paused only)
STOP STATES  DONE ○  STOPPED ○  APPROVAL ●   (paused only)
```

Rows:

- `ROUND <n>` is a count with no maximum. `STOP` is one of `RUNNING | NEEDS_HUMAN <recovery> | DONE | STOPPED`; the `STOP STATES` cells on the paused board are `DONE / STOPPED / APPROVAL`, APPROVAL a derived lamp, never a persisted status.
- `RETRY <attempt> · <reason> · next <s>s` appears while `state.json.retry` is set and shows the wait the operator is looking at, never less than it.
- Stage cells carry one detail line in both layouts, shrinking by form to the cell width: DONE `<elapsed> · <n> calls · $<cost> est.` → `<elapsed> · $<cost> est.` → `<elapsed> · $<cost>`; CURRENT `<tool> <target>  <elapsed>` → `<tool>  <elapsed>` → `<elapsed>`; PENDING `—`. The rail is sized from the label lines so it never wraps. Elapsed forms `12s` / `3m12s` / `1h02m` / `4d04h` (saturating at `99d23h`); cost `$0.42` / `$12` / `$—` when unknown — an estimate, never a bill.
- `NOW <node>  run <n>  <k> tools  ▸ <tool> <target>  <elapsed>  <cost>  MODEL <m>`: what the current stage's node is doing, from `events.jsonl`. Optional spans drop in the order `MODEL` → `▸ tool` → `run n` before anything truncates, framed and flat; `no node.started yet` before the first record; `EVENTS ✕ <n> unreadable` / `EVENTS ✕ <code>` on log problems.
- `AGENTS n · k nodes · w workers` counts the live job's in-process node sessions and worker processes in this process; `AGENTS n` alone when the split is unknown. The widget repaints when a node session or worker starts or ends (`GraphEngineOptions.onSessionsChange` → the loop's `onStateChange`), not only per superstep. `BUS ●` tracks `bus.jsonl` history independently.
- Height with activity: compact ≤ 11 lines at 120 columns, ≤ 14 at 100 (9 / 12 without); the full board at 200 is one rail row plus `NOW`.

The widget is a component with a 1 s ticker (`BOARD_TICK_MS`) that reads `events.jsonl` incrementally through one activity reader per live job and narrates each record once in the chat (`K-π ▶` start, `K-π ■` / `K-π ✕` finish, `K-π ↻` retry, `K-π ⇄` route change — never a line per tool call); a reinstall or `/kpi status` never re-narrates. A read error paints `EVENTS ✕ <code>`. The current stage cell and lit lamps are `accent`, done stages `success`, pending `dim`; the STOP box is `warning` while running, `success` for DONE, `accent` for NEEDS_HUMAN, `error` for STOPPED. `PASS/FAIL PENDING` reads until a verdict exists. At 70 columns and below the rows are flat but keep every field; the lamp row folds rather than cuts. Once the newest run has finished the widget drops itself and stops its ticker; `/kpi status` then names that last job (`no active job — last job <id> <status>`).

### Command Centre (`/kpi status`)

In the TUI `/kpi status` reinstalls the ticking widget and opens the K-π Command Centre over it: `ctx.ui.custom` with `overlay: true`, width 100%, built from the same board model, activity reader and tick as the widget, so it is live while the job is `RUNNING` (run files every fifth tick) and stops ticking when the run finishes, the job is gone (`K-π no active job`), or the view closes. In print/rpc mode the plain board is printed instead, with no key hint. Source design: `design/claude-design/K-pi Command Centre.dc.html` and the rendered `command-centre*.rendered.txt`.

- HOME: header `K-π  COMMAND  › <job>` with `MODE <mode>  ·  ROUND <n>  ·  GATE <gate>  ·  STOP <status>[ <recovery>] ⠙ <elapsed>  ·  <clock>` on the right (shorter forms drop the clock, then the gate); STAGES (01–08 with ✓ DONE / ⠙ RUNNING / ○ PENDING / ✕ FAILED / ◉ WAITING glyphs, per-stage elapsed, a dim detail line per stage, `▸` on the selected stage); LIVE › <NN stage> (the tail of that stage's node session, `⠙ live · following agents/<stage>/*.jsonl` while running); TELEMETRY (`$<x> est.  +$<y>/min` with a sparkline, `CONTEXT`, `TOKENS`, `TIME <elapsed>`, `ROUNDS` per-round elapsed, `STEPS <supersteps>   NODE RUNS <n>   WORKERS <w>/<cap>` and the `RETRY …` text while backing off — no cap token anywhere); SHARED RUN STATE (the six run files ● / ○ with size, mtime and note; footer `FINGERPRINT <12> · ROUND <n> · VERIFIER <PASS|FAIL>`); CONTEXT LAYER (`research.json · accounts.json`: PACK lamps, RESEARCH, K-STACK, AGENTS, ROUTE, POLICY); EVENTS (`events.jsonl`, `following` while running); the input line; key hint `tab/↑↓ select stage · enter open · esc close · r refresh`.
- SESSION (enter on a stage): STAGES rail (labels + glyphs, `← → switch node`, `esc  back`, ROUND / GATE / STOP / elapsed), the node's transcript (`following · <elapsed>` while running, `finished in <elapsed> · replaying` after), and the NODE panel (status, elapsed, `<cost> est.`, model, route, tokens `—` when unknown).
- Keys (both views): `tab`/`↓`/`→` next stage, `shift+tab`/`↑`/`←` previous, `1`–`8` jump, `enter` opens the session view, `esc` back to home or close, `q` close, `r` refresh now, `ctrl+c` close. Any printable character types into the input line; `enter` on `/kpi stop` runs exactly what `/kpi stop` does, once, then repaints; `/kpi verify` shows the verify line on the hint row; any other `/kpi …` → `K-π /kpi <goal> is refused while a job runs; /kpi stop first`; `!…` → `K-π bash is not available inside the command centre`; other text closes the view, then goes to chat as a user message. `esc` with a non-empty input clears it.
- Layout: two columns at ≥ 120 columns, one column below, and only STAGES, LIVE and EVENTS below 80. Row budget: the terminal's rows less three; ≥ 44 rows shows the full STAGES detail lines, 38–43 compacts STAGES to labels and glyphs so SHARED RUN STATE and CONTEXT LAYER stay on screen (the 40-row pty default keeps both), below that the second row of panels goes, and last the detail lines. A run-file read that fails on open paints `EVENTS ✕ <code>` in the header and `K-π reading run files ✕ <code> · r to retry` in the body; the ticker retries it. No framed line is ever wider than the terminal.

`/agents` prints a table of this process's live sessions — columns `KIND ID ROLE MODEL PID ALIVE ELAPSED TOOLS LAST NODE JOB` — then `caps (this process): workers <w>/2 · writers <n>/1`, the mechanism line (`K-π runs graph nodes as in-process sessions in this kpi process; a node with workerRole (the reviewer) and the spawn_background tool start separate kpi --mode rpc processes that talk over .kpi/runs/<job>/bus.jsonl. No sub-agent API is used.`), and `job <id> <status>` or `no active job`. Node sessions are visible only from the kpi process running the loop; a worker whose pid has died is listed `ALIVE no` and not counted. Files and memory only, no model.

Accounts widget:

```
ACCOUNTS
  ANTH  ● <slot>  <pct>%  <window>   <slot>  <pct>% cd <eta>
  LOCAL ● <slot>  (local) $0  <base-url>
  …
ROUTE   <provider>/<model>  via <slot>
```

Per-slot percentages. No unlabeled aggregate as the only number. A `local` slot has no quota: show its base URL and health instead of a percentage.

`/kpi status` uses `ctx.ui.custom` overlay. Data from files, refreshed on the widget's tick.

Footer `setStatus("loopgraph", …)` and `setStatus("accounts", …)`.

Custom entry renderers for EVT types listed above.

## 12. Policy

`.kpi/policy.json` default (`templates/policy.json`, identical to the in-code `DEFAULT_POLICY_CONFIG`):

```json
{
  "deny": [
    "git push --force",
    "git reset --hard",
    "rm -rf",
    "chmod 777"
  ],
  "allow": [],
  "commit": {
    "chat": "allow",
    "gated": "confirm",
    "autopilot": "after-release"
  },
  "unknown": {
    "chat": "allow",
    "gated": "confirm",
    "autopilot": "deny"
  }
}
```

A file written before `allow` and the `chat` keys existed still loads: missing keys take these defaults, and the `git push` entry every earlier template seeded is dropped on load because pushing is a structural rule (below), not a deny entry. The file is seeded at session start only in a project directory (one with `.kpi/` or a git root), and a missing file reads as the default without being created.

Hook: `pi.on("tool_call", …)`.

### Scopes

| Scope | When | What applies |
|---|---|---|
| `chat` | No live job in the cwd (`readLiveJob` is empty; a finished run is not a job) | The hard denies below. No write bounds, no prompts: `commit.chat` and `unknown.chat` default to `allow`. |
| `gated` | The live job's mode is gated | Everything: bounds, commit confirm with diff stat, unknown confirm. |
| `autopilot` | The live job's mode is autopilot | Everything: bounds, commit after `release.approved`, unknown deny. |

A live job whose `task.json` will not parse resolves to gated with no bounds, never to chat.

### Order of evaluation

First, any command containing `git push` is judged by shape alone and never confirmed or allowlisted: exactly one unchained `git push [-u|--set-upstream|-q|-v] origin kpi/<branch>` is allowed inside a job after `release.approved`; every other push — another branch (`main` included), a force (`--force`, `-f`, `--force-with-lease`, a `+` refspec), `--delete`, `--tags`, `--all`, `--mirror`, a colon refspec, a tag, another remote, no refspec, a chained or `-C` form, or chat scope — is denied with the reason named.

Deny if, in every scope:

- command matches the deny list, is a recursive forced `rm`, a `gh pr merge`, or a production/publish/dependency-adding command
- a `write_contract` call whose target is not the declared contract path for that agent, job, and role, or whose payload fails `SCH-verdict` / `SCH-evidence`
- path names a reserved run artifact (`verdict.json`, `release.approved`, `ship.json`) or the authoritative knowledge graph
- path looks like `.env`, `id_rsa`, `auth.json`, `accounts.secrets.json` — read or written, `write`/`edit` or shell

Then, in a job scope only, deny a shell write target outside the active job's `write_allow`.

Then, in order: a standalone `git commit` follows `commit.<scope>`; in a job after `release.approved`, a standalone `git add` and a standalone `gh pr create` (whose `--head`, when given, is a `kpi/*` branch) are allowed, and before it `gh pr create` is denied; an exact `quality_gates` command is allowed; a command every segment of which the read-only classifier accepts is allowed (`gh pr view|list|status|checks|diff`, `gh auth status`, `gh repo view`, `gh run list|view` included); an exact entry of `allow[]` is allowed; anything else is unknown and follows `unknown.<scope>`.

### Read-only classifier (`shell-classifier.ts`)

Allowlisted reads never confirm. A command is read-only when it parses and every simple command in it is: reads such as `cat head tail grep rg ls find wc sort diff stat jq sed -n awk`; `git status|log|diff|show|rev-parse|ls-files|branch (list)|remote (show)|config --get|stash list`; `npm ls|view|outdated|audit`; `node --version`; `<head> --help|--version`; shell control words (`if for while case [ test`), assignments, and `env`/`command`/`xargs`/`timeout` wrapping a read-only command. Pipes, `;`, `&&`, `||`, `$(…)`, backticks and subshells are fine when every part is read-only; redirects only to `/dev/null` or between descriptors (`2>&1`). A segment that writes a file, executes project code (`node script.js`, `npm test`), runs `-exec`/`-delete`, uses a heredoc, a background job, or an unknown head makes the whole line unknown, and the confirm question names that segment. A segment naming a secret-shaped path is denied regardless.

### Remembered approvals

In gated scope an unknown command asks once with three choices: **Allow for this session**, **Always allow in this project**, **Deny**. Either allow is kept for the process (the same whitespace-collapsed command does not ask again); *Always* appends the exact command to `allow[]` in `.kpi/policy.json`, creating the file from the template if needed, and later sessions run it without a prompt. `allow[]` is consulted after every hard deny and after the bounds check, so it cannot launder a push, a secret read, a write outside bounds, or a commit gate. A commit confirm is never remembered. Without a selector (print mode) the dialog falls back to confirm, and no UI at all answers deny.

## 13. Accounts and providers

### Store

`~/.kpi/agent/accounts.json` mode 0600. Schema version 1:

```json
{
  "version": 1,
  "pools": {
    "anthropic": {
      "strategy": "quota-first",
      "slots": [
        {
          "id": "home",
          "kind": "oauth",
          "label": "personal max",
          "warningAcceptedAt": "2026-08-31T00:00:00.000Z",
          "official": true
        },
        {
          "id": "work",
          "kind": "oauth",
          "needsLogin": "Anthropic rejected its refresh token (invalid_grant)"
        }
      ]
    }
  },
  "fallback": ["anthropic", "openai-codex", "xai", "zai", "kimi-coding", "cursor"],
  "stickiness": "session-until-exhausted"
}
```

Pool ids: `anthropic | openai | openai-codex | xai | zai | zai-coding-cn | kimi-coding | cursor | llama | ollama | lmstudio | local-openai`.

`exa`, `perplexity`, and `firecrawl` are **not** pool ids. They are research credential targets (`research.md`): never in `pools`, never in `fallback`, never an argument to `/pool strategy` or `/pool chain`, and never a `registerProvider` call. A research key never changes which model answers a turn and never grants provider-native web search.

Strategy: `quota-first | round-robin | sticky`.  
Slot kind: `oauth | api_key | local`.  
`official?: true` — at most one per pool, never on a `local` slot: this slot's grant is the one `auth.json` holds.  
`needsLogin?: string` — the persisted reason this slot can no longer authenticate; `balancer.selectInFamily` never selects it, the widget shows `needs login`, and `putSlot` on re-login clears it. Reasons written today: `<provider> rejected its refresh token (invalid_grant)`, `<provider> rejected the refresh token held in auth.json (invalid_grant)`, `auth.json no longer holds a <pool> credential`, `its auth.json credential now belongs to <slot>`, `its auth.json credential was replaced by the login of <slot>` (when the demoted official slot had no grant to keep).

**REQ-SL-01** A `local` slot is credential-free. It persists the `baseUrl` it was configured with, and every request routed to that slot stays on that origin — no silent cloud proxy. It MAY carry an optional `secretRef` when the local server wants a token. An absent `secretRef` is valid; never write a placeholder or dummy secret to satisfy the schema.

**REQ-SL-02** `local` slots are outside the default cloud fallback chain. They enter routing only through `/pool chain …,<pool>` or an explicit pin. They have no quota: the accounts widget shows no percentage for them (§11) and the footer cost cell is `(local) $0` (REQ-SB-08).

Local pools use official llama.cpp (`LLAMA_BASE_URL`) or first-party `refreshModels` on `/v1/models`. An unreachable server cools that slot; failover stays inside the local family first.

Secrets in `~/.kpi/agent/accounts.secrets.json` keyed by `pool/slot`. Never log them. A `local` slot with no `secretRef` has no entry here.

One grant, one refresher. Per pool at most one **official** slot: `auth.json[pool]` is that slot's grant, it has no `accounts.secrets.json` entry, and K-π never calls `oauth.refresh` on it — the base runtime refreshes it on every request. Every other slot exists only in `accounts.secrets.json` and is refreshed by K-π at session start and turn start, five minutes before expiry. Subscription OAuth selected through `/login` delegates to the pooled login path, allocates a new slot when no name is supplied, and activates that slot without deleting siblings; because the runtime persists that grant into `auth.json`, the new slot becomes the official slot and the previous official slot keeps the grant `auth.json` held until then as a K-π-refreshed secret (`loginAccount` reads it live immediately before login; the notice reads `Added account <pool>/<slot> (<pool>/<previous> keeps its previous grant)`). Reconciliation runs once per `session_start`: by content match (refresh or access token equal, or api key equal), then the legacy rule (bind `default` only when its secret is absent or an expired OAuth copy), else a fresh official slot (`default`, else the next `slot-N`); a flagged slot whose `auth.json` entry vanished is marked `needsLogin` `auth.json no longer holds a <pool> credential` and reported once. An `invalid_grant` on either refresher marks the slot `needsLogin` — one notification `K-π accounts: <pool>/<slot> needs a new login: <reason>. Run /accounts login <pool> <slot>`, no cooldown, no stack trace — while a transient refresh failure cools the slot 5h with `K-π accounts: could not refresh <pool>/<slot>: <summary>; cooling 300m`.

### Official catalogs

**REQ-PR-01** Do not pass `models` when overlaying `anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, `kimi-coding`.

Credential injection: `before_provider_headers` sets `Authorization` from the selected slot for that provider family. For the official slot the runtime's own auth header is left in place and only request attribution is recorded. Anthropic OAuth requests identify as Claude Code (`user-agent: claude-cli/<v>`, an upstream constant pinned by cherry-pick, 2.1.251 today); a `claude_code_version_too_old` refusal is a client-identity failure, not a quota event — notified once per session at level error (`K-π <version> identifies to Anthropic as Claude Code <sent>; Anthropic requires <required> or newer for <model>. Update K-π: npm install -g @korallis/k-pi@latest`), no cooldown, no failover, assistant diagnostic `kpi_client_version_rejected` with details `{ sent?, required?, slot? }`, which never triggers the agent-session retry (only `kpi_account_failover` does).

Detection: the global `after_provider_response` hook carries status and headers only, never a response body. Classifier in `accounts/errors.ts` treats 429, 402, and quota-shaped 403, together with `retry-after` and reset headers, as cooldown events at that layer. A custom fetch client may classify a body it owns. After a provider stream has already been consumed, the finalized assistant error may classify quota-shaped 400 text such as `out of extra usage`; no hook consumes the response body. OpenAI API count headers and Codex subscription `x-codex-{primary,secondary}-used-percent` windows populate the slot cache.

Cooldown: parsed reset timestamp if present, else 5 hours. Slot is skipped while cooling. A successful response reporting 5% remaining or less proactively cools that slot and moves the next request before a hard refusal.

Selection order:

1. Sticky slot if healthy and above the low-quota threshold
2. quota-first among healthy siblings (usage readers and response headers in `accounts/usage/*`)
3. else round-robin among healthy siblings
4. only when the whole family is unavailable, follow `fallback_models` + `pi.setModel`
5. else wait or `NEEDS_HUMAN`

**REQ-PR-02** Never select a cooling slot when a healthy sibling exists.

Fallback invariant: same-provider slot rotation preserves the exact provider, model id, and thinking level. Cross-provider fallback uses the exact `fallback_models` order written by `/setup-kstack`; each slug must be in the live registry intersected with configured K-π pools. If no configured live model exists for a fallback family, skip it. The older `/pool chain` remains the fallback only when `fallback_models` has never been configured.

### Anthropic warning (normative text)

Show with `ctx.ui.confirm` before OAuth for a **new** anthropic slot if `warningAcceptedAt` missing:

```
Claude Pro/Max in this harness uses Anthropic’s subscription OAuth, same as Pi and Atomic.

Anthropic’s own docs: third-party harness usage draws from extra usage and is billed per token, not against the in-app Claude plan bar.

API keys (ANTHROPIC_API_KEY) are a separate pay-as-you-go path.

You are responsible for the seats you attach.

Continue?
```

Cancel → no slot. Accept → write `warningAcceptedAt`.

Codex and Cursor get a one-line provider billing confirm once per new slot.

### Cursor provider

`extensions/cursor/provider.ts`:

```ts
pi.registerProvider("cursor", {
  name: "Cursor",
  oauth: { name: "Cursor", login, refreshToken, getApiKey },
  async refreshModels({ signal }) { /* live usable list */ },
});
```

Fallback static models only so `/model` is not empty before first sync. Live list replaces fallback after refresh.

Do not load community Cursor packages.

## 14. Knowledge graph

Paths: `.kpi/kg/nodes.jsonl`, `edges.jsonl`, `sources.jsonl`, `inbox/`, `snapshots/<iso>/`.

Node minimum: `id`, `kind`, `source_ids`, `status`, `rev`, `observed_at`.  
Optional: `confidence` on inferred edges, `valid_from`, `valid_to`.  
Status: `proposed | verified | rejected | superseded`.

One writer. Inbox patches are JSON files. Accept → append JSONL, bump rev, snapshot first.

Markdown projection is optional and not authoritative.

## 15. Voice

User-visible assistant text after a protocol step:

```
Reviewer blocked ship.
Blocking: src/auth/refresh.ts:81 accepts expired tokens.
Evidence: tests/auth.refresh.test.ts:44
Next: implementer, round 3. Approval still outside the loop.
```

No preamble. No restating the task. No ASCII board.

## 16. Non-functional

| ID | Requirement |
|---|---|
| NFR-01 | Secrets never in git or events |
| NFR-02 | accounts.json and secrets 0600 |
| NFR-03 | TypeScript strict |
| NFR-04 | Tests for balancer, classifier, atomic write, AC compiler, hash chain, `write_contract` path pinning, research network state |
| NFR-05 | Builds and runs from this repository's own source at the pinned upstream base (Pi `v0.84.4`, commit `b79e4cc`). Moving the pin is a reviewed merge per `../UPSTREAM.md`. |
| NFR-06 | Board render does not call a model |
| NFR-07 | TUI required fields (US-25) present. Pixel match is not required. |
| NFR-08 | One writer worker. `claim_path` exclusive per job. |

## 17. Test fixtures (normative)

Repo `fixtures/` MUST include:

1. `healthcheck-gated` — small app, `/loop` reaches human confirm
2. `healthcheck-auto` — five executable AC, reaches `DONE` + commit
3. `narrative-ac` — “make it nicer”, autopilot refused
4. `bounds-violation` — implementer tries to edit outside allow → `NEEDS_HUMAN` (`bounds`), no commit
5. `accounts-failover` — slot A classified exhausted, slot B healthy, A never selected
