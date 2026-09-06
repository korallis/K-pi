# Visual targets — k-pi

Agents building the TUI must preserve the operator-selected imported wireframes' Jobs-first styling and mentality, adding truthful useful detail without inventing a different home or status language. This RP-22 contract reconciliation follows the recorded [operator decision](remediation-plan.md#rp-22--autonomous-runtime-architectural-rebuild); it is not terminal acceptance evidence.

## Source posts and files

| What | Where |
|---|---|
| Historical graph-engineering boards (retained widget/detail geometry, not home or status colors) | https://x.com/av1dlive/status/2092622516544270781 |
| Oh My Pi status bar (the look of the footer) | This folder: `visual/omp-statusbar-codemod.jpg`, `visual/omp-statusbar-collab.jpg` |
| OMP segment source (reference only, do not import) | https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/components/status-line/presets.ts |
| OMP brand icon source | `icon.omp` = `π` (unicode) / Nerd `U+F0D57` / ascii `pi` in oh-my-pi `symbols.ts` |
| Command Centre home, input, intervention, details, help and narrow layout | `visual/k-pi-design/K-pi Command Center Wireframes.dc.html`, frames 4b–4k |
| Imported reference support and screen mapping | `visual/k-pi-design/support.js`, `visual/k-pi-design/github.md` |

We implement our own footer. We do not install Oh My Pi.

---

## 1. Status bar — Oh My Pi layout, k-pi brand

### What the operator sees today in OMP

From `visual/omp-statusbar-codemod.jpg`:

```
π  >  ⬡ Opus 4.7 ⚡ · ● high  >  📁 omp-codemod-demo  >  ▦ 2.8%/1M  >  $0.63  ────────  Migrate console.log to log.debug
```

From `visual/omp-statusbar-collab.jpg`:

```
π  >  ⬡ Opus 4.8++ · ● high  >  📁 omp-collab  >  🌿 main  >  ▦ 4.0%/1M  >  (sub)
```

Layout rules copied from OMP default preset (`leftSegments` then `rightSegments`, powerline-thin separators):

1. **Brand** (leftmost)
2. **Model** + thinking level
3. **Path** (repo / cwd, abbreviated)
4. **Git** (branch + dirty marks when present)
5. **Context** `pct%/window` + auto-compact mark
6. **Cost** — `$x.xx`, `(sub)`, or `(local) $0`
7. Right side: last user request or session name, truncated

Separator: powerline chevron `>` between segments. Thin variant is the default.

Context color: green < 50%, yellow 50–70%, orange 70–90%, red > 90%.

While a turn is running, OMP replaces the idle brand glyph with a braille spinner + whole-second timer. Do the same.

### The only brand change

OMP idle brand is `π`.

k-pi idle brand is **`K-π`**.

| Preset | Idle brand | Working brand |
|---|---|---|
| unicode (default) | `K-π` | braille spinner + `Ns` timer |
| nerd | `K-` + Nerd pi `U+F0D57` | same spinner rule |
| ascii | `K-pi` | `~ Ns` |

Do not render bare `π`. Do not render `omp`. Do not render a big ASCII Π logo in the footer (that belongs to OMP’s splash, not our bar).

Exact idle cell:

```
K-π
```

No space between `K-` and `π`. Accent color on the whole cell. While working, the `K-` prefix stays and the spinner replaces `π` only if width is tight; prefer `K-π ⠋ 3s` when there is room, else spinner+timer alone.

### Default k-pi footer (normative)

```
K-π  >  ⬡ claude-opus · ● high  >  📁 repo  >  ⎇ main  >  ▦ 12%/200k  >  (sub)  ────  add healthcheck
```

Plus, when a k-pi job is active, an extension status slot on line 2 (or the next wrapping line):

```
K-π LOOP gated r2 STAGE implement GATE human AC 4/5 ROUTE anthropic/home
```

That second line is ours (`ctx.ui.setStatus("kpi", …)` if the footer is a full replacement, or a dedicated segment `kpi_job`).

### Segments we implement first-party

| Id | Content |
|---|---|
| `brand` | `K-π` / spinner |
| `model` | short model name |
| `thinking` | `● low\|medium\|high\|xhigh` |
| `path` | abbreviated cwd |
| `git` | branch + `+staged *unstaged ?untracked` |
| `context_pct` | `n%/window` |
| `cost` | `$x.xx` for api-key slots, `(sub)` for subscription slots, exactly `(local) $0` for a `local` slot |
| `usage` | per-pool remaining if known, else omit. A local slot has no quota: omit it, never draw `100%` |
| `kpi_job` | mode / round / stage / gate |
| `request` | last user text, 80 chars, right-aligned |

Exact local cost cell:

```
(local) $0
```

