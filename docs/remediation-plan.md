# remediation-plan.md — k-pi

> **STATUS: ACTIVE.** This is the only implementation queue. `roadmap.md` and `implementation-plan.md` are historical build records, not completion evidence.

**How agents use this file.** Pick the lowest incomplete `RP-##` whose dependencies are complete. Implement only that package. Run its scoped verification. Check its DoD only after the observable result passes. Do not use historical `[x]` boxes as proof.

IDs: `RP-##`. Stories and ACs: `PRD.md`. Normative contracts: `spec.md` and focused product docs. Research and gap IDs: [`remediation-research.md`](remediation-research.md).

## Execution rules

1. Read the package's listed sources before editing. Reuse the existing module and test patterns.
2. One writer owns a file. Do not parallelize packages that name the same source file.
3. A package owns only its listed gap IDs. If another gap appears, add it to the research register and assign one owner before editing.
4. Run only the package's scoped tests while packages are in flight. RP-19 runs the full product gates once.
5. Use injected clocks, fetches, process launchers, RPC peers, and temporary HOME/repository roots. No cloud keys, model downloads, real sleeps, or production services in tests.
6. Tests must exercise observable behavior. A source-text assertion is insufficient unless the source text itself is the contract, such as forbidden dependency or packaged-resource inventory.
7. Update the owning product docs in the same package as behavior. Do not defer contract drift to RP-19.
8. Do not push, deploy, publish, create a PR, or add a runtime dependency as part of this plan.

## Constraints not requiring a product decision

- Pi `0.84.4` is the baseline. Use Pi's resource loader, official catalogs, native llama.cpp provider, sessions, and RPC.
- No custom prompt/skill/theme loader.
- No Cursor authorization-code requirement. Pi-compatible paste/manual/device login is valid.
- No cross-process worker cap in v1.
- `APPROVAL` is a derived protocol-blue board lamp while a human node is paused, never a serialized stop state. Persisted stop states remain `DONE | BLOCKED | EXHAUSTED | NO_PROGRESS | UNSAFE | NEEDS_HUMAN`.
- Exa and Perplexity are research credential targets, not model pools.
- Exa content is capped at 10,000 characters before model handoff or persistence.
- Global `after_provider_response` classification uses status and headers. Body classification is limited to custom fetch clients that own the body.
- The current Dune module is explicit; `modules[0]` is never an implicit current module.
- Generated Pi-loadable K-stack output is the only runtime truth. `make-bot-ui` and the documented drop list are excluded.
- Relevant K-stack upstream drift is a changed pstack tree, not an unrelated repository HEAD change.

## `NEEDS_HUMAN` gates

Recommendations below are non-authoritative. RP-00 cannot complete while any gate is `OPEN`; document precedence must not select an option.

| ID | Status | Decision required | Recommended option | Blocks |
|---|---|---|---|---|
| NH-01 | OPEN | Reconcile AC-27.6 local footer semantics with `spec.md`'s `oauth | api_key` slot-kind enum. | Add a credential-free `local` slot kind. | RP-01, RP-08, RP-18 |
| NH-02 | OPEN | Reconcile local completion after provider exhaustion with AC-29.2's two-external-source rule unless `no-network` is set. | Permit engine-set effective `no-network` only after bounded, recorded provider failures. | RP-01, RP-09, RP-10, RP-18 |
| NH-03 | OPEN | Reconcile reviewer/tester write denial with the requirement that the reviewer publish `verdict.json`. | Add a schema-validating capability restricted to the declared run-contract file. | RP-01, RP-13, RP-14, RP-18 |

## Dependency map

```text
RP-00
  └─ RP-01
      ├─ RP-02 ───────────────┐
      ├─ RP-03 → RP-04 ───────┼→ RP-05
      ├─ RP-06 → RP-07 → RP-08
      │             └→ RP-09 → RP-10
      └─ RP-12

RP-05 + RP-10 → RP-11
RP-01 + RP-11 → RP-13
RP-05 + RP-13 → RP-14
RP-05 + RP-11 → RP-15
RP-08 + RP-10 + RP-13 + RP-15 → RP-16 → RP-17
RP-05 + RP-07 + RP-10 + RP-12 + RP-13 + RP-16 → RP-18
RP-02…RP-18 → RP-19
```

---

## RP-00 — Activate remediation authority and align contracts

**Depends on:** —  
**Owns gaps:** DOC-01, DOC-02  
**Stories:** Traceability for US-01–US-30

### Read first

- `remediation-research.md`
- `PRD.md` §6, §10, §11
- `spec.md` §4–§14
- `research.md`, `dune-architecture.md`, `kstack.md`, `agents-bus.md`, `visual-targets.md`
- Historical `roadmap.md` and `implementation-plan.md`

### Change

- Add historical supersession banners to `roadmap.md` and `implementation-plan.md`. Preserve their remaining bodies and checkboxes.
- Route `AGENTS.md`, `docs/AGENTS.md`, `START-HERE.md`, `docs/START-HERE.md`, `docs/BUILD-PROMPT.md`, `docs/README.md`, and the PRD companion list to this file.
- For NH-01 through NH-03, stop and present the conflicting clauses and concrete options to a human. Record each exact human decision in this gate table and the affected normative documents. Never resolve a gate by document precedence.
- Apply only corrections that do not choose between conflicting product behaviors: compatible Exa/Perplexity research-target separation; primary API constraints for Exa's 10,000-character cap and status/header-only global response hooks; explicit current-module execution state; K-stack runtime authority; resume/US-22/US-23 historical trace.
- Create `test/docs-routing.test.ts` to validate active-plan routing, gap-owner uniqueness, and the decision-gate block.

