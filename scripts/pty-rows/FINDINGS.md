# PTY rows: product findings

Everything below was found by driving `packages/coding-agent/dist/bundle/cli.js`
over a real PTY (UAT-06, 15, 16, 25) or its RPC surface (UAT-07) and grading the
bytes it wrote. All four are fixed with tests and a
control: the first two in the row commit, the last two in the follow-up.

## Fixed

### 1. The always-on widget dropped `STOP` and the paused extras

**Locator:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
`setExtensionWidget` cut an array widget to the first 10 lines and appended
`... (widget truncated)`.

**Observed:** the paused board is 13 lines, so an operator watching the widget
during a human gate saw the header, stages, `GATE human`, `HUMAN OVERSIGHT
REQUIRED`, `WAITING ON OPERATOR` and `SHARED RUN STATE` — and then nothing. The
run-file lamps, `STOP STATES`, `THREE LAWS`, `STOP` and `NODE` were all below the
cut. `STOP` is the row the board exists to show and it is last, so a head-cut
removes exactly the wrong rows.

**Fix:** `EXTENSION_WIDGET_MAX_LINES` is now exported from
`core/extensions/types.ts` — the budget was private, so an extension could not
fit its own widget and only discovered the cut afterwards. `board.ts` gained
`fitBoardHeight`, which drops rows by what an operator loses (context layer,
three laws, fingerprint) and never `STOP`, the current stage, the lamps or the
operator question, keeping board order. `control-plane.ts` fits the widget;
`/kpi status` still renders every line in its overlay, which is what UAT-16
means by "expands it".

**Tests:** `test/operator-ui.test.ts` — "the widget-sized board keeps STOP and
the lamps a top-cut would drop", plus a control that a board already inside the
budget is returned untouched. Reverting `board.ts` fails the first test.

### 2. K-π's status bar hid every extension status, including its own

**Locator:** `packages/coding-agent/src/kpi/extensions/status-line/index.ts`
`installFooter`'s `render` returned only its own segment rail.

**Observed:** `ctx.ui.setStatus()` feeds the footer, and replacing Pi's footer
took the row those are drawn on with it. So the accounts widget — the operator's
only view of which credential is serving them — was published and never drawn.
UAT-06 requires "the accounts widget shows remaining % per slot, and no
percentage for a `local` slot"; with the K-π status bar active it showed nothing.
K-π's own code shows the intent: `publishKpiStatus` clears the `kpi` status slot
for the `full` preset "to avoid duplication", i.e. it expects something to render
that slot.

**Fix:** the K-π footer now draws the extension-status row beneath its rail. The
single-line folding rule moved to `FooterDataProvider.getExtensionStatusLine()`,
beside the statuses themselves, so Pi's footer and K-π's cannot disagree about
how a multi-line status becomes one row.

**Tests:** `test/status-line.test.ts` — "the registered footer draws the
extension statuses it took over", with a control that a footer with no statuses
stays a single row.

## Fixed in the follow-up commit

### 3. An extension cannot select a theme it ships, on `session_start`

**Locator:** `packages/coding-agent/src/core/agent-session.ts:2469-2470`

```
await this._extensionRunner.emit(this._sessionStartEvent);
await this.extendResourcesFromExtensions(...);
```

`session_start` is emitted *before* `resources_discover` runs, and
`interactive-mode.ts:623` registers themes from the resource loader before
either. So when the K-π control plane calls
`ctx.ui.setTheme(paused ? "protocol-blue" : "loop-amber")` from its
`session_start` handler, neither theme is registered yet and the call fails
silently — `setTheme` returns `{success:false}` and the result is discarded.

**Reproduction, independent of K-π:** put `"theme": "loop-amber"` in
`settings.json` and start the built binary. The product prints
`Error: Failed to load theme "loop-amber": Theme not found: loop-amber` and
`Fell back to dark theme.`, even though its own startup banner lists
`[Themes] loop-amber, protocol-blue` a moment later.

