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
| `/kpi [goal]` | Gated coding loop from a task. `/loop` is an alias. |
| `/kpi --plan <path>` | Skip specify; freeze plan files |
| `/kpi --mode gated\|autopilot` | Force mode |
| `/kpi --until-green` | Alias of autopilot |
| `/kpi --max-cost-usd <n>` | Freeze maxCostUsd onto task.limits |
| `/kpi --timeout-ms <n>` | Freeze timeoutMs onto task.limits |
| `/kpi --max-rounds <n>` | Freeze maxRounds onto task.limits |
| `/kpi status` | Overlay from files, no model. Must look like the Avid boards. |
| `/kpi stop` | Write `BLOCKED`, halt |
| `/statusbar` | Toggle the K-π footer |
| `/specify [goal]` | Spec files only |
| `/plan [goal]` | Isolated plan |
| `/implement` | Implementer node only |
| `/review` | Isolated reviewer |
| `/verify` | Run gates → `evidence.json` |
| `/ship` | Gated confirm or no-op if already `DONE` |
| `/accounts` | Slot overlay |
| `/accounts login <pool>` | Add a model slot. Pools: anthropic, openai, openai-codex, xai, zai, zai-coding-cn, kimi-coding, cursor, llama, ollama, lmstudio, local-openai. |
| `/accounts login exa\|perplexity` | Store a research credential. Research targets are not pools: no slot, no routing, no fallback-chain entry. See `research.md`. |
| `/accounts logout <slot>` | Drop slot. `/accounts logout exa\|perplexity` clears that research credential. |
| `/accounts next` | Force sibling |
| `/accounts pin <slot>` | Stick session |
| `/pool strategy <provider> <name>` | |
| `/pool chain a,b,c` | Fallback order |
| `/kg query` `/kg propose` | Claim store |
| `/setup-kstack` | Role map from `model-ladder.md`, then Exa and Perplexity key save/skip. See `kstack.md`. |
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
| `state.json` | graph engine | Progress |
| `events.jsonl` | append-log | Hash chain |
| `research.md` / `research.json` | specify/plan research node | Mode, network state, sources + notes. Required before implement. |
| `stack.json` | plan | Dune modules. Frozen before implement. |
| `fingerprints.json` | control plane | SHA-256 of canonical JSON |

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

`mode` enum: `exa | perplexity | auto | local`.  
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

**EVT types:** `handoff.created`, `tool.request`, `approval.result`, `tool.result`, `checkpoint`, `handoff.completed`, `recovery.started`, `recovery.completed`, `kg.patch.proposed`, `kg.patch.accepted`, `accounts.failover`, `ac.refused`, `loop.terminal`.

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

### Stop states

| State | Meaning |
|---|---|
| `DONE` | Required AC receipts green + fresh, review.approved, bounds.held |
| `BLOCKED` | Required AC not executable after start, or forbidden action requested |
| `EXHAUSTED` | maxRounds / maxCostUsd / timeoutMs / maxNodeRuns |
| `NO_PROGRESS` | Repeated output_fingerprint or same failing AC ids two rounds |
| `UNSAFE` | Write outside bounds, policy deny, secret-shaped path |
| `NEEDS_HUMAN` | AC changed, untestable review issue, risk left repo-local, or a healthy research service that supplies fewer than two distinct external sources |

Default caps: `maxRounds=3`, `maxCostUsd=5`, `timeoutMs=1800000`, `maxConcurrency=2`.

Retry ≠ round. Transient transport/429/timeout: same round key, max 2 retries, exponential backoff.

## 7. Graphs

Node types we implement: `agent | set | human`.

Context modes for agent nodes: `isolated | thread`. Default thread key = node id. Reviewer and planner and ac-compiler and specify are `isolated` + `readOnly`. Implementer is `thread` key `coder`.

### coding-loop.gated.json (normative shape)

```
ac-compiler → specify? → plan → implement → test → bounds → review → human → ship
                              ▲                         │
                              └─────────────────────────┘  REVISE / red
```

Conditional:

- skip specify when `--plan` present
- `test.passed == false` → implement
- `bounds.held == false` → `UNSAFE`
- `review.approved == false` and testable → implement
- `review.approved == false` and untestable → `NEEDS_HUMAN`
- review pass → human
- human true → ship
- human false → implement or `__end__`

