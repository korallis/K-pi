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
                │   ├── cursor/provider.ts
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
| `/kpi <job>` | Resume the checkpoint's persisted execution topology and protected intent, not today's named template. `NEEDS_HUMAN` resumes its recovery and `STOPPED` its interrupted work. A substantiated `DONE` is a no-op only while its host proof and ship marker remain valid; stale delivered proof requires operator attention, and an unsupported cached `DONE` cannot bypass verification. |
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
| `task.json` | control plane | Working task snapshot checked against protected intent; only `current_module_id` is excluded from its contract hash |
| `intent.json` / `intent-history/revision-<n>.json` | control plane only | Versioned desired state, revision, hash and acceptance timestamp; agents cannot publish accepted intent |
| `intent.proposal.json` | specify / plan-check response contract | Additive desired-state proposal, not consent |
| `context.md` | control plane at start | Frozen pack |
| `candidate.json` | implementer via contract | Semantic payload only |
| `evidence.json` / `verification/<run_id>/*` | host verifier only | Latest projection plus immutable command receipts and full output bound to exact intent and candidate |
| `goals.json` | host verifier | Derived AC, quality-gate and journey coverage; cached statuses are not completion authority |
| `release-approval.json` | control plane | Gated operator approval bound to the accepted intent hash and verified candidate tree hash |
| `verdict.json` | reviewer only, via `write_contract` | PASS/REVISE/BLOCKED |
| `state.json` | driver (gated loop) | Progress. See the field list under SCH-event. |
| `events.jsonl` | append-log | Hash chain |
| `research.md` / `research.json` | specify/plan research node | Mode, network state, sources + notes. Required before implement. |
| `stack.json` | plan | Explicit feature ownership and current slice (SCH-stack); validated and frozen before implement, not a prescribed folder layout. |
| `fingerprints.json` | control plane | SHA-256 of canonical JSON |
| `stop.json` | control plane / `/kpi stop` | `{ reason: "operator stop", at, recorded }`. The operator's stop marker, honoured at every checkpoint and after every backoff. `recorded` says who appended the `STOPPED` terminal: the control plane (no loop live) or the driver whose loop was aborted. |
| `repair.json` / `execution-repair.json` | driver / engine | Repeated-witness and execution-defect diagnosis, evidence references, affected tasks/goals and changed-strategy decision; no fixed re-plan allowance |
| `graph/checkpoint-<n>.json` | engine | Actual execution definition, state, revision audit, superseded-task history, blockers, recoveries and pending result routes |

**REQ-RS-02** Atomic write: `foo.tmp` → fsync → rename to `foo` in the same directory.

**REQ-RS-03** One writer per file. Graph workers do not write `state.json` or `kg/*.jsonl`. Reviewer publication uses its pinned `write_contract`; other read-only response artifacts are published by the engine (REQ-RS-06). Neither path grants general product-write authority, and host verification artifacts remain host-owned.

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

### Protected desired state

`intent.json` is the completion contract, not arbitrary edits to `task.json`. Its version-1 envelope records `job_id`, `revision`, `hash`, `accepted_at` and the task without `current_module_id`. Job creation protects the original request at revision 1. Before plan or implement, specify (or plan-check for supplied plans) proposes users, journeys, linked acceptance checks, engineering constraints, assumptions, testing criteria and definition of done. Existing goals, acceptance IDs/checks/bounds, constraints, non-goals and quality commands cannot be weakened by that refinement.

Gated mode explicitly asks **Accept intent / Request changes / Stop**; unresolved questions instead require operator decisions. Missing UI or dismissal pauses `NEEDS_HUMAN` (`approval`). Explicit autopilot delegates initial refinement only when there are no unresolved questions and derived required acceptance is executable with bounds; otherwise it pauses for the missing contract decision or AC quality. Accepted refinement is a new protected revision, recorded as `approval.result` on `intent`; a pending-publication record reconciles interrupted host writes. Initial refinement cannot replace an already accepted detailed intent. There is no general mid-run intent editor: changed success requires explicit operator authority, not graph repair or manual bounds widening.

Execution remains fluid within that intent. Replanning may select another current slice and mutate admissible task topology without another plan-consent gate. Protected intent, credential policy, writer ownership and release/external-action authority remain unchanged. Legacy runs lacking intent require operator inspection and confirmation before adoption; legacy checkpoints lacking the original execution definition are refused rather than rebuilt from current templates.

The native acceptance compiler lowers each protected check to one host command; the
receipt binds that exact command and its expectations to intent and candidate digests.
Structured checks have these fields (other fields fail closed):

