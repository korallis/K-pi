# remediation-plan.md — K-π

> **STATUS: ACTIVE.** This is the only implementation queue. `roadmap.md` and `implementation-plan.md` are historical build records, not completion evidence.

**How agents use this file.** Pick the lowest incomplete package whose dependencies are complete. Implement only that package. Run its scoped verification. Check its DoD only after the observable result passes. Do not use historical `[x]` boxes as proof.

**Ordering.** IDs sort as written: `RP-00`, `RP-01`, `RP-01A`, `RP-02`, … `RP-19`. RP-00 through RP-19 are complete. **No incomplete remediation package remains** — next is feature acceptance in [`uat.md`](uat.md) (not an RP). This plan still names the whole-product DoD and UAT hand-off as the remaining authority.

IDs: `RP-##`. Stories and ACs: `PRD.md`. Normative contracts: `spec.md`, `../UPSTREAM.md`, and focused product docs. Research and gap IDs: [`remediation-research.md`](remediation-research.md).

## Execution rules

1. Read the package's listed sources before editing. Reuse the existing module and test patterns.
2. **One writer owns a file.** This is the only real constraint on concurrency. Dependency-ready packages run in parallel; two packages that name the same source file do not.
3. Work in dependency waves, not single file. Any set of packages whose dependencies are all complete may run at once, subject to rule 2 and the shared-file list in `Execution waves` below. Sequential execution is a fallback for a single operator, not the contract.
4. A package owns only its listed gap IDs. If another gap appears, add it to the research register and assign one owner before editing.
5. Run only the package's scoped `Verification` block while packages are in flight — a full suite mid-wave reports siblings' half-landed edits. `npm run check && npm test && npm run test:kpi` runs once before a pull request. RP-19 runs the whole product proof.
6. Use injected clocks, fetches, process launchers, RPC peers, and temporary HOME/repository roots. No cloud keys, model downloads, real sleeps, or production services in tests.
7. Tests must exercise observable behavior. A source-text assertion is insufficient unless the source text itself is the contract, such as forbidden dependency or packaged-resource inventory.
8. Update the owning product docs in the same package as behavior. Do not defer contract drift to RP-19.
9. Do not push, deploy, publish, or add a runtime dependency as part of a package, and never mark a package done by opening a pull request. No package publishes anything: the only publish path is the tag-driven release workflow governed by NH-04. Delivery and CI configuration are governed separately from this queue.

## Constraints not requiring a product decision

