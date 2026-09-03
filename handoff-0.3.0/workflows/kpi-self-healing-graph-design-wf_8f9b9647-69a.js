export const meta = {
  name: 'kpi-self-healing-graph-design',
  description: 'Design the self-healing stop model: no caps, retries and re-planning instead of terminal failures, the operator is the only stop',
  phases: [
    { title: 'Design' },
    { title: 'Critique' },
    { title: 'Revise' },
  ],
}

const REPO = '/Users/leebarry/K-pi'

const COMMON = `
You are a senior engineer designing a change inside the K-π repository at ${REPO} (a TypeScript monorepo, fork of Pi v0.84.4; K-π's own runtime is packages/coding-agent/src/kpi/). You are READ-ONLY in this phase: do not edit, create, or delete any file. Read code with cat/sed/grep/Read. Return ONLY the structured object requested.

Repository rules you must design within (from AGENTS.md):
- Reproduce before you fix; prove against the real artifact (built binary), not "it compiles".
- Smallest correct change. Prefer deletion and reuse over new structure. No shims, aliases, or deprecated re-exports; migrate every caller.
- Handle the failures the contracts name: each failure mode gets a real path, a recorded reason, and a bound. Silence is a defect. (Here the product owner has redefined the bound for failures: the operator, not a counter.)
- Update the owning product docs in the same change (docs/PRD.md stories US-xx with ACs, docs/spec.md, docs/uat.md, docs/visual-targets.md, README.md, AGENTS.md where it states the old principle). New acceptance criteria get rows in scripts/generate-traceability-map.mjs and docs/traceability-map.json is regenerated (node scripts/generate-traceability-map.mjs), never hand-edited. Existing test titles bound in that map must survive verbatim unless the behaviour they pin is being removed, in which case list the title and the generator row to delete.
- Tests live in root test/*.test.ts (node --test --experimental-strip-types), exercise observable behaviour, use injected clocks/sleepers/fetches and temp repo roots; no real sleeps.
- test/harness.test.ts compares src/kpi resource dirs byte-for-byte with dist/kpi, so graph/schema/template edits need a rebuild of packages/coding-agent.
- Never hard-code official model ids.

Extension UI available (packages/coding-agent/src/core/extensions/types.ts): ctx.ui.select, confirm, input, editor, notify, setStatus, setWidget, custom overlays; ctx.hasUI / mode "tui" vs print/RPC.

Return a JSON object with exactly these fields:
issue (string), root_cause (string, citing file:line), evidence (array of {file, line, note}), change (array of {file, action: "create"|"edit"|"delete", what}), event_or_data_contracts (array of strings: new/changed event types, schema fields, settings keys, state paths, status vocabularies, exported functions, with exact names and shapes), tests (array of {file, title, asserts}), docs (array of {file, section, what}), verification (array of shell commands), risks (array of strings), open_questions (array of strings), size ("S"|"M"|"L").
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

const PROMPT = `${COMMON}

ISSUE F (product-owner decision, recorded 2026-09-03; treat as normative, it overrides PRD US-05 / spec §6 where they conflict, and the docs must be amended to match):
The operator's gated job ended "EXHAUSTED: graph exhausted maxCostUsd 5 at 7.69". The owner's words: "graphs should never fail"; "there shouldn't be a cap at all — the system's designed around using your subscriptions"; "if it hits a timeout it shouldn't stop, it should retry. The point of graphs is they are self-repairing and self-healing to ensure the user's intent is delivered."

