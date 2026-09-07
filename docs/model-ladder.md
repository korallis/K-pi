# K-stack model ladder

Used by `/setup-kstack` to **suggest** a mapping. Operator applies or edits. Never
written as a required default.

Cut date: 2026-08-31.

The order below is a starting point for this harness, not a benchmark result and
not a claim about any model. `/setup-kstack` intersects it with the live registry
and the operator's own configured pools, so an entry that is not available is
simply skipped.

## Role suggest lists

First live slug that matches a pattern wins during setup. Backtick patterns match `provider/id`; `(not flash)` excludes that substring and `any-local` matches configured local providers. These are setup suggestions, not runtime quality measurements.

| Role | Prefer, in order | Why | Confidence |
|---|---|---|---|
| implementer | `gpt-5.6-sol`, `glm-5.3` (not flash), `opus-5`, `kimi-k3`, `grok-4.6`, `glm-5.2` | General implementation. Second and third entries are value and UI-heavy alternates. | Medium |
| frontend | `kimi-k3`, `fable-5`, `opus-5`, `glm-5.3` | Frontend and design work. | Medium-high |
| judgment | `opus-5`, `fable-5`, `gpt-5.6-terra`, `gpt-5.6-sol`, `kimi-k3` | Review and judgment. | Medium |
| precise | `gpt-5.6-sol`, `gpt-5.6-terra`, `opus-5`, `glm-5.3` | Exact contracts. | Medium |
| fast | `gpt-5.6-luna`, `glm-5.3-flash`, `grok-4.6`, `any-local` | Cheap movers, including any configured local pool. | Medium |
| review_panel | Prefer `opus-5` + `gpt-5.6-sol`. If the job is UI, `kimi-k3` + `fable-5`. Cap 3. | Cross-family review; capped at three. | Medium |

If a role has no match: `inherit-parent`.

Do not suggest Cursor Cloud slugs. Do not require a named id that is not in the live registry.

## Overall working order

Use as a tie-break when two candidates match the same role pattern and as the proposed fallback order during setup. Runtime selection uses the operator-applied roles and fallback order, not this prose as a measured ranking.

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

## Runtime engineering selection

`resolveEngineeringModel` rereads the native authenticated catalog, saved operator policy and applicable host observations at dispatch. Graph roles map `builder` → `implementer`, `reviewer` → `judgment`, and `planner` → `precise`; exact role entries take precedence, with `review_panel` also available to reviewer roles. Eligible explicit role mappings are operator constraints: neither an independence preference nor measured outcomes can silently escape them.

Unmapped selection considers parent affinity, operator fallback order and then available catalog order, but applicable quality evidence can reorder these candidates before affinity. Reviewers first prefer a known different family from the builder within the allowed candidate set. A single-family installation remains usable with the independence limitation recorded; an unknown builder family cannot establish independence. Local/cloud crossings require an exact operator role or fallback authorization, rather than treating a new available provider as consent. A requested context minimum excludes resources with unknown or insufficient capacity; the inference-time canonical context boundary also refuses unusable capacity or mandatory overflow.

The optional `model_families` object in `kstack/models.json` maps exact provider/model slugs to operator-identified family names. Without it, conservative recognizable model-id prefixes identify families; an unknown id remains unknown rather than treating its provider as a family. Two providers serving the same family are not independent reviewers. The graph records model, family and routing reasons and observes the actual native session resource after model switches. The prose ladder is a setup prior, not a frozen capability database or an instruction to choose an unavailable slug.

### Account selection is native pre-auth, not header replacement

Model/role quality routing and request-time credential scheduling are separate. `before_provider_auth` selects the authorized grant before native auth resolution and request shaping. Denial or hook failure fails closed instead of falling back to an unrelated primary credential. Unmanaged providers and official OAuth retain native auth behavior; pooled OAuth refresh uses the provider's native refresh and auth conversion under the shared account file lock. Slot cooldowns persist, local slots must match the model endpoint, and response accounting uses the request ID that selected the slot. Successful HTTP transport, available quota and catalog membership are not quality evidence.

### Evidence-backed capability and local evaluation

Host outcomes live under `.kpi/kstack/engineering/outcomes/`, keyed by exact model, role and task kind, with raw evidence references and content hashes. Dispatch ignores malformed, future, stale (30-day default), missing or changed evidence, and counts only the newest observation for each model/task pair. Omitted metrics remain unknown. The comparator considers observed verification and task success, then reviewer defects and tool failures, then explicitly labeled operator priors from `priors.json`; latency and context usage are reported, not reasons to outrank quality. This is an evidence comparison, not a calibrated quality score.

`runEngineeringEvaluations` is a host API requiring configured representative tasks, exact available model identities, explicit workspaces/checker argv and a real runtime invoker. It runs task/model pairs sequentially, stores raw responses and checker stdout/stderr/exit evidence, and gives the checker `KPI_EVAL_OUTPUT`. An adapter model switch or invocation/checker error cannot be attributed as a measured pass for the requested model. Model testimony is not a verifier. This API does not launch an automatic benchmark, invent metrics or authorize additional credentials.

RP-22's `scoped-tests-8.json` records passing routing/evaluation fixtures and `accounts-native-auth.test.ts` exercises native auth construction against a local server. Those are local contract proofs, not live provider inference, a benchmark of the suggested models, or proof of cross-family review quality. The successful offline build and built-harness smoke likewise prove startup, not those live outcomes. Authorized live credentials and representative evaluation runs are still required before making model-quality claims.
