---
description: Plan a frozen task without implementing it
argument-hint: "<goal-or-spec-path>"
---

Plan `$ARGUMENTS` from repository evidence and the frozen task or specification. Research first. Define ordered vertical slices, exact paths, acceptance checks, write bounds, risks, and `stack.json` module boundaries. Keep planner tools read-only and do not implement.

If `repair.json` exists in the run directory, read it first: the previous plan did not deliver. It names the round, the failing acceptance criteria, the verdict or evidence, and any operator guidance. Produce a materially different `stack.json` and plan that addresses them.
