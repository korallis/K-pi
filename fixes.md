# fixes.md — K-π operator-experience fixes

> **Status: ACTIVE work queue for these four packages.** Same rules as `docs/remediation-plan.md`: one writer per file, scoped verification while in flight, full gates once before a PR. Package IDs here are `FX-##`. Every package edits the normative docs it changes behaviour for, in the same change.

## 0. Context

Three complaints from a live session on 2026-09-02, all reproduced from this repository's own run store (`.kpi/runs/`), plus a request to check upstream currency.

| # | Complaint | Root cause (verified in code) |
|---|---|---|
| 1 | The TUI looks nothing like the target boards | `src/kpi/extensions/board.ts` is pure string concatenation: no borders, no colour, no TUI component. The widget is installed with the `string[]` form of `setWidget`, which caps at 10 lines and paints plain `Text`. The footer's second line is every `setStatus` entry concatenated (accounts + kpi), so `ROUTE` prints twice. |
| 2 | It permanently asks for permission | `registerPolicy` is a built-in hook on every session. With no job it defaults to `mode: "gated"`; the safe list is 19 exact strings; any compound command (`;`, `&&`, `|`, `$(…)`, `${…}`) is categorically "unknown" → confirm. There is no "always allow" and nothing is remembered. |
| 3 | It always assumes a loop | `src/kpi/extensions/auto-wrap.ts` rewrites every bare message into `/kpi --mode gated <text>`. No triage exists. Goals on disk: `hi`, `apply`, a pasted bug report, a pasted error. Every one ended `UNSAFE` at round 0 in ~2 s because the plan node's mandatory `stack.json` contract cannot be met for a non-task. The dead job then stays pinned in the widget, footer and policy because `readActiveJob` has no liveness filter. |
| 4 | Upstream packages may be stale | Pi base and K-stack are current. npm dependencies match upstream Pi's pins exactly but the registry is far ahead. Decision taken 2026-09-02: **bump everything, majors included** (FX-04). |

The written contract currently *specifies* 2 and 3 — AGENTS.md hard rule "Bare non-slash text … is gated `/kpi`", `docs/spec.md` §4 line 133, `docs/PRD.md` US-24 + WF-00, `docs/uat.md` UAT-24, and US-13 AC-13.4 — so FX-02 and FX-03 amend those docs in the same change as the code.

## 1. Evidence

```
.kpi/runs/20260902-hi-9425e148/task.json        goal: "hi"   quality_gates: ["pnpm test","pnpm lint","pnpm typecheck"]   (npm repo)
.kpi/runs/20260902-hi-9425e148/state.json       status: UNSAFE  stage: plan  round: 0  elapsed_ms: 2059
                                                reason: "stack.json is missing; implement has no frozen map to read"
.kpi/runs/20260902-apply-cb28a3dc               goal: "apply"                                   → same UNSAFE
.kpi/runs/20260902-we-keep-hittin-a-loop-…      goal: "we keep hittin a loop failure ENAMETOOLONG" → same UNSAFE
.kpi/runs/20260902-error-k-loop-failed-…        goal: "Error: K-π loop failed: ENAMETOOLONG …"  → same UNSAFE
```

- `events.jsonl` of the finished `hi` job keeps receiving `tool.request … node: "plan" … "Approve unrecognized command"` records 45 s after its `loop.terminal` — those are the operator's unrelated chat session being tagged with the dead job's node.
- ENAMETOOLONG: `control-plane.ts` `handleKpiCommand` probes `.kpi/runs/<raw args>/task.json` to detect a resume id and rethrows anything but ENOENT.
- The board showed `FAIL` at round 0 because `verifierLabel` prints FAIL whenever `passed` is false, even before any verifier ran.
- The plan node is specified read-only (`read, grep, find, ls`) yet the session in front of the operator was running bash under node `plan` — because the *main* session's tool calls are attributed to whatever run is newest on disk.

## 2. Upstream audit (2026-09-02)

| Source | Pinned | Latest | Verdict |
|---|---|---|---|
| Pi (`upstream.json`) | v0.84.4 @ `b79e4cc` | v0.84.4 is the latest tag; `main` is 21 commits ahead (`e266507`), all untagged | **Current.** `npm run upstream:check` exit 0. Next Pi tag is a reviewed merge per UPSTREAM.md §6, not part of this queue. |
| K-stack (`kstack/UPSTREAM.md`) | pstack `efa2a53` (2026-09-02) | same commit | **Current.** `npm run kstack:status`: local pin honest, remote current. |
| `npm audit --omit=dev` | — | 0 vulnerabilities | clean |
| npm dependencies | identical to upstream Pi `main` pins | many majors behind (table in FX-04) | **Stale by policy choice; bumping (FX-04).** |

Workspace defect found during the audit: `packages/evals/package.json` still declares `@earendil-works/pi-coding-agent: "^0.84.4"` although the workspace is `0.1.0`; `npm ls` reports it `invalid`. UPSTREAM.md §6 claims this was patched to `^0.1.0`. Fixed in FX-04.

## 3. Packages

Dependency order: **FX-03 first** (it adds `readLiveJob`, which FX-01 and FX-02 consume), then FX-01 and FX-02 in parallel (disjoint files), then FX-04 last (it touches every manifest and reruns the whole gate).

```text
FX-03 routing + run-store liveness
  ├─ FX-01 board + footer
  └─ FX-02 policy
FX-04 dependency refresh (after the three above are merged)
```

---

## FX-01 — Board and footer: framed, themed operator board; one-line footer status

**Depends on:** FX-03 (`readLiveJob`)  
**Stories:** US-06, US-15, US-16, US-25 (AC-06.1–06.3, AC-16.1–16.6, AC-25.1–25.4)  
**Owns files:** `packages/coding-agent/src/kpi/extensions/board.ts`, new `board-frame.ts`, new `board-component.ts`, `control-plane.ts` (board/widget/overlay parts only), `status-line/index.ts`, `status-line/segments.ts`, `test/operator-ui.test.ts`, `test/status-line.test.ts`, `test/control-plane.test.ts`, `docs/spec.md` §11, `docs/visual-targets.md` §2, `scripts/pty-rows/FINDINGS.md`, README links.

### Read first

