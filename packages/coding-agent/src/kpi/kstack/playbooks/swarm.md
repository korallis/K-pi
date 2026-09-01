---
name: swarm
description: Fan out at most two disjoint local K-π workers
---

1. Read Principles.
2. Split the request into at most two non-overlapping slices.
3. Call `spawn_background` for each local worker.
4. Use `communicate` with `deliverAs: followUp` for steering.
5. Read candidate, evidence, or verdict files; never copy worker transcripts.
6. Aggregate evidence and stop the workers.
