# K-π (`kpi`)

**K-π is a standalone terminal coding agent — a maintained fork of [Pi](https://github.com/earendil-works/pi), not a plugin for it.**

This repository is the whole harness: TUI, agent loop, providers, sessions, tools, RPC. On top of that base, K-π compiles in its own gated or autonomous engineering loop — specify, research, plan, implement, test, bounds, isolated review, and one ship commit on a `kpi/<job>` branch that is pushed and opened as a pull request.

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

- Node 22.22 or newer. Both `package.json` files declare `"node": ">=22.22.2"`.
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

On a first launch in a clean home directory, with no slot in any pool and no
model the harness can serve, the footer reads `⬡ unknown` and the guided setup
opens by itself:

```text
K-π  >  ⬡ unknown  >  ● off  >  📁 proj  >  ⎇ main  >  ▦ —  >  $0.00
K-π is a standalone coding-agent harness you own.
A job runs a gated graph — specify → plan → implement → test → review → ship — with a plan gate and a release gate you confirm.
Reviewer and tester workers are separate kpi processes on the worker bus (see /agents).

Welcome to K-π
→ Start setup
  Not now
```

`Start setup` walks three steps, each skippable:

1. **Model accounts** — `Add a model account` lists every pool as `<pool> — <n>
   slot(s)` (local pools as `<pool> (local server) — …`) plus `Continue`.
   Picking a pool runs the same pooled login as `/accounts login <pool>`
   (section 5) with its provider notices; a cancelled or failed login is
   reported as `<pool> login not completed: …` and the list comes back until
   you choose `Continue`.
2. **Research keys (Exa, Perplexity, Firecrawl)** — `Enter API keys` asks the
   three prompts of section 7 (`Enter to save, s to skip` each) and saves
   whatever you gave to `accounts.secrets.json`. It writes no project file, so
   the directory you launched in never becomes trust-requiring; `/setup-kstack`
   is what writes `.kpi/settings.json`'s research mode. `Skip` writes nothing.
3. **K-stack roles** — `Map roles now` runs the role map of section 7; `Skip`
   leaves it.

It ends with a summary — `accounts: …`, `research keys: …`, `K-stack roles:
mapped|skipped`, `Run /onboarding any time; /accounts and /setup-kstack edit
the same files.` A step that fails is reported as `Onboarding step "<name>"
failed: …` and the wizard continues with the next.

`Not now` closes it for this launch and writes nothing — no marker, no settings
key — so it returns on the next TUI startup until a slot exists. The auto-run
rule is exact: TUI only (never print, rpc or json mode), every pool empty, and
no model available; `/onboarding` re-runs it whenever you like.
The same state is what the base harness warns about, so until a slot exists
that launch also shows:

```text
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
| `auth.json` | the base harness's credential per provider, mode `0600`, starts as `{}`; for a K-π pool this is the official slot's grant, and K-π never writes it |
| `APPEND_SYSTEM.md` | K-π's concise-output system prompt, installed on first run |
| `models-store.json` | cached model catalogue |
| `sessions/<project-slug>/` | session transcripts, one directory per project path |

Added by later commands:

| Path | Written by |
|---|---|
| `accounts.json` | `/accounts login` and `/onboarding` — pools, slots, fallback chain, stickiness |
| `accounts.secrets.json` | slot credentials and the Exa, Perplexity and Firecrawl research keys, mode `0600` |
| `settings.json` | harness settings, including the active `theme` |
| `<pool>-models.json` | local pool model lists, for example `local-openai-models.json` |

Never commit `accounts.secrets.json` or `auth.json`.

## 5. Signing in

Two surfaces, one subscription store. `/login` keeps the familiar harness UI;
when you choose subscription OAuth for a K-π pool it delegates to the pooled
login, adds a new *slot* without replacing siblings, and activates it. `/accounts
login` is the explicit pooled form, with an optional slot name, and
`/onboarding` (section 3) is the guided entry to the same pooled login. API-key
choices that are not subscription OAuth keep the base harness flow.

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

### One grant per slot

Each pool has at most one *official* slot: the one whose grant is what
`~/.kpi/agent/auth.json` holds. K-π serves it from `auth.json` and never
refreshes it — the base runtime refreshes that grant on every request. Every
other slot lives only in `accounts.secrets.json` and is refreshed by K-π, at
session start and at the start of a turn. No grant is ever held by two
refreshers (Anthropic rotates refresh tokens, so two copies refreshing one grant
kill it for both), and a slot's credential is never substituted by another
slot's. `/accounts login anthropic <slot>` for a pooled OAuth login the runtime
persisted makes the new slot official and the previous official slot keeps the
grant it had as a K-π-refreshed secret; the notice reads
`Added account anthropic/<slot> (anthropic/<previous> keeps its previous grant)`.

A refresh that fails with `invalid_grant` — K-π's own on a non-official slot, or
the runtime's on the official grant — marks the slot as needing a login rather
than cooling it: one notification
`K-π accounts: anthropic/<slot> needs a new login: Anthropic rejected its refresh token (invalid_grant). Run /accounts login anthropic <slot>`,
`needsLogin` in `accounts.json`, `needs login` after the slot in the accounts
widget, and routing skips it until `/accounts login <pool> <slot>`. A
transient refresh failure (http or transport) cools the slot for five hours with
a plain reason instead. Anthropic's `claude_code_version_too_old` refusal is
explained once per session and never cools a slot (section 20).

## 6. Inspecting and steering accounts

| Command | Effect |
|---|---|
| `/accounts` or `/accounts list` | list every `pool/slot  kind  label` |
| `/accounts login <pool> [slot]` | add or replace one slot |
| `/accounts logout <pool>/<slot>` | remove one slot |
| `/accounts logout exa` / `perplexity` / `firecrawl` | remove a research credential |
| `/accounts pin <pool>/<slot>` | pin this session to one slot |
| `/accounts next` | advance past the pinned slot |
| `/pool strategy <pool> <quota-first\|round-robin\|sticky>` | set a pool's strategy |
| `/pool chain a,b,c` | set the legacy provider chain used until K-stack `fallback_models` is configured |

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
quota is not yet known shows `?%`. K-π also reads Codex subscription used-percent
windows. At 5% remaining it proactively moves to a healthy sibling while keeping
the exact model and thinking level. A 429/402/403 quota refusal or finalized
quota-shaped 400 error also cools the slot; `home ?% cd 60m` means sixty minutes
remain. Only after every slot in that provider is unavailable does routing change
models/providers.

## 7. Models and K-stack roles

`/model` selects a model interactively; `--model <pattern>` and `--models
<patterns>` set and cycle them from the command line. `kpi --list-models` prints
what is available. Official catalogues are never frozen; refresh them with:

```sh
kpi update --models
```

`/setup-kstack` maps K-stack roles onto models that are actually live in your
configured registry and proposes an editable, exact `fallback_models` order from
the same ladder. Same-provider plans are always tried first; cross-provider
routing follows this saved order. Setup then offers to save research keys and
writes the project's research mode. With nothing configured
it tells you so rather than inventing a mapping:

```text
Warning: No live model in a K-π pool; K-stack roles will inherit the parent session model.
Exa API key for research
>
Perplexity API key for research
>
Firecrawl API key for research
>
Research mode: local
```

All three key prompts accept an empty submit (or `s`) to skip; with at least one
key saved the notice is `External research configured` and the project mode is
`auto`. `/onboarding` runs the same role map and the same three key prompts,
but saves keys only and never writes the project mode. The role suggestions
come from
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

A bare non-command message is plain chat. Under the default routing (`auto`) the
agent calls `kpi_start_job` for substantial engineering work, which queues a
gated `/kpi` job with sticky K-mode after the current turn; questions, greetings
and quick edits are answered directly. `/kpi always` wraps every bare message
into a gated job as before; `/kpi off` (or `kpi.routing = off` in
`.kpi/settings.json` / `~/.kpi/agent/settings.json` under `kpi`) leaves only
explicit `/kpi`. `/k-mode off` disables K-mode. Existing installs: run
`/append-system` to refresh the routing rule in `~/.kpi/agent/APPEND_SYSTEM.md`.

### Gated versus autopilot

Gated is the default and stops for you twice: at plan approval (`Approve plan`,
or `Request changes` with feedback, as many times as you need, or `Stop`) and at
the release gate (`Approve`, `Request changes` — the feedback goes back to
implement — or `Stop`). Without a dialog UI a gate stops `NEEDS_HUMAN
(approval)` and prints `/kpi <job>` to resume. Autopilot is unattended, and it
will only start when your acceptance criteria are **executable**. That is a
mechanical test, not a judgement:

- each required criterion needs a check — `cmd <command> exits <n>`
- and bounds — `writes only <paths>`

Both present on every required criterion means `executable`. Some present means
`partial`. None means `narrative`. Autopilot refuses anything but `executable`:

```text
STOP NEEDS_HUMAN ac_quality
reason: autopilot requires executable acceptance criteria; received narrative. Rewrite the goal with executable acceptance criteria, or run it gated, then resume with /kpi <job>
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

### No caps

A K-π run has no spend cap, no clock, no round, step or node-run counter that
ends it. `state.json` reports `cost_usd` (a catalogue estimate, never a bill —
the board writes it `$0.42 est.`), `elapsed_ms`, `graph_round` and `batches`;
nothing enforces them. The only graph limit is `maxConcurrency`, and the
retired flags are refused rather than ignored:

```text
/kpi --max-cost-usd 5 add a healthcheck
K-π loop failed: /kpi --max-cost-usd was removed: K-π runs have no caps; cost and elapsed time are reported on the board
```

`--timeout-ms` and `--max-rounds` answer the same way. `--no-network` writes
`"research_network": "offline"` onto the task and composes with `--mode`,
`--plan` and `--until-green`.

### Self-healing

Graphs never fail on their own. Three things happen instead:

- **Transient faults retry without bound.** An http 408/429/5xx, a timeout or a
  transport error keeps the round, checkpoints, waits 1 s doubling to a 60 s
  ceiling, and tries again — for as long as it takes. Every attempt appends a
  `node.retry` record, notifies `K-π <job> retry <n> on <node>: <reason>; next in
  <s>s (/kpi stop stops it)`, and shows on the board as `RETRY <n> · <reason> ·
  next <s>s`. A provider refusal that cannot fail over pauses `NEEDS_HUMAN
  (provider)` instead, with the real reason.
- **No progress re-plans.** A review that repeats an earlier output fingerprint
  or the same failing acceptance set, or a failed test round whose evidence is
  identical to the previous failed round, is written to `repair.json` (`round`,
  `reason`, `failing_ac`, `evidence_ref`, `witness`) and the job goes back to
  plan with that brief. Two such re-plans happen automatically; when the same
  witness comes back after them the loop asks `K-π no progress after 2 re-plans`
  with `Give guidance` (an editor; your text goes into `repair.json` and the
  planner reads it), `Keep going` (two more automatic re-plans) or `Stop`. A
  green round is progress even if it repeats a fingerprint.
- **Everything else waits for you.** A write outside the declared bounds, an
  untestable reviewer issue, a gate reached without dialog UI, a broken research
  service, an invalid `stack.json`: each pauses `NEEDS_HUMAN` with a `recovery`
  word and a reason that ends `then resume with /kpi <job>`. Nothing is
  committed, nothing is lost.

### Run states

A run is `RUNNING`, `NEEDS_HUMAN <recovery>`, `DONE` or `STOPPED` — and nothing
else. Only `RUNNING` is live. `NEEDS_HUMAN` and `STOPPED` are finished but
resumable: `/kpi <job>` continues either from its last checkpoint (a paused
gate is asked again; a retry resumes into the same node; a `no_progress` pause
asks its three-way question first). `/kpi <job>` on a `DONE` job reports `DONE`
and runs nothing. Runs written by an older release as `BLOCKED`, `EXHAUSTED`,
`NO_PROGRESS` or `UNSAFE` keep that word on disk and read as `NEEDS_HUMAN`
until they are resumed.

The loop is detached from the `/kpi` handler: while a job runs, `/kpi status`
opens the Command Centre, `/agents` lists its sessions, chat works, `/kpi stop`
is immediate, and a second `/kpi <goal>` is refused with `K-π job <id> is still
running: /kpi status shows it, /kpi stop stops it`. A stop that lands while a
gate select, its feedback editor or the no-progress prompt is open ends the run
`STOPPED` too, never as a failure.

## 9. Reading the board

The board is a pure render of run-owned state. It never starts a model, which is
why `/kpi status` works with your provider unreachable. Its look follows the
graph-engineering boards in
[the Avid post](https://x.com/av1dlive/status/2092622516544270781); the
in-repo contract is [`docs/visual-targets.md`](docs/visual-targets.md).

Amber (`#ff6a1a`) means the loop is running. Protocol-blue (`#3da9fc`) means it is
paused on you. The always-on widget above the editor is the compact cut of the
board, framed in the theme's colours:

```text
K-π GRAPH CONTROL │ MODE gated │ JOB 20260902-add-get-health │ ROUND 1
┌─────────────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
│01 ac-compile│ 02 specify  │   03 plan   │04 implement │   05 test   │  06 bounds  │  07 review  │   08 ship   │
│    DONE     │    DONE     │    DONE     │   CURRENT   │   PENDING   │   PENDING   │   PENDING   │   PENDING   │
│      —      │      —      │3m12s · $0.42│edit  12m04s │      —      │      —      │      —      │      —      │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────┴─────────────┴─────────────┴─────────────┘
FILES  ● task.json  ● context.md  ● candidate.json  ○ evidence.json  ○ verdict.json  ● events.jsonl
LOOP 20260902-add-get-health  STAGE 04 implement  NODE implement  GATE machine                          ┌──────────────┐
ROUND 1  PASS/FAIL PENDING  FINGERPRINT —                                                               │ STOP RUNNING │
RETRY 3 · http · next 4s                                                                                └──────────────┘
CONTEXT product ●  structure ●  tech ○  AGENTS 1 · 1 node · 0 workers  BUS ○
NOW implement  run 1  41 tools  ▸ edit board.ts  12m04s  $1.20  MODEL anthropic/claude-sonnet-4
```

The widget is live: it re-reads `state.json` and `events.jsonl` every second
(no model call) and repaints when a node session or worker starts or ends.

- **Stage cells** — the eight stages, `01 ac-compile`, `02 specify`, `03 plan`,
  `04 implement`, `05 test`, `06 bounds`, `07 review`, `08 ship`. Exactly one is
  `CURRENT` (accent border); the rest are `DONE` (green) or `PENDING` (dim).
  Each cell carries a detail line: a `DONE` cell reads `<elapsed> · <n> calls ·
  $<cost> est.` and gives up the calls, then ` est.`, as the cell narrows
  (`3m12s · $0.42` above); `CURRENT` reads `<tool> <target>  <elapsed>` and gives
  up the target, then the tool (`edit  12m04s` above); `PENDING` is `—`. The
  cost is a catalogue estimate, never a bill.
- **Six file lamps** — `task.json`, `context.md`, `candidate.json`,
  `evidence.json`, `verdict.json`, `events.jsonl`, in that order. `●` is present
  and non-empty, `○` is missing or empty. They fill in as the run progresses.
- **ROUND** — `ROUND n`, with no maximum. **FINGERPRINT** is the output
  fingerprint once a verifier has run. **PASS/FAIL PENDING** becomes `PASS ●
  last verifier` or `FAIL ● last verifier` once a verdict exists.
- **RETRY** — `RETRY <attempt> · <reason> · next <s>s` while a node is backing
  off from a transient fault (`http`, `timeout` or `transport`); the row
  disappears when the retry succeeds.
- **GATE** — `machine` while the loop decides, `human` when you do.
- **RESEARCH** — a cell such as `RESEARCH local 0 src` when research ran without
  external services (in the context layer of the full board).
- **AGENTS** — the live sessions of this job in this process, `AGENTS 1 · 1
  node · 0 workers`: nodes are in-process sessions, workers are separate kpi
  processes (section 14). `BUS ●` lights once `bus.jsonl` has traffic.
- **STOP** — the box at the right, and nothing else: `RUNNING`, `DONE`,
  `STOPPED`, or `NEEDS_HUMAN <recovery>` (for example `STOP NEEDS_HUMAN
  bounds`).
- **NODE** — the graph node that last ran. **NOW** — what it is doing: the
  node, its run number, tool-call count, last tool and target, elapsed, cost and
  model, refreshed every second from run files. Before the first record the row
  reads `no node.started yet`; a log problem shows as `EVENTS ✕ <n> unreadable`
  or `EVENTS ✕ <code>`. On a narrow board the `MODEL`, then the `▸ <tool>`, then
  the `run n` span are dropped before anything is cut.

While a job runs the chat carries one line per node start, finish, retry, gate
answer and route change, and never one per tool call:

```text
K-π ▶ 04 implement · run 1 · anthropic/claude-sonnet-4
K-π ↻ 04 implement retry 3 · http · next 4s
K-π ■ 04 implement done · 12m04s · $1.20 · candidate.json
K-π ✕ 05 test failed · 40s · npm test exited 1
K-π ⚑ plan-approval gate approved
K-π ⇄ route anthropic/home → openai-codex/work
K-π ■ job NEEDS_HUMAN bounds
```

A paused board turns protocol-blue, its header reads `K-π PROTOCOL … GATE
approval`, and it adds the operator rows — the pending question and the lamp row
for the stop states:

```text
WAITING ON OPERATOR  The plan is frozen as stack.json. Approve it for implementation, or request changes?
STOP STATES  DONE ○  STOPPED ○  APPROVAL ●
```

The widget is removed once the newest run has ended; `/kpi status` then answers
`no active job — last job <id> <status>`.

Narrow terminals wrap rather than lose fields: below 70 columns the rows are
flat, the lamp and stage rows fold, and the job id gives way before `MODE` or
`ROUND`. The guarantee is information, not pixel identity. The footer's job
cell (section 10) reads `K-π LOOP gated r1 STAGE implement GATE machine ROUTE
anthropic/claude-sonnet-4` — mode, round, stage, gate, then the provider/model
serving the run.

### The Command Centre (`/kpi status`)

In the TUI `/kpi status` opens the K-π Command Centre: a full-width overlay
over the widget that is as live as the widget — it re-reads the run files on the
same one-second tick while the job is `RUNNING`, and it is usable mid-run. In
print and rpc mode `/kpi status` prints the plain board instead.

**HOME** carries a header — `K-π COMMAND › <job>` with `MODE <mode> · ROUND <n>
· GATE <gate> · STOP <status>[ <recovery>] ⠙ <elapsed> · <clock>` — and these
panels:

- **STAGES** — `01`–`08` with `✓ DONE`, `⠙ RUNNING`, `○ PENDING`, `✕ FAILED` or
  `◉ WAITING` (a gate waiting on you), the stage's elapsed, and the same detail
  line as the widget's cells; `▸` marks the selected stage.
- **LIVE › <NN stage>** — the tail of the selected stage's session transcript
  (`agents/<node>/*.jsonl`), following while the node runs.
- **TELEMETRY** — `cost $<x> est.` with a sparkline of cost per minute, context,
  tokens, time, per-round elapsed, steps, node runs, `WORKERS <w>/<cap>` and
  `RETRY <attempt> · <reason> · next <s>s` while a node backs off. There is no
  cap anywhere on it because there is none.
- **SHARED RUN STATE** — the six run files with size, mtime and a note;
  `BOUNDS held · BASELINE n files · PREVIOUS HEAD <sha>` when known.
- **CONTEXT LAYER** — the context-pack lamps, research, agents, bus, and the
  route (`anthropic/home 71% 5h · fallback openai-codex → xai`).
- **EVENTS · events.jsonl** — the newest records, `following` while running;
  **PATH** — the rail with the current stage marked.

`enter` on a stage opens the **SESSION** view: the STAGES rail on the left, the
node's transcript in the middle (`following · <elapsed>` while it runs), and a
**NODE** panel on the right — type, context mode, tools, readOnly, retries,
status, elapsed, cost, tokens, model, route, thinking, the files it wrote and
whether they stayed inside bounds, its superstep, and the graph's next edges.

Keys: `tab`/`↓`/`→` next stage, `shift+tab`/`↑`/`←` previous, `1`–`8` jump,
`enter` open the session (home) , `esc` back (session) or close (home), `q`
close, `r` refresh now, `ctrl+c` close. The hint row reads `tab/↑↓ select stage
· enter open · esc close · r refresh` at home and `esc back · ← → node · r
refresh` in a session. Anything printable types into the input line: `/kpi
stop` stops the job exactly as the command does, then repaints; `/kpi verify`
puts the verify line on the hint row; any other `/kpi …` answers `K-π /kpi …
is refused while a job runs; /kpi stop first`; `!…` answers `K-π bash is not
available inside the command centre`; any other text closes the view and goes
to the chat as your message. `esc` with a non-empty line clears it.

A refresh that fails paints `EVENTS ✕ <code>` in the header and never throws;
a read that fails on open paints `K-π reading run files ✕ <code> · r to retry`
and the ticker retries it. When the job is gone the header reads `K-π no active
job` and the ticking stops; it also stops when the run ends `DONE`,
`NEEDS_HUMAN` or `STOPPED`. At 44 rows or more HOME shows the full STAGES
detail; between 38 and 43 rows STAGES compacts to labels so SHARED RUN STATE
and CONTEXT LAYER stay on screen; below that the second row of panels goes.

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
| `/kpi status` | opens the Command Centre (section 9); in print/rpc mode prints the board; `no active job — last job <id> <status>` when nothing is running |
| `/kpi stop` | immediate: aborts the live loop, writes `stop.json`, records `loop.terminal STOPPED` and notifies `K-π job <id> STOPPED (resume with /kpi <id>)`; `no active job` when there is none |
| `/kpi <job-id>` | resumes a `NEEDS_HUMAN` or `STOPPED` job; a `DONE` job answers `K-π job <id> DONE` and runs nothing |
| `/kpi <goal>` while a job runs | refused: `K-π job <id> is still running: /kpi status shows it, /kpi stop stops it` |
| `/kpi verify [job-id]` | `events.jsonl verified: 22 records chained for <job>` (the count is the run's own — section 13); with no job, `no active job to verify; pass a job id` |
| `/agents` | `K-π SESSIONS <n> live · <k> node(s) in-process · <w> worker process(es)`, a `KIND ID ROLE MODEL PID ALIVE ELAPSED TOOLS LAST NODE JOB` table, `caps (this process): workers 0/2 · writers 0/1`, the mechanism sentence, then `job <id> <status>` — or `no active job`, which is not an error |
| `/onboarding` | the guided setup of section 3, re-runnable any time; it also opens by itself on a TUI startup with no slot in any pool and no model available |
| `/kg` | with nothing stored: `No claims`. Also `/kg propose <json>` and `/kg accept <inbox-path>` |
| `/append-system` | on a current file: `… already matches the shipped APPEND_SYSTEM.md` |
| `/kpi-ping` | notifies `ok` — the one-word proof that the built-in registered |

The loop runs detached from the `/kpi` handler: the command returns once the job
has started, so `/kpi status`, `/kpi stop`, `/agents` and plain chat all work
while it runs. `/kpi stop` is a stop, not a kill and not a death: the run
directory keeps everything and `/kpi <job>` continues from the checkpoint.

```text
event: loop.terminal  STOPPED  reason: operator stop
state.json status: STOPPED
.kpi/runs/<job>/stop.json  { "reason": "operator stop", "at": "…", "recorded": true }
```

A stop that lands before the run directory exists creates nothing:
`K-π job <id> stopped before its run was created; nothing to resume`. A stop
from a second session while this one is mid-backoff or mid-superstep is honoured
at the loop's next checkpoint.

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
  task.json                 the validated contract: goal, acceptance, gates
  context.md                the frozen repository context
  candidate.json            the implementer's chosen approach
  evidence.json             commands run, exit codes, excerpts, bound to a HEAD
  verdict.json              the isolated reviewer's verdict
  events.jsonl              hash-chained event log
  state.json                current run state, stage, and stop-safety fields
  stack.json                the frozen Dune slice
  repair.json               the planner's brief after a no-progress finding
  stop.json                 the operator's stop marker; /kpi <job> removes it
  ship.json                 the ship decision: the commit, the job branch pushed, the pull request
  research.json             research provenance
  research.md               research notes
  baseline.json             pre-run file snapshot
  previous-head.txt         the git HEAD the run started from
  bus.jsonl                 background worker transcript
  agents/<node>/*.jsonl     one transcript per graph node
  agents/reviewer-*.jsonl   the reviewer's isolated session and its receipt
  graph/checkpoint-NNNNNN.json   one checkpoint per superstep
```

**`state.json`** is the file to read first. A finished gated run (the report-only
counters and stop-safety fields elided):

```json
{
  "job_id": "20260902-add-get-health-returning-status-ae4a7049",
  "mode": "gated",
  "round": 1,
  "stage": "done",
  "node": "done",
  "passed": true,
  "bounds": { "held": true },
  "review": { "approved": true, "status": "PASS", "output_fingerprint": "sha256:…" },
  "release": { "approved": true },
  "ac": { "quality": "executable" },
  "status": "DONE",
  "graph_status": "completed",
  "limits": { "maxConcurrency": 2 },
  "elapsed_ms": 184213,
  "cost_usd": 0.42,
  "graph_round": 1,
  "repaired": []
}
```

`status` is the run vocabulary: `RUNNING`, `NEEDS_HUMAN`, `DONE`, `STOPPED`.
Only `RUNNING` is live; `NEEDS_HUMAN` and `STOPPED` are finished but resume
with `/kpi <job>`. A `NEEDS_HUMAN` run also carries `recovery` (`approval`,
`provider`, `delivery`, `ship`, `bounds`, `review`, `no_progress`, `research`,
`stack`, `contract` or `ac_quality`) and a `reason` that ends with the resume
command. `graph_status` is the engine's own state — `running`, `interrupted`,
`paused`, `completed`. A run waiting at a gate reads `"status": "RUNNING"`,
`"graph_status": "interrupted"` and carries `pending_question`.

`limits` holds `maxConcurrency` and nothing else; `cost_usd`, `elapsed_ms`,
`graph_round` and `batches` are reported, never enforced. The stop-safety
fields a resume must not lose: `evidence_fingerprints`, `output_fingerprints`,
`failing_ac_sets`, `last_test_evidence`, `repaired` (the re-plans spent since
the operator last answered), `plan_repair` (the current `repair.json` brief),
and `retry { node, attempt, reason, delay_ms, until_ms }` while a node is
backing off.

**`events.jsonl`** is one JSON object per line, each carrying `prev_hash` and
`record_hash`. The first record's `prev_hash` is sixty-four zeros:

```json
{"job_id":"…","mode":"gated","node":"ac-compiler","prev_hash":"000…000","record_hash":"9d3d5cee…","round":0,"ts":"2026-09-02T09:25:25.062Z","type":"handoff.created"}
```

The scripted fixture run behind
`test/gated-loop.test.ts` "loop on healthcheck fixture reaches human confirm
with green gates" — the same graph, both gates approved, no tool calls —
produces twenty-two records:

```text
handoff.created  node.started/node.finished (ac-compiler)
research.started  research.completed  node.started/node.finished (specify)
node.started/node.finished (plan)  approval.result (plan-approval)
node.started/node.finished (implement)  node.started/node.finished (test)
node.started (review)  agent.spawned  review.verdict PASS  node.finished (review)
approval.result (human)  node.started/node.finished (ship)  loop.terminal DONE
```

A run against a live model adds one `tool.request` per tool call, one
`node.retry` per transient retry, and `checkpoint` records where the loop
re-plans or reports a retired cap, so its count is higher; `/kpi verify` reports
the real number. `loop.terminal` carries `status` `DONE`, `STOPPED` or
`NEEDS_HUMAN` with its `recovery`.

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

K-π runs graph nodes as in-process sessions in this kpi process; a node with
`workerRole` (the reviewer) and the `spawn_background` tool start separate `kpi
--mode rpc` processes that talk over `.kpi/runs/<job>/bus.jsonl`. No sub-agent
API is used. The board's `AGENTS n · k nodes · w workers` cell counts the live
sessions of the current job in this process and repaints when a node session or
worker starts or ends; `/agents` lists every one of them. The caps and the count
are per process; `bus.jsonl` and the `BUS ●`/`BUS ○` lamp are per run
directory. Workers produce contract files; they never declare the run complete.

## 15. Research

Research runs before implementation. With no keys it is local repository
research, and the board says so with `RESEARCH local`. `research.json` records
the provenance either way.

Save keys with `/onboarding`, `/setup-kstack`, or `/accounts login exa`,
`/accounts login perplexity` and `/accounts login firecrawl`. They are stored in
`~/.kpi/agent/accounts.secrets.json` at mode `0600`, and a saved key beats the
`EXA_API_KEY`, `PERPLEXITY_API_KEY` and `FIRECRAWL_API_KEY` environment
variables (`EXA_BASE_URL`, `PERPLEXITY_BASE_URL` and `FIRECRAWL_BASE_URL`
override the origins). `/accounts logout exa`, `perplexity` or `firecrawl`
removes one. The tools are `exa_search`, `exa_contents`, `pplx_search` and
`firecrawl_search` (`POST https://api.firecrawl.dev/v2/search`, web sources
only, at most 10 results); research mode `auto` tries Exa, then Perplexity,
then Firecrawl.

`--no-network` (and `/kpi --no-network`) freezes the operator's offline decision
onto the task as `"research_network": "offline"`. Exa, Perplexity and Firecrawl
are research credentials, not pools: they create no slot, join no fallback chain
and change no routing.

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

Outside a K-π job the policy enforces only those hard denies: plain chat never
prompts. Inside a gated job, read-only commands never prompt either — including
pipes, `;`, `&&` and `$(…)` chains whose every segment is read-only, such as
`git log --oneline --all | head` or `grep -rn foo src | wc -l`. Anything that
writes a file, executes project code or is otherwise unknown asks once, and the
answer can be kept for the session or remembered in `.kpi/policy.json` under
`allow[]` (exact command, whitespace collapsed). A remembered command can never
override a hard deny.

Process-level policy is not an operating-system sandbox. Use Docker or Gondolin
when filesystem, network or process isolation is required.

## 19. Worked example, start to finish

A scratch repository, one gated job, the plan gate, the release gate, the
commit, and what it leaves behind.
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
NOW plan  run 1  0 tools  4s  $—
STAGES  … 04 implement CURRENT                    NODE implement
FILES   ● task.json ● context.md ● candidate.json ○ evidence.json ○ verdict.json ● events.jsonl
STAGES  … 05 test CURRENT                         NODE test
ROUND 0  FINGERPRINT —  PASS
STAGES  … 07 review CURRENT                       NODE review    AGENTS 1 · 0 nodes · 1 worker  BUS ●
ROUND 1  FINGERPRINT e19fa3fb0278  PASS
FILES   ● task.json ● context.md ● candidate.json ● evidence.json ● verdict.json ● events.jsonl
```

Each node start and finish also puts one line in the chat — `K-π ▶ 03 plan ·
run 1 · <provider/model>`, then `K-π ■ 03 plan done · 4s` — and nothing per tool
call.

**First approval — the plan.** After `03 plan` writes `stack.json` the loop
pauses on the `plan-approval` node, notifies `K-π job
20260902-add-get-health-returning-status-ae4a7049 is waiting on you: Plan
approval`, and opens a select whose title is the plan itself:

```text
Plan approval
The plan is frozen as stack.json. Approve it for implementation, or request changes?

Delivery: …
Root: …
Current slice: health
Modules (1):
  1. health — …

Full plan: .kpi/runs/20260902-add-get-health-returning-status-ae4a7049/stack.json
Revision 1
→ Approve plan
  Request changes
  Stop
```

`Approve plan` records `approval.result` for `plan-approval` and implement
starts. `Request changes` opens an editor; the feedback (non-empty, at most 4000
characters) re-runs plan, which overwrites `stack.json` and asks again as
`Revision 2` — as many times as you need, there is no cap. `Stop` ends the run
`STOPPED`.

**Second approval — the release gate.** The theme turns protocol-blue and the
board tells you that you are the gate:

```text
GATE human
HUMAN OVERSIGHT REQUIRED
WAITING ON OPERATOR  All quality gates and isolated review are green. Approve this change for a commit on the job branch, a push of that branch to origin, and a pull request?
SHARED RUN STATE
  ● task.json  ● context.md  ● candidate.json  ● evidence.json  ● verdict.json  ● events.jsonl
STOP STATES  DONE ○  STOPPED ○  APPROVAL ●
NODE human
```

```text
Approve gated release
All quality gates and isolated review are green. Approve this change for a commit on the job branch, a push of that branch to origin, and a pull request?
→ Approve
  Request changes
  Stop
```

`Request changes` opens an editor for your feedback and sends the job back to
implement with it; `Stop` ends the run `STOPPED`, resumable with `/kpi <job>`.

**Third approval — the commit.** The commit is shown before it is made, with the
exact command and the diffstat:

```text
Approve git commit
git commit --allow-empty -m "feat: healthcheck endpoint" -m "KPI-Job: 20260902-add-get-health-returning-status-ae4a7049"
1 files changed, 7 insertions(+), 1 deletions(-) against HEAD.
Commit on the job branch?
```

**Finished.** The board settles and the loop reports the terminal:

```text
ROUND 1  FINGERPRINT 59106f5dc44b  PASS
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
events.jsonl verified: 22 records chained for 20260902-add-get-health-returning-status-ae4a7049
```

## 20. Troubleshooting

**`Warning: No models available. Use /login …`** — no provider is configured.
In the TUI the `/onboarding` wizard opens by itself in this state; otherwise run
`/login` or `/accounts login <pool> <slot>`.

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

**`Claude Code 2.1.x does not support this model; version … or newer is required`**
— K-π identifies as Claude Code for Anthropic subscription OAuth, and Anthropic
has raised the floor. The session explains it once:
`K-π <version> identifies to Anthropic as Claude Code <sent>; Anthropic requires <required> or newer for <model>. Update K-π: npm install -g @korallis/k-pi@latest`.
Nothing is cooled and no failover happens; update and resend.

**`K-π accounts: anthropic/<slot> needs a new login: … (invalid_grant). Run /accounts login anthropic <slot>`**
— the slot's refresh token is dead. Anthropic rotates refresh tokens, so a grant
refreshed by two copies dies for both; that is why the official slot is served
from `auth.json` and refreshed only by the base runtime (section 5). The widget
marks the slot `needs login` and routing skips it. A dead *official* grant
leaves the pool unavailable until that login — resend the prompt afterwards,
there is no automatic retry.

**A job is `NEEDS_HUMAN`** — the loop paused for you, it did not die.
`state.json`'s `recovery` says which kind of pause and `reason` ends with the
resume command: `approval` (answer the gate in an interactive session),
`provider` (select a healthy model or fix that account), `bounds` (revert the
writes that left the declared bounds, or widen them), `review` (address the
reviewer's blocking issue), `no_progress` (the resume asks Give guidance / Keep
going / Stop), `research`, `stack`, `delivery`, `ship`, `contract`,
`ac_quality`. Then `/kpi <job>`.

**The loop keeps retrying** — a transient provider fault (http 408/429/5xx, a
timeout, a transport error) retries without bound: 1 s doubling to a 60 s
ceiling, one `node.retry` record and one `K-π <job> retry <n> on <node>: …; next
in <s>s (/kpi stop stops it)` line per attempt, and a `RETRY` row on the board.
Fix the provider and the next attempt succeeds, or `/kpi stop`; the run resumes
into the same node with `/kpi <job>`.

**A job is `STOPPED`** — you stopped it (`/kpi stop`, Stop at a gate or at the
no-progress prompt). Everything is on disk; `/kpi <job>` continues it. A run
that ended `EXHAUSTED`, `UNSAFE`, `NO_PROGRESS` or `BLOCKED` under an older
release keeps that word on disk until you resume it: it reads as `NEEDS_HUMAN`,
`/kpi <job>` continues it, and a contract or checkpoint that still carries the
retired caps is reported once as `K-π job <job>: retired caps ignored: …` and
never enforced.

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
`verify-built-harness: ok version=0.3.0 shipped=403 rpc_ui=true`.

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
