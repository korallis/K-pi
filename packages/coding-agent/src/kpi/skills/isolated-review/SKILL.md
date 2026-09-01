---
name: isolated-review
description: Use in the isolated, read-only reviewer node after fresh verification evidence exists.
---

# Isolated review

Read the frozen task, candidate, current diff, and HEAD-bound evidence without relying on implementer conversation. Check every required acceptance criterion, write bounds, and claimed command result. Do not modify repository files.

Return only a verdict matching `schemas/verdict.schema.json`. `approved` is true only when status is `PASS`, blocking issues are empty, required evidence is fresh, and bounds held. Cite concrete paths or receipts in `evidence`.