- `docs/visual-targets.md` §2 and the two `docs/visual/kpi-board-*.jpg` (open them); `docs/spec.md` §11 (L449-535); `docs/PRD.md` US-16/US-25
- `board.ts` (all 434 lines), `control-plane.ts` L190-340, `status-line/index.ts` L180-285, `status-line/segments.ts`, `core/footer-data-provider.ts:157` (`getExtensionStatusLine`)
- `core/extensions/types.ts:182-187` (`setWidget` string[] vs factory form); `interactive-mode.ts:2223-2263` (factory form is not capped at 10 lines); `packages/tui/src/tui.ts:23` (`Component`), `:126` (`overlayOptions`); `packages/tui/src/utils.ts` (`visibleWidth`, `truncateToWidth`, `stripTerminalSequences`, `wrapTextWithAnsi`)
- `modes/interactive/theme/theme.ts:847`: the `theme` handed to widget factories is a Proxy over the live theme, so after `setTheme("protocol-blue")` the same object yields blue and `invalidate()` repaints
- Raw-byte graders `scripts/pty-rows/uat-06/16/25.mjs`: they search terminal bytes for contiguous tokens (`STOP RUNNING`, `MODE gated`, `JOB <id>`, `ROUND n/m`, `LOOP <job>`, `NODE <id>`, `WAITING ON OPERATOR`, `APPROVAL`), so a label and its value must always sit inside one colour span

### Change

1. **Region model** (`board.ts`, stays pure and import-light). `Span { text; tone? }`, `Row = Span[]`, regions `Strip | Panel | CellRow` with ids `header | telemetry | contextLayer | stages | iteration | oversight | lamps | stop | sharedRunState | stopStates | threeLaws | waiting | stageRail`; `buildBoardRegions(model) → { variant: "amber"|"blue", regions, byId }`; `flattenRegions` + `rowText` give the frame-less text; `renderBoard(model)` becomes flatten + `fitBoard` (kept for tests and non-TUI); `fitBoard` keys essentials off region ids instead of string prefixes and measures with `visibleWidth`. Delete `fitBoardHeight`/`ROW_PRIORITY`. `BoardModel` gains `verifier: "pass"|"fail"|"pending"` and `gate: "human"|"machine"`. Header strip: `K-π GRAPH CONTROL │ MODE gated │ JOB <id> │ ROUND n/m [│ K-STACK on]` (the duplicated `LOOP <id>` moves to the telemetry row `LOOP <id>  STAGE 04 implement  NODE implement  GATE machine`). Stage cells: `04 / implement / CURRENT|DONE|PENDING`. Iteration: `ROUND n/m`, `PASS ● … / FAIL ○ …`, or `PASS/FAIL PENDING` before any verdict exists, `FINGERPRINT …`. Oversight panel (accent border) whenever gate is human. Lamps: six cells `name / ■ / ON` lit or `name / ▪ / DIM`. Stop box: one span `STOP <STATE>` (warning RUNNING, success DONE, error BLOCKED/UNSAFE/EXHAUSTED/NO_PROGRESS, accent NEEDS_HUMAN). Board B: header `K-π PROTOCOL │ MODE │ JOB │ ROUND │ NODE human-confirm │ GATE approval`, `STAGE RAIL`, `SHARED RUN STATE` (`● READY`/`○ MISSING`/`● APPEND`), `STOP STATES` cells with APPROVAL lit while paused, `THREE LAWS`, `WAITING ON OPERATOR <question>` (accent border). Keep `K-STACK on` on flat line 0 (`test/runtime-milestone.test.ts:106`).
2. **Painter** (`board-frame.ts`, new; no I/O). `BoardPalette { paint(tone, text) }`, `PLAIN_PALETTE` (identity), `paletteFromTheme(theme)` mapping tones to the nine `ThemeColor` keys that exist in both K-π themes (`accent borderAccent border success warning error dim muted text`). `paintBoard(model, { width, layout: "compact"|"full", palette?, frameMinWidth = 70, columnsMinWidth = 100 })`, plus exported internals `framePanel`, `frameCells`, `frameStrip`, `sideBySide`, `paintFlat`. Rules: measure plain text only, colour finished padded segments (ANSI never enters arithmetic); every line padded to exactly `width`; width < 70 → coloured flat rows truncated with `…`; cell rows pack `perRow = max k` that fits, rebalance so 8 stages at 80 cols are 4+4 (not 6+2), stretch cells to fill, join rows with `├┼┤`; two-column regions (`iteration | oversight`, `sharedRunState | stopStates + threeLaws`) only at ≥ 100 cols, 40/60 split; stop box right-aligned, in compact layout drawn beside the telemetry rows; header overflow truncates the JOB id first, never MODE/ROUND; glyphs `┌ ─ ┐ │ └ ┘ ├ ┼ ┤ ┬ ┴`, border tone `border`, lit cells `borderAccent`, titles accent. Compact layout target at ≥ 100 cols: header (1) + stage cells (4) + lamp cells (3) + telemetry/stop block (3) = 11 lines, 12 when paused.
3. **Component** (`board-component.ts`, new). `createBoardComponent(model, { layout, palette, onDispose }) → Component & { refresh(model); dispose() }` with a render cache keyed by width and model, cleared on `invalidate()` (theme swap) and `refresh`. No timers, no I/O.
4. **Control plane.** `buildBoardModel` uses `readLiveJob`; derives `gate` and `verifier` (`passed === true` → pass; `passed === false && verdict.json lit` → fail; else pending). `installWidget` installs the factory form: `ctx.ui.setWidget("kpi", (tui, theme) => createBoardComponent(model, { layout: "compact", palette: paletteFromTheme(theme) }))`, or `setWidget("kpi", undefined)` when there is no live job. `showStatus`: TUI → `ctx.ui.custom` overlay with the full-layout component using the real `theme` argument, `overlayOptions { width: "92%", maxHeight: "90%", anchor: "center" }`, any key closes; non-TUI → notify the flat board; no live job → notify `no active job` plus `— last job <id> <STATUS>` when `readActiveJob` finds a finished one. Drop the `EXTENSION_WIDGET_MAX_LINES`/`fitBoardHeight` imports. `stopJob` keeps calling `installWidget`, which now clears the widget.
5. **Footer.** `segments.ts` gains `formatStatusRow(statuses, preset)`: keys sorted, `accounts` dropped unless preset is `full`, newlines collapsed, `undefined` when empty. `installFooter.render` uses it instead of `getExtensionStatusLine()`, so default/compact line 2 is exactly `K-π LOOP gated r0/3 STAGE plan GATE machine [AC n/m] ROUTE …` with ROUTE once; `full` embeds the job fields in the rail and prints the accounts summary on line 2. `loadKpiJobFields` returns `undefined` for a finished job so the `kpi` status clears. Move `isPausedHuman` into `run-store.ts` next to `isLiveJob` to avoid a status-line ↔ control-plane import cycle. `formatKpiJob`, `assembleFooter`, `accounts/index.ts` unchanged.
6. **Tests.** Keep every map-bound title verbatim (operator-ui: "amber board lights exactly one CURRENT stage and six nonempty file lamps", "empty run files keep lamps dark", "protocol-blue pause derives APPROVAL lamp without persisting APPROVAL status", "research cells distinguish online operator and engine no-network", "narrow width keeps CURRENT stage and STOP visible", "board and status rendering never call a model client", "BUS lamp tracks bus.jsonl history independent of AGENTS count", "sticky kMode alone does not light K-STACK on for an active job without freeze"; status-line: "unicode brand is K-π and never bare pi", "default segment order matches the visual contract", "cost cells cover oauth local and api_key kinds", "context colors follow the required thresholds", "end-to-end footer assembly covers every account kind presets job route usage", "formatKpiJob is the documented second line shape", "registered footer full preset embeds kpi job fields and refreshes after state change"). Update glyph assertions `●`→`■`, `○`→`▪` for file lamps only; measure with `visibleWidth`. New: "the framed board keeps every required field at 200, 120, 80 and 60 columns" (full and compact; framed lines are exactly `width` wide; `┌` at 200/120 with one stage row, two rows at 80, no frame at 60); "colour never enters the width math" (ANSI palette output stripped equals plain output); "tones: the current stage and lit lamps are accent, done stages success, pending dim" (spy palette); "a paused board is the protocol variant with APPROVAL lit"; "the compact widget is at most 12 lines at 100 columns and keeps STOP and the lamps" (replaces the two `fitBoardHeight` tests); "PASS/FAIL reads PENDING until a verdict exists". control-plane: fake `setWidget` accepts the factory form and renders it at 120; "a finished job is not pinned above the editor". status-line: rewrite "the registered footer draws the extension statuses it took over" (one ROUTE, no ACCOUNTS by default, ACCOUNTS under `preset full`); "the job line is hidden when the newest job is finished"; pure `formatStatusRow` test. Run `test/traceability.test.ts` to confirm no bound title moved.
7. **Docs (same change).** `docs/spec.md` §11 Widgets block → compact widget description + "`/kpi status` is the full framed board in a `ctx.ui.custom` overlay". `docs/visual-targets.md` §2 Honesty: the widget is the compact cut of Board A/B, `/kpi status` the full board, below 70 columns rows are flat but keep every field; note ■/▪ lamps and `PASS/FAIL PENDING`. `scripts/pty-rows/FINDINGS.md` §1 note. README: add the X post and `docs/visual-targets.md` links that §3 of that doc requires (currently missing).