### Tests

- Every active next-step pointer resolves to `docs/remediation-plan.md`.
- Historical files carry `STATUS: HISTORICAL` before their old instructions.
- Every gap ID in `remediation-research.md` has exactly one `Owns gaps` occurrence in this plan.
- No `RP-##` is duplicated and every dependency names an existing lower package.
- RP-00 remains blocked while any NH gate is `OPEN`; a closed gate names the deciding human, date, selected option, and aligned normative files.

### Verification

```bash
node --test --experimental-strip-types test/docs-routing.test.ts
```

### DoD

- [ ] One active queue; historical completion authority revoked
- [ ] NH-01 through NH-03 have explicit human decisions and aligned normative contracts
- [ ] Non-gated contract and primary-API corrections are internally consistent
- [ ] Gap-owner, dependency, and decision-gate checks pass

---

## RP-01 — Conform schemas, events, redaction, and package boundaries

**Depends on:** RP-00  
**Owns gaps:** STORE-01, STORE-02  
**Stories:** US-14; supports US-23 and US-28–US-30

### Read first

- `spec.md` §5 schemas and event contract
- `extensions/run-store.ts`, `extensions/append-log.ts`
- `schemas/*.schema.json`
- `test/run-store.test.ts`, `test/append-log.test.ts`, `test/package.test.ts`

### Change

- Make TypeScript payload types and all four JSON schemas describe the same task, evidence, verdict, and event payloads.
- Add explicit research and bus event types required by later packages.
- Centralize event redaction for bearer values, cookies, passwords, provider keys, and known key prefixes.
- Reject raw vendor envelopes and headers from persisted event payloads; later clients persist normalized fields only.
- Define the publish-artifact allowlist in `package.json`; include runtime resources and exclude docs-only upstream, tests, fixtures, secrets, and maintainer debris.
- Create `test/schema-conformance.test.ts`; extend existing store/log/package tests.

### Tests

- Representative live payloads validate; one targeted mutation per schema fails.
- Research/bus events round-trip through schema validation, redaction, append, and hash-chain verification.
- Secret canaries never appear in the stored JSONL.
- `npm pack --dry-run --json` inventory matches the allowlist without creating a publish.

### Verification

```bash
node --test --experimental-strip-types test/schema-conformance.test.ts test/run-store.test.ts test/append-log.test.ts test/package.test.ts
```

### DoD

- [ ] Schemas and live writers agree
- [ ] Research/bus events are typed, redacted, and hash-chained
- [ ] Publish payload is explicit and secret-safe

---

## RP-02 — Complete gated and autopilot command policy

**Depends on:** RP-01  
**Owns gaps:** POL-01, POL-02, POL-03  
**Stories:** US-13; AC-13.1–AC-13.4

### Read first

- `spec.md` policy and node-tool sections
- `extensions/policy.ts`, `templates/policy.json`
- `test/policy.test.ts`

### Change

- In gated mode, classify `git commit` as confirm and include the current diff stat in the prompt.
- In autopilot, deny `git commit` until the active job has fresh `release.approved === true`.
- Confirm unknown commands in gated mode; deny them in autopilot.
- Preserve an exact safe-command allowlist for non-mutating Git inspection and task-declared quality gates.
- Keep all AC-13.1 denies and protected `verdict.json`/`release.approved` writes.

### Tests

- Registered `tool_call` hook, not only a pure evaluator, covers accept and decline for gated commit.
- Prompt contains files changed, insertions, and deletions.
- Autopilot commit fails before release and passes after release.
- Unknown command behavior differs by mode; known safe commands do not prompt.

### Verification

```bash
node --test --experimental-strip-types test/policy.test.ts
```

### DoD

- [ ] AC-13.2–AC-13.4 pass through the live hook boundary
- [ ] Existing AC-13.1 denials still pass

---

## RP-03 — Enforce graph budgets and bounded scheduling

**Depends on:** RP-01  
**Owns gaps:** GRAPH-01, GRAPH-02, GRAPH-03  
**Stories:** US-03, US-05; stop-state and graph-engine contracts

### Read first

- `spec.md` §6–§8
- `extensions/graph/schema.ts`, `extensions/graph/engine.ts`, `extensions/graph/stop.ts`
- `test/graph-engine.test.ts`, `test/stop.test.ts`

### Change

- Inject clock and accumulated-cost sources into the engine.
- Enforce `maxCostUsd`, `timeoutMs`, `maxNodeRuns`, `maxRounds`, and existing step limits.
- Translate every exhausted limit to product terminal `EXHAUSTED` plus one `loop.terminal` event; do not leak internal `failed`/throw as the product result.
- Schedule ready nodes in batches no larger than `maxConcurrency`; do not reject a valid wide superstep.
- Source caps from the validated task/job contract and persist counters needed by RP-04.

### Tests

- Injected cost and clock cross each cap without sleeps.
- Eight ready nodes at concurrency two execute in four batches; peak concurrency is exactly two.
- Each cap produces persisted `EXHAUSTED`, one terminal event, and no unhandled exception.
- Custom task limits override defaults.

### Verification

```bash
node --test --experimental-strip-types test/graph-engine.test.ts test/stop.test.ts
```

