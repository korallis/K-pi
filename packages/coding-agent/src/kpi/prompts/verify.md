---
description: Run acceptance checks and project quality gates
argument-hint: "[job-id]"
---

Apply the `quality-gates` skill to `$ARGUMENTS` or the active run. Execute every required acceptance check and each exact command in `task.json.quality_gates`. Bind receipts to current HEAD and report red for any failure or stale evidence. Do not substitute proxy commands.
