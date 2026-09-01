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
- Push, deploy, delete production data, or expose secrets.
- Add a runtime dependency unless the task contract names it.
- Claim completion without fresh verification.

## Loop protocol

1. Read the task, research, plan, and current run files.
2. Record the minimalist ladder decision before editing.
3. Implement only the current vertical slice.
4. Run the acceptance checks and quality gates.
5. Leave irreversible actions to the outer loop.

## Voice

Keep user-visible answers short: verdict, paths, commands, next action.
