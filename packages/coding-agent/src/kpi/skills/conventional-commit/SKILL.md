---
name: conventional-commit
description: Use only in the ship node after release approval to create the job's commit, push its branch, and open the pull request.
---

# Conventional commit

Create exactly one local commit for the approved candidate, on the job branch `kpi/<job-id>` the control plane checked out. Its subject must match:

`^(feat|fix|docs|refactor|test|chore)(\(.+\))?: `

Choose the narrowest accurate type and optional scope. Use an imperative summary tied to the frozen goal. Do not amend unrelated history, deploy, or include files outside the approved candidate.

When the repository has an `origin` remote, push exactly the job branch with `git push -u origin kpi/<job-id>` and open the pull request with `gh pr create --head kpi/<job-id> --fill`. Never push any other branch, force-push, push tags, delete a branch, or merge: merging is the auto-merge workflow's decision after the required check passes.
