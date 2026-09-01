# k-pi — Loop & Graph Engineering Control System

**Product name:** k-pi. **Brand cell:** `K-π`. **Build contract:** `pi-loopgraph-docs/` (PRD, spec, visual-targets, roadmap, implementation-plan). This file is the design narrative.

**Purpose.** Turn Pi (pi.dev) into a control system — not a swarm — that decides what work matters, what agents may do, and what they must leave behind. Give it a **task** or a **finished plan** and it runs a full engineering loop. Human approval is the default for irreversible effects; **autopilot is allowed only when acceptance criteria are machine-verifiable** and the evidence gates pass.

**Source of truth for the idea.** Avid (@Av1dlive), 26 Aug 2026, [x.com/av1dlive/status/2092622516544270781](https://x.com/av1dlive/status/2092622516544270781), plus the builder-edition definition of graph engineering (10 Aug 2026).

**Source of truth for the harness.** Official Pi documentation at [pi.dev/docs](https://pi.dev/docs), the Pi extension / TUI / package APIs, and `@shying/pi-graph`.

**Non-goal.** Do not pretend Grok Bot and Kimi Code are one native product, and do not pretend Pi ships a native knowledge-graph engine or DAG scheduler. The article itself is explicit about those gaps. This plan maps the *control principles* onto Pi primitives that actually exist.

---

## 0. What the post actually says

Most agent systems do not fail because the model is weak. They fail because nobody owns:

1. the **return path** (who decides the loop is done),
2. the **shared state** (what every worker reads and writes),
3. the **approval boundary** (what may never happen without a human).

The fix is a control system with seven pieces:

| Piece | Job |
|---|---|
| Outer loop owner | Owns the result, the round key, the stop rule |
| Bounded inner worker | One reviewable candidate per round |
| Knowledge graph | Source-backed claims, not vibes |
| DAG | Execution order and fan-out / barriers |
| Context pack | Limits drift; every worker gets the same frame |
| Two policy layers | Outer approvals + inner tool allowlists |
| Append log | Every transition is recorded, hash-chained, inspectable |

Avid’s builder definition of graph engineering is the shortest correct one:

> You own the map and the route. The model owns the judgment inside each step. A loop is just a graph with one node and an edge that points back at itself.

The coding graph he actually runs:

```
plan (strong, isolated) → build (cheap, one step) → grade (independent reviewer)
                                                      ↓ fail
                                                   back to build
                                                      ↓ pass
                                                   verify (tests / build — a signal no model can argue with)
                                                      ↓
                                                   ship (human gate)
```

That is the graph this Pi setup implements.

---

## 1. Product-boundary map (do not lie to yourself)

### What Pi actually is

Pi is a **minimal terminal coding harness**. Core thesis: four tools (`read`, `write`, `edit`, `bash`) and a system prompt under ~1,000 tokens. Everything else is opt-in.

Pi is extended, not forked:

| Mechanism | What it is | Where it lives |
|---|---|---|
| Extensions | TypeScript modules: tools, commands, events, custom TUI | `~/.pi/agent/extensions/`, `.pi/extensions/`, or a package |
| Skills | On-demand Agent Skills (`SKILL.md`), progressive disclosure | `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/` |
| Prompt templates | Slash-command prompts (`/plan`, `/review`) | `~/.pi/agent/prompts/`, `.pi/prompts/` |
| Themes | JSON color tokens for the TUI | `~/.pi/agent/themes/` |
| Packages | Bundle of the above, installable via npm/git | `pi install …` |
| Context files | `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md` | cwd + parents + `~/.pi/agent/AGENTS.md` |
| System prompt files | `SYSTEM.md` (replace instruction template), `APPEND_SYSTEM.md` (add rules) | `.pi/` (project, trust-gated) and `~/.pi/agent/` |
| Modes | Interactive TUI, `pi -p` print, `--mode json`, `--mode rpc`, SDK | four official modes |

Pi does **not** ship: native sub-agents, native plan mode, native knowledge graph, native DAG, built-in sandbox, or a Grokbot-style multi-bot group chat.

### What already exists that we should compose, not rebuild

| Existing piece | Use for |
|---|---|
| `@shying/pi-graph` | Recoverable multi-agent state graphs: `agent` / `set` / `human` nodes, reducers, checkpoints, `/pig` commands, `pi_graph_run` tool |
| Graphify or `@vndv/pi-codegraph` | Code intelligence graph (callers, callees, impact) — *code* graph, not the *claim* graph |
| Official extension events | `tool_call`, `tool_result`, `agent_start/end`, `turn_start/end` — the append log and policy gates |
| Official TUI API | `setWidget`, `setStatus`, `setFooter`, `registerEntryRenderer`, `registerMessageRenderer`, overlays |
| Official security model | Project trust is a *load guard only*. Real isolation is Docker / Gondolin / OpenShell |

### Honest mapping from the article onto Pi

| Article component | Pi equivalent | What it is *not* |
|---|---|---|
| Grokbot outer loop | Pi interactive session + control-plane extension + `/loop` `/ship` commands | Not a second product |
| Kimi K3 inner pass | A pi-graph `agent` node with a cheaper/faster model, narrow tools, JSON output contract | Not a native handoff |
| Knowledge graph | File-backed JSONL under `.pi/kg/` plus one writer | Not a built-in graph DB |
| DAG | `pi-graph` JSON graphs under `.pi/graphs/` | Not Kimi AgentSwarm |
| Context pack | `AGENTS.md` + `.pi/context/` + run-scoped `context.md` | Not conversation memory |
| Outer policy | Human `pi-graph` nodes + `tool_call` hook + confirm dialogs | Not Grok Bot Auto Review |
| Inner policy | Per-node `tools` + `readOnly` + `policy.confirmMutatingNodes` | Not Kimi permission rules |
| Append log | Extension writing `runs/<id>/events.jsonl` with a hash chain | Not Kimi `wire.jsonl` |

---

## 2. Design principles (non-negotiable)

1. **A loop is a protocol, not “keep going.”** Owner, worker, verifier, stop rule. Max rounds. New evidence required to start a new round. Retry ≠ new round.
2. **Separate memory from execution.** Knowledge graph = long-lived source-backed claims. DAG = order. `state.json` = temporary run progress. Never let two writers own the authoritative graph.
3. **Approval sits outside the loop — and can be a machine.** Research, draft, test, recommend automatically. A human is the default ship gate. Autopilot may replace that gate only when every acceptance criterion has a fresh, source-bound, mechanically checkable proof. Irreversible *external* effects (push, deploy, delete, spend, secrets) stay human unless a separate allowlist says otherwise.
4. **Tests and builds are the signal no model can argue with.** Reviewer opinion is not a ship gate by itself.
5. **One writer per state file. Atomic writes.** Write `*.tmp`, fsync, rename. Append-only events.
6. **Least privilege by default.** Planner and reviewer are read-only. Implementer gets write tools only after a plan exists. Print mode (`pi -p`) never runs a write-capable profile.
7. **User always knows what is happening.** The TUI is a control panel, not a chat dump. Stage, node, round, gate, and evidence are always visible. The *model’s spoken reply* stays short.
8. **Best-practice primitives are already on the path.** Spec, tests, review, conventional commits, DoD — the user does not have to remember to ask.

---

## 3. Target user experience (match the screenshots)

The article screenshots are the visual contract.

### Screenshot language to reproduce

**Board 1 — “Master Loop & Graph engineering” (amber on black)**

- Context layer across the top: long-term memory, session memory, knowledge base, user context, system state.
- Numbered pipeline `01 input → 02 load → 03 parse → 04 plan → 05 step tools → 06 decide / tool-loop → 07 output → 08 feedback`.
- Lower iteration loop: capture insights → PASS? → refine / evaluate / persist.
- Corner counters: `STAGES` and `NODES`.
- Safety box: “THINK SAFETY / ISOLATED PER SESSION / HUMAN OVERSIGHT REQUIRED.”

**Board 2 — “The loop is a protocol, not keep going” (blue on black)**

- Five stages in one job: EVENT → COORDINATOR → WORKER → VERIFIER → EXECUTE + LIVE CHECK.
- Shared run state files in a single row: `task.json`, `context.md`, `candidate.json`, `evidence.json`, `verdict.json`, `events.jsonl`.
- Stop box: DONE / BLOCKED / APPROVAL / ROUND N.
- Three laws under the board: retry is not a new round; a round needs new evidence; approval sits outside the loop.
- Color grammar: gray = read/prepare, blue = active handoff, outlined = human decision.

### What the user sees in Pi

Always-on **control widget** above the editor:

```
LOOP  feature/auth-refresh   MODE autopilot   ROUND 2/3   STAGE 04 VERIFY   NODE reviewer
STATE  planned → implemented → reviewing
GATE   machine  AC 5/5 executable  evidence fresh@9f3a  human=off
STOP   running  until DONE | EXHAUSTED | NO_PROGRESS | UNSAFE | NEEDS_HUMAN
FILES  task.json  context.md  candidate.json  evidence.json  verdict.json  events.jsonl
```

Footer status:

```
pi-loopgraph  ● running  stages 8  nodes 5  tokens 41.2k  cost $0.18  stop-rule 3
```

Custom entries in the transcript (not LLM prose):

- `handoff.created` — coordinator dispatched reviewer
- `tool.request` / `approval.result`
- `checkpoint` — state.json committed
- `verdict` — PASS / REVISE / BLOCKED with evidence paths

The assistant message itself is short:

```
Reviewer blocked ship.

Blocking: auth middleware does not reject expired refresh tokens.
Evidence: tests/auth.refresh.test.ts:44 failed; src/auth/refresh.ts:81.
Next: implementer, round 3. Approval still outside the loop.
```

No walls of “Sure! Here’s a comprehensive…”. That is a first-class product requirement, enforced in `APPEND_SYSTEM.md` and a `concise-output` skill.

---

## 4. Architecture

```
                    ┌─────────────────────────────────────────┐
                    │                 YOU                      │
                    │   mission, approvals, irreversible acts  │
                    └──────────────┬──────────────────────────┘
                                   │ human nodes + dialogs
                    ┌──────────────▼──────────────────────────┐
                    │     CONTROL PLANE (Pi extension)        │
                    │  loop owner, round keys, stop rules,    │
                    │  widgets, policy hooks, append log      │
                    └──────┬───────────────┬────────┬─────────┘
                           │               │        │
              ┌────────────▼───┐   ┌───────▼──┐  ┌──▼──────────────┐
              │  pi-graph DAG  │   │ Context  │  │ Knowledge graph │
              │  .pi/graphs/*  │   │ pack     │  │ .pi/kg/*.jsonl  │
              │  planner       │   │ AGENTS.md│  │ one writer      │
              │  implementer   │   │ context/ │  │ inbox patches   │
              │  tester        │   │ run ctx  │  │ source records  │
              │  reviewer      │   └──────────┘  └─────────────────┘
              │  human gate    │
              └────────┬───────┘
                       │ artifacts + state.json
              ┌────────▼──────────────────────────────────────┐
              │  RUN STORE  .pi/runs/<job_id>/                │
              │  task.json context.md candidate.json          │
              │  evidence.json verdict.json events.jsonl      │
              │  state.json (atomic) fingerprints             │
              └───────────────────────────────────────────────┘
```

Three different “graphs,” never mixed:

1. **Knowledge graph** — long-lived claims with sources (`kg/nodes.jsonl`, `kg/edges.jsonl`, `kg/sources.jsonl`).
2. **Execution DAG** — what runs, in what order, with which tools (`/.pi/graphs/*.json`).
3. **Session tree** — Pi’s own JSONL session DAG (`/tree`, `/fork`). Useful for exploration. Not the control plane.

---

## 5. Recommended package layout

Ship this as one Pi package so it is installable with `pi install ./pi-loopgraph` or later `pi install npm:@you/pi-loopgraph`.

```
pi-loopgraph/
├── package.json                          # "keywords": ["pi-package"]
├── README.md
├── AGENTS.md                             # package self-instructions
├── templates/
│   ├── AGENTS.md                         # dropped into new projects
│   ├── APPEND_SYSTEM.md                  # concise + safety + DoD
│   ├── constitution.md                   # non-negotiables
│   └── context-pack/
│       ├── product.md
│       ├── structure.md
│       └── tech.md
├── extensions/
│   ├── index.ts                          # registers everything
│   ├── control-plane.ts                  # /loop /ship /status commands + widgets
│   ├── run-store.ts                      # atomic file IO, fingerprints
│   ├── append-log.ts                     # hash-chained events.jsonl
│   ├── policy.ts                         # tool_call gate
│   ├── kg.ts                             # kg_* tools
│   ├── renderers.ts                      # entry + message renderers
│   ├── graph/                            # OUR DAG runner on the official Pi SDK
│   │   ├── engine.ts
│   │   └── schema.ts
│   ├── accounts/                         # OUR multi-sub balancer (not oh-my-pi)
│   │   ├── index.ts
│   │   ├── store.ts                      # ~/.pi/agent/accounts.json
│   │   ├── balancer.ts
│   │   ├── errors.ts
│   │   └── usage/
│   │       ├── anthropic.ts
│   │       ├── openai-codex.ts
│   │       ├── xai.ts
│   │       └── cursor.ts
│   └── cursor/                           # Cursor is NOT a built-in Pi provider
│       ├── provider.ts                   # registerProvider + refreshModels
│       └── oauth.ts
├── graphs/
│   ├── coding-loop.json                  # the default ship graph
│   ├── spec-first.json                   # specify → plan → tasks
│   ├── research-review.json
│   └── hotfix.json                       # shorter path, same gates
├── skills/
│   ├── spec-first/SKILL.md
│   ├── tdd-cycle/SKILL.md
│   ├── isolated-review/SKILL.md
│   ├── quality-gates/SKILL.md
│   ├── conventional-commit/SKILL.md
│   ├── context-pack/SKILL.md
│   ├── concise-output/SKILL.md
│   └── kg-claim/SKILL.md
├── prompts/
│   ├── specify.md                        # /specify
│   ├── plan.md                           # /plan
│   ├── implement.md                      # /implement
│   ├── review.md                         # /review
│   ├── verify.md                         # /verify
│   └── ship.md                           # /ship
├── themes/
│   ├── loop-amber.json                   # screenshot 1
│   └── protocol-blue.json                # screenshot 2
└── schemas/
    ├── task.schema.json
    ├── candidate.schema.json
    ├── evidence.schema.json
    ├── verdict.schema.json
    ├── node.schema.json
    └── event.schema.json
```

`package.json` sketch:

```json
{
  "name": "@you/pi-loopgraph",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-agent-core": "*"
  },
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Project install (trusted repo). First-party package only — no oh-my-pi, no pi-multi-account, no pi-multi-pass, no pi-graph as a runtime dependency. Those are references we steal ideas from, not code we load.

```bash
pi install -l ./pi-loopgraph
```

Then copy templates into the repo.

---

## 5A. First-party plugins, official catalogs, stacked subscriptions

Build every plugin ourselves against the official Pi extension API. Oh My Pi / `pi-multi-account` / `pi-multi-pass` prove the product shape and also prove the failure modes. We do not install them.

### What official Pi already gives you

| Need | Official mechanism |
|---|---|
| Write a plugin | TypeScript extension in `extensions/*.ts`, or a Pi package with a `pi` key in `package.json` |
| Custom UI | `setWidget`, `setStatus`, `setFooter`, `registerEntryRenderer`, `ctx.ui.custom`, themes |
| Built-in subscription login | `/login` → Claude Pro/Max, ChatGPT Plus/Pro (Codex), GitHub Copilot, **xAI Grok**, OpenRouter, Radius |
| Built-in API keys | `auth.json` or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` |
| New official models | Live catalog refresh: `/model` refreshes in the background, `pi update --models` forces it, automatic revalidate about every 4 hours, cache in `~/.pi/agent/models-store.json` |
| Custom / missing provider | `pi.registerProvider` + optional `refreshModels({ signal })` + optional `oauth: { login, refreshToken, getApiKey }` (appears in `/login`) |
| Swap headers per request | `before_provider_headers` |
| See 429 / retry-after | `after_provider_response` (`event.status`, `event.headers`) |
| Change model mid-session | `pi.setModel`, `model_select` event |

Official Pi stores **one credential per provider id** in `~/.pi/agent/auth.json`. That is why stacking two Claude Max accounts is not a built-in feature. We add a pool *around* that, we do not fork Pi.

Cursor is **not** a built-in provider. Several community packages exist. We write our own `cursor` provider with `refreshModels` talking to Cursor’s usable-model endpoint so a new Cursor model appears without a code change.

### The rule that keeps new models automatic

**Never replace an official provider’s `models` array.**

If you `registerProvider("anthropic", { models: [...] })` you freeze last month’s list and the next Opus never shows up.

Correct split:

| Provider | How models appear | How extra subs appear |
|---|---|---|
| Anthropic | Official catalog. Leave it alone. | Extra OAuth/API slots in *our* `accounts.json`. Inject the chosen token via `before_provider_headers`. User still picks `anthropic/claude-…` from `/model`. |
| OpenAI API | Official catalog. Leave it alone. | Same: pool of `OPENAI_API_KEY` slots under the official `openai` provider. |
| OpenAI Codex (ChatGPT sub) | Official `openai-codex` catalog + `pi update --models`. | Extra ChatGPT OAuth slots in our pool. Same model ids. |
| xAI Grok | Official xAI catalog (Grok 4.6 default as of Pi 0.84.3). Device-code OAuth is built in. | Extra xAI slots in our pool. |
| Cursor | **Our** provider, with `refreshModels` hitting Cursor live. Fallback static list only until the first successful sync. | Extra Cursor OAuth/token slots in the same pool. |

On `session_start` and whenever `/model` refreshes, we read the official registry (`ctx.modelRegistry.getAvailable()`) and attach those ids to our account slots. We do not hard-code model ids for Anthropic/OpenAI/xAI.

### Account store (ours)

`~/.pi/agent/accounts.json` (mode `0600`), never committed:

```json
{
  "version": 1,
  "pools": {
    "anthropic": {
      "strategy": "quota-first",
      "slots": [
        { "id": "home", "kind": "oauth", "label": "personal max" },
        { "id": "work", "kind": "oauth", "label": "work max" }
      ]
    },
    "openai-codex": {
      "strategy": "quota-first",
      "slots": [
        { "id": "plus", "kind": "oauth" },
        { "id": "team", "kind": "oauth" }
      ]
    },
    "openai": {
      "strategy": "round-robin",
      "slots": [
        { "id": "key-a", "kind": "api_key" },
        { "id": "key-b", "kind": "api_key" }
      ]
    },
    "xai": { "strategy": "quota-first", "slots": [{ "id": "main", "kind": "oauth" }] },
    "cursor": { "strategy": "quota-first", "slots": [{ "id": "pro", "kind": "oauth" }] }
  },
  "fallback": ["anthropic", "openai-codex", "xai", "cursor"],
  "stickiness": "session-until-exhausted"
}
```

Secrets stay in the OS keychain or in `accounts.secrets.json` (`0600`), referenced by slot id. Do not put refresh tokens in the repo. `/accounts login anthropic` runs the official OAuth callbacks (`onAuth` / `onPrompt`) and writes a **new slot**, without clobbering the existing official `auth.json` primary if we can avoid it. Primary `/login` still works; our extension treats that primary as slot `default` of that provider.

### Balancer (ours)

Request path:

1. User selected model `anthropic/claude-opus-4-6` (official id).
2. Balancer picks a healthy slot in the `anthropic` pool.
3. `before_provider_headers` writes that slot’s `Authorization`.
4. `after_provider_response` reads status + `retry-after` + body.
5. On usage-limit / 429 / 402 / 403-quota: mark slot cooling until parsed reset (else default 5h window), pick the next healthy **sibling** with the same model + thinking level, retry.
6. Only if the whole family is cooling do we walk `fallback` (Anthropic → Codex → xAI → Cursor) and `pi.setModel` to the nearest equivalent on the next family.
7. If every pool is cooling, UI shows the earliest reset and the loop enters `NEEDS_HUMAN` or waits, depending on mode.

Selection strategy per pool:

- `quota-first` — ask the provider usage endpoint, pick the most remaining headroom. Use this for OAuth families that expose windows (Claude 5h/7d, Codex 5h/weekly, Cursor pools).
- `round-robin` — API-key families with no usage API. Still skip slots already cooling from a prior 429.
- `sticky` — keep the session on one slot so prompt cache survives, until that slot is exhausted, then release.

Lessons we take from Oh My Pi’s public bugs, then do the opposite:

- Do not keep routing to an exhausted sibling when a healthy one exists.
- Do not show one unlabeled aggregate “17% free” across three accounts. Show **per slot**.
- Apply usage-aware pick to API keys as well as OAuth. A 429 classifier is not enough if `/usage` already knew the window was dead.
- A 100% forecast is not a skip until that slot has actually refused this session, unless the usage API is authoritative.

### Cursor provider (ours, official API)

```ts
pi.registerProvider("cursor", {
  name: "Cursor",
  api: "openai-completions", // or streamSimple if Cursor’s AgentService is not OpenAI-shaped
  oauth: {
    name: "Cursor",
    login,
    refreshToken,
    getApiKey,
  },
  async refreshModels({ signal }) {
    // Cursor GetUsableModels (or documented successor)
    // Return whatever the subscription can see today.
  },
});
```

`refreshModels` is what makes a new Cursor model appear the next time `/model` or `pi update --models` runs. Ship a tiny fallback list only so `/model` is not empty before the first sync.

### Commands and UI

| Command | Action |
|---|---|
| `/accounts` | Overlay: every slot, remaining %, reset time, cooling, active marker |
| `/accounts login <provider>` | Add a slot. Does not delete existing slots |
| `/accounts logout <slot>` | Drop one slot |
| `/accounts status` | Footer-style dump |
| `/accounts next` | Force sibling |
| `/accounts pin <slot>` | Stick this session |
| `/pool strategy <provider> quota-first\|round-robin\|sticky` | |
| `/pool chain anthropic,openai-codex,xai,cursor` | Cross-family order |

Widget (always on, matches the control-board language):

```
ACCOUNTS
  ANTH  ● home  62% 5h   work  0% cd 1h14m
  OAI   plus 40%         team  88%
  XAI   main ok
  CUR   pro  12 models (live)
ROUTE   anthropic/claude-opus-4-6  via home
```

When a slot cools mid-loop the widget flips, an `accounts.failover` event hits the append log, and the model reply stays short: `switched anthropic/work → anthropic/home (5h window empty, reset 1h14m)`.

### What we will not do

- Install or wrap Oh My Pi.
- Fork Pi.
- Hard-code model ids for official providers.
- Put a second copy of Claude in `/model` named `anthropic-account-2/claude-…` that drifts from the official catalog. One model id, many slots underneath.
- Call community Cursor packages at runtime. Read them, then write ours.

### Anthropic subscriptions are first-class

Official Pi already exposes `/login` → **Anthropic (Claude Pro/Max)** as subscription OAuth (`isSubscription: true`). Atomic documents the same path. Oh My Pi stacks multiple of those seats. We do too.

`/accounts login anthropic` is a supported slot kind. Use the official OAuth callbacks. Keep the official Anthropic catalog. Extra seats live in our pool.

**Required warning — once per new Anthropic slot, and in the README:**

> Claude Pro/Max in this harness uses Anthropic’s subscription OAuth, same as Pi and Atomic.
> Anthropic’s own docs: third-party harness usage draws from **extra usage** and is billed per token, not against the in-app Claude plan bar.
> API keys (`ANTHROPIC_API_KEY`) are a separate pay-as-you-go path.
> You are responsible for the seats you attach.

Show it with `ctx.ui.confirm` before the OAuth window opens. Persist `warningAcceptedAt` on the slot so we do not nag every session. Do not block login. Do not pretend extra usage is the Max 5-hour in-app bar.

Same pattern for Cursor and ChatGPT Codex slots: short provider-specific billing note, confirm once, then proceed.

### Other limits

- Cursor subscriptions are sold only by Cursor. A first-party provider that speaks their OAuth and model list is an integration, not a resale.
- `before_provider_headers` can swap a bearer token. It cannot invent a provider Pi does not know how to stream. That is why Cursor needs `registerProvider` and possibly `streamSimple`.
- Catalog refresh for official providers is Pi’s job. Catalog refresh for Cursor is our `refreshModels`. Both must run; neither replaces the other.

```
.pi/APPEND_SYSTEM.md
.pi/graphs/coding-loop.json
.pi/kg/
.pi/runs/
.pi/context/{product,structure,tech}.md
AGENTS.md
specs/<feature>/{requirements,design,tasks}.md
```

---

## 6. Run contract (the file bridge)

Every job gets a stable id and a directory. This is Avid’s run layout, adapted to Pi.

```
.pi/runs/<job_id>/
  task.json            # goal, constraints, acceptance tests, nongoals
  context.md           # frozen context pack for this job
  candidate.json       # worker output, no job_id / round / model fingerprint in payload
  evidence.json        # commands run, exit codes, log excerpts, file hashes
  verdict.json         # PASS | REVISE | BLOCKED, blockingIssues[], evidence[]
  state.json           # DAG progress, attempts, readiness
  events.jsonl         # append-only hash chain
  fingerprints.json    # RFC 8785 canonical JSON → SHA-256 of semantic payloads
```

### Round vs retry

- **Retry:** same request, same round key, transient failure (timeout, 429, transport). Max 2, exponential backoff. Not a new round.
- **Round:** new verifier evidence. Caps at 3 by default. If `output_fingerprint` repeats, stop. No progress = stop.

### Atomic write rule

```
write  candidate.tmp
fsync
rename candidate.tmp → candidate.json
append one sanitized event
```

One writer per file. The control-plane extension is the only process that commits `state.json` and the knowledge graph. Graph workers write *candidates* and *proposed patches* into an inbox.

### JSON contracts (minimum fields)

**task.json**

```json
{
  "job_id": "2026-08-31-auth-refresh",
  "goal": "Refresh tokens expire and cannot be reused",
  "nongoals": ["SSO", "password reset UI"],
  "acceptance": [
    "expired refresh token returns 401",
    "reused refresh token is revoked",
    "unit + integration tests pass"
  ],
  "constraints": ["no schema dump", "no new dependencies without approval"],
  "quality_gates": ["pnpm test", "pnpm lint"]
}
```

**verdict.json**

```json
{
  "status": "REVISE",
  "blockingIssues": ["expired token accepted in src/auth/refresh.ts:81"],
  "nonBlockingIssues": ["log line missing request id"],
  "evidence": ["tests/auth.refresh.test.ts:44"],
  "round": 2,
  "output_fingerprint": "sha256:…"
}
```

**event record**

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

Event types: `handoff.created`, `tool.request`, `approval.result`, `tool.result`, `checkpoint`, `handoff.completed`, `recovery.started`, `recovery.completed`, `kg.patch.proposed`, `kg.patch.accepted`.

Never log tokens, cookies, raw secrets, or unredacted command output.

---

## 7. Dual-mode control law: gated vs autopilot

This is the change that makes the system a full agentic loop instead of a supervised assistant.

You give it either:

- a **task** (`/loop Add refresh-token rotation`), or
- a **plan** (`/loop --from specs/012-auth-refresh/` or `/loop --plan plan.md`)

and the graph runs. The human is no longer mandatory on every ship. The human is mandatory when the evidence is not good enough to stand in for one.

### 7.1 Two modes, one graph family

| Mode | When | Ship gate | pi-graph policy |
|---|---|---|---|
| **gated** (default) | Ambiguous AC, first time in a repo, irreversible external effect, or you asked for it | `human` node pauses; `/pig resume <id> true` | `allowNonInteractive: false` |
| **autopilot** | AC passed the quality bar, verifiers are wired, risk class is `repo-local` | Conditional edge skips the human node. `set` node writes `release.approved = true` from evidence | `allowNonInteractive: true`, `allowNonInteractiveMutations: true` |

pi-graph will **not** invent autopilot for you. A `human` node with no pre-supplied value always interrupts, even when `allowNonInteractive` is true. Autopilot is therefore a **different edge**, not a human node that magically says yes. Route around the human when the evidence contract holds; keep the human node on the other case. That is the documented way to skip humans: conditional edges, not a skipped interrupt.

### 7.2 Entry points

```
/loop <task>                  # start at specify (or plan, if AC already look executable)
/loop --plan <file-or-dir>    # skip specify; freeze the given plan as task.json + context.md
/loop --mode gated            # force human ship gate
/loop --mode autopilot        # request machine ship gate; refused if AC bar fails
/loop --until-green           # alias for autopilot on repo-local work
```

**Task entry.** `ac-compiler` node (isolated, read-only) reads the request and writes `task.json` with typed acceptance criteria. If the user only said “add auth”, the compiler either asks one clarifying question (gated) or refuses autopilot and falls back to gated specify.

**Plan entry.** A finished `requirements.md` / `design.md` / `tasks.md` (or a single plan file) is copied into the run store, hashed, and treated as frozen. The graph starts at `plan-check` (does this plan still match the repo?) then `implement`. It does not silently rewrite the plan unless a later verdict says the plan is wrong — then it goes to `replan` and, in autopilot, stops if the new plan would change acceptance criteria. AC changes are a mode violation; they require you.

### 7.3 Acceptance criteria quality bar (the thing that unlocks autopilot)

Autopilot is refused unless **every** criterion in `task.json` is executable. Soft language is a hard fail.

A criterion is executable only if it has all four:

1. **Observable** — a command, file assertion, or typed probe the tester node can run. Not “should feel fast.”
2. **Stated check** — exact command + expected outcome. `"pnpm test -- tests/auth.refresh.test.ts exits 0"`.
3. **Bound** — which files may change; which must not; which commands are the gates.
4. **Freshness** — the proof is bound to the current git tree hash. Stale receipts do not count.

Schema for each criterion:

```json
{
  "id": "AC-03",
  "statement": "Expired refresh tokens return 401",
  "check": {
    "kind": "command",
    "cmd": "pnpm test -- tests/auth.refresh.test.ts",
    "expect": { "exit": 0, "stdout_includes": ["expired", "401"] }
  },
  "bounds": {
    "write_allow": ["src/auth/**", "tests/auth.refresh.test.ts"],
    "write_deny": ["pnpm-lock.yaml", ".env", "infra/**"]
  },
  "required": true
}
```

Allowed `check.kind` values: `command`, `file_exists`, `file_absent`, `grep_empty`, `grep_matches`, `json_path`, `http_probe` (local only). Forbidden as autopilot checks: “code reviewed”, “looks clean”, “matches the spirit of the spec”, any criterion whose only evidence is an LLM paragraph.

The `ac-compiler` node outputs `ac.quality`:

- `executable` — every required AC has a check + bounds. Autopilot *may* be offered.
- `partial` — some AC are executable, some are not. Gated only. The compiler lists what is missing.
- `narrative` — the request is a vibe. Specify first, then you decide.

This is the 2026 “goal contract” / “proof-or-stop” rule: the doer does not get to declare done. A different node checks evidence the doer cannot edit after the fact. Lifecycle states (`tested`, `reviewed`, `DONE`) are claims until a fresh, source-bound receipt exists.

### 7.4 What autopilot is allowed to do

Repo-local work that the gates can see:

- edit files inside `write_allow`
- run allowlisted test / lint / typecheck commands
- create or update tests that encode the AC
- conventional-commit on a feature branch (`commit` allowlisted, `push` not)
- update the knowledge-graph inbox with proposed claims

### 7.5 What autopilot is never allowed to do

These stay human even when AC are perfect. Encode them as a second policy layer, not as a hope in the prompt:

- `git push`, force-push, rewrite of shared history
- deploy, publish, production migrate, spend, secret access
- delete outside the workset, `rm -rf`, chmod of credentials
- changing acceptance criteria mid-run
- expanding `write_allow` or installing a new runtime dependency
- any command not in the gate list or the safe-read prefix list

If the implementer *needs* one of those to finish, the graph emits `BLOCKED: needs-human` with the exact command and why. It does not invent a workaround.

### 7.6 Autonomous stop rules (stricter than gated)

Gated mode can afford to wait for you. Autopilot cannot. Terminal states are required:

| State | Meaning |
|---|---|
| `DONE` | All required AC receipts are fresh and green; isolated review `approved: true`; bounds held; fingerprint new |
| `BLOCKED` | A required AC is not executable, a gate is red after max rounds, or a forbidden action was requested |
| `EXHAUSTED` | `maxRounds`, `maxCostUsd`, `timeoutMs`, or `maxNodeRuns` hit |
| `NO_PROGRESS` | Same `output_fingerprint` twice, or two consecutive rounds with the same failing AC ids |
| `UNSAFE` | Policy hook denied a tool; worktree dirty outside bounds; secret-shaped file touched |
| `NEEDS_HUMAN` | AC changed, risk class left `repo-local`, or reviewer returned `approved: false` with an untestable issue |

“Keep going until it looks good” is not a stop rule. Autopilot that cannot prove `DONE` must stop, not guess.

### 7.7 Doer ≠ done-checker

In both modes:

- Implementer never writes `verdict.json` or `release.approved`.
- Tester runs the AC commands against the live tree and writes `evidence.json` bound to `git rev-parse HEAD`.
- Reviewer is isolated, read-only, different thread (and different model when possible). It inspects the diff + evidence + AC ids. It cannot run write tools. Its JSON is schema-validated.
- A deterministic `set` node, not a model, copies `release.approved = true` when `mode == autopilot AND test.passed AND review.approved AND bounds.held AND fingerprints.fresh`.
- If any of those are false, the edge goes back to implementer *or* to `NEEDS_HUMAN` / `NO_PROGRESS` per the stop table.

That is Avid’s “signal no model can argue with,” plus the Proof-or-Stop rule that agent output is a claim, not a lifecycle state.

---

## 7A. The default coding graph

Start from `@shying/pi-graph`’s official `coding-review.json` and extend it. That example already has isolated planner, threaded implementer, isolated reviewer, human approval, and conditional return-to-implementer. We add an **ac-compiler**, a **tester**, a **bounds-check** `set` node, and a **fork after review**: human in gated mode, deterministic `set` in autopilot.

```
          task ──► ac-compiler ──► specify? ──► plan ──► implement ──► test ──► bounds ──► review
          plan ──────────────────────────────────┘         ▲            │        │         │
                                                           └────────────┴────────┴─────────┤
                                                             REVISE / red / bounds-fail    │
                                                                                           ▼
                                                                              ┌─ gated ──► human ──► ship
                                                                              └─ auto ───► release.set ──► ship
```

Node policy:

| Node | Context | Tools | Model bias | Output |
|---|---|---|---|---|
| ac-compiler | isolated, read-only | read, grep, find, ls | strong | `task.json` + `ac.quality` |
| specify | isolated, read-only | read, grep, find, ls | strong | `specs/<id>/requirements.md` |
| plan | isolated, read-only | read, grep, find, ls | strong | `plan` JSON + `design.md` + `tasks.md` |
| implement | thread `coder` | read, grep, find, ls, bash, edit, write | fast | `implementation` report |
| test | isolated | read, bash (AC commands only) | cheap | `evidence.json` bound to HEAD |
| bounds | `set` | none | deterministic | `bounds.held` |
| review | isolated, read-only | read, grep, find, ls | strong, different from implementer | `verdict.json` (schema-validated) |
| human | pause | none | you | `release.approved` (gated only) |
| release.set | `set` | none | deterministic | `release.approved = true` iff evidence contract holds |
| ship | set / narrow bash | git commit on feature branch; never push | deterministic | completion marker |

Conditional edges:

- `ac.quality != executable` AND requested mode is autopilot → refuse autopilot, continue as gated (or `__end__` with `NEEDS_HUMAN` if `--mode autopilot` was forced).
- `test.passed == false` → implement (attach failing output). New round only if evidence changed.
- `bounds.held == false` → `UNSAFE` / `__end__` (do not keep looping; the workset was violated).
- `review.approved == false` and issues are testable → implement.
- `review.approved == false` and issues are untestable → `NEEDS_HUMAN`.
- gated + review passed → human node.
- autopilot + review passed + bounds held + receipts fresh → `release.set` → ship.
- `release.approved == false` → implement or `__end__` if aborted.
- `round >= maxRounds` → `__end__` `EXHAUSTED`.
- `output_fingerprint` repeats → `__end__` `NO_PROGRESS`.

Two graph files, not one file with a prayer:

- `.pi/graphs/coding-loop.gated.json` — human node present, `allowNonInteractive: false`
- `.pi/graphs/coding-loop.auto.json` — no human node on the happy path, `allowNonInteractive: true`, `allowNonInteractiveMutations: true`, `confirmMutatingNodes: false` only after the repo has been trusted and the policy file allowlists repo-local commits

`/loop --mode autopilot` refuses to load the auto graph unless `ac.quality == executable`. The control plane picks the file; the model does not.

Graph limits (starting point):

```json
"limits": {
  "maxSteps": 12,
  "maxNodeRuns": 16,
  "maxConcurrency": 2,
  "maxCostUsd": 5,
  "timeoutMs": 1800000
},
"policy": {
  "allowNonInteractive": false,
  "allowNonInteractiveMutations": false,
  "confirmProjectGraph": true,
  "confirmMutatingNodes": true
}
```

Do not raise concurrency until the single-worker loop is stable. That is both Avid’s rule and pi-graph’s own guidance: simple tasks stay on one Pi loop; graphs exist for parallel work, independent reviewers, persistent role memory, or human gates.

---

## 8. Knowledge graph (source-backed claims)

Pi has no native KG. Build the file-backed graph Avid specifies. Keep JSONL as source of truth.

```
.pi/kg/
  nodes.jsonl
  edges.jsonl
  sources.jsonl
  inbox/                 # proposed patches from workers
  snapshots/<ts>/        # immutable snapshots before each merge
```

Minimum fields:

- `id`, `kind`, `source_ids`, `status` (`proposed|verified|rejected|superseded`), `rev`, `observed_at`
- `confidence` only on inferred relations
- optional `valid_from` / `valid_to`

One writer: the control-plane extension (or a dedicated Knowledge Steward skill invoked by that extension). Workers drop patches in `inbox/`. Accepted patches append to the JSONL logs and bump `rev`.

Optional human view: generate one Markdown page per node with YAML frontmatter and `[[wikilinks]]`. Do not treat the Markdown as authoritative.

This KG is for *working claims* (“refresh tokens must be single-use — source: RFC 6819 §5.2.2.3 + our threat model §4”). It is not the code-structure graph. For that, add Graphify or `pi-codegraph` so the planner can ask “what calls `chargeCustomer`?” instead of grepping half the repo.

Connect them:

- Code graph answers structure.
- Claim graph stores decisions and evidence.
- DAG consumes both and writes artifacts.

---

## 9. Context pack (stop the drift)

Do not rely on conversation memory. Pi’s own design agrees: keep the system prompt tiny and put durable instructions in files.

### Layers (in load order)

1. **Global personality / brevity** — `~/.pi/agent/APPEND_SYSTEM.md`
2. **Global operator rules** — `~/.pi/agent/AGENTS.md`
3. **Project constitution** — `AGENTS.md` at repo root (always loaded; trust not required)
4. **Project override** — `AGENTS.override.md` when a subtree needs different rules
5. **Steering pack** — `.pi/context/product.md`, `structure.md`, `tech.md` (Kiro-style split; load via skill, not dumped into every prompt)
6. **Run pack** — `.pi/runs/<id>/context.md`, frozen at job start
7. **Skills** — only the skill whose description matches the current node

Keep `AGENTS.md` under ~200–400 lines. Imperative. Exact commands. Negative examples. Definition of Done. No essays.

### Project `AGENTS.md` skeleton

```markdown
# AGENTS.md

## Product
<one paragraph>

## Setup
- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`

## Quality gates (task is not done until all pass)
- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`

## Conventions
- TypeScript strict. No `any` without a comment that names the boundary.
- No new dependencies without human approval.
- Conventional Commits.

## Do not
- Commit secrets, force-push main, run production migrations, or push.
- Rewrite unrelated files to "clean up" while implementing a task.
- Claim done without pasting the gate command output into evidence.json.

## Loop protocol
- Spec before code on anything larger than a one-line fix.
- Tests before or with the implementation, never after as theatre.
- Isolated reviewer. Human gate before commit.

## Voice
- Short answers. Facts, paths, commands, next action.
- No preamble, no cheerleading, no restating the task.
```

### `APPEND_SYSTEM.md` (keep default Pi prompt; add the operating law)

Do **not** use `SYSTEM.md` unless you intend to replace Pi’s instruction template. `APPEND_SYSTEM.md` is the correct lever: it keeps skills, context files, and generated tool rules.

Contents, in this order:

1. You are the outer-loop operator for a graph-engineered coding system.
2. Response style: concise, specific, no filler.
3. Never claim completion without verification you ran and read.
4. Irreversible actions require an explicit human yes.
5. Prefer reading the context pack and run files over guessing.
6. When a skill matches, load it. Do not improvise a parallel method.

---

## 10. Best-practice primitives baked into the path

These are not optional docs the user might remember. They are nodes, skills, and slash commands that fire because the graph and the skill descriptions say so.

### 10.1 Spec-driven development

2026 consensus (GitHub Spec Kit, Kiro, Addy Osmani, Anthropic AI-native SDLC): the spec is the artifact of record; implementations are disposable.

For any task that is not a one-line fix, `/specify` or the `specify` node writes:

```
specs/<nnn>-<slug>/
  requirements.md     # user stories + acceptance criteria
  design.md           # architecture, data, APIs, nongoals
  tasks.md            # ordered, independently verifiable steps
```

A second isolated pass attacks the spec: contradictions, untestable claims, hidden dependencies. Only then does `plan` run.

### 10.2 TDD as a node contract, not a slogan

Implementer instructions:

1. Write or update the failing test that encodes one acceptance criterion.
2. Show the red output in `evidence.json`.
3. Write the minimum code to go green.
4. Refactor only after green.
5. Do not edit the test to make a bad implementation pass.

Reviewer re-runs the gates itself. That is the longgraph-skill insight: the supervisor must not trust the executor’s word that tests passed.

### 10.3 Quality gates

Exact commands live in `AGENTS.md`. The `test` node runs them. `verdict.json` may not be `PASS` if any gate is red. Models do not get to narrate around a failed command.

### 10.4 Isolated reviewer

Different context mode (`isolated`), read-only tools, structured JSON verdict, optionally a stronger or different model. Never the same thread as the implementer. This is the whole point of graph engineering versus one looping agent grading itself.

### 10.5 Human gate

`pi-graph` `human` node, `pause: true`, `kind: confirm`. Also a `tool_call` hook in the control plane that blocks:

- `git push`, `git reset --hard`, `git checkout --theirs`
- `rm -rf`, `chmod 777`, production deploy, package publish
- any command matching a deny list in `.pi/policy.json`

Grok Bot’s rule applies here too: Require Approval beats Always Allow. Auto-review is not least privilege.

### 10.6 Git hygiene

`conventional-commit` skill. Ship node proposes the commit message; human confirms. No force-push, no amending shared history, no committing `.env`.

### 10.7 Definition of Done (printed into every `task.json`)

- Acceptance criteria mapped to tests
- Quality gates green, output stored in `evidence.json`
- Isolated review `approved: true` or explicit human override recorded
- KG claims updated if a decision was made
- Human yes for commit
- Assistant reply is the verdict, not a diary

### 10.8 Small diffs, one workset

Avid / longgraph: related siblings with one claim, one write set, and one gate form one workset. The implementer does not “while I’m here” rewrite the module.

---

## 11. Two policy layers

### Outer layer (control plane + human)

Implemented in `extensions/policy.ts` on `tool_call`:

- Classify the tool call: read / write-repo / write-git / network / destructive / unknown.
- Read / allowlisted checks: auto.
- Write-repo inside an active implementer node, inside `write_allow`: auto, logged.
- Write outside `write_allow`: deny, `UNSAFE`.
- Git commit on the job’s feature branch: confirm in gated mode; auto in autopilot only after `release.approved` is already true from evidence.
- Network, install, deploy, delete, push: confirm, default no. Never auto.
- Unknown: confirm in gated; deny in autopilot.

Also: `pi-graph` `policy.confirmMutatingNodes: true` and `allowNonInteractiveMutations: false`.

### Inner layer (per node)

Copied from the official coding-review graph:

- Planner / specifier / reviewer: `readOnly: true`, tools `read, grep, find, ls`.
- Tester: `bash` but only the gate commands from `AGENTS.md`.
- Implementer: full edit tools, thread memory, still cannot push.
- Print mode / CI: a dedicated read-only profile. Never `pi -p` a write agent.

Pi has no built-in sandbox. For unattended or untrusted repos, run the whole process in Docker / Gondolin / OpenShell as documented. `readOnly` is an allowlist, not an OS boundary. pi-graph says this explicitly.

---

## 12. UI / theme plan (look like the screenshots)

### Theme tokens

Two themes, both dark industrial.

**loop-amber** — screenshot 1

- background implied black
- `accent` / `borderAccent` / `toolTitle`: `#ff6a1a`
- `success`: `#3dff6a`
- `error`: `#ff3b3b`
- `warning`: `#ffb020`
- `muted` / `dim`: dark gray
- `toolPendingBg`: near-black warm
- `mdHeading`: amber
- thinking levels climb amber → red

**protocol-blue** — screenshot 2

- `accent`: `#3da9fc`
- human-gate / outlined elements use `borderAccent`
- gray for prepare stages, blue for active handoff

Default to `loop-amber`. Switch to `protocol-blue` while a human node is paused so the “outlined gate” language is literal.

### Widgets and renderers

Using official APIs (`setWidget`, `setStatus`, `setFooter`, `registerEntryRenderer`, `registerMessageRenderer`, overlays):

1. **Context-layer widget** (above editor, always on during a job): the five memory buckets and whether each is loaded.
2. **Pipeline widget**: stages 01–08 with the current one highlighted.
3. **Run-files widget**: the six filenames, existing vs missing, last write time.
4. **Stop box** in the footer: DONE / BLOCKED / APPROVAL / ROUND n.
5. **Custom entries** for protocol events so the transcript reads like a flight recorder, not a chat.
6. **Overlay** on `/loop status` or `/pig inspect`: full board, generated from `state.json` + `events.jsonl`, not from model prose.
7. **Mermaid** of the live DAG via `/pig visualize` plus a local renderer that uses the current node as the accent.

The model is forbidden from drawing the board in ASCII. The extension draws the board. The model talks.

---

## 13. Commands the user actually types

| Command | Action |
|---|---|
| `/specify [goal]` | Create spec files, freeze a job, do not touch code |
| `/plan [goal]` | Isolated planner, writes plan + tasks |
| `/loop [goal]` | Start gated coding-loop from a task |
| `/loop --plan <path>` | Start from a finished plan; skip specify |
| `/loop --mode autopilot [goal]` | Request machine ship gate; refused unless AC are executable |
| `/loop --until-green` | Alias for autopilot on repo-local work |
| `/loop status` | Overlay of the board (works while you are away) |
| `/loop stop` | Hard stop, write `BLOCKED` |
| `/implement` | Run only the implementer node against current task |
| `/review` | Isolated reviewer |
| `/verify` | Run quality gates, write evidence.json bound to HEAD |
| `/ship` | Gated: human confirm → commit. Autopilot: already committed if `DONE` |
| `/kg query …` | Query claims |
| `/kg propose …` | Drop a patch in inbox |
| `/pig list\|run\|resume\|inspect\|visualize` | pi-graph native |
| `/skill:tdd-cycle` | Force the TDD skill into context |

Tab-complete via Pi’s prompt-template `argument-hint`.

---

## 14. Concise LLM responses (enforced, not hoped)

Three stacked controls, because one is never enough:

1. **`APPEND_SYSTEM.md`** — “Answers are short. Lead with the state change. Paths and commands, not essays. No preamble.”
2. **`concise-output` skill** — description: “Use whenever writing to the user. One screen or less. Verdict, evidence, next action.”
3. **Control plane** — after `agent_end`, if the last assistant message exceeds ~800 characters *and* a structured verdict exists, the widget already shows the board; the extension can notify “trim: board has the state.” Do not silently rewrite model text in production v1; teach the model. Revisit a renderer-side collapse in v2 if needed.

Hide thinking blocks for day-to-day use (`hideThinkingBlock: true`) so the user sees protocol, not chain-of-thought.

---

## 15. Implementation plan (phased)

### Phase 0 — Baseline Pi, one hour

- Install Pi. Authenticate. Trust the project.
- Add repo `AGENTS.md` and `~/.pi/agent/APPEND_SYSTEM.md`.
- Confirm `/model`, tests, and `pi "summarize this repo and how to run checks"` works.
- Do not install graphs yet. Prove the single-agent loop first. Official Pi and official pi-graph both insist on this.

### Phase 1 — Context pack + voice, half day

- Drop `templates/AGENTS.md`, `APPEND_SYSTEM.md`, `.pi/context/*`.
- Install `concise-output` and `quality-gates` skills.
- Theme `loop-amber`.
- Success: answers are short, gates are named, theme matches the board.

### Phase 2 — Run store + append log, one day

- Extension: create `job_id`, write the six run files, atomic rename, hash chain.
- Commands: `/loop status` reads files, does not ask the model.
- Hook `tool_call` / `tool_result` / `agent_end` into `events.jsonl`.
- Success: a manual three-step job leaves a complete, inspectable run directory.

### Phase 3 — Policy gate, half day

- Deny list + confirm dialogs for irreversible tools.
- Implementer can edit; nobody pushes.
- Success: `git push` and `rm -rf` pause for you.

### Phase 4 — Compose pi-graph, one day

- `pi install npm:@shying/pi-graph`
- Adapt `coding-review.json` → `coding-loop.gated.json` with `ac-compiler`, `test`, `bounds`, fingerprint stop rule, human ship gate.
- Wire `/loop` and `/loop --plan` to `pi_graph_run`.
- Human node uses Pi’s `ctx.ui.confirm`.
- Success: a real small change goes plan → implement → test → review → your yes → commit.

### Phase 4b — Autopilot graph, one day

- Second file: `coding-loop.auto.json`. No human node on the happy path. `release.set` is a deterministic `set` node.
- `ac-compiler` quality bar implemented and tested with fixtures: narrative / partial / executable.
- Autopilot refused unless every required AC has `check` + `bounds`.
- Policy: repo-local commit allowed; push/deploy/delete still denied by the `tool_call` hook.
- Success: `/loop --mode autopilot` on a fixture repo with five executable AC reaches `DONE`, writes a conventional commit, and leaves a complete evidence bundle. A second fixture with “make it better” is refused and falls back to gated. A third fixture that edits outside `write_allow` ends `UNSAFE`, not `DONE`.

### Phase 5 — Spec and TDD primitives, one day

- Skills + prompt templates + `spec-first.json` graph.
- Implementer skill refuses to write production code before a failing test on non-trivial work.
- Success: `/specify` produces the three spec files; implementer attaches red then green output.

### Phase 6 — Knowledge graph, one to two days

- `kg_*` tools, JSONL store, inbox, one writer, snapshot-before-merge.
- Planner reads verified claims. Reviewer may propose new ones.
- Optional Obsidian-style Markdown projection.
- Success: a decision made in review is a verified node with `source_ids`, not a sentence in chat.

### Phase 7 — Board UI, one day

- Widgets, footer stop-box, custom event renderers, `/loop status` overlay.
- Theme switch to `protocol-blue` while a human node is paused.
- Success: you can glance at the terminal and know stage, round, gate, and which run file last changed — without reading the model.

### Phase 8 — Code intelligence (optional)

- Graphify or `pi-codegraph` for callers/callees/impact.
- Planner skill: “ask the code graph before dumping files into context.”

### Phase 9 — Harden

- Docker / Gondolin path documented for unattended runs.
- Read-only print profile for CI.
- Recover-from-checkpoint drill: kill mid-implementer, `/pig resume`, reconcile.
- Anchor `events.jsonl` head outside the workspace if you care about tamper evidence. A hash chain detects later edits; it does not stop the same OS user.

Do not add swarms, 128-way fan-out, or “the model said it was fine” auto-review until Phase 4 is boringly reliable. Do not turn on autopilot until Phase 4b’s three fixtures pass.

---

## 16. Suggested models

Pi talks to 15+ providers. Assign by node, not by vibe.

| Node | Want | Why |
|---|---|---|
| specify / plan / review | strongest available | architecture, contradiction-finding, judgment |
| implement | fast, cheap, good at diffs | one workset at a time |
| test | cheapest that can run tools | it mostly shells out |
| titles / routing | cheap | not user-visible quality |

Keep planner and reviewer on a different model than implementer when budget allows. Same-model self-review is how loops flatter themselves.

---

## 17. Risks and limits (from the primary sources)

- **Pi is not sandboxed.** Project trust only stops a repo from loading its own extensions before you say yes. Prompt injection from files is expected. Isolation is OS/container.
- **pi-graph checkpoints are at-least-once.** External effects need idempotency keys. A missing result is retried only when the provider accepts the same key; otherwise stop for you.
- **Nested harness gap, translated.** Approving `/loop` does not approve every tool call inside an implementer node. The inner allowlist and the outer `tool_call` hook both have to exist.
- **Do not mix writers** on `kg/*.jsonl` or `state.json`.
- **Do not use `SYSTEM.md` casually.** It replaces the instruction template. Prefer `APPEND_SYSTEM.md`.
- **Do not run write-capable agents via `pi -p`.** Print mode is for bounded, schema-checked, read-mostly passes.
- **Skills and extensions run with your user’s power.** Review package source before `pi install`.
- **A graph will not save a missing spec or a missing test.** It will only make the failure inspectable.

---

## 18. Definition of done for the setup itself

The custom Pi setup is done when:

1. A new project can be bootstrapped with the package + templates in one install.
2. Typing a feature request starts specify → plan → implement → test → review → (human | machine release), not a raw coding dump.
2b. `/loop --plan <path>` skips specify and runs the same gates against a frozen plan.
2c. `/loop --mode autopilot` reaches `DONE` without you when AC are executable, and **refuses** autopilot when they are not.
3. The six run files exist for every job and the event log hash-chains.
4. The TUI shows stage, round, gate, and files without asking the model.
5. Assistant replies stay short; the board carries the state.
6. Quality gates are real commands whose output is stored.
7. Irreversible *external* actions cannot complete without a human node or confirm dialog. Repo-local commit may be automatic only after fresh AC receipts, isolated review, and bounds check.
8. Claims that survive a review are in the knowledge graph with sources.
9. Killing the process mid-run leaves a resume path.
10. You can explain every edge in `coding-loop.json` without waving at “the agent will figure it out.”

---

## 19. Research base

### Primary — the post and its author

- Avid, “A-Z blueprint for mastering loop and graph engineering using Grok bot”, 26 Aug 2026.
- Avid, “graph engineering explained (builder’s edition)”, 10 Aug 2026: nodes, edges, state, checkpoints, gates; the plan-build-grade-verify-ship coding graph.
- The article’s own product-boundary section: no native Grokbot↔Kimi handoff, no native KG in Grokbot, no arbitrary DAG in Kimi; file bridge is a *proposed* pattern. We treat Pi the same way.

### Primary — Pi

- [pi.dev/docs](https://pi.dev/docs) index, Quickstart, Using Pi, Extensions, Skills, Prompt templates, Themes, Packages, Settings, Security, TUI, SDK.
- Extension events and UI: `tool_call`, `setWidget`, `setStatus`, `setFooter`, custom components, overlays.
- Security: trust ≠ sandbox; containerization patterns (Gondolin, Docker, OpenShell).
- System prompt files: `.pi/SYSTEM.md` replaces the instruction template; `.pi/APPEND_SYSTEM.md` appends and keeps skills/context.

### Primary — graph runtime on Pi

- [huang-sh/pi-graph](https://github.com/huang-sh/pi-graph): schema v2, agent/set/human nodes, isolated/thread/shared context, reducers, human pause, `/pig *`, official `coding-review.json`.

### Adjacent — code graphs for Pi

- Graphify + Pi; `@vndv/pi-codegraph` (tree-sitter index, callers/callees/impact as native tools).

### Primary — 2026 software-engineering practice for agents

- Spec-driven development as the default for non-trivial work (GitHub Spec Kit, AWS Kiro, Osmani, Anthropic AI-native SDLC).
- `AGENTS.md` as the agent README: exact commands, negative examples, ≤ ~500 lines, updated in the same PR as the convention.
- TDD with agents: red output is part of the evidence; tests-after is a known failure mode.
- Spec + TDD together: spec is the contract, tests are the proof.
- Human-in-the-loop reserved for irreversible *external* acts and for any AC that is not executable. Automated review is layered and never writes `DONE` by itself. Proof-or-Stop / goal-contract: the doer does not grade itself; receipts are bound to the current tree.
- Context engineering: constitution is persistent; spec is task-scoped; skills load on demand so the always-on prompt stays small. That last point is also why Pi exists.

---

## 20. First commands after you accept this plan

```bash
# 0. Pi
curl -fsSL https://pi.dev/install.sh | sh
cd <your-project>
pi          # /login, /trust

# 1. Compose, do not fork
pi install -l npm:@shying/pi-graph
pi install -l ./pi-loopgraph     # once the package in §5 exists

# 2. Theme + rules
# copy templates/AGENTS.md → ./AGENTS.md
# copy templates/APPEND_SYSTEM.md → .pi/APPEND_SYSTEM.md
# /settings → theme loop-amber

# 3. Prove the protocol on a safe change (gated first)
/specify Add a healthcheck endpoint that returns { ok: true }
/loop
# watch the board, not the prose

# 4. Same change, autopilot, only after AC are executable
/loop --mode autopilot Add a healthcheck endpoint that returns { ok: true }. AC: curl -s localhost:3000/health exits 0 and body equals {"ok":true}; pnpm test exits 0; no files outside src/health.ts and tests/health.test.ts change.
```

Start with one read-mostly task. Then one gated write with tests. Then the same write in autopilot against a fixture. Raise concurrency last.

That is how Pi becomes the control system in the screenshots without pretending it is Grok Bot, Kimi Code, or a swarm — and without pretending “no human” means “no proof.”
