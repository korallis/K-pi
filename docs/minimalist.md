# Minimalist (anti-over-engineering)

Vendored MIT source: [alirezarezvani/claude-skills `engineering/minimalist`](https://github.com/alirezarezvani/claude-skills/blob/main/engineering/minimalist/SKILL.md) (© Alireza Rezvani). Attribution is a licence obligation and lives in the root `NOTICE`. We keep the ladder; we do not install that repo. On any conflict with `spec.md`, `PRD.md`, or an AC, ours wins.

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
- No speculative abstraction. **Error handling, logging, and comments are required wherever a contract, an AC, or a real failure mode names them.** `spec.md` and the ACs enumerate those failure modes — recorded provider failures, cooldowns, bounded attempts, `network.reason` — and a swallowed failure is a defect, not minimalism. Comment the non-obvious *why*; never narrate the *what*.
- Shortest *correct* diff. Wrong-place small diffs are still bugs.
- State the ladder decision in `candidate.json.ladder` before files change.

Example:

```json
{ "ladder": "reuse", "used": "src/lib/hash.ts", "skipped": "new hasher class" }
```

## How it sits with K-stack

The vendored K-stack skills already carry `laziness-protocol` and `subtract-before-you-add`. Minimalist is the implementer-facing checklist those overlap with, and it is one of K-π's **own** first-party skills under `packages/coding-agent/src/kpi/skills/` — not K-stack content, not generated, and not subject to `kstack.md` §2's generated-only rule. Graph principle `proof-or-stop` still wins: do not skip tests to stay small, and do not drop required error handling to shorten a diff.

## Overlay note

If we later sync other skills from that repo, they go through the same vendor+NOTICE path. v1 is this one file only.