- Pi `0.84.4` (commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`) is the forked base, tracked via the `upstream` remote per `../UPSTREAM.md`. K-π is that harness, not a package inside it. Use the base's resource loader, official catalogs, native llama.cpp provider, sessions, and RPC rather than rebuilding them.
- No custom prompt/skill/theme loader.
- No Cursor authorization-code requirement. Paste/manual/device login satisfies the harness OAuth surface.
- No cross-process worker cap in v1.
- `APPROVAL` is a derived protocol-blue board lamp while a human node is paused, never a serialized stop state. Persisted stop states remain `DONE | BLOCKED | EXHAUSTED | NO_PROGRESS | UNSAFE | NEEDS_HUMAN`.
- Exa and Perplexity are research credential targets, not model pools.
- Exa content is capped at 10,000 characters before model handoff or persistence.
- Global `after_provider_response` classification uses status and headers. Body classification is limited to custom fetch clients that own the body.
- The current Dune module is explicit; `modules[0]` is never an implicit current module.
- Generated, harness-loadable K-stack output is the only runtime truth. `make-bot-ui` and the documented drop list are excluded.
- Relevant K-stack upstream drift is a changed pstack tree, not an unrelated repository HEAD change.

## `NEEDS_HUMAN` gates

All four gates are `CLOSED` by recorded human decision. The `Selected decision` cell is the authoritative product behavior, and the `Aligned normative files` cell names where that behavior is written. The `Blocks` column is dependency history: those packages were blocked until the gate closed and are released by the recorded decision. Document precedence never selects an option. A newly discovered contract conflict opens a new `OPEN` gate, blocks its dependent packages, and closes only the same way: an explicit human decision recorded here with the deciding human, date, selected option, and aligned normative files.

| ID | Status | Decided by | Decided on | Decision required | Selected decision | Aligned normative files | Blocks |
|---|---|---|---|---|---|---|---|
| NH-01 | CLOSED | korallis | 2026-09-01 | Reconcile AC-27.6 local footer semantics with `spec.md`'s `oauth \| api_key` slot-kind enum. | Add credential-free `Slot.kind = local`. A local slot persists its configured base URL, may reference an optional credential without storing a dummy secret, renders exactly one cost cell as `(local) $0`, shows no quota percentage, and stays outside the default cloud chain. | `docs/spec.md` (§13 `Slot.kind` plus REQ-SL-01/REQ-SL-02; §11 REQ-SB-08 cost cell and accounts widget), `docs/PRD.md` (AC-06.4, AC-15.10, AC-27.3, AC-27.5, AC-27.6), `docs/visual-targets.md` (§1 `cost`/`usage` segments; §3 acceptance checks) | RP-01, RP-08, RP-18 |
| NH-02 | CLOSED | korallis | 2026-09-01 | Reconcile local completion after provider exhaustion with AC-29.2's two-external-source rule unless `no-network` is set. | A successful online Exa or Perplexity run must cite at least two distinct external sources. After bounded, recorded failures of every configured service, the engine sets effective `no-network` and the planning model researches repository and frozen local sources with normal read and search tools, citing local files only; no external URL is ever fabricated. A healthy online service that still supplies fewer than two distinct sources ends `NEEDS_HUMAN`. | `docs/research.md` (planning default, effective no-network, local research), `docs/PRD.md` (AC-28.5, AC-29.2, AC-29.3, AC-29.6, AC-29.7), `docs/spec.md` (§5 `SCH-research` and REQ-RS-07; §6 `NEEDS_HUMAN` stop-state row), `docs/visual-targets.md` (§2 Board A research state; §3 acceptance checks) | RP-01, RP-09, RP-10, RP-18 |
| NH-03 | CLOSED | korallis | 2026-09-01 | Reconcile reviewer/tester write denial with the requirement that the reviewer publish `verdict.json`. | Reviewer and tester keep no general `write` or `edit` tool. A dedicated `write_contract` capability is pinned to the spawned agent, job, role, and declared contract path, schema-validates the verdict or evidence payload, then performs an atomic write. Every other path is denied. | `docs/agents-bus.md` (`write_contract`, same-tree rule, forbidden list), `docs/spec.md` (§5 run-store writer column and REQ-RS-06; §7 node tool policy; §12 policy deny; NFR-04), `docs/PRD.md` (AC-02.4, AC-04.3, AC-08.4, AC-23.9) | RP-01, RP-13, RP-14, RP-18 |
| NH-04 | CLOSED | korallis | 2026-09-02 | Reconcile REQ-DIST-05 and PRD Q-01 (`source build only; never published`) with the owner's instruction to distribute K-π through npm and rebuild CI/CD. | K-π publishes exactly one npm package, `@korallis/k-pi`, built from the CLI bundle (`dist/bundle` plus the runtime resource directories) by `scripts/pack-kpi.mjs`. Workspace packages keep their upstream names and are never published. Releases are tag-driven: the tag `v<version>` must equal `packages/coding-agent/package.json#version`, and `.github/workflows/release.yml` publishes from a GitHub-hosted runner through npm trusted publishing (OIDC, provenance, no long-lived token); the first publish of the package is manual. CI is `check` (required, self-hosted macOS hard gate), `ai-review` (advisory z.ai review, never required), `auto-merge`, `queue-stall-alarm`, and `upstream-drift`; the fail-closed Grok review and React Doctor workflows are deleted. | `docs/spec.md` (§2 distribution contract and REQ-DIST-05), `docs/PRD.md` (§10 Q-01), `../AGENTS.md` (Stack, Gates, Do not), `../UPSTREAM.md` (§4 root manifest row, §5 exclusions, §6 workflow register), `../README.md` (Install, Non-goals), `remediation-research.md` (NH-04), `../test/harness.test.ts` (root `pack` script, no publish scripts) | — |

## Dependency map

```text
RP-00
  └─ RP-01
      └─ RP-01A  ← completed architecture reset; gates everything below
          ├─ RP-02 ──┐
          ├─ RP-03 → RP-04 ───────┼→ RP-05
          ├─ RP-06 → RP-07 → RP-08
          │             └→ RP-09 → RP-10 → RP-11
          └─ RP-12

RP-05 + RP-10 → RP-11
RP-01A + RP-11 → RP-13
RP-05 + RP-13 → RP-14
RP-05 + RP-11 → RP-15
RP-08 + RP-10 + RP-13 + RP-15 → RP-16 → RP-17
RP-05 + RP-07 + RP-10 + RP-12 + RP-13 + RP-16 → RP-18
RP-01A + RP-02…RP-18 → RP-19  ← complete; UAT next
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
- NH-01 through NH-03 are closed by the recorded decisions of `korallis` on `2026-09-01`. Write each recorded decision into the gate table above and into that gate's aligned normative documents. Never resolve a gate by document precedence; a newly discovered conflict opens a new `OPEN` gate instead.
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

- [x] One active queue; historical completion authority revoked
- [x] NH-01 through NH-03 have explicit human decisions and aligned normative contracts
- [x] Non-gated contract and primary-API corrections are internally consistent
- [x] Gap-owner, dependency, and decision-gate checks pass

---

## RP-01 — Conform schemas, events, and redaction

**Depends on:** RP-00  
**Owns gaps:** STORE-01, STORE-02  
**Stories:** US-14; supports US-23 and US-28–US-30

### Read first

- `spec.md` §5 schemas and event contract
- `packages/coding-agent/src/kpi/extensions/run-store.ts`, `packages/coding-agent/src/kpi/extensions/append-log.ts`
- `packages/coding-agent/src/kpi/schemas/*.schema.json`
- `test/run-store.test.ts`, `test/append-log.test.ts`

### Change

- Make TypeScript payload types and all four JSON schemas describe the same task, evidence, verdict, and event payloads.
- Add explicit research and bus event types required by later packages.
- Centralize event redaction for bearer values, cookies, passwords, provider keys, and known key prefixes.
- Reject raw vendor envelopes and headers from persisted event payloads; later clients persist normalized fields only.
- ~~Define the publish-artifact allowlist in `package.json`.~~ **Superseded by RP-01A.** The Pi-package payload this bullet described does not exist, so there is no allowlist to declare. The equivalent obligation — proving the built harness actually carries K-π's runtime resources — moves to RP-01A's distribution inventory. The npm payload of `@korallis/k-pi` is governed by NH-04 and built by `scripts/pack-kpi.mjs`, outside this queue.
- Create `test/schema-conformance.test.ts`; extend the existing store and log tests.

### Tests

- Representative live payloads validate; for each schema, one deliberately invalid variant is rejected with a located error.
- Research/bus events round-trip through schema validation, redaction, append, and hash-chain verification.
- Secret canaries never appear in the stored JSONL.
- ~~`npm pack --dry-run --json` inventory matches the allowlist.~~ **Superseded by RP-01A** (dist resource inventory instead of a pack inventory).

### Verification

```bash
node --test --experimental-strip-types test/schema-conformance.test.ts test/run-store.test.ts test/append-log.test.ts
```

### DoD

- [x] Schemas and live writers agree
- [x] Research/bus events are typed, redacted, and hash-chained
- [x] **Closed by RP-01A:** distribution boundary is explicit and secret-safe. The old package-publish framing is void; RP-01A proves the built fork distribution is complete and secret-free. The two boxes above stay checked — the schema, event, redaction, and hash-chain evidence behind them is unaffected by the architecture reset.

---

## RP-01A — Architecture reset: standalone fork, not a Pi package

**Depends on:** RP-01  
**Owns gaps:** ARCH-01, ARCH-02, ARCH-03, PKG-01  
**Stories:** US-01; releases every package from RP-02 onward  
**Reassigned:** `PKG-01` moves here from RP-19 — the resource proof is now a distribution inventory of the built `dist`, not a packed-artifact install.

This package converts K-π from a Pi package into its own harness. Nothing below it is meaningful until it lands: a policy, graph, account, research, K-stack, bus, or UI change written against `pi install`, a package manifest, or a peer dependency is written against an architecture that no longer exists.

### Read first

- `../UPSTREAM.md` — fork base, remotes, patched-file register, sync procedure
- `spec.md` §1 system context, §2 distribution and layout, §3 repository layout, NFR-05
- `PRD.md` US-01 (AC-01.1–AC-01.6), §3 non-goals, §9 constraints
- `AGENTS.md` hard rules and stack section
- `packages/coding-agent/package.json`, `packages/coding-agent/src/config.ts`
- The built-in registration path: `packages/coding-agent/src/extensions/index.ts` and the K-π factory it mounts, `packages/coding-agent/src/kpi/extensions/index.ts`
- Root `package.json`; the root proofs `test/harness.test.ts`, `test/cli-smoke.test.ts`, `test/docs-routing.test.ts`

### Change

- Make the repository the harness. Root `package.json` is `k-pi-monorepo`, private, npm workspaces. Remove pnpm workspace and lockfile artifacts, and every publish, release, and version script.
- Set `packages/coding-agent/package.json` `bin` to exactly `kpi` and `k-pi`, and delete the `pi` bin. Set `piConfig` to `{ "name": "kpi", "title": "K-π", "configDir": ".kpi" }`, and teach the config reader `piConfig.title` so `APP_TITLE` is `K-π`.
- Relocate K-π's runtime to `packages/coding-agent/src/kpi/` keeping the sibling layout (`extensions/`, `graphs/`, `prompts/`, `schemas/`, `skills/`, `templates/`, `themes/`, `kstack/`). Root `test/*.test.ts` stay at the repository root and import the relocated source.
- Register the K-π extension factory as a **visible built-in**. Its skills, prompts, themes, and graphs are declared by that built-in through resource discovery, and the build copies them into `dist`.
- A resource path declared by that built-in but absent on disk is a load error, not a silent omission. Resource discovery never filters a missing path out of its own result.
- Delete every install-era artifact: `keywords: ["pi-package"]`, the `package.json#pi` manifest key, `peerDependencies` on `@earendil-works/pi-*`, and any doc or code path that expects `pi install` or a package-trust decision before K-π's commands exist.
- Separate the two versions. The harness reports K-π's own `0.1.0`; the forked Pi base version lives only in `upstream.json` and `UPSTREAM.md`. Delete every path that would self-update K-π from `pi.dev` or an `@earendil-works` npm package, and keep `kpi update --models` for model-catalog refresh.
- Make every project-local runtime path derive from `CONFIG_DIR_NAME`, so the run store, knowledge graph, policy, graphs, and context pack live under `.kpi/` and user state under `~/.kpi/agent/`.
- Record the fork: `upstream.json` pin, `UPSTREAM.md` patched-file register, `NOTICE` attribution, `upstream` remote.
- Update `test/docs-routing.test.ts` for the RP-01A queue position. Make `test/harness.test.ts` the manifest, identity, and distribution proof, and `test/cli-smoke.test.ts` the credential-free CLI proof. Both assert against built or executed output, not against the source text that declares it.

### Tests

- `packages/coding-agent/package.json` declares exactly the bins `kpi` and `k-pi`, no `pi` bin, and the three `piConfig` fields.
- The built CLI reports K-π's own version `0.1.0`. The forked Pi base version appears only in `upstream.json` and `UPSTREAM.md`, never as the harness's own version, and no code path offers, checks, or performs a self-update from `pi.dev` or an `@earendil-works` npm package. `kpi update --models` still refreshes model catalogs.
- No manifest in the repository declares `keywords: ["pi-package"]`, a `pi` key, or a `peerDependencies` entry for `@earendil-works/pi-*`.
- No manifest carries publish, release, or version automation. (Workflow publishing arrived later under NH-04 and is confined to `.github/workflows/release.yml`.)
- With `piConfig.configDir` set, resolved config paths are `.kpi/` and `~/.kpi/agent/`; a repository-wide check finds no hard-coded `.pi/` runtime path.
- Instantiating the real built-in resource loader against a temporary HOME and an untrusted scratch project registers `/kpi`, `/accounts`, `/k-mode`, `/setup-kstack`, the `loop-amber` theme, and K-π's skills and prompts, with **no install command and no trust decision**. The assertion reads the command, resource, and diagnostic lists the loader actually returns — not the source text that declares them — and the diagnostic list is empty.
- A declared built-in resource that is missing on disk fails the load with an error naming the path. Dropping it from the discovery result is a defect, not a degraded mode.
- **Distribution inventory** (replaces RP-01's publish allowlist): after `npm run build:offline`, the inventory walks the built `dist` tree itself and finds every K-π graph, skill, prompt, theme, template, and schema that exists in source; that tree carries no secret, no test, no fixture, and no maintainer debris.
- `upstream.json` matches `UPSTREAM.md` §1, and the `upstream` remote points at `https://github.com/earendil-works/pi.git`.

### Verification

```bash
npm run build:offline
node --test --experimental-strip-types test/harness.test.ts test/cli-smoke.test.ts test/docs-routing.test.ts
node packages/coding-agent/dist/bundle/cli.js --version
npm run upstream:check -- --offline
```

### DoD

- [x] The repository builds one standalone harness whose only bins are `kpi` and `k-pi`
- [x] K-π's commands and resources load from the built-in with no install step and no trust gate
- [x] Every install-era artifact is gone: `pi install`, package manifest, peer dependencies, publish and release automation
- [x] Config and runtime paths resolve under `.kpi/` and `~/.kpi/agent/`
- [x] Distribution inventory is complete and secret-free, closing RP-01's reopened boundary box
- [x] Fork provenance is recorded: `upstream` remote, `upstream.json`, `UPSTREAM.md`, `NOTICE`

---

## RP-02 — Complete gated and autopilot command policy

**Depends on:** RP-01A  
**Owns gaps:** POL-01, POL-02, POL-03  
**Stories:** US-13; AC-13.1–AC-13.6

### Read first

- `spec.md` policy and node-tool sections
- `extensions/policy.ts`, `templates/policy.json`
- `test/policy.test.ts`

### Change

- In gated mode, classify `git commit` as confirm and include the current diff stat in the prompt.
- In autopilot, deny `git commit` until the active job has fresh `release.approved === true`.
- Confirm unknown commands in gated mode; deny them in autopilot.
- Classify shell commands by segment: a read-only classifier (`shell-classifier.ts`) replaces the exact safe list; task-declared quality gates stay exact.
- Chat scope (no live job): hard denies only, no bounds, no prompts (`commit.chat`, `unknown.chat`).
- Remember approvals: three-way confirm; *Always allow* persists the exact command to `.kpi/policy.json` `allow[]`; a session cache covers the process.
- Liveness: `resolveActivePolicyState` and `recordToolRequest` read only a live job; the write-bounds override is skipped in chat.
- Keep all AC-13.1 denies and protected `verdict.json`/`release.approved` writes.

### Tests

- Registered `tool_call` hook, not only a pure evaluator, covers accept and decline for gated commit.
- Prompt contains files changed, insertions, and deletions.
- Autopilot commit fails before release and passes after release.
- Unknown command behavior differs by mode; known safe commands do not prompt.
- `test/shell-classifier.test.ts` covers read-only heads, control words, wrappers, substitutions, and every mutating form.
- Chat scope, `allow[]` persistence, session cache, finished-job liveness, and project-only seeding through the live hook.

### Verification

```bash
node --test --experimental-strip-types test/shell-classifier.test.ts test/policy.test.ts
```

### DoD

- [x] AC-13.2–AC-13.4 pass through the live hook boundary
- [x] Existing AC-13.1 denials still pass
- [x] AC-13.5 chat scope and AC-13.6 remembered approvals pass through the live hook (fixes.md FX-02, 2026-09-02)

---

## RP-03 — Enforce graph budgets and bounded scheduling

**Depends on:** RP-01A  
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

- [x] Every configured cap is enforced
- [x] Wide supersteps are bounded, not rejected
- [x] Exhaustion is a durable product state

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

- [x] Failing-AC and fingerprint no-progress rules both work
- [x] Retry is bounded, same-round, and backoff-driven
- [x] Resume restores every stop-safety field

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

- [x] Shipped graphs match the normative conditional contract
- [x] Release is evidence-derived
- [x] Ship replay is a durable no-op

---

## RP-06 — Wire account usage, selection, failover, and stickiness

**Depends on:** RP-01A  
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

- [x] Quota-first and percentages use one live cache contract
- [x] M-05 passes through the integrated selection path
- [x] Stickiness releases only on the named transitions

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

- [x] Account and pool command surface matches `spec.md`
- [x] Official catalogs remain Pi-owned
- [x] Provider notices and classifier boundary are correct

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

- [x] AC-27.1–AC-27.8 have executable coverage
- [x] Native llama.cpp remains Pi-owned
- [x] Local discovery is live, bounded, stored, and no-cloud

---

## RP-09 — Build the research credential, mode, event, and budget control plane

**Depends on:** RP-01A, RP-07  
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

- [x] Research keys, modes, budgets, events, and fallback have one owner
- [x] US-28 setup variants and US-29 no-network/local paths are deterministic

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

- [x] Provider requests match current official REST contracts
- [x] Research artifacts are normalized, bounded, cited, and secret-safe
- [x] Two-source completion never fabricates evidence

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

- [x] AC-30.1–AC-30.11 have named behavior tests
- [x] Graph and worker claims share one exact current-module boundary

---

## RP-12 — Complete the knowledge graph lifecycle and kg-claim

**Depends on:** RP-01A  
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
node --test --experimental-strip-types test/kg.test.ts test/harness.test.ts
```

### DoD

- [x] KG authoritative lifecycle is complete and crash-safe
- [x] One-writer boundary is executable
- [x] `kg-claim` is loadable without custom resource code

---

## RP-13 — Implement the Pi RPC worker bus

**Depends on:** RP-01A, RP-11  
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
- Launch the absolute Pi CLI with `--mode rpc`, session file `.kpi/runs/<job>/agents/<role>-<id>.jsonl`, the matching session directory, role-specific `--tools`, piped stdout/stderr, and bounded lifecycle cleanup.
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

- [x] Worker protocol matches the forked harness base (Pi `0.84.4`)
- [x] Tool isolation, completion, cancellation, leases, and logs are enforced
- [x] Q-04 remains in-process only

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

- [x] Reviewer is a background Pi session with read-only isolation
- [x] Verdict file, not prose, controls release routing

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

- [x] Ladder data is semantically enforced, not presence-checked
- [x] One-concat fixture prevents needless structure

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
- Replace hard-coded model slugs and `.cursor/rules/*.mdc` consumers with the k-pi-owned `~/.kpi/agent/kstack/models.json` contract.
- Make `/setup-kstack` consume `model-ladder.md`, filter to live healthy pool models, show chosen/next-best/confidence per role, allow per-line edits, and preserve ordered cross-family review panels.
- Exclude `make-bot-ui`, Benny, Bugbot, worktree cleanup, `/loop` sleeper, cloud-agent, Graphite, and every documented drop path.
- Use token/path-aware branding; never corrupt containing words such as `upstack`.
- Arena/swarm use live configured k-pi pools, at most two workers, one writer, and no cloud/worktree semantics.
- Freeze the matched playbook name and ordered `{node,text,skip?}` steps into `task.json`; render every step into `state.json.todos` from that snapshot only; include playbook and steps in `contractHash` (only `current_module_id` excluded).
- Retain the complete upstream MIT license.

### Tests

- Offline residue fixture includes every known invalid name/operator/path/slug/brand/drop-path and either transforms it correctly or fails with a located diagnostic.
- Every shipped skill has valid, unique Pi frontmatter and all support files remain reachable.
- Required feature, bug-fix, investigation, shipping, autonomous-run, arena, and swarm playbooks are each discoverable exactly once.
- No forbidden residue exists in loaded roots; ordinary words containing `pstack` substrings remain intact.
- `/setup-kstack` follows the ladder/healthy-pool contract, accepts only live registry slugs, supports per-line edits, and writes atomic validated JSON. K-mode freezes the selected playbook and skip reasons.

### Verification

```bash
node --test --experimental-strip-types test/kstack-runtime.test.ts test/harness.test.ts test/bus.test.ts
```

### DoD

- [x] One generated/loadable K-stack runtime source
- [x] No invalid skill diagnostics or forbidden Cursor/cloud/Graphite residue
- [x] K-stack orchestration uses the first-party bus and live model map

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
npm run kstack:sync:check
```

### DoD

- [x] Sync is deterministic, semantic, patch-safe, and license-preserving
- [x] Drift reporting is pstack-tree aware
- [x] `kstack:sync:check` can no longer pass invalid generated skills

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

- [x] US-15, US-16, and US-25 are information-complete
- [x] All upstream state owners feed honest lamps/labels
- [x] M-06 measures a real assistant response

---

## RP-19 — Prove traceability and the whole built product

**Depends on:** RP-01A, RP-02–RP-18  
**Owns gaps:** REL-01, REL-02  
**Stories:** US-01–US-30; M-01–M-07

### Read first

- `PRD.md`, `spec.md`, focused product docs
- `remediation-research.md` gap register
- Every RP DoD and verification command
- Root `package.json`, `packages/coding-agent/package.json`, `upstream.json`, CI workflows, `README.md`, `../UPSTREAM.md`

### Change

- Create `test/traceability.test.ts` and a machine-readable requirement→test map. Every PRD AC, required spec ID, metric, gap ID, and RP has at least one named observable check and one primary owner.
- Create `scripts/verify-built-harness.mjs` and `scripts/verify-product.mjs`. There is no package to install and no artifact to pack: the subject under test is the built `kpi` binary produced from this repository.
- Make CI run the repository gates, the K-stack semantic sync check, the upstream pin check, the distribution inventory, and the built-harness smoke.
- Update README workflows and operator commands to match the verified product. Do not change feature behavior here; return any failure to its owning RP.

### Tests and built-product proof

1. Run the repository gates and the K-stack semantic sync check.
2. Build the harness from this repository's own source, then verify the distribution inventory: every K-π graph, skill, prompt, theme, template, and schema is in `dist`, with no secret, test, fixture, or maintainer debris.
3. Launch the built binary — `node packages/coding-agent/dist/bundle/cli.js` — against a temporary HOME (`KPI_CODING_AGENT_DIR`) and a scratch Git repository. It must report `kpi`, config root `~/.kpi/agent/`, and the pinned upstream base.
4. Start that binary in `--mode rpc` with an explicit offline test model/provider. Assert zero resource/skill diagnostics, and discover every built-in command, prompt, theme, ordinary skill, K-stack skill, and `kg-claim` — with **no install command and no trust decision**.
5. Exercise deterministic fixtures against the built binary for gated, autopilot, policy, accounts, local discovery, research, Dune, KG, bus/reviewer, and UI.
6. Write a secret-free machine-readable M-01–M-07 proof report.

### Verification

```bash
npm run check
npm test
npm run test:kpi
npm run kstack:sync:check
npm run upstream:check -- --offline
npm run build:offline
node scripts/verify-built-harness.mjs
node scripts/verify-product.mjs --json .kpi/remediation-proof.json
```

### Required observations

- M-01: gated fixture reaches human confirmation with green receipts.
- M-02: autopilot fixture reaches `DONE`, no human node, exactly one job-marked commit.
- M-03: narrative AC refuses autopilot and writes `ac.refused`.
- M-04: bounds violation reaches `UNSAFE` and creates no commit.
- M-05: exhausted sibling is never selected while a healthy sibling exists.
- M-06: actual visible assistant reply is below 800 characters.
- M-07: all repository gates and built-harness checks pass.

### Feature acceptance hand-off

RP-19 proves the product is built, traceable, and green. It does not decide whether a real user would accept each feature. That is [`uat.md`](uat.md): one row per story US-01–US-30 plus the seven PRD metrics, run against the built binary **after** this package closes and the gates above pass. RP-19 wires the evidence path (`.kpi/uat/<UAT-ID>/`) and the roll-up into `.kpi/remediation-proof.json`; it does not run the rows.

### DoD

- [x] Every AC, required contract, metric, gap, and RP has executable traceability
- [x] The built `kpi` binary starts from a clean HOME and scratch repository with zero diagnostics and no install step
- [x] M-01–M-07 proof report is green and secret-free
- [x] No historical checkbox was used as evidence
- [x] The `docs/uat.md` evidence path and roll-up exist and are wired, and every row's owning RP is closed so UAT can begin

---

## Execution waves

RP-01A was a hard barrier and it has landed. From here the only constraints are the dependency map above and one writer per file: any set of packages whose dependencies are complete may run concurrently.

| Wave | Concurrent packages | Primary ownership |
|---|---|---|
| 1 | RP-02, RP-03, RP-06, RP-12 | `extensions/policy.ts` + `templates/policy.json` · `extensions/graph/{schema,engine,stop}.ts` · `extensions/accounts/{store,balancer,widget}.ts` + `accounts/usage/*` · `extensions/kg/{store,index}.ts` |
| 2 | RP-04, RP-07 | RP-04 re-owns `graph/stop.ts` and `graph/engine.ts`, so it never overlaps RP-03 |
| 3 | RP-05, RP-08, RP-09 | RP-05 exclusively owns `extensions/gated-loop.ts` and `graphs/*.json` for this wave |
| 4 | RP-10 | RP-05 and RP-08 must be merged before wave 5 |
| 5 | RP-11 | Re-owns `extensions/gated-loop.ts`; serialize against everything |
| 6 | RP-13, RP-15 | `extensions/bus/*` · `extensions/minimalist.ts` + `skills/minimalist/` |
| 7 | RP-14, RP-16 | RP-14 takes the reviewer path in `gated-loop.ts`; RP-16 takes `kstack/**` and the `STEPS` table in `kstack/mode.ts` |
| 8 | RP-17, RP-18 | RP-18 re-owns `accounts/widget.ts`, `control-plane.ts`, `status-line/*`, `renderers.ts` |
| 9 | RP-19 | Full product proof, run once |

Serialize any packages that touch `extensions/index.ts`, `extensions/gated-loop.ts`, `extensions/accounts/index.ts`, a `package.json`, or generated K-stack output. A wave's registration edits to `extensions/index.ts` land as one integration commit owned by one agent. Merge a wave and run its owning scoped checks before the next dependent wave starts.

From RP-02 onward, a source path written `extensions/…`, `graphs/…`, `prompts/…`, `schemas/…`, `skills/…`, `templates/…`, `themes/…`, or `kstack/…` is relative to `packages/coding-agent/src/kpi/`, where RP-01A relocated the K-π runtime; `test/…` and `fixtures/…` stay at the repository root.

## Definition of done for the whole product

Remediation packages RP-00–RP-19 are closed. Items 1–7 below are satisfied by that scoped evidence plus `.kpi/remediation-proof.json`. **Item 8 (UAT)** machine rows are green on the tip binary; one attended residual remains (see below). The product is not finished until that residual is closed too.

All of:

1. [x] RP-00, RP-01, RP-01A, and RP-02–RP-19 DoD boxes checked from their scoped evidence, including RP-01's reopened distribution box closed by RP-01A.
2. [x] `npm run check`, `npm test`, `npm run test:kpi`, `npm run kstack:sync:check`, and `npm run upstream:check` exit 0.
3. [x] The built `dist` carries every K-π runtime resource and contains no secret or forbidden runtime dependency.
4. [x] The built `kpi` binary starts from a clean HOME and scratch repository with zero resource diagnostics, no install step, and no trust decision.
5. [x] Fixtures run against that binary cover gated, autopilot, policy, accounts, local providers, research, Dune, KG, bus/reviewer, K-stack, footer, and both boards.
6. [x] M-01–M-07 are true in `.kpi/remediation-proof.json`.
7. [x] Docs match the built behavior; historical plan/roadmap remain clearly non-authoritative.
8. [~] Every machine-drivable row of [`uat.md`](uat.md) — US-01 through US-30 — **PASS** against the built binary under `.kpi/uat/UAT-*/result.json`, rolled into `.kpi/remediation-proof.json` with `uat.rows_executed=true` and `uat.all_pass=true` for those machine verdicts. **Still open (attended-only):** **AC-10.2** on UAT-10 — live `/accounts login anthropic` twice (stacked OAuth slots) needs a human with real Anthropic credentials and network; the machine half (loopback z.ai pool, 429 sibling failover, cooled-never-reselected) already passes. Do not mark this line `[x]` until AC-10.2 is attended and evidence is filed. The product is finished at this line and not before.
