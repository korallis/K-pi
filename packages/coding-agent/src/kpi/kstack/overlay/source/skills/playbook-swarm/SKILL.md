---
name: playbook-swarm
description: Fan out at most two disjoint local K-π workers for coverage. Use for a swarm, a fan-out, or splitting independent slices.
playbook: swarm
match: swarm, fan out, fan-out, parallelize, split the work
---

# swarm playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **plan** Split the request into at most two non-overlapping slices with no shared files.
- **implement** Call `spawn_background` for each local worker and steer with `communicate`, one writer at a time.
- **test** Read each worker's contract file. Never copy a worker transcript.
- **review** Aggregate the evidence and stop the workers.
- **ship** Hand the aggregate to the shipping gate.
