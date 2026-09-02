---
name: k-mode
description: K-π's sticky rigor mode. Matches the task to a K-stack playbook, expands its steps into the job todo list, and keeps the graph's gates in charge. Use for /k-mode, when a task needs a playbook, or when rigor is requested.
disable-model-invocation: true
mode: true
icon: crown
color: yellow
reminder: New task? Playbook match or rigor needed -> apply /k-mode. Casual turn or user opts out -> don't.
---

# K-mode

Sticky. Once on, it stays on until `/k-mode off`.

K-mode supplies node-local engineering technique. It never supplies order: the
K-π graph decides which node runs next, and a playbook step cannot jump a gate.
Where a playbook and a K-π contract disagree, the contract wins.

## What happens when you turn it on

1. The task is matched against the `match` list in each `playbook-*` skill's
   frontmatter. The first playbook whose keywords hit wins; `playbook-feature` is
   the fallback.
2. The matched playbook is frozen into `task.json.playbook`. It does not change
   for the life of the job.
3. Every step in that playbook becomes a todo, tagged with the graph node allowed
   to complete it. A step the playbook marks `skip:` stays in the list with its
   reason, so the record shows what was deliberately not done.
4. Only the node named by a todo may complete it. The reviewer writes
   `verdict.json` and nothing else.

## Playbooks

The registry is the `playbook-*` skills. `playbook-feature`, `playbook-bug-fix`,
`playbook-investigation`, `playbook-shipping`, `playbook-autonomous-run`,
`playbook-arena`, `playbook-swarm`, `playbook-autopilot-full` and
`playbook-autopilot-stack` each declare their own steps and match keywords. Read
the one that matched; do not read the whole set.

`/figure-it-out` writes a one-off playbook under `.kpi/kstack/playbooks/` when
nothing matches.

## Principles

`k-stack-principles` carries the four graph principles, which are always in
force. The upstream `principle-*` skills load on demand: read the one whose
description matches the node you are in, never the whole index.

## Delegation

Work that fans out goes through the K-π bus: `spawn_background` starts a local
background K-π session, `communicate` steers it, and the parent reads the
worker's contract file rather than its transcript. At most two workers are live
and at most one of them may write. There is no in-process delegate, no remote
runner, and no second checkout.

Models come from `~/.kpi/agent/kstack/models.json`, written by `/setup-kstack`. A
role is a model id resolved at spawn time, never a slug written into a skill.

## Irreversible effects

Reversible work proceeds. A commit in gated mode, a push, a deploy, a delete, or
a new runtime dependency reaches the K-π human node or is denied in autopilot.
K-mode never widens that.
