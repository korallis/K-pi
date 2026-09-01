---
name: arena
description: Run at most two local K-π candidates against one frozen brief and graft the stronger result. Use for /arena, a bake-off, comparing two approaches, or picking between competing implementations.
disable-model-invocation: true
---

# Arena

Two attempts at the same brief, judged on their contract files.

1. **Freeze the brief.** Both workers receive the same text. A brief that changes
   between workers compares two different questions.
2. **Pick the runners.** Take them from the `arena runners` list in
   `~/.kpi/agent/kstack/models.json`. Prefer two different families so the
   comparison is not one family reviewing its own habits. Only models the live
   registry returned are eligible.
3. **Spawn at most two.** `spawn_background` with role `arena`, one worker per
   runner. Two is the cap every K-π fan-out obeys, and only one worker may hold
   the writer slot, so the second either reviews or waits.
4. **Steer with `communicate`.** Follow-up constraints go to the worker, not to a
   shared scratch file.
5. **Judge the candidates.** Read each worker's `candidate.json` against the
   frozen acceptance criteria. Never read a worker transcript.
6. **Graft the smallest proven result.** Take the winning candidate, or the
   smallest combination that satisfies the criteria, and hand it to the shipping
   gate. Never merge an origin branch and never push.

Every worker writes inside the current checkout on the job branch. There is no
second checkout, no remote runner, and no sleeper waiting for one to wake.