### DoD

- [ ] Every configured cap is enforced
- [ ] Wide supersteps are bounded, not rejected
- [ ] Exhaustion is a durable product state

---

## RP-04 — Persist stop, retry, and resume state

**Depends on:** RP-03  
**Owns gaps:** GRAPH-04, GRAPH-05, GRAPH-06  
**Stories:** US-05, US-14; AC-14.4

### Read first

- `extensions/graph/stop.ts`, `extensions/graph/engine.ts`, `extensions/gated-loop.ts`
- `test/stop.test.ts`, `test/resume.test.ts`

### Change

- Extend the pure stop reducer with canonical output fingerprints and sorted failing-AC-id sets.
- Return `NO_PROGRESS` when the same failing AC-id set occurs in two rounds, even if prose changes.
- Execute at most two transient transport/429/timeout retries in the same round with injected exponential backoff.
- Persist start time, accumulated cost, round/maxRounds, fingerprints, failing AC sets, retry counters, and completed-node/checkpoint state.
- Restore the full state on resume and run unresolved nodes only.

### Tests

- Same failing AC set twice stops; a changed set continues.
- First two transient failures retry with increasing delays and unchanged round; the third stops deterministically.
- Kill after a checkpoint, resume, and prove all stop/retry/cost/time fields survive and completed nodes do not rerun.
- A non-default `maxRounds` value survives resume.

### Verification

```bash
node --test --experimental-strip-types test/stop.test.ts test/resume.test.ts test/graph-engine.test.ts
```

### DoD

- [ ] Failing-AC and fingerprint no-progress rules both work
- [ ] Retry is bounded, same-round, and backoff-driven
- [ ] Resume restores every stop-safety field

---

## RP-05 — Correct graph routing, release, and idempotent ship

**Depends on:** RP-02, RP-04  
**Owns gaps:** GRAPH-07, GRAPH-08  
**Stories:** US-02–US-05, US-08, US-13, US-14

### Read first

- `graphs/coding-loop.gated.json`, `graphs/coding-loop.auto.json`, `graphs/spec-first.json`
- `extensions/gated-loop.ts`, `extensions/graph/engine.ts`
- `test/gated-loop.test.ts`, `test/autopilot.test.ts`, `test/resume.test.ts`

### Change

- Encode conditional routing in graph data: test red→implement; bounds false→`UNSAFE`; review red testable→implement; review red untestable→`NEEDS_HUMAN`; gated review pass→human; human deny→configured retry/end; autopilot review pass→guarded release.
- Remove set nodes that manufacture green test/bounds state.
- Set `release.approved` and `DONE` only from fresh evidence, approved review, and held bounds.
- Add a durable job marker for ship. Replay after a crash must no-op; one job creates at most one commit.

### Tests

- Table-driven graph-edge fixtures cover every conditional branch.
- Existing gated, auto, narrative, and bounds fixtures traverse the actual graph files.
- Ship twice for one job: exactly one marker and one commit decision.
- Autopilot never enters a human node and cannot release from model prose alone.

### Verification

```bash
node --test --experimental-strip-types test/gated-loop.test.ts test/autopilot.test.ts test/resume.test.ts test/graph-engine.test.ts
```

### DoD

- [ ] Shipped graphs match the normative conditional contract
- [ ] Release is evidence-derived
- [ ] Ship replay is a durable no-op

---

## RP-06 — Wire account usage, selection, failover, and stickiness

**Depends on:** RP-01  
**Owns gaps:** ACCT-01, ACCT-02  
**Stories:** US-10; M-05

### Read first

- `spec.md` §13 selection order
- `extensions/accounts/store.ts`, `balancer.ts`, `widget.ts`, `usage/*`
- `fixtures/accounts-failover/accounts.json`
- `test/accounts.test.ts`, account scenarios in `test/milestone.test.ts`

### Change

- Replace incompatible usage-reader types with one cached snapshot contract.
- Refresh usage outside the request-header hot path; quota-first consumes cached remaining percentages and fails open to round-robin when unknown.
- Populate the cache from documented provider rate-limit/usage headers and injected supported readers; do not poll undocumented subscription endpoints. Providers without a reliable signal remain unknown.
- Feed real cached percentages and active route into the accounts widget.
- Preserve exact model and thinking level on same-family sibling failover.
- Cross family only after every sibling in the family is cooling.
- Persist or session-bind stickiness so a pinned slot holds until it cools, logs out, or the operator advances it.

### Tests

- Distinct cached percentages cause quota-first to select the highest healthy sibling.
- The normative accounts-failover fixture proves a cooling sibling is never selected in 100 attempts.
- Same-family failover preserves model and thinking level.
- Cross-family fallback begins only after total family cooldown and follows the default chain.
- Unknown usage falls back without blocking a request.

### Verification

```bash
node --test --experimental-strip-types test/accounts.test.ts test/accounts-routing.test.ts
```

### DoD

- [ ] Quota-first and percentages use one live cache contract
- [ ] M-05 passes through the integrated selection path
- [ ] Stickiness releases only on the named transitions

---

## RP-07 — Complete account commands and provider contracts

**Depends on:** RP-06  
**Owns gaps:** ACCT-03, ACCT-04, ACCT-05  
**Stories:** US-10–US-12, US-26

### Read first

- `spec.md` account command table and provider requirements
- `extensions/accounts/index.ts`, `store.ts`, `errors.ts`
- `extensions/cursor/provider.ts`, `oauth.ts`
- Installed Pi provider and response-hook contracts cited in the research

