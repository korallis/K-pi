export const meta = {
  name: 'kpi-wave4-docs-traceability',
  description: 'Wave 4 of the K-π operator fixes: ONE docs+traceability agent folds every wave report hand-over into PRD/spec/uat/README/AGENTS/fixes/remediation-plan and the traceability generator, regenerates the map, then two adversarial verifiers and one fix pass',
  phases: [
    { title: 'Probe', detail: 'which subagent model tier answers' },
    { title: 'Implement', detail: 'one docs+traceability agent' },
    { title: 'Verify', detail: 'two adversarial verifiers (contract lens, behaviour lens)' },
    { title: 'Fix', detail: 'the docs agent fixes verified problems' },
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
DESIGN FILES AND REPORTS: named under DECISIONS (read them in full first)
INTEGRATION PLAN: ${DESIGNS}/plan.json

${CONTRACTS}

OWNED FILES (the only files you may create, edit, or delete):
${p.owned.map(f => `- ${f}`).join('\n')}

DECISIONS THAT OVERRIDE THE DESIGN WHERE THEY DIFFER:
${p.decisions}
${extra}
When done: run \`npx biome check --error-on-warnings\` on your owned source and test files, \`npx tsc --noEmit\` (report errors in your files only), and every scoped test file you own; include the exact commands with exit codes. List every file you changed (git status --short filtered to your files).`

const verifyPrompt = (d, checks, lens) => `${lens.brief}

You are an adversarial verifier for the package "${d.pkg.key}" in ${REPO} (branch fix/operator-issues-0.3.0). Another package was edited in the same tree at the same time; judge ONLY the owned files below, but you MAY read any file. You may edit nothing and run no git command that changes the tree.

1. Read every report and design file named under DECISIONS, then the SHARED CONTRACTS and DECISIONS below (they override the designs). 2. Read the implementer's report (below). 3. Run \`git diff -- <owned files>\` and \`git status --short\` and read every changed owned file in full. 4. Run each owned test file with \`perl -e 'alarm 300; exec @ARGV' node --test --experimental-strip-types <file>\` and \`npx biome check --error-on-warnings <owned source/test files>\` and \`npx tsc --noEmit\` (errors in owned files only); record exact exit codes. 5. Try hard to refute: does the change do what the contracts, decisions and design require (not more, not less)? Does any edit land outside the owned files? Any silent catch, shim, alias, hard-coded model id, missing "K-π " prefix, renamed bound test title not listed in titles_changed, docs edit, or a retired symbol (maxCostUsd, maxRounds, maxSteps, maxNodeRuns, timeoutMs caps, maxTransientRetries, EXHAUSTED, NO_PROGRESS, UNSAFE/BLOCKED as run statuses, transitionStopState, TerminalGraphNode, GraphBudgetOverrides) still alive in an owned file? Does every new test actually exercise the behaviour it names (read the assertions)? ${checks}
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

const REPORT_FILES = ['wave1-reports.json', 'wave2-reports.json', 'wave3a-reports.json', 'wave3b-reports.json'].map(f => `${DESIGNS}/${f}`)
const DESIGN_FILES = ['anthropic-auth', 'plan-gate', 'agents-visibility', 'board-live', 'onboarding', 'self-healing'].map(k => `${DESIGNS}/design-${k}.json`)

const PACKAGES = [
  {
    key: 'docs-traceability',
    owned: [
      'docs/PRD.md', 'docs/spec.md', 'docs/uat.md', 'docs/visual-targets.md', 'docs/agents-bus.md', 'docs/research.md', 'docs/kstack.md', 'docs/dune-architecture.md', 'docs/remediation-plan.md',
      'AGENTS.md', 'README.md', 'fixes.md', 'UPSTREAM.md (verify the cherry-pick row exists; edit only if missing)',
      'scripts/generate-traceability-map.mjs', 'docs/traceability-map.json (regenerated only, via node scripts/generate-traceability-map.mjs)', 'test/traceability.test.ts', 'test/docs-routing.test.ts (only if a docs change it binds requires it)',
    ],
    decisions: `
- You are the ONLY writer of docs in this batch. Inputs, all of which you must read in full first: the wave reports ${REPORT_FILES.join(', ')} (every report's handover: ac_rows, doc_edits, event_types_added, titles_changed; treat hunks_for_other_owners addressed to "docs+traceability"/"docs" as yours), and the "docs" arrays of ${DESIGN_FILES.join(', ')}. Where a report and a design disagree, the report (what actually landed) wins; where the OWNER DECISIONS below disagree with both, the decisions win. Verify every claim against the CURRENT code and tests (grep the exact test title in test/*.ts before you bind it).
- OWNER DECISIONS (normative): no USD cost cap at all (maxCostUsd, --max-cost-usd, --timeout-ms, --max-rounds, task.limits are gone; cost is reported "est." only); graphs never fail on their own (transient failures retry forever with 1 s doubling to a 60 s ceiling, checkpoint before every wait, node.retry event + one "K-π " line per retry, board RETRY row); repeated failures re-plan via repair.json (TWO automatic re-plans per operator touch, then pause NEEDS_HUMAN offering Give guidance / Keep going / Stop); a failed test round counts as a round and identical evidence fingerprints across consecutive failed test rounds are a witness; run vocabulary RUNNING | NEEDS_HUMAN | DONE | STOPPED, NEEDS_HUMAN/STOPPED resumable but not live (AC-24.3 stays), old runs on disk keep their finished status until resumed, loop.terminal keeps its name with a recovery field; the running loop is detached from the /kpi command handler so /kpi status, /kpi stop (AbortController, immediate, writes stop.json), /agents and chat work mid-run; both gates offer Approve / Request changes (feedback) / Stop; the official-slot NEEDS_HUMAN gate is answered YES — record NH-05 CLOSED with that answer (NH-03 already exists); onboarding = RP-20 / US-31; self-healing = RP-21; version 0.3.0 (do NOT bump package.json — the lead does; write the docs as 0.3.0); compact board stage cells carry "<elapsed> · <n> calls · $<cost> est.", a NOW row, chat narration per node, interactive /kpi status overlay, no keyboard shortcut; /onboarding with Firecrawl as the third research service (auto order exa → perplexity → firecrawl).
- Edit list (minimum; add what the reports require): docs/PRD.md (US-02 ACs 02.8–02.11, US-05 rewrite per the self-healing design docs[0] amended by the decisions above — AC-05.1–05.9, US-10 AC-10.2 amended + 10.9/10.10, US-23 AC-23.10/11, US-28 AC-28.8, new US-31, US-06/14/16/25 board ACs, AC-02.7 "ROUND n", AC-04.6/24.3/29.4/30.2 wording, M-04 row, traceability table US-05 -> RP-21, US-31 -> RP-20); docs/spec.md (§4 commands incl. /agents /onboarding and the removed budget flags, §5 research + SCH-event node.retry/node.started/node.finished + loop.terminal vocabulary, §6 stop states + recovery table + no caps + retry line, §7 graphs pause nodes + facts progress.repeated/plan.repair_tried + the four-way splits, §8 engine, §11 board/footer, §13 accounts official slot); docs/uat.md (UAT-02/04/05/06/10/16/23/28/30 + UAT-31 + M-04 row); docs/visual-targets.md; docs/agents-bus.md; docs/research.md (Firecrawl); docs/kstack.md; docs/dune-architecture.md; docs/remediation-plan.md (NH-05 CLOSED, RP-20 onboarding, RP-21 self-healing with Read first / Change / Tests / Verification / DoD, ordering line, execution rule L29 vocabulary, RP-03/RP-04 superseded prefixes); AGENTS.md (best-practice row on stopping conditions, product paragraph, US range US-01..US-31); README.md (§3 first launch → /onboarding, §5, §8 "No caps" replacing budget flags, §9 board incl. NOW row/RETRY row/STOP list/overlay, §12 commands incl. /agents /onboarding /kpi stop semantics, §13 state.json example, §14, §15 Firecrawl, §19 plan-approval block, §20 troubleshooting; recompute the \`/kpi verify\` record counts from a REAL run — see below); fixes.md (FX-05 board, FX-06 sessions, plus rows for the other landed fixes if fixes.md lists per-fix rows); UPSTREAM.md check; scripts/generate-traceability-map.mjs (every AC row from every report, EVENT_TYPES copy = the current append-log.ts EVENT_TYPES list, usOwner rows incl. US-31, the RP-20/RP-21 rows, the retitled/deleted titles); test/traceability.test.ts (EVENT_TYPES copy and the US-01..US-31 loop).
- Record counts for README: run a real gated job against the pty stub (scripts/pty-rows/lib.mjs exports startStub; read scripts/pty-rows/uat-06.mjs for how a screenplay drives the built TUI at ${REPO}/packages/coding-agent/dist/bundle/cli.js) in a scratch git repo under /private/tmp, let it reach the plan-approval gate or DONE, then \`grep -c\` the record types in that run's events.jsonl and quote the real numbers; if the stub cannot drive it to a full run, quote the numbers from the furthest point reached and say which point in the README sentence. Never run a job in ${REPO} itself.
- Commands allowed beyond the RULES: \`node scripts/generate-traceability-map.mjs\`, \`node --test --experimental-strip-types test/traceability.test.ts test/docs-routing.test.ts\`, \`npx biome check --error-on-warnings scripts/generate-traceability-map.mjs test/traceability.test.ts\`, the stub-driven run above. The lead runs the full gates after you.
- Every test title you bind must exist verbatim in the current test files (grep it); every AC id must appear in docs/PRD.md; every RP/NH id in docs/remediation-plan.md. docs/implementation-plan.md, docs/remediation-research.md and docs/roadmap.md are archives: do not touch them.`,
  },
]

const VERIFY_CHECKS = {
  'docs-traceability': 'Specifically: (i) run `node scripts/generate-traceability-map.mjs && git diff --stat docs/traceability-map.json && node --test --experimental-strip-types test/traceability.test.ts test/docs-routing.test.ts` and record exit codes; (ii) for EVERY ac_rows entry across all four report files, grep the bound title in test/ and confirm it exists verbatim and is bound in docs/traceability-map.json; (iii) grep docs/ README.md AGENTS.md fixes.md (excluding docs/implementation-plan.md, docs/remediation-research.md, docs/roadmap.md, docs/traceability-map.json) for maxCostUsd|max-cost-usd|maxRounds|EXHAUSTED|NO_PROGRESS|\\bUNSAFE\\b|\\bBLOCKED\\b|ROUND [0-9]+/|importOfficialCredentials|live-snapshot and confirm each remaining hit is a deliberate legacy/claim mention; (iv) confirm README §12 documents /agents, /onboarding, /kpi stop (immediate, stop.json, resumable) and /kpi status mid-run, §8 says no caps, §15 lists Firecrawl third; (v) confirm docs/remediation-plan.md has NH-05 CLOSED (yes), RP-20 onboarding, RP-21 self-healing; (vi) confirm the README record-count sentence quotes numbers the implementer measured (their commands_run must show the grep) — not copied from a design.',
}

return await implementVerifyFix(PACKAGES, VERIFY_CHECKS)