### Verification

```bash
node --test --experimental-strip-types test/operator-ui.test.ts test/control-plane.test.ts test/status-line.test.ts test/runtime-milestone.test.ts test/traceability.test.ts
npm run check && npm run test:kpi
# eyeball: a scratch script printing paintBoard(model, {width, layout}) for 200/120/80/60, amber and blue, PLAIN_PALETTE
npm run build:offline
# live: in a repo whose newest run is RUNNING → framed amber widget; /kpi status → full overlay; set graph_status=interrupted + pending_question → blue; resize to 80 and 60 cols
node scripts/pty-rows/uat-16.mjs && node scripts/pty-rows/uat-06.mjs && node scripts/pty-rows/uat-25.mjs
```

### DoD

- [ ] Widget and `/kpi status` are framed, themed Board A/B; every AC-25.1 field present at 200/120/80/60 columns; STOP and current stage never truncated
- [ ] Pause flips to protocol-blue with APPROVAL lit; resume flips back; the widget repaints without a restart
- [ ] No finished job is drawn above the editor; footer line 2 is a single job line with ROUTE once
- [ ] pty graders and the four test files pass; map-bound titles unchanged

---
## FX-02 — Policy: chat scope, read-only classifier, remembered approvals, liveness

**Depends on:** FX-03 (`readLiveJob`)  
**Stories:** US-13; AC-13.1–13.4 unchanged for job scope; new AC-13.5, AC-13.6  
**Owns files:** `packages/coding-agent/src/kpi/extensions/policy.ts`, new `packages/coding-agent/src/kpi/extensions/shell-classifier.ts`, `packages/coding-agent/src/kpi/templates/policy.json`, `test/policy.test.ts`, new `test/shell-classifier.test.ts`, the two `resolveActiveWriteAllow` copies (`kpi/extensions/index.ts:25-37`, `kpi/extensions/graph/engine.ts:471-483`), `scripts/generate-traceability-map.mjs`, docs listed below.

### Read first

- `docs/spec.md` §12 (L535-568) and §7 node tool policy (L376-390); `docs/PRD.md` US-13 (L215-222); `docs/uat.md` UAT-13
- `policy.ts` L40-140 (types, safe list, composition pattern), L448-533 (`resolveActivePolicyState`, `evaluateCommand`), L535-553 (`evaluateWrite`), L614-680 (`recordToolRequest`, `registerPolicy`)
- `test/policy.test.ts` L27-102 (fixtures/hook harness), L302-345, L370-385, L541-600, L755-855
- Dialog primitives: `core/extensions/types.ts` `ExtensionUIContext.select(title, options) → Promise<string|undefined>` (TUI + RPC; print returns `undefined`), `confirm`, `notify`

### Facts that shape the change

- Today every `write`/`edit` in plain chat is denied too (`writeAllow: []` with no job; test L590 pins it). Chat scope must drop bounds, not only prompts.
- Node tool policy is already enforced three ways in `graph/engine.ts` (L48/L224-229 graph-load check, L845 `excludeTools`, L861-869 post-creation check); bash cannot reach `plan`. The bash calls attributed to `plan` in the evidence were the *main* session tagged with a dead job. No engine change.
- `docs/traceability-map.json` is generated by `scripts/generate-traceability-map.mjs` (AC table ~L380-400, owner table ~L1226). Never hand-edit the JSON. Existing US-13 test titles bound in the map must survive verbatim.
- Both `resolveActiveWriteAllow` copies *override* `resolved.writeAllow` in the hook (policy.ts L652-655); they must use the live reader and the override must be skipped in chat scope.

