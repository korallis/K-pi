export const meta = {
  name: 'kpi-wave1b-implement',
  description: 'Finish wave 1 after an interruption: implement anthropic-auth (tests already written) and plan-gate, then verify and fix all three wave-1 packages',
  phases: [
    { title: 'Implement', detail: 'anthropic-auth and plan-gate in parallel' },
    { title: 'Verify', detail: 'adversarial verifier per package, including agents-visibility' },
    { title: 'Fix', detail: 'implementer fixes verified problems' },
  ],
}

const REPO = '/Users/leebarry/K-pi'
const SCRATCH = '/private/tmp/claude-501/-Users-leebarry-K-pi/304cbd03-16f6-4bf4-b7d1-7643df70b280/scratchpad'

const RULES = `
You are implementing one package inside the K-π repository at ${REPO} on branch fix/operator-issues-0.3.0. Other engineers are editing OTHER files in the SAME working tree at the same time.

HARD RULES
- Edit ONLY the files listed under OWNED FILES. Creating a file not listed, or touching any other file, is a defect: if you believe another file must change, do not change it — describe the exact hunk in your report under handover.
- Never run git commands that change the tree or index: no commit, stash, checkout, reset, restore, clean, cherry-pick, rebase. Read-only git (status, diff, show, log) is fine.
- Never run \`npm run build\`, \`npm run build:offline\`, \`npm run check\`, \`npm run test:kpi\`, \`npm test\`, or scripts/generate-traceability-map.mjs (other engineers' half-landed edits would confuse the result and the lead runs the full gates after the wave). Allowed: \`node --test --experimental-strip-types test/<your files>\`, \`npx tsc --noEmit\` (act only on errors in your owned files; others' files may be mid-edit), \`npx biome check --error-on-warnings <your files>\` and \`npx biome format --write <your files>\` (the repo uses tabs and double quotes), \`cd packages/ai && npx vitest --run test/<file>\` when the file is yours.
- Reproduce before you fix: write or adapt the test first, run it and see it fail for the reason the design names, then implement, then see it pass. Record both runs in commands_run.
- Smallest correct change; no shims, aliases, or deprecated re-exports; migrate every caller inside your owned files; if a caller lives outside them, put the exact hunk in handover.
- Every failure mode gets a real path, a recorded reason and a bound; never a silent catch.
- No hard-coded official model ids. Every new operator-facing line starts with "K-π ". Never describe K-π as a Pi package.
- Existing test titles are bound in docs/traceability-map.json: keep them verbatim unless the design explicitly renames one (then list it under handover.titles_changed).
- Docs (docs/*.md, README.md, AGENTS.md, fixes.md, docs/remediation-plan.md, scripts/generate-traceability-map.mjs, docs/traceability-map.json, test/traceability.test.ts) are written by a later wave by ONE agent: do not touch them; instead put the exact AC rows (id, test file, verbatim test title, note) and the doc edits (file, section, what) into handover.
- packages/coding-agent/dist is rebuilt by the lead after the wave; do not run the build and do not run test/harness.test.ts.
- The design you implement is a JSON file you must read in full first (cat it). Follow it unless a DECISION below overrides it or you find, with evidence, that a cited line is wrong — then implement the intent and record the deviation.
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

const PACKAGES = [
  {
    key: 'anthropic-auth',
    implement: true,
    design: `${SCRATCH}/design-anthropic-auth.json`,
    owned: [
      'packages/coding-agent/src/kpi/extensions/accounts/errors.ts',
      'packages/coding-agent/src/kpi/extensions/accounts/store.ts',
      'packages/coding-agent/src/kpi/extensions/accounts/index.ts',
      'packages/coding-agent/src/kpi/extensions/accounts/balancer.ts',
      'packages/coding-agent/src/kpi/extensions/accounts/widget.ts',
      'packages/ai/test/anthropic-auth-token.test.ts',
      'test/accounts-errors.test.ts',
      'test/accounts-commands.test.ts',
      'test/accounts.test.ts',
      'test/accounts-routing.test.ts',
      'UPSTREAM.md',
    ],
    decisions: `