One cell, one space, that literal. A `local` slot is credential-free and its traffic costs nothing, so it renders neither a computed burn nor `$0.00`, and no quota percentage sits beside it.

Commands: `/statusbar` toggle, `/statusbar preset default|compact|full`.

Do not depend on `pi-status-bar`, `pi-vitals`, `pi-powerline-footer`, or Oh My Pi at runtime. Read them. Write ours.

---

## 2. Jobs-first terminal with retained graph detail

The imported 4b–4k wireframes define the primary operator experience: real Jobs, a plain explanation of what happens now/next/has completed, and human intervention only when the runtime requires it. The compact widget and deeper technical boards retain stage, mode, gate, files, loop result and stop state without requiring model prose. Useful truthful detail may be added without replacing Jobs home with a technical dashboard.

### Honesty

Pi widgets will not reproduce the JPEGs pixel-for-pixel. That is not a failure.

The widget and printed board retain: `K-π`, MODE, JOB, ROUND, stages 01–08 with current identified, PASS/FAIL, six file lamps, STOP; authoritative human intervention adds WAITING ON OPERATOR + the question. These are not a demand to crowd every technical field onto Jobs home.

May wrap, stack, or truncate on a narrow terminal. Current stage and STOP stay visible. **Color migration:** cool cyan means machine work; restrained warm peach means actual human intervention. The earlier amber-running / blue-paused mapping is superseded by the imported 4b–4k wireframes. Hex values are guidance, not a screenshot test.

The always-on widget is the compact cut of Board A/B: header strip, one row of stage cells, the `FILES` lamp row, the LOOP/STAGE/NODE/GATE and ROUND/PASS/FAIL rows, the STOP box, the `NOW` row, and while paused the operator question and STOP STATES. `/kpi status` opens the Command Centre (below) over it. Below 70 columns the rows are flat but keep every field; the lamp row folds. Lamps are `●` lit / `○` dark; the iteration panel reads `PASS/FAIL PENDING` until a verdict exists.

While a node runs the board must change: a `NOW` row names the running node, its run number, tool count, last tool and target, elapsed and cost, refreshed from run files every second; the chat carries one line per node start, finish, retry and route change (`K-π ▶`, `K-π ■` / `K-π ✕`, `K-π ↻`, `K-π ⇄`) and none per tool call. Stage cells carry a detail line in both layouts — DONE `<elapsed> · <n> calls · $<cost> est.`, CURRENT `<tool> <target>  <elapsed>`, PENDING `—` — shrinking by form to the cell width, never wrapping the rail. Cost is an estimate, never a bill; `$—` when unknown.

Canonical post:

**https://x.com/av1dlive/status/2092622516544270781**

X did not expose the article images as downloadable media here. In-repo reconstructions agents must match:

- `visual/kpi-board-amber-running.jpg` — historical running-board geometry; its amber color semantics are superseded
- `visual/kpi-board-protocol-pause.jpg` — historical pause-board geometry; its blue color semantics are superseded

These JPEGs guide the retained technical board and widget geometry. The imported 4b–4k HTML guides Command Centre home and interaction. All surfaces draw from `state.json` and run files, never model-painted markdown.

The Oh My Pi bar is the **footer**. Jobs home is the primary overview; these retained boards supply the **compact live widget and informed-operator detail**.

### Board A — cool working board (theme registration `loop-amber`)

Dark charcoal field (`#14171c`), cool working accent (`#70ced1`), warm intervention (`#e9ad86`), muted gray text. The historical theme registration name is retained for existing theme selection; its former orange-running palette is not.

Required regions, top to bottom:

1. **Header strip**  
   Product mark `K-π` · loop name · `MODE gated|autopilot` · job id.

2. **Context layer**  
   Short lines: product / structure / tech pack loaded. Not the full files. The layer also carries the live-session cell `AGENTS n · k nodes · w workers` (in-process node sessions plus worker processes for the live job; `AGENTS n` alone when the split is unknown); the `AGENTS <n>` prefix is the graded token. The §1 default footer is unchanged by it.

3. **Stages 01–08** as a numbered rail, current stage lit cool cyan, recorded completed stages muted green, unrecorded stages dim. Position in this presentation rail is never completion evidence: execution may skip, revisit, or replace work.

   ```
   01 ac-compile   02 specify   03 plan   04 implement
   05 test         06 bounds    07 review 08 ship
   ```

   Each cell is the label line plus one detail line. Compact rail at 120 columns: `│ 3m12s · $0.42 │ edit  12m04s │ — │`; full board at 200 columns: `3m12s · $0.42 est.` under a DONE stage and `edit board.ts  12m04s` under the CURRENT one. Below the rail, the `NOW` row: `NOW implement  run 1  41 tools  ▸ edit board.ts  12m04s  $1.20  MODEL …`; its optional spans drop in the order `MODEL` → `▸ tool` → `run n` before anything truncates, and it reads `no node.started yet` before the first record. Height with activity: compact ≤ 11 lines at 120 columns, ≤ 14 at 100 (9 / 12 without); the full board at 200 stays one rail row plus `NOW`.

   **Inspecting a stage.** `/kpi status` opens Jobs; `↵` opens the existing technical details, where `j/k`, arrows or `1`–`8` select a stage. `↵` again opens its session and NODE panel; `esc` returns one level, `q` closes. `tab` always selects the next real job needing human action, not the next stage.

