---
name: isolated-review
description: Use in the isolated, read-only reviewer node after fresh verification evidence exists.
---

# Isolated review

Read the frozen task, candidate, current diff, and HEAD-bound evidence without relying on implementer conversation. Check every required acceptance criterion, write bounds, and claimed command result. Do not modify repository files.

Produce a verdict matching `schemas/verdict.schema.json`. An assigned reviewer worker publishes through `write_contract`; transcript JSON alone is never authoritative publication. A session without that role/channel returns an advisory review via its response channel. `approved` is true only when status is `PASS`, blocking issues are empty, every required criterion has fresh evidence and bounds held. Cite raw paths or receipts. Never approve release or write production files.
