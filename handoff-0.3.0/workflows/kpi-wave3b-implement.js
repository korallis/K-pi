export const meta = {
  name: 'kpi-wave3b-self-healing-driver',
  description: 'Wave 3b of the K-π operator fixes: the self-healing driver (gated-loop + control-plane detach/stop + tests) and the operator surface (board/status-line/graders/metric-runs + tests), in parallel on disjoint files, each verified and fixed once',
  phases: [
    { title: 'Probe', detail: 'which subagent model tier answers' },
    { title: 'Implement', detail: 'self-healing-driver and self-healing-surface in parallel' },
    { title: 'Verify', detail: 'adversarial verifier per package' },
    { title: 'Fix', detail: 'implementer fixes verified problems' },
  ],
}

const CONTRACTS = `
SHARED CONTRACTS FOR THE SELF-HEALING CHANGE (every package compiles against these; they OVERRIDE the design JSON where they differ)

C1 run-store.ts (owner self-healing-contracts): exports
  export const RUN_STATUSES = ["RUNNING", "NEEDS_HUMAN", "DONE", "STOPPED"] as const; export type RunStatus = (typeof RUN_STATUSES)[number];
  export const LOOP_RECOVERIES = ["approval","provider","delivery","ship","bounds","review","no_progress","research","stack","contract","ac_quality"] as const; export type LoopRecovery = (typeof LOOP_RECOVERIES)[number];
  export function runStatus(raw: unknown): RunStatus | undefined  // the four tokens map to themselves; legacy BLOCKED | EXHAUSTED | NO_PROGRESS | UNSAFE -> "NEEDS_HUMAN"; anything else undefined
  export function isFinishedRunStatus(status: unknown): boolean   // true for NEEDS_HUMAN, DONE, STOPPED and every legacy token (TERMINAL_RUN_STATUSES = NEEDS_HUMAN, DONE, STOPPED after runStatus()); false for RUNNING/undefined
  isLiveJob / readLiveJob semantics UNCHANGED: only RUNNING is live (PRD AC-24.3). NEEDS_HUMAN and STOPPED are finished-but-resumable. Task.limits deleted; validateBudgetOverrides calls deleted; the budget imports deleted.

C2 graph/stop.ts (owner self-healing-engine): exports
  DEFAULT_RETRY_BASE_MS = 1_000; RETRY_MAX_DELAY_MS = 60_000; MAX_AUTOMATIC_REPLANS = 2;
  retryDelayMs(spent: number, baseMs = DEFAULT_RETRY_BASE_MS): number = Math.min(RETRY_MAX_DELAY_MS, baseMs * 2 ** spent)  // no jitter
  type TransientReason = "http" | "timeout" | "transport" (unchanged); classifyTransientFailure: http status 408, 429 or 500-599 on the error or its cause -> "http"; timeout/transport as today; anything else undefined.
  interface PlanRepair { round: number; reason: string; failing_ac: string[]; evidence_ref: "verdict.json" | "evidence.json"; witness: string; guidance?: string }
  interface StopState { round: number; evidenceFingerprints: readonly string[]; outputFingerprints: readonly string[]; failingAcSets: readonly string[]; lastTestEvidence?: string; repaired: readonly string[]; repair?: PlanRepair }
    // repaired = witnesses that triggered an AUTOMATIC re-plan since the last operator touch (Give guidance / Keep going reset it to []); it may hold the same witness twice.
  interface VerifierEvent { type: "verifier"; source?: "review" | "test" (default "review"); passed: boolean; evidenceFingerprint: string; outputFingerprint?: string (required for review, absent for test); failingAcIds?: readonly string[] }
  createStopState(): StopState  // no argument
  repeatedWitness(state, event): string | undefined
    // review event: the canonical output fingerprint when it is already in outputFingerprints, else the failing-set key (failingAcSetKey) when already in failingAcSets, else undefined.
    // test event (source "test", passed false): "evidence:" + canonical evidence fingerprint when it equals state.lastTestEvidence (i.e. identical evidence in CONSECUTIVE failed test rounds), else undefined.
  recordVerifier(state, event): StopState  // round + 1 for every event it receives; review: dedup-add evidence fp, output fp, failing-set key and CLEAR lastTestEvidence; test (failed): dedup-add evidence fp and SET lastTestEvidence to it. The driver calls it for every review verdict and for every FAILED test round (a failed test round counts as a round); a passing test round is not recorded (its review round is).
  Deleted: DEFAULT_MAX_ROUNDS, MAX_TRANSIENT_RETRIES, TerminalStatus, StopStatus, StopState.status/maxRounds/retries/retryDelaysMs, RetryEvent, StopEvent, RetryPlan, planRetry, retryTransient, transitionStopState.
  Keep: Sleeper, canonicalFingerprint, stopFingerprint, failingAcSetKey.

C3 graph/schema.ts (owner self-healing-engine): GraphLimits = { maxConcurrency: number }; delete GraphBudgetLimits, GraphBudgetOverrides, BUDGET_LIMIT_NAMES, BudgetLimitName, GraphRoutedTerminal, GRAPH_ROUTED_TERMINALS, TerminalGraphNode, GraphTerminalState.
  PauseGraphNode { id: string; type: "pause"; recovery: LoopRecovery; reason: string; resume: string[] } (import type LoopRecovery from ../run-store.ts). GraphNode union: agent | set | human | pause.
  GraphRunStatus = "running" | "interrupted" | "completed" | "paused". GraphNodeRunStatus drops "exhausted". GraphNodeRunState keeps transientRetries/retryRun/retryDelaysMs and adds retryReason?: TransientReason, retryAtMs?: number.
  GraphPauseState { recovery: LoopRecovery; reason: string; round: number; superstep: number; nodes: string[]; resume: string[] }; GraphRunState.pause?: GraphPauseState replaces .terminal.

C4 graph/engine.ts (owner self-healing-engine):
  GraphEngineOptions: delete limits; add onRetry?: (retry: NodeRetry) => Promise<void> where NodeRetry = { nodeId: string; attempt: number; reason: TransientReason; status?: number; delayMs: number; message: string }; add stopRequested?: () => Promise<boolean>; add signal?: AbortSignal; emitTerminal?: (pause: GraphPauseState) => Promise<void> (default sink appends loop.terminal { status: "NEEDS_HUMAN", reason, recovery }).
  export class OperatorStopError extends Error (message "operator stop"). Export type NodeRetry.
  GraphAgentSession gains optional abort?(): Promise<void> | void (the core AgentSession already has abort(); test fakes may omit it).
  Retries: executeWithRetries is an unbounded loop. On a transient failure: spent = transientRetries ?? 0; delay = retryDelayMs(spent, retryBaseDelayMs); set transientRetries = spent + 1, retryReason, retryAtMs = now() + delay, push retryDelaysMs, record the error text; writeCheckpoint; await onRetry?.({...}); await abortable sleep(delay); then stop check; delete retryAtMs before the next attempt. A run resumed with nodeState.retryAtMs > now() sleeps the remainder first (same checks). A non-transient failure is never retried.
  Operator stop = "immediately": the backoff sleep races options.signal (abort resolves it at once); when signal.aborted the engine calls abort?.() on every in-flight session, and OperatorStopError is thrown (a) from the sleep, (b) right after a node attempt returns (before the result is committed) when signal.aborted, and (c) after any wait when await stopRequested?.() is true. OperatorStopError is thrown out of runSuperstep untouched (never converted by fail()); before throwing, the engine writes a checkpoint in which the interrupted node is still "running" with its transientRetries/retryAtMs intact so a restore re-arms and continues it. GraphNodeProviderError is also re-thrown untouched (the driver's provider path).
  pause(state: GraphPauseState): status "paused", active unchanged, superstep + 1, checkpoint, ONE emitTerminal(pause). fail(message, nodeIds, cause) marks the nodes failed with the error text and returns pause({ recovery: "contract", reason: message, round, superstep, nodes, resume: nodes }) instead of throwing. route(): a pause-node target wins exactly as a terminal target did and calls pause({ recovery: node.recovery, reason: node.reason, round, superstep, nodes: [node.id], resume: node.resume }). Delete the three cap checks in runSuperstep, exhaust(), rearmIfAffordable, TransientRetriesExhaustedError, get limits. validateLimits requires only maxConcurrency (a graph carrying maxSteps/maxCostUsd/timeoutMs/maxNodeRuns/maxRounds/maxTransientRetries is REJECTED by validateGraphDefinition); validateNode accepts type "pause" (recovery ∈ LOOP_RECOVERIES imported at runtime from ../run-store.ts, non-empty reason, resume = non-empty array of existing non-pause node ids).
  Constructor: budget.limits = { maxConcurrency: graph.limits.maxConcurrency }; readonly retiredLimits: string[] = keys of initialState.budget.limits other than maxConcurrency in checkpoint order (empty for a new run). On restore, when initialState.status is not running/interrupted/completed (paused, or legacy exhausted/failed/terminated) call this.rearm(). rearm() is public: status running, active = pause?.resume ?? active, every active node not "running" becomes "pending" (a node left "running" continues its own run and keeps transientRetries/retryAtMs), delete pause and any legacy terminal.
  countRound/readBudget unchanged: elapsedMs and costUsd stay report-only counters; nothing in the engine ends a run from a counter or a clock.

C5 append-log.ts + event.schema.json (owner self-healing-contracts): EVENT_TYPES gains "node.retry" appended at the END; EventInput gains Event<"node.retry", { attempt: number; reason: TransientReason; delay_ms: number; status?: number; message?: string }> (import type TransientReason from ./graph/stop.ts); loop.terminal becomes Event<"loop.terminal", { status: Exclude<RunStatus, "RUNNING">; reason?: string; recovery?: LoopRecovery }> (import types from ./run-store.ts). event.schema.json: loop.terminal status enum ["DONE","NEEDS_HUMAN","STOPPED"] plus optional recovery (enum = LOOP_RECOVERIES); new $defs.nodeRetry (base seven required + attempt integer >= 1, reason enum http|timeout|transport, delay_ms integer >= 0; optional status integer, message text; additionalProperties false) appended to the top-level oneOf. task.schema.json: delete taskLimits and the limits property.

C6 shipped graphs (owner self-healing-contracts): limits = { "maxConcurrency": 2 } (spec-first: 1). Pause nodes: unsafe { type "pause", recovery "bounds", reason unchanged, resume ["test"] }, needs-human { type "pause", recovery "review", reason unchanged, resume ["implement"] }, no-progress { type "pause", recovery "no_progress", reason "the loop repeated the same evidence or review outcome after its automatic re-plans", resume ["plan"] }.
  The review REVISE edge becomes four mutually exclusive edges, each carrying [bounds.held=true, review.approved=false, review.status=REVISE] plus: (a) progress.repeated=false -> implement; (b) progress.repeated=true, plan.repair_tried=false, plan.provided=false -> plan; (c) progress.repeated=true, plan.repair_tried=true -> no-progress; (d) progress.repeated=true, plan.repair_tried=false, plan.provided=true -> no-progress.
  The test-failure edge [bounds.held=true, test.passed=false] -> implement becomes the SAME four-way split (a)-(d) (owner decision: a failed test round counts as a round and identical evidence across consecutive failed test rounds is a witness). Every other edge unchanged.
  Release gate: the "human" node gains "feedbackPath": "release.feedback" and the "implement" node gains "feedbackPath": "release.feedback" (the engine injects it into the implement prompt as it does plan.feedback). The human -> implement (revise) and human -> __end__ (end) edges stay.
  Plan prompt (graph node prompt AND prompts/plan.md) gains: when repair.json exists in the run directory, read it first: the previous plan did not deliver; it names the round, the failing acceptance criteria, the verdict or evidence and any operator guidance; produce a materially different stack.json and plan that addresses them.

C7 facts merged before routing (driver, wave 3b): progress.repeated: boolean and plan.repair_tried: boolean. The driver calls facts.observe(stopState, state.active) before every runSuperstep; resolve() computes: if the observed active set includes "review" and verdict.json is readable -> witness = repeatedWitness(observedStop, { type: "verifier", source: "review", passed, evidenceFingerprint, outputFingerprint, failingAcIds }); else if it includes "test" and test.passed === false and evidence.json is readable -> witness = repeatedWitness(observedStop, { type: "verifier", source: "test", passed: false, evidenceFingerprint, failingAcIds }); else undefined. progress.repeated = witness !== undefined; plan.repair_tried = observedStop.repaired.length >= MAX_AUTOMATIC_REPLANS (two automatic re-plans per operator touch, then pause).

C8 state.json (driver): removed maxRounds, exhausted_limit, retries, retry_delays_ms; status ∈ RunStatus; recovery ∈ LoopRecovery on NEEDS_HUMAN; added repaired: string[], plan_repair?: PlanRepair, last_test_evidence?: string, retry?: { node; attempt; reason; delay_ms; until_ms }; limits = { maxConcurrency }; cost_usd, elapsed_ms, graph_round, batches stay report-only.

C9 operator stop marker: <run>/stop.json = { reason: "operator stop", at: ISO, recorded: boolean }. control-plane stopJob writes it; recorded=true means stopJob itself appended loop.terminal STOPPED and wrote state.json STOPPED (no in-process loop was live); recorded=false means an in-process loop was aborted and the DRIVER records the terminal (loop.terminal STOPPED reason "operator stop" + state.json STOPPED). The driver checks the marker before every superstep and catches OperatorStopError; on either it returns terminalStatus "STOPPED", reason "operator stop", terminalEmitted = marker.recorded === true. resumeLoop deletes stop.json first. STOPPED is resumable like any non-DONE status.

C10 board/footer vocabulary (wave 3b): ROUND n (no /max) in header and iteration rows; iteration region gains "RETRY <attempt> · <reason> · next <s>s" while state.retry is set; STOP box RUNNING | NEEDS_HUMAN <recovery> | DONE | STOPPED; Board B cells DONE / STOPPED / APPROVAL; footer "K-π LOOP <mode> r<n> STAGE … GATE …"; graders search "ROUND <n>" with a negative lookahead for a following digit or "/". BoardModel: delete maxRounds; add retry?: { node: string; attempt: number; reason: TransientReason; delayMs: number } and recovery?: LoopRecovery (control-plane buildBoardModel maps state.retry -> retry with delayMs = delay_ms, state.recovery -> recovery).

C11 Events: node.retry appended before every wait (attempt 1-based, reason, delay_ms, status?, message?); checkpoint reused with details "re-plan for witness <w>" and "retired caps ignored: <keys in checkpoint order>". Every new operator-facing line starts with "K-π ".
`