| Kind | Protected fields and predicate |
|---|---|
| `command` | `cmd`: exact operator-authorized shell string |
| `file_exists`, `file_absent` | `path`: existence of a filesystem entry (`lstat`, including dangling symlinks) |
| `grep_empty`, `grep_matches` | `path`, `pattern`: no match / a match of an ECMAScript regular expression over complete UTF-8 file contents |
| `json_path` | `path`, `pointer` (RFC 6901, empty selects the document), `equals` (JSON value): an own-property selection exists and deeply equals the value |
| `http_probe` | `url`: local plain-HTTP GET, `status` (default 200), `timeout_ms` (default 5000, maximum 30000), `max_bytes` (default 1048576, maximum 16777216) |

All checks accept `expect.exit` (default 0) and `expect.stdout_includes`.
Commands preserve actual exits 0–255; structured predicates return 0 for a match
and 1 for a mismatch, either of which may be explicitly expected. Observation,
parse, filesystem and transport errors return 2 and cannot satisfy a structured
check, even when failure was expected. Missing/unknown/malformed structured checks
remain unverified. Paths are interpreted relative to the authorized project cwd.
File predicates emit observed existence/type; grep and JSON checks emit complete
source bytes. HTTP emits received body bytes plus status/raw headers on stderr.
Full stdout/stderr and actual exits are sealed in host receipts; only display
excerpts are truncated. HTTP connects directly to loopback, preserves the local
Host header, never follows redirects, and fails on timeout or excess response
bytes (retaining bytes received up to termination). Credentials, fragments,
external hosts and non-HTTP schemes are rejected.

### SCH-stack

`stack.json` is a version-1 `shape: "dune"` Product Feature Map input. Modules declare `id`, non-empty `purpose`, `folder`, `interface`, `allowed_paths` and `depends_on`; the stack declares `root`, `delivery` and explicit current-module selection. `root`/`folder` may be `.`, identity need not equal folder name, and existing language, generic/layered folders and test locations are preserved. The interface is inside its folder and explicitly admitted. Only the selected module's declared paths grant writes; neither its folder nor an inferred test twin grants ownership. Canonical path/segment/glob checks reject traversal, prefix and symlink escapes, ownership without an explicit prefix, and selected ownership beyond protected task bounds. Dependencies must exist and be acyclic.

Missing, stale or conflicting selection blocks implement before writes and routes through the existing execution-repair contract (§6–§7), never `modules[0]` inference. The named typo, unslop and comment-strip exemptions remain; the accepted playbook cannot be changed to bypass admission. Vertical delivery is the planning default; horizontal delivery requires a non-empty reason. `module.scaffold` optionally names exact authorized directories, creating no interface/test stubs and preserving existing content; `scaffold_first` is optional stack metadata.

This is the operator's RP-22 **Preserve existing layouts** cutover, not acceptance of the former folder=id/auth-home/nested-only-layer/two-consumer rules. Source and tests are added only as needed under accepted constraints and the minimalist ladder. See [RP-22](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild), PRD US-30 and `dune-architecture.md` for ownership, canonical-context and repository-navigation contracts. Offline fixture evidence does not replace live reset/small-window or semantic-navigation proof.

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

`schemas/evidence.schema.json` describes host evidence version 1. The envelope includes `job_id`, `run_id`, `intent_hash`, `tree_hash`, `head` (observed Git metadata only), `verifier_id: "host:verification"`, absolute `cwd`, execution timestamps, `record_path`, `commands[]`, `ac_results[]`, `passed` and `unverified_reasons[]`.

Each command receipt includes the exact protected command and expectation, source/criterion identity, receipt/run/job/intent/candidate/verifier/cwd bindings, start/end times, actual exit or signal/error, and stdout/stderr artifacts with path, full-byte hash, byte count and display excerpt. Reads validate against immutable host records, rehash the raw output and recompute predicates; tester prose, caller-constructed records, copied JSON and `goals.json` statuses cannot confer trust.

Freshness is the current candidate worktree hash plus accepted intent and cwd, not `git rev-parse HEAD`. The snapshot includes tracked, untracked and ignored product files, excluding `.git`, `node_modules` and `.kpi`. Verification leases the candidate against harness writers and rehashes after commands; release and final `DONE` recheck proof. Gated release approval additionally binds the exact intent and tree hashes. A candidate change cannot reuse approval for the previous tree.

Every required AC and every quality command must pass. Each declared journey is also required and passes only when every linked acceptance check passes, including links to otherwise optional AC. Missing, unsupported, failed, blocked or stale checks do not become green from prose. Journey coverage is this explicit link projection, not an independent browser/usability oracle.

