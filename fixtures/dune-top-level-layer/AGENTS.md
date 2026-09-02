# Fixture guidance

The plan made `api/` the top-level map. A layer folder is legal inside a feature folder,
never as the map a stranger reads the product from.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
