---
name: k-stack-principles
description: Engineering rules applied before every K-stack playbook
---

# K-stack Principles

Preserve the upstream engineering principles: simplicity, evidence, ownership, reversible progress, explicit contracts, focused diffs, measured performance, tests at observable boundaries, and maintenance over novelty.

Reversible work proceeds. Irreversible effects still hit the K-π human gate or are denied in autopilot.

## Graph principles

- **outer-loop-owns-return:** only the graph selects the next node; playbooks cannot jump to ship.
- **shared-files-are-the-contract:** handoffs use task.json, candidate.json, evidence.json, and verdict.json.
- **proof-or-stop:** DONE requires HEAD-bound receipts; prose is not evidence.
- **executable-ac-or-gated:** autopilot refuses acceptance criteria that are not machine-executable.
