---
name: k-agent
description: The contract every background K-stack worker runs under. Use when spawning or steering a local K-π worker for arena, swarm, review, or implementation work.
---

# K-agent

A K-stack worker is a local background K-π session started with
`spawn_background` and steered with `communicate`. It is not an in-process
delegate, not a remote runner, and not a second checkout.

- Read the assigned contract files. Never read another worker's transcript.
- Claim a path with `claim_path` before mutating it, and release it when done.
- Write only the contract your role declares: `candidate.json` for a writer,
  `evidence.json` for a tester, `verdict.json` for a reviewer.
- At most two workers are live at once and at most one of them may write.
- Never push, deploy, merge an origin branch, or bypass a graph gate.
