# Background Pi agents + communicate

**Normative.** k-pi does not use Cursor-style subagents (`Task`, `subagent_type`) and does not install pi-intercom, pi-mesh, pi-agents-talk-to-each-other, pi-bus, or pi-side-agents.

The forked harness base [does not ship sub-agents](https://pi.dev/). Workers are **real K-π sessions** started in the background. They talk with the harness's own injection APIs.

## Official primitives we wrap

| API | Role |
|---|---|
| `createAgentSession()` / `kpi --mode rpc` | Spawn a headless worker |
| `pi.sendUserMessage(content, { deliverAs })` | Deliver into a live session |
| `pi.sendMessage(...)` | Non-user custom events |
| `session.prompt` / RPC `prompt` | Start work on a headless session |
| `deliverAs: "steer"` | Interrupt after current tool |
| `deliverAs: "followUp"` | Wait until the current turn ends |

That pair — spawn + `sendUserMessage`/`prompt` — is the communicate path. We expose it as one tool so models do not invent a bus.

## Tools

### `spawn_background`

```
role: implementer | reviewer | tester | arena | explorer
model?: id from k-pi pool / kstack models.json
tools?: allowlist
prompt: string
```

Starts `kpi --mode rpc` (or in-process `createAgentSession` when tests need it) with:

- session file `.kpi/runs/<job>/agents/<role>-<id>.jsonl`
- same cwd as the job
- tool allowlist for that role (reviewer and tester: read + grep + test bash, plus the pinned `write_contract` below — never `write` / `edit`)
- model from K-stack role map, failed over through accounts

Returns `{ agent_id, session_path, pid }`. Writes `agent.spawned` to `events.jsonl`. Cap: `maxConcurrency = 2` live workers per job.

### Same-tree rule (v1, no worktrees)

Two workers share the project checkout. They must not edit the same files.

- At most **one** live worker may have `write` / `edit`. That is the writer. Reviewer and tester never get either tool; they publish through `write_contract`, which does not make them the writer.
- Before a writer edits path `P`, it calls `claim_path(P)`. Exclusive. Held in `.kpi/runs/<job>/leases.json`.
- Another claim on `P` is denied until release or the holder exits.
- Bounds still apply. A claim outside `task.json.allowed_paths` is `UNSAFE`.
- Parent implementer in the operator session counts as the writer if no worker writer is live.

`claim_path` / `release_path` are tools. Crash/reap of a pid releases its claims.

### `write_contract`

Reviewer and tester must publish a run-contract file without holding a general file-mutation tool. `write_contract` is that single, narrow surface. It is the only way those roles reach disk.

```
path: string      # must equal the role's declared contract path
content: object   # the parsed contract payload, not a diff and not prose
```

- **Pinned at spawn.** The capability is minted for one `agent_id`, one job, one role, and one declared contract path, and that tuple is fixed when the worker starts. Reviewer → `.kpi/runs/<job>/verdict.json`. Tester → `.kpi/runs/<job>/evidence.json`. A worker cannot widen its own pin at call time.
- **One path, everything else denied.** Any other `path` fails: product files, `task.json`, `release.approved`, another role's contract file, another job's run directory, and any `..` or symlink that resolves outside the pinned path. Denial is a returned error, never a silent no-op.
- **Schema before disk.** The payload validates against `verdict.schema.json` or `evidence.schema.json` first. An invalid payload writes nothing — no partial file, no placeholder — and the error goes back to the worker. A reviewer that cannot produce a valid verdict has failed review; it has not approved anything.
- **Atomic write.** A validated payload lands by temp file → fsync → same-directory rename, so the parent never reads a half-written contract.
- **Not a writer.** `write_contract` takes no `claim_path` lease, does not consume the one-writer slot, and does not relax the same-tree rule. Caps are unchanged.

### `communicate`

```
to: agent_id
message: string
deliverAs: "steer" | "followUp"   # default followUp
expect: "none" | "ack" | "result" # default none
```

- Live same-process session → `pi.sendUserMessage(message, { deliverAs })`
- Other process → RPC `prompt` into that worker (steer maps to immediate prompt, followUp waits for idle)
- Always appends `agent.message` to `events.jsonl` and `.kpi/runs/<job>/bus.jsonl`

`expect: "result"` waits until the worker writes its contract file (`candidate.json` / `evidence.json` / `verdict.json`) or hits timeout. It does not scrape the worker transcript into the parent context.

### `agents_status`

Lists live workers, last event, pid liveness. Dead pids are reaped.

### `agents_stop`

Sends a follow-up “stop, publish your contract file, exit”, then SIGTERM if needed.

## Who talks to whom

```
operator session (TUI, board, /kpi)
    spawn_background reviewer
    communicate to=reviewer "grade candidate.json"
    reviewer publishes verdict.json through write_contract
    parent reads verdict.json  — not the reviewer's chat
```

Handoffs stay the run contract files. Chat between agents is steering, not source of truth.

## Replaces

| Old idea | Now |
|---|---|
| K-stack `poteto-agent` / `k-agent` subagent | background K-π session with role prompt |
| `/swarm` fan-out | N≤2 `spawn_background` + `communicate` |
| `/arena` bakeoff | N≤2 arena workers, parent grafts from their `candidate.json` |
| `/interrogate` panel | one reviewer worker per panel model, results merge into `verdict.json` |
| Isolated reviewer node | background reviewer session, parent blocked on file |

## Board

File lamp row may include `BUS` when `bus.jsonl` exists. Header can show `AGENTS 2`. Worker names stay off the main transcript.

## Forbidden

- `subagent_type`
- installing community room/bus packages
- dumping a worker transcript into the parent model
- spawning Cursor Cloud
- more than 2 live workers
- granting `write` / `edit` to a reviewer or tester
- publishing `verdict.json` or `evidence.json` by any path other than that role's pinned `write_contract`