Design the self-healing stop model with these rules:
R1. No spend cap. Delete maxCostUsd entirely: the limit in graph/budget.ts (OVERRIDABLE_LIMITS, PERSISTED_LIMIT_NAMES, findExhaustedRunLimit), graph/schema.ts types, the graph JSON "limits" blocks (src/kpi/graphs/*.json), the /kpi --max-cost-usd flag in control-plane.ts and its task.limits freezing, state.json fields (exhausted_limit values), README §8 "Budget flags" (L444-470), spec §4 command table (L140) and §6 (L323-328), PRD, uat. Cost stays reported (state.json cost_usd, the board, events) as a notional figure and is never enforced. Old checkpoints/task.json carrying maxCostUsd must still load (decide: ignore the key with a recorded note, or migrate) — no crash on resume of an old job.
R2. The engine never ends a run on its own initiative because of a counter or clock. Transient failures (classifyTransientFailure in graph/stop.ts L199: http 429/5xx, timeout, transport; engine.ts L1090-1160 runNode retry with maxTransientRetries=2 and doubling backoff from DEFAULT_RETRY_BASE_MS; L1365 exhaust on maxTransientRetries; the accounts extension's failover on 402/429 in accounts/index.ts applyFailure ~L639) retry with capped exponential backoff (e.g. 1s doubling to a 60s ceiling, jitter optional) for as long as it takes, across slots/providers via the existing balancer, with the operator informed on every retry (board + one notify line per retry with attempt number, reason, next delay) and with the checkpoint written before each wait so a kill/resume continues the wait, not the run. Delete maxTransientRetries and the "exhausted maxTransientRetries" path, or keep it only as a threshold that escalates from silent retry to a visible NEEDS_HUMAN pause offering "keep retrying / stop" in gated mode — pick one and justify by minimalism; an unattended (autopilot/print/RPC) run keeps retrying with backoff and a persisted attempt count; state how a hung provider (never answers) is detected (per-request timeout already exists?) so a retry actually happens.
R3. Whole-run timeoutMs, maxSteps, maxNodeRuns, maxRounds: these must no longer terminate. Decide per limit what replaces it: (a) timeoutMs — delete (a run is as long as the work; the operator sees elapsed on the board); (b) maxRounds / maxNodeRuns / maxSteps — replace with a repair escalation, not a stop: when a round ends with the same failing AC set or the same output fingerprint as before (the existing NO_PROGRESS detection in stop.ts transitionStopState / stopFingerprint / failingAcSetKey), the loop routes back to the plan node with the evidence and the previous plan as feedback (state path plan.repair = {round, reason, failing_ac, evidence_ref}; the plan prompt in src/kpi/prompts/plan.md and the graph node prompt receive it), and only when a re-plan has already been tried for the same fingerprint does the job pause NEEDS_HUMAN (gated: ctx.ui.select "Give guidance / Keep going / Stop" where guidance goes into plan.repair; unattended: NEEDS_HUMAN with the resume command). Define the exact edge/routing changes in graphs/coding-loop.gated.json and coding-loop.auto.json (read their edges), the engine's routing on plan.repair, and how the round counter still increments for display (ROUND n on the board) without a max (board shows "ROUND n" not "n/m"; check scripts/pty-rows/*.mjs for the "ROUND n/m" token and say what the grader must search for instead).
R4. Stop vocabulary. Today TerminalStatus = DONE | BLOCKED | EXHAUSTED | NO_PROGRESS | UNSAFE | NEEDS_HUMAN (stop.ts L11), produced in gated-loop.ts at L1497 (EXHAUSTED), L1742/L1987 (BLOCKED), L1857/L1866 (NEEDS_HUMAN) and via engine terminate/exhaust/fail. Propose the smallest vocabulary consistent with "the operator is the only stop": e.g. RUNNING | WAITING (paused for the operator: plan gate, release gate, repair escalation, provider unavailable after N visible retries, policy refusal) | DONE | STOPPED (operator /kpi stop), where the old BLOCKED/EXHAUSTED/NO_PROGRESS/UNSAFE become recorded *reasons* on a WAITING pause — OR keep NEEDS_HUMAN as the pause name if that is a smaller change for the board (board.ts STOP_VOCABULARY, normalizeStop, the STOP STATES cells on Board B, docs/visual-targets.md §2, scripts/pty-rows graders, docs/spec.md §6 table, PRD AC-05.1, run-store.ts isLiveJob which decides which statuses count as live — a WAITING/NEEDS_HUMAN job must count as live/resumable, not finished). Enumerate every producer of each removed status and what it becomes. UNSAFE today covers non-executable ACs in autopilot and policy refusals (ac.refused event): those become a WAITING pause with the reason, never a death.
R5. Resume. /kpi <job> on a WAITING job continues from the checkpoint (existing resumeLoop in gated-loop.ts L1627+); make sure a job paused mid-backoff or mid-re-plan resumes correctly, and that "STOPPED" by the operator is also resumable (or say why not).
R6. Keep autopilot's promise from PRD US-04 (autopilot only when every AC is machine-executable) — that is a mode gate, not a stop, and stays.

Read: graph/budget.ts (all), graph/stop.ts (all), graph/engine.ts (runNode L1090-1180, runSuperstep ~L1240-1400, terminate/exhaust/fail, route()), graph/schema.ts (limits types, GraphRunState.status values), gated-loop.ts (the superstep loop L1300-1420, stop handling L1480-1520, terminal returns, restoreStopState L524+, resumeLoop L1627+, the first-run loop L1880-2020), control-plane.ts (flags), run-store.ts (isLiveJob, writeState), board.ts (STOP vocabulary), status-line (footer job line "r0/3"), docs/spec.md §6 and §8, docs/PRD.md US-04/US-05/US-02, docs/uat.md UAT-05, AGENTS.md "Best practices" row (stopping conditions) and "Do not" list, README §8, §9, §13, scripts/generate-traceability-map.mjs (rows for AC-05.x and titles in test/stop.test.ts, test/autopilot.test.ts, test/gated-loop.test.ts, test/graph-engine.test.ts, test/resume.test.ts), the run on disk ${REPO}/.kpi/runs/20260903-fix-claude-model-requests-failin-42986cfa/ (state.json, graph/checkpoint-000004.json) as the reproduction fixture.
Name new test titles; list every bound title that changes or is deleted and its generator row. Size honestly (this is L). Put in open_questions only decisions the owner has NOT already made above.`

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['lens','verdict','problems','required_changes'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['sound','needs-revision','wrong'] },
    problems: { type: 'array', items: { type: 'object', required: ['severity','claim','evidence'], properties: { severity: {type:'string', enum:['major','minor']}, claim:{type:'string'}, evidence:{type:'string'} } } },
    required_changes: { type: 'array', items: { type: 'string' } },
  },
}

phase('Design')
const design = await agent(PROMPT, { label: 'design:self-healing', phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })
if (!design) return { error: 'designer returned nothing' }

phase('Critique')
const LENSES = [
  { name: 'correctness', brief: 'Verify every cited file:line and claimed API against the actual source. Does the change guarantee no run ends on a counter or clock while still making a hung or dead provider visible and resumable? Are all producers of removed statuses migrated (grep the whole src/kpi and test/ for EXHAUSTED|BLOCKED|NO_PROGRESS|UNSAFE|maxCostUsd|maxTransientRetries|timeoutMs)? Do old checkpoints/task.json still load? Are new state/event contracts consistent with schemas/event.schema.json, append-log.ts, graph/schema.ts, stop.ts, run-store.ts isLiveJob? Would the specified tests fail before and pass after? Would the pty graders and test/traceability.test.ts pass with the listed generator changes? Try hard to REFUTE.' },
  { name: 'minimalism-and-contract', brief: 'Judge against AGENTS.md and docs/minimalist.md and the owner\'s recorded rules R1-R6. Is this the smallest change that satisfies R1-R6? Does it keep any counter-based termination the owner forbade, or silently keep a cap under another name? Does it invent unnecessary vocabulary or modules? Does it amend every doc that states the old principle (PRD US-05, spec §6, AGENTS.md best-practice row, README) in the same change? Is every pause given a recorded reason and a resume path? Try hard to REFUTE.' },
]
const critiques = (await parallel(LENSES.map(l => () =>
  agent(`You are an adversarial reviewer with the "${l.name}" lens. ${l.brief}\nRepository: ${REPO}. You are READ-ONLY. Return the structured object only.\n\nOWNER RULES R1-R6 (normative):\n${PROMPT.slice(PROMPT.indexOf('R1.'), PROMPT.indexOf('Read:'))}\n\nDESIGN UNDER REVIEW:\n${JSON.stringify(design, null, 1)}`,
    { label: `critique:${l.name}`, phase: 'Critique', schema: CRITIQUE_SCHEMA, effort: 'high' })
))).filter(Boolean)

phase('Revise')
const revised = await agent(`${COMMON}\n\nYou are revising the design "self-healing" using two adversarial critiques. Re-verify against the source anything a critique disputes (READ-ONLY). Produce the final design object: fix every major problem, address minors where cheap, keep the shape identical, and add a note inside risks[] for any critique point you rejected and why (prefix "rejected:").\n\nOWNER RULES R1-R6 (normative):\n${PROMPT.slice(PROMPT.indexOf('R1.'), PROMPT.indexOf('Read:'))}\n\nORIGINAL DESIGN:\n${JSON.stringify(design, null, 1)}\n\nCRITIQUES:\n${JSON.stringify(critiques, null, 1)}`,
  { label: 'revise:self-healing', phase: 'Revise', schema: DESIGN_SCHEMA, effort: 'high' })

return { design: revised ?? design, critiques }