4. **Iteration loop**  
   `ROUND n` (a count, no maximum) · `RETRY k · <reason> · next <s>s` while a node backs off · last `output_fingerprint` short · PASS/FAIL on the last verifier.

5. **Human oversight box**  
   Present for genuine human intervention: parked `NEEDS_HUMAN` or an attended `RUNNING` gate whose interrupted graph carries an explicit pending question/human record. Use a warm border and the pending question (`approve intent?` / `commit?`). Automatic interruption, stale question/paused metadata on a running graph, and DONE/STOPPED are not human oversight. The accepted-experience summary lives in the intent dialog, not the board; the board row stays one line.

6. **File row**  
   The six run files as named lamps, lit only when the named file exists and is non-empty:

   `task.json  context.md  candidate.json  evidence.json  verdict.json  events.jsonl`

7. **Stop / status box**  
   One of `RUNNING | NEEDS_HUMAN <recovery> | DONE | STOPPED` — the run-state vocabulary. A status token an earlier release persisted is normalised to one of the four before it is drawn.

### Research state (drawn into region 2)

The context layer carries one research cell, so an operator can see **how** the current plan was researched without opening a file. It reads `research.json`. It is never model prose.

| `research.json` | Cell |
|---|---|
| `network.state: online` | `RESEARCH exa 4 src` — the service actually used and the external source count |
| `network.state: no-network`, `network.origin: operator` | `RESEARCH local · no-network operator` |
| `network.state: no-network`, `network.origin: engine` | `RESEARCH local · no-network engine · <network.reason>` |

The third row is the one that must not blend in. When the engine sets effective no-network after bounded, recorded provider failures and the planning model researches repository sources instead:

- The cell names `engine` as the origin and prints the recorded reason. A degraded round never renders like a healthy online round.
- The services that failed stay visible as struck marks from `network.failures[]` — `EXA ✕  PPLX ✕  FC ✕` for the services named there; when failures are recorded without a recognisable name every known mark is struck — not as missing lamps.
- Citations for that round are `sources[].kind: local`, so the board shows repo paths. An external URL on a no-network round is a defect, not a display choice.
- This is a display state, **not a stop state**. The stop box keeps exactly `RUNNING | NEEDS_HUMAN <recovery> | DONE | STOPPED`; `no-network` is never written into a persisted stop-state field and never drawn inside that box.

### Board B — warm intervention board (theme registration `protocol-blue`)

Same geometry as Board A. Genuine human intervention uses warm `#e9ad86`, including an attended live gate as well as parked `NEEDS_HUMAN`. Both historical theme registrations share the restrained dark/cool palette; the painter applies warm emphasis from current gate/status evidence, not from the theme name or an automatic repair pause.

Required extra copy on the human-intervention widget/board (the three laws belong on the printed board):

- Shared run-state file list (the six files)
- Stop box: `DONE / STOPPED / APPROVAL` (APPROVAL is a derived lamp, lit while the pause lasts, never a persisted status)
- Three laws, short:
  1. Outer loop owns the return path
  2. Shared files are the contract
  3. Irreversible effects stay outside the worker

Return to cool working emphasis when the runtime resumes. Automatic retry stays cool and does not become a human-action row.

### What this is not

- Not a chat bubble restating the stages
- Not a rainbow dashboard
- Not OMP’s splash Π logo as the loop overlay
- Not a web UI

The always-on widget and printed board retain recognizable Board A/B geometry under the new status colors. `/kpi status` opens Jobs first, then technical details/session. Footer stays the OMP-style bar with `K-π`.

### Command Centre — `/kpi status` overlay

Primary guidance is the actual imported `visual/k-pi-design/K-pi Command Center Wireframes.dc.html`, inspected in a browser: 4b home, 4c labelled input, 4d–4h intervention and lifecycle, 4i details, 4j help, 4k 80-column floor. `support.js` and `github.md` accompany the import. Older `design/claude-design/K-pi Command Centre.dc.html` and rendered text files guide the retained technical details/session panels, not the new home.

