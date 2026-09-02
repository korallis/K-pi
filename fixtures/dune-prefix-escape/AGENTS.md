# Fixture guidance

Ship the `auth` slice. `src/auth-admin/` is a different capability that shares every
character of `src/auth`; a claim there is outside this slice.

## Quality gates

```bash
npm test
```

Never push. Claim only paths inside `src/auth/**` and `test/auth/**`.