// ---- model-tier fallback (the Fable/Opus subagent tiers have been answering 529 for hours; Sonnet answers) ----
let MODEL_FALLBACK = null
const withModel = (opts) => (MODEL_FALLBACK && !opts.model) ? { ...opts, model: MODEL_FALLBACK } : opts
const robust = async (prompt, opts) => {
  let r = await agent(prompt, withModel(opts))
  if (r == null && !MODEL_FALLBACK) {
    MODEL_FALLBACK = 'sonnet'
    log(`${opts.label}: default tier unavailable (529) - falling back to sonnet for the rest of the run`)
    r = await agent(prompt, withModel({ ...opts, label: `${opts.label}:sonnet` }))
  } else if (r == null) {
    log(`${opts.label}: agent died - retrying once`)
    r = await agent(prompt, withModel({ ...opts, label: `${opts.label}:retry` }))
  }
  return r
}
async function probeTier() {
  phase('Probe')
  const r = await agent('Reply with exactly the single word: ok', { label: 'probe:default', phase: 'Probe', effort: 'low' })
  if (r == null) { MODEL_FALLBACK = 'sonnet'; log('default model tier is overloaded (529): every agent runs on sonnet') }
  else log('default model tier answers: agents run on the session model')
}

const LENSES = [
  { key: 'contract', brief: 'LENS: CONTRACT AND SCOPE. Refute that the change matches the shared contracts, the decisions and the design: every required export, field, edge, event and message present with the exact shape and text; nothing extra; no edit outside the owned files; no retired symbol alive; no shim, alias or deprecated re-export; hand-over complete (every hunk another owner needs is listed, every AC row and doc edit the docs wave needs is listed); bound test titles verbatim unless listed in titles_changed; every new operator-facing line starts with "K-π ".' },
  { key: 'behaviour', brief: 'LENS: BEHAVIOUR AND TESTS. Refute that the code behaves as required: run every owned test file; write scratch scripts under /private/tmp that import the real modules and drive the scenarios the contracts and decisions describe, comparing outcomes with the spec; read every new or changed test\'s assertions and judge whether it would fail if the behaviour were removed; look for silent catches, unbounded waits without a checkpoint, and error paths with no recorded reason.' },
]