- INTERRUPTED ATTEMPT: a previous engineer on this package was cut off after writing the tests and before touching any source file. The tree already holds their test edits (git status shows M packages/ai/test/anthropic-auth-token.test.ts, M test/accounts-commands.test.ts, M test/accounts.test.ts, M test/accounts-routing.test.ts, ?? test/accounts-errors.test.ts; the accounts/*.ts sources and UPSTREAM.md are untouched). Start with \`git diff -- <those test files>\` and \`cat test/accounts-errors.test.ts\`, keep what matches the design, correct what does not, run them to see them fail (that is the reproduction), then implement the sources.
- The upstream cherry-pick is ALREADY applied on this branch as commit ea35b7f80 (packages/ai/src/api/anthropic-messages.ts:77 now reads claudeCodeVersion = "2.1.251"). Do not cherry-pick again and do not edit that file; verify the line with grep and record it. Keep/finish the vitest floor test in packages/ai/test/anthropic-auth-token.test.ts and write the UPSTREAM.md §6 "Patched upstream files" block as designed (UPSTREAM.md is yours).
- The NEEDS_HUMAN gate the design calls NH-03 has been answered YES by the product owner (their own earlier instruction: "fix /login anthropic so K-π synchronizes refreshed OAuth credentials into account routing and supports two distinct subscription slots"). Implement the whole design, including the official-slot half (store.ts reconcileOfficialCredentials/readOfficialCredential/claimOfficial/markNeedsLogin, balancer, widget, hooks). Do NOT edit docs/remediation-plan.md: the docs wave records the gate as NH-05 (NH-03 already exists). Put the gate text, the amended AC-10.2 wording, AC-10.9/AC-10.10 rows and the spec/README/uat edits in handover.
- The onboarding package (a later wave) will widen loginAccount/loginWithOfficialProvider context types and add exports in accounts/index.ts; leave room but do not do its work.
- The live-artifact steps in the design's verification (backups of ~/.kpi/agent, running dist/bundle/cli.js) are the lead's after the build; skip them.`,
  },
  {
    key: 'plan-gate',
    implement: true,
    design: `${SCRATCH}/design-plan-gate.json`,
    owned: [
      'packages/coding-agent/src/kpi/extensions/stack.ts',
      'packages/coding-agent/src/kpi/extensions/graph/schema.ts',
      'packages/coding-agent/src/kpi/extensions/graph/engine.ts',
      'packages/coding-agent/src/kpi/graphs/coding-loop.gated.json',
      'packages/coding-agent/src/kpi/extensions/gated-loop.ts',
      'packages/coding-agent/src/kpi/extensions/append-log.ts',
      'packages/coding-agent/src/kpi/schemas/event.schema.json',
      'test/gated-loop.test.ts',
      'test/graph-engine.test.ts',
      'test/graph-routing.test.ts',
      'test/stack.test.ts',
      'test/schema-conformance.test.ts',
    ],
    decisions: `
- PRODUCT DECISION (owner, 2026-09-03): there is NO cap on plan revisions and the graph must never end a job on a counter — the operator is the only bound. Therefore: the dialog title line reads "Revision N" (never "of <cap>" and never the EXHAUSTED warning); do NOT implement or test "the third change request ends EXHAUSTED" (drop AC-02.10 in that form; instead hand over AC-02.10 as "plan revisions are unbounded; the operator is the bound", whose test belongs to the later self-healing package that deletes the engine's per-node caps). Do not touch budget.ts or the cap check itself; note in known_gaps that until the self-healing package lands, the engine's existing per-node cap still applies to plan re-runs.
- A gated job without dialog UI (print/RPC) runs to the gate and stops NEEDS_HUMAN with recovery "approval" and the resume command, exactly as designed; it is not refused at start.
- Shared-contract duty: you own append-log.ts, event.schema.json and test/schema-conformance.test.ts for the whole batch. Land ALL of these in this wave, exactly: (1) EVENT_TYPES gains "node.started" and "node.finished" appended at the END in that order; EventInput gains Event<"node.started", { run: number; model?: string }> and Event<"node.finished", { run: number; status: "completed" | "failed"; elapsed_ms: number; cost_usd?: number; result?: string; session?: string; error?: string }>; export type NodeLifecycleEvent = Extract<EventInput, { type: "node.started" | "node.finished" }>; (2) approval.result payload { approved: boolean; question?: string; feedback?: string }; (3) ResearchPayload.mode union adds "firecrawl"; (4) event.schema.json: $defs.nodeStarted (base seven required fields + run; type const node.started; run integer minimum 1; model $ref identifier; additionalProperties false) and $defs.nodeFinished (base seven + run, status, elapsed_ms required; status enum [completed, failed]; elapsed_ms integer minimum 0; cost_usd number minimum 0; result/session/error $ref text; additionalProperties false) appended to the top-level oneOf; approvalResult.properties.feedback = {$ref: "#/$defs/text"}; $defs.service enum = [exa, perplexity, firecrawl, local]; $defs.researchMode enum = [exa, perplexity, firecrawl, auto, local]; (5) test/schema-conformance.test.ts eventPayload(): approval.result → { ...base, approved: false, question: "Commit?", feedback: "split the module" }; node.started → { ...base, run: 1, model: "openai-codex/gpt-test" }; node.finished → { ...base, run: 1, status: "completed", elapsed_ms: 1200, cost_usd: 0.01 }, keeping every existing title verbatim. Do NOT emit node.* events from the engine yourself — the board package does that in a later wave; you only land the types and schema.
- The engine and gated-loop hunks of the agents-visibility package (getSessionStats widening, onSessionsChange option, registerLiveNodeSession brackets, onSessionsChange: dependencies.onStateChange literals) are NOT yours; leave them out.
- Rebuilding dist for the harness test is the lead's job after the wave.`,
  },
  {
    key: 'agents-visibility',
    implement: false,
    design: `${SCRATCH}/design-agents-visibility.json`,
    owned: [
      'packages/coding-agent/src/kpi/extensions/bus/sessions-snapshot.ts (created)',
      'packages/coding-agent/src/kpi/extensions/bus/sessions-command.ts (created)',
      'packages/coding-agent/src/kpi/extensions/bus/spawn.ts',
      'packages/coding-agent/src/kpi/extensions/bus/communicate.ts',
      'test/bus.test.ts',
    ],
    decisions: `
- WAVE SCOPE (integration plan): this wave lands ONLY the bus half: sessions-snapshot.ts (new, the sole liveness registry, exactly the exported shapes in the design), sessions-command.ts (new, the /agents command and formatSessionsTable), spawn.ts (LiveWorker, liveWorkers(), countLiveProcesses derived from it, node?: string on spawn options/WorkerRecord/WorkerStatus), communicate.ts (registerLiveBus on activeBus, releases at session_shutdown, registerSessionsCommand in registerParentTools) and test/bus.test.ts.
- live-snapshot.ts is kept; control-plane.ts, board.ts, graph/engine.ts, gated-loop.ts, test/graph-engine.test.ts, test/reviewer-session.test.ts, test/operator-ui.test.ts, test/control-plane.test.ts are NOT touched: those hunks belong to the board package in a later wave. In communicate.ts the existing setLiveWorkerCountProvider bridge is KEPT but points at the new registry: setLiveWorkerCountProvider(() => liveWorkerCount()) importing liveWorkerCount from ./sessions-snapshot.ts.
- Accepted deviations from the previous implementer's report: "K-π " prefix on the table header, usage warning and error notify; a TOOLS column; a job line after the mechanism sentence; conditional spread of node; exported formatElapsed; registerSessionsCommand at the top of registerParentTools under its own registerCommand guard.
- The /agents handler: sessionsSnapshot({ main: { sessionId, model, pid: process.pid } }) with no jobId; job status line from readLiveJob; the one failure path (run store unreadable) reported as an error notify starting with "K-π /agents could not read the run store: ".`,
    previousReport: 'The implementer reported: files_changed sessions-snapshot.ts (created), sessions-command.ts (created), spawn.ts, communicate.ts, test/bus.test.ts; tests added "a registered bus lists its workers for the sessions snapshot and leaves it when released", "/agents prints every kind of session and names the mechanism", and the migrated "countLiveProcesses excludes dead PIDs without reaping the table"; node --test test/bus.test.ts 96/96 pass; biome check clean on the five files; tsc --noEmit showed 0 errors in owned files.',
  },
]

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

const implPrompt = (p) => `${RULES}

PACKAGE: ${p.key}
DESIGN FILE (read it in full first): ${p.design}
INTEGRATION PLAN (read the shared_contracts and the ownership rows that name your files): ${SCRATCH}/plan.json

OWNED FILES (the only files you may create or edit):
${p.owned.map(f => `- ${f}`).join('\n')}

DECISIONS THAT OVERRIDE THE DESIGN WHERE THEY DIFFER:
${p.decisions}

When done: run \`npx biome check --error-on-warnings\` on your owned source and test files, \`npx tsc --noEmit\` (report errors in your files only), and every scoped test file you own; include the exact commands with exit codes. List every file you changed (git status --short filtered to your files).`

phase('Implement')
log('Wave 1b: implementing anthropic-auth (tests pre-written) and plan-gate in parallel')
const reports = await parallel(PACKAGES.filter(p => p.implement).map(p => () =>
  agent(implPrompt(p), { label: `impl:${p.key}`, phase: 'Implement', schema: REPORT_SCHEMA, effort: 'high' })
    .then(r => ({ pkg: p, report: r }))
))
const done = reports.filter(Boolean)
const av = PACKAGES.find(p => p.key === 'agents-visibility')
done.push({ pkg: av, report: { package: 'agents-visibility', note: av.previousReport } })
log(`${done.length}/3 packages ready for verification`)

phase('Verify')
const verified = await parallel(done.map(d => () =>
  agent(`You are an adversarial verifier for the package "${d.pkg.key}" in ${REPO} (branch fix/operator-issues-0.3.0). Other packages are being edited in the same tree by other engineers; judge ONLY the owned files below. You may edit nothing and run no git command that changes the tree.

1. Read the design ${d.pkg.design} and the decisions below. 2. Read the implementer's report (below). 3. Run \`git diff -- <owned files>\` and \`git status --short\` and read every changed owned file in full. 4. Run each owned test file with \`node --test --experimental-strip-types <file>\` (and \`cd packages/ai && npx vitest --run test/anthropic-auth-token.test.ts\` if owned), and \`npx biome check --error-on-warnings <owned source/test files>\`; record exact exit codes. 5. Try hard to refute: does the change do what the design and the decisions require (not more, not less)? Does any edit land outside the owned files (a defect)? Any silent catch, shim, alias, hard-coded model id, missing "K-π " prefix, renamed bound test title, or docs edit? Does a new test actually exercise the behaviour (would it have failed before)? Are the shared contracts landed exactly as specified?
Verdict "pass" only when there is no major problem and every owned test passes. Return ONLY the structured object.

OWNED FILES:
${d.pkg.owned.map(f => `- ${f}`).join('\n')}

DECISIONS:
${d.pkg.decisions}

IMPLEMENTER REPORT:
${JSON.stringify(d.report, null, 1)}`,
    { label: `verify:${d.pkg.key}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' })
    .then(v => ({ ...d, verdict: v }))
))

phase('Fix')
const fixed = await parallel(verified.filter(Boolean).map(d => () => {
  const majors = (d.verdict?.problems ?? []).filter(p => p.severity === 'major')
  if (d.verdict?.verdict === 'pass' && majors.length === 0) return Promise.resolve({ ...d, fix: null })
  return agent(`${implPrompt(d.pkg)}

YOU ARE THE FIX PASS. The package was implemented (report below) and an adversarial verifier found problems (below). Fix every major problem and the minors that are cheap, inside the OWNED FILES only, re-run the scoped tests and biome, and return an updated report of the same shape covering the WHOLE package (files_changed = all files changed by the package so far).

PREVIOUS REPORT:
${JSON.stringify(d.report, null, 1)}

VERIFIER PROBLEMS:
${JSON.stringify(d.verdict, null, 1)}`,
    { label: `fix:${d.pkg.key}`, phase: 'Fix', schema: REPORT_SCHEMA, effort: 'high' })
    .then(r => ({ ...d, fix: r }))
}))

return fixed.filter(Boolean).map(d => ({ package: d.pkg.key, report: d.fix ?? d.report, verdict: d.verdict, fixed: d.fix !== null }))