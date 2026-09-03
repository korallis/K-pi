# Visual targets — k-pi

Agents building the TUI must match these references. Do not invent a different board language.

## Source posts and files

| What | Where |
|---|---|
| Graph-engineering boards (the look of the loop overlay) | https://x.com/av1dlive/status/2092622516544270781 |
| Oh My Pi status bar (the look of the footer) | This folder: `visual/omp-statusbar-codemod.jpg`, `visual/omp-statusbar-collab.jpg` |
| OMP segment source (reference only, do not import) | https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/components/status-line/presets.ts |
| OMP brand icon source | `icon.omp` = `π` (unicode) / Nerd `U+F0D57` / ascii `pi` in oh-my-pi `symbols.ts` |

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

## 2. Graph-engineering TUI — the Avid boards are the product

This is not a garnish. The X post screenshots are the **operator TUI for graph engineering**. While a job runs, the user must see stage, mode, gate, files, loop result, and stop state without reading model prose.

### Honesty

Pi widgets will not reproduce the JPEGs pixel-for-pixel. That is not a failure.

Must be present: `K-π`, MODE, JOB, ROUND, stages 01–08 with current lit, PASS/FAIL, six file lamps, STOP; when paused, WAITING ON OPERATOR + the question.

May wrap, stack, or truncate on a narrow terminal. Current stage and STOP stay visible. Amber ≈ running, blue ≈ paused. Hex values in the reconstructions are guidance, not a screenshot test.

The always-on widget is the compact cut of Board A/B: header strip, one row of stage cells, the `FILES` lamp row, the LOOP/STAGE/NODE/GATE and ROUND/PASS/FAIL rows, the STOP box, the `NOW` row, and while paused the operator question and STOP STATES. `/kpi status` opens the Command Centre (below) over it. Below 70 columns the rows are flat but keep every field; the lamp row folds. Lamps are `●` lit / `○` dark; the iteration panel reads `PASS/FAIL PENDING` until a verdict exists.

While a node runs the board must change: a `NOW` row names the running node, its run number, tool count, last tool and target, elapsed and cost, refreshed from run files every second; the chat carries one line per node start, finish, retry and route change (`K-π ▶`, `K-π ■` / `K-π ✕`, `K-π ↻`, `K-π ⇄`) and none per tool call. Stage cells carry a detail line in both layouts — DONE `<elapsed> · <n> calls · $<cost> est.`, CURRENT `<tool> <target>  <elapsed>`, PENDING `—` — shrinking by form to the cell width, never wrapping the rail. Cost is an estimate, never a bill; `$—` when unknown.

Canonical post:

**https://x.com/av1dlive/status/2092622516544270781**

X did not expose the article images as downloadable media here. In-repo reconstructions agents must match:

- `visual/kpi-board-amber-running.jpg` — running board (amber)
- `visual/kpi-board-protocol-pause.jpg` — human-paused board (blue)

Open those two JPEGs before writing overlay or widget code. `/kpi status` and the always-on job widget **are** this board, drawn from `state.json` + run files. The model must not paint it as markdown.

The Oh My Pi bar is the **footer**. These boards are the **main informed-operator surface**.

### Board A — amber running board (theme `loop-amber`)

Dark charcoal field. Amber `#ff6a1a` rules and labels. Looks like a plant-floor panel, not a website.

Required regions, top to bottom:

1. **Header strip**  
   Product mark `K-π` · loop name · `MODE gated|autopilot` · job id.

2. **Context layer**  
   Short lines: product / structure / tech pack loaded. Not the full files. The layer also carries the live-session cell `AGENTS n · k nodes · w workers` (in-process node sessions plus worker processes for the live job; `AGENTS n` alone when the split is unknown); the `AGENTS <n>` prefix is the graded token. The §1 default footer is unchanged by it.

