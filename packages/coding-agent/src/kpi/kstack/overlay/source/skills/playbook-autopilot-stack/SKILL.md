---
name: playbook-autopilot-stack
description: Run linear local K-π slices without remote merge authority. Use for a stacked or sequential autopilot run.
playbook: autopilot-stack
match: autopilot-stack, stacked slices, linear slices
---

# autopilot-stack playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **plan** Order the vertical slices in graph order.
- **implement** Run one slice at a time with at most two background sessions and one writer; hand off through contract files.
- **test** Run the gates for the current slice.
- **review** Obtain a verdict for the current slice.
- **ship** Finish with DONE and linear local commits only after release approval. Never push, deploy, or merge origin.
