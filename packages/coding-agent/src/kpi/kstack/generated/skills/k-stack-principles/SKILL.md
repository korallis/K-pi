---
name: k-stack-principles
description: The engineering rules every K-stack playbook applies before its first step. Use when a playbook step says read Principles, or before implementing, reviewing, or shipping under /k-mode.
---

# K-stack principles

Upstream engineering principles ship as their own `principle-*` skills and load on
demand. These are the four graph principles K-π adds, and they are always in
force.

| id | rule |
|---|---|
| outer-loop-owns-return | The graph decides the next node. A playbook step cannot jump to ship. |
| shared-files-are-the-contract | Handoffs are `task.json`, `candidate.json`, `evidence.json`, `verdict.json` — never chat memory. |
| proof-or-stop | No DONE without HEAD-bound receipts. A model reporting that tests passed is not evidence. |
| executable-ac-or-gated | An autopilot playbook refuses to start unless `ac.quality` is `executable`. |

## The never-block-on-the-human override

Reversible work proceeds without asking. Irreversible effects — a commit in gated
mode, a push, a deploy, a delete, a new runtime dependency — still reach the K-π
human node, or are denied outright in autopilot. The outer loop owns those gates,
and this principle never removes one.
