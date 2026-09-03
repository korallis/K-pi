export const meta = {
  name: 'kpi-six-issues-design',
  description: 'Design implementation-ready fixes for six K-π operator issues, critique each, and produce a file-ownership wave plan',
  phases: [
    { title: 'Design', detail: 'one designer per issue reads the code and returns a spec' },
    { title: 'Critique', detail: 'two lenses per design try to break it' },
    { title: 'Synthesize', detail: 'revise designs with critiques, build a file-ownership wave plan' },
  ],
}

const REPO = '/Users/leebarry/K-pi'

const COMMON = `
You are a senior engineer designing a fix inside the K-π repository at ${REPO} (a TypeScript monorepo, fork of Pi v0.84.4; K-π's own runtime is packages/coding-agent/src/kpi/). You are READ-ONLY in this phase: do not edit, create, or delete any file. Read code with cat/sed/grep/Read. Return ONLY the structured object requested.

Repository rules you must design within (from AGENTS.md):
- Reproduce before you fix; prove against the real artifact (built binary), not "it compiles".
- Smallest correct change. Prefer deletion and reuse over new structure. No shims, aliases, or deprecated re-exports; migrate every caller.
- Handle the failures the contracts name: each failure mode gets a real path, a recorded reason, and a bound. Silence is a defect.
- Update the owning product docs in the same change (docs/PRD.md stories US-xx with ACs, docs/spec.md, docs/uat.md, docs/visual-targets.md, docs/research.md, docs/agents-bus.md, README.md). New acceptance criteria get rows in scripts/generate-traceability-map.mjs and docs/traceability-map.json is regenerated (node scripts/generate-traceability-map.mjs), never hand-edited. Existing test titles bound in that map must survive verbatim.
- Tests live in root test/*.test.ts (node --test --experimental-strip-types), exercise observable behaviour, use injected clocks/fetches/launchers and temp HOME/repo roots; no cloud keys, no real sleeps.
- test/harness.test.ts compares src/kpi resource dirs (graphs, prompts, schemas, skills, templates, themes) byte-for-byte with dist/kpi, so resource edits need a rebuild of packages/coding-agent.
- Never hard-code official model ids. Never describe K-π as a Pi package. Config dir is .kpi/ (project) and ~/.kpi/agent/ (user).
- Gates: npm run check (biome, pinned deps, ts imports, tsc, browser smoke), npm run test:kpi, npm test, npm run verify:built.
- Upstream Pi changes normally come through the upstream remote as reviewed merges (UPSTREAM.md §6); a single narrow upstream fix may be cherry-picked when it is the smallest correct change, and UPSTREAM.md §6 "Patched upstream files" must record it.

Extension UI available to K-π code (packages/coding-agent/src/core/extensions/types.ts): ctx.ui.select(title, options), confirm(title, message), input(title, placeholder), editor(title, prefill), notify(msg, level), setStatus, setWidget (string[] or component factory), custom(component factory, {overlay, overlayOptions}) for a focused overlay with handleInput, onTerminalInput, ctx.hasUI / mode "tui". pi.registerCommand, pi.registerTool, pi.on(event) hooks, pi.sendUserMessage.

Return a JSON object with exactly these fields:
issue (string), root_cause (string: what is wrong and why, citing file:line), evidence (array of {file, line, note}), change (array of {file, action: "create"|"edit"|"delete", what: precise description of the edit, including function names and behaviour}), event_or_data_contracts (array of strings: any new event types, schema fields, settings keys, state paths, or exported functions other work will depend on, with exact names and shapes), tests (array of {file, title, asserts}), docs (array of {file, section, what}), verification (array of shell commands, in order), risks (array of strings), open_questions (array of strings: only decisions a human must make; otherwise empty), size ("S"|"M"|"L").
Be concrete enough that a different engineer could implement it without re-deriving anything. Cite real line numbers you verified.`

