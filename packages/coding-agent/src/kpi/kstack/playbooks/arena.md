---
name: arena
description: Compare two local K-π candidates and graft the stronger result
---

1. Read Principles.
2. Call `spawn_background` for at most two arena workers with the same frozen brief.
3. Use `communicate` for follow-up constraints.
4. Compare their candidate files against acceptance criteria.
5. Select or graft the smallest proven result. Never merge an origin branch.
