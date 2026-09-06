# Local peer runtime

K-π uses native agent sessions, both in-process graph sessions and owned `kpi --mode rpc` child processes, with persistent native session JSONL files. A job-owned `BackgroundBus` supplies the shared authenticated Unix-domain socket broker. The broker routes messages; it does not execute graph nodes, choose plans, or replace the native agent runtime. No external room package, filesystem inbox poller, or second orchestrator is involved. The shared `registerRuntime` bootstrap installs account routing, resources, peer tools, knowledge/research tools and policy for ordinary and graph sessions; graph-session setup adds its authenticated peer binding and canonical context extension.

## Identity and lifetime

The canonical run root remains `.kpi/runs/<job>`. The job owns:

- `agents/`: native transcripts; RPC workers use `agents/<agentId>.jsonl`, while graph sessions use native session files beneath the node/thread's session directory;
- `peer-events.jsonl`: ordered, fsynced logical identities, task references, room membership, message envelopes, and acknowledgement cursors;
- existing contract files and publication receipts, still checked for capability, canonical path, schema, and content hash;
- verification evidence is host-owned; tester peers cannot publish `evidence.json` or mint verification receipts.
- `bus.jsonl` and `events.jsonl`: audit records, **not message transports**.

`agentId` is the canonical logical peer, not a native session ID or a model slug. RPC workers use stable role-prefixed names; graph peers retain their recorded job/thread identity in run state. PID, native session incarnation, broker incarnation UUID, model resource and transport bearer are distinct. An isolated graph assignment may create and dispose a native session without deleting its logical peer; thread mode reuses or continues native history. Canonical identity, membership and inbox are not reconstructed from transcript text.

For RPC workers, `spawn({agentId, ...})` reuses an existing live peer, or reopens its recorded session after the previous process has exited. `restart(agentId)` uses the recorded prompt, model, tools and task reference. Room membership and cursor survive both peer replacement and owner restart. A changed RPC launch model/tool allowance requires stopping the live peer first. The broker's logical role and recorded session path cannot change through activation; that is not a requirement to keep one native session UUID or model forever. Graph routing observes native model changes and records the actual resource while retaining logical identity; pinned architecture assignments instead reject a resource switch.

This is an **owner-lifetime service**, not a detached daemon. Owner shutdown stops its RPC children and closes the socket. Abrupt owner death closes their RPC pipes; a later owner can recover records and reopen sessions, but refuses replacement while a recorded PID still appears alive. It does not adopt arbitrary surviving processes. PID reuse can conservatively block recovery.

The Unix socket is a short hash-derived path from the canonical run root in the OS temporary directory and is mode `0600`. A durable `peer-owner` lock is acquired before journal recovery and held through socket shutdown. Existing accepting sockets are never removed. Dead-lock recovery uses separately owned recovery locks, so simultaneous reapers cannot unlink a new live holder; a crashed reaper is recovered by the same mechanism. Only verified dead PIDs are recovered. A stopped process, reused PID, permission failure, or unreadable ownership record fails closed; age is not evidence of death.

## Worker tools

RPC workers receive these tools through the built-in extension. Explicit tool narrowing may remove them but cannot widen a role's authority. Protected graph sessions expose authenticated `communicate` and `peers` through `GraphPeerBinding`; their mutation and publication authority remains the graph node's, not the broker descriptor's.

### `communicate`

Send exactly one direct or room message:

```json
{"to":"tester-auth","message":"Run the declared auth gate","id":"auth-gate-request-17"}
```

```json
{"room":"auth-review","message":"Revision is ready","id":"auth-revision-17","replyTo":"prior-message-id"}
```

RPC worker `communicate` accepts optional `deliverAs` (`steer` or `followUp`); the graph-peer variant always sends `followUp` and does not expose that option. The runtime derives sender from the authenticated incarnation, never from a model-controlled `sender`, role, PID, job or capability argument. Unknown broker fields are rejected. A room sender must first join that room. A reply must name a message the sender sent or received.

The response includes `accepted`, `message` and `duplicate`. Here `accepted: true` means the full envelope was durably appended, **not** that a model processed it or completed a task. Reusing an ID with the same envelope returns the original sequence; reusing it for different content/origin/destination is refused.

### `peers`

- `{"action":"discover"}` lists only this job's logical peers, roles, task references, rooms, incarnation and presence. No bearer or publication capability is returned.
- `{"action":"join","room":"auth-review"}` and `leave` durably change this peer's membership.
- `{"action":"inbox"}` returns this peer's unacknowledged messages in order, at most 100 and within the bounded response size.
- `{"action":"inbox","after":0}` explicitly replays this peer's history without changing its cursor. Use the last returned sequence as `after` to page.
- `{"action":"ack","id":"message-id"}` advances only this peer's cursor, and only over its next unacknowledged message. Repeating an acknowledgement is harmless; skipping a pending message is refused.

