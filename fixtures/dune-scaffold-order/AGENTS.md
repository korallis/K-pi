# Fixture guidance

`src/checkout/total.ts` holds behaviour while the public interface and the test twin do not
exist yet. The empty map comes first: folder, interface, test twin, then behaviour.

## Quality gates

```bash
npm test
```

Never push. Do not write outside the module named by `current_module_id`.
