# Fixture guidance

Ship the `auth` slice. The frozen map carries a `task_hash` from an older contract, so it
does not describe this `task.json`.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