### Change

1. **`shell-classifier.ts` (new, no imports from policy.ts).** `classifyShellCommand(command): { readOnly: true } | { readOnly: false; reason; segment? }` and `isReadOnlyShellCommand`. Tokenizer handles quotes, `$(…)`/backticks (recursed), `( )` subshells, `{ }` groups, operators `; && || | |& ;;`, redirects; heredocs, here-strings, process substitution, `&` background and unbalanced input → not read-only. Split into simple commands; control words (`if then else elif fi for in do done while until case esac { } ! [ ] [[ ]] test true false : set exit cd`) are read-only; leading `NAME=value` stripped; wrappers `env command xargs timeout time nice` recurse on the wrapped command (`command -v x` and bare `env` allowed outright). Per-head refinement table: `cat head tail less more grep egrep fgrep rg ls pwd echo printf wc uniq cut tr diff file stat du df which whereis type printenv uname whoami id basename dirname realpath readlink jq` always; `find` without `-exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls`; `sort` without `-o`; `sed` only with `-n` and no `-i`/`w`; `awk` without `-i`/`system(`/`>`/`|`; `git` verbs `status log diff show rev-parse ls-files ls-remote`, `branch` list-only flags, `remote` (none/`-v`/`show`/`get-url`), `config --get|--get-all|--get-regexp|--list`, never `--output`; `npm ls|list|view|info|outdated|--version` and `audit` without `fix`; `node --version|-v` only; any head with exactly one arg `--help`/`--version`. Redirects allowed only `2>&1 1>&2 >/dev/null 1>/dev/null 2>/dev/null &>/dev/null </dev/null`. Whole command is read-only iff every segment is. `node <file> --help` is deliberately **not** read-only (executes project code): allowed in chat scope, confirms inside a gated job.
2. **`policy.ts` schema.** `PolicyMode = "chat" | "gated" | "autopilot"`. `PolicyConfig` gains `allow: string[]` and `commit.chat`/`unknown.chat` (`"allow" | "confirm"`, default `"allow"`). `DEFAULT_ACTIVE_POLICY_STATE.mode = "chat"`; new `UNREADABLE_JOB_POLICY_STATE` (gated, unbounded) for a live job whose task.json will not parse. `normalizePolicy(raw, source)` supplies defaults for files that predate the keys; `readPolicy` never writes (missing file → `DEFAULT_POLICY_CONFIG`); `session_start` seeds `.kpi/policy.json` only when `cwd/.kpi` or `cwd/.git` exists; `rememberAllowedCommand(cwd, command)` appends the whitespace-collapsed command via `atomicWrite`. Template `templates/policy.json` must deep-equal `DEFAULT_POLICY_CONFIG` (test guard). Delete `SAFE_COMMANDS`; keep `SHELL_COMPOSITION_PATTERN` only for `isStandaloneGitCommit`.
3. **Evaluator order** (`evaluateCommand`): deny list → protected run artifacts → secret-shaped path → write targets vs bounds (**skipped in chat**) → standalone `git commit` (chat: `commit.chat`; gated: confirm with diff stat; autopilot: release gate) → exact `quality_gates` → `isReadOnlyShellCommand` → exact `policy.allow[]` → unknown (chat: `unknown.chat`; gated: confirm; autopilot: deny). The confirm question includes the classifier's reason (`Not read-only: unknown head "curl …"`) and carries `command` (collapsed) for remembering; commit confirms carry no `command`. `evaluateWrite` in chat denies only secret-shaped/protected paths.
4. **Hook.** `resolveActivePolicyState` and `recordToolRequest` use `readLiveJob`; the `resolveWriteAllow` override applies only when mode ≠ chat; both `resolveActiveWriteAllow` copies switch to `readLiveJob`. Confirm flow: session cache (`Set` keyed `cwd\0command`, injectable for tests) → `ctx.ui.select(title, ["Allow for this session", "Always allow in this project", "Deny"])` (fallback to `confirm` when `select` is absent; `undefined` = deny) → `once` caches; `always` caches + `rememberAllowedCommand` + `notify`; `deny` blocks with the existing `/unrecognized command/` decline reason. Keep the literal title `Approve unrecognized command`.
5. **Tests.** `test/policy.test.ts`: fixture gains `allow`/`chat` keys; L321 becomes "read-only inspection commands are allowed whatever their arguments, in both job modes" (`ls -la /etc`, `git log --oneline --all`, `git diff --stat -- src`, `git status; whoami` → allow); L335 becomes "a composition is only as safe as its least safe segment" (`npm test && npm run lint` still confirm/deny, `git status && ls -la` allow, `git status && cat .env` deny, `ls | tee /tmp/out` confirm/deny, `find … -exec rm` confirm/deny, `sed -n` allow vs `sed -i` confirm); L378 → "without a live job the resolved state is chat scope; an unreadable live job falls back to gated"; L582 split into chat-scope (reads/writes/commits run, push and `.env` still blocked) and live-gated-commit-prompts-with-diff-stat. New: "chat scope never confirms but keeps every hard deny" (AC-13.5), "the two commands that prompted in ordinary chat are allowed", "a finished job never puts chat into a job mode or receives its tool requests", "an operator can allow a command for the session, and the same command does not ask again", "always allow persists to policy.json allow[] and is honoured by a fresh session" (AC-13.6), "a declined or cancelled approval blocks the call", "the policy file is seeded only in a project directory". New `test/shell-classifier.test.ts` table-driven (read-only heads/control words; mutating/executing/writing forms; recursive substitutions). Generator: add AC-13.5/13.6 rows (owner RP-02) and regenerate the map.
6. **Docs (same change).** `docs/spec.md` §12 new default JSON + "Scopes" paragraph + classifier wording; §7 `test` row "bash (quality_gates + AC commands + read-only inspection)". `docs/PRD.md` US-13 add AC-13.5 (chat scope never confirms; hard denies stay) and AC-13.6 (three-way approval; *Always* persists to `allow[]`). `docs/uat.md` UAT-13 action/evidence for chat scope and remembered approval. `docs/remediation-plan.md` RP-02 bullets/DoD. `README.md` permissions paragraph (~L761).

### Verification

