# k-pi remediation research

**Observed:** 2026-09-01  
**Baseline:** Pi `0.84.4` (commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`), now K-π's own forked source under `packages/`  
**Purpose:** Evidence, non-choice corrections, and the recorded human decision gates for [`docs/remediation-plan.md`](remediation-plan.md). This document does not authorize implementation order; the plan does.

> **Architecture note (supersedes the packaging basis of this audit).** This audit was executed while K-π was still built as a package installed into a separately installed Pi. K-π is now a fork: the harness is this repository, the executable is `kpi`, and the control plane is a compiled-in built-in. Every finding about schemas, events, redaction, providers, catalogs, research, K-stack, bus, and UI still holds — those contracts did not change. Findings expressed as *package installation, package trust, peer dependency, publish payload, or `pi install`* are superseded by RP-01A in the plan and are not authority. Where a source below is cited under `node_modules/@earendil-works/pi-coding-agent/…`, the same file now lives in this repository under `packages/coding-agent/…`.

## Method

The audit used five evidence levels, in this order:

1. `PRD.md` acceptance criteria and the focused product contracts in `spec.md`, `research.md`, `dune-architecture.md`, `kstack.md`, `minimalist.md`, `agents-bus.md`, and `visual-targets.md`.
2. Installed Pi `0.84.4` documentation, declarations, and compiled implementation under `node_modules/@earendil-works/`.
3. Official vendor API documentation and owning source repositories.
4. The shipped k-pi source, generated resources, fixtures, tests, and package manifest.
5. Executed repository and live-package checks.

Checked boxes in `roadmap.md` and `implementation-plan.md` were excluded as evidence. All were marked complete before this audit, but the source and live package contradict several of them.

### Executed baseline

Before this remediation plan was written:

- `pnpm test`: 79 tests passed.
- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm kstack:sync:check`: passed.
- Scratch install of the then-current package artifact succeeded (superseded: there is no install step now).
- Pi `0.84.4` loaded the extension, prompts, themes, footer, and `/kpi-ping`.
- The live Pi startup emitted invalid-skill diagnostics for generated `Poteto Mode` and `Make Bot UI` skill names.

These checks prove the current artifact is internally consistent enough to load. They do not prove the acceptance criteria below.

## Constraints not requiring a product decision

These constraints are compatible scope choices or corrections forced by primary installed/vendor API evidence. None selects between conflicting PRD and specification behavior.

| ID | Decision | Evidence |
|---|---|---|
| S-01 | Pi `0.84.4` is the baseline, now forked into this repository. K-π extends that base through its own extension surface; it does not rebuild resource loading, model catalogs, sessions, or RPC. | `AGENTS.md`; `UPSTREAM.md`; the forked harness source and docs under `packages/coding-agent/` |
| S-02 | Declared prompts, skills, and themes need no custom loader; the harness's resource loader handles them. Under the fork they are declared by K-π's built-in extension through resource discovery instead of a package manifest. | `packages/coding-agent/docs/packages.md`; `src/core/pi-manifest.ts`; `src/core/resource-loader.ts` |
| S-03 | Cursor login does not require an authorization-code or loopback callback flow. Paste/manual/device flows satisfy Pi's OAuth callback surface. | Installed `dist/compat/extension-oauth-types.d.ts`; `docs/custom-provider.md` |
| S-04 | The v1 worker cap is in-process only. Do not add a cross-process cap. | `PRD.md` Q-04 |
| S-05 | Pi's built-in provider `llama.cpp` and `/llama` own llama.cpp discovery. k-pi maps pool `llama` to it and must not re-register it. | Installed `dist/extensions/llama/`; `docs/llama-cpp.md`; AC-27.1 |
| S-06 | Exa and Perplexity are research credential targets, not model pools. | AC-28.2; `spec.md` pool-id list |
| S-07 | `APPROVAL` is a derived protocol-blue board lamp while a human node is paused. It is never serialized as a stop state. Normative stop states remain `DONE | BLOCKED | EXHAUSTED | NO_PROGRESS | UNSAFE | NEEDS_HUMAN`. | AC-16.3; AC-25.2; `spec.md` §6 stop states, §8 interrupted human nodes, and §11 protocol-blue pause behavior |
| S-08 | The Exa per-content provider and local persistence cap is 10,000 characters, not 15,000. | Exa Search and Contents references below |
| S-09 | `after_provider_response` provides status and headers, not a response body. Global classification cannot depend on body tokens. Custom fetch clients may classify bodies they own. | Installed `docs/extensions.md`; extension types |
| S-10 | Generated, Pi-loadable K-stack output is the only runtime truth. Overlay-owned additions must feed that output. | `package.json` manifest; `kstack.md` |
| S-11 | Unsupported Cursor Routines such as `make-bot-ui` are excluded. Blind token replacement is not an implementation. | `kstack.md` drop list; upstream skill contract |
| S-12 | Cross-process caps, worktree-per-job, Obsidian as authority, auto-push, fan-out above two, Exa advanced APIs, and Perplexity deep-research APIs remain outside v1. | `roadmap.md`; `PRD.md`; `research.md` |

## `NEEDS_HUMAN` decision gates

These conflicts were resolved only by explicit human decision, never by document precedence. All four gates are `CLOSED`: `korallis` decided NH-01 through NH-03 on `2026-09-01` and NH-04 on `2026-09-02`. The `Selected decision` cell is the authoritative product behavior, the `Aligned normative files` cell names where that behavior is written, and the `Blocks` column is dependency history — those packages were blocked until closure and the recorded decisions release them. Any newly discovered contradiction adds a new `OPEN` gate that blocks its dependents until a human closes it the same way.

| ID | Status | Decided by | Decided on | Conflicting contracts | Human decision required | Selected decision | Aligned normative files | Blocks |
|---|---|---|---|---|---|---|---|---|
| NH-01 | CLOSED | korallis | 2026-09-01 | AC-27.6 requires local slots to render `(local)` at `$0`, while `spec.md` restricts `Slot.kind` to `oauth \| api_key`. | Decide whether local providers are represented as account slots and, if so, their schema kind. | Add credential-free `Slot.kind = local`. A local slot persists its configured base URL, may reference an optional credential without storing a dummy secret, renders exactly one cost cell as `(local) $0`, shows no quota percentage, and stays outside the default cloud chain. | `docs/spec.md` (§13 `Slot.kind` plus REQ-SL-01/REQ-SL-02; §11 REQ-SB-08 cost cell and accounts widget), `docs/PRD.md` (AC-06.4, AC-15.10, AC-27.3, AC-27.5, AC-27.6), `docs/visual-targets.md` (§1 `cost`/`usage` segments; §3 acceptance checks) | RP-01, RP-08, RP-18 |
| NH-02 | CLOSED | korallis | 2026-09-01 | AC-28.5 and `research.md` require local completion after all online providers fail, while AC-29.2 requires at least two external sources whenever a key exists unless the job is flagged `no-network`. | Decide who may set `no-network` after provider exhaustion and whether that fallback satisfies AC-29.2. | A successful online Exa or Perplexity run must cite at least two distinct external sources. After bounded, recorded failures of every configured service, the engine sets effective `no-network` and the planning model researches repository and frozen local sources with normal read and search tools, citing local files only; no external URL is ever fabricated. A healthy online service that still supplies fewer than two distinct sources ends `NEEDS_HUMAN`. | `docs/research.md` (planning default, effective no-network, local research), `docs/PRD.md` (AC-28.5, AC-29.2, AC-29.3, AC-29.6, AC-29.7), `docs/spec.md` (§5 `SCH-research` and REQ-RS-07; §6 `NEEDS_HUMAN` stop-state row), `docs/visual-targets.md` (§2 Board A research state; §3 acceptance checks) | RP-01, RP-09, RP-10, RP-18 |
| NH-03 | CLOSED | korallis | 2026-09-01 | `agents-bus.md` denies reviewer/tester write tools but also requires the reviewer to write `verdict.json`. | Decide how a read-only reviewer may publish its run-contract result without gaining product-file mutation access. | Reviewer and tester keep no general `write` or `edit` tool. A dedicated `write_contract` capability is pinned to the spawned agent, job, role, and declared contract path, schema-validates the verdict or evidence payload, then performs an atomic write. Every other path is denied. | `docs/agents-bus.md` (`write_contract`, same-tree rule, forbidden list), `docs/spec.md` (§5 run-store writer column and REQ-RS-06; §7 node tool policy; §12 policy deny; NFR-04), `docs/PRD.md` (AC-02.4, AC-04.3, AC-08.4, AC-23.9) | RP-01, RP-13, RP-14, RP-18 |
| NH-04 | CLOSED | korallis | 2026-09-02 | `spec.md` REQ-DIST-05 states that no publish, release, or version automation exists and `PRD.md` Q-01 defaults to `source build only; never published`, while the owner instructed that K-π be distributed through npm and that CI/CD be rebuilt. | Decide whether K-π is published at all, which artifact is published, and what governs the publish path. | K-π publishes exactly one npm package, `@korallis/k-pi`, built from the CLI bundle (`dist/bundle` plus the runtime resource directories) by `scripts/pack-kpi.mjs`. Workspace packages keep their upstream names and are never published. Releases are tag-driven: the tag `v<version>` must equal `packages/coding-agent/package.json#version`, and `.github/workflows/release.yml` publishes from a GitHub-hosted runner through npm trusted publishing (OIDC, provenance, no long-lived token); the first publish of the package is manual. CI is `check` (required, self-hosted macOS hard gate), `ai-review` (advisory z.ai review, never required), `auto-merge`, `queue-stall-alarm`, and `upstream-drift`; the fail-closed Grok review and React Doctor workflows are deleted. | `docs/spec.md` (§2 distribution contract and REQ-DIST-05), `docs/PRD.md` (§10 Q-01), `AGENTS.md` (Stack, Gates, Do not), `UPSTREAM.md` (§4 root manifest row, §5 exclusions, §6 workflow register), `README.md` (Install, Non-goals), `docs/remediation-plan.md` (execution rule 9, NH-04), `test/harness.test.ts` (root `pack` script, no publish scripts) | — |

## Plan-document strategy research

Three document strategies were compared.

| Strategy | Result | Reason |
|---|---|---|
| Append new WPs to `implementation-plan.md` | Rejected | The file would contain checked claims and new repair claims for the same ACs. It would also exceed its original milestone/batching model. |
| Replace or rewrite the original plan | Rejected | The repository has no commits; the checked documents are the only record of the original build intent, including WP-21's reviewer migration. |
| Dedicated remediation plan with historical banners and pointer cutover | Selected | Preserves the baseline verbatim, revokes its completion authority, creates one active unchecked queue, and keeps research separate from execution steps. |

`docs/remediation-plan.md` is therefore the sole active queue. `roadmap.md` and `implementation-plan.md` remain readable historical baselines.

## Installed Pi contracts

### Packages and resources

The harness reads only `extensions`, `skills`, `prompts`, and `themes` from a `package.json` `pi` manifest, and also supports conventional directories when a manifest is absent. Either way the resources flow through the default resource loader, so K-π needs no custom parsing or discovery layer. **Under the fork, K-π uses neither path:** it has no `pi` manifest, and its resources are declared by the compiled-in K-π extension through resource discovery. The finding that survives is the negative one — do not build a custom loader.

Skill rules in Pi `0.84.4`:

- `name`: 1–64 characters; lowercase letters, digits, and hyphens; no leading, trailing, or consecutive hyphens.
- Missing or empty `description`: the skill does not load.
- Invalid names: diagnostic warning; Pi may still load the skill.
- Name collisions: diagnostic warning; first discovery wins.

An extension factory may be async and is awaited during startup. It must not start long-lived processes, watchers, sockets, or timers. Those resources belong in `session_start`, a command/tool call, or another consuming event, with idempotent cleanup on `session_shutdown`.

Primary sources, now in-repo under the fork:

- `packages/coding-agent/docs/packages.md`
- `packages/coding-agent/docs/skills.md`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/src/core/pi-manifest.ts`
- `packages/coding-agent/src/core/skills.ts`

### Providers and catalogs

Pi supports `registerProvider(provider)` and `registerProvider(name, config)`.

Provider composition matters:

- A `models.json` model list upserts into built-ins.
- An extension `models` list replaces that provider's lower catalog.
- An extension that changes only `baseUrl` or headers preserves the catalog.
- `refreshModels` is the live-catalog seam and must honor its abort signal and stored snapshot.

Therefore k-pi must never pass `models` when touching official ids `anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, or `kimi-coding`. Cursor, Ollama, LM Studio, and generic local OpenAI compatibility are first-party additions and may publish dynamic catalogs.

Pi `0.84.4` includes a hidden native `llama.cpp` provider. It resolves `LLAMA_BASE_URL`, optional `LLAMA_API_KEY`, defaults to `http://127.0.0.1:8080`, restores stored discovery, and owns `/llama`.

Primary installed sources:

- `dist/core/extensions/types.d.ts`
- `dist/core/provider-composer.js`
- `node_modules/@earendil-works/pi-ai/dist/models.d.ts`
- `dist/extensions/llama/index.js`
- `dist/extensions/llama/provider.js`
- `docs/custom-provider.md`
- `docs/llama-cpp.md`

### RPC and worker sessions

Pi RPC uses strict LF-delimited JSONL. Node's `readline` is not compliant because it also treats U+2028/U+2029 as line boundaries.

Required worker behavior:

- Initial request: `{"type":"prompt","message":"..."}`.
- Mid-run steer: `{"type":"steer",...}` or prompt with `streamingBehavior:"steer"`.
- Follow-up: `{"type":"follow_up",...}` or prompt with `streamingBehavior:"followUp"`.
- Prompt `success:true` means accepted, not completed.
- `agent_settled` is the completion event. `agent_end` may still be followed by retries or queued continuations.
- Cancel clears queued steering/follow-ups before abort.
- Worker CLI isolation uses `--mode rpc`, a session path/directory, and `--tools <csv>`.

Primary installed sources:

- `docs/rpc.md`
- `dist/modes/rpc/rpc-types.d.ts`
- `dist/modes/rpc/jsonl.d.ts`
- `dist/modes/rpc/rpc-client.js`
- `dist/cli/args.js`

## Vendor API contracts

### Exa

Exa Search is `POST https://api.exa.ai/search`. Search content options are nested under `contents`. Exa Contents is `POST https://api.exa.ai/contents`; its content options are top-level. Both accept bearer authentication.

Hard requirements:

- `text.maxCharacters` and `highlights.maxCharacters` are at most 10,000.
- Search/Contents may return fewer results than requested.
- Contents can return HTTP 200 while individual URLs fail; inspect `statuses[]`.
- Classify by HTTP status first. Error envelopes vary, especially on 429.
- Bound at request time and clamp again before returning or persisting data.

Sources:

- [Exa Search](https://exa.ai/docs/reference/search)
- [Exa Search guide for coding agents](https://exa.ai/docs/reference/search-api-guide-for-coding-agents)
- [Exa Contents](https://exa.ai/docs/reference/get-contents)
- [Exa Contents guide](https://exa.ai/docs/reference/contents-api-guide-for-coding-agents)
- [Exa error codes](https://exa.ai/docs/reference/error-codes)
- [Exa rate limits](https://exa.ai/docs/reference/rate-limits)

### Perplexity Search

Perplexity Search is `POST https://api.perplexity.ai/search` with bearer authentication.

Hard requirements:

- `max_results` is a maximum, not a guarantee.
- `search_context_size` is qualitative. It is not a hard response bound.
- Hard-bounded mode uses `max_tokens` and/or `max_tokens_per_page` and omits `search_context_size`.
- The Search API documents 422 validation errors and general 429/5xx behavior. It does not document Search-specific 402; k-pi may handle any 402 defensively without attributing that promise to Perplexity.

Sources:

- [Perplexity Search API](https://docs.perplexity.ai/api-reference/search-post)
- [Search quickstart](https://docs.perplexity.ai/docs/search/quickstart)
- [Rate limits](https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers)
- [Error handling](https://docs.perplexity.ai/docs/sdk/error-handling)
- [Best practices](https://docs.perplexity.ai/docs/sdk/best-practices)

### Local model discovery

| Runtime | Default base | Discovery | Identity |
|---|---|---|---|
| Pi llama.cpp | `http://127.0.0.1:8080` | Pi-native `/models`/`/llama` path | Pi-native catalog |
| Ollama | `http://127.0.0.1:11434/v1` | `/v1/models`, then required `/api/tags` compatibility fallback | `data[].id` or `models[].model` |
| LM Studio | `http://127.0.0.1:1234/v1` | `/v1/models` | `data[].id` |
| local-openai | operator URL | `/v1/models` | `data[].id` |

Preserve exact server model ids. Do not synthesize aliases or infer capabilities from model names. Empty catalogs are valid. Distinguish HTTP, schema, timeout/abort, and transport failures. The configured origin is the only origin; no OpenAI or Ollama cloud fallback is allowed.

Sources:

- [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [Ollama list models](https://docs.ollama.com/api/tags)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama authentication](https://docs.ollama.com/api/authentication)
- [LM Studio OpenAI models](https://lmstudio.ai/docs/developer/openai-compat/models)
- [LM Studio native model list](https://lmstudio.ai/docs/developer/rest/list)
- [LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication)
- [OpenAI List Models structural contract](https://developers.openai.com/api/reference/resources/models/methods/list)

## K-stack upstream research

Observed upstream `cursor/plugins` HEAD was `b9ddc83c32972210b8a94d389130713e8eed346e`; the latest commit touching `pstack/` was `6fecddba65801f9b9c08b8b328d998ee5b09d290`. Both resolved to the same `pstack` tree `950b90234c17babd00c43e32b19ae50abb4720f5`.

Therefore repository-HEAD drift and relevant pstack-tree drift are different states. A scheduled check should not treat unrelated repository commits as a K-stack content update.

The upstream pstack tree:

- is MIT licensed, Copyright 2026 Lauren Tan;
- has no upstream NOTICE file;
- includes invalid-for-Pi display names `Poteto Mode` and `Make Bot UI`;
- contains Cursor-only `Task`, `subagent_type`, `.cursor/rules/*.mdc`, Cloud Agent, worktree, Routines/webhook, and model-slug contracts;
- contains nested skill support files and executable scripts that must survive a recursive transform;
- can add, move, or delete skills between pins, so generation must start from an empty candidate tree.

The current k-pi overlay uses global string replacement and whole-line deletion. It leaves forbidden residue, deletes unrelated prose, creates `UK-stack`/`uK-stack` corruption from words containing `pstack`, and fabricates `spawn_background: true` rather than translating orchestration contracts.

The remediation must use path-aware and frontmatter-aware transforms, a documented drop-path policy, fail-closed semantic invariants, staging-only patch application, candidate validation, and atomic promotion. It must preserve the complete upstream MIT license.

Sources:

- [cursor/plugins current commits](https://api.github.com/repos/cursor/plugins/commits?path=pstack&per_page=20)
- [pstack manifest](https://raw.githubusercontent.com/cursor/plugins/b9ddc83c32972210b8a94d389130713e8eed346e/pstack/.cursor-plugin/plugin.json)
- [pstack LICENSE](https://raw.githubusercontent.com/cursor/plugins/b9ddc83c32972210b8a94d389130713e8eed346e/pstack/LICENSE)
- [setup-pstack source](https://raw.githubusercontent.com/cursor/plugins/b9ddc83c32972210b8a94d389130713e8eed346e/pstack/skills/setup-pstack/SKILL.md)
- [poteto-mode source](https://raw.githubusercontent.com/cursor/plugins/b9ddc83c32972210b8a94d389130713e8eed346e/pstack/skills/poteto-mode/SKILL.md)
- [make-bot-ui source](https://raw.githubusercontent.com/cursor/plugins/b9ddc83c32972210b8a94d389130713e8eed346e/pstack/skills/make-bot-ui/SKILL.md)
- [Git apply](https://git-scm.com/docs/git-apply)
- [Git sparse checkout](https://git-scm.com/docs/git-sparse-checkout)

## Confirmed gap register

The `Owner` column is authoritative and must remain one-to-one with the plan.

| Gap | Confirmed defect | Owner |
|---|---|---|
| DOC-01 | Checked roadmap and implementation plan still claim active completion. | RP-00 |
| DOC-02 | NH-01 through NH-03 captured the behavioral contract conflicts. All three are `CLOSED` by the decisions `korallis` recorded on `2026-09-01`, and each selected decision must land in that gate's aligned normative files. RP-00 also owns compatible namespace clarifications plus primary-API and historical-trace corrections for research targets, Exa limits, response hooks, Dune execution state, and K-stack runtime source. | RP-00 |
| ARCH-01 | K-π is built as a Pi package installed into a separately installed Pi: `pi install -l ./`, `keywords: ["pi-package"]`, a `package.json#pi` manifest, and `peerDependencies` on `@earendil-works/pi-*`. The product is meant to be its own harness. | RP-01A |
| ARCH-02 | The executable, config dir, and env prefix are still Pi's (`pi`, `.pi/`, `~/.pi/agent/`, `PI_CODING_AGENT_DIR`) instead of K-π's (`kpi`/`k-pi`, `.kpi/`, `~/.kpi/agent/`, `KPI_CODING_AGENT_DIR`), and K-π's runtime is not located inside the harness source tree. | RP-01A |
| ARCH-03 | K-π's commands and resources depend on package discovery and a project-trust decision rather than a compiled-in built-in extension, and the fork has no recorded provenance (`upstream` remote, `upstream.json`, `UPSTREAM.md`, `NOTICE`). | RP-01A |
| PKG-01 | No diagnostic-free resource proof for the shipped product; generated skill warnings ship. Reframed by RP-01A: the proof is a distribution inventory of the built `dist` plus a clean start of the built `kpi` binary, not a packed-artifact install. | RP-01A |
| STORE-01 | Task/evidence/verdict/event schemas drift from live payloads. | RP-01 |
| STORE-02 | Research/bus event types and redaction/normalized-payload boundaries are incomplete. | RP-01 |
| POL-01 | Gated commit confirmation lacks diff-stat and decline proof. | RP-02 |
| POL-02 | Autopilot does not prevent commit before release approval. | RP-02 |
| POL-03 | Unknown-command gated-confirm/autopilot-deny and safe allowlist are incomplete. | RP-02 |
| GRAPH-01 | `maxCostUsd` and `timeoutMs` are validated but unenforced; cap failures do not yield `EXHAUSTED`. | RP-03 |
| GRAPH-02 | `maxConcurrency` aborts instead of scheduling bounded batches. | RP-03 |
| GRAPH-03 | Limit values and accumulated counters are not consistently sourced from the job contract. | RP-03 |
| GRAPH-04 | Same failing AC-id sets do not produce `NO_PROGRESS`. | RP-04 |
| GRAPH-05 | Max-two same-round transient retries and exponential backoff are not executed. | RP-04 |
| GRAPH-06 | Stop/retry/cost/time/fingerprint state is not resume-durable. | RP-04 |
| GRAPH-07 | Shipped graphs do not encode every required test/bounds/review/human/release edge. | RP-05 |
| GRAPH-08 | Ship lacks a durable job-marker no-op replay contract. | RP-05 |
| ACCT-01 | Usage readers/cache/widget/quota-first route are unwired. | RP-06 |
| ACCT-02 | Same-model/thinking failover, whole-family fallback, and stickiness release lack end-to-end proof. | RP-06 |
| ACCT-03 | Accounts next/pin, pool strategy/chain, and auth.json default import are absent. | RP-07 |
| ACCT-04 | z.ai/Codex/Cursor notices and the official-catalog invariant lack end-to-end coverage. | RP-07 |
| ACCT-05 | Global hook body-token classification contradicts Pi's status/header-only response hook. | RP-07 |
| LOCAL-01 | k-pi pool `llama` is not integrated with Pi provider `llama.cpp`. | RP-08 |
| LOCAL-02 | Ollama, LM Studio, and local-openai registration/live refresh are absent. | RP-08 |
| LOCAL-03 | Local cooldown, local-first fallback, no-cloud routing, and local cost attribution are absent. | RP-08 |
| RESEARCH-01 | Saved-key precedence, research account commands, mode, and graph visibility are wrong or absent. | RP-09 |
| RESEARCH-02 | Research events, call budget, cooldown, no-network, and deterministic source completion are missing. | RP-09 |
| RESEARCH-03 | Exa request bounds and partial-status handling are wrong or incomplete. | RP-10 |
| RESEARCH-04 | Perplexity hard bounds and error assumptions are wrong or incomplete. | RP-10 |
| RESEARCH-05 | Normalized/deduplicated/bounded artifacts, failover, and secret/raw-envelope exclusion are incomplete. | RP-10 |
| DUNE-01 | Stack is optional and the current module defaults to `modules[0]`. | RP-11 |
| DUNE-02 | String-prefix allowed paths can escape the module. | RP-11 |
| DUNE-03 | Layer/shared/delivery/extraction/no-stack/scaffold rules are incomplete. | RP-11 |
| KG-01 | Authoritative nodes/edges/sources/snapshot lifecycle is incomplete. | RP-12 |
| KG-02 | Direct-write denial and serialized concurrent proposal/accept proof are absent. | RP-12 |
| KG-03 | `skills/kg-claim/SKILL.md` is missing. | RP-12 |
| BUS-01 | RPC records, LF framing, completion, and cancel behavior are wrong or incomplete. | RP-13 |
| BUS-02 | Child argv omits role tools and protocol/stderr handling. | RP-13 |
| BUS-03 | `expect`, contract wait, `agents_status`, and `agents_stop` are absent. | RP-13 |
| BUS-04 | Dual logs, PID liveness, Dune error propagation, and BUS/AGENTS state are absent. | RP-13 |
| BUS-05 | Original WP-21 reviewer migration is absent. | RP-14 |
| MIN-01 | Ladder shape and the one-concat/no-helper contract are unenforced. | RP-15 |
| KSTACK-01 | Generated runtime contains invalid names, branding, hard-coded models/paths, Cursor/cloud/worktree/Graphite semantics, dropped packs, and replacement corruption. | RP-16 |
| KSTACK-02 | Hand-written, generated, and hard-coded mode playbooks compete; runtime content is not uniformly Pi-loadable. | RP-16 |
| KSTACK-03 | Sync lacks semantic invariants, offline fixtures, patch/drift/no-op proof, and tree-aware provenance. | RP-17 |
| UI-01 | Footer lacks active slot kind, `(local) $0`, `kpi_job`, and documented presets. | RP-18 |
| UI-02 | Amber board lacks context lamps, current-stage lighting, and oversight fields. | RP-18 |
| UI-03 | Blue pause board lacks shared state, approval, three laws, and pending-question panels. | RP-18 |
| UI-04 | Research, BUS, AGENTS, route, usage, and K-stack state feeds are absent. | RP-18 |
| UI-05 | M-06 lacks a real under-800-character assistant reply fixture. | RP-18 |
| REL-01 | Requirement, metric, gap, and named-test ownership are not machine-auditable. | RP-19 |
| REL-02 | No single whole-product proof covers the repository gates, K-stack sync, upstream pin, distribution inventory, a clean start of the built `kpi` binary, fixtures, and M-01–M-07. | RP-19 |

## Explicit non-gaps

Do not create remediation work for:

- custom loading of manifest prompts, skills, or themes;
- a Cursor authorization-code callback server;
- cross-process worker caps;
- re-registering official Pi model catalogs;
- re-registering Pi's llama.cpp provider;
- advanced Exa or Perplexity products outside Search/Contents;
- worktree-per-job, auto-push, deployment, production migration, or Obsidian authority;
- an upstream pstack NOTICE file, because none exists;
- pixel-perfect board reproduction.

## Risk boundary

RP-00's three human decision gates, NH-01 through NH-03, are `CLOSED`: `korallis` recorded each decision on `2026-09-01`, so the selected options are authoritative and every listed dependent package is released. Vendor behavior that can vary remains isolated behind injected fetch/RPC fixtures and bounded failure contracts. Any newly discovered PRD/specification contradiction must add another explicit `NEEDS_HUMAN` gate and block its dependents until a human closes it; implementation must never resolve it by document precedence.
