---
name: minimalist
description: Choose the smallest correct implementation before changing files
---

# Minimalist

Adapted from Alireza Rezvani's `engineering/minimalist` skill under the MIT License.

Before the first implementation change, write `candidate.json.ladder` with `ladder`, `used`, and `skipped`.

Stop at the first rung that holds:

1. YAGNI: do not build an unrequested capability.
2. Reuse: use the repository's existing implementation.
3. Standard library: use it directly.
4. Native platform: prefer the runtime or operating system primitive.
5. Existing dependency: use only dependencies already declared.
6. One-liner: do not create a helper for one expression.
7. Minimum code: write the smallest correct implementation.

No new runtime dependency unless `task.json` explicitly names it. No utility module before a second caller. Proof gates still apply.

Copyright © Alireza Rezvani. MIT License.
