# Project instructions

## Commands

- Setup: `<setup-command>`
- Test: `<test-command>`
- Lint: `<lint-command>`
- Typecheck: `<typecheck-command>`

## Quality gates

Before completion, run `<test-command>`, `<lint-command>`, and `<typecheck-command>`. Record their outputs in the active run evidence.

## Do not

- Edit outside the active task bounds.
- Push without canonical release authorization, deploy, delete production data, or expose secrets.
- Add a runtime dependency unless the task contract names it.
- Claim completion without fresh verification.

## Loop protocol

1. Recover protected intent, required acceptance, current task and raw references from canonical run context.
2. Inspect existing code and claim the current feature's explicit paths before editing when required.
3. Implement only the current slice; preserve the project's language and valid layout.
4. Investigate acceptance failures; deterministic verification owns authoritative receipts.
5. Leave release authorization and external actions to their assigned graph roles.

## Voice

Keep user-visible answers short: verdict, paths, commands, next action.