Policy on gated graph: `allowNonInteractive: false`.

### coding-loop.auto.json

Same until review. Then:

- review pass + bounds + fresh receipts → `release.set` → ship
- no human node on the happy path

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
| implement | read, grep, find, ls, bash, edit, write | false |
| test | read, bash (quality_gates + AC commands only), `write_contract` → `evidence.json` | read-only for product files; bash command-allowlisted |
| bounds | set | n/a |
| review | read, grep, find, ls, `write_contract` → `verdict.json` | read-only for product files |
| human | none | n/a |
| release.set | set | n/a |
| ship | bash: `git add` `git commit` on job branch only | false |

Neither `test` nor `review` receives `write` or `edit`. `write_contract` (REQ-RS-06) is their only mutation path and reaches exactly one declared file.

## 8. Graph engine (ours)

**REQ-GE-01** Implement in `extensions/graph/`. Do not import `@shying/pi-graph`.

Minimum engine behavior:

- Load JSON schemaVersion 2 graphs from package `graphs/` and project `.kpi/graphs/`
- Superstep: ready nodes run, writes commit together
- Agent nodes call `createAgentSession` from the harness core (the `@earendil-works/pi-coding-agent` workspace in this repository)
- Isolated = new in-memory or fresh session; thread = persisted JSONL keyed by threadKey
- Human node: `ctx.ui.confirm` / `select` / `input`; status `interrupted` until resume
- Checkpoint after each superstep under `.kpi/runs/<job_id>/graph/`
- Resume unresolved nodes only
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
K-π  LOOP gated r2/3  STAGE implement  GATE human  AC 4/5
```

### Overlay (Avid boards)

Canonical look: https://x.com/av1dlive/status/2092622516544270781

`/kpi status` and the above-editor widget must contain: header with `K-π`, stages 01–08, ROUND, PASS/FAIL, six file lamps, STOP state. Human pause adds the oversight box and the three laws. Geometry in `visual-targets.md` §2.

### Widgets

Always-on during a live job, `setWidget` above the editor as a **component** (the string form is capped at ten lines and painted colourless). It is the compact cut of Board A / Board B, framed in the theme's colours:

```
K-π GRAPH CONTROL │ MODE gated │ JOB <id> │ ROUND <n>/<max>
┌──────────────┬──────────────┬ … 8 stage cells: "04 implement" / CURRENT|DONE|PENDING …┐
FILES  ● task.json  ● context.md  ○ candidate.json  ● evidence.json  ○ verdict.json  ● events.jsonl
LOOP <id>  STAGE 04 implement  NODE <node>  GATE <human|machine>            ┌──────────────┐
ROUND <n>/<max>  PASS ● last verifier  FAIL ○ none  FINGERPRINT <short>       │ STOP RUNNING │
CONTEXT product ● structure ● tech ○  AGENTS n  BUS ●  ROUTE …  USAGE …       └──────────────┘
WAITING ON OPERATOR  <question>          (paused only)
STOP STATES  DONE ○  BLOCKED ○  APPROVAL ●   (paused only)
```

The current stage cell and lit lamps are `accent`, done stages `success`, pending `dim`; the STOP box is `warning` while running, `success` for DONE, `accent` for NEEDS_HUMAN, `error` otherwise. `PASS/FAIL PENDING` reads until a verdict exists. At 70 columns and below the rows are flat but keep every field; the lamp row folds rather than cuts. Once the newest run has reached a terminal the widget is removed; `/kpi status` then names that last job.

`/kpi status` draws the full board (context layer, stage cells, iteration loop, oversight, lamp cells, and on Board B the shared run state, stop states, three laws and the operator question) in a `ctx.ui.custom` overlay using the live theme; any key closes it.

Accounts widget:

```
ACCOUNTS
  ANTH  ● <slot>  <pct>%  <window>   <slot>  <pct>% cd <eta>
  LOCAL ● <slot>  (local) $0  <base-url>
  …
