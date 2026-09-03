---
description: Commit an approved run on its job branch, push it, and open the pull request
argument-hint: "[job-id]"
---

Ship `$ARGUMENTS` or the active run only after human approval. Apply the `conventional-commit` skill and create exactly one local commit on the job branch `kpi/<job-id>` whose subject matches `^(feat|fix|docs|refactor|test|chore)(\(.+\))?: `. Include only the approved candidate. If the repository has an `origin` remote, push exactly that branch (`git push -u origin kpi/<job-id>`) and open the pull request (`gh pr create --head kpi/<job-id> --fill`). Never push any other branch, force-push, push tags, delete a branch, merge, deploy, or amend unrelated history: the auto-merge workflow merges after the required check passes.
