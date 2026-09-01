# Healthcheck requirements

- `GET /health` responds with status `200`.
- The JSON response is exactly `{ "status": "ok" }`.
- Other paths preserve the existing `404` response.
- `npm test` and `npm run lint` pass.