Host commands inherit the project cwd and host environment. Operators must trust the exact authorized scripts and dependencies. Private raw output may contain sensitive data; file ownership, exclusive creation and permission checks are not an OS sandbox against a hostile same-identity process or privileged operator.

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

- `approval.result` — `approved` (boolean), optional `question`, optional `feedback`. Initial desired-state acceptance uses `node: intent`; the shipped gated graph's release gate uses `node: human`. There is no routine `plan-approval` gate.
- `loop.terminal` — `status` ∈ `DONE | NEEDS_HUMAN | STOPPED`, optional `reason`, and on `NEEDS_HUMAN` a `recovery` ∈ `approval | provider | delivery | ship | bounds | review | no_progress | research | stack | contract | ac_quality`. One per pause or stop; a run that resumes and pauses again writes another.
- `node.started` — `run` (integer ≥ 1), optional `model`. Written by the engine when an agent node's batch attempt starts; a resumed running node re-emits it with the same `run`.
- `node.finished` — `run`, `status` ∈ `completed | failed`, `elapsed_ms`, optional `cost_usd` (summed across every attempt of the run; omitted, never zeroed, when the session has no billing), optional `result`, `session`, `error`. Transient retries inside a run repeat neither `node.started` nor `node.finished`.
- `node.retry` — `attempt` (integer ≥ 1), `reason` ∈ `http | timeout | transport`, `delay_ms` (integer ≥ 0), optional `status` (HTTP status integer), optional `message`. Written by the driver's `onRetry` after the engine's checkpoint and before the wait.

`state.json` is the driver's progress projection: job/mode, round/stage/node, test/bounds/review/release facts, AC quality, run and graph status, optional reason/recovery/pending question, superstep, `limits: { maxConcurrency }`, report-only elapsed/cost/graph-round/batch counters, witness history, `repaired[]` history, `plan_repair`, retry deadline and playbook/todos. These counters and projections are not completion authority or a replan allowance. The graph checkpoint separately retains topology and execution audit; legacy cap fields are ignored.

**REQ-RS-04** Hash: serialize record without `record_hash` as RFC 8785 canonical JSON UTF-8, SHA-256 lowercase hex. Chain `prev_hash` to previous `record_hash`. First record `prev_hash` is 64 zeros.

**REQ-RS-05** Redact tokens, cookies, passwords, `sk-`, `oat01-`, bearer values from events.

**REQ-RS-06** `write_contract` is a dedicated capability, not `write` or `edit`. In the shipped loop it is pinned to the reviewer agent, job, role and declared `verdict.json`, schema-validates before the atomic write, and grants no product-file mutation or release authority. Wrong path, role, job or invalid payload is denied and recorded. Specify/plan-check and plan publish schema-validated response artifacts through the engine; those artifacts are proposals and execution plans. Neither tester prose nor `write_contract` publishes trusted `evidence.json`: only the host `verify` executor owns verification evidence and goals.

**REQ-RS-07** Online research success requires at least two distinct external sources, counted by canonical origin after deduplication. A healthy configured service that answers with fewer ends the node `NEEDS_HUMAN`; it is never downgraded to local research. Only bounded, recorded failure of every configured service permits `network.origin: "engine"`, which requires a non-empty `network.reason` and one `network.failures[]` entry per attempt. `no-network` is a research state and is never written to a stop-state field.

## 6. Modes and stop states

`mode` on the job is `gated | autopilot`.

The requested mode selects `coding-loop.auto.json` or `coding-loop.gated.json`. Before engineering, the host accepts only a non-weakening desired-state refinement. Autopilot requires no unresolved product decisions and executable derived required AC with explicit bounds; otherwise it pauses `NEEDS_HUMAN` (`contract` or `ac_quality`) rather than treating partial/narrative acceptance as proof. Mode does not grant credential access or waive policy hard denies.

### Run states

A run is in exactly one of four states (`RUN_STATUSES` in `run-store.ts`). Only `RUNNING` is live; the other three are finished, and two of them resume.

| State | Meaning | Resumes |
|---|---|---|
| `RUNNING` | The loop is driving the graph. | — |
| `NEEDS_HUMAN` | The loop is waiting for the operator. `recovery` names what for; `reason` carries the real message and ends with the resume command. | `/kpi <job>` |
| `DONE` | All required AC, quality and journey goals have fresh host receipts for the accepted intent and candidate; release is approved and the one-commit/delivery contract is verified. Graph exhaustion alone is insufficient. | No-op only with current proof and a valid ship marker |
| `STOPPED` | The operator stopped it (`/kpi stop` or Stop at a gate). Work and checkpoint remain available for resume. | `/kpi <job>` |

