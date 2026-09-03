export const meta = {
  name: 'kpi-budget-exhaustion-design',
  description: 'Design the change so a gated K-π job never dies on a budget limit but pauses and asks the operator to extend or stop',
  phases: [
    { title: 'Design' },
    { title: 'Critique' },
    { title: 'Revise' },
  ],
}

const REPO = '/Users/leebarry/K-pi'

const COMMON = `
You are a senior engineer designing a fix inside the K-π repository at ${REPO} (a TypeScript monorepo, fork of Pi v0.84.4; K-π's own runtime is packages/coding-agent/src/kpi/). You are READ-ONLY in this phase: do not edit, create, or delete any file. Read code with cat/sed/grep/Read. Return ONLY the structured object requested.

Repository rules you must design within (from AGENTS.md):
- Reproduce before you fix; prove against the real artifact (built binary), not "it compiles".
- Smallest correct change. Prefer deletion and reuse over new structure. No shims, aliases, or deprecated re-exports; migrate every caller.
- Handle the failures the contracts name: each failure mode gets a real path, a recorded reason, and a bound. Silence is a defect.
- Update the owning product docs in the same change (docs/PRD.md stories US-xx with ACs, docs/spec.md, docs/uat.md, docs/visual-targets.md, README.md). New acceptance criteria get rows in scripts/generate-traceability-map.mjs and docs/traceability-map.json is regenerated (node scripts/generate-traceability-map.mjs), never hand-edited. Existing test titles bound in that map must survive verbatim.
- Tests live in root test/*.test.ts (node --test --experimental-strip-types), exercise observable behaviour, use injected clocks/fetches/launchers and temp HOME/repo roots; no cloud keys, no real sleeps.
- test/harness.test.ts compares src/kpi resource dirs byte-for-byte with dist/kpi, so resource edits need a rebuild of packages/coding-agent.
- Never hard-code official model ids. Config dir is .kpi/ (project) and ~/.kpi/agent/ (user).
- A contract conflict between PRD/spec and a request is a NEEDS_HUMAN decision: put it in open_questions with both citations rather than picking silently.

Extension UI available to K-π code (packages/coding-agent/src/core/extensions/types.ts): ctx.ui.select(title, options), confirm(title, message), input(title, placeholder), editor(title, prefill), notify(msg, level), setStatus, setWidget, custom(...) overlays; ctx.hasUI / mode "tui" vs print/RPC.

Return a JSON object with exactly these fields:
issue (string), root_cause (string, citing file:line), evidence (array of {file, line, note}), change (array of {file, action: "create"|"edit"|"delete", what}), event_or_data_contracts (array of strings: new event types, schema fields, settings keys, state paths, exported functions, with exact names and shapes), tests (array of {file, title, asserts}), docs (array of {file, section, what}), verification (array of shell commands), risks (array of strings), open_questions (array of strings), size ("S"|"M"|"L").
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

ISSUE F: The operator's gated job ended with the footer warning "K-π job 20260903-fix-claude-model-requests-failin-42986cfa EXHAUSTED: graph exhausted maxCostUsd 5 at 7.691661999999999". The operator's words: "graphs should never fail". A gated job has a human in front of it; killing the run at a budget line instead of asking that human is the defect.
Facts on disk (read them): ${REPO}/.kpi/runs/20260903-fix-claude-model-requests-failin-42986cfa/state.json shows status EXHAUSTED, exhausted_limit maxCostUsd, cost_usd 7.69, limits {maxSteps 24, maxNodeRuns 16, maxConcurrency 2, maxCostUsd 5, timeoutMs 1800000, maxRounds 3, maxTransientRetries 2}, superstep 4, node implement, round 1, elapsed 923418 ms; events.jsonl has a loop.terminal record with status EXHAUSTED and no cost per node; graph/checkpoint-00000N.json shows what the engine tracks per node (read checkpoint-000004.json). The route was an OAuth subscription slot (openai-codex/gpt-5.6-sol), so the USD figure is a notional catalog price, not a bill.
Code to read: packages/coding-agent/src/kpi/extensions/graph/budget.ts (limits, defaults, where maxCostUsd 5 comes from), graph/engine.ts (runSuperstep, cost accounting — where cost_usd is accumulated and when the limit is checked; why it overshot to 7.69 against 5; terminate/fail paths; the "exhausted" status), graph/stop.ts (stop states, EXHAUSTED semantics), gated-loop.ts (how a terminal graph status becomes the loop's stop state and the footer warning; the superstep loop ~L1300-1420 and ~L1880-2020; how --max-cost / budget flags are parsed — README §8 "Budget flags"; how resume (/kpi <job>) restores limits; how human gates pause the loop with ctx.ui.confirm), control-plane.ts (/kpi flags), run-store.ts (state.json writer), docs/spec.md §6 Modes and stop states and §8 Graph engine (budget rows), docs/PRD.md US-02, US-04, US-05 (autopilot stop states are normative: EXHAUSTED exists for a reason), docs/uat.md UAT-05, docs/minimalist.md, AGENTS.md "Best practices" row on stopping conditions, test/stop.test.ts, test/graph-engine.test.ts, test/gated-loop.test.ts, test/autopilot.test.ts (fixture patterns and bound titles in scripts/generate-traceability-map.mjs).

Design:
1. In gated mode (and any interactive session), reaching ANY graph limit (maxCostUsd, maxSteps, maxNodeRuns, timeoutMs, maxRounds) must not terminate the job. The engine pauses at the limit in a durable way (a persisted "limit reached" interruption, checkpointed like a human node so a crash or resume re-asks), the operator is told exactly what was spent and where (per-node cost and steps if available; else totals), and asked via ctx.ui.select: extend by a sensible step (e.g. +$5 / +$20 / no limit for this job / stop). The chosen extension is persisted (task.json limits or state.json limits, whichever is the source of truth on resume — verify) and the graph continues from the same superstep without re-running finished nodes. "Stop" ends as EXHAUSTED with the recorded reason as today. Define exact new engine API (e.g. runState.status "limit-reached" or reuse "interrupted" with pendingLimit {limit, value, max}), events (limit.reached {limit, value, max, node, superstep}; limit.extended {limit, from, to, by: "operator"}), and how gated-loop.ts drives it (mirror the pendingHuman loop). Bound the number of extensions? The operator is the bound in gated mode; say so explicitly and record each extension.
2. Autopilot and non-interactive (print/RPC) runs: limits stay hard stops (US-05), but the stop must be NEEDS_HUMAN-style actionable: the state and footer carry the exact resume command that raises the limit (e.g. /kpi <job> --max-cost 20) and resume must accept a higher limit for an EXHAUSTED job (verify whether resume currently refuses a terminal job; design the path).
3. Overshoot: why the check let 5 become 7.69 (per-superstep check after the node finished? cost of one node unknown until it ends?). Propose the cheapest honest improvement: check before starting a superstep with the projected cost (last node cost as the estimate) OR keep the post-hoc check but state the rule in docs. Do not add per-token streaming budget enforcement unless it already exists.
4. Subscription routes: decide whether cost on an OAuth subscription slot should count toward maxCostUsd at all (the footer already prints "(local) $0" for local slots; see spec §11/§13 and accounts/store.ts slot kinds). If the contract is silent, propose the default (e.g. still count notional cost but label it "notional" in the pause dialog) and put the alternative in open_questions rather than choosing silently.
5. Default: keep maxCostUsd 5 as the default pause line? Or raise? Cite where the default is documented (README §8 Budget flags / spec) before answering; a default change is a product decision → open_questions unless the docs already say it is advisory.
Name new test titles; name existing bound titles that must not change.`

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
const design = await agent(PROMPT, { label: 'design:budget-exhaustion', phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })
if (!design) return { error: 'designer returned nothing' }

