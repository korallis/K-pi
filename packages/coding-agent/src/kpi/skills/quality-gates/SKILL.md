---
name: quality-gates
description: Use in tester and verify nodes to produce mechanical, HEAD-bound evidence.
---

# Quality gates

Read `task.json.quality_gates`; those exact commands are authoritative and originate from project `AGENTS.md`. Run every required acceptance check and quality gate. Record command, exit code, concise excerpt, current HEAD, and per-criterion result in `evidence.json`.

Any required non-zero command or stale HEAD is red. Never replace a required command with an easier proxy, infer success from model output, or omit a failing receipt.
