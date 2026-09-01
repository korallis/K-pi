---
name: autopilot-stack
description: Run linear local K-π slices without remote merge authority
---

Run vertical slices in graph order. Use at most two background Pi sessions and one writer. Each slice hands off through contract files. Finish with DONE and linear local commits only after release approval. Never push, deploy, or merge origin.
