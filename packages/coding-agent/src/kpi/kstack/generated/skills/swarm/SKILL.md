---
name: swarm
description: Fan out at most two disjoint local K-π workers for coverage, then aggregate their evidence. Use for /swarm, splitting independent slices, or covering several files at once.
disable-model-invocation: true
---

# Swarm

Coverage, not competition. Each worker owns a different slice.

1. **Split into at most two non-overlapping slices.** Two slices that touch the
   same file are one slice: the writer slot is exclusive, and a shared file is a
   collision waiting for a lease refusal.
2. **Spawn one local worker per slice.** `spawn_background` with the role the
   slice needs, on models from `~/.kpi/agent/kstack/models.json`. Two workers is
   the cap; one writer at a time.
3. **Claim before mutating.** Each writer calls `claim_path` for the paths it will
   change and releases them when done.
4. **Steer with `communicate`.** `deliverAs: followUp` waits for the current turn
   to end; `steer` interrupts after the current tool.
5. **Read contract files.** `candidate.json`, `evidence.json`, `verdict.json`.
   Never copy a worker's transcript into the parent.
6. **Aggregate and stop.** Combine the evidence, then stop the workers so the
   writer slot returns.

Workers are local background K-π sessions in this checkout. No remote runner, no
second checkout, no fan-out wider than two.