3. **Stages 01–08** as a numbered rail, current stage lit amber, completed dim green, future dim:

   ```
   01 ac-compile   02 specify   03 plan   04 implement
   05 test         06 bounds    07 review 08 ship
   ```

   Each cell is the label line plus one detail line. Compact rail at 120 columns: `│ 3m12s · $0.42 │ edit  12m04s │ — │`; full board at 200 columns: `3m12s · $0.42 est.` under a DONE stage and `edit board.ts  12m04s` under the CURRENT one. Below the rail, the `NOW` row: `NOW implement  run 1  41 tools  ▸ edit board.ts  12m04s  $1.20  MODEL …`; its optional spans drop in the order `MODEL` → `▸ tool` → `run n` before anything truncates, and it reads `no node.started yet` before the first record. Height with activity: compact ≤ 11 lines at 120 columns, ≤ 14 at 100 (9 / 12 without); the full board at 200 stays one rail row plus `NOW`.

   **Inspecting a stage.** `/kpi status` opens the Command Centre; `tab`/`↓`/`→` and `1`–`8` select a stage (`▸` marks it), `↵` opens its session view with the NODE panel (status, elapsed, `$… est.`, model, route) and the transcript, `esc` returns, `q` closes. The plan summary lives in the plan-approval dialog, not on the board.

4. **Iteration loop**  
   `ROUND n` (a count, no maximum) · `RETRY k · <reason> · next <s>s` while a node backs off · last `output_fingerprint` short · PASS/FAIL on the last verifier.

5. **Human oversight box**  
   Present whenever GATE is human. Amber border. Text: `HUMAN OVERSIGHT REQUIRED` and the pending question (`approve plan?` / `commit?`). The plan summary lives in the dialog, not the board; the board row stays one line.

6. **File row**  
   The six run files as named lamps, lit when the file exists:

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

### Board B — protocol-blue pause board (theme `protocol-blue`)

Same geometry as Board A. Accent flips to `#3da9fc` while a `human` node is paused.

Required extra copy on this board, from the source post:

- Shared run-state file list (the six files)
- Stop box: `DONE / STOPPED / APPROVAL` (APPROVAL is a derived lamp, lit while the pause lasts, never a persisted status)
- Three laws, short:
  1. Outer loop owns the return path
  2. Shared files are the contract
  3. Irreversible effects stay outside the worker

Switch back to amber when the human node resumes.

### What this is not

- Not a chat bubble restating the stages
- Not a rainbow dashboard
- Not OMP’s splash Π logo as the loop overlay
- Not a web UI

`/kpi status` and the always-on widget above the editor must be readable as Board A or Board B. Footer stays the OMP-style bar with `K-π`.

### Command Centre — `/kpi status` overlay

Source design: `design/claude-design/K-pi Command Centre.dc.html` (with `support.js`), rendered at 160×50 as `design/claude-design/command-centre.rendered.txt` (HOME) and `command-centre-session.rendered.txt` (SESSION); `design/claude-design/github.md` maps screens to files. Every value on it is something the run already writes; it is live while the job is `RUNNING` — re-read on the widget's 1 s tick, run files every fifth tick — and usable mid-run, because the loop runs detached from the `/kpi` handler.

