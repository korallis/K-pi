---
name: context-pack
description: Use at job start to freeze the minimum repository and task context needed by graph workers.
---

# Context pack

Build run-scoped `context.md` from the goal or frozen plan, applicable `AGENTS.md`, repository structure, relevant existing patterns, constraints, and quality gates. Prefer file-backed facts over conversation memory. Include exact source paths and omit secrets, generated output, unrelated files, and speculative decisions.

Once execution begins, acceptance criteria and frozen plan fingerprints do not change. A mismatch requires a plan check or human decision.
