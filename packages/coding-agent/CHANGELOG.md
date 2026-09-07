# Changelog

K-π's own release history. Upstream Pi's changelog is kept beside this file as
`CHANGELOG.upstream.md` for merge history; the version this file is compared
against at startup is K-π's, so only K-π entries belong here.

## [0.4.0] - 2026-09-07

### Fixed

- SSH/Mosh subscription login preserves the complete OAuth URL in clickable links and adds Ctrl+Y clipboard transfer in pooled and native login prompts. Remote sessions no longer launch a server-side browser or write the server's desktop clipboard. Anthropic/Codex prompts explain how to paste the final callback URL when the browser runs on another machine.

### Changed

- Published as a normal GitHub release and on npm `latest`, replacing `0.3.0` for default installs. Includes the Cursor adapter and runtime changes described in `0.4.0-rc.1`.

The operator requested the normal release channel for testing. Live provider login and the wider RP-22 acceptance matrix remain open; normal release labeling does not establish their completion.

## [0.4.0-rc.1] - 2026-09-06

### Changed

- Protected, versioned intent is separate from mutable execution. Initial gated consent and candidate-bound release approval remain; routine planning and diagnosis-driven repair no longer require repeated plan approval or a fixed re-plan allowance.
- The runtime executes acceptance checks and quality commands independently, retaining immutable raw receipts bound to intent and candidate content. Model testimony and graph exhaustion cannot authorize DONE.
- Execution mutations retain audited topology and checkpointed branch progress. Persistent logical peers use authenticated direct/room communication, replay, and exact-session writer ownership.
- Protected graph inference receives fresh canonical context, scoped repository/feature maps, and capacity-aware serialization. Role routing records actual authenticated model choices and locally evidenced outcomes; unknown capabilities remain unknown.
- The Command Centre opens a grouped Jobs home with Now/Next/Done and labelled input. Machine work is cool, human intervention warm, and stage completion requires recorded activity.
- Local discovery retains source-attributed capacities and stable endpoint identities; missing metadata is unknown, not an invented context limit.
- Cursor subscription support uses first-party browser PKCE login/token renewal, dynamic CLI-protocol model discovery and HTTP/2 streaming. Native K-π tools, permission hooks and genuine result replay remain in control; no OMP runtime dependency or Cursor Cloud/subagent execution.
- Testing releases publish to npm's `next` channel and are marked GitHub prereleases without replacing stable `latest`.

### Fixed

- Independent host checks do not inherit Node's enclosing test-worker context, which could make nested test commands report success without running.
- Resource refusal refreshes the account display and clears a stale active route.
- Startup help identifies K-π and describes intent consent and runtime-owned verification rather than the retired plan/tester path.
- A provider response lost after commit cannot repeat the commit. A separate host delivery node reconciles the real remote ref and existing pull request, retrying only missing authorised actions with the engine's durable backoff.
- Delivery-record publication now stays inside the checkpointed host action. A redundant final PR lookup can no longer strand a delivered job on a transient error; lost records reconcile delivery without another commit.
- Acceptance-map regeneration exposes retired/conflicting checks and inventories every shipped JSON schema. Product proof refuses uncovered or empty inventories before gates/probes and replaces stale green reports with an explicit failure. Native built-in loading, not a source regex, now checks official catalog preservation.
- Schema validation enforces `uniqueItems`; duplicate arena proposal references no longer pass payload validation.
- Automatic retries and RUNNING status use cool machine emphasis. Genuine attended gates remain warm; interrupted repair, stale questions after resume, and completed/stopped runs cannot invent human-attention prompts.
- Missing reviewer publication returns to autonomous repair instead of being mistaken for a completed review; a valid unchanged ownership map no longer traps the planner in a validation loop.

This release candidate is for operator testing. Live Cursor seat eligibility/login/renewal/inference and the broader multi-provider, multi-account, greenfield and context-quality acceptance remain tracked by RP-22; offline protocol and package checks do not accept that live matrix.

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
