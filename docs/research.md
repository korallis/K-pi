# Exa, Perplexity, and Firecrawl research in K-π

**Normative.** Optional. Implement all three integrations as first-party REST clients using the runtime `fetch`. Do not add `exa-js`, `@perplexity-ai/perplexity_ai`, a Firecrawl SDK, a community research package, or an MCP dependency at runtime.

Exa, Perplexity, and Firecrawl are **research credential targets**, never model pools. None is a `PoolId`. They never appear in `accounts.json.pools`, `/pool strategy`, `/pool chain`, or the cross-family fallback chain, and they never call `registerProvider`. `/accounts login exa|perplexity|firecrawl` stores a research credential; it never creates a routing slot and never changes which model answers a turn. These keys also grant no provider-native web search: every external research call is one of the four first-party REST tools below.

| Service | Base | Auth | Secret key |
|---|---|---|---|
| Exa | `https://api.exa.ai` | `Authorization: Bearer` | `exa/default`; env fallback `EXA_API_KEY` |
| Perplexity | `https://api.perplexity.ai` | `Authorization: Bearer` | `perplexity/default`; env fallback `PERPLEXITY_API_KEY` |
| Firecrawl | `https://api.firecrawl.dev` (`FIRECRAWL_BASE_URL` overrides) | `Authorization: Bearer` | `firecrawl/default`; env fallback `FIRECRAWL_API_KEY` |

Secrets live in `~/.kpi/agent/accounts.secrets.json`, mode 0600.

Official references:

- Exa Search: https://exa.ai/docs/reference/search-api-guide-for-coding-agents
- Exa Contents: https://exa.ai/docs/reference/contents-api-guide-for-coding-agents
- Perplexity Search: https://docs.perplexity.ai/docs/search/quickstart
- Firecrawl Search: https://docs.firecrawl.dev/api-reference/endpoint/search

## Setup

`/setup-kstack`, after the model map, offers three independent prompts:

```
Exa API key for research (Enter to save, s to skip)
Perplexity API key for research (Enter to save, s to skip)
Firecrawl API key for research (Enter to save, s to skip)
```

- Save any key → write that secret and set `kpi.research = auto`.
- Save several → `auto` asks Exa first, then Perplexity, then Firecrawl.
- Skip all → set `kpi.research = local`. Planning still runs the research gate on repo files.
- `/accounts login exa|perplexity|firecrawl` and `/accounts logout exa|perplexity|firecrawl` manage the same keys later.
- `/onboarding` asks the same three prompts through the same writer but never writes the project research mode; only `/setup-kstack` writes `.kpi/settings.json`.

No key is not a crash. It is a narrower research mode. Operators may set `kpi.research = exa|perplexity|firecrawl|auto|local`; a selected service without a key falls back through `auto`, then local.

## Tools

| Tool | Endpoint | Contract |
|---|---|---|
| `exa_search` | `POST https://api.exa.ai/search` | Natural-language web search. Default `type: "auto"`, `numResults: 5`, `contents.highlights: true`. |
| `exa_contents` | `POST https://api.exa.ai/contents` | Extract capped text or highlights for known URLs. At most 10 URLs. `text.maxCharacters` and `highlights.maxCharacters` are at most 10,000. |
| `pplx_search` | `POST https://api.perplexity.ai/search` | Ranked web results with extracted snippets. Default `max_results: 5`. Hard bounds are token-based: send `max_tokens` and/or `max_tokens_per_page` and omit `search_context_size`, which is qualitative and bounds nothing. |
| `firecrawl_search` | `POST https://api.firecrawl.dev/v2/search` | Web search with bounded excerpts. Body is `query` (≤ 500 characters), `limit` (1–10, default 5), `sources: [{type: "web"}]`, `timeout`; never `scrapeOptions`. Only http(s) results are kept; the excerpt is the result `description` (else its `markdown`), clamped to 10,000 characters. |

Return titles, URLs, dates, and bounded highlights/snippets. Do not dump full pages into model context. Write every call to `events.jsonl` as `research.*`; never log a key or authorization header.

Use native `fetch`; no provider SDK.

## Planning default

Specify and plan must write `.kpi/runs/<job>/research.md` and `research.json` before completing. `research.json` carries the mode, network state, and sources defined in `spec.md` §5 `SCH-research`.

1. Search official docs and current API shapes with the configured service.
2. Search current engineering practice only when the task needs it.
3. Retrieve Exa contents only for the two or three URLs that materially affect the plan.
4. Online success requires **at least two distinct external sources**: two different origins, not two paths on one host and not one URL twice. Canonicalize and deduplicate before counting.

`auto` uses Exa first, then Perplexity, then Firecrawl.

### When a service fails

A 429, timeout, abort, or unavailable service cools that service and tries the next configured service. k-pi also treats a 402 as a cooling failure; that is defensive handling on our side, not a documented Perplexity or Firecrawl response (Firecrawl documents 408 and 500). A Firecrawl 200 whose body carries `success: false` is classified `unavailable` and cools the service too. Classify on HTTP status and transport first — error envelopes vary, especially on 429.

Attempts per service are bounded. Every failure is recorded in `research.json.network.failures[]` and emitted as a redacted `research.*` event. The research gate never hangs and a research call never retries without a bound.

### Effective no-network

Online shortfall and provider exhaustion are different outcomes and must not be collapsed:

- **Shortfall is not exhaustion.** A healthy configured service that answers but still yields fewer than two distinct external sources ends the node `NEEDS_HUMAN`. It is never downgraded to local research.
- **Exhaustion is exhaustion.** Only after every configured service has failed its bounded attempts, with each failure recorded, may the engine set effective no-network: `network.state: "no-network"`, `network.origin: "engine"`, and a `network.reason` naming the exhausted services. An operator-flagged job carries the same state with `network.origin: "operator"`.
- Effective no-network is a research state. It is never a stop state and never written to a persisted stop-state field.

Under either origin of `no-network`, the two-external-source requirement is satisfied by the local contract below.

### Local research

With no usable key, or under either origin of `no-network`, write the same files with `mode: "local"`. The planning model researches the repository and any frozen plan using the ordinary read and search tools over `AGENTS.md`, existing code, `specs/`, and frozen plan files. There is no provider-native search in this mode.

Cite every local source as a repository-relative path (`path` or `path:line`) in the run's `research.md` and in `research.json.sources[]` with `kind: "local"`. Emitting an external URL that was not actually fetched in this job is a bounds violation, not a fallback. The RESEARCH lamp still lights.

## Caps

- 20 external research calls per job unless the operator raises the cap.
- 10 results per search request. `numResults` and `max_results` are maxima, not guarantees.
- 10 URLs per Exa contents request. HTTP 200 can still carry per-URL failures; inspect `statuses[]`.
- Full text is opt-in and capped at **10,000 characters** per URL. Bound it at request time (`text.maxCharacters`, `highlights.maxCharacters` ≤ 10,000) and clamp again before the text reaches the model, the run's `research.md`, `research.json`, or `events.jsonl`.
- Every Exa-derived model, event, and artifact field takes the 10,000-character cap or that field's narrower cap, whichever is smaller. Never persist a raw provider response, header, or authorization value.
- Agent, deep-research, crawl, monitor, and background-run APIs are out of v1.
