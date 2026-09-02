# Fixture guidance

`shared/` holds what two or more slices need. Only `auth` consumes it here, so those types
belong inside `src/auth/`.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