const DESIGN_SCHEMA = {
  type: 'object',
  required: ['issue','root_cause','evidence','change','event_or_data_contracts','tests','docs','verification','risks','open_questions','size'],
  properties: {
    issue: { type: 'string' },
    root_cause: { type: 'string' },
    evidence: { type: 'array', items: { type: 'object', required: ['file','line','note'], properties: { file: {type:'string'}, line: {type:'integer'}, note: {type:'string'} } } },
    change: { type: 'array', items: { type: 'object', required: ['file','action','what'], properties: { file: {type:'string'}, action: {type:'string', enum:['create','edit','delete']}, what: {type:'string'} } } },
    event_or_data_contracts: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'object', required: ['file','title','asserts'], properties: { file:{type:'string'}, title:{type:'string'}, asserts:{type:'string'} } } },
    docs: { type: 'array', items: { type: 'object', required: ['file','section','what'], properties: { file:{type:'string'}, section:{type:'string'}, what:{type:'string'} } } },
    verification: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    size: { type: 'string', enum: ['S','M','L'] },
  },
}

const ISSUES = [
  {
    key: 'anthropic-auth',
    prompt: `${COMMON}

ISSUE A (two operator-reported failures on the Anthropic OAuth path; design ONE coherent change for both):

A1. Every request to a Claude model through a K-π Anthropic OAuth slot fails: 400 {"type":"invalid_request_error","message":"Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required. Run 'claude update'...","details":{"error_code":"claude_code_version_too_old"}}.
Known facts: packages/ai/src/api/anthropic-messages.ts:77 has const claudeCodeVersion = "2.1.75" and line ~938 sends user-agent claude-cli/<version> with anthropic-beta claude-code-20250219,oauth-2025-04-20 for OAuth tokens. Upstream Pi fixed this in commit 96317e50b "fix(ai): bump claude code user agent version" (2.1.251) on the upstream remote (git show 96317e50b). The real Claude Code CLI installed on this machine reports 2.1.259 (\`claude --version\`), and npm view @anthropic-ai/claude-code version is 2.1.259. The operator's default model is claude-opus-4-8 (in ~/.kpi/agent/settings.json). Decide the exact version string to ship (justify), whether to cherry-pick the upstream commit or edit directly (check git show 96317e50b for what else it touches), whether an environment override (e.g. KPI_CLAUDE_CODE_VERSION / PI_CLAUDE_CODE_VERSION) is warranted so operators survive the next floor bump before a release, and how K-π should surface claude_code_version_too_old when it recurs: look at packages/coding-agent/src/kpi/extensions/accounts/errors.ts and the after_provider_response / assistant-error classification in accounts/index.ts (~L816-1000) to design a classification that (a) does NOT treat it as quota exhaustion/cooldown or failover fodder in a way that hides it, (b) tells the operator once, in plain words, which K-π version identifies as which Claude Code version, the floor the server demanded (parse it from the message), and the remedy (update @korallis/k-pi). Also check whether packages/ai has an existing test for the OAuth headers (grep -rn "claude-cli" packages/ai/test packages/ai/src) and what the test convention is there (vitest).

A2. Warning on every session start / turn: "Could not refresh anthropic/default: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; ... body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}; stack=Error: HTTP request failed..." followed by a full JS stack trace in the notification.
Known facts: K-π keeps its own copy of official credentials. accounts/store.ts:393 importOfficialCredentials copies ~/.kpi/agent/auth.json entries into ~/.kpi/agent/accounts.secrets.json as slot "default" ONLY when no default slot exists yet, and never again. accounts/index.ts:559 refreshExpiringCredentials refreshes each expiring OAuth slot with the provider's oauth.refresh and putSlot()s the result; it does not write back to auth.json, and on failure it marks the slot cooling and notifies with error.message which (from packages/ai/src/auth/oauth/anthropic.ts formatErrorDetails, L88-105) embeds the whole stack. On this machine auth.json's anthropic credential expires later (1788453002792) than the anthropic/default slot's (1788387252486): the two copies diverged. Anthropic rotates refresh tokens: after one copy refreshes (or after a fresh /login writes auth.json), the other copy's refresh token is dead → invalid_grant forever, and the slot is cooled instead of being told to re-login. The operator earlier asked for "/login anthropic to synchronize refreshed OAuth credentials into account routing", which never landed. Find: where the base harness refreshes/writes auth.json for OAuth providers (packages/coding-agent/src/core/auth-storage.ts, model-registry.ts, packages/ai/src/auth/*; grep for refresh, expires, oauth) and whether the base still refreshes even though K-π's before_provider_request hook (accounts/index.ts ~L800-850) overrides the authorization header; whether an extension event fires after /login (grep types.ts for auth events); how accounts/index.ts loginWithOfficialProvider (L198-245) writes both files. Design the single-source-of-truth or two-way-sync rule so the default slot and auth.json can never hold two different grants: e.g. reconcile on session_start and before refresh (adopt the credential with the later expires / different refresh token), write a K-π refresh back to auth.json for default slots, and on invalid_grant: re-check auth.json, else mark the slot as needing login (a persisted, visible slot state, not a cooldown) and notify ONCE per session with exactly: which slot, why, and the command /accounts login anthropic. The notification must never include a stack trace. Consider the two-slot case (a second anthropic slot "work" that is NOT mirrored to auth.json). Check test/accounts.test.ts, test/accounts-routing.test.ts, test/accounts-commands.test.ts for the harness/fixture patterns (injected fetch, temp agent dir) so the tests you specify fit.

Docs to check for this issue: docs/spec.md §13 Accounts and providers; docs/PRD.md US-10, US-12; README.md §5 Signing in (L181-315) and §20 Troubleshooting; docs/uat.md UAT-10.`,
  },
  {
    key: 'board-live',
    prompt: `${COMMON}

ISSUE B: "The graph boxes do not show anything and are not interactive; as a result the user has no idea what's going on." Screenshot of the live widget (120 cols) during a job: header "K-π GRAPH CONTROL │ MODE gated │ JOB 20260903-fix-... │ ROUND 0/3"; eight stage cells "01 ac-compile DONE", "02 specify CURRENT", "03 plan PENDING" ... "08 ship PENDING"; a FILES lamp row; "LOOP <job> STAGE 02 specify NODE specify GATE machine"; "ROUND 0/3 PASS/FAIL PENDING FINGERPRINT —"; "CONTEXT product ○ structure ○ tech ○ AGENTS 0 BUS ○ ROUTE openai-codex/gpt-5.6-sol"; and a "STOP RUNNING" box. Nothing in the chat pane changes for minutes while a node runs; the stage cells never show what the node is doing, how long it has run, what it cost, or what it produced; and nothing on the board can be selected or opened.

Design the change that makes the board informative and the /kpi status overlay interactive, within the existing architecture:
- Read packages/coding-agent/src/kpi/extensions/board.ts (BoardModel, regions, stage cells), board-frame.ts (painter: framePanel/frameCells/frameStrip, compact vs full layouts, width rules), board-component.ts, control-plane.ts (buildBoardModel, installWidget, showStatus overlay via ctx.ui.custom, how/when the widget refreshes — find the refresh trigger: timer? events? tool hooks?), run-store.ts (readLiveJob, state.json shape), append-log.ts (appendEvent, event types), graph/engine.ts (runSuperstep, how agent nodes run: sessions per node in .kpi/runs/<job>/agents/<node>/, cost accounting, tool.request events with node+tool name), gated-loop.ts (the loop that drives supersteps, L1300-1420 and L1880-2020), status-line/ (footer), docs/visual-targets.md §2 (the board contract and its Honesty section), docs/spec.md §11 UI, docs/PRD.md US-06, US-14, US-16, US-25, docs/uat.md UAT-06/16/25, fixes.md FX-01 (how the framed board was built; what pty graders in scripts/pty-rows/*.mjs assert, so nothing they search for moves).
- A real run's events.jsonl on disk for reference: .kpi/runs/20260903-fix-claude-model-requests-failin-42986cfa/events.jsonl (261 tool.request records with node and tool name, handoff.created, research.started/completed, loop.terminal — there is NO node.started/finished record, no per-node cost/elapsed, no model per node); its graph/checkpoint-00000N.json files show what the engine persists per node (runs, status, cost?). Read one checkpoint.
Specify:
1. Per-stage live content: what each stage cell shows in DONE / CURRENT / PENDING (e.g. elapsed, tool-call count, cost, last tool + target for CURRENT, model/route per node), the exact data source for each (existing state/checkpoints/events, or new events the engine must append — define exact event names and payloads, e.g. node.started {node, ts, model, session?}, node.finished {node, ts, elapsed_ms, cost_usd, tool_calls, status, summary?}, and how they are validated by schemas/event.schema.json and append-log.ts types), and the width rules so the framed board still fits at 200/120/80/60 columns and every pty-grader token stays inside one colour span.
2. Chat-pane narration so the operator is never silent for minutes: a compact notify or custom message on node start/finish/route change/failover/human gate (exact wording, at most one line each, no spam per tool call), and where it hooks (gated-loop.ts superstep loop vs engine callbacks).
3. Interactive /kpi status overlay: keys (←/→ or h/l select a stage, Enter/Space expand the selected node's detail panel: status, elapsed, cost, model, tool calls, last N events, its result file if any; t opens/prints the node transcript path or content; r refreshes; q/Esc closes), focus handling via ctx.ui.custom with handleInput, a live refresh while open (what triggers it), and how the compact widget hints at the overlay ("/kpi status · ↵ inspect").
4. Where per-node aggregation lives (a pure module, e.g. board-activity.ts, that folds events.jsonl + checkpoint into {node → activity}) so board.ts stays pure and testable.
Keep the FX-01 test titles listed in fixes.md verbatim; name new test titles. Keep AGENTS/BUS lamps as they are (another design owns the agents count). Size honestly.`,
  },
  {
    key: 'plan-gate',
    prompt: `${COMMON}

ISSUE C: "When the plan graph finishes the user should be notified and asked if they approve the plan or it needs updating, and everything needs to keep the user informed."
Today the gated graph packages/coding-agent/src/kpi/graphs/coding-loop.gated.json has exactly one human node ("human", title "Approve gated release") after review, before ship. The plan node returns stack.json (schema stack.schema.json, retries 2) and then plan-check runs and implement starts with no operator involvement. The engine (graph/engine.ts) supports human nodes only as a boolean: interrupt at L1281-1295 (pendingHuman {nodeId,title,question}), submitHuman(approved: boolean) at L1459 sets node.statePath to the boolean and routes on edges; gated-loop.ts answers a pending human with ctx.ui.confirm(pending.title, pending.question) at L1693 (resume path) and L1937 (first run) and records approval.result events. Edges/routing: read graph/engine.ts route(), edge conditions on state values, and the JSON graph edge syntax (look at coding-loop.gated.json edges and spec-first.json). Prompts: node prompts are strings in the graph JSON with {{job_id}} substitution — find the substitution function and whether state values can be interpolated; the plan node's system prompt lives in src/kpi/prompts/plan.md.

Design:
1. A plan-approval human gate: a new human node after plan (decide: after plan or after plan-check; justify) whose question carries a readable summary of the frozen plan (modules from stack.json: id, title/goal, boundaries, task count; where the summary is built — the engine's pendingHuman question is static text in the graph today, so define how the question gets the live summary: e.g. a question template with {{stack.summary}} rendered from state at interrupt time, or a gated-loop hook that renders the summary from stack.json before asking). The operator answers one of: Approve plan / Request changes (then ctx.ui.editor or input for feedback, required non-empty) / View full plan (prints stack.json readable, then asks again). "Request changes" must route back to the plan node with the feedback available to the model (define the state path, e.g. plan.feedback and plan.revision, how the plan prompt receives it, and the bound on revisions — e.g. maxRounds or a dedicated plan.max_revisions of 3 → NEEDS_HUMAN/BLOCKED with a recorded reason). The approval must be recorded (approval.result event with node, approved, feedback length or text?) and persisted so a resumed job does not re-ask (look at how release.approved is restored: gated-loop.ts L472-540, restoreStopState).
2. Engine API changes needed: submitHuman(approved, answer?) or a richer HumanAnswer {approved, feedback?}; how a human node declares a feedback state path in the graph schema (schema.ts validation at L218-222) and how edges condition on it. Keep the non-interactive-graph refusal (L412-418) intact. The autopilot graph coding-loop.auto.json must not gain a human node.
3. Notification: how the operator is told a gate is waiting (the board goes protocol-blue with WAITING ON OPERATOR today; add a ctx.ui.notify line and terminal bell? check if the TUI has a bell/attention API: grep packages/tui/src for bell, \\x07, and packages/coding-agent/src/modes/interactive for "notify"), and what happens in non-TUI (print/RPC) mode: the job must stop NEEDS_HUMAN with the resume command rather than hang or auto-approve (check gated-loop's existing print-mode handling of ctx.ui.confirm returning false/undefined).
4. "Keep the user informed" beyond the gate: coordinate with issue B (board narration) by ONLY specifying what this gate contributes: the approval.result payload and the plan-summary rendering function (a pure function in a small module, e.g. graph/plan-summary.ts) that issue B may also reuse.
Docs: docs/spec.md §6 Modes and stop states, §7 Graphs (node types, human node fields), §8 Graph engine; docs/PRD.md US-02 (gated), US-05, US-30 (Dune stack); docs/uat.md UAT-02; README §8 Running a job / Gated versus autopilot and §19 worked example; the tests test/graph-engine.test.ts, test/gated-loop.test.ts, test/resume.test.ts, test/graph-routing.test.ts, test/stack.test.ts for fixture patterns (fake sessions, fake UI with scripted confirm answers). Name new test titles and which existing titles must not change (check scripts/generate-traceability-map.mjs for bound titles in those files).`,
  },
  {
    key: 'agents-visibility',
    prompt: `${COMMON}

ISSUE D: "This uses K-π-to-K-π (pi-to-pi) communication instead of sub-agents, if I'm not mistaken, but there's no way to know that or how many sessions are currently active."
Facts: background workers are separate K-π processes launched by packages/coding-agent/src/kpi/extensions/bus/launch.ts (launchWorkerProcess spawns the CLI entry) and admitted by spawn.ts (MAX_LIVE_WORKERS=2, MAX_LIVE_WRITERS=1, "In-process only: another K-π process is not counted"); leases.ts keeps a leases file with {agent_id, pid, at} records and liveness by process.kill(pid,0); communicate.ts registers the bus tools (spawn_background, communicate, agents_status, agents_stop per docs/agents-bus.md); bus/live-snapshot.ts exposes liveWorkerCount() from an in-process provider that the board reads (board.ts BoardModel.agents; control-plane.ts buildBoardModel), which showed AGENTS 0 during a running job because graph nodes run as in-process agent sessions (graph/engine.ts: isolated/thread contexts using a GraphAgentSessionFactory — confirm whether node sessions are in-process AgentSession objects or spawned processes; read engine.ts session creation ~L800-900 and gated-loop.ts's factory) and only reviewer/tester roles go through the bus (workerRole in the graph JSON). Where is the leases file (path) and which UAT artifact .kpi/uat/UAT-23/artifacts/run/leases.json shows its shape. Read docs/agents-bus.md fully and docs/PRD.md US-23, docs/spec.md §5 (run store bus rows) and §11.

Design an honest, always-visible picture of concurrency:
1. A model of "live sessions" for the operator: the main session, in-process graph node sessions (node id, context mode isolated/thread, model, started, tool calls so far), and out-of-process bus workers (agent_id, role, pid, alive?, started, node, job). Define the data sources (engine run state/checkpoint, events.jsonl, leases file with liveness, WorkerAdmission counts) and one pure aggregation function (e.g. bus/sessions-snapshot.ts) that reads them without starting anything and is cross-process where the data is on disk (leases), so a second K-π process sees the same count.
2. Board: AGENTS cell becomes e.g. "AGENTS 1 node · 0 workers" or "SESSIONS 2" — pick the wording that fits the 120/80-col cell rules and keeps the pty grader tokens (check scripts/pty-rows/uat-23.mjs and uat-06/16/25 for tokens containing AGENTS/BUS). Footer: whether to add a segment (status-line/segments.ts, docs/visual-targets.md §1 default footer is normative — say if it must change and what AC governs it).
3. A command: /kpi agents (or /agents; check name collisions with the agents_status tool and existing commands) that prints a table: kind (main/node/worker), id, role, model, pid, alive, elapsed, last activity, job; and a one-line explanation of the mechanism ("K-π runs graph nodes as in-process sessions and spawns reviewer/tester workers as separate kpi processes that talk over .kpi/runs/<job>/bus.jsonl; no sub-agent API is used"). Decide whether it belongs in control-plane.ts (which another design edits for the overlay) or in bus/communicate.ts — prefer a file no other design in this batch owns, and say which.
4. Stale leases: what the command shows for a lease whose pid is dead, and whether it offers cleanup (releaseDeadLeases exists in leases.ts).
Tests: test/bus.test.ts and test/operator-ui.test.ts / test/control-plane.test.ts patterns; name new titles. Docs: docs/agents-bus.md (§Board and a new §Visibility), docs/PRD.md US-23 AC, docs/spec.md §11, README §14 Background workers. Coordinate by naming the exact BoardModel field(s) you add so the board design can render them.`,
  },
  {
    key: 'onboarding',
    prompt: `${COMMON}

ISSUE E: "There's no onboarding when K-π is first installed or when a user invokes a /onboarding command. It should walk through model logins, setting up search providers if they wish (Exa / Firecrawl / Perplexity — they would need to add API keys to enable them), and it should set up the K-stack."
Facts: README §3 First launch (L94-153) describes today's manual first run; commands today: /login (base harness OAuth, writes ~/.kpi/agent/auth.json), /accounts login <pool> [slot] (accounts/index.ts L245-330: loginAccount, loginWithOfficialProvider via context.modelRegistry.login, loginResearchService for exa/perplexity), /setup-kstack (kstack/models.ts:305 registerKStackSetup: maps K-stack roles to live models from the ladder then calls research/setup.ts promptResearchSetup which asks for Exa and Perplexity keys and writes kpi.research mode), /pool, /k-mode, /kpi. Settings: ~/.kpi/agent/settings.json (settings.ts userSettingsPath; keys kpi.research, kpi.researchEndpoints, kpi.routing; the harness keeps unknown top-level keys; lastChangelogVersion exists there today). Research services: research/session.ts RESEARCH_SERVICES = ["exa","perplexity"], research/exa.ts and perplexity.ts clients, endpoints.ts base URLs/env names, gate.ts, docs/research.md (Setup, Tools, Planning default, Caps), settings.ts RESEARCH_MODES ["auto","exa","perplexity","local"], schemas/event.schema.json research enums, docs/PRD.md US-28/US-29, docs/spec.md §5 SCH-research and §13. Pools: accounts/store.ts PoolId list (anthropic, openai-codex, xai, zai, kimi-coding, cursor, local pools llama-cpp/ollama/lm-studio — verify names), local/providers.ts for local pool setup, README §5.

Design:
1. /onboarding command (decide the name; consider alias /setup; check collisions: grep registerCommand across src/kpi and the base harness's built-in commands in packages/coding-agent/src/modes/interactive for "login", "setup") implemented in a new packages/coding-agent/src/kpi/extensions/onboarding.ts, registered from extensions/index.ts. Steps, each skippable, each using ctx.ui.select/input/confirm and existing functions (NOT re-implementing login): (a) welcome: what K-π is in three lines, that jobs run a gated graph with a plan gate and a release gate, and that reviewer/tester workers are separate kpi processes; (b) model logins: for each cloud pool, "Log in now / Skip"; reuse the accounts login path — decide the exact reuse mechanism: export loginAccount/loginWithOfficialProvider from accounts/index.ts (name the export and signature; note accounts/index.ts is owned by another design in this batch, so specify the smallest export change), or drive it via pi.sendUserMessage("/accounts login anthropic") (check whether sendUserMessage runs slash commands and whether it can be awaited); prefer the direct function; (c) local pools optional (llama.cpp/Ollama/LM Studio base URL) if a one-call helper exists; (d) research providers: Exa, Perplexity, and NEW Firecrawl API keys, each optional, saved with saveResearchKeys; (e) K-stack: run the same logic as /setup-kstack (extract its handler body into an exported async function runKStackSetup(context) in kstack/models.ts so both call it); (f) default model/theme: only if a one-call API exists (pi.setModel? check), else skip; (g) write a marker so first-run auto-onboarding happens once: define where (e.g. kpi.onboarding = {completedAt, version} in ~/.kpi/agent/settings.json via the existing settings writer) and the trigger (session_start in interactive TUI mode when the marker is absent AND stdin is a TTY AND not print/RPC mode; must never block print mode or tests; check how registerControlPlane/registerStatusLine detect mode). Re-running /onboarding always works.
2. Firecrawl as a third research service: add "firecrawl" to RESEARCH_SERVICES, ResearchKeys, endpoints (DEFAULT_FIRECRAWL_BASE_URL https://api.firecrawl.dev, env FIRECRAWL_API_KEY / FIRECRAWL_BASE_URL), settings RESEARCH_MODES (add "firecrawl"), a client research/firecrawl.ts modelled on exa.ts (verify Firecrawl's current search API: POST /v1/search with Authorization: Bearer, body {query, limit, scrapeOptions?}; response {success, data:[{url,title,description,markdown?}]} — state what you assumed if you cannot fetch docs; use the same caps MAX_RESULTS_PER_REQUEST/MAX_FIELD_CHARACTERS, 10,000-char cap, timeout, failure classes http_402/429/5xx/timeout), its place in the auto order (exa → perplexity → firecrawl? justify), gate.ts changes, session.ts researchSecretName, event.schema.json enums (researchService, researchMode), the research tool descriptions in research/index.ts, and the /accounts login firecrawl path. Check test/research-clients.test.ts and test/research-control-plane.test.ts for the injected-fetch pattern.
3. Docs: README new "§3 First launch" rewrite around /onboarding + a §12 command row; docs/PRD.md: a new story (US-31 Onboarding) with ACs, and US-28 extended for Firecrawl; docs/spec.md §4 entry points/commands, §5 SCH-research, §13; docs/research.md Setup/Tools; docs/uat.md UAT-31 and UAT-28; scripts/generate-traceability-map.mjs rows for the new ACs.
Tests: test/onboarding.test.ts (fake UI with scripted answers, temp agent dir, asserts the marker, that skipped steps write nothing, that first-run trigger fires only in TUI mode without a marker), research tests for firecrawl. Name titles.`,
  },
]