### Change

- Implement `/accounts next`, `/accounts pin <pool/slot>`, `/pool strategy`, and `/pool chain` with schema-validated persistence.
- Import the official `auth.json` primary credential as slot `default` without copying secrets into the repo.
- Show the one-time z.ai personal-use note and one-time Codex/Cursor billing confirmations for new slots.
- Keep official catalogs live: no official id receives an extension `models` array. Preserve Cursor's bounded bootstrap list, live refresh, stored last-known catalog, and Pi-compatible login callbacks.
- Make global failure classification status/header-only. Retain body-token classification only in owned custom fetch paths that safely consume bodies.

### Tests

- Commands persist and survive reload; invalid pool, strategy, chain, or slot fails without partial write.
- Pin holds until exhaustion; next advances; logout of the pinned slot releases it.
- Temporary `auth.json` imports one default slot without exposing its secret.
- Notes appear once per new slot and never after acceptance.
- Static/runtime provider inspection proves no official catalog replacement.

### Verification

```bash
node --test --experimental-strip-types test/accounts.test.ts test/accounts-commands.test.ts test/provider-contracts.test.ts
```

### DoD

- [ ] Account and pool command surface matches `spec.md`
- [ ] Official catalogs remain Pi-owned
- [ ] Provider notices and classifier boundary are correct

---

## RP-08 — Add live local model pools

**Depends on:** RP-07  
**Owns gaps:** LOCAL-01, LOCAL-02, LOCAL-03  
**Stories:** US-27; AC-27.1–AC-27.8

### Read first

- `PRD.md` US-27, `spec.md` local-pool contract
- Installed Pi llama.cpp provider sources cited in the research
- Official Ollama, LM Studio, and OpenAI-compatible discovery sources
- `extensions/accounts/store.ts`, `extensions/index.ts`

### Change

- Map k-pi pool `llama` to Pi provider `llama.cpp`, including login/status/cost attribution. Do not register it.
- Add first-party providers `ollama`, `lmstudio`, and `local-openai` with bounded `refreshModels` and stored last-known catalogs.
- Use `/v1/models`; for Ollama, fall back to `/api/tags` as required by AC-27.2.
- Preserve exact server model ids. Tolerate extra fields and empty arrays; reject malformed identity entries.
- Defaults: Ollama `http://127.0.0.1:11434/v1`; LM Studio `http://127.0.0.1:1234/v1`; prompt for local-openai URL. Optional bearer only where configured; do not send a dummy Ollama credential.
- Cool unreachable local slots. Remain in configured local families unless the operator explicitly includes a cloud pool in `/pool chain`.
- Every request stays on the configured origin and costs zero. Represent the local account/slot exactly as recorded by NH-01 while preserving AC-27.6 footer semantics.

### Tests

- Loopback stub servers assert request path, origin, headers, timeout/abort, exact ids, empty catalog, malformed schema, and stored offline restore.
- Ollama fallback runs only after the OpenAI-compatible list is unavailable.
- Fetch spy fails on any unconfigured/cloud origin.
- Unreachable local server cools the slot and selects only an allowed local successor.
- No forbidden local provider dependency or frozen model id appears.

### Verification

```bash
node --test --experimental-strip-types test/local-providers.test.ts test/provider-contracts.test.ts test/accounts-routing.test.ts
```

### DoD

- [ ] AC-27.1–AC-27.8 have executable coverage
- [ ] Native llama.cpp remains Pi-owned
- [ ] Local discovery is live, bounded, stored, and no-cloud

---

## RP-09 — Build the research credential, mode, event, and budget control plane

**Depends on:** RP-01, RP-07  
**Owns gaps:** RESEARCH-01, RESEARCH-02  
**Stories:** US-28, US-29

### Read first

- `research.md`, `PRD.md` US-28/US-29
- `extensions/research/index.ts`, `setup.ts`, `gate.ts`
- `extensions/accounts/store.ts`, `extensions/settings.ts`

### Change

- Create one research configuration/session owner for key resolution, mode, call count, cooldown, source collection, and event emission.
- Saved `accounts.secrets.json` keys win over environment fallbacks.
- Implement `/accounts login|logout exa|perplexity` as research targets, not `PoolId`s.
- Implement `kpi.research = auto | exa | perplexity | local` and the network-state mechanism selected in NH-02.
- Emit redacted `research.started`, query/call/result/fallback, and `research.completed` events.
- Enforce 20 external calls per job, 10 results per request, 10 Exa Contents URLs, and deterministic cooldown/fallback state.
- Require two distinct external sources when a configured online mode succeeds. Implement the recorded NH-02 decision for bounded 402/429/timeout exhaustion. A healthy online service that still cannot supply two sources ends `NEEDS_HUMAN`. Never fabricate a citation.

### Tests

- Temporary HOME proves saved-key precedence, env fallback, 0600 writes, login/logout, and mode persistence.
- The 21st external call is refused before fetch.
- 429/timeout cools the service, tries the alternate configured service once, then follows the recorded NH-02 decision without inventing sources or hanging.
- An authorized no-network path uses repo sources, emits events, lights the research state, and makes zero network calls.
- Secret canaries do not appear in events or diagnostics.

### Verification

```bash
node --test --experimental-strip-types test/research-control-plane.test.ts test/accounts-commands.test.ts
```

### DoD

