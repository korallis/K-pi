# Fixture guidance

Ship the `auth` slice: session issue and verify inside `src/auth/`, behaviour checks in `test/auth/`.
`stack.json` is the frozen map and one implement round ships one slice.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
