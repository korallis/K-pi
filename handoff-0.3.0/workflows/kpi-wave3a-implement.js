export const meta = {
  name: 'kpi-wave3a-self-healing-core',
  description: 'Wave 3a of the K-π operator fixes: the self-healing engine core (budget/schema/stop/engine + tests) and the contracts (run-store/append-log/schemas/graphs/prompts + tests + resume fixture), in parallel on disjoint files, each verified and fixed once',
  phases: [
    { title: 'Probe', detail: 'which subagent model tier answers' },
    { title: 'Implement', detail: 'self-healing-engine and self-healing-contracts in parallel' },
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

const PACKAGES = [
  {
    key: 'self-healing-engine',
    owned: [
      'packages/coding-agent/src/kpi/extensions/graph/budget.ts',
      'packages/coding-agent/src/kpi/extensions/graph/schema.ts',
      'packages/coding-agent/src/kpi/extensions/graph/stop.ts',
      'packages/coding-agent/src/kpi/extensions/graph/engine.ts',
      'test/stop.test.ts',
      'test/graph-engine.test.ts',
      'test/resume.test.ts (engine-level tests only: the resumeLoop-based fixture test is written by the wave-3b driver package)',
      'test/reviewer-session.test.ts',
      'test/graph-routing.test.ts',
    ],
    decisions: `
- Implement design change items 0 (budget.ts), 1 (schema.ts), 2 (stop.ts), 3 (engine.ts), 25 (stop.test.ts), 26 (graph-engine.test.ts), 27 (resume.test.ts: deletions, retitles and the engine-level tests 17, 18 [the GraphEngine.restore half; the restoreStopState half is 3b's], 19), 30 (graph-routing.test.ts) and 31 (reviewer-session.test.ts), with the SHARED CONTRACTS C2, C3, C4 as the exact API (they differ from the design in: MAX_AUTOMATIC_REPLANS, VerifierEvent.source/outputFingerprint optional, StopState.lastTestEvidence, the test-round witness in repeatedWitness/recordVerifier, PlanRepair.evidence_ref union, options.signal + GraphAgentSession.abort + the immediate-stop semantics, LOOP_RECOVERIES validation of pause.recovery).
- The design's tests array items 0-10 are yours (graph-engine and stop). Add to stop.test.ts: "identical evidence in consecutive failed test rounds is a repeated witness and a review round in between clears it" (test events with source "test": second identical evidence -> "evidence:<fp>"; a review event between two identical test evidences -> undefined; recordVerifier increments the round for a failed test event). Add to graph-engine.test.ts: "an aborted signal stops the engine at once and leaves the node resumable" (a session whose prompt never resolves until abort() is called; controller.abort() during the prompt -> runUntilPause rejects with OperatorStopError within the same tick chain, session.abort was called, the checkpoint has the node "running" with runs unchanged; GraphEngine.restore then runs the node again) and the design's test 5 (stopRequested after the backoff). For the abortable sleep: aborting during an injected sleep must reject the run with OperatorStopError without waiting for the sleeper.
- run-store.ts, append-log.ts, event.schema.json and the graph JSON files are the other engineer's (self-healing-contracts) and are being edited NOW: import LoopRecovery/LOOP_RECOVERIES from ../run-store.ts as the contract says even if the export is not there yet when you start; if tsc complains only because their file is mid-edit, note it and move on. The graph-routing shipped-graph shape test (design test 26, plus "a --plan job never routes to plan") reads their JSON: write it from contract C6, run it at the very end, and if it still fails only because their JSON has not landed, record that under known_gaps (the verifier re-runs it).
- Engine default emitTerminal sink appends loop.terminal { status: "NEEDS_HUMAN", reason, recovery } through appendEvent; until the contracts engineer widens the EventInput type this may be a type error in their file, not yours.
- Existing bound titles kept verbatim: "two transient failures retry twice with increasing delays and still finish", "a non-transient failure is never retried" (body: the run pauses with recovery contract), "a resumed run restores every stop, retry, cost, and time field", "every stop-safety field survives a state document round trip" (this one calls restoreStopState/writeState from gated-loop.ts, which 3b changes: keep the title, update the body to the new fields only as far as the current gated-loop.ts allows, and note the rest for 3b), "a changed failing acceptance set continues", the canonical fingerprint tests, "the transition path canonicalizes…" retargeted to recordVerifier. Every deleted title goes into titles_changed as "deleted: <title>".
- Do not touch gated-loop.ts, control-plane.ts, board*.ts, status-line, scripts, or any docs. Hunks those files need go into handover.hunks_for_other_owners with owner "self-healing-driver" or "self-healing-surface".
- Hand over for the docs wave: AC rows for AC-05.6, AC-05.7, AC-05.8 (engine half), RP-03/GRAPH-06 and GRAPH-04 title bindings, and the spec §8 engine paragraph.`,
  },
  {
    key: 'self-healing-contracts',
    owned: [
      'packages/coding-agent/src/kpi/extensions/run-store.ts',
      'packages/coding-agent/src/kpi/extensions/append-log.ts',
      'packages/coding-agent/src/kpi/schemas/event.schema.json',
      'packages/coding-agent/src/kpi/schemas/task.schema.json',
      'packages/coding-agent/src/kpi/graphs/coding-loop.gated.json',
      'packages/coding-agent/src/kpi/graphs/coding-loop.auto.json',
      'packages/coding-agent/src/kpi/graphs/spec-first.json',
      'packages/coding-agent/src/kpi/prompts/plan.md',
      'test/run-store.test.ts',
      'test/schema-conformance.test.ts',
      'test/fixtures/retired-cap-resume/ (create; the directory test/fixtures does not exist yet)',
    ],
    decisions: `
- Implement design change items 4, 5, 6 (graphs), 7 (plan.md), 8 (task.schema.json), 9 (event.schema.json), 10 (append-log.ts), 11 (run-store.ts), 24 (the fixture), 36 (run-store.test.ts) and 39 (schema-conformance.test.ts) with the SHARED CONTRACTS C1, C5, C6 as the exact API (they differ from the design in: LOOP_RECOVERIES const export, the four-way split of the test-failure edge, the release-gate feedbackPath on the "human" and "implement" nodes, the no-progress reason text, PlanRepair.evidence_ref allowing "evidence.json").
- Graph edges: the four REVISE edges from review and the four test-failure edges from test must be exactly mutually exclusive over progress.repeated × plan.repair_tried × plan.provided (route() unions every firing edge). The auto graph gets the identical treatment; its release.set path is unchanged. spec-first.json: limits -> { "maxConcurrency": 1 } only.
- The engine (other engineer, in parallel) validates pause nodes as { id, type: "pause", recovery ∈ LOOP_RECOVERIES, reason non-empty, resume non-empty array of existing non-pause node ids } and REJECTS any limits key other than maxConcurrency. Write the JSON to that contract; the engine's graph-routing test checks it after the wave.
- The design's tests 20 (run-store vocabulary) and 25 (schema-conformance: node.retry accepted, loop.terminal STOPPED and NEEDS_HUMAN+recovery accepted, EXHAUSTED rejected, a task with limits rejected) are yours. Existing bound titles verbatim; "the live job skips finished runs and is absent when every run has ended" keeps its title with the new body.
- Fixture test/fixtures/retired-cap-resume/: copy ${REPO}/.kpi/runs/20260903-fix-claude-model-requests-failin-42986cfa/ minus agents/ and context.md (task.json, state.json, baseline.json, previous-head.txt, events.jsonl, research.json, research.md, stack.json, graph/checkpoint-000001..4.json), scrub every absolute path (/Users/…) from every copied file to a relative or placeholder form WITHOUT changing the checkpoint's budget.limits key order or its costUsd 7.691661999999999; keep events.jsonl's hash chain valid (if scrubbing would break a record_hash, leave that record's text intact and say so in known_gaps; check with verifyChain from append-log.ts). Add a README.md line inside the fixture directory? NO — no docs; put a one-line comment file only if a JSON cannot carry it; otherwise none. The wave-3b driver writes the resumeLoop test that consumes it: describe in handover.hunks_for_other_owners (owner "self-healing-driver") which files the test must copy and the expected "retired caps ignored: maxSteps, maxNodeRuns, maxCostUsd, timeoutMs, maxRounds, maxTransientRetries" string in checkpoint key order.
- append-log.ts imports: type TransientReason from ./graph/stop.ts (exists today), type RunStatus and LoopRecovery from ./run-store.ts (yours). EVENT_TYPES order: existing 25 names then "node.retry" at the end; hand the final list to the docs wave (event_types_added and a doc_edits row for scripts/generate-traceability-map.mjs EVENT_TYPES copy and test/traceability.test.ts copy).
- Do not touch stop.ts, schema.ts, engine.ts, gated-loop.ts, control-plane.ts, board*.ts, status-line, scripts, or any docs. Hunks those files need go into handover.hunks_for_other_owners with owner "self-healing-engine", "self-healing-driver" or "self-healing-surface".
- Hand over for the docs wave: AC rows for AC-05.1 (run-store title) and the schema rows, spec §5 SCH-event lines, README §13 state.json/event list, and the RP-20/RP-21 numbering note (self-healing = RP-21 in docs/remediation-plan.md; onboarding took RP-20).`,
  },
]

const VERIFY_CHECKS = {
  'self-healing-engine': 'Specifically: (i) run `grep -nE "maxCostUsd|maxSteps|maxNodeRuns|timeoutMs|maxRounds|maxTransientRetries|exhaust|TransientRetriesExhaustedError|GraphTerminalState|TerminalGraphNode|rearmIfAffordable" packages/coding-agent/src/kpi/extensions/graph/*.ts` and confirm only the retiredLimits key filter and comments explaining the retirement remain; (ii) write a scratch script under /private/tmp that builds a GraphEngine with an injected sleeper and a factory failing 12 times with a 503 then succeeding, and confirm the delays are 1000,2000,4000,8000,16000,32000,60000,60000,… with a node.retry-style onRetry call before each wait and a checkpoint on disk carrying transientRetries/retryAtMs before each wait; (iii) abort the AbortController during a hanging prompt and during an injected sleep and confirm OperatorStopError surfaces at once in both cases and the checkpoint leaves the node running; (iv) confirm GraphEngine.restore on the real checkpoint ${REPO}/.kpi/runs/20260903-fix-claude-model-requests-failin-42986cfa/graph/checkpoint-000004.json (copy it) re-arms to running with active [implement] pending, retiredLimits in checkpoint key order, costUsd preserved; (v) confirm validateGraphDefinition rejects a graph with a maxCostUsd limit and accepts the three shipped graphs in packages/coding-agent/src/kpi/graphs (if the contracts package has not finished, say so).',
  'self-healing-contracts': 'Specifically: (i) validate all three shipped graphs with the engine\'s validateGraphDefinition (if the engine package has not finished its pause-node validation, validate by hand against contract C6 and say so); (ii) enumerate every combination of progress.repeated × plan.repair_tried × plan.provided for the review REVISE edges and the test-failure edges and prove exactly one edge fires per combination — do it with a scratch script that evaluates the edge conditions, not by reading; (iii) validate the fixture: every JSON parses, no /Users/ or other absolute path remains, verifyChain(events.jsonl) result recorded, checkpoint-000004.json budget.limits key order is maxSteps, maxNodeRuns, maxConcurrency, maxCostUsd, timeoutMs, maxRounds, maxTransientRetries and costUsd is 7.691661999999999; (iv) validate a node.retry payload, a loop.terminal STOPPED and a loop.terminal NEEDS_HUMAN+recovery against event.schema.json with the repo\'s validator and confirm EXHAUSTED is rejected; (v) confirm runStatus/isFinishedRunStatus/isLiveJob behave per C1 with a scratch script.',
}

return await implementVerifyFix(PACKAGES, VERIFY_CHECKS)
