# Fixture guidance

Add the healthcheck without dependencies. Keep response handling in `src/server.js` and behavior checks in `test/health.test.js`.

## Quality gates

```bash
npm test
npm run lint
```

Never push. Do not edit files outside `src/server.js` and `test/health.test.js`.