```bash
node --test --experimental-strip-types test/shell-classifier.test.ts test/policy.test.ts
node --test --experimental-strip-types test/run-store.test.ts test/graph-engine.test.ts test/bus.test.ts
node scripts/generate-traceability-map.mjs && node --test --experimental-strip-types test/traceability.test.ts
npm run check
# real artifact: build, then in a scratch git repo with no job run the two commands from §1 through the agent → no dialog;
# ask for `git push origin main` → "Policy denied command"; inside a gated job pick "Always allow" → .kpi/policy.json allow[] gains it; restart → silent.
```

### DoD

- [x] Plain chat never prompts; AC-13.1 denials and secret/reserved paths still deny — `test/policy.test.ts` "chat scope never confirms but keeps every hard deny", "with no live job the hook is chat scope…"; built bundle in a scratch git repo (`--mode json`, no job): `printf '%s\n' "${HOME:-}"; command -v node || true` and `node --version | head -n 1` executed with zero prompt events, `git push origin main` blocked with `Policy denied command`
- [x] Gated job: read-only compositions run silently; unknown commands ask once with a three-way choice; *Always* persists — `test/shell-classifier.test.ts` (4 tests), `test/policy.test.ts` "read-only inspection commands are allowed whatever their arguments…", "a composition is only as safe as its least safe segment", "an operator can allow a command for the session…", "always allow persists to policy.json allow[]…", "a declined or cancelled approval blocks the call"
- [x] A finished job neither sets policy mode nor receives tool.request records — "a finished job never puts chat into a job mode or receives its tool requests"; the write-bounds override is skipped in chat scope
- [x] Traceability map regenerated; AC-13.5/13.6 bound to real tests — `docs/traceability-map.json` 319/319 covered

**Landed 2026-09-02 on branch `fx/02-policy`.** Gates: `npm run check` green, `npm run test:kpi` 663/663, `packages/coding-agent` policy vitest 4/4, `npm run build:offline` green. Policy files are now seeded only in a project directory (`.kpi/` present or a git root).

---
## FX-03 — Smart routing: bare text is chat, the agent starts jobs, dead runs stop haunting the session

**Depends on:** —  
**Stories:** US-24 rewritten (AC-24.1–24.4), US-08 AC-08.3 (quality gates) unchanged, US-13 liveness  
**Owns files:** new `packages/coding-agent/src/kpi/extensions/routing.ts` (replaces `auto-wrap.ts`, which is deleted), `settings.ts`, `control-plane.ts`, `run-store.ts`, `gated-loop.ts`, `graphs/coding-loop.gated.json`, `templates/APPEND_SYSTEM.md`, `extensions/index.ts`, `test/runtime-milestone.test.ts`, `test/run-store.test.ts`, `test/gated-loop.test.ts`, `test/control-plane.test.ts`, `scripts/generate-traceability-map.mjs`, docs listed below.

### Read first

- `auto-wrap.ts` (27 lines), `settings.ts` L1-80, `control-plane.ts` L391-452, `run-store.ts` L380-423, `gated-loop.ts` L38, L160-290 (`parseLoopInvocation`, `makeJobId`, `qualityGates`), L995-1021 (plan catch), L1337-1470 (`runLoop`)
- `core/extensions/types.ts`: `registerTool` (L1338), `ToolDefinition.promptSnippet`/`promptGuidelines` (L468-471), `sendUserMessage` (L1400-1408), `agent_end` (L765)
- `core/agent-session.ts` L1177-1186 and L1596-1601: `prompt()` executes extension commands **immediately, even while streaming**, so `deliverAs: "followUp"` does not defer `/kpi …`
- `bus/identity.ts:121 hasWorkerDescriptor` (bus workers load the full built-in; graph nodes do not: `graph/engine.ts:485-515`)
- `append-system.ts` L56-70: `APPEND_SYSTEM.md` is install-once; an existing copy is never refreshed
- `scripts/generate-traceability-map.mjs` L712-731 (AC-24 block); `docs/traceability-map.json` is generated, never hand-edited
- `schemas/task.schema.json` root `additionalProperties: false` (no new task fields)

### Change

