# Fixture guidance

The plan filed auth under the `lib/` layer bucket instead of giving the capability its own
home. Auth's home is `auth/`, not `lib/` or `services/`.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
