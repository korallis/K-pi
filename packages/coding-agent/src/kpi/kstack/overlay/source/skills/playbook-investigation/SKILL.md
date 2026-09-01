---
name: playbook-investigation
description: Produce evidence about a system without changing product code. Use to investigate, research, diagnose, or explain why something behaves as it does.
playbook: investigation
match: investigate, research, diagnose, why, explain, understand, audit
---

# investigation playbook

Every step below is a K-π graph node. The graph decides which node runs next; a
step never jumps ahead of its gate. A step carrying `skip:` is kept in the todo
list with its reason rather than deleted, so the record shows what was not done.

## Steps

- **specify** State the question and the falsifiable hypotheses.
- **plan** Inspect repository sources and current authoritative references.
- **implement** Run one focused experiment. Write it under a scratch path, never into product code. `skip: an investigation changes no product code`
- **test** Record the experiment's output as evidence.
- **review** Write the conclusion and the evidence it rests on.
- **ship** Stop without shipping. `skip: an investigation produces evidence, not a commit`
