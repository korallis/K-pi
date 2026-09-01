# k-pi remediation research

**Observed:** 2026-09-01  
**Tested Pi baseline:** `@earendil-works/pi-coding-agent@0.84.4`  
**Purpose:** Evidence, non-choice corrections, and open human decision gates for [`remediation-plan.md`](remediation-plan.md). This document does not authorize implementation order; the plan does.

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
- Scratch `pi install -l --approve` succeeded.
- Pi `0.84.4` loaded the extension, prompts, themes, footer, and `/kpi-ping`.
- The live Pi startup emitted invalid-skill diagnostics for generated `Poteto Mode` and `Make Bot UI` skill names.

These checks prove the current artifact is internally consistent enough to load. They do not prove the acceptance criteria below.

## Constraints not requiring a product decision

These constraints are compatible scope choices or corrections forced by primary installed/vendor API evidence. None selects between conflicting PRD and specification behavior.

| ID | Decision | Evidence |
|---|---|---|
| S-01 | Pi `0.84.4` is the baseline. k-pi enhances Pi; it does not rebuild Pi package loading, model catalogs, sessions, or RPC. | `AGENTS.md`; installed Pi package docs and declarations |
| S-02 | Manifest-listed prompts, skills, and themes need no custom loader. | Installed `docs/packages.md`; `dist/core/pi-manifest.js`; `dist/core/resource-loader.js` |
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

The following conflicts are intentionally unresolved. A recommendation is not authorization. RP-00 must stop at each open gate, obtain a human decision, record that decision in the normative documents, and only then allow dependent remediation work to begin. Document precedence must not choose an option.

| ID | Conflicting contracts | Human decision required | Recommended option | Blocks |
|---|---|---|---|---|
| NH-01 | AC-27.6 requires local slots to render `(local)` at `$0`, while `spec.md` restricts `Slot.kind` to `oauth | api_key`. | Decide whether local providers are represented as account slots and, if so, their schema kind. | Add `local` to `Slot.kind`; keep local slots credential-free and out of the default cloud chain. | RP-01, RP-08, RP-18 |
| NH-02 | AC-28.5 and `research.md` require local completion after all online providers fail, while AC-29.2 requires at least two external sources whenever a key exists unless the job is flagged `no-network`. | Decide who may set `no-network` after provider exhaustion and whether that fallback satisfies AC-29.2. | Let the engine set effective `no-network` only after bounded provider failures, with a recorded reason and failure events; otherwise end `NEEDS_HUMAN`. | RP-01, RP-09, RP-10, RP-18 |
| NH-03 | `agents-bus.md` denies reviewer/tester write tools but also requires the reviewer to write `verdict.json`. | Decide how a read-only reviewer may publish its run-contract result without gaining product-file mutation access. | Add a schema-validating `write_contract` capability restricted to the role's declared run-contract file. | RP-01, RP-13, RP-14, RP-18 |

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

Pi reads only `extensions`, `skills`, `prompts`, and `themes` from the `package.json` `pi` manifest. It also supports conventional directories when a manifest is absent. Manifest resources flow through Pi's default resource loader; k-pi needs no custom parsing or discovery layer.

Skill rules in Pi `0.84.4`:

- `name`: 1–64 characters; lowercase letters, digits, and hyphens; no leading, trailing, or consecutive hyphens.
- Missing or empty `description`: the skill does not load.
- Invalid names: diagnostic warning; Pi may still load the skill.
- Name collisions: diagnostic warning; first discovery wins.

An extension factory may be async and is awaited during startup. It must not start long-lived processes, watchers, sockets, or timers. Those resources belong in `session_start`, a command/tool call, or another consuming event, with idempotent cleanup on `session_shutdown`.

Primary installed sources:

- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/skills.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/pi-manifest.js`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js`

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
| DOC-02 | NH-01 through NH-03 capture the unresolved behavioral contract conflicts. RP-00 also owns compatible namespace clarifications plus primary-API and historical-trace corrections for research targets, Exa limits, response hooks, Dune execution state, and K-stack runtime source. | RP-00 |
| PKG-01 | No installed, packed, diagnostic-free resource proof; generated skill warnings ship. | RP-19 |
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
| REL-02 | No single installed-artifact proof covers gates, sync, payload, scratch Pi, fixtures, and M-01–M-07. | RP-19 |

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

RP-00 has three open human decisions: NH-01 through NH-03. Until those decisions are recorded, their recommendations are non-authoritative and every listed dependent package is blocked. Vendor behavior that can vary remains isolated behind injected fetch/RPC fixtures and bounded failure contracts. Any newly discovered PRD/specification contradiction must add another explicit `NEEDS_HUMAN` gate; implementation must never resolve it by document precedence.
