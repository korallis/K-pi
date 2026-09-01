# Exa and Perplexity research in k-pi

**Normative.** Optional. Implement both integrations as first-party REST clients using the runtime `fetch`. Do not add `exa-js`, `@perplexity-ai/perplexity_ai`, a community Pi research package, or an MCP dependency at runtime.

| Service | Base | Auth | Secret key |
|---|---|---|---|
| Exa | `https://api.exa.ai` | `Authorization: Bearer` | `exa/default`; env fallback `EXA_API_KEY` |
| Perplexity | `https://api.perplexity.ai` | `Authorization: Bearer` | `perplexity/default`; env fallback `PERPLEXITY_API_KEY` |

Secrets live in `~/.pi/agent/accounts.secrets.json`, mode 0600.

Official references:

- Exa Search: https://exa.ai/docs/reference/search-api-guide-for-coding-agents
- Exa Contents: https://exa.ai/docs/reference/contents-api-guide-for-coding-agents
- Perplexity Search: https://docs.perplexity.ai/docs/search/quickstart

## Setup

`/setup-kstack`, after the model map, offers two independent prompts:

```
Exa API key for research (Enter to save, s to skip)
Perplexity API key for research (Enter to save, s to skip)
```

- Save either key → write that secret and set `kpi.research = auto`.
- Save both → Exa is preferred for developer/code research; Perplexity is the live fallback.
- Skip both → set `kpi.research = local`. Planning still runs the research gate on repo files.
- `/accounts login exa|perplexity` and `/accounts logout exa|perplexity` manage the same keys later.

No key is not a crash. It is a narrower research mode. Operators may set `kpi.research = exa|perplexity|auto|local`; a selected service without a key falls back through `auto`, then local.

## Tools

| Tool | Endpoint | Contract |
|---|---|---|
| `exa_search` | `POST https://api.exa.ai/search` | Natural-language web search. Default `type: "auto"`, `numResults: 5`, `contents.highlights: true`. |
| `exa_contents` | `POST https://api.exa.ai/contents` | Extract capped text or highlights for known URLs. At most 10 URLs. |
| `pplx_search` | `POST https://api.perplexity.ai/search` | Ranked web results with extracted snippets. Default `max_results: 5`, `search_context_size: "high"`. |

Return titles, URLs, dates, and bounded highlights/snippets. Do not dump full pages into model context. Write every call to `events.jsonl` as `research.*`; never log a key or authorization header.

Use native `fetch`; no provider SDK. These are research services, not model pools, and they do not call `registerProvider`.

## Planning default

Specify and plan must write `.pi/runs/<job>/research.md` and `research.json` before completing.

1. Search official docs and current API shapes with the configured service.
2. Search current engineering practice only when the task needs it.
3. Retrieve Exa contents only for the two or three URLs that materially affect the plan.
4. Record at least two cited external sources unless `no-network` is set.

`auto` uses Exa first, then Perplexity. A 402, 429, timeout, or unavailable service cools that service and tries the other configured service. If neither is usable, finish local research from repo files rather than hanging.

With no usable key, write the same files with `mode: "local"` and sources from repo `AGENTS.md`, existing code, and any frozen plan. The RESEARCH lamp still lights.

## Caps

- 20 external research calls per job unless the operator raises the cap.
- 10 results per search request.
- 10 URLs per Exa contents request.
- Full text is opt-in and capped at 15,000 characters per URL.
- Agent, deep-research, crawl, monitor, and background-run APIs are out of v1.
