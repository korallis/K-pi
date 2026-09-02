---
name: playbook-autonomous-run
description: Run executable acceptance criteria through local K-π autopilot. Use for autonomous, autopilot, or unattended runs.
playbook: autonomous-run
match: autonomous, autopilot, unattended, overnight
---

# autonomous-run playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **specify** Refuse to start unless every required acceptance criterion is machine-executable.
- **plan** Plan one vertical slice and freeze the plan.
- **plan-check** Scaffold the slice before behaviour.
- **implement** Implement inside the declared write bounds and dependency bounds.
- **test** Run the gates. A failing gate ends the round; it does not lower the bar.
- **review** Obtain a fresh isolated verdict.
- **ship** Create one local commit and mark DONE. Never push or deploy.