HOME is a single dark terminal Jobs list at 80, 108 and 120 columns. Genuine snapshots group as NEEDS YOU (`NEEDS_HUMAN`), RUNNING, DONE and separately STOPPED: cancelled work is never presented as completed. The selected job unfolds **Now / Next / Done**, with plain words above technical details. Missing summaries say that the runtime chooses the next step; no invented path, completion, agent count, fleet, spend or shipped PR. Completed steps require recorded completed activity. Retry/repair while `RUNNING` stays in RUNNING even if a stale pause flag exists.

Keys: `j/k` or arrows choose jobs on home and stages in details/session; `↵` opens details, then the session; `esc` clears input, dismisses help, returns one level, then closes; `tab` / `shift+tab` selects the next / previous actual human-action job from every view; `?` opens a help card that intercepts other navigation; `r` refreshes; `q` / `ctrl+c` closes. In details/session, `1`–`8` and `[ ]` walk stages. Keys are shortcuts only on empty input; begin with a space to type a shortcut letter.

Input labels describe the implemented destination, not aspirational wireframe behavior: **chat ›** closes and sends to the existing chat source; **command ›** accepts `/kpi stop` and `/kpi verify` for the opened job. A different selected fleet job must be opened before either command, preventing accidental actions on the wrong run. Other `/kpi …` and shell commands are refused. This slice does not claim direct steering, approval, new-job creation, revisions, or bounds recovery from this input; those require actual runtime action integration.

`CommandCentreSources.fleet` optionally supplies native discovery via `read(): Promise<readonly CentreJob[]>` and `open(jobId): Promise<void>`. Rows contain `jobId`, `model: BoardModel`, optional `title`, and optional recorded `now` / `next` / `done` summaries. The current source remains authoritative for its own duplicate row. Selection is stable by job id across refreshes; large lists scroll to keep its unfolded explanation visible. Opening another job closes the old overlay before invoking the source's open operation. The source must surface open failures. Without this hook, only the actual opened job appears. With it, the ticker remains live even when that job ends.

The retained details grid is two-column at ≥120 and stacked below, with sessions one level deeper. HOME never becomes a technical grid merely because the terminal is wider. The row budget is terminal rows minus three, with Now/Next/Done retained at 80 columns. At 140×50 all detail panels are visible; at 140×40 STAGES compacts so SHARED RUN STATE and CONTEXT LAYER stay visible. Below 80 the technical fallback retains STAGES, LIVE and EVENTS; the retained 60/160/200-column cases must not overflow. Narrow widget/printed-board layouts retain the current stage and STOP. Telemetry uses snapshot node summaries rather than rescanning full history on each repaint; round summaries are cached on refresh and event tails do not reverse-copy the full log.

Browser inspection of imported HTML is reference research only, **not terminal runtime proof**. Actual navigation and color proof at 80/108/120 and retained fallback widths/heights must be run after integration; no live inference proof is implied by fixture snapshots. The 1 s overlay ticker must recover from read errors, serialize slow reads, and continue native fleet discovery after the opened job ends or disappears; only a local-only source ends discovery with its sole job. Closing disposes the ticker.

---

## 3. Acceptance checks for visual work

- Idle footer leftmost cell is exactly `K-π` (unicode preset) or documented nerd/ascii equivalent.
- Footer includes model, thinking, path, context_pct. Git when in a repo.
- Subscription slots show `(sub)` not a fake dollar burn. Local slots show exactly `(local) $0`, with no quota percentage beside them.
- `/kpi status` opens truthful grouped jobs, with Now/Next/Done on selection and existing graph/file/telemetry/session details one keypress deeper; it refreshes while work runs.
- The widget's `NOW` row and stage detail lines change while a node runs without a keypress; the chat gets one line per node start/finish and none per tool call.
- Only authoritative human intervention gets warm emphasis; machine work and automatic repair remain cool. Historical theme registration names do not define status colors.
- The board tells online research, operator-set no-network, and engine-set no-network apart, and prints the recorded engine reason.
- `no-network` never appears in a persisted stop-state field or inside the stop box.
- No `π` without the `K-` prefix in our chrome.
- README links the X post and this file.

---

## 4. Local image files

```
docs/visual/kpi-board-amber-running.jpg     # historical graph/widget geometry; not running colors
docs/visual/kpi-board-protocol-pause.jpg    # historical human-board geometry; not paused colors
docs/visual/omp-statusbar-codemod.jpg       # OMP footer + last-request text
docs/visual/omp-statusbar-collab.jpg        # OMP footer with git + (sub)
```

Open the imported `visual/k-pi-design/K-pi Command Center Wireframes.dc.html` before changing home or interaction. Open the two `kpi-board-*.jpg` files for retained widget/detail geometry, not to restore old status colors; open the two `omp-statusbar-*.jpg` files before writing footer code. The X post is historical graph-board intent.

Note: the protocol reconstruction image labeled some stage rail nodes `init/validate`. Ignore those labels. Stage ids are always the amber-board eight: ac-compile, specify, plan, implement, test, bounds, review, ship.
