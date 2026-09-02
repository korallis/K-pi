# Fixture guidance

Ship the `auth` slice. The plan node never wrote a frozen map, so this repository has a
contract and no `stack.json`.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
