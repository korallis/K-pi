# K-π (`kpi`)

**K-π is a standalone terminal coding agent — a maintained fork of [Pi](https://github.com/earendil-works/pi), not a plugin for it.**

This repository is the whole harness: TUI, agent loop, providers, sessions, tools, RPC. On top of that base, K-π compiles in its own gated or autonomous engineering loop — specify, research, plan, implement, test, bounds, isolated review, and one local ship commit.

You do not install Pi. There is no `pi install`, no peer dependency, and no Pi package to trust. You install `@korallis/k-pi`, or build this repository, and run `kpi`.

| | |
|---|---|
| Executable | `kpi` (alias `k-pi`) |
| Project config | `.kpi/` |
| User config and secrets | `~/.kpi/agent/` |
| Environment overrides | `KPI_CODING_AGENT_DIR`, `KPI_CODING_AGENT_SESSION_DIR` |
| Upstream base | Pi `v0.84.4`, commit `b79e4cc834970cca69daebffab7df1da7d1e52c4` |
| Upstream remote | `upstream` → `https://github.com/earendil-works/pi.git` |
| Licence | MIT — see [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), [`UPSTREAM.md`](UPSTREAM.md) |

## Install

```sh
npm install -g @korallis/k-pi     # then run: kpi
bun add -g @korallis/k-pi         # then run: kpi
```

Without installing anything:

```sh
npx @korallis/k-pi
bunx @korallis/k-pi
```

`@korallis/k-pi` is the only published package. It carries the built CLI plus K-π's
own runtime resources, and it is cut from a `v<version>` tag. To build from source
instead, follow [§2 Clone, install, build](#2-clone-install-build).

Everything in the operator manual below was run against the built binary from this
repository. Where a command's output is quoted, that is the text it printed.

---

# Operator manual

## 1. Prerequisites

- Node 22.19 or newer. Both `package.json` files declare `"node": ">=22.19.0"`.
  This manual was produced on Node v26.7.0.
- `git`, and `npm` (the repository uses npm workspaces).
- A terminal that supports 24-bit colour if you want the amber and protocol-blue
  boards to look right. K-π sends truecolor escapes; without them the board still
  carries every field, just without the colour.
- `python3` only if you intend to run the PTY-based UAT rows under `uat/`.

## 2. Clone, install, build

```sh
git clone https://github.com/korallis/K-pi.git
cd K-pi
npm ci                 # or: npm install
npm run build          # or: npm run build:offline, which skips the model-data fetch
```

`npm run build:offline` prints, on success:

```text
Built packages/coding-agent/dist/bundle (48 files, 7.4 MiB)
```

The binary lands at:

```text
packages/coding-agent/dist/bundle/cli.js
```

Run it directly:

```sh
node packages/coding-agent/dist/bundle/cli.js
```

Or put `kpi` and `k-pi` on your `PATH`. The `bin` map in
`packages/coding-agent/package.json` declares both names against that one file:

```sh
npm link --workspace @earendil-works/pi-coding-agent
kpi
```

To run from source without building, use `./kpi-test.sh` (`kpi-test.ps1` or
`kpi-test.bat` on Windows).

`kpi --version` prints the version alone; `kpi --help` prints the full flag list.

## 3. First launch

On a first launch in a clean home directory, with no provider configured, the
footer and a warning are what you get:

```text
K-π  >  ⬡ unknown  >  ● off  >  📁 proj  >  ⎇ main  >  ▦ —  >  $0.00
Warning: No models available. Use /login to log into a provider via OAuth or API key. See:
  .../packages/coding-agent/docs/providers.md
  .../packages/coding-agent/docs/models.md
```

The key hints on the second line are:

```text
escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
```

`ctrl+o` expands the startup report. On a fresh install it lists the loaded
resources — and this is how you confirm K-π registered itself with no install
step:

```text
[Context]
  ~/.kpi/agent/APPEND_SYSTEM.md
[Skills]
  architect, arena, blast-radius, bro, concise-output, context-pack, ... why
[Prompts]
  /implement, /plan, /review, /ship, /specify, /verify
[Extensions]
  <inline:k-pi>
[Themes]
  loop-amber, protocol-blue
```

`<inline:k-pi>` is the built-in control plane. There is no install command and no
trust decision for it.

### The untrusted-project first run

Project trust governs *your repository's* resources, never K-π itself. A project
is trust-requiring when `.kpi/` contains any of `settings.json`, `extensions`,
`skills`, `prompts`, `themes`, `SYSTEM.md` or `APPEND_SYSTEM.md`. Open such a
project and K-π asks before loading any of it:

```text
Trust project folder?
/path/to/your/project
This allows kpi to load .kpi settings and resources, install missing project packages, and execute project extensions.
→ Trust
  Trust parent folder (/path/to)
  Trust (this session only)
  Do not trust
  Do not trust (this session only)
↑↓ navigate  enter select  escape/ctrl+c cancel
```

A project with no `.kpi/` resources never shows this. `--approve` trusts for one
run; `--no-approve` ignores project-local files for one run.

## 4. The config directory

User configuration lives in `~/.kpi/agent/`. `KPI_CODING_AGENT_DIR` overrides the
whole directory; `KPI_CODING_AGENT_SESSION_DIR` overrides only session storage.
Point `KPI_CODING_AGENT_DIR` at a scratch path whenever you want to try something
without touching your real setup — every example in this manual was run that way.

A first launch creates:

| Path | What it is |
|---|---|
| `auth.json` | provider credentials, mode `0600`, starts as `{}` |
| `APPEND_SYSTEM.md` | K-π's concise-output system prompt, installed on first run |
| `models-store.json` | cached model catalogue |
| `sessions/<project-slug>/` | session transcripts, one directory per project path |

Added by later commands:

| Path | Written by |
|---|---|
| `accounts.json` | `/accounts login` — pools, slots, fallback chain, stickiness |
| `accounts.secrets.json` | slot credentials and research keys, mode `0600` |
| `settings.json` | harness settings, including the active `theme` |
| `<pool>-models.json` | local pool model lists, for example `local-openai-models.json` |

Never commit `accounts.secrets.json` or `auth.json`.

## 5. Signing in

Two surfaces. `/login` is the base harness's provider login. `/accounts login` is
K-π's pooled login, which adds a *slot* to a *pool* without replacing its
siblings — that is what lets you stack several subscriptions of the same family.

### `/login`

`/login` first asks which kind of credential:

```text
Select authentication method:
→ Sign in with an account
  Sign in with an API key
```

"Sign in with an account" offers the eight providers that support subscription
OAuth, each marked with its current state:

```text
Anthropic • unconfigured
Cursor • unconfigured
GitHub Copilot • unconfigured
Kimi For Coding • unconfigured
OpenAI Codex • unconfigured
OpenRouter • unconfigured
Radius • unconfigured
xAI • unconfigured
```

"Sign in with an API key" offers 43 providers, paged (`1/43`), beginning Amazon
Bedrock, Ant Ling, Anthropic, Azure OpenAI, Baseten, Cerebras, Cloudflare AI
Gateway, Cloudflare Workers AI.

### `/accounts login <pool> [slot]`

Valid pool ids are `anthropic`, `openai`, `openai-codex`, `xai`, `zai`,
`zai-coding-cn`, `kimi-coding`, `cursor`, and the local pools `llama`, `ollama`,
`lmstudio`, `local-openai`. The slot name is yours: `home`, `work`, anything
matching a lowercase identifier.

**Anthropic** shows the extra-usage confirmation before OAuth, and will not
proceed until you answer:

```text
Anthropic extra-usage warning
Claude Pro/Max in this harness uses Anthropic's subscription OAuth, same as Pi and Atomic.
Anthropic's own docs: third-party harness usage draws from extra usage and is billed per token, not against the in-app Claude plan bar.
API keys (ANTHROPIC_API_KEY) are a separate pay-as-you-go path.
You are responsible for the seats you attach.
Continue?
→ Yes
  No
```

**z.ai** is an API key, with a personal-use note first:

```text
z.ai Coding Plan is personal-use and official-tool-only; K-π routes it through Pi's supported zai provider.
Z.AI API key
>
enter submit  escape/ctrl+c cancel
```

**Kimi For Coding** is a device OAuth flow, not a key. `/accounts login
kimi-coding work` prints a URL and a code for you to approve in a browser:

```text
https://www.kimi.com/code/authorize_device?user_code=XXXX-0000
Code: XXXX-0000
```

Note that login reaches the network even under `--offline`: that flag disables
*startup* network operations, not an explicit sign-in you asked for.

### Local pools

Local pools hold no credential. `/accounts login <pool> [slot]` asks for an
origin, pre-filled with the default where one exists:

```text
Base URL for ollama
>
enter submit  escape/ctrl+c cancel
```

| Pool | Default base URL | Submit empty? |
|---|---|---|
| `ollama` | `http://127.0.0.1:11434/v1` | yes, takes the default |
| `lmstudio` | `http://127.0.0.1:1234/v1` | yes, takes the default |
| `local-openai` | none | no — errors |
| `llama` | none | no — errors |

Accepting the ollama default prints:

```text
Added local account ollama/home on http://127.0.0.1:11434/v1
```

A pool with no default has nothing to fall back on:

```text
Error: K-π accounts: llama needs a base URL
```

For llama.cpp, the router's own default is `http://127.0.0.1:8080` and it honours
`LLAMA_BASE_URL`; see [`packages/coding-agent/docs/llama-cpp.md`](packages/coding-agent/docs/llama-cpp.md).
`local-openai` is the escape hatch for any other OpenAI-compatible server: it has
no default precisely so that K-π never guesses an origin for you.

After adding a local slot, `accounts.json` looks like this — note the default
fallback chain and stickiness, which are written for you:

```json
{
  "version": 1,
  "pools": {
    "ollama": {
      "strategy": "round-robin",
      "slots": [{ "id": "home", "kind": "local", "label": "home", "baseUrl": "http://127.0.0.1:11434/v1" }]
    }
  },
  "fallback": ["anthropic", "openai-codex", "xai", "zai", "kimi-coding", "cursor"],
  "stickiness": "session-until-exhausted"
}
```

A new local pool defaults to `round-robin`; a new cloud pool defaults to
`quota-first`.

## 6. Inspecting and steering accounts

| Command | Effect |
|---|---|
| `/accounts` or `/accounts list` | list every `pool/slot  kind  label` |
| `/accounts login <pool> [slot]` | add or replace one slot |
| `/accounts logout <pool>/<slot>` | remove one slot |
| `/accounts logout exa` / `perplexity` | remove a research credential |
| `/accounts pin <pool>/<slot>` | pin this session to one slot |
| `/accounts next` | advance past the pinned slot |
| `/pool strategy <pool> <quota-first\|round-robin\|sticky>` | set a pool's strategy |
| `/pool chain a,b,c` | set the fallback chain |

`/pool` with no arguments prints its own grammar:

```text
K-π pool: Usage: /pool strategy <provider> <name> | /pool chain a,b,c
```

An unknown subcommand is rejected by name, not silently ignored:

```text
K-π accounts: Unknown /accounts command: wat
```

`/accounts next` with no traffic yet has nothing to advance:

```text
No active route to advance; run a turn first
```

Once a slot has served a request, the accounts widget appears above the footer:

```text
ACCOUNTS
  LOCAL-OPENAI  home (local) $0
ROUTE   local-openai/uat-stub  via home
```

A `local` slot shows `(local) $0` and never a quota percentage. A slot whose
quota is not yet known shows `?%`. When a provider refuses with a 429 or a quota
error, the slot is cooled and the widget appends the wait — `home ?% cd 60m` is a
slot cooling for sixty more minutes, rounded up from the deadline the provider
itself stated — and the route moves to a healthy sibling.

## 7. Models and K-stack roles

`/model` selects a model interactively; `--model <pattern>` and `--models
<patterns>` set and cycle them from the command line. `kpi --list-models` prints
what is available. Official catalogues are never frozen; refresh them with:

```sh
kpi update --models
```

`/setup-kstack` maps K-stack roles onto models that are actually live in your
configured registry, then offers to save research keys. With nothing configured
it tells you so rather than inventing a mapping:

```text
Warning: No live model in a K-π pool; K-stack roles will inherit the parent session model.
Exa API key for research
>
Perplexity API key for research
>
Research mode: local
```

Both key prompts accept an empty submit to skip. The role suggestions come from
the committed ladder in [`docs/model-ladder.md`](docs/model-ladder.md); it is a
starting point for this harness, not a benchmark result.

## 8. Running a job

`/kpi <goal>` starts the loop. `/loop` is an alias for it.

```text
/kpi add a healthcheck; verify GET /health returns 200        # gated (default)
/kpi --plan specs/healthcheck/                                # frozen plan
/kpi --mode autopilot AC-01: ...; cmd npm test exits 0; writes only src/**   # unattended
/kpi --no-network <goal>                                      # local research only
/kpi --until-green <goal>
```

`/kpi off` restores plain harness input; `/k-mode off` disables K-mode. A bare
non-command message starts a gated `/kpi` job with sticky K-mode when automatic
wrapping is enabled.

### Gated versus autopilot

Gated is the default and stops for you at the release gate. Autopilot is
unattended, and it will only start when your acceptance criteria are
**executable**. That is a mechanical test, not a judgement:

- each required criterion needs a check — `cmd <command> exits <n>`
- and bounds — `writes only <paths>`

Both present on every required criterion means `executable`. Some present means
`partial`. None means `narrative`. Autopilot refuses anything but `executable`:

```text
STOP NEEDS_HUMAN
reason: autopilot requires executable acceptance criteria; received narrative
```

So this is refused:

```text
/kpi --mode autopilot add /health; check: curl -fsS localhost:3000/health
```

and this runs to `DONE`:

```text
/kpi --mode autopilot AC-01: GET /health returns status 200; cmd npm test exits 0; writes only src/health/** and test/health/**
```

One criterion per line, `AC-01:`-style ids, is the shape the fixtures use.

### Budget flags

`--max-cost-usd`, `--timeout-ms` and `--max-rounds` freeze onto `task.limits`
when the job is created, and only the flags you passed appear there. Running
`/kpi --mode autopilot --max-rounds 1 --max-cost-usd 1.5 --timeout-ms 600000 …`
writes:

```json
"limits": { "maxCostUsd": 1.5, "timeoutMs": 600000, "maxRounds": 1 }
```

and the board's round counter reads `ROUND 0/1`. Without flags the job takes the
graph defaults, which appear in `state.json` as:

```json
"limits": {
  "maxSteps": 24, "maxNodeRuns": 16, "maxConcurrency": 2,
  "maxCostUsd": 5, "timeoutMs": 1800000, "maxRounds": 3, "maxTransientRetries": 2
}
```

Crossing any of these ends the job `EXHAUSTED`. Local pools cost nothing, so
`maxCostUsd` only meters non-local catalogue spend. `--no-network` writes
`"research_network": "offline"` onto the task.

The flags compose with `--mode`, `--plan` and `--until-green`.

## 9. Reading the board

The board is a pure render of run-owned state. It never starts a model, which is
why `/kpi status` works with your provider unreachable.

Amber (`#ff6a1a`) means the loop is running. Protocol-blue (`#3da9fc`) means it is
paused on you. A running board:

```text
K-π  LOOP 20260902-add-get-health-…  MODE gated  JOB 20260902-add-get-health-…
CONTEXT LAYER  product ○  structure ○  tech ○
  AGENTS 0  BUS ○
STAGES  01 ac-compile CURRENT   02 specify PENDING   03 plan PENDING   04 implement PENDING
        05 test PENDING   06 bounds PENDING   07 review PENDING   08 ship PENDING
ROUND 0/3  FINGERPRINT —  PASS/FAIL
GATE machine
FILES  ● task.json  ● context.md  ○ candidate.json  ○ evidence.json  ○ verdict.json  ● events.jsonl
STOP RUNNING
NODE ac-compiler
```

- **Stage rail** — the eight stages, `01 ac-compile`, `02 specify`, `03 plan`,
  `04 implement`, `05 test`, `06 bounds`, `07 review`, `08 ship`. Exactly one is
  `CURRENT`; the rest are `DONE` or `PENDING`.
- **Six file lamps** — `task.json`, `context.md`, `candidate.json`,
  `evidence.json`, `verdict.json`, `events.jsonl`, in that order. `●` is present
  and non-empty, `○` is missing or empty. They fill in as the run progresses.
- **ROUND** — `round/maxRounds`. **FINGERPRINT** is the output fingerprint once a
  verifier has run. **PASS/FAIL** becomes `PASS` or `FAIL`.
- **GATE** — `machine` while the loop decides, `human` when you do.
- **RESEARCH** — a cell such as `RESEARCH local 0 src` when research ran without
  external services.
- **STOP** — the stop vocabulary, and nothing else: `RUNNING`, `DONE`, `BLOCKED`,
  `EXHAUSTED`, `NO_PROGRESS`, `UNSAFE`, `NEEDS_HUMAN`.
- **NODE** — the graph node that last ran.

A paused board turns protocol-blue and adds the operator rows — the pending
question, a lamp row for the terminal states, and the laws the loop holds itself
to while it waits:

```text
HUMAN OVERSIGHT REQUIRED
WAITING ON OPERATOR  All quality gates and isolated review are green. Approve this change for commit?
SHARED RUN STATE
  ● task.json  ● context.md  ● candidate.json  ● evidence.json  ● verdict.json  ● events.jsonl
STOP STATES  DONE ○  BLOCKED ○  APPROVAL ●
THREE LAWS
  1. Outer loop owns the return path
  2. Shared files are the contract
  3. Irreversible effects stay outside the worker
```

`/kpi status` renders every line in an overlay. The always-on widget has a fixed
line budget, and a board taller than it is fitted by what each row is worth
rather than truncated: the rows that carry `STOP`, the lamps and the pending
question are kept, in board order, so the short board reads like the same board
rather than a re-sorted one.

Narrow terminals wrap rather than lose fields. The guarantee is information, not
pixel identity.

## 10. The footer

Default segments, left to right: brand, model, thinking, path, git branch,
context, cost.

```text
K-π  >  ⬡ uat-stub  >  ● off  >  📁 proj  >  ⎇ main  >  ▦ 0%/32.8k  >  $0.00
```

The leftmost cell is always `K-π`. During a turn the brand animates with elapsed
seconds, `K-π ⠋ 3s`. The context cell is `▦ —` until a turn has reported usage,
then `▦ <percent>%/<window>`, coloured green below 50, yellow 50–70, orange
70–90, red above 90 — in the loop-amber theme those are `#3dff6a`, `#ffb020`,
`#ff6a1a`, `#ff3b3b`.

The cost cell tells you which kind of credential is serving you:

| Cell | Meaning |
|---|---|
| `(sub)` | an `oauth` subscription slot |
| `(local) $0` | a `local` slot — always exactly this, never a percentage |
| `$0.00` | an `api_key` slot, metered |

`/statusbar` toggles the K-π footer; when it turns off it says `Pi default footer
restored`. `/statusbar default|compact|full` sets a preset and confirms, for
example `K-π status bar preset full`. `compact` is genuinely shorter — brand,
model, path, cost:

```text
K-π  >  ⬡ uat-stub  >  📁 proj  >  $0.00
```

`full` adds the usage and job cells. `/statusbar brand unicode|nerd|ascii`
changes the brand glyph.

## 11. K-mode and playbooks

`/k-mode` turns on sticky K-mode rigor and reports `K-mode on`. `/k-mode <task>`
also selects a generated K-stack playbook for that task; `/k-mode off` disables
it. The playbooks ship as skills — `playbook-feature`, `playbook-bug-fix`,
`playbook-investigation`, `playbook-shipping`, `playbook-arena`,
`playbook-swarm`, `playbook-autopilot-full`, `playbook-autopilot-stack`,
`playbook-autonomous-run` — and appear in the `ctrl+o` skill list.

## 12. Other commands

| Command | Observed behaviour |
|---|---|
| `/kpi` | with no job: `no active job`. It is not a usage message |
| `/kpi status` | draws the board; `no active job` when there is none |
| `/kpi stop` | `no active job`, or on a live job a warning `K-π job <id> BLOCKED` |
| `/kpi verify [job-id]` | `events.jsonl verified: 14 records chained for <job>`; with no job, `no active job to verify; pass a job id` |
| `/kg` | with nothing stored: `No claims`. Also `/kg propose <json>` and `/kg accept <inbox-path>` |
| `/append-system` | on a current file: `… already matches the shipped APPEND_SYSTEM.md` |
| `/kpi-ping` | notifies `ok` — the one-word proof that the built-in registered |

`/kpi stop` is a real terminal, not a kill: it appends one record to the event
log and moves the state.

```text
event: loop.terminal  BLOCKED  reason: operator stop
state.json status: BLOCKED
```

`/append-system` never overwrites a file you wrote. If yours differs from the
shipped prompt it asks first:

```text
Replace APPEND_SYSTEM.md?
… Replace your version with K-π's?
→ Yes
  No
```

`/kpi verify` recomputes the RFC 8785 canonical hash of every record in
`.kpi/runs/<job>/events.jsonl` and names the first line that does not chain. It
reads no model and changes nothing.

## 13. The run directory

Everything a job produces lives under `.kpi/runs/<job-id>/`. Job ids are
`<date>-<goal-slug>-<hash>`, for example
`20260902-add-get-health-returning-status-ae4a7049`. There is no pointer file:
the *active* job is simply the run directory whose `state.json` was modified
most recently, which is what `/kpi status`, `/kpi stop` and `/kpi verify` read
when you give them no job id.

```text
.kpi/runs/<job>/
  task.json                 the validated contract: goal, acceptance, gates, limits
  context.md                the frozen repository context
  candidate.json            the implementer's chosen approach
  evidence.json             commands run, exit codes, excerpts, bound to a HEAD
  verdict.json              the isolated reviewer's verdict
  events.jsonl              hash-chained event log
  state.json                current stop state and stage
  stack.json                the frozen Dune slice
  ship.json                 the ship decision and the commit it made
  research.json             research provenance
  research.md               research notes
  baseline.json             pre-run file snapshot
  previous-head.txt         the git HEAD the run started from
  bus.jsonl                 background worker transcript
  agents/<node>/*.jsonl     one transcript per graph node
  agents/reviewer-*.jsonl   the reviewer's isolated session and its receipt
  graph/checkpoint-NNNNNN.json   one checkpoint per superstep
```

**`state.json`** is the file to read first. A finished gated run:

```json
{
  "job_id": "20260902-add-get-health-returning-status-ae4a7049",
  "mode": "gated",
  "round": 1,
  "maxRounds": 3,
  "stage": "done",
  "node": "done",
  "passed": true,
  "bounds": { "held": true },
  "review": { "approved": true, "status": "PASS", "output_fingerprint": "sha256:…" },
  "ac": { "quality": "executable" },
  "status": "DONE",
  "graph_status": "completed"
}
```

`status` is the stop vocabulary. `graph_status` is the engine's own state —
`running`, `interrupted`, `completed`. A run paused on you reads `"status":
"RUNNING"`, `"graph_status": "interrupted"` and carries `pending_question`.

**`events.jsonl`** is one JSON object per line, each carrying `prev_hash` and
`record_hash`. The first record's `prev_hash` is sixty-four zeros:

```json
{"job_id":"…","mode":"gated","node":"ac-compiler","prev_hash":"000…000","record_hash":"9d3d5cee…","round":0,"ts":"2026-09-02T09:25:25.062Z","type":"handoff.created"}
```

The finished gated run above produced fourteen records:

```text
handoff.created  research.started  research.completed
tool.request ×2 (implement)  tool.request ×3 (test)
agent.spawned  tool.request (review)  review.verdict PASS
approval.result  tool.request (human)  loop.terminal DONE
```

**`evidence.json`** binds commands to the HEAD they ran against, and records the
red test before the green one:

```json
{ "head": "2d4473d…",
  "commands": [
    { "cmd": "npm test", "exit": 1, "excerpt": "red: baseline failing before production fix" },
    { "cmd": "npm test", "exit": 0, "excerpt": "green: ok" }] }
```

**`verdict.json`** is the reviewer's, never the implementer's:

```json
{ "status": "PASS", "approved": true, "blockingIssues": [], "nonBlockingIssues": [],
  "evidence": ["npm test exits 0", "acceptance criteria covered by fixture"],
  "round": 0, "output_fingerprint": "sha256:59106f5d…" }
```

**`candidate.json`** records what was built and what was deliberately not:

```json
{ "ladder": "minimum-code",
  "used": "node:http createServer handleRequest for GET /health",
  "skipped": "frameworks routers and extra modules" }
```

## 14. Background workers

K-π spawns background workers for isolated work such as review. The caps are
counted across jobs, not per job, and they are small on purpose: **two live
workers**, of which **one may hold the write lease**. Excess is refused, never
queued, and the refusal is both raised and recorded in `bus.jsonl`:

```text
Background worker limit is 2          → bus.jsonl reason "worker-limit"
A writer worker is already live       → bus.jsonl reason "writer-live"
```

The board's `AGENTS <n>` count and `BUS ●`/`BUS ○` lamp track that file. Workers
produce contract files; they never declare the run complete.

## 15. Research

Research runs before implementation. With no keys it is local repository
research, and the board says so with `RESEARCH local`. `research.json` records
the provenance either way.

Save keys with `/setup-kstack`, or `/accounts login exa` and `/accounts login
perplexity`. They are stored in `~/.kpi/agent/accounts.secrets.json` at mode
`0600`, and a saved key beats the `EXA_API_KEY` and `PERPLEXITY_API_KEY`
environment variables. `/accounts logout exa` removes one.

`--no-network` (and `/kpi --no-network`) freezes the operator's offline decision
onto the task as `"research_network": "offline"`. Exa and Perplexity are research
credentials, not pools: they create no slot, join no fallback chain and change no
routing.

## 16. K-stack sync

K-stack ships vendored. Check its state, then move the pin deliberately:

```sh
npm run kstack:status
npm run kstack:sync -- --pin <commit>
npm run kstack:sync:check
```

`kstack:status` reports both halves — the local pin and whether upstream moved:

```text
local pin honest: vendored pstack tree is 950b90234c17babd00c43e32b19ae50abb4720f5
remote: update available — HEAD efa2a531… has pstack tree 1c625329…. Move the pin with: npm run kstack:sync -- --pin efa2a531…
```

`kstack:sync:check` is the gate: it fails if the generated tree does not match
the overlay and pin. Never hand-edit `packages/coding-agent/src/kpi/kstack/generated/`.

## 17. Read-only print profile

One-shot print mode is a read-only profile. It keeps only `read`, `grep`, `find`
and `ls`; `write` and `edit` are always excluded in v1.

```sh
kpi -p "Summarise this repository"
cat README.md | kpi -p "Review these instructions"
```

## 18. Unattended and containers

Autopilot is unattended only for machine-executable acceptance criteria. It may
create one local commit after deterministic approval. Beyond that, the policy
layer denies whole command families regardless of mode — publishing
(`npm/pnpm/yarn publish`), infrastructure application (`kubectl`, `helm` or
`terraform` with `apply`/`deploy`/`upgrade`), production deploys (`vercel` or
`netlify --prod`, any `deploy … prod`), and dependency addition (`npm install`,
`pnpm/yarn/bun add`). Adding a runtime dependency is deliberately in that list:
the loop is expected to solve the task with what the repository already has.

A small, exact allow-list of non-mutating inspection commands never prompts, and
matching is literal after collapsing whitespace: `git log` is safe, while
`git log --all -p > /tmp/dump` is a different command and stays unknown.

Process-level policy is not an operating-system sandbox. Use Docker or Gondolin
when filesystem, network or process isolation is required.

## 19. Worked example, start to finish

A scratch repository, one gated job, both approvals, and what it leaves behind.
This transcript was produced against a local OpenAI-compatible server so that it
is reproducible; with a real provider the sequence is the same.

**Set up a scratch repository.** The repository ships a fixture that is a working
example of a task with a failing test and declared gates:

```sh
cp -R fixtures/healthcheck-gated /tmp/scratch && cd /tmp/scratch
git init -q . && git add -A && git commit -qm "chore: fixture baseline"
cat task.txt
```

```text
Add GET /health returning status 200 and JSON {"status":"ok"}; cmd npm test exits 0; writes only src/health/** and test/health/**
```

**Start the job.** Launch `kpi` in that directory and paste the goal:

```text
/kpi Add GET /health returning status 200 and JSON {"status":"ok"}; cmd npm test exits 0; writes only src/health/** and test/health/**
```

**Watch the board.** It opens on stage 01 with two lamps lit and walks the rail.
The interesting transitions, in order:

```text
STAGES  01 ac-compile CURRENT  …                  STOP RUNNING   NODE ac-compiler
STAGES  01 ac-compile DONE   02 specify CURRENT   NODE specify   RESEARCH local 0 src
STAGES  … 03 plan CURRENT                         NODE plan
STAGES  … 04 implement CURRENT                    NODE implement
FILES   ● task.json ● context.md ● candidate.json ○ evidence.json ○ verdict.json ● events.jsonl
STAGES  … 05 test CURRENT                         NODE test
ROUND 0/3  FINGERPRINT —  PASS
STAGES  … 07 review CURRENT                       NODE review    AGENTS 0  BUS ●
ROUND 1/3  FINGERPRINT e19fa3fb0278  PASS
FILES   ● task.json ● context.md ● candidate.json ● evidence.json ● verdict.json ● events.jsonl
```

**First approval — the release gate.** The theme turns protocol-blue and the
board tells you that you are the gate:

```text
GATE human
HUMAN OVERSIGHT REQUIRED
WAITING ON OPERATOR  All quality gates and isolated review are green. Approve this change for commit?
SHARED RUN STATE
  ● task.json  ● context.md  ● candidate.json  ● evidence.json  ● verdict.json  ● events.jsonl
NODE human
```

```text
Approve gated release
All quality gates and isolated review are green. Approve this change for commit?
→ Yes
  No
```

**Second approval — the commit.** The commit is shown before it is made, with the
exact command and the diffstat:

```text
Approve git commit
git commit --allow-empty -m "feat: healthcheck endpoint" -m "KPI-Job: 20260902-add-get-health-returning-status-ae4a7049"
1 files changed, 7 insertions(+), 1 deletions(-) against HEAD.
Commit on the job branch?
```

**Finished.** The board settles and the loop reports the terminal:

```text
ROUND 1/3  FINGERPRINT 59106f5dc44b  PASS
GATE machine
FILES  ● task.json  ● context.md  ● candidate.json  ● evidence.json  ● verdict.json  ● events.jsonl
STOP DONE
NODE done
```

```text
K-π job 20260902-add-get-health-returning-status-ae4a7049 DONE
```

**What it left behind.** One commit, and a complete run directory:

```sh
git log --oneline -2
```

```text
cfcda90 feat: healthcheck endpoint
2d4473d chore: fixture baseline
```

The commit subject matches Conventional Commits and its body carries the job id.
`/kpi verify` then re-reads the log from disk:

```text
events.jsonl verified: 14 records chained for 20260902-add-get-health-returning-status-ae4a7049
```

## 20. Troubleshooting

**`Warning: No models available. Use /login …`** — no provider is configured.
Run `/login` or `/accounts login <pool> <slot>`.

**Autopilot stops immediately at `NEEDS_HUMAN`, "requires executable acceptance
criteria; received narrative"** — your goal has no `cmd … exits <n>` and no
`writes only …` on a required criterion. Either add both, or run gated.

**`Error: K-π accounts: llama needs a base URL`** — `llama` and `local-openai`
have no default origin. Supply one.

**`K-π accounts: Unknown /accounts command: …`** — check the subcommand against
the table in section 6.

**`No active route to advance; run a turn first`** — `/accounts next` needs a
route, which only exists after a request has been served.

**The board has no colour, or the wrong one** — the board's theme is applied when
the widget is installed. If the terminal cannot do truecolor the fields are all
still there. `/statusbar` and `--use-theme` control the rest of the chrome.

**Nothing appears to happen after typing a command** — commands submit on Enter.
Notifications are shown in the TUI; in `--mode rpc` only errors are delivered as
notifications, so use the TUI when you are looking for confirmation text.

**A first launch prints a long upstream changelog** — the changelog is shown when
`lastChangelogVersion` in `~/.kpi/agent/settings.json` is older than the shipped
entries. A truly fresh directory does not show it.

**`/kpi status` says `no active job`** — this project has no `.kpi/runs/*/state.json`
at all. The active job is whichever one was written last, so a job you finished
weeks ago still answers here until a newer one exists.

**A job ended `EXHAUSTED`** — a budget was crossed. Read `task.json`'s `limits`
and `state.json`'s `cost_usd` and `elapsed_ms`.

**A job ended `UNSAFE`** — a write fell outside the declared bounds, or policy
denied a command. `state.json`'s `reason` names it and no commit was made.

**A job ended `NO_PROGRESS`** — two rounds produced the same output fingerprint
or the same failing acceptance set. Change the goal or the criteria.

**`kstack:sync:check` fails** — the generated tree no longer matches the overlay
and pin. Re-run `npm run kstack:sync`; never hand-edit `generated/`.

---

# Contributor and repository reference

## Architecture

```text
kpi (this repository, one process)
├── packages/**                    forked Pi harness — K-π source, not a dependency
│   └── coding-agent/
│       ├── src/**                 upstream harness: TUI, agent loop, providers, sessions, RPC
│       └── src/kpi/**             K-π: control plane, graph engine, accounts, K-stack, resources
└── test/**                        K-π's node tests
```

K-π's commands, prompts, skills, themes and graphs are **built in**. The control
plane is registered as a visible built-in extension and its resources are
discovered by that built-in and copied into `dist`, so `/kpi`, `/accounts`,
`/k-mode` and `/setup-kstack` exist the moment the binary starts — no install
step, no manifest, no trust gate. Project trust still governs a *user's*
repo-local resources, exactly as in the base harness; it never gates K-π itself.

## Gates

The full local gate list, which is also what closes RP-19:

```sh
npm run check
npm test
npm run test:kpi
npm run kstack:sync:check
npm run upstream:check -- --offline
npm run build:offline
npm run verify:built
node scripts/verify-product.mjs --json .kpi/remediation-proof.json
```

`verify:built` starts the built `kpi` binary under a temporary `HOME` and
`KPI_CODING_AGENT_DIR`, checks the `dist/kpi` inventory, and exercises `--mode
rpc` offline with no install or trust step. It prints, for example,
`verify-built-harness: ok version=0.1.0 shipped=367 rpc_ui=true`.

`verify-product.mjs` re-runs M-01–M-07 against the built binary, writes
secret-free evidence under `.kpi/proof/`, rolls up `.kpi/uat/<UAT-ID>/` row
results, and emits `.kpi/remediation-proof.json`. Feature failures name the
owning `RP-##`; they are not fixed inside the proof scripts.

UAT rows are executed artefacts and are gitignored along with the rest of
`.kpi/`. A clean clone reports them as `NOT_RUN` until you run them; the roll-up
never invents a pass.

## Tracking upstream

K-π tracks Pi through the `upstream` git remote. Releases are fetched, reviewed
and merged deliberately; fork identity and the built-in registration always win.
Full policy, patched-file register and sync procedure: [`UPSTREAM.md`](UPSTREAM.md).

**External GitHub fork PRs do not run the self-hosted `check` gate.** Untrusted
fork heads never schedule on the persistent Mac runner. Outside contributors need
a maintainer-owned branch in `korallis/K-pi` (push access, or a maintainer-created
branch from the fork tip) so `pull_request` heads stay same-repository. The
workflow does not use `pull_request_target` and does not expose secrets to PR
code.

This fork does not report its own installs to `pi.dev`, and its provider
attribution stays with the upstream preference it inherited.

## Non-goals

K-π does not install community account or provider packs, replace official model
catalogues, run remote hosted workers, merge origin branches, or claim in-process
hooks are an OS sandbox. The one artifact it publishes is `@korallis/k-pi`, the CLI
itself, released from a `v<version>` tag by `.github/workflows/release.yml`; no
workspace package and nothing else in this repository is published. It is a fork, so
it also does not pretend to be the official Pi distribution: bugs found here go to
this repository, not upstream.