function mergeVerdicts(pkgKey, vs) {
  const alive = vs.filter(Boolean)
  if (alive.length === 0) return { package: pkgKey, verdict: 'unverified', problems: [], tests: [] }
  return {
    package: pkgKey,
    verdict: alive.length === LENSES.length && alive.every(v => v.verdict === 'pass') ? 'pass' : 'fix-required',
    problems: alive.flatMap(v => (v.problems ?? []).map(p => ({ ...p, lens: v.lens }))),
    tests: alive.flatMap(v => v.tests ?? []),
  }
}

const REPO = '/Users/leebarry/K-pi'
const DESIGNS = '/Users/leebarry/.claude/projects/-Users-leebarry-K-pi/handoff-0.3.0/designs'

const RULES = `
You are implementing one package inside the K-π repository at ${REPO} on branch fix/operator-issues-0.3.0. Another engineer is editing OTHER files in the SAME working tree at the same time. Waves 1 and 2 already landed: the accounts official-slot change, the plan-approval gate (HumanAnswer/feedbackPath, submitHuman/resume take { approved, feedback? }), node.started/node.finished events, the bus sessions registry (/agents), the live board (board-activity.ts, board-overlay.ts, narration, NOW row, 1 s ticker in control-plane.ts) and /onboarding + Firecrawl. Read the CURRENT code first: the design's line numbers have shifted.

HARD RULES
- Edit ONLY the files listed under OWNED FILES. Creating a file not listed, or touching any other file, is a defect: if another file must change, do not change it — describe the exact hunk in your report under handover.hunks_for_other_owners.
- Never run git commands that change the tree or index: no commit, stash, checkout, reset, restore, clean, cherry-pick, rebase. Read-only git (status, diff, show, log) is fine.
- Never run \`npm run build\`, \`npm run build:offline\`, \`npm run check\`, \`npm run test:kpi\`, \`npm test\`, or scripts/generate-traceability-map.mjs. Allowed: \`node --test --experimental-strip-types test/<your files>\` (macOS has no timeout: wrap long runs as \`perl -e 'alarm 240; exec @ARGV' node --test ...\`), \`npx tsc --noEmit\` (act only on errors in your owned files; the other engineer's files may be mid-edit), \`npx biome check --error-on-warnings <your files>\` and \`npx biome format --write <your files>\` (tabs, double quotes).
- Reproduce before you fix: write or adapt the test first, run it and see it fail for the reason the design names, then implement, then see it pass. Record both runs in commands_run.
- Smallest correct change; no shims, aliases, or deprecated re-exports; migrate every caller inside your owned files; a caller outside them goes into handover as an exact hunk.
- Every failure mode gets a real path, a recorded reason and a bound; never a silent catch.
- No hard-coded official model ids. Every new operator-facing line starts with "K-π ". Never describe K-π as a Pi package.
- Existing test titles are bound in docs/traceability-map.json: keep them verbatim unless the design or the decisions explicitly rename or delete one (then list it under handover.titles_changed, as "old -> new" or "deleted: old").
- Docs (docs/*.md, README.md, AGENTS.md, fixes.md, docs/remediation-plan.md, scripts/generate-traceability-map.mjs, docs/traceability-map.json, test/traceability.test.ts) are written by a later wave by ONE agent: do not touch them; put the AC rows (id, test file, verbatim title, note) and doc edits (file, section, what) into handover.
- packages/coding-agent/dist is rebuilt by the lead after the wave; do not build and do not run test/harness.test.ts.
- The design is a JSON file you must read in full first (cat it). Its "change", "tests" and "event_or_data_contracts" arrays are the spec. Follow it unless the SHARED CONTRACTS or a DECISION below overrides it (they win) or you find, with evidence, that a cited line is wrong — then implement the intent and record the deviation.
- Finish the whole package. If something is blocked, finish everything else and say exactly what is left and why.

Return ONLY the structured object.`

