---
name: playbook-shipping
description: Ship an already approved K-π candidate as one local commit. Use to ship, release, or land work whose verdict is already approved.
playbook: shipping
match: ship, release, land, cut a release
---

# shipping playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **test** Verify the recorded evidence is fresh for the current HEAD.
- **review** Verify bounds held and that `verdict.approved` is true.
- **ship** Create exactly one Conventional Commit with the job marker, then mark DONE. Never push or deploy.