Status tokens an earlier release wrote — `BLOCKED`, `EXHAUSTED`, `NO_PROGRESS`, `UNSAFE` — read as `NEEDS_HUMAN` (finished, resumable) and stay on disk as written until the run is resumed; nothing writes them today.

### Recovery

`recovery` on a `NEEDS_HUMAN` run (`LOOP_RECOVERIES`) says what the operator does before `/kpi <job>` continues. The reason text is worded once: `<message>. <advice>, then resume with /kpi <job>`.

| `recovery` | When | What the operator does |
|---|---|---|
| `approval` | Initial intent consent or a human release gate needs UI or was dismissed | Answer it in an interactive K-π session |
| `provider` | Every configured account/model fallback refused; the real provider reason is kept | Select a healthy model or resolve that provider account |
| `delivery` | A required remote, credential or pull-request authority is unavailable | Restore the named access/configuration; resume reconciles the same commit and performs only missing authorised delivery actions |
| `ship` | The one-commit contract refused, or ship finalization failed unexpectedly | Put the job branch and its commit right in the repository |
| `bounds` | A write left the accepted bounds (`bounds.held == false`) | Restore compliant writes; resume re-runs test. Do not widen protected bounds by editing `task.json` |
| `review` | Release evidence/approval is stale, or previously delivered proof is no longer current | Resolve the named proof problem; a delivered candidate is not silently rewritten |
| `no_progress` | Recovery vocabulary retained for restored/custom pause nodes, not a two-replan gate in the shipped loops | Follow that checkpoint's reason and resume targets; ordinary repeated failures route to diagnosis and plan |
| `research` | Research cannot satisfy its freshness/source contract | Repair the named research prerequisite; the accepted offline decision cannot be silently changed |
| `stack` | A stack admission defect cannot continue through automatic execution repair | Resolve the named map/ownership defect; missing/stale/invalid slices normally route to the repair planner |
| `contract` | Protected intent, legacy migration, execution restore or another authority/contract prerequisite is missing | Restore the authorized record or supply the explicit operator decision; ordinary routing/response defects use planner repair |
| `ac_quality` | Derived required autopilot acceptance lacks executable checks and bounds | Supply the missing desired-state decision or start an appropriately scoped gated job; never claim unverified AC passed |

