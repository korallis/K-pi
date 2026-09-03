# Changelog

K-π's own release history. Upstream Pi's changelog is kept beside this file as
`CHANGELOG.upstream.md` for merge history; the version this file is compared
against at startup is K-π's, so only K-π entries belong here.

## [0.3.0] - 2026-09-03

### Fixed

- **Claude Code version rejection** — subscription OAuth requests identify as `claude-cli/2.1.251` (upstream `96317e50b`); Anthropic's `claude_code_version_too_old` is explained once with the sent and required versions and `npm install -g @korallis/k-pi@latest`, never cooled or failed over.
- **One grant per slot** — a pool's official slot is served from `auth.json` and refreshed only by the runtime; `invalid_grant` marks the slot `needs login` and says so once with the exact `/accounts login <pool> <slot>`; no stack trace reaches a notification.

### Added

- **Self-healing loop** — no cost, time, step or round caps; transient failures retry without bound (1 s doubling to 60 s) with a checkpoint and a `node.retry` event before every wait; a repeated review output, failing-criteria set or identical test evidence re-plans with `repair.json`, twice per operator touch, then pauses `NEEDS_HUMAN` offering Give guidance / Keep going / Stop. Run states are `RUNNING | NEEDS_HUMAN | DONE | STOPPED`; `/kpi <job>` resumes anything but `DONE`.
- **Detached loop** — `/kpi status`, `/agents` and chat work while a job runs; `/kpi stop` is immediate and writes `stop.json`; a second `/kpi <goal>` is refused while a job runs.
- **Plan and release gates** — Approve plan / Request changes / Stop before implement, Approve / Request changes / Stop before ship; feedback reaches the next plan or implement prompt.
- **Live board** — stage cells carry elapsed, calls and cost, a NOW row names the running node and tool, a RETRY row shows the backoff, and one `K-π` line per node start, finish, retry, route change and gate narrates the run.
- **Command Centre** — `/kpi status` opens a live full-screen view: stages, the selected node's session tail, telemetry, run files, context layer, events, and an input line that routes `/kpi stop`, `/kpi verify` and chat.
- **`/agents`** — lists live in-process node sessions and worker processes with the mechanism sentence and the worker caps.
- **`/onboarding`** — guided first launch: pool logins, Exa / Perplexity / Firecrawl keys, K-stack roles; auto-runs only when no slot and no model exist.
- **Firecrawl** — third research service (`firecrawl_search`, `/accounts login firecrawl`, auto order exa → perplexity → firecrawl).

## [0.2.1] - 2026-09-03

- A job pushes only its own `kpi/<job>` branch and opens the pull request; the `auto-merge` workflow merges after the required check.

## [0.2.0] - 2026-09-03

- First release published by `release.yml` through npm trusted publishing; K-stack synced to pstack `7314f72`.

## [0.1.0] - 2026-09-02

- First published `@korallis/k-pi`: the standalone K-π harness forked from Pi `v0.84.4`.