Room recipients are snapshotted at send time. Disconnecting does not remove room membership, so messages sent while a peer is offline remain available to it. Joining later does not grant earlier room history. Neither direct delivery nor context projection reveals another peer's inbox.

Messages carry sequence, ID, authenticated sender, concrete recipients, optional room/task/reply reference, text, timestamp and delivery mode. `readPeerMessages(runDirectory, agentId, taskId?)` is the read-only context projection; optional task filtering includes matching and job-level messages only.

## Realtime delivery and replay

The socket broker accepts direct and room messages without filesystem polling and offers arrivals through the registered native delivery adapter. For RPC children, delivery uses `prompt` with `streamingBehavior`: the atomic native operation starts an idle session and queues correctly during streaming. Queue-only `steer`/`follow_up` RPC commands are not used for peer work delivery.

For in-process graph peers, `GraphPeerBinding` serializes assignments and message turns on one logical peer. Delivery obtains the current node's native session and calls `session.prompt` after its current assignment, with the envelope explicitly marked as data, not protected intent or a new assignment. Mutating followups acquire checkout writer authority and bind it to that exact native session for the turn. The receiver can respond directly with `communicate` and acknowledge with `peers`; a message turn cannot publish a new task result or establish completion. Completed/disposed executions refuse new message turns. This is actual native followup delivery, not merely an audit entry or context projection.

Delivery does not move the durable cursor. The receiving peer acknowledges after handling the message. If a process or owner dies before acknowledgement, the new incarnation is offered that message again. This is **at-least-once delivery**, with durable envelope-ID deduplication and ordered explicit acknowledgement. It does not promise exactly-once arbitrary shell effects: consumers must use message IDs and independently verified artifacts when an interrupted operation could be repeated.

Connections have bounded LF-only JSONL framing, bounded pending requests, request/connect/drain deadlines and idle timeouts. Text messages are limited to 32,000 characters; wire/journal records to 128,000 characters. Journal capacity is bounded and exceeding it refuses further acceptance rather than silently dropping history. Worker extensions heartbeat every 20 seconds; presence ages offline after 60 seconds. Presence is a liveness projection, not proof of progress or completion. An authenticated connection is not an OS sandbox: processes under the same OS account with unrestricted shell/read access remain trusted harness participants.

## Mutation and publication authority

Scheduler concurrency is operational policy: `KPI_MAX_PEERS` configures the default process admission limit (default 8); hosts/tests can inject `createWorkerAdmission({maxWorkers})`. This capacity is process-scoped, but **writer exclusion is checkout-scoped**, independent of job, bus, or owner process. `.kpi/ownership/{writers,leases}.json` records are updated under one cross-process hard-link lock. Every holder is identified by the complete job ID, agent ID, process PID and incarnation UUID; matching only agent ID or PID does not grant claim, mutation, transfer or release.

An implementer/arena holding general `bash` reserves the whole checkout **before launch**, even when `write` and `edit` were narrowed away. That reservation is durably transferred to the child PID before its first prompt. For edit-only peers, `spawn({writePaths: ["src/auth"], tools: [...]})` can reserve explicit scopes; disjoint canonical scopes run concurrently, while ancestor/descendant, symlink-alias and same-path overlap are refused. A scoped peer cannot carry unrestricted `bash`. Omitting `writePaths` retains whole-checkout exclusion.

Reviewer/tester shells remain limited to exactly their frozen quality gates; potentially mutating gates also acquire whole-checkout authority, retained until peer stop. The scheduler must stop the candidate writer before those gates execute. Explorer shells and classified read-only parent commands remain concurrent. Gate execution does not grant model-written verification receipts or candidate publication authority.

`claim_path`, `release_path` and publication use narrow authenticated broker methods. Named file mutations additionally require a canonical claim belonging to the active process incarnation; a directory claim covers its descendants. Escape through lexical traversal, dangling or existing symlinks is refused. Multiply-linked file targets are refused by the path-claim boundary because arbitrary hard-link aliases cannot be fenced by names alone. The durable writer reservation remains held after individual claim release, preventing in-flight mutations from being handed to another writer. Failed process termination retains both reservation and admission; transport loss alone never releases either.

`write_contract` executes in the owning runtime, retaining the existing role pin, canonical path checks, schema validation and content-hash receipt. Workers cannot choose another sender/role's pin through tool parameters. The runtime never returns the bearer in tool results. A stop failure retains the live record and admission; successful transfer occurs only after process exit and lease cleanup. SIGKILL is followed by a bounded wait for confirmed exit, not immediate release.

