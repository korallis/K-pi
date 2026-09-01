# K-stack model ladder (Pi-harness reports only)

Used by `/setup-kstack` to **suggest** a mapping. Operator applies or edits. Never written as a required default.

Cut date: 2026-08-31. Refresh when enough new Pi/OMP reports accumulate.

## What this is not

Not SWE-bench. Not Claude Code. Not Codex CLI. Not vendor launch tables.

Those numbers move models, but they are a different harness. A model that wins Terminal-Bench inside Codex can slop in Pi, and the reverse is also true.

## Challenge to the submitted overall table

The submitted sheet ranked twelve models 1–12 and copied that order into every column (planning, writing, apps, bugs, PR review, code review). That shape is not supported.

- Same rank in every column is a smell. Role matters.
- GPT-5.6 Sol as #1 at **PR / code review** fights repo-level reports: Opus 5 leads SWE-bench Pro by a wide gap (79.2 vs 64.6). Pi/OMP users put Sol on the workhorse seat and Fable/Opus on UI and judgment.
- GLM-5.3 as a blanket #2 is too clean. On Pi it has both “beat Sol xHigh on a two-day bug” and “made a junior-level error.” SlopCodeBench **on Pi** tied GLM-5.3 with Fable 5 and Sol at 10/30 strict on one list.
- Fable 5 as #5 under Grok 4.6 has almost no Pi-only head-to-head. OMP users keep Fable as oracle / UI.
- Grok 4.6 as #4 is medium at best. One OMP report preferred Qwen 3.8 27B over it for some code work.
- GLM-5.3 Flash as a uniform #6 undersells Pi fleet use: one operator ran whole backlogs on Flash+Pi after harness work and called it a Fable replacement for ticket grind. That is workhorse, not review.
- Terra vs Luna: Pi-specific. Terra Low beat Luna as explorer. Luna “small model smell,” misses cache. Terra on Pi+teams was reported as the only model that self-looped review 10+ rounds (also: over-defensive). So Terra sits above Luna, and Terra is a review/precise candidate, not a generic #8.

Kimi K3 was missing. That was a miss. It is the frontend/design seat. Arena Frontend Code put K3 ahead of Fable 5 and Sol. Developer reports pair “design: Kimi K3 and Fable.” Pi users already run K3 via `kimi-coding` (and mention K3 next to Pi/OMP). Pi-only head-to-heads are still thinner than Sol/GLM, so frontend confidence is medium-high, general implementer confidence is medium.

## Role suggest lists

First live slug that matches a pattern wins. Patterns are substring match on `provider/id` after `getAvailable()` ∩ healthy pools.

| Role | Prefer, in order | Why | Confidence |
|---|---|---|---|
| implementer | `gpt-5.6-sol`, `glm-5.3` (not flash), `opus-5`, `kimi-k3`, `grok-4.6`, `glm-5.2` | Sol is the Pi/OMP workhorse. GLM-5.3 is value. K3 is capable but slower; use it when the slice is UI-heavy. | Medium |
| frontend | `kimi-k3`, `fable-5`, `opus-5`, `glm-5.3` | Frontend/design seat. Arena Frontend Code: K3 over Fable and Sol. Devs: “design = K3 and Fable.” Sol is weak here. | Medium-high |
| judgment | `opus-5`, `fable-5`, `gpt-5.6-terra`, `gpt-5.6-sol`, `kimi-k3` | Review and taste. K3 belongs on visual review, not as the default repo judge. | Medium |
| precise | `gpt-5.6-sol`, `gpt-5.6-terra`, `opus-5`, `glm-5.3` | Exact contracts. | Medium |
| fast | `gpt-5.6-luna`, `glm-5.3-flash`, `grok-4.6`, any local | Cheap movers. K3 is not fast. | Medium |
| review_panel | Prefer `opus-5` + `gpt-5.6-sol`. If the job is UI, `kimi-k3` + `fable-5`. Cap 3. | Cross-family. | Medium |

If a role has no match: `inherit-parent`.

Do not suggest Cursor Cloud slugs. Do not require a named id that is not in the live registry.

## Overall working order (implementer-shaped, not review-shaped)

Use only as a tie-break when two candidates match the same role pattern.

1. GPT-5.6 Sol — High for *writing/planning in Pi*. Weak as a design seat.
2. GLM-5.3 — High for value loops in Pi. Not automatically #2 at PR review.
3. Claude Opus 5 — High for judgment / repo review.
4. Kimi K3 — Medium-high for **frontend/UI**. Not the default implementer. Official pool `kimi-coding`.
5. Claude Fable 5 — Medium. Oracle / UI. Pair with K3 on visual work.
6. GPT-5.6 Terra — Medium. Pi explorer + defensive long review loops.
7. Grok 4.6 — Medium. Fast / research seat, not the default implementer.
8. GLM-5.3 Flash — Medium. Fleet / ticket grind on Pi after harness work.
9. Claude Opus 4.8 — High that it sits below Opus 5.
10. GLM-5.2 — Medium. Cheap “Opus-ish” on OMP before 5.3.
11. GPT-5.6 Luna — Medium. Fast only. Cache misses reported on Pi.
12. Grok 4.5 — Low. Do not prefer over 4.6.
13. GLM-5.1 — Medium. Legacy.

## Sources allowed in this file

- Developer posts that name **Pi** or **Oh My Pi** as the harness
- Pi-run benches (example: SlopCodeBench GLM-5.3 · pi)
- In-thread Pi explorer timings (Luna vs Terra)
- For the **frontend role only**: Arena Frontend Code + named developer design comparisons. K3-in-Pi is a documented path (`kimi-coding`); Pi-only UI bake-offs are still thin.

Rejected as ranking evidence: vendor SWE tables, Codex-only or Claude-Code-only leaderboards, marketing blogs. They may appear in comments, not in the suggest lists.

## Refresh rule

Bump this file in a dated commit. `/setup-kstack` reads the committed lists. No network scrape at setup time.
