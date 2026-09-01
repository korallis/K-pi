# Minimalist (anti-over-engineering)

**Normative.** Vendored from [alirezarezvani/claude-skills `engineering/minimalist`](https://github.com/alirezarezvani/claude-skills/blob/main/engineering/minimalist/SKILL.md) (MIT, © Alireza Rezvani). We keep the ladder. We do not install that repo.

Runtime file: `skills/minimalist/SKILL.md`  
Always on for implementer, planner, and K-mode. Listed in `APPEND_SYSTEM.md`.

## Efficiency ladder

Stop at the first rung that holds:

1. **YAGNI** — If the user did not ask for it, do not build it.
2. **Reuse** — Exists in this repo? Use it.
3. **Standard library** — Use it directly.
4. **Native platform** — OS / runtime feature first.
5. **Existing dependency** — Already in package.json only.
6. **One-liner** — Prefer one line over a helper.
7. **Minimum code** — Only then write the smallest thing that works.

## Rules we enforce as gates

- No unrequested interfaces, base classes, or generics.
- No new runtime dependency unless `task.json` names it. Autopilot cannot add one.
- No utility module before a second caller exists.
- No comments, logging, or error handling the user / AC did not ask for.
- Shortest *correct* diff. Wrong-place small diffs are still bugs.
- State the ladder decision in `candidate.json.ladder` before files change.

Example:

```json
{ "ladder": "reuse", "used": "src/lib/hash.ts", "skipped": "new hasher class" }
```

## How it sits with K-stack

Upstream pstack already has `laziness-protocol` and `subtract-before-you-add`. Minimalist is the implementer-facing checklist those principles need. Graph principle `proof-or-stop` still wins: do not skip tests to stay small.

## Overlay note

If we later sync other skills from that repo, they go through the same vendor+NOTICE path. v1 is this one file only.