1. **Settings** (`settings.ts`). Delete `autoWrapState`. Add `ROUTING_MODES = ["auto","always","off"]`, `routingState: { override?: RoutingMode }` (session override), `KpiSettings.routing` (default `"auto"`), `readKpiSettings(projectRoot, agentDirectory = getAgentDir())` reading project `.kpi/settings.json` top-level `routing` over user `~/.kpi/agent/settings.json` `{"kpi":{"routing":…}}` (Pi's SettingsManager preserves unknown top-level keys), and `resolveRoutingMode(projectRoot)` = override ?? settings.
2. **`routing.ts` (new).** `registerRouting(pi, { env?, agentDirectory? })`:
   - `input` handler: transform bare text into `/kpi --mode gated <goal>` **only** when routing is `always`, text is non-empty and not a command, and no live job (`commandForGoal` collapses whitespace so multi-line goals cannot reach the run store as a path).
   - Tool `kpi_start_job` `{ goal: string (≥12 chars), mode?: "gated"|"autopilot", reason: string }`, `executionMode: "sequential"`, with `promptSnippet` and `promptGuidelines` carrying the routing rule (that is the load-bearing prompt surface because APPEND_SYSTEM.md is install-once). Skipped when `hasWorkerDescriptor(env)` or `registerTool` is unavailable, so bus workers never hold it; graph nodes never see K-π tools anyway. `execute`: routing `off` → throw "K-π routing is off; the operator starts jobs explicitly with /kpi <goal>"; `refuseGoal` (too short, greeting regex, pure question regex) → throw with the reason so the model answers directly; live job → throw "K-π job <id> is live; steer it with plain text or /kpi stop" (AC-24.3); already queued → throw; else `kModeState.enabled = true`, `dispatchState.pending = { goal, mode, reason, text }`, notify "K-π job queued: <goal>", return text "K-π job queued for: … It starts when this turn ends; finish your reply in one short sentence and do not call kpi_start_job again."
   - `agent_end` handler drains `dispatchState.pending` with `pi.sendUserMessage(text, { expandPromptTemplates: true })`. Comment why: `prompt()` runs slash commands immediately regardless of `deliverAs`, so dispatching inside the tool would nest the loop in the tool call.
   - `index.ts`: replace `registerAutoWrap(pi)` with `registerRouting(pi)`.
3. **Routing rule text** (tool guidelines + new paragraph in `templates/APPEND_SYSTEM.md`; README tells existing installs to run `/append-system`):
   > Routing. A bare message is ordinary chat. Answer directly, with tools as needed, when the operator asks a question, greets you, wants an explanation or an investigation, asks for a quick or single-file edit, or invokes a skill. Call kpi_start_job only for substantial engineering work: a feature that touches several files, work that needs tests, review and a commit, anything the operator calls a task, feature or plan, or when they ask for the loop. Never call kpi_start_job for greetings, questions, pasted logs or error messages, or while a K-π job is live; if it refuses, answer directly. After it queues a job, end your reply in one sentence.
4. **Control plane.** `/kpi off|auto|always` set `routingState.override` with a one-line notify each. Resume probe only when `JOB_ID_PATTERN.test(command)`; tolerate `ENOENT | ENAMETOOLONG | ENOTDIR`; otherwise go straight to `runLoop(parseLoopInvocation(command))`. `installWidget` and `buildBoardModel` switch to `readLiveJob`; `showStatus`, `stopJob`, `verifyJobLog` keep `readActiveJob` (last job).
5. **Run store.** Extract `stateCandidates(cwd)` (newest first) and add `readLiveJob(cwd)` = newest candidate whose status is not terminal. Live-only call sites: `control-plane.ts:198, 301`, `status-line/index.ts:82`, `policy.ts:449, 621`, `extensions/index.ts:26`, `graph/engine.ts:472` (FX-02 owns the policy edits; FX-01 the status line). Leave `readActiveJob` for status/stop/verify/resume, `research/index.ts:38`, `bus/communicate.ts:307`, `accounts/index.ts:713`.
6. **Gated loop robustness.** (a) `detectQualityGates(projectRoot) → { commands, source: "agents-md"|"package-scripts"|"none", reason }`: AGENTS.md "Quality gates" block first (AC-08.3), else package manager from `packageManager` field / lockfile (`package-lock.json`→npm, `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `bun.lock*`→bun) and only scripts that exist (`test`, `lint`, first of `typecheck`/`check`), else `[]` with a reason written into `context.md` and a warning notify. Delete `DEFAULT_QUALITY_GATES`. (b) Plan catch keeps the `stack.json is missing` prefix (pinned by `test/gated-loop.test.ts:570` and `test/dune-fixtures.test.ts:47`, which pins the *stack.ts* message and must not change) but appends the real cause: `stack.json is missing: plan response was not valid stack.json JSON after N attempts (<validation errors>)`. (c) `coding-loop.gated.json` plan node `retries: 1 → 2` (grep `"retries"` in test/ first). (d) `makeJobId` already truncates; no other raw-text path remains after 4.
7. **Tests.** Replace "bare goals wrap while commands and active-job follow-ups do not" with four titled tests, one per AC: "bare text stays plain chat and the agent starts a K-π job through kpi_start_job" (input continues; tool queues `/kpi --mode gated <goal>`; `agent_end` sends it once with `expandPromptTemplates: true`), "routing always wraps bare goals but never commands", "a live job owns bare follow-ups and kpi_start_job refuses to start a second one", "kpi off, kpi.routing off, and worker sessions leave no automatic job start" (also refuses `hi`, `apply`, `why does the build fail?`). `test/run-store.test.ts`: "the live job skips finished runs and is absent when every run has ended". `test/gated-loop.test.ts`: "quality gates come from AGENTS.md, then the package manager's own scripts, then nothing"; "a plan that never returns stack.json ends UNSAFE with the validation cause". `test/control-plane.test.ts`: "a long or multi-line goal is never probed as a job id"; "kpi auto, always and off set the session routing override". Settings test for project-over-user precedence. Rebind AC-24.1–24.4 in the generator and regenerate the map.
8. **Docs (same change).** `AGENTS.md` hard rule line 54 → "Bare non-slash text is plain harness input. The agent starts a K-π job for substantial work through `kpi_start_job` (`kpi.routing = auto`, default); `/kpi always` restores wrapping; `/kpi off` or `kpi.routing = off` leaves only explicit `/kpi`, `/loop`, `/k-mode`. Commands are never wrapped; a live job owns bare follow-ups." `docs/spec.md` §4 bare-text row + `/kpi auto|always|off` row + `kpi_start_job` note (parent session only) + `kpi.routing` setting. `docs/PRD.md` US-24 retitled "Bare message is plain chat; the agent starts a K-π job for substantial work" with AC-24.1–24.4 restated; WF-00 gains the `hi → answered directly, no run directory` line. `docs/uat.md` UAT-24 action/evidence (`hi`, a question, a real goal → exactly one run dir; follow-up → none; `/kpi off` → chat). `README.md` L395-397. Passing mentions in `docs/roadmap.md:95`, `docs/implementation-plan.md:607-617`.

### Verification

```bash
node --test --experimental-strip-types test/runtime-milestone.test.ts test/run-store.test.ts test/control-plane.test.ts test/gated-loop.test.ts test/concise-output.test.ts test/dune-fixtures.test.ts test/research-control-plane.test.ts test/bus.test.ts
node scripts/generate-traceability-map.mjs && node --test --experimental-strip-types test/traceability.test.ts
npm run check && npm run test:kpi
grep -rn "autoWrap\|auto-wrap\|registerAutoWrap\|DEFAULT_QUALITY_GATES" packages/coding-agent/src test docs AGENTS.md README.md scripts   # expect none
# real artifact: build; in a scratch git repo type "hi" and "why does npm test fail?" → no .kpi/runs entry;
# type "add a /health endpoint with a test and commit it" → tool call, one-sentence reply, board appears,
# task.json quality_gates are npm commands; paste a 400-char error → answered as chat, no ENAMETOOLONG.
```

### DoD

- [x] `hi`, a question, and a pasted error create no run directory; a substantial goal creates exactly one — `test/runtime-milestone.test.ts`, `test/routing.test.ts`; built bundle in a scratch repo: `-p "hi"` answered as chat, `--mode json` forced `kpi_start_job` calls refused (`goal is too short`, `questions are answered directly`), `.kpi/runs` absent
- [x] `/kpi off|auto|always` and `kpi.routing` behave as documented; workers never hold the tool — `test/control-plane.test.ts`, `test/routing.test.ts`
- [x] Finished runs are invisible to the widget, footer and policy; `/kpi status` still shows the last job — `readLiveJob` wired into control-plane, status-line, policy (`resolveActivePolicyState`, `recordToolRequest`), `extensions/index.ts`, `graph/engine.ts`; `test/run-store.test.ts`, `test/policy.test.ts`
- [x] Quality gates match the repository's package manager and real scripts; a plan failure reports its real cause — `test/routing.test.ts`, `test/gated-loop.test.ts`
- [x] AGENTS.md, spec §4, PRD US-24/WF-00, UAT-24, README and the traceability map agree with the code — map regenerated by `scripts/generate-traceability-map.mjs`

**Landed 2026-09-02 on branch `fx/03-smart-routing`.** Gates: `npm run check` green, `npm run test:kpi` 649/649, `packages/coding-agent` vitest green, `npm run build:offline` green.

Incidental findings recorded for the other packages:
- The liveness switches in `policy.ts`, `status-line/index.ts` and `graph/engine.ts` were done here (one-line swaps), so FX-01 and FX-02 no longer need them.
- `kpi/extensions/print-profile.ts` limits print mode (`-p`) to `read grep find ls`, so no extension tool is active in print mode; `--mode json` is the non-interactive way to exercise `kpi_start_job`. Not changed.
- In print and JSON mode the footer logs `[kpi/status-line] agent_settled publish failed: This extension ctx is stale after session replacement` on every turn: `status-line/index.ts` uses the `agent_settled` ctx after the print session is replaced. Pre-existing; belongs to FX-01.
- `core/agent-session.ts:1211` carries a K-π comment that still says "Bare-message auto-wrap rewrites to `/kpi …`"; upstream-owned file, comment only, left alone.

---
## FX-04 — Dependency refresh: every dependency to latest, majors included

**Depends on:** FX-01, FX-02, FX-03 merged (this package touches every manifest and reruns the whole gate)  
**Decision (2026-09-02):** bump everything ahead of upstream Pi. Every upstream-owned `package.json` therefore diverges from upstream; UPSTREAM.md §6 must record that and the merge rule ("take the higher version").  
**Owns files:** root `package.json`, `package-lock.json`, `packages/*/package.json`, `packages/session-backends/*/package.json`, `packages/coding-agent/examples/extensions/*/package.json`, `scripts/check-ts-relative-imports.mjs`, `tsconfig.base.json`, `biome.json`, `UPSTREAM.md` §6, `AGENTS.md` Stack section, the source files named in the migration table.

### Facts that shape the change

- `npm audit --omit=dev`: 0 vulnerabilities today. `check:pinned-deps` requires exact versions everywhere except the vendored `kstack/upstream/` tree.
- The build already runs the native compiler: every `build` script calls `tsgo` from `@typescript/native-preview 7.0.0-dev.20260120.1`. `typescript@7.0.2` is that compiler released: `tsc` is native, there is **no programmatic API until 7.1**. Only one thing here uses the API: `scripts/check-ts-relative-imports.mjs` (`ts.createSourceFile`, `ts.isImportDeclaration`, …).
- TypeScript 6/7 default flips are already satisfied by `tsconfig.base.json` (`strict`, `types: ["node"]`, `module: Node16`, no `baseUrl`, no `outFile`, build configs set `rootDir`). `experimentalDecorators`/`emitDecoratorMetadata` are set but no decorator is used anywhere in `packages/*/src`; drop both.
- `highlight.js` is called in the v11 form already (`hljs.highlight(code, { language })`, `lib/core` + `lib/languages/*` imports); jsdiff is called with `headerOptions: Diff.FILE_HEADERS_ONLY`, no `newlineIsToken` on patch functions.
- `hosted-git-info@10` requires `node ^22.22.2 || ^24.15.0 || >=26`; the repo says `>=22.19.0`. Local Node is 26.7.0.
- `packages/evals/package.json` depends on `@earendil-works/pi-coding-agent ^0.84.4`; the workspace is `0.1.0` → `npm ls` invalid.
- `@types/node@26` describes Node 26 APIs; compiling Node-22-floor code against it hides runtime gaps.

### Target versions

| Package | From → To | Risk | Migration |
|---|---|---|---|
| typescript (+ remove `@typescript/native-preview`) | 5.9.3 + preview → **7.0.2** | High | Scripts: `tsgo -p …` → `tsc -p …`, `tsgo --noEmit` → `tsc --noEmit` (root `check`, `packages/{agent,ai,client,coding-agent,protocol,server,telemetry,tui,session-backends/sqlite-node}`). Add devDependency `typescript6: "npm:@typescript/typescript6@6.0.2"` and import it in `scripts/check-ts-relative-imports.mjs` (the only API consumer). Remove `experimentalDecorators`/`emitDecoratorMetadata` from `tsconfig.base.json`. Nightly note in AGENTS.md: `typescript@next`, not native-preview. |
| @anthropic-ai/sandbox-runtime | 0.0.26 → **0.0.75** | High (pre-1.0) | Used only by the `sandbox` example extension via `SandboxManager.wrapWithSandbox(command)` (signature compatible). Root devDep + example dep bump; re-run the example's tests; drop `seccomp.bpfPath` from any fixture config. |
| @anthropic-ai/sdk | 0.91.1 → **0.123.0** (also the `custom-provider-anthropic` example: 0.52.0 → 0.123.0) | Medium | `tsc` the `packages/ai/src/api/anthropic-messages.ts` path: exhaustive `stop_reason` switches gain `model_context_window_exceeded`; beta Files/Skills renames do not apply (unused); retired model ids may vanish from literal types — check fixtures/tests. |
| highlight.js | 10.7.3 → **11.12.0** | Medium | Call form already v11. Confirm every `lib/languages/*.js` import still resolves under the v11 `exports` map (deep imports limited to `lib/core`, `lib/common`, `lib/languages/*`); re-snapshot any highlighted output test. Node ≥20. |
| diff | 8.0.4 → **9.0.0** | Medium | Patch-header formatting changes: re-baseline tests asserting unified-diff text (`packages/agent/test/harness/tools.test.ts`, `packages/coding-agent/test/tools.test.ts`); `oldFileName/newFileName` typed `string | undefined`. |
| hosted-git-info | 9.0.3 → **10.1.1** | Medium | Raise root and `packages/coding-agent` `engines.node` to `>=22.22.2`; README/AGENTS.md "Node >= 22.19" → 22.22. API unchanged. |
| @types/node | 22.19.19 → **latest 22.x** (deliberately not 26) | Medium | The one exception to "everything": types must match the engine floor. Move to 24.x/26.x only with an engines bump. |
| openai | 6.40.0 → **7.9.0** | Med-Low | Node ≥22 only breaking change. `tsc` the five `packages/ai/src/api/*openai*` files (Responses `call_id` optional, `usage.compute_units`); re-run streaming tests (SSE abort semantics changed in 7.7). |
| @google/genai | 1.52.0 → **2.20.0** | Low | Only the Interactions API broke; `generateContentStream`, `ThinkingConfig`, `FunctionCallingConfigMode` unchanged. |
| chalk | 5.6.2 → **6.0.0** | Low | Node ≥22; numeric `FORCE_COLOR` is now an exact level (none set in CI). |
| @xterm/headless | 5.5.0 → **6.0.0** | Low-Med | Test-only (`packages/tui/test/virtual-terminal.ts`); no removed options in use; verify the ESM entry the runner resolves. |
| http-proxy-agent / https-proxy-agent | 7.x → **9.1.0** | Low | ESM-only + Node ≥20; only `bedrock-converse-stream.ts` uses them with unchanged constructors. |
| @aws-sdk/client-bedrock-runtime / @smithy/node-http-handler | → **3.1124.0** / **4.12.0** | Low | Additive. |
| vitest / @vitest/coverage-v8 | 4.1.9 → **4.1.11** | Low | Concurrency-limit revival may reorder hooks; do not take `vitest@5` rc. |
| vitest-evals | 0.15.0 → **0.16.1** | Low | Only the GitHub reporter action changed. |
| undici | 8.9.0 → **8.10.1** | Low | Engines match exactly. |
| typebox | 1.3.7 → **1.3.25** | Low | Immutability in `Assign/Update/Discard` (1.3.18), sparse-array checks (1.3.20): run `test/schema-conformance.test.ts` and the ai/agent suites. |
| marked | 18.0.5 → **18.0.11** | Low | Edge-case HTML changes: re-run `packages/tui/test/markdown.test.ts`. |
| ignore | 7.0.5 → **7.0.8** | Low | Backslash/tab handling now git-exact. |
| semver, minimatch, grok-mermaid, @types/semver | → 7.8.5, 10.2.6, 0.2.3, 7.8.0 | Low | Patch. |
| @biomejs/biome | 2.3.5 → **2.5.11** | Low-Med | Run `npx biome migrate --write`; new rules may surface under `--error-on-warnings`, fix or configure in `biome.json`. |
| esbuild, tsx | → 0.28.2, 4.23.13 | Low | Patch/minor. |
| @earendil-works/pi-coding-agent in `packages/evals` | `^0.84.4` → **`^0.1.0`** | — | Workspace consistency; makes `npm ls` clean and matches the UPSTREAM.md register. |

Keep the existing `overrides` (`protobufjs`, `rimraf`, `gaxios.rimraf`) unless `npm ls`/`npm audit` show they are no longer needed after the bump; if removed, say so in the commit.

### Change

1. Edit every manifest to the exact versions above (no ranges; `check:pinned-deps` enforces it). Replace `@typescript/native-preview` with `typescript@7.0.2` and add the `typescript6` alias devDependency at the root.
2. Rename `tsgo` → `tsc` in every script; update `scripts/check-ts-relative-imports.mjs` to `import ts from "typescript6"`.
3. `tsconfig.base.json`: remove `experimentalDecorators` and `emitDecoratorMetadata`.
4. `engines.node` → `>=22.22.2` (root and `packages/coding-agent`); update README/AGENTS.md/START-HERE.md wording.
5. `npx biome migrate --write`; resolve new diagnostics.
6. `rm -rf node_modules && npm install`; commit the regenerated `package-lock.json`.
7. Fix compile errors surfaced by `tsc --noEmit` in the files named in the table; re-baseline the diff-text and markdown snapshot tests.
8. UPSTREAM.md §6: add a row "Dependency refresh 2026-09-02: every `packages/*/package.json` and the root manifest pin newer versions than upstream `v0.84.4`; on an upstream merge keep the higher version of each dependency and re-run FX-04's verification"; correct the evals row. AGENTS.md Stack: TypeScript 7 native `tsc`, Node `>= 22.22`.

### Verification

```bash
npm ls --all >/dev/null && echo "npm ls clean"        # no invalid/missing
npm audit --omit=dev
npm run check                                          # biome 2.5, pinned deps, ts-imports (via typescript6), tsc --noEmit (native), browser smoke
npm test && npm run test:kpi
npm run build && node packages/coding-agent/dist/bundle/cli.js --version
npm run pack                                           # packs, installs the tarball, runs kpi --version
npm run kstack:sync:check && npm run upstream:check -- --offline
# live smoke: one streamed turn each on an anthropic, openai-codex and (if configured) google slot
```

### DoD

- [ ] Every non-vendored dependency is at the version in the table; `npm outdated` lists only `@types/node` (deliberate) and nothing else
- [ ] `npm run check`, `npm test`, `npm run test:kpi`, `npm run build`, `npm run pack` green on Node 22.22+ and 26
- [ ] UPSTREAM.md §6 and AGENTS.md describe the divergence and the merge rule

---

## 4. Execution waves and gates

| Wave | Packages | Shared files to coordinate |
|---|---|---|
| 1 | FX-03 | `run-store.ts` (adds `readLiveJob`, `isPausedHuman` move), `control-plane.ts` (command/probe parts) |
| 2 | FX-01 ∥ FX-02 | `control-plane.ts` (FX-01 owns board/widget/overlay; FX-03 already landed the command parts), `extensions/index.ts` (FX-02 edits `resolveActiveWriteAllow`; FX-03 edited the registration line in wave 1) |
| 3 | FX-04 | everything; run after waves 1–2 are merged |

Before the pull request of each wave, once:

```bash
npm run check && npm test && npm run test:kpi
node scripts/generate-traceability-map.mjs && git diff --exit-code docs/traceability-map.json || echo "map regenerated: commit it"
```

Feature acceptance afterwards: rerun `docs/uat.md` rows UAT-06, UAT-13, UAT-16, UAT-24, UAT-25 against the built bundle in a scratch repo.

## 5. Out of scope (recorded so nobody reopens them by accident)

- Merging Pi `main` (21 untagged commits): wait for the next release tag, then UPSTREAM.md §6.
- K-stack: already current.
- `ensurePolicyFile` creating `.kpi/policy.json` in unrelated directories is narrowed in FX-02, not removed.
- Pixel parity with the JPEGs (`docs/visual-targets.md` §2 Honesty).