No caps: cost and elapsed time are reported (`state.json` `cost_usd`, `elapsed_ms`; the board's `$<cost> est.`) and never enforced; `maxConcurrency` is the only graph limit. Counters and clocks cannot terminate engineering. Transient faults retry and ordinary defects replan; unresolved authority and retained safety gates can still park a run `NEEDS_HUMAN`. Only verified delivery yields `DONE`, and only the operator requests `STOPPED`.

Retry ≠ round. Transient http 408/429/5xx, timeout, transport: same round, same node run, unbounded retries, backoff 1 s doubling to a 60 s ceiling, one `node.retry` event and one notification each time, checkpoint before the wait. A resume mid-backoff finishes the wait it was in. A hung provider becomes a timeout through the harness's per-request idle timeout (`httpIdleTimeoutMs`, default 300000); set to 0 that timeout is disabled and a hung request is then never retried.

No progress: a failed round repeating a review output/failing-AC set or consecutive failed-test witness routes to plan with `repair.json`, including a recovery decision. Diagnosis progresses through `diagnose`, `replan`, `decompose`, then `reconsider`; attempt counts are history, not termination thresholds. Execution defects similarly write `execution-repair.json` and schedule the authorized repair planner. These briefs require new diagnostic evidence or materially different strategy rather than identical engineering retries; they do not prove the model's diagnosis correct. A green round is progress. `/kpi stop` or Stop at an operator gate leaves `STOPPED` and remains resumable.

The former mandatory two-replan/no-progress prompt is explicitly superseded by the operator's [Architectural rebuild decision — 2026-09-05](remediation-plan.md#architectural-rebuild-decision--2026-09-05). PRD AC-05.3 and UAT-05 exercise continued repair beyond that old allowance; this does not waive protected intent, security or release authority.

## 7. Graphs

Node types: `agent | set | human | pause | verify`. `verify` is a host executor, not a model session.

Context modes for agent nodes: `isolated | thread`; default thread key = node id. Reviewer, planner and specify/plan-check are isolated and product-read-only. The initial `ac-compiler` node is deterministic `set`; implementer uses thread `coder`. Agent model selection remains subject to authorized available resources and credential policy.

### coding-loop.gated.json (initial shape)

```text
ac-compiler → specify or plan-check → [host initial intent consent] → plan
plan → implement → test (host) → review → verify (host) → human → ship → deliver (host)
```

Research is supplied by the driver before specification/planning and checked before implement. A supplied frozen plan chooses `plan-check`, not permission to skip accepted intent. There is no `plan-approval` node in the shipped graph.

Routing uses driver facts derived from current receipts and bounds:

- Bounds failure routes to `unsafe` (`bounds`, resume `test`).
- Failed test without a repeated witness routes to implement; a repeated witness routes to plan, including for supplied plans.
- Review `REVISE` routes to implement unless its witness repeats; repeated outcomes, `BLOCKED`, or approval over failed/stale receipts route to plan.
- Approved review with passed/fresh evidence routes through the final host `verify`; green verification and bounds reach `human`, while failed/stale evidence or missing review approval routes to plan.
- Human approval permits the one-commit ship decision; an already committed job routes directly to host delivery. Request changes returns to implement with `release.feedback` under `onHumanDeny: revise`. A custom `end` denial does not authorize `DONE`.
- At exhaustion the engine re-derives required goal coverage. Missing goals schedule repair; absent repair authority or unresolved blockers produce a resumable contract/operator pause. Engine `completed` is not product `DONE`: the driver also requires release approval, fresh proof and verified ship finalization.

### Audited execution mutation

Only planner/diagnostic roles receive `graph_mutate`. They may create, replace, split or supersede execution tasks, revise dependencies or routes, and insert an authorized architecture arena. Each mutation names the expected execution revision, reason, real run-local evidence, and affected task/goal/assumption IDs. The engine serializes revision compare-and-swap, validates topology and persists the changed definition with an audit entry containing actor, time and previous/new hashes. Superseded task identities and results remain as tombstones.

Mutation cannot expand tools, roles or artifact authority, replace running or protected safety nodes, remove the repair planner, bypass previously reachable safety nodes, or change protected goal identity. Task dependency DAGs are distinct from conditional/retry edges. Mutation is execution adaptation, not a new acceptance contract or a release approval.

### Human node fields

`title`, `question`, `statePath`, optional `detail: "stack.json"` renderer and optional `feedbackPath` remain available for custom graphs. A feedback gate requires non-empty denial feedback of at most 4000 characters. The shipped gated graph has one human node, `human` (`release.approved`, `release.feedback`, Approve / Request changes / Stop), in addition to the driver's initial intent confirmation. Its approval is checkpointed and written to `release-approval.json` for the exact accepted intent and verified candidate. A persisted answer is not authority for a changed candidate.

### Local blockers and operator gates

Pause nodes carry `{ id, type: "pause", recovery, reason, resume }`. A routed pause records a branch-local blocker; its affected tasks and dependency descendants cannot run, while independent ready branches drain before the graph parks. Human nodes likewise wait for independent ready work. The parked checkpoint preserves blockers and resume targets; `/kpi <job>` re-arms them. This scheduling behavior does not promise that every driver-level credential, research or intent refusal is branch-local.

The shipped loops retain `unsafe` as their explicit bounds pause; ordinary stack/response/routing/repeated-witness defects use repair instead of mandatory operator approval. Initial gated intent consent, gated release consent, credential access, protected-intent changes, hard policy denies and unavailable external authority remain explicit boundaries.

The host `deliver` node reads the actual remote ref with `git ls-remote`, never treating a stale local tracking ref as delivery proof. It pushes only the verified commit to `refs/heads/kpi/<job_id>`, never force-pushing, and looks up an existing pull request before creating one. A lost response after commit or PR creation cannot replay that completed action. Delivery uses the existing checkpointed retry engine and checkout writer authority; credential/configuration refusal parks at `delivery-prerequisite`, whose resume target is delivery rather than commit. The invocation's one-commit check and durable `ship.json` publication stay inside that host action. Final completion rechecks protected intent, current acceptance and the local commit record without an uncheckpointed remote lookup. Resuming a completed graph whose delivery record was lost re-arms only `deliver`, not the commit action.

Graph limits are `{ maxConcurrency }` only (`coding-loop.gated` and `coding-loop.auto` 2, `spec-first` 1). Other configured cap keys are refused. Gated policy retains `allowNonInteractive: false`, project-graph confirmation and mutating-node policy checks; adaptive planning does not disable tool authorization.

### coding-loop.auto.json

The auto graph shares initial refinement, repair and host verification. Explicit autopilot delegates initial intent acceptance only under the constraints in §5. After approved review and final host verification it uses deterministic `release.set` (`release.approved = true`) instead of a human release node, then ship. The set node does not assign `DONE`. Policy sets `allowNonInteractive: true`, `allowNonInteractiveMutations: true`, `confirmProjectGraph: true` and `confirmMutatingNodes: false`; these do not grant blanket external-action or secret authority.

### Node tool policy

| Node | tools | readOnly |
|---|---|---|
| ac-compiler | deterministic set | n/a |
| specify / plan-check | read, grep, find, ls; engine response → `intent.proposal.json` | true |
| plan | read, grep, find, ls; engine response → `stack.json`; planner mutation capabilities | true for product files |
| implement | read, grep, find, ls, bash, edit, write | false |
| test / verify | host executes exact protected quality/AC commands under writer lease | not a model role |
| review | read, grep, find, ls, `write_contract` → `verdict.json` | read-only for product files |
| human | none | n/a |
| unsafe | pause/blocker | n/a |
| release.set | deterministic set | n/a |
| ship | bash: stage approved candidate and create its one Conventional Commit with the exact job trailer; no delegated push/PR instructions | false |
| deliver | host-owned remote reconciliation, exact job-ref push and native `gh` PR lookup/create; current release authority and candidate evidence required | host writer authority |

Review cannot write product files; its verdict is not host verification. The host owns `evidence.json`, `goals.json` and `verification/**`. Exact authorized verification commands may have effects through project scripts; this is not shell sandboxing.

## 8. Graph engine (ours)

**REQ-GE-01** Implement in `extensions/graph/`. Do not import `@shying/pi-graph`.

Minimum engine behavior:

- Load JSON schemaVersion 2 graphs from package `graphs/` and project `.kpi/graphs/`
- Superstep: ready nodes run, writes commit together
- Agent nodes call `createAgentSession` from the harness core (the `@earendil-works/pi-coding-agent` workspace in this repository)
- Isolated = new in-memory or fresh session; thread = persisted JSONL keyed by threadKey
- Human node: `ctx.ui.confirm` for a yes/no gate, `ctx.ui.select` + `ctx.ui.editor` for a gate with `feedbackPath`; the driver answers with `submitHuman(HumanAnswer)`; no dialog UI → `NEEDS_HUMAN` (`approval`), never auto-answered; an answered gate is in the checkpoint and is not asked again on resume
- Each agent node batch attempt is bracketed by `node.started` / `node.finished` events written to the run's `events.jsonl` before any pause handling; transient retries do not repeat them. The engine exposes nothing else — the control plane reads the log.
- Checkpoint after each superstep and before every backoff, including actual execution definition, audit revisions, supersession, blockers, recoveries and pending result routes
- Restore the checkpoint definition, never reconstruct from a named template. Missing topology requires a trusted original backup or a new job with newly confirmed intent; the old run is not silently restarted
- Resume unresolved work and durable result propagation; interrupted running nodes retain run/retry/backoff state. Re-derive goal coverage even from a cached completed checkpoint. Paused targets and active siblings remain scheduled, and retired cap keys are ignored rather than enforced
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

`loop-amber.json` and `protocol-blue.json` retain their historical registration names, not their former color semantics. The operator's RP-22 imported-wireframe choice makes machine work cool and actual human intervention warm (`visual-targets.md` §2; PRD AC-06.1/.2 and US-16).

- `accent`, `borderAccent`, `toolTitle`: cool `#70ced1`
- `success`: muted green `#91c9a0`
- `error`: restrained red `#df827b`
- `warning`: warm peach `#e9ad86`

Both registrations use the restrained dark palette. Warm human emphasis applies to a parked `NEEDS_HUMAN` run or a genuine attended `RUNNING` gate (graph interrupted with an explicit pending question/human record). Automatic interruption/retry/repair, stale question/paused metadata on a running graph and terminal DONE/STOPPED must not show human oversight. Resume returns to cool work. Hex values guide styling, not screenshot equality. This is a target contract, not a claim that a terminal capture has passed.

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

### Overlay and retained graph board

The primary home/interaction reference is imported `visual/k-pi-design/K-pi Command Center Wireframes.dc.html` (4b–4k), per the operator's [RP-22 decision](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild). The Avid post https://x.com/av1dlive/status/2092622516544270781 and reconstructions guide retained technical/widget geometry only.

The above-editor widget and printed board retain header `K-π`, MODE, JOB, stages 01–08, ROUND, PASS/FAIL, six non-empty-file lamps and STOP. Authoritative human intervention adds the pending-question oversight box and, on the printed board, the three laws. Jobs home exposes plain-language Now/Next/Done first; the graph/file/context/telemetry/session detail remains accessible one level deeper. See `visual-targets.md` §2 and §Command Centre.

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

The widget is a component with a 1 s ticker (`BOARD_TICK_MS`) that reads `events.jsonl` incrementally through one activity reader per live job and narrates each record once in the chat (`K-π ▶` start, `K-π ■` / `K-π ✕` finish, `K-π ↻` retry, `K-π ⇄` route change — never a line per tool call); a reinstall or `/kpi status` never re-narrates. A read error paints `EVENTS ✕ <code>`. Current machine activity and running/retry status stay cool, recorded completed stages use `success`, pending stages are dim, actual human intervention is warm, and STOPPED is distinct from DONE. Stage-rail position alone is not completion evidence. `PASS/FAIL PENDING` reads until a verdict exists. At 70 columns and below rows are flat but keep every field; the lamp row folds rather than cuts, keeping current stage and STOP visible. Once the newest run has finished the widget drops itself and stops its ticker; `/kpi status` can still open that job's Command Centre. Widget lifecycle does not terminate a fleet-enabled overlay.

### Command Centre (`/kpi status`)

In the TUI `/kpi status` opens a full-width `ctx.ui.custom` overlay using native run-file snapshots, no model. The loop is detached so status, `/agents` and chat remain usable mid-run. In print/rpc mode the plain board is printed instead, without key hints. Imported `visual/k-pi-design/K-pi Command Center Wireframes.dc.html` guides HOME and interaction; older `design/claude-design/` layouts guide retained DETAILS/SESSION, not HOME.

- HOME: a single Jobs list grouping genuine snapshots as NEEDS YOU (`NEEDS_HUMAN`), RUNNING, DONE and separately STOPPED. The selected job unfolds Now/Next/Done. Runtime status, not stale pause metadata, determines human attention. Recorded completed activity is required for done steps. Missing summaries or metrics remain unknown; never invent an agent count, spend, fleet member, path or shipped PR.
- DETAILS (enter on the opened job): STAGES 01–08 with recorded DONE / RUNNING / PENDING / FAILED / WAITING status and per-stage detail; LIVE transcript; TELEMETRY (estimated cost/rate, context, tokens, elapsed, rounds, supersteps, node runs, worker admission and retry, never spend/time/round caps); SHARED RUN STATE (six non-empty-file lamps, sizes, mtimes, notes, fingerprint and verifier); CONTEXT LAYER (pack, research, K-stack, agents, route, policy); EVENTS; labelled input and key hints.
- SESSION (enter on a stage): stage rail and transcript, following while running and replaying after completion; NODE panel with status, elapsed, estimated cost, model, route and tokens, unknown values shown as unknown.
- Keys: `j/k` or arrows navigate jobs on HOME and stages in DETAILS/SESSION; `1`–`8` and `[ ]` select stages in DETAILS/SESSION. Enter opens details then session. Tab/shift-tab selects the next/previous actual human-action job from every view. `?` opens a help card that intercepts navigation; esc clears input, dismisses help, returns one level, then closes. `q`/ctrl+c closes; `r` refreshes. Shortcuts act only with empty input; begin with a space to type a shortcut letter.
- Input: `command ›` accepts `/kpi stop` exactly once or `/kpi verify` for the opened job. A different selected job must first be opened, preventing actions on the wrong run. Other `/kpi …` and shell commands are refused; `chat ›` closes before sending ordinary text to the existing chat source. This input does not claim direct steering, approval, new-job creation, revisions or bounds recovery.
- Layout: HOME stays Jobs-first at all widths; Now/Next/Done remain visible at 80/108/120 columns. DETAILS is two-column at ≥120, stacked below; below 80 its technical fallback retains STAGES, LIVE and EVENTS. At 140×50 the full detail panels are visible; at 140×40 STAGES compacts so SHARED RUN STATE and CONTEXT LAYER remain visible. Row budget is terminal rows minus three; remaining panels/detail lines yield as height shrinks. The retained 60-column fallback and 160/200-column layouts must not overflow. No framed line may exceed terminal width.
- Refresh: use the same 1 s tick as the widget (run-file metadata every fifth tick), serialize slow reads, show read errors and retry them on later ticks or `r`. Native `CommandCentreSources.fleet` provides `read()` snapshots and `open(jobId)`; the current source wins its duplicate row. Selection is stable by id and scrolls into view. Fleet refresh continues when the opened job ends or disappears; opening another job closes the old overlay before invoking its source and surfaces open failures. Without fleet, only the actual opened job appears and a terminal/gone result stops the ticker. Closing always disposes it. No fallback invents a job.

Imported HTML inspection and deterministic fixture renders are not built-terminal acceptance. UAT-16 still requires actual navigation, color, error recovery and fleet lifecycle proof; authenticated inference is separate.

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

Codex gets a one-line provider billing confirm once per new slot. Cursor gets an informational notice that access uses its CLI protocol and subscription entitlement, compatibility may change, and K-π does not provision Cloud Agents.

### Cursor provider

Operator-authorised on 2026-09-06: implement Cursor's CLI protocol as a first-party provider through `registerProvider("cursor", { oauth, refreshModels, streamSimple })`, using custom API `kpi-cursor`. This replaces the earlier public-standalone-API prerequisite. Reference: OMP 18.1.11, commit `b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b`; source attribution belongs in `NOTICE`. This is observed protocol compatibility, not a claim of Cursor endorsement or a public API stability guarantee.

- **Authentication:** Browser PKCE at `https://cursor.com/loginDeepControl`, with a fresh verifier/challenge and flow UUID; poll `https://api2.cursor.sh/auth/poll`. Persist actual returned access/refresh credentials through native auth and account-pool storage. Renew at `https://api2.cursor.sh/auth/exchange_user_api_key`; rotate refresh tokens when returned. Use validated JWT expiry, never a fabricated lifetime or an access token masquerading as a refresh token. Cancellation, timeout, invalid/expired grants and transient failures retain their distinct native recovery paths; no secret appears in diagnostics. No imported grant acquires a second refresh owner.
- **Catalog:** Discover through authenticated HTTP/2 protobuf `/agent.v1.AgentService/GetUsableModels`. Use the native generation-checked `RefreshModelsContext.publish` cache, not the removed unverified `cursor-models.json`. Offline mode uses only the last native discovery cache. A successful empty list is authoritative and clears it; failed discovery reports the error without substituting guessed models. Model ids and explicit parameters come from discovery. Missing capacities use the existing zero/unknown sentinel; do not infer images, reasoning, context or output limits from a model name or another provider's model. Native `models.json` overrides are the explicit operator metadata path. Native zero price fields mean unreported subscription price, not free usage.
- **Streaming:** Use HTTP/2 Connect/protobuf `/agent.v1.AgentService/Run` on `https://api2.cursor.sh`, with bearer authentication and the observed CLI protocol identity. Honour `onPayload` replacements and `onResponse` before consuming any response body, including non-2xx. Preserve the native conversation, real tool results and system instructions, including Cursor's request-context rule projection and content-addressed history handshake. Decode fragmented frames, text/thinking, usage when reported, trailers and terminal errors. Aborts, deadlines and interrupted streams release resources and never become successful completions.
- **Wire identity and reasoning replay:** Keep discovered catalog ids stable while applying the observed CLI serialization rule for OpenAI effort-sibling ids to `requestedModel` parameters. This is wire translation, not a guessed capability or fallback model. Preserve required same-model Cursor K3 reasoning parts and signatures in replay; foreign-model history that cannot satisfy that protocol is explicitly refused rather than forged.
- **Authority:** The adapter is transport, not another executor. Cursor-requested tools become native K-π tool calls and pass normal validation, policy, `tool_call` and approval handling; only genuine native results return to the model. No direct filesystem/shell execution, fabricated successful handoff, Cloud Agent provisioning, Cursor subagent dispatch, or server-side action approval. Reject unsupported execution requests explicitly. K-π owns graph nodes, protected intent, sessions and release approval.
- **Recovery and evidence:** Rebuild continuation from the native transcript rather than treating provider-side state as the source of truth. Never share pending execution across sessions or grants. Keep protocol tests for binary discovery, history/system handshake, tool-result continuation, cancellation, malformed/truncated streams and HTTP/Connect errors. Exercise the compiled/packed artifact against that protocol fixture. Real Cursor login, discovery, inference and tool use require an authorised seat and get separately labelled live evidence; fixtures cannot satisfy that acceptance.

No community Cursor/OMP runtime package, hardcoded bootstrap catalog, guessed OpenAI endpoint or generic `streamSimple` fallback is permitted. Unknown account eligibility, metadata or pricing must remain visible as unknown.

### Local model metadata

Local discovery uses only the configured origin and documented discovery replies. Positive integer context/output capacities and reported modalities/reasoning retain `discovery` or explicit `operator` provenance. Missing capacities remain zero/unknown and cannot authorize a guessed context budget. Native `models.json` overrides are the operator's explicit metadata path.

The version-2 local cache retains stable model-to-origin bindings and successful sibling catalogs when another origin fails. Legacy identity-only caches do not promote the old generated 32K/4K numbers to measured metadata. Explicitly reported Ollama cloud-backed or embedding entries are not selectable local chat resources.

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
3. `narrative-ac` — unresolved/non-executable required acceptance cannot enter autopilot engineering or count as verified success
4. `bounds-violation` — implementer tries to edit outside allow → `NEEDS_HUMAN` (`bounds`), no commit
5. `accounts-failover` — slot A classified exhausted, slot B healthy, A never selected
