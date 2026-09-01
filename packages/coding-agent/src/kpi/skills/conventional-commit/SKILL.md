---
name: conventional-commit
description: Use only in the ship node after gated approval to create the local commit.
---

# Conventional commit

Create exactly one local commit for the approved candidate. Its subject must match:

`^(feat|fix|docs|refactor|test|chore)(\(.+\))?: `

Choose the narrowest accurate type and optional scope. Use an imperative summary tied to the frozen goal. Do not amend unrelated history, push, deploy, or include files outside the approved candidate.
