---
name: playbook-arena
description: Compare two local K-π candidates for the same brief and graft the stronger one. Use for a bake-off, an arena run, or comparing two approaches.
playbook: arena
match: arena, bake-off, bakeoff, compare approaches, two attempts
---

# arena playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **plan** Freeze one brief both workers receive unchanged.
- **implement** Call `spawn_background` for at most two arena workers on live configured K-π pools, and steer them with `communicate`.
- **test** Compare their `candidate.json` files against the frozen acceptance criteria.
- **review** Select or graft the smallest proven result.
- **ship** Hand the grafted result to the shipping gate. Never merge an origin branch.