phase('Design')
log('Designing fixes for the six reported issues (five designers; A covers the two auth errors)')
const designs = await parallel(ISSUES.map(i => () =>
  agent(i.prompt, { label: `design:${i.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })
    .then(d => ({ key: i.key, design: d }))
))
const okDesigns = designs.filter(Boolean)
log(`${okDesigns.length}/${ISSUES.length} designs returned`)

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['lens','verdict','problems','required_changes','file_conflicts_seen'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['sound','needs-revision','wrong'] },
    problems: { type: 'array', items: { type: 'object', required: ['severity','claim','evidence'], properties: { severity: {type:'string', enum:['major','minor']}, claim:{type:'string'}, evidence:{type:'string'} } } },
    required_changes: { type: 'array', items: { type: 'string' } },
    file_conflicts_seen: { type: 'array', items: { type: 'string' } },
  },
}

phase('Critique')
const LENSES = [
  { name: 'correctness', brief: 'Verify every cited file:line and every claimed API against the actual source at /Users/leebarry/K-pi. Does the change actually fix the reported symptom? Are the new event/state/schema contracts complete and consistent with existing validators (schemas/*.json, append-log.ts types, graph/schema.ts)? Would tests as specified actually fail before and pass after? Will the pty graders in scripts/pty-rows/*.mjs and test/traceability.test.ts still pass? Try hard to REFUTE the design; default to needs-revision if any cited line is wrong.' },
  { name: 'minimalism-and-contract', brief: 'Judge against AGENTS.md and docs/minimalist.md: is this the smallest correct change? Is any new module, setting, event, or command unjustified? Does it introduce shims, duplicate code paths, hard-coded model ids, or describe K-π as a Pi package? Does it update the owning docs and the traceability generator in the same change? Does it name a real path for every failure mode (no silent catch)? Does anything require a human product decision that the design silently made (then it belongs in open_questions)? Try hard to REFUTE the design.' },
]
const critiqued = await parallel(okDesigns.map(d => () =>
  parallel(LENSES.map(l => () =>
    agent(`You are an adversarial reviewer with the "${l.name}" lens. ${l.brief}\nYou are READ-ONLY. Return the structured object only.\n\nOTHER DESIGNS IN THIS BATCH (for file-ownership conflicts; list every file this design edits that another design also edits, under file_conflicts_seen):\n${okDesigns.filter(o => o.key !== d.key).map(o => `- ${o.key}: ${o.design.change.map(c => c.file).join(', ')}`).join('\n')}\n\nDESIGN UNDER REVIEW (${d.key}):\n${JSON.stringify(d.design, null, 1)}`,
      { label: `critique:${d.key}:${l.name}`, phase: 'Critique', schema: CRITIQUE_SCHEMA, effort: 'high' })
  )).then(cs => ({ ...d, critiques: cs.filter(Boolean) }))
))

phase('Synthesize')
const revised = await parallel(critiqued.filter(Boolean).map(d => () =>
  agent(`${COMMON}\n\nYou are revising the design "${d.key}" using two adversarial critiques. Re-verify against the source anything a critique disputes (READ-ONLY). Produce the final design object: fix every major problem, address minors where cheap, keep the shape identical, and add a field-free note inside risks[] for any critique point you rejected and why (prefix "rejected:").\n\nORIGINAL DESIGN:\n${JSON.stringify(d.design, null, 1)}\n\nCRITIQUES:\n${JSON.stringify(d.critiques, null, 1)}`,
    { label: `revise:${d.key}`, phase: 'Synthesize', schema: DESIGN_SCHEMA, effort: 'high' })
    .then(r => ({ key: d.key, design: r, critiques: d.critiques }))
))

const PLAN_SCHEMA = {
  type: 'object',
  required: ['shared_contracts','ownership','waves','conflicts_unresolved','version_bump'],
  properties: {
    shared_contracts: { type: 'array', items: { type: 'string' } },
    ownership: { type: 'array', items: { type: 'object', required: ['file','owner','also_touched_by','resolution'], properties: { file:{type:'string'}, owner:{type:'string'}, also_touched_by:{type:'array', items:{type:'string'}}, resolution:{type:'string'} } } },
    waves: { type: 'array', items: { type: 'object', required: ['wave','packages','why_parallel_safe'], properties: { wave:{type:'integer'}, packages:{type:'array', items:{type:'string'}}, why_parallel_safe:{type:'string'} } } },
    conflicts_unresolved: { type: 'array', items: { type: 'string' } },
    version_bump: { type: 'string' },
  },
}
const plan = await agent(`You are the integration lead for five revised designs that will be implemented by separate agents, one writer per file, in the repository /Users/leebarry/K-pi (READ-ONLY for you). Build the execution plan:\n- shared_contracts: every event type, schema field, state path, settings key, BoardModel field, exported function that two designs both depend on, with the single exact definition both must use (resolve any naming disagreement now).\n- ownership: for EVERY file edited or created by any design, one owner package (design key) and the list of other designs that wanted it, with a resolution (e.g. "board-live owns control-plane.ts; agents-visibility passes its /kpi agents handler as an exported function from bus/agents-command.ts that board-live wires in one line", or "sequential: X after Y").\n- waves: an ordering where every package in a wave touches disjoint files; minimise the number of waves; explain why each wave is parallel-safe. Docs files (docs/PRD.md, docs/spec.md, docs/uat.md, README.md, scripts/generate-traceability-map.mjs, docs/traceability-map.json) are shared by everyone: assign them to a final "docs+traceability" wave executed by ONE agent after all code waves, and say what each package must hand over (its AC text and test titles) so that agent can write the rows.\n- version_bump: recommend the next @korallis/k-pi version (current 0.2.1; semver: new commands/features present?) and why.\n\nREVISED DESIGNS:\n${JSON.stringify(revised.filter(Boolean).map(r => ({ key: r.key, design: r.design })), null, 1)}`,
  { label: 'integration-plan', phase: 'Synthesize', schema: PLAN_SCHEMA, effort: 'high' })

return { designs: revised.filter(Boolean), plan }