- [ ] Research keys, modes, budgets, events, and fallback have one owner
- [ ] US-28 setup variants and US-29 no-network/local paths are deterministic

---

## RP-10 — Correct Exa/Perplexity clients and research artifacts

**Depends on:** RP-09  
**Owns gaps:** RESEARCH-03, RESEARCH-04, RESEARCH-05  
**Stories:** US-28, US-29

### Read first

- Exa and Perplexity sources in `remediation-research.md`
- `extensions/research/exa.ts`, `perplexity.ts`, `index.ts`, `gate.ts`
- Research artifact schemas in `spec.md`

### Change

- Exa Search: nested bounded highlights. Exa Contents: top-level content options, at most 10 URLs, and per-URL status inspection on HTTP 200.
- Cap Exa provider requests and every local/model/event/artifact field at 10,000 characters or the narrower field cap.
- Perplexity: use `max_tokens` and/or `max_tokens_per_page` for hard bounds; omit qualitative `search_context_size` in that mode.
- Normalize usable title, absolute HTTP(S) URL, dates without conflating semantics, and bounded snippet/highlight text.
- Canonicalize and deduplicate URLs. Retry a bounded alternate query only when needed to seek the two-source contract.
- Never serialize raw provider responses, headers, authorization values, or unrequested full text.
- Classify 402 defensively and 429/abort/timeout by status/transport, independent of envelope shape.

### Tests

- Injected fetch inspects exact request bodies and abort signals.
- Oversized upstream data contains tail canaries that are absent from tool output, events, `research.md`, and `research.json`.
- Exa Contents partial failures yield only successful citations plus bounded diagnostics.
- Duplicate and short source sets exercise deduplication, one bounded follow-up, and explicit shortfall.
- Perplexity test asserts token caps and absence of `search_context_size`.

### Verification

```bash
node --test --experimental-strip-types test/research-clients.test.ts test/research-control-plane.test.ts
```

### DoD

- [ ] Provider requests match current official REST contracts
- [ ] Research artifacts are normalized, bounded, cited, and secret-safe
- [ ] Two-source completion never fabricates evidence

---

## RP-11 — Enforce the mandatory Dune stack and current slice

**Depends on:** RP-05, RP-10  
**Owns gaps:** DUNE-01, DUNE-02, DUNE-03  
**Stories:** US-30; AC-30.1–AC-30.11

### Read first

- `dune-architecture.md`, `PRD.md` US-30
- `extensions/stack.ts`, stack integration in `extensions/gated-loop.ts`
- Dune scenarios in `test/milestone.test.ts`

### Change

- Require a valid, fresh `stack.json` before implement; missing/stale is `UNSAFE`.
- Freeze an explicit `current_module_id`/current slice in the job contract. Never infer `modules[0]`.
- Match `allowed_paths` by normalized path segments/globs, including the module's declared test twin. Close prefix escapes such as `src/auth-admin` for `src/auth`.
- Enforce folder=id, auth home, nested-only layers, tight-purpose generic folders, two-consumer shared extraction, vertical delivery default, horizontal reason, no API-then-UI vertical staging, second-slice extraction, and named no-stack exemptions.
- Enforce scaffold order: folder, public interface, test twin, then behavior.
- Reuse the same path predicate from implement bounds and bus `claim_path`.

### Tests

- Fixtures cover missing/stale stack, second selected module, prefix escape, auth under lib, top-level layer/generic folders, one-consumer shared, invalid horizontal delivery, no-stack exemption, second-slice extraction, and scaffold order.
- Valid stack reaches implement; every invalid fixture reaches `UNSAFE` before a write.

### Verification

```bash
node --test --experimental-strip-types test/stack.test.ts test/gated-loop.test.ts
```

### DoD

- [ ] AC-30.1–AC-30.11 have named behavior tests
- [ ] Graph and worker claims share one exact current-module boundary

---

## RP-12 — Complete the knowledge graph lifecycle and kg-claim

**Depends on:** RP-01  
**Owns gaps:** KG-01, KG-02, KG-03  
**Stories:** US-09; AC-09.1–AC-09.4

### Read first

- `spec.md` §14
- `extensions/kg/store.ts`, `extensions/kg/index.ts`
- Existing KG scenarios in `test/milestone.test.ts`
- Installed Pi skill frontmatter contract

### Change

- Make the control plane the only authoritative writer for nodes, edges, sources, inbox acceptance, and snapshots.
- Snapshot the complete prior authoritative state before acceptance; write a completion marker before promoting the new revision.
- Validate minimum fields, status enum, source references, and monotonic revisions.
- Workers/public tools may write proposal files only; deny direct authoritative JSONL paths.
- Serialize concurrent in-process proposal and acceptance writes.
- Create `skills/kg-claim/SKILL.md` with valid Pi frontmatter and an inbox-only claim contract.

### Tests

- Node, edge, and source round-trips validate and bump revisions.
- Injected crash after snapshot leaves the prior state readable.
- Twenty concurrent proposals remain twenty parseable, non-interleaved records.
- Direct authoritative write through the public tool fails.
- Pi resource discovery finds `kg-claim` with no diagnostic.

### Verification

```bash
node --test --experimental-strip-types test/kg.test.ts test/package.test.ts
```

### DoD

- [ ] KG authoritative lifecycle is complete and crash-safe
- [ ] One-writer boundary is executable
- [ ] `kg-claim` is loadable without custom resource code

---

## RP-13 — Implement the Pi RPC worker bus

**Depends on:** RP-01, RP-11  
**Owns gaps:** BUS-01, BUS-02, BUS-03, BUS-04  
**Stories:** US-23; AC-23.1–AC-23.8

### Read first

- `agents-bus.md`
- Installed Pi RPC/CLI sources cited in `remediation-research.md`
- `extensions/bus/spawn.ts`, `extensions/bus/communicate.ts`
- Existing bus scenarios in `test/milestone.test.ts`

### Change

- Use strict LF-only JSONL with ids and response correlation. Initial delivery is `prompt`; live delivery is `steer` or `follow_up`/`streamingBehavior`.
- Treat prompt response as acceptance and `agent_settled` as completion. Capture last assistant text only as diagnostics; contract files are authoritative.
- Clear queues before abort.
- Launch the absolute Pi CLI with `--mode rpc`, session file `.pi/runs/<job>/agents/<role>-<id>.jsonl`, the matching session directory, role-specific `--tools`, piped stdout/stderr, and bounded lifecycle cleanup.
- Start workers only from tool/command/session use, never the extension factory; stop them idempotently on `session_shutdown`.
- Implement `communicate.expect = none | ack | result`, contract-file wait/timeout, `agents_status`, and `agents_stop`.
- Implement the verdict-publication mechanism recorded in NH-03. It must schema-validate the role's declared run-contract file and must not grant general product-file mutation access.
- Append `agent.spawned` and `agent.message` to both `events.jsonl` and `bus.jsonl`.
- Release path leases when the recorded PID is dead; propagate Dune claim errors. Keep worker cap two and writer cap one within the process only.

### Tests

- Scripted RPC peer asserts exact argv, records, LF framing, ids, acceptance-before-settlement, stderr capture, queue-clear-before-abort, and graceful shutdown.
- Role tool allowlists are enforced; reviewer/tester cannot mutate.
- Expect modes, file wait timeout, status, stop, dual logs, dead/live PID leases, worker/writer caps, and outside-module claim errors each have named tests.

### Verification

```bash
node --test --experimental-strip-types test/bus.test.ts test/append-log.test.ts test/stack.test.ts
```

### DoD

- [ ] Worker protocol matches Pi `0.84.4`
- [ ] Tool isolation, completion, cancellation, leases, and logs are enforced
- [ ] Q-04 remains in-process only

---

## RP-14 — Migrate isolated review to the worker bus

**Depends on:** RP-05, RP-13  
**Owns gaps:** BUS-05  
**Stories:** US-08, US-23; original WP-21 reviewer contract

### Read first

- Historical `implementation-plan.md` WP-21
- `skills/isolated-review/SKILL.md`
- Review node and reviewer-session code in `extensions/gated-loop.ts`
- `schemas/verdict.schema.json`

### Change

- Replace the graph reviewer's in-process isolated session with a spawned RP-13 reviewer worker.
- Give the reviewer read-only product tools plus only the verdict-publication mechanism recorded in NH-03, and use an isolated session file.
- Require a valid `verdict.json`; never parse transcript prose as the verdict.
- Missing, malformed, stale, or unauthorized verdict is reviewer failure, not approval.
- Preserve graph review routing from RP-05 and record worker lineage in the run store.

### Tests

- Fake worker accepts the prompt before settlement; parent waits for `agent_settled` and a valid verdict file.
- Reviewer argv has no write/edit tool.
- Transcript saying PASS without a verdict fails.
- Implementer and reviewer session ids differ.
- Gated and autopilot fixtures consume the spawned verdict through the real review node.

### Verification

```bash
node --test --experimental-strip-types test/reviewer-session.test.ts test/gated-loop.test.ts test/autopilot.test.ts
```

### DoD

- [ ] Reviewer is a background Pi session with read-only isolation
- [ ] Verdict file, not prose, controls release routing

---

## RP-15 — Enforce the minimalist ladder and one-concat fixture

**Depends on:** RP-05, RP-11  
**Owns gaps:** MIN-01  
**Stories:** US-22; `minimalist.md`

### Read first

- `minimalist.md`
- `extensions/minimalist.ts`, `skills/minimalist/SKILL.md`
- Existing minimalist scenarios in `test/milestone.test.ts`

### Change

- Validate `candidate.json.ladder` as a known rung plus non-empty `used` and `skipped` decisions.
- Reject a claimed rung that the observed diff violates.
- Preserve the dependency-baseline gate; undeclared runtime dependencies cannot ship.
- Create `fixtures/minimalist-one-concat/` and a focused `test/minimalist.test.ts`.

### Tests

- Unknown/missing rung, missing used/skipped, and undeclared dependency fail independently.
- One-concat task passes with a direct one-line change and zero new files.
- New helper, class, abstraction, file, or dependency fails the fixture.

### Verification

```bash
node --test --experimental-strip-types test/minimalist.test.ts
```

### DoD

- [ ] Ladder data is semantically enforced, not presence-checked
- [ ] One-concat fixture prevents needless structure

---

## RP-16 — Generate one clean, loadable K-stack runtime

**Depends on:** RP-08, RP-10, RP-13, RP-15  
**Owns gaps:** KSTACK-01, KSTACK-02  
**Stories:** US-17–US-21, US-23

### Read first

- `kstack.md`, `model-ladder.md`, `agents-bus.md`
- `kstack/overlay/*`, `kstack/mode.ts`, `kstack/models.ts`
- `kstack/playbooks/*`, `kstack/principles.md`, `kstack/k-agent.md`
- Upstream findings in `remediation-research.md`

