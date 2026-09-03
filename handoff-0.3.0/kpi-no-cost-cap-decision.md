---
name: kpi-no-cost-cap-decision
description: "User decision 2026-09-03 — K-π must have no USD cost cap at all (subscription-centric); gated graphs must never terminate on a limit, they pause and ask the operator; the seven-issue operator batch this came from"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 304cbd03-16f6-4bf4-b7d1-7643df70b280
  modified: 2026-09-03T12:31:47.544Z
---

On 2026-09-03 the user's gated job ended `EXHAUSTED: graph exhausted maxCostUsd 5 at 7.69` and they said: "graphs should never fail" and "there shouldn't be a cap at all … the system's designed around using your subscriptions, so it should simply have no cap."

Follow-up the same day: "if it hits a timeout it shouldn't stop, it should retry. The point of graphs is they are self-repairing and self-healing to ensure the user's intent is delivered." So: no hard stop of any kind on the engine's own initiative. Transient failures (timeout, 429, 5xx, transport) retry with backoff and failover indefinitely while the operator is kept informed; node/round failures re-plan; the only stops are DONE and the operator. When genuinely stuck the job pauses NEEDS_HUMAN with the evidence, it does not die.

Decision: delete `maxCostUsd` everywhere (limits, `--max-cost-usd` flag, task.limits, state, docs). Cost stays *reported* as a notional figure, never enforced. In gated/interactive mode no remaining limit (maxRounds, maxSteps, maxNodeRuns, timeoutMs) may kill a job: the engine pauses durably and asks the operator to extend or stop. Autopilot/non-interactive keeps bounded stop states per PRD US-05 unless the user says otherwise (flagged, not decided by me).

**Why:** the user routes through Claude Max / Codex / xAI subscriptions, so USD is a catalogue price, not a bill; a cap that silently kills a 15-minute job with no way to extend is the defect they care about most.
**How to apply:** never reintroduce a spend cap or an unattended-style hard stop on a gated job; when a bound exists, the operator is the bound. Same batch as [[kpi-operator-issues-2026-09]]; process in [[kpi-release-process]].
