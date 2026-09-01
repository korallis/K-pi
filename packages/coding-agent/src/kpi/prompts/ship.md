---
description: Commit an approved gated run without pushing
argument-hint: "[job-id]"
---

Ship `$ARGUMENTS` or the active run only after human approval. Apply the `conventional-commit` skill and create exactly one local commit whose subject matches `^(feat|fix|docs|refactor|test|chore)(\(.+\))?: `. Include only the approved candidate. Never push, deploy, or amend unrelated history.
