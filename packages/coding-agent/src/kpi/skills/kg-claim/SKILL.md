---
name: kg-claim
description: Use when a decision should outlive the run, to propose a source-backed knowledge graph claim through the inbox.
---

# KG claim

A claim that outlives the run is a record, not a sentence in chat. Propose it with `kg_propose`, which writes one patch to `.kpi/kg/inbox/`. The control plane is the only authoritative writer: it snapshots the prior state, validates the patch, stamps the next revision, and appends to `.kpi/kg/{nodes,edges,sources}.jsonl`.

Never write those files, and never write `.kpi/kg/snapshots/`. Policy denies it, and a direct write would break the one-writer rule the store depends on.

## Patch contract

One patch carries a `source`, a `node`, an `edge`, or any combination, applied in that order so an edge may cite a source and a node the same patch adds.

Every record carries `id`, `kind`, `source_ids`, `status`, `observed_at`. The control plane assigns `rev`; state one only when you mean the exact next revision.

- `status` is `proposed | verified | rejected | superseded`. A claim you have not verified is `proposed`.
- `observed_at` is an RFC 3339 instant, and `valid_from` / `valid_to` bound a claim that is only true for a period.
- A `source` also carries `uri`. Register the source before, or in the same patch as, the claim that cites it.
- A `node` and an `edge` must cite at least one existing source id. An unresolvable `source_ids` entry is rejected.
- An `edge` also carries `from` and `to`, which must name known nodes, plus `confidence` between 0 and 1 when the edge is inferred rather than observed.

## When not to claim

Skip the claim for anything the run already records: acceptance criteria, evidence, verdicts, and commits live in the run store. Claim the durable decision and the source that justifies it.