ROUTE   <provider>/<model>  via <slot>
```

Per-slot percentages. No unlabeled aggregate as the only number. A `local` slot has no quota: show its base URL and health instead of a percentage.

`/kpi status` uses `ctx.ui.custom` overlay. Data from files.

Footer `setStatus("loopgraph", …)` and `setStatus("accounts", …)`.

Custom entry renderers for EVT types listed above.

## 12. Policy

`.kpi/policy.json` default:

```json
{
  "deny": [
    "git push",
    "git push --force",
    "git reset --hard",
    "rm -rf",
    "chmod 777"
  ],
  "commit": {
    "gated": "confirm",
    "autopilot": "after-release"
  },
  "unknown": {
    "gated": "confirm",
    "autopilot": "deny"
  }
}
```

Hook: `pi.on("tool_call", …)`.

Deny if:

- command matches deny list
- write path outside active job `write_allow`
- path looks like `.env`, `id_rsa`, `auth.json`, `accounts.secrets.json`
- a `write_contract` call whose target is not the declared contract path for that agent, job, and role, or whose payload fails `SCH-verdict` / `SCH-evidence`

Allowlisted reads (`ls`, `git status`, `git diff`, `git log`, test commands from `quality_gates`) do not confirm.

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
          "warningAcceptedAt": "2026-08-31T00:00:00.000Z"
        }
      ]
    }
  },
  "fallback": ["anthropic", "openai-codex", "xai", "zai", "kimi-coding", "cursor"],
  "stickiness": "session-until-exhausted"
}
```

Pool ids: `anthropic | openai | openai-codex | xai | zai | zai-coding-cn | kimi-coding | cursor | llama | ollama | lmstudio | local-openai`.

`exa` and `perplexity` are **not** pool ids. They are research credential targets (`research.md`): never in `pools`, never in `fallback`, never an argument to `/pool strategy` or `/pool chain`, and never a `registerProvider` call. A research key never changes which model answers a turn and never grants provider-native web search.

Strategy: `quota-first | round-robin | sticky`.  
Slot kind: `oauth | api_key | local`.

**REQ-SL-01** A `local` slot is credential-free. It persists the `baseUrl` it was configured with, and every request routed to that slot stays on that origin — no silent cloud proxy. It MAY carry an optional `secretRef` when the local server wants a token. An absent `secretRef` is valid; never write a placeholder or dummy secret to satisfy the schema.

**REQ-SL-02** `local` slots are outside the default cloud fallback chain. They enter routing only through `/pool chain …,<pool>` or an explicit pin. They have no quota: the accounts widget shows no percentage for them (§11) and the footer cost cell is `(local) $0` (REQ-SB-08).

Local pools use official llama.cpp (`LLAMA_BASE_URL`) or first-party `refreshModels` on `/v1/models`. An unreachable server cools that slot; failover stays inside the local family first.

Secrets in `~/.kpi/agent/accounts.secrets.json` keyed by `pool/slot`. Never log them. A `local` slot with no `secretRef` has no entry here.

Official `~/.kpi/agent/auth.json` primary credential is imported as slot `default` if present.

### Official catalogs

**REQ-PR-01** Do not pass `models` when overlaying `anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, `kimi-coding`.

Credential injection: `before_provider_headers` sets `Authorization` from the selected slot for that provider family.

Detection: the global `after_provider_response` hook carries status and headers only, never a response body. Classifier in `accounts/errors.ts` treats 429, 402, and quota-shaped 403, together with `retry-after` and reset headers, as cooldown events at that layer. Body tokens such as `usage limit`, `rate_limit`, and `quota` may be classified only inside a custom fetch client that owns and safely consumes that body. Global classification never depends on body inspection.

Cooldown: parsed reset timestamp if present, else 5 hours. Slot is skipped while cooling.

Selection order:

1. Sticky slot if healthy
2. quota-first among healthy siblings (usage readers in `accounts/usage/*`)
3. else round-robin among healthy
4. else cross-family fallback + `pi.setModel` to mapped equivalent
5. else wait or `NEEDS_HUMAN`

**REQ-PR-02** Never select a cooling slot when a healthy sibling exists.

Model mapping for fallback is a table in `accounts/balancer.ts` updated when catalogs refresh (`ctx.modelRegistry.getAvailable()`). Prefer same-class: opus→strongest available, sonnet→mid, etc. If no mapping, skip that family.

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
4. `bounds-violation` — implementer tries to edit outside allow → `UNSAFE`
5. `accounts-failover` — slot A classified exhausted, slot B healthy, A never selected