const REPORT_SCHEMA = {
  type: 'object',
  required: ['package','files_changed','tests_added','commands_run','deviations','handover','known_gaps'],
  properties: {
    package: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests_added: { type: 'array', items: { type: 'object', required: ['file','title'], properties: { file:{type:'string'}, title:{type:'string'} } } },
    commands_run: { type: 'array', items: { type: 'object', required: ['cmd','exit','summary'], properties: { cmd:{type:'string'}, exit:{type:'integer'}, summary:{type:'string'} } } },
    deviations: { type: 'array', items: { type: 'string' } },
    handover: { type: 'object', required: ['ac_rows','doc_edits','event_types_added','titles_changed','hunks_for_other_owners'], properties: {
      ac_rows: { type: 'array', items: { type: 'object', required: ['id','file','title','note'], properties: { id:{type:'string'}, file:{type:'string'}, title:{type:'string'}, note:{type:'string'} } } },
      doc_edits: { type: 'array', items: { type: 'object', required: ['file','section','what'], properties: { file:{type:'string'}, section:{type:'string'}, what:{type:'string'} } } },
      event_types_added: { type: 'array', items: { type: 'string' } },
      titles_changed: { type: 'array', items: { type: 'string' } },
      hunks_for_other_owners: { type: 'array', items: { type: 'object', required: ['file','owner','hunk'], properties: { file:{type:'string'}, owner:{type:'string'}, hunk:{type:'string'} } } },
    } },
    known_gaps: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['package','verdict','problems','tests'],
  properties: {
    package: { type: 'string' },
    verdict: { type: 'string', enum: ['pass','fix-required'] },
    problems: { type: 'array', items: { type: 'object', required: ['severity','file','claim','evidence','fix'], properties: { severity:{type:'string', enum:['major','minor']}, file:{type:'string'}, claim:{type:'string'}, evidence:{type:'string'}, fix:{type:'string'} } } },
    tests: { type: 'array', items: { type: 'object', required: ['cmd','exit','summary'], properties: { cmd:{type:'string'}, exit:{type:'integer'}, summary:{type:'string'} } } },
  },
}


const implPrompt = (p, extra = '') => `${RULES}

PACKAGE: ${p.key}
DESIGN FILE (read it in full first): ${DESIGNS}/design-self-healing.json
INTEGRATION PLAN (shared_contracts from earlier waves): ${DESIGNS}/plan.json

${CONTRACTS}

OWNED FILES (the only files you may create, edit, or delete):
${p.owned.map(f => `- ${f}`).join('\n')}

DECISIONS THAT OVERRIDE THE DESIGN WHERE THEY DIFFER:
${p.decisions}
${typeof WAVE3A === "string" ? WAVE3A : ""}
${extra}
When done: run \`npx biome check --error-on-warnings\` on your owned source and test files, \`npx tsc --noEmit\` (report errors in your files only), and every scoped test file you own; include the exact commands with exit codes. List every file you changed (git status --short filtered to your files).`

const verifyPrompt = (d, checks, lens) => `${lens.brief}

You are an adversarial verifier for the package "${d.pkg.key}" in ${REPO} (branch fix/operator-issues-0.3.0). Another package was edited in the same tree at the same time; judge ONLY the owned files below, but you MAY read any file. You may edit nothing and run no git command that changes the tree.

1. Read the design ${DESIGNS}/design-self-healing.json (its change/tests/contracts arrays), then the SHARED CONTRACTS and DECISIONS below (they override the design). 2. Read the implementer's report (below). 3. Run \`git diff -- <owned files>\` and \`git status --short\` and read every changed owned file in full. 4. Run each owned test file with \`perl -e 'alarm 300; exec @ARGV' node --test --experimental-strip-types <file>\` and \`npx biome check --error-on-warnings <owned source/test files>\` and \`npx tsc --noEmit\` (errors in owned files only); record exact exit codes. 5. Try hard to refute: does the change do what the contracts, decisions and design require (not more, not less)? Does any edit land outside the owned files? Any silent catch, shim, alias, hard-coded model id, missing "K-π " prefix, renamed bound test title not listed in titles_changed, docs edit, or a retired symbol (maxCostUsd, maxRounds, maxSteps, maxNodeRuns, timeoutMs caps, maxTransientRetries, EXHAUSTED, NO_PROGRESS, UNSAFE/BLOCKED as run statuses, transitionStopState, TerminalGraphNode, GraphBudgetOverrides) still alive in an owned file? Does every new test actually exercise the behaviour it names (read the assertions)? ${checks}
Verdict "pass" only when there is no major problem and every owned test passes (except tests the decisions explicitly mark as expected to fail until the next wave — list those under tests with their exit code and say why). Return ONLY the structured object.

${CONTRACTS}

OWNED FILES:
${d.pkg.owned.map(f => `- ${f}`).join('\n')}

DECISIONS:
${d.pkg.decisions}

IMPLEMENTER REPORT:
${JSON.stringify(d.report, null, 1)}`

async function implementVerifyFix(PACKAGES, verifyChecks) {
  await probeTier()
  phase('Implement')
  const reports = await parallel(PACKAGES.map(p => () =>
    robust(implPrompt(p), { label: `impl:${p.key}`, phase: 'Implement', schema: REPORT_SCHEMA, effort: 'high' })
      .then(r => ({ pkg: p, report: r }))
  ))
  const done = reports.filter(Boolean).filter(d => d.report)
  log(`${done.length}/${PACKAGES.length} implementers reported`)

  phase('Verify')
  const verified = await parallel(done.map(d => () =>
    parallel(LENSES.map(lens => () =>
      robust(verifyPrompt(d, verifyChecks[d.pkg.key] ?? '', lens), { label: `verify:${d.pkg.key}:${lens.key}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
        .then(v => v == null ? null : { ...v, lens: lens.key })
    )).then(vs => ({ ...d, verdict: mergeVerdicts(d.pkg.key, vs) }))
  ))

  phase('Fix')
  const fixed = await parallel(verified.filter(Boolean).map(d => () => {
    const majors = (d.verdict?.problems ?? []).filter(p => p.severity === 'major')
    if (d.verdict?.verdict === 'unverified') { log(`${d.pkg.key}: both verifiers died - no fix pass; the lead reviews the diff`); return Promise.resolve({ ...d, fix: null }) }
    if (d.verdict?.verdict === 'pass' && majors.length === 0) return Promise.resolve({ ...d, fix: null })
    if ((d.verdict?.problems ?? []).length === 0) return Promise.resolve({ ...d, fix: null })
    return robust(implPrompt(d.pkg, `
YOU ARE THE FIX PASS. The package was implemented (report below) and an adversarial verifier found problems (below). Fix every major problem and the minors that are cheap, inside the OWNED FILES only, re-run the scoped tests, tsc and biome, and return an updated report of the same shape covering the WHOLE package (files_changed = all files changed by the package so far; handover = the complete hand-over, not only the delta).

PREVIOUS REPORT:
${JSON.stringify(d.report, null, 1)}

VERIFIER PROBLEMS:
${JSON.stringify(d.verdict, null, 1)}
`), { label: `fix:${d.pkg.key}`, phase: 'Fix', schema: REPORT_SCHEMA, effort: 'high' })
      .then(r => ({ ...d, fix: r }))
  }))
  return fixed.filter(Boolean).map(d => ({ package: d.pkg.key, report: d.fix ?? d.report, verdict: d.verdict, fixed: d.fix !== null }))
}

const WAVE3A = args && args.wave3aReports ? `
WAVE-3A REPORTS (the engine and contracts packages landed before you; their handover.hunks_for_other_owners addressed to your package MUST be applied; their known_gaps tell you what they left for you):
${JSON.stringify(args.wave3aReports, null, 1)}
` : ''

const PACKAGES = [
  {
    key: 'self-healing-driver',
    owned: [
      'packages/coding-agent/src/kpi/extensions/gated-loop.ts',
      'packages/coding-agent/src/kpi/extensions/control-plane.ts (the /kpi handler, stopJob, buildBoardModel retry/recovery mapping, LoopDependencies plumbing; NOT the widget/overlay/narration code board-live wrote unless a hunk requires it)',
      'test/gated-loop.test.ts',
      'test/autopilot.test.ts',
      'test/control-plane.test.ts',
      'test/research-control-plane.test.ts',
      'test/policy.test.ts',
      'test/milestone.test.ts',
      'test/resume.test.ts (add the resumeLoop fixture test 16 and the restoreStopState half of test 18; the engine-level tests are already there from 3a)',
    ],
    decisions: `
- Wave 3a landed the engine and the contracts (read the current stop.ts, schema.ts, engine.ts, run-store.ts, append-log.ts, graphs and test/fixtures/retired-cap-resume/). Implement design change items 12 (gated-loop.ts), 13 (control-plane.ts), 27 (the resume.test.ts remainder), 28 (autopilot.test.ts), 29 (gated-loop.test.ts), 32 (policy.test.ts), 33 (milestone.test.ts), 34 (research-control-plane.test.ts), 35 (control-plane.test.ts) with the SHARED CONTRACTS C1, C2, C4, C7, C8, C9 as the exact API. The design's tests 11-16, 21, 22 and 27 are yours.
- OWNER DECISIONS that override the design: (1) TWO automatic re-plans per operator touch: plan.repair_tried = observedStop.repaired.length >= MAX_AUTOMATIC_REPLANS; every automatic re-plan appends its witness to repaired; Give guidance / Keep going reset repaired to [] (repair stays, with guidance when given); Stop resets nothing. (2) A FAILED test round counts as a round and identical evidence fingerprints across consecutive failed test rounds are a witness: after runSuperstep, when completedNodes includes "test" and test.passed === false (and bounds held), call recordVerifier with { type: "verifier", source: "test", passed: false, evidenceFingerprint: await evidenceFingerprint(jobDirectory), failingAcIds: await failingAcIds(jobDirectory) }; the review branch keeps calling it with source "review". facts.observe(stopState, state.active) before every runSuperstep; resolve() computes progress.repeated / plan.repair_tried per C7. When the routed state.active includes "plan" and the witness repeated (automatic re-plan): repaired = [...repaired, witness]; repair = { round, reason: "no progress: " + (review repeated the same output | review repeated the same failing criteria | test evidence repeated), failing_ac, evidence_ref: "verdict.json" | "evidence.json", witness }; write <run>/repair.json (atomicWrite); rewrite task.json without current_module_id; append event checkpoint { detail: "re-plan for witness <w>" }; notify "K-π <job> re-planning: <reason>". (3) The stop is IMMEDIATE and the loop is DETACHED from the /kpi command handler — see below. (4) Gates: PLAN_GATE_OPTIONS = ["Approve plan", "Request changes", "Stop"] as const and RELEASE_GATE_OPTIONS = ["Approve release", "Request changes", "Stop"] as const; askGateWithFeedback takes the option list and is used for BOTH gates now that the release "human" node carries feedbackPath "release.feedback" (wave 3a graph change): Approve -> { approved: true }; Request changes -> editor (non-empty, ≤ MAX_HUMAN_FEEDBACK_CHARS) -> { approved: false, feedback } (the graph routes human -> implement under policy.onHumanDeny revise, and the engine injects release.feedback into the implement prompt); Stop -> the driver returns STOPPED with reason "stopped by the operator at <gate title> (resume with /kpi <job>)" leaving the gate pending (no marker needed; /kpi <job> asks again); a dismissed select is still NEEDS_HUMAN/approval "was dismissed". A human node WITHOUT feedbackPath keeps ctx.ui.confirm. (5) The design's item (8) "release denied with policy end -> STOPPED final" stays for graphs that declare onHumanDeny end (the shipped graphs use revise).
- DETACH (control-plane.ts): module-level live handle { jobId, controller: AbortController, done: Promise<void> }. handleKpiCommand for a goal or a job id: if a live handle exists -> ctx.ui.notify("K-π job <id> is still running: /kpi status shows it, /kpi stop stops it", "warning") and return. Otherwise create the controller, start the loop with { ...dependencies, onStateChange, signal: controller.signal } (LoopDependencies gains signal?: AbortSignal; runLoop/resumeLoop pass it to GraphEngine as signal and use it for their own waits), store the handle, attach .then(outcome -> the existing outcome notify + provider-recovery confirm).catch(error -> "K-π loop failed: <message>").finally(clear the handle if it is still this controller; await installWidget(ctx)), and RETURN WITHOUT AWAITING the loop (the interactive main loop awaits the handler, so returning is what frees /kpi status, /kpi stop, /agents and chat mid-run; the captured ctx stays valid — runner.ts marks ctx stale only on session replacement/reload). The loop keeps driving ctx.ui gates from the detached promise. Every rejection of the detached promise must be caught (no unhandled rejection): the .catch is mandatory.
- STOP (control-plane.ts stopJob + driver): per C9. stopJob: locate the job (live handle's jobId, else the live job on disk); write <run>/stop.json { reason: "operator stop", at, recorded } via atomicWrite BEFORE aborting; if a live handle exists: recorded=false, controller.abort(), await handle.done (the driver records loop.terminal STOPPED + state.json STOPPED), notify "K-π job <id> STOPPED (resume with /kpi <id>)"; else: recorded=true, append loop.terminal { status: "STOPPED", reason: "operator stop" }, write state.json STOPPED, same notify. Driver: before each superstep check the marker; catch OperatorStopError from runSuperstep (and from the gate/select awaits: when the signal aborts while a gate is open, treat it as Stop); return { terminalStatus: "STOPPED", reason: "operator stop", terminalEmitted: marker?.recorded === true }; writeTerminalState appends loop.terminal STOPPED only when terminalEmitted is false. resumeLoop deletes stop.json first. onRetry (both runLoop and resumeLoop): append node.retry { attempt, reason, delay_ms, status?, message? }, write state.json with the retry row, notify "K-π <job> retry <attempt> on <node>: <reason>; next in <s>s (/kpi stop stops it)", await onStateChange. stopRequested = () => marker exists.
- Every NEEDS_HUMAN carries exactly one recovery and its reason ends with the resume command via recoveryReason (extend its advice table for every LoopRecovery value). Driver returns: research shortfall -> NEEDS_HUMAN/research; stack refusals (implement precondition and the plan stack refusal) -> NEEDS_HUMAN/stack; branch switch failure -> NEEDS_HUMAN/ship; missing review fingerprint -> NEEDS_HUMAN/contract; engine pause -> NEEDS_HUMAN with state.pause.recovery (bounds reason = facts.boundsReason() ?? pause.reason); graph completed without release approval -> STOPPED "release denied by the operator (final: the graph completed)" when release.approved === false, else NEEDS_HUMAN/contract; ShipIntegrityError/unexpected ship failure -> NEEDS_HUMAN/ship; ac.refused -> NEEDS_HUMAN/ac_quality with recovery in the document; provider path unchanged (NEEDS_HUMAN/provider). Delete the exhausted branch, the NO_PROGRESS/EXHAUSTED reducer branch, LoopInvocation.limits, the budget flag loop and errors; add the retired-flag guard from design item 12(1). stateDocument per C8 (drop maxRounds/exhausted_limit/retries/retry_delays_ms; add repaired, plan_repair, last_test_evidence, retry, recovery; status = terminalStatus ?? (paused -> NEEDS_HUMAN, completed -> DONE, else RUNNING)); restoreStopState restores round, fingerprints, failing sets, lastTestEvidence, repaired, repair.
- settleNoProgress(ctx, engine, stopState, jobDirectory, task) when a drive result is NEEDS_HUMAN/no_progress and ctx.hasUI: ctx.ui.select("K-π: no progress after two re-plans", ["Give guidance","Keep going","Stop"]); Give guidance -> ctx.ui.editor("Guidance for the planner", repair.guidance ?? "") -> set repair.guidance, rewrite repair.json, repaired = [], engine.rearm(), drive again; Keep going -> repaired = [], engine.rearm(), drive again; Stop or dismissed -> STOPPED. Unattended (!ctx.hasUI): the NEEDS_HUMAN/no_progress result stands with the resume command; resumeLoop with recovery no_progress and ctx.hasUI runs settleNoProgress before driving.
- resumeLoop: after restore, if engine.retiredLimits or Object.keys(task.limits ?? {}) is non-empty append event checkpoint { detail: "retired caps ignored: <keys in checkpoint order>" } once and notify once; STOPPED resumes like any other non-DONE status; DONE returns early as today. The fixture test (design test 16) copies test/fixtures/retired-cap-resume/ into a temp repo per the contracts engineer's handover and asserts exactly what the design says (costUsd 7.691661999999999 preserved, active [implement] pending, the checkpoint detail in checkpoint key order, state.json RUNNING without exhausted_limit, the stub factory receives implement).
- New tests you must add beyond the design's list: control-plane.test.ts "a running job leaves /kpi status, /agents and chat free and refuses a second goal" (a factory whose prompt hangs until the signal aborts; the /kpi <goal> handler promise resolves before the loop ends; /kpi status renders; a second /kpi <goal> is refused with the K-π notice; /kpi stop aborts at once: the handler resolves, stop.json exists with recorded false, exactly one loop.terminal STOPPED, state.json STOPPED, readLiveJob undefined); gated-loop.test.ts "a failed test round counts as a round and identical evidence twice re-plans" (scripted test node failing twice with the same evidence.json content: round increments per failed test round; the routed active set is [plan]; repair.json evidence_ref "evidence.json") and "the release gate offers approve, request changes, and stop" (select receives exactly the three RELEASE_GATE_OPTIONS; Request changes writes approval.result with feedback and routes to implement whose prompt contains the feedback; Stop returns STOPPED with the gate still pending and a later resume asks again) and "two automatic re-plans then a pause, and an operator touch resets the allowance" (witness repeats three times: plan, plan, then NEEDS_HUMAN/no_progress; Keep going -> repaired [] and plan again).
- Existing bound titles kept verbatim unless design items 28/29/35 rename them (list every rename/deletion in titles_changed). Do not touch board.ts, board-*.ts, status-line, renderers.ts, scripts, engine/stop/schema/run-store/append-log, or any docs; hunks for those go into handover with owner "self-healing-surface" or "self-healing-engine".
- Hand over for the docs wave: AC rows for AC-05.1–05.9 (driver half), AC-04.6/29.4/30.2/24.3 observable text, the README §12 /kpi stop text, spec §4/§6/§7 lines, the M-04 row, and the /kpi command description string.`,
  },
  {
    key: 'self-healing-surface',
    owned: [
      'packages/coding-agent/src/kpi/extensions/board.ts',
      'packages/coding-agent/src/kpi/extensions/board-frame.ts',
      'packages/coding-agent/src/kpi/extensions/board-activity.ts',
      'packages/coding-agent/src/kpi/extensions/board-overlay.ts',
      'packages/coding-agent/src/kpi/extensions/renderers.ts',
      'packages/coding-agent/src/kpi/extensions/status-line/segments.ts',
      'packages/coding-agent/src/kpi/extensions/status-line/index.ts',
      'scripts/pty-rows/uat-06.mjs',
      'scripts/pty-rows/uat-15.mjs',
      'scripts/pty-rows/uat-16.mjs',
      'scripts/pty-rows/uat-25.mjs',
      'scripts/metric-runs.mjs',
      'test/operator-ui.test.ts',
      'test/status-line.test.ts',
      'test/board-activity.test.ts',
    ],
    decisions: `
- Wave 3a landed run-store.ts (RUN_STATUSES, RunStatus, LoopRecovery, runStatus) and stop.ts (TransientReason). Implement design change items 14 (board.ts), 15 (segments.ts), 16 (status-line/index.ts), 17-20 (pty rows), 21 (metric-runs.mjs), 37 (operator-ui.test.ts), 38 (status-line.test.ts) with SHARED CONTRACT C10 as the exact API. The design's tests 23 and 24 are yours.
- board.ts: StopDisplay = RunStatus; STOP_VOCABULARY from RUN_STATUSES; normalizeStop: APPROVAL/INTERRUPTED -> RUNNING, COMPLETED -> DONE, else runStatus(raw) ?? RUNNING; stopTone: NEEDS_HUMAN accent, STOPPED error, DONE success, RUNNING warning. BoardModel per C10 (delete maxRounds; add retry, recovery). iterationRegion "ROUND <n>" plus a "RETRY <attempt> · <reason> · next <s>s" row while retry is set; headerRegion "ROUND <n>"; stop box "STOP NEEDS_HUMAN <recovery>" when recovery is set; stopStatesRegion cells DONE / STOPPED / APPROVAL. The wave-2 live content (compact cells, NOW row, overlay, narration) stays; the overlay and narration adopt the new vocabulary (a node.retry event narrates one line "K-π ↻ <node> retry <attempt> · <reason> · next <s>s"; loop.terminal narrates "K-π ■ job <status> <recovery?>"). renderers.ts: render loop.terminal with the new statuses/recovery and node.retry rows; delete any EXHAUSTED/NO_PROGRESS/UNSAFE/BLOCKED tone mapping.
- control-plane.ts is the driver engineer's (in parallel): it maps state.retry -> BoardModel.retry and state.recovery -> BoardModel.recovery per C10 and drops maxRounds. If you need any other change there, hand it over as a hunk (owner "self-healing-driver").
- status-line: KpiJobFields drops maxRounds; formatKpiJob renders "r<round>"; index.ts deletes the maxRounds derivation and its equality check.
- pty rows: fixtures drop maxRounds; uat-16 header check uses "ROUND <n>" as the raw-bytes cell AND a new sibling check header-round-unbounded asserting new RegExp("ROUND " + RUNNING.round + "(?![\\\\d/])").test(text without \\r); uat-25 the same lookahead; uat-06/uat-15 fixtures only. Run each grader you changed: perl -e 'alarm 240; exec @ARGV' node scripts/pty-rows/uat-16.mjs etc. (they drive the built TUI — if dist is stale for the board because the lead has not rebuilt, say so; you must NOT run the build). metric-runs.mjs: the terminal regex and the M-04 checks per design item 21.
- Existing bound titles verbatim (REQUIRED_FIELDS "ROUND 2/3" -> "ROUND 2"; fixtures drop maxRounds; "formatKpiJob is the documented second line shape" keeps its title with the new expected string). Paint the compact widget and the full overlay at 200/120/80/60 columns with a scratch script (PLAIN_PALETTE) and check the RETRY row, STOP NEEDS_HUMAN <recovery> and ROUND n survive without any framed line exceeding the width.
- Do not touch gated-loop.ts, control-plane.ts, engine/stop/schema/run-store/append-log, or any docs. Hand over for the docs wave: AC rows for AC-02.7 (ROUND n), the board/footer visual-targets lines, README §9 board examples, fixes.md FX-05 facts, and the M-04 row wording.`,
  },
]

const VERIFY_CHECKS = {
  'self-healing-driver': 'Specifically: (i) prove the detach with a scratch test or script: register the control plane with a factory whose prompt() hangs until abort(); invoke the /kpi <goal> handler and confirm it resolves within a few ticks while the loop is still running; then invoke /kpi stop and confirm the handler resolves, stop.json has recorded false, exactly one loop.terminal STOPPED exists, state.json is STOPPED, and no unhandled rejection is emitted (listen for process "unhandledRejection"); (ii) prove the two-re-plans rule and the test-round witness with the gated-loop tests (read their assertions: round increments per failed test round, repair.json evidence_ref, repaired length, the third repeat pauses no_progress, Keep going resets repaired); (iii) prove the release gate select offers exactly ["Approve release","Request changes","Stop"] and that Request changes reaches the implement prompt; (iv) run the fixture resume test and confirm the "retired caps ignored" detail is in checkpoint key order; (v) grep gated-loop.ts and control-plane.ts for maxRounds|maxCostUsd|EXHAUSTED|NO_PROGRESS|"UNSAFE"|"BLOCKED"|transitionStopState|task.limits and confirm only the retired-flag error text and the legacy-status comments remain.',
  'self-healing-surface': 'Specifically: (i) paint the board at 200/120/80/60 columns with PLAIN_PALETTE from a scratch script for a RUNNING model with retry set, a NEEDS_HUMAN model with recovery bounds, and a STOPPED model, and confirm "ROUND 2" appears with no "/" after it, the RETRY row text, "STOP NEEDS_HUMAN bounds", "STOP STOPPED", the DONE/STOPPED/APPROVAL cells, and no framed line wider than the width; (ii) run the changed pty graders if dist is current (check `git diff --stat packages/coding-agent/dist` is empty and dist/kpi is newer than src; if the graders fail only because dist is stale for the board, say so explicitly and do not fail the verdict on that alone); (iii) grep board.ts, board-*.ts, renderers.ts, status-line/*.ts, scripts/pty-rows/*.mjs, scripts/metric-runs.mjs for maxRounds|EXHAUSTED|NO_PROGRESS|UNSAFE|BLOCKED and confirm nothing but legacy-status comments remain; (iv) confirm status-line.test.ts and operator-ui.test.ts bound titles are verbatim against docs/traceability-map.json (read-only).',
}

return await implementVerifyFix(PACKAGES, VERIFY_CHECKS)
