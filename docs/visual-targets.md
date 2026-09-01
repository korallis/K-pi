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
6. **Cost or (sub)**
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
K-π  LOOP gated r2/3  STAGE implement  GATE human  AC 4/5  ROUTE anthropic/home
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
| `cost` | `$x.xx` or `(sub)` for subscription slots |
| `usage` | per-pool remaining if known, else omit |
| `kpi_job` | mode / round / stage / gate |
| `request` | last user text, 80 chars, right-aligned |

Commands: `/statusbar` toggle, `/statusbar preset default|compact|full`.

Do not depend on `pi-status-bar`, `pi-vitals`, `pi-powerline-footer`, or Oh My Pi at runtime. Read them. Write ours.

---

## 2. Graph-engineering TUI — the Avid boards are the product

This is not a garnish. The X post screenshots are the **operator TUI for graph engineering**. While a job runs, the user must see stage, mode, gate, files, loop result, and stop state without reading model prose.

### Honesty

Pi widgets will not reproduce the JPEGs pixel-for-pixel. That is not a failure.

Must be present: `K-π`, MODE, JOB, ROUND, stages 01–08 with current lit, PASS/FAIL, six file lamps, STOP; when paused, WAITING ON OPERATOR + the question.

May wrap, stack, or truncate on a narrow terminal. Current stage and STOP stay visible. Amber ≈ running, blue ≈ paused. Hex values in the reconstructions are guidance, not a screenshot test.

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
   Short lines: product / structure / tech pack loaded. Not the full files.

3. **Stages 01–08** as a numbered rail, current stage lit amber, completed dim green, future dim:

   ```
   01 ac-compile   02 specify   03 plan   04 implement
   05 test         06 bounds    07 review 08 ship
   ```

4. **Iteration loop**  
   `ROUND n / max` · last `output_fingerprint` short · PASS/FAIL on the last verifier.

5. **Human oversight box**  
   Present whenever GATE is human. Amber border. Text: `HUMAN OVERSIGHT REQUIRED` and the pending question (commit? / replan?).

6. **File row**  
   The six run files as named lamps, lit when the file exists:

   `task.json  context.md  candidate.json  evidence.json  verdict.json  events.jsonl`

7. **Stop / status box**  
   One of `RUNNING | DONE | BLOCKED | EXHAUSTED | NO_PROGRESS | UNSAFE | NEEDS_HUMAN`.

### Board B — protocol-blue pause board (theme `protocol-blue`)

Same geometry as Board A. Accent flips to `#3da9fc` while a `human` node is paused.

Required extra copy on this board, from the source post:

- Shared run-state file list (the six files)
- Stop box: `DONE / BLOCKED / APPROVAL`
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

---

## 3. Acceptance checks for visual work

- Idle footer leftmost cell is exactly `K-π` (unicode preset) or documented nerd/ascii equivalent.
- Footer includes model, thinking, path, context_pct. Git when in a repo.
- Subscription slots show `(sub)` not a fake dollar burn.
- `/kpi status` overlay contains MODE, ROUND, STAGE, GATE, the six file lamps, and a stop state.
- Human pause changes accent to protocol-blue.
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
