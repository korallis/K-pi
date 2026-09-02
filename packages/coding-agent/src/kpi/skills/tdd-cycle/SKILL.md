---
name: tdd-cycle
description: Use when the implementer writes or changes production behavior.
---

# TDD cycle

For non-trivial behavior, add or update the smallest test that expresses the frozen acceptance criterion. Run it before production changes and preserve the failing command, exit code, and relevant output in `evidence.json`. Implement only enough to make that behavior pass, then rerun the focused test.

Never weaken an assertion to obtain green. Keep deterministic tests isolated and full-suite safe. A one-line fix may skip the red step only when `task.json` identifies it as trivial.
