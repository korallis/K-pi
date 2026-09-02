# Fixture guidance

Two slices are planned. The frozen map selects `billing` while the frozen contract selects
`auth`, so the round has two selected modules and no single current slice.

## Quality gates

```bash
npm test
```

Never push. One implement round owns exactly one `current_module_id`.