phase('Critique')
const LENSES = [
  { name: 'correctness', brief: 'Verify every cited file:line and claimed API against the actual source. Does the change actually prevent a gated job from ending EXHAUSTED at a limit while keeping autopilot hard stops? Is the pause durable across crash/resume without re-running finished nodes? Are the new state/event contracts consistent with schemas/event.schema.json, append-log.ts, graph/schema.ts, stop.ts? Would the specified tests fail before and pass after? Try hard to REFUTE.' },
  { name: 'minimalism-and-contract', brief: 'Judge against AGENTS.md, docs/minimalist.md, PRD US-05 and spec §6. Is this the smallest correct change? Does it silently change a normative default or stop-state semantics that belongs in open_questions? Does it update the owning docs and the traceability generator in the same change? Is every failure mode given a real path with a recorded reason? Try hard to REFUTE.' },
]
const critiques = (await parallel(LENSES.map(l => () =>
  agent(`You are an adversarial reviewer with the "${l.name}" lens. ${l.brief}\nRepository: ${REPO}. You are READ-ONLY. Return the structured object only.\n\nDESIGN UNDER REVIEW:\n${JSON.stringify(design, null, 1)}`,
    { label: `critique:${l.name}`, phase: 'Critique', schema: CRITIQUE_SCHEMA, effort: 'high' })
))).filter(Boolean)

phase('Revise')
const revised = await agent(`${COMMON}\n\nYou are revising the design "budget-exhaustion" using two adversarial critiques. Re-verify against the source anything a critique disputes (READ-ONLY). Produce the final design object: fix every major problem, address minors where cheap, keep the shape identical, and add a note inside risks[] for any critique point you rejected and why (prefix "rejected:").\n\nORIGINAL DESIGN:\n${JSON.stringify(design, null, 1)}\n\nCRITIQUES:\n${JSON.stringify(critiques, null, 1)}`,
  { label: 'revise:budget-exhaustion', phase: 'Revise', schema: DESIGN_SCHEMA, effort: 'high' })

return { design: revised ?? design, critiques }