---
name: setup-kstack
description: Map K-stack roles onto the models this K-π session can actually reach, then offer research keys. Use for /setup-kstack, first-run setup, or changing which model a K-stack role uses.
disable-model-invocation: true
---

# Setup K-stack

Writes `~/.kpi/agent/kstack/models.json`: the one place a K-stack role becomes a
model id.

## The contract

- Candidates are the live registry intersected with healthy K-π pools. A model
  that is not in `getAvailable()` is not offered, whatever any table says.
- The suggestion order comes from the repository's model-ladder document, read at
  setup time and never scraped from the network. It is a suggestion table, not a lock.
- For each role the command shows the chosen slug, the next-best candidate, and
  the ladder's confidence for that role.
- `review_panel` takes models from different families, in ladder order, capped at
  three, because a panel of one family reviews its own habits.
- `fallback_models` is the exact live cross-provider order used only after every
  account slot for the current provider is low or exhausted. The command derives
  it from the ladder and lets the operator edit it before the atomic write.
- A role with no live match is written as `inherit-parent`: it runs on the parent
  session's model.
- Any line may be edited before the file is written. An edit that names a slug
  outside the live candidate set is refused, not saved.
- The file is written atomically. A partially written model map would be read on
  the next spawn.

## Roles

| Role | What it drives |
|---|---|
| implementer | the writer node |
| frontend | UI-shaped slices |
| judgment | review and taste |
| precise | exact contracts |
| fast | cheap movers |
| review_panel | the ordered cross-family review panel |

No remote runner is ever offered, and no slug is required as a default.
Failover stays in the K-π accounts balancer. It preserves the exact model while
healthy sibling subscription slots remain, hands off at 5% remaining or on a
classified limit, and only then follows `fallback_models`. Slots live in
`accounts.json`.

## After the model map

The command offers to save an Exa key, a Perplexity key, both, or neither.
Skipping both leaves research in local mode, which is a narrower mode and not a
failure.
