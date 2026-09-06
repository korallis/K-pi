---
name: quality-gates
description: Use to interpret deterministic verification receipts and required checks without manufacturing evidence.
---

# Quality gates

Read the exact quality gates and required acceptance checks in protected intent. The graph's deterministic verifier executes them and publishes candidate-bound receipts with raw output references. An agent may investigate failures and report diagnostics but cannot author authoritative `evidence.json` or invent successful command receipts.

Any required non-zero command or stale HEAD is red. Never replace a required command with an easier proxy, infer success from model output, or omit a failing receipt.