## Graph and parent integration

Use the shared registry factory:

```ts
const bus = getOrCreateBackgroundBus(cwd, runDirectory, jobId, dependencies);
const worker = await bus.spawn({
  agentId: "reviewer-review-node",
  role: "reviewer",
  prompt,
  node: "review-node",
});
const result = await bus.awaitInitialContract(worker.agentId);
```

Keep the bus and peer between node executions; do not `stopAll()` or release its registration in a node's `finally`. Stop at the run/runtime ownership boundary instead. The factory, parent tools and `/agents` consume the same registry; there is no separate private parent lookup that hides graph workers. Parent `communicate` retains its existing `none`/`ack`/`result` contract: `none` means only bounded pipe delivery, `ack` means native RPC acceptance, and `result` additionally requires the existing fresh validated publication. Parent messages are also journaled. These legacy flags are distinct from a worker socket send's durable acceptance.

Direct host mutation and verification executors use `reserveWriterAuthority(cwd, owner, paths)` and `releaseWriterAuthority(cwd, owner)`, where `owner` is `{jobId, agentId, pid, incarnation}`. Reserve before execution and release only after execution/termination is confirmed. Bind an in-process node's exact session ID using `bindSessionWriterAuthority(sessionId, owner)` for that turn and dispose the binding afterward. The tool boundary verifies the complete bound owner against disk; another session in the same PID cannot borrow it. Unbound parent tool calls acquire their own reservation through `tool_execution_end`. Host verification remains separate from peer publication.

## Canonical context at inference

For protected-intent graph sessions, the native `context` hook rebuilds an ephemeral `kpi-runtime-context` message before each inference, including continuation and retry turns. It removes the prior projection from that request rather than appending another copy to persisted session history. Reset, compaction, isolated-session replacement and resource changes therefore do not make transcript memory authoritative.

Assembly rechecks `intent.json` against `task.json`, preserves the complete protected intent, and adds bounded execution state, feature ownership, raw evidence references, relevant failure/approval events, this peer's task-scoped messages, accepted knowledge claims and repository maps. These are retrieved data; neither peer messages nor knowledge claims authorize scope changes, write ownership, external actions or completion. Product ownership and structural repository maps remain separate. `context_map` supports targeted retrieval; `context_navigate` reports real configured LSP capabilities or unsupported status rather than calling text search semantic navigation.

The current resource's context capacity, history, system prompt and output reserve constrain assembly. Unknown/nonpositive capacity, unavailable protected state or mandatory context overflow blocks inference through the native extension runner; there is no invented capacity that makes an unknown resource safe. Optional layers may be omitted with raw references and coverage recorded in `context/manifest-*.json`. Model-bound authorized tokenizers can measure serialization candidates; without one, budgeting is explicitly a conservative UTF-8-byte estimate, not measured model tokens. The ephemeral projection never rewrites canonical evidence.

## Remaining limits and verification

- These are enforced harness/tool authority boundaries, **not mandatory OS isolation**. An independently launched hostile process under the same OS account, a legacy runtime bypassing this boundary, an authorized arbitrary shell that tampers with lock files, or a detached descendant surviving its managed parent can bypass cooperative filesystem fencing. Filesystem paths can also be changed between preflight and the actual syscall by such a process. Strong hostile-process guarantees require OS sandboxing or separate OS identities/workspaces; they are not claimed here.
- Publication results still use the existing role files and receipt validation. Same-role concurrent publications can invalidate a shared projection's hash; this fails closed but is not immutable per-assignment result storage. Legacy contract-result waits still inspect files; those waits are not the peer message transport.
- Reply correlation identifies messages, not independent evidence completion. Parent concurrent result requests to one peer are refused, but a settle event plus publication is not proof of a task's external effects.
- Automatic owner recovery restores logical records, not a running daemon. Reopening a peer is explicit through stable `spawn`/`restart`; replays do not prove exactly-once effects.
- RP-22 scoped evidence is retained under `.kpi/proof/RP-22/`. `scoped-tests-8.json` records exit 0 for the scoped run including `test/peer-runtime.test.ts`, `test/graph-peer.test.ts`, `test/context.test.ts`, bus, ownership and routing fixtures; `native-context-runner.json` records the native extension-runner suite passing. These cover authenticated transport/replay, graph delivery adapters, local process ownership and fail-closed context behavior, not live model quality. `build-offline.json` and `built-harness.json` record successful offline build and built startup/resource/RPC smoke. No validation was rerun for this documentation update. Live credentialed three-peer inference, live failover and representative model-quality comparisons remain unverified here; these local proofs do not complete RP-22's DoD or the full autonomous-runtime mandate.
