---
name: playbook-bug-fix
description: Reproduce and repair one defect through the K-π gates. Use for a bug, a regression, broken behaviour, or a failing test.
playbook: bug-fix
match: bug, fix, broken, regression, defect, crash, fails
---

# bug-fix playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **specify** Reproduce the reported defect and write the reproduction down as the acceptance criterion.
- **plan** Locate the root cause and state the regression contract the fix must hold.
- **implement** Implement the narrowest source fix. Never suppress the symptom.
- **test** Confirm the reproduction no longer triggers and the gates stay green.
- **review** Obtain a fresh isolated verdict.
- **ship** Create exactly one local Conventional Commit carrying the job marker.
