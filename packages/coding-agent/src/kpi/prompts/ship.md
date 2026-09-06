---
description: Commit an approved run on its job branch, push it, and open the pull request
argument-hint: "[job-id]"
---

Ship `$ARGUMENTS` or the active run only under canonical release authorization: operator approval in gated mode, independently validated release authority in autopilot. Include only the approved candidate in one conventional commit on `kpi/<job-id>`. When authorized and `origin` exists, push only that branch and open its pull request. Never force-push, push tags or another branch, delete branches, merge, deploy or amend unrelated history. Publish actual shipping receipts through the assigned output channel.
