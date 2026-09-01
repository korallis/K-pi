---
name: playbook-autopilot-full
description: Coordinate local K-π owners without remote merge authority. Use for a full autopilot coordination run across slices.
playbook: autopilot-full
match: autopilot-full, coordinate owners, full autopilot
---

# autopilot-full playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **plan** Order the slices and name one owner per slice.
- **implement** Use at most two background K-π sessions and one writer. The parent reads contract files, not transcripts.
- **test** Run the gates for each slice before starting the next.
- **review** Obtain a verdict per slice.
- **ship** Finish with DONE and an optional local commit after release approval. Never push, deploy, or merge origin.