Panels. HOME: header `K-π  COMMAND  › <job>` with `MODE … · ROUND n · GATE … · STOP <status>[ <recovery>] ⠙ <elapsed> · <clock>` on the right; left column STAGES (01–08, glyphs `✓` done / `⠙` running, advancing per tick / `○` pending / `✕` failed / `◉` waiting on the operator, per-stage elapsed right-aligned, a dim detail line per stage, `▸` on the selection) over SHARED RUN STATE (the six run files `●`/`○` with size, mtime and note; footer `FINGERPRINT … · ROUND n · VERIFIER …`); right column `LIVE › <NN stage>` (the stage's transcript tail, `⠙ live · following agents/<stage>/*.jsonl`), TELEMETRY (`$<x> est.  +$<y>/min` with a braille sparkline, CONTEXT, TOKENS, `TIME <elapsed>`, `ROUNDS` per-round elapsed, `STEPS n   NODE RUNS n   WORKERS w/cap`, `RETRY …` while backing off — never a cap token), CONTEXT LAYER (PACK, RESEARCH, K-STACK, AGENTS, ROUTE, POLICY); EVENTS across the bottom; then the input line and the key hint `tab/↑↓ select stage · enter open · esc close · r refresh`. SESSION (↵ on a stage): the STAGES rail (labels + glyphs, `← → switch node`, `esc  back`, ROUND / GATE / STOP / elapsed), the session transcript in the centre (`following · <elapsed>` while running), the NODE panel on the right (status, elapsed, `$… est.`, model, route, tokens).

Keys (both views): `tab`/`↓`/`→` next stage, `shift+tab`/`↑`/`←` previous, `1`–`8` jump, `↵` open the session, `esc` back or close, `q` close, `r` refresh now, `ctrl+c` close. The input line takes `/kpi stop` (the job's stop, once), `/kpi verify` (the verify line on the hint row), refuses other `/kpi …` and `!…` with a `K-π …` hint, and hands any other text to chat after closing.

Widths: two columns at ≥ 120 (200 and 160 are the reference renders, 120 the floor); one stacked column below 120; STAGES, LIVE and EVENTS only below 80; graded at 200, 120, 80 and 60 with no framed line wider than the terminal. Row budget: the overlay uses the terminal's rows less three. At 44 rows or more the two-column HOME shows the full STAGES panel (a detail line per stage); between 38 and 43 rows STAGES compacts to labels and glyphs so SHARED RUN STATE and CONTEXT LAYER stay on screen (the 40-row pty default keeps both); below that the second row of panels goes, and last the detail lines. `uat-16` drives 140×50. A run-file read that fails on open paints `EVENTS ✕ <code>` in the header and `K-π reading run files ✕ <code> · r to retry` in the body; the ticker retries it. When the job is gone the header reads `K-π no active job` and the ticker stops. THREE LAWS is printed-board text (`renderBoard`, print/rpc mode); the Command Centre does not carry it.

---

## 3. Acceptance checks for visual work

- Idle footer leftmost cell is exactly `K-π` (unicode preset) or documented nerd/ascii equivalent.
- Footer includes model, thinking, path, context_pct. Git when in a repo.
- Subscription slots show `(sub)` not a fake dollar burn. Local slots show exactly `(local) $0`, with no quota percentage beside them.
- `/kpi status` opens the Command Centre with MODE, ROUND, STAGE, GATE, the six file lamps, and a stop state; its TELEMETRY panel carries no cap token; it re-reads run files while the job runs.
- The widget's `NOW` row and stage detail lines change while a node runs without a keypress; the chat gets one line per node start/finish and none per tool call.
- Human pause changes accent to protocol-blue.
- The board tells online research, operator-set no-network, and engine-set no-network apart, and prints the recorded engine reason.
- `no-network` never appears in a persisted stop-state field or inside the stop box.
- No `π` without the `K-` prefix in our chrome.
- README links the X post and this file.

---

## 4. Local image files

```
docs/visual/kpi-board-amber-running.jpg     # graph TUI while the loop is running
docs/visual/kpi-board-protocol-pause.jpg    # graph TUI while waiting on the human
docs/visual/omp-statusbar-codemod.jpg       # OMP footer + last-request text
docs/visual/omp-statusbar-collab.jpg        # OMP footer with git + (sub)
```

Open the two `kpi-board-*.jpg` files before writing overlay/widget code. Open the two `omp-statusbar-*.jpg` files before writing footer code. Open the X post for intent.

Note: the protocol reconstruction image labeled some stage rail nodes `init/validate`. Ignore those labels. Stage ids are always the amber-board eight: ac-compile, specify, plan, implement, test, bounds, review, ship.
