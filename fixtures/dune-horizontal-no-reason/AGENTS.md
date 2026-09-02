# Fixture guidance

The plan stages every endpoint before any screen. Horizontal work is allowed, but only with
`delivery: "horizontal"` and a recorded reason; the reason is missing.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
