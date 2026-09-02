# Fixture guidance

The plan extracts `shared/` as its own first slice, before any slice needs it. Shared code
is extracted only after a second slice asks for it.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