### Change

- Make overlay-owned source plus vendored upstream produce the single Pi-loadable runtime under `kstack/generated/skills`.
- Migrate first-party principles, playbooks, and agent guidance into generated loadable skill content; remove competing hand-written runtime truths and the hard-coded `STEPS` table after cutover.
- Parse/validate YAML frontmatter. Normalize skill identifiers to valid lowercase-hyphen names and unique parent-aligned identities.
- Translate only understood orchestration contracts to `spawn_background`/`communicate`; fail closed on unknown Cursor operators.
- Replace hard-coded model slugs and `.cursor/rules/*.mdc` consumers with the k-pi-owned `~/.pi/agent/kstack/models.json` contract.
- Make `/setup-kstack` consume `model-ladder.md`, filter to live healthy pool models, show chosen/next-best/confidence per role, allow per-line edits, and preserve ordered cross-family review panels.
- Exclude `make-bot-ui`, Benny, Bugbot, worktree cleanup, `/loop` sleeper, cloud-agent, Graphite, and every documented drop path.
- Use token/path-aware branding; never corrupt containing words such as `upstack`.
- Arena/swarm use live configured k-pi pools, at most two workers, one writer, and no cloud/worktree semantics.
- Freeze the matched playbook in `task.json.playbook`, render every playbook step, and preserve skipped steps as `skip: <reason>`.
- Retain the complete upstream MIT license.

### Tests

- Offline residue fixture includes every known invalid name/operator/path/slug/brand/drop-path and either transforms it correctly or fails with a located diagnostic.
- Every shipped skill has valid, unique Pi frontmatter and all support files remain reachable.
- Required feature, bug-fix, investigation, shipping, autonomous-run, arena, and swarm playbooks are each discoverable exactly once.
- No forbidden residue exists in loaded roots; ordinary words containing `pstack` substrings remain intact.
- `/setup-kstack` follows the ladder/healthy-pool contract, accepts only live registry slugs, supports per-line edits, and writes atomic validated JSON. K-mode freezes the selected playbook and skip reasons.

### Verification

```bash
node --test --experimental-strip-types test/kstack-runtime.test.ts test/package.test.ts test/bus.test.ts
```

### DoD

- [ ] One generated/loadable K-stack runtime source
- [ ] No invalid skill diagnostics or forbidden Cursor/cloud/Graphite residue
- [ ] K-stack orchestration uses the first-party bus and live model map

---

## RP-17 — Make K-stack sync deterministic and provenance-aware

**Depends on:** RP-16  
**Owns gaps:** KSTACK-03  
**Stories:** US-21; AC-21.1–AC-21.6

### Read first

- `kstack.md` sync contract
- `kstack/scripts/sync-kstack.ts`, `kstack/UPSTREAM.md`
- `kstack/overlay/transforms.ts`, `forbidden.txt`, patches
- Official Git sources in `remediation-research.md`

### Change

- Track origin, full commit, expected pstack tree, transform version, ordered patch digests, and license provenance.
- Acquire/copy only the pinned `pstack/` subtree into a new empty staging tree.
- Apply structured transforms, then ordered path-confined patches with `git apply --check`; never use partial `--reject` application.
- Validate semantic invariants before promotion, then atomically swap the generated tree.
- `--check` proves both byte synchronization and semantic validity.
- Distinguish repository HEAD drift from relevant pstack-tree drift; never silently advance the pin.
- Add offline upstream, broken-patch, stale-file, hand-edit drift, unchanged-tree HEAD, and changed-tree fixtures.

### Tests

- Same pin twice is a byte no-op and does not rewrite generated output.
- Broken patch leaves live generated bytes unchanged and creates no `.rej`.
- Upstream deletion removes stale generated files.
- Hand edit makes `--check` fail.
- Unrelated HEAD drift reports informational state; changed pstack tree reports update available without changing the pin.
- Missing/changed license, invalid frontmatter, forbidden residue, unsafe patch path, or malformed models JSON fails before promotion.

### Verification

```bash
node --test --experimental-strip-types test/kstack-sync.test.ts test/kstack-runtime.test.ts
pnpm kstack:sync:check
```

### DoD

- [ ] Sync is deterministic, semantic, patch-safe, and license-preserving
- [ ] Drift reporting is pstack-tree aware
- [ ] `kstack:sync:check` can no longer pass invalid generated skills

---

## RP-18 — Render the complete board, footer, lamps, and concise output

**Depends on:** RP-05, RP-07, RP-10, RP-12, RP-13, RP-16  
**Owns gaps:** UI-01, UI-02, UI-03, UI-04, UI-05  
**Stories:** US-06, US-07, US-15, US-16, US-25, AC-28.6; M-06

### Read first

- `visual-targets.md` and all four footer/board JPEGs
- `extensions/control-plane.ts`, `extensions/status-line/*`, `extensions/accounts/widget.ts`, `extensions/renderers.ts`
- `test/control-plane.test.ts`, `test/status-line.test.ts`, `test/runtime-milestone.test.ts`

### Change

