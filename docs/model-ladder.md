# K-stack model ladder

Used by `/setup-kstack` to **suggest** a mapping. Operator applies or edits. Never
written as a required default.

Cut date: 2026-08-31.

The order below is a starting point for this harness, not a benchmark result and
not a claim about any model. `/setup-kstack` intersects it with the live registry
and the operator's own configured pools, so an entry that is not available is
simply skipped.

## Role suggest lists

First live slug that matches a pattern wins. Patterns are substring match on `provider/id` after `getAvailable()` ∩ healthy pools.

| Role | Prefer, in order | Why | Confidence |
|---|---|---|---|
| implementer | `gpt-5.6-sol`, `glm-5.3` (not flash), `opus-5`, `kimi-k3`, `grok-4.6`, `glm-5.2` | General implementation. Second and third entries are value and UI-heavy alternates. | Medium |
| frontend | `kimi-k3`, `fable-5`, `opus-5`, `glm-5.3` | Frontend and design work. | Medium-high |
| judgment | `opus-5`, `fable-5`, `gpt-5.6-terra`, `gpt-5.6-sol`, `kimi-k3` | Review and judgment. | Medium |
| precise | `gpt-5.6-sol`, `gpt-5.6-terra`, `opus-5`, `glm-5.3` | Exact contracts. | Medium |
| fast | `gpt-5.6-luna`, `glm-5.3-flash`, `grok-4.6`, any local | Cheap movers, including any configured local pool. | Medium |
| review_panel | Prefer `opus-5` + `gpt-5.6-sol`. If the job is UI, `kimi-k3` + `fable-5`. Cap 3. | Cross-family review; capped at three. | Medium |

If a role has no match: `inherit-parent`.

Do not suggest Cursor Cloud slugs. Do not require a named id that is not in the live registry.

## Overall working order

Use only as a tie-break when two candidates match the same role pattern.

1. GPT-5.6 Sol — general implementation
2. GLM-5.3 — general implementation
3. Claude Opus 5 — review and judgment
4. Kimi K3 — frontend, official pool `kimi-coding`
5. Claude Fable 5 — review and frontend
6. GPT-5.6 Terra — exploration and long review
7. Grok 4.6 — fast movers
8. GLM-5.3 Flash — fast movers
9. Claude Opus 4.8 — review and judgment
10. GLM-5.2 — general implementation
11. GPT-5.6 Luna — fast movers
12. Grok 4.5 — fast movers
13. GLM-5.1 — general implementation

## Refresh rule

Bump this file in a dated commit. `/setup-kstack` reads the committed lists. No network scrape at setup time.
