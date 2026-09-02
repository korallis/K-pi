---
name: playbook-feature
description: Deliver one vertical feature slice through the K-π gates. Use for a new capability, a feature request, or adding behaviour to a module.
playbook: feature
match: feature, add, implement, build, support, introduce
---

# feature playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **specify** Specify executable acceptance criteria and freeze them.
- **plan** Research the repository and current external practice, then plan one vertical Dune module.
- **plan-check** Scaffold the module folder, its public interface, and its test twin before behaviour.
- **implement** Implement the smallest change that satisfies the frozen criteria.
- **test** Run the declared quality gates and record their output as evidence.
- **review** Obtain a fresh isolated verdict against the frozen criteria.
- **ship** Create exactly one local Conventional Commit carrying the job marker.