- Footer: active account/slot representation from NH-01; `(sub)` for subscription; `(local) $0` for local; `kpi_job`; route/usage; `/statusbar preset default|compact|full`; documented brand variants and segment order.
- Amber board: context lamps, exactly one current stage, PASS/FAIL, human oversight, six non-empty-file lamps, and always-visible STOP/current stage under narrow wrapping.
- Protocol-blue pause board: derive the `APPROVAL` lamp from a paused human node while retaining SHARED RUN STATE, STOP STATES, THREE LAWS, WAITING ON OPERATOR, and the pending question. Never write `APPROVAL` into a persisted stop-state field.
- Show EXA/PPLX, BUS lamp, `AGENTS n`, K-stack playbook/progress, route, and usage from the state owners created earlier. UI code reads state; it never starts a model.
- Add field-aware concise renderers for research, accounts, bus, checkpoints, and verdict events.
- Add a real assistant-output fixture whose visible protocol reply stays below 800 characters.

### Tests

- State fixtures assert every required field/lamp and exactly one lit current stage; empty files keep lamps dark.
- Paused fixture asserts the derived `APPROVAL` lamp, the paused/interrupted human-node state, and the absence of `APPROVAL` from persisted stop-state fields.
- End-to-end footer assembly, not `formatCost` alone, covers subscription, local, api-key, presets, job line, route, and usage under the NH-01 representation.
- Fake model client fails if board/status rendering calls it.
- Narrow width retains current stage and STOP.
- Visible output from a structured verdict fixture is under 800 characters.

### Verification

```bash
node --test --experimental-strip-types test/control-plane.test.ts test/status-line.test.ts test/operator-ui.test.ts test/concise-output.test.ts
```

### DoD

- [ ] US-15, US-16, and US-25 are information-complete
- [ ] All upstream state owners feed honest lamps/labels
- [ ] M-06 measures a real assistant response

---

## RP-19 — Prove traceability and the installed whole product

**Depends on:** RP-02–RP-18  
**Owns gaps:** PKG-01, REL-01, REL-02  
**Stories:** US-01–US-30; M-01–M-07

### Read first

- `PRD.md`, `spec.md`, focused product docs
- `remediation-research.md` gap register
- Every RP DoD and verification command
- `package.json`, `.github/workflows/ci.yml`, `README.md`

### Change

- Create `test/traceability.test.ts` and a machine-readable requirement→test map. Every PRD AC, required spec ID, metric, gap ID, and RP has at least one named observable check and one primary owner.
- Create `scripts/verify-installed-package.mjs` and `scripts/verify-product.mjs`.
- Make CI run the repository gates, K-stack semantic sync check, package payload check, and installed-product smoke on Pi `0.84.4`.
- Update README workflows and operator commands to match the verified product. Do not change feature behavior here; return any failure to its owning RP.

### Tests and installed proof

1. Run tests, lint, typecheck, and K-stack semantic sync check.
2. Pack the exact artifact, compare its path inventory to the allowlist, and inspect it for secrets/forbidden dependencies.
3. Install that artifact into a temporary HOME and scratch Git repository with Pi `0.84.4`.
4. Start Pi RPC with an explicit offline test model/provider. Assert zero package/resource/skill diagnostics and discover all manifest commands, prompts, themes, ordinary skills, K-stack skills, and `kg-claim`.
5. Exercise installed deterministic fixtures for gated, autopilot, policy, accounts, local discovery, research, Dune, KG, bus/reviewer, and UI.
6. Write a secret-free machine-readable M-01–M-07 proof report.

### Verification

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm kstack:sync:check
node scripts/verify-installed-package.mjs --pi-version 0.84.4
node scripts/verify-product.mjs --pi-version 0.84.4 --json .pi/remediation-proof.json
```

### Required observations

- M-01: gated fixture reaches human confirmation with green receipts.
- M-02: autopilot fixture reaches `DONE`, no human node, exactly one job-marked commit.
- M-03: narrative AC refuses autopilot and writes `ac.refused`.
- M-04: bounds violation reaches `UNSAFE` and creates no commit.
- M-05: exhausted sibling is never selected while a healthy sibling exists.
- M-06: actual visible assistant reply is below 800 characters.
- M-07: all repository and installed-artifact gates pass.

### DoD

- [ ] Every AC, required contract, metric, gap, and RP has executable traceability
- [ ] Packed and scratch-installed Pi artifact loads with zero diagnostics
- [ ] M-01–M-07 proof report is green and secret-free
- [ ] No historical checkbox was used as evidence

---

## Suggested execution batches

Sequential execution is the default. If separate worktrees and one-writer ownership are available, only these logical groups can overlap:

- After RP-01: RP-02, RP-03, RP-06, and RP-12.
- After RP-07 and RP-05: RP-08 and RP-09.
- After RP-11: RP-13 and RP-15.

Serialize any packages that touch `extensions/index.ts`, `extensions/gated-loop.ts`, `extensions/accounts/index.ts`, `package.json`, or generated K-stack output. Merge and run the owning scoped checks before the next dependent package.

## Definition of done for the whole product

All of:

1. RP-00–RP-19 DoD boxes checked from their scoped evidence.
2. `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm kstack:sync:check` exit 0.
3. The packed artifact matches the allowlist and contains no secret or forbidden runtime dependency.
4. Scratch Pi `0.84.4` install/startup reports zero resource diagnostics.
5. Installed fixtures cover gated, autopilot, policy, accounts, local providers, research, Dune, KG, bus/reviewer, K-stack, footer, and both boards.
6. M-01–M-07 are true in `.pi/remediation-proof.json`.
7. Docs match the installed behavior; historical plan/roadmap remain clearly non-authoritative.