**Consequence for the rows:** a session that *resumes* with an already-active job
paints a board with neither brand colour until the operator runs a command. Both
UAT-06 and UAT-16 pass because their documented actions ("start a job", "run
`/kpi status`") happen after startup, when the themes are registered — verified:
amber and protocol-blue are both on the wire in `evidence/UAT-06/`.

**Fix:** `bindExtensions` now discovers resources, hands off to the host, then
emits `session_start`. `ExtensionBindings.onResourcesExtended` is that hand-off;
interactive mode uses it to mirror the loader's themes into the theme registry
and re-apply the operator's selection. The pre-extension apply no longer reports
errors, because a name that is not registered *yet* is not a missing theme — the
attempt after resources are extended is the one that reports. K-π's
`applyBoardTheme` now reads the `ThemeResult` and warns once if the board's
colour is refused; discarding it is what let this hide for a whole session.

**Tests:** `packages/coding-agent/test/session-start-resource-order.test.ts`
pins the order and asserts a theme the extension ships is in the loader when its
own `session_start` handler runs. `test/operator-ui.test.ts` covers the warning
and its absence on success.

**Built-binary evidence:** with nothing typed, a resumed session with a running
job comes up amber and a paused one protocol-blue, and `"theme": "loop-amber"`
in `settings.json` resolves with no error. Reverting the three files reproduces
all of it — no amber, no blue, `Theme not found`, and the new warning firing,
which is also the control for the warning.

### 4. A first run reports an install to `pi.dev`

**Locator:** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1291-1308`
(`reportInstallTelemetry`), reached from the first-run changelog path.

**Observed:** in a clean `HOME` the built K-π binary attempts
`https://pi.dev/api/report-install?version=…`. The egress guard recorded
`{"kind":"connect","host":"pi.dev","port":443}`. It is gated only by
`PI_OFFLINE` and an install-telemetry setting; `PI_SKIP_VERSION_CHECK`, which
`cli.ts:17` sets for every non-`pi` app name, does not cover it.

`cli.ts:15` states K-π "is built from its own checkout and is never distributed
through pi.dev", so this reports an install of something pi.dev did not ship,
from a first run the operator did not opt into.

**Fix:** a new `isInstallReportAllowed` returns false unless the build is the
upstream product, so no setting and no env flag can turn the report back on for
a fork. `reportInstallTelemetry` is its only caller. Upstream keeps both
switches.

Deliberately narrow: `isInstallTelemetryEnabled` is untouched, because it also
governs `getDefaultAttributionHeaders`. Gating the shared predicate would have
withheld `HTTP-Referer: https://pi.dev` and `X-OpenRouter-Title: pi` as well — a
defensible question, but a different one, and it would have gutted three
upstream tests whose real subject is which providers count as OpenRouter. That
question belongs to whoever owns fork attribution policy, not to a side effect
of stopping an install report.

**Tests:** `test/fork-telemetry.test.ts`, including that the shared preference
still behaves exactly as before.

**Built-binary evidence:** a genuinely clean HOME with `PI_OFFLINE` unset
produces no egress log at all; reverting `telemetry.ts` reproduces
`{"kind":"connect","host":"pi.dev","port":443}`. The row sandboxes no longer set
`PI_OFFLINE`.

**One legitimate outbound remains, and is not a defect:** a credentialed cloud
pool resolves official model ids from the provider catalog on `pi.dev`. That
serves the operator, `AGENTS.md` forbids hard-coding official ids, and the
product exposes `--offline`/`PI_OFFLINE` to decline it. Only UAT-15's `oauth`
capture passes `--offline`, for that reason; every other capture proves no
outbound attempt with no flags at all.

## Notes for the `uat/**` owner

Read-only inputs used as-is: `uat/pty_drive.py`, `uat/stub-model.mjs`,
`uat/egress-guard.cjs`. Four things cost real debugging time and are worth
writing down in those files:

- **`expect` is a precondition, not a result.** `run_pty` waits for step *N*'s
  `expect` and only then writes step *N*'s `send`. Reading it as "send, then wait
  for this" produces scripts whose sends all fire in the first tick against a
  pattern that is already on screen. A one-line docstring on `parse_script` would
  save the next reader the same hour.
- **Enter is `\r`.** `\n` reaches the editor without submitting, so a command
  sits on the input line and the run looks like a silent product failure.
  `encode_send` already maps `\\r`; the shape of a working step is worth an
  example.
- **`strip_ansi` keeps `\r`**, so `frame.txt` lines carry carriage returns and
  every consumer has to strip them before matching line ends.
- **Grading `frame.raw` needs the UTF-8 bytes of a glyph.** The file is bytes; a
  consumer that reads it as latin1 and searches for `▦` or `K-π` silently never
  matches. A helper next to `write_frames` would make the intended pattern
  obvious.

One stub observation, not a bug for the rows: `stream_options.include_usage`
normally delivers usage in a final chunk with an empty `choices` array, while
`streamCompletion` attaches it to the chunk carrying `finish_reason`. Pi's
OpenAI client accepts both, so calibration worked, but a stricter client would
report zero usage against this stub.
