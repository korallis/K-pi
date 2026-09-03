---
name: kpi-operator-issues-2026-09
description: "State of the seven-issue K-π operator batch (branch fix/operator-issues-0.3.0, started 2026-09-03) — what landed, the wave plan still to run, owner decisions, and where the designs/reports/workflow scripts live"
metadata: 
  node_type: memory
  type: project
  originSessionId: 304cbd03-16f6-4bf4-b7d1-7643df70b280
  modified: 2026-09-03T15:05:15.350Z
---

Branch `fix/operator-issues-0.3.0` (off main at cbecd84e7). Landed and green (build, check, test:kpi 714, npm test) as of 2026-09-03 afternoon: ea35b7f80 cherry-pick of upstream 96317e50b (claude-cli 2.1.251), 68da4505b accounts official-slot + invalid_grant needs-login + version-rejection notice, ae3565bc4 plan-approval human gate with feedback, 640fbaa81 bus sessions registry + `/agents`. Proven on the real artifact: a print-mode Anthropic OAuth request now reaches the server (answered "out of extra usage", not `claude_code_version_too_old`) with no refresh warning; `~/.kpi/agent/*.pre-0.3.0.bak` are the pre-reconcile backups.

Still to run, in order: wave 2 = board-live ∥ onboarding (script `kpi-wave2-implement-wf_ee4b350f-ced.js`, failed twice only on API 529, tree clean); wave 3a self-healing core (budget/schema/stop/engine/graphs/prompts/schemas/append-log/run-store + their tests); wave 3b self-healing driver (gated-loop, control-plane incl. detaching the loop from the `/kpi` handler, board, status-line, pty graders, metric-runs + tests, release gate gains Request changes/Stop); wave 4 one docs+traceability agent (PRD/spec/uat/README/visual-targets/agents-bus/research/remediation-plan NH-05, RP-20 onboarding, RP-21 self-healing; generator rows from every wave report; regenerate the map); then full gates, `npm run build:offline`, `verify:built`, pty rows, bump to 0.3.0 per [[kpi-release-process]], `npm run pack` and `bun install -g` the tarball for the user's global install, PR, tag after merge.

Everything durable is in `~/.claude/projects/-Users-leebarry-K-pi/handoff-0.3.0/` (designs/*.json incl. plan.json and wave1-reports.json, workflows/*.js, logs/, HANDOFF.md with the full prompt). Pending unrelated item: import Claude Design project e9a6e374-8c54-4805-be22-1d21ca1ee8cd (`K-pi Command Centre.dc.html`, `support.js`) via DesignSync once `/design-login` succeeds.

Session 2 (2026-09-03 15:00): wave 2 failed a third time on API 529 — a probe showed the Fable and Opus SUBAGENT tiers answer 529 for hours while Sonnet answers and the main loop is unaffected. The workflow scripts now start with a `probeTier()` and fall back to `model: "sonnet"` for every agent when the default tier is down, with TWO adversarial verifiers per package (contract lens + behaviour lens) and the lead reviewing each diff before gates. Wave-3 scripts are authored: `handoff-0.3.0/workflows/kpi-wave3a-implement.js` (engine ∥ contracts), `kpi-wave3b-implement.js` (driver ∥ surface; pass `args: { wave3aReports }`), `kpi-contracts-3.js` (the C1–C11 shared contracts: two automatic re-plans per operator touch, failed test rounds count and identical consecutive evidence is a witness, abort-immediately stop via AbortSignal + stop.json `recorded` flag, gates Approve / Request changes / Stop, RUN_STATUSES + LOOP_RECOVERIES in run-store.ts).

Session 1 close (2026-09-03 16:10): pushed `origin/fix/operator-issues-0.3.0` (wave 1 + `1208c4a72 wip(wave2)`, the unverified board-live/onboarding snapshot) and `origin/handoff/operator-issues-0.3.0` (handoff-0.3.0/ with HANDOFF.md and HANDOFF-FRESH.md). Branch inventory: the eleven other local branches (gap-fixes, metric-proof, rp16, rp17, uat-blockers, wave1-hard, pty-rows, operator-manual, authority-cleanup, upstream-refresh, drop-mutation-controls, rp-01-ci-fix) and the rp-02 stash are stale — every unmerged commit conflicts with main because the work landed later under reworked commits; nothing outside the 0.3.0 batch is missing from main.

**Why:** the batch is half-landed; a fresh session must not redo wave 1 or re-litigate the decisions in [[kpi-no-cost-cap-decision]].
**How to apply:** start from HANDOFF.md; one writer per file, agents share the working tree, run full gates only between waves.
