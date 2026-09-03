export const meta = {
  name: 'kpi-wave2-implement',
  description: 'Wave 2 of the K-π operator fixes: live board (board-live, absorbing the sessions-visibility hunks) and onboarding + Firecrawl, in parallel on disjoint files, each verified and fixed once',
  phases: [
    { title: 'Implement', detail: 'board-live and onboarding in parallel' },
    { title: 'Verify', detail: 'adversarial verifier per package' },
    { title: 'Fix', detail: 'implementer fixes verified problems' },
  ],
}

const REPO = '/Users/leebarry/K-pi'
const SCRATCH = '/private/tmp/claude-501/-Users-leebarry-K-pi/304cbd03-16f6-4bf4-b7d1-7643df70b280/scratchpad'

const RULES = `
You are implementing one package inside the K-π repository at ${REPO} on branch fix/operator-issues-0.3.0. Another engineer is editing OTHER files in the SAME working tree at the same time. Wave 1 already landed (commits 68da4505b, ae3565bc4, 640fbaa81): the accounts official-slot change, the plan-approval gate with HumanAnswer/feedbackPath, the node.started/node.finished/approval.result.feedback/firecrawl event contracts in append-log.ts and event.schema.json, and the bus sessions registry (bus/sessions-snapshot.ts, /agents). Read the current code: design line numbers may have shifted.

HARD RULES
- Edit ONLY the files listed under OWNED FILES. Creating a file not listed, or touching any other file, is a defect: if you believe another file must change, do not change it — describe the exact hunk in your report under handover.
- Never run git commands that change the tree or index: no commit, stash, checkout, reset, restore, clean, cherry-pick, rebase. Read-only git (status, diff, show, log) is fine.
- Never run \`npm run build\`, \`npm run build:offline\`, \`npm run check\`, \`npm run test:kpi\`, \`npm test\`, or scripts/generate-traceability-map.mjs. Allowed: \`node --test --experimental-strip-types test/<your files>\`, \`npx tsc --noEmit\` (act only on errors in your owned files), \`npx biome check --error-on-warnings <your files>\` and \`npx biome format --write <your files>\` (tabs, double quotes).
- Reproduce before you fix: write or adapt the test first, run it and see it fail for the reason the design names, then implement, then see it pass. Record both runs in commands_run.
- Smallest correct change; no shims, aliases, or deprecated re-exports; migrate every caller inside your owned files; a caller outside them goes into handover as an exact hunk.
- Every failure mode gets a real path, a recorded reason and a bound; never a silent catch.
- No hard-coded official model ids. Every new operator-facing line starts with "K-π ". Never describe K-π as a Pi package.
- Existing test titles are bound in docs/traceability-map.json: keep them verbatim unless the design explicitly renames one (then list it under handover.titles_changed).
- Docs (docs/*.md, README.md, AGENTS.md, fixes.md, docs/remediation-plan.md, scripts/generate-traceability-map.mjs, docs/traceability-map.json, test/traceability.test.ts) are written by a later wave by ONE agent: do not touch them; put the AC rows (id, test file, verbatim title, note) and doc edits (file, section, what) into handover.
- packages/coding-agent/dist is rebuilt by the lead after the wave; do not build and do not run test/harness.test.ts.
- The design is a JSON file you must read in full first (cat it). Follow it unless a DECISION below overrides it or you find, with evidence, that a cited line is wrong — then implement the intent and record the deviation.
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
    key: 'board-live',
    design: `${SCRATCH}/design-board-live.json`,
    owned: [
      'packages/coding-agent/src/kpi/extensions/graph/engine.ts',
      'packages/coding-agent/src/kpi/extensions/gated-loop.ts (ONLY the two GraphEngine option literals `onSessionsChange: dependencies.onStateChange`, plus any hunk addressed to board-live in the wave-1 reports)',
      'packages/coding-agent/src/kpi/extensions/board.ts',
      'packages/coding-agent/src/kpi/extensions/board-frame.ts',
      'packages/coding-agent/src/kpi/extensions/board-component.ts',
      'packages/coding-agent/src/kpi/extensions/board-activity.ts (create)',
      'packages/coding-agent/src/kpi/extensions/board-overlay.ts (create)',
      'packages/coding-agent/src/kpi/extensions/control-plane.ts',
      'packages/coding-agent/src/kpi/extensions/renderers.ts',
      'packages/coding-agent/src/kpi/extensions/bus/live-snapshot.ts (delete)',
      'packages/coding-agent/src/kpi/extensions/bus/communicate.ts (ONLY remove the setLiveWorkerCountProvider bridge line and its import)',
      'test/board-activity.test.ts (create)',
      'test/operator-ui.test.ts',
      'test/control-plane.test.ts',
      'test/graph-engine.test.ts',
      'test/reviewer-session.test.ts',
      'test/concise-output.test.ts',
    ],
    decisions: `
- HAND-OVERS YOU MUST APPLY: read ${SCRATCH}/wave1-reports.json and apply every hunk whose owner is "board-live" (from agents-visibility: getSessionStats widening, GraphEngineOptions.onSessionsChange + noteSessionsChange, registerLiveNodeSession/registerLiveBus brackets in executeNode/executeWorkerAgentNode with node: node.id in bus.spawn, the two gated-loop option literals, BoardModel.sessions + the agentsCell text "AGENTS n · k nodes · w workers", control-plane buildBoardModel deriving agents/sessions from sessionsSnapshot({ jobId }), and the four handed-over tests with their exact titles; from plan-gate: its control-plane.ts and renderers.ts hunks). Then delete bus/live-snapshot.ts and the bridge line in communicate.ts (control-plane was its last importer). Also apply onboarding's RESEARCH_MARKS change in board.ts exactly as the shared contract states: module const RESEARCH_MARKS = [["exa", [], "EXA ✕"], ["perplexity", ["pplx"], "PPLX ✕"], ["firecrawl", ["fc"], "FC ✕"]], struck marks derived from it, and the unnamed-failure fallback listing every known mark (operator-ui.test.ts regexes for EXA ✕ / PPLX ✕ must keep passing).
- PRODUCT DECISIONS (owner): (1) the compact always-on widget's stage cells DO carry live content — the owner's complaint is "the graph boxes do not show anything": DONE cells show "<elapsed> · <n> calls · $<cost>", the CURRENT cell shows "<last tool> <target>" and elapsed, PENDING cells show "—"; the NOW row is in addition, not instead. Accept the extra line. (2) Do NOT add a keyboard shortcut: a later package detaches the running loop from the /kpi command handler so /kpi status opens mid-run; design the overlay so it can be opened while a job runs (reads only the run store + registry, ticks while open). (3) Narration lines in the chat pane on node start/finish, route change, failover, and human gate — one line each, "K-π ▶ 02 specify started (openai-codex/gpt-x)", "K-π ■ 02 specify done 3m12s · 41 calls · $0.42 → 03 plan" etc. — never per tool call. (4) Cost is a notional figure (subscriptions): label it "$0.42 est." or similar in the detail panel, never as a bill.
- The engine emits node.started / node.finished events (types and schema already in append-log.ts and event.schema.json from wave 1: node.started { run, model? }, node.finished { run, status, elapsed_ms, cost_usd?, result?, session?, error? }). Use them exactly; do not edit append-log.ts or event.schema.json.
- Engine human API is now submitHuman({ approved, feedback? }) / resume({ approved }) (wave 1); GraphHumanUI/resumeWithUI no longer exist.
- Stop vocabulary: keep the CURRENT six stop states as-is; a later self-healing package changes it. Do not touch budget.ts, stop.ts, or limits.
- control-plane.ts: keep the /kpi command shape; installWidget must be re-entrant (dispose the previous component, which stops its ticker); a 1 s ticker while a live job exists; narration cursor and activity reader keyed by eventsPath as module state so a reinstall never re-narrates.
- Existing bound titles in test/operator-ui.test.ts, test/control-plane.test.ts, test/graph-engine.test.ts stay verbatim (fixes.md FX-01 lists them).`,
  },
  {
    key: 'onboarding',
    design: `${SCRATCH}/design-onboarding.json`,
    owned: [
      'packages/coding-agent/src/kpi/extensions/accounts/index.ts',
      'packages/coding-agent/src/kpi/kstack/models.ts',
      'packages/coding-agent/src/kpi/extensions/research/setup.ts',
      'packages/coding-agent/src/kpi/extensions/research/session.ts',
      'packages/coding-agent/src/kpi/extensions/research/endpoints.ts',
      'packages/coding-agent/src/kpi/extensions/research/firecrawl.ts (create)',
      'packages/coding-agent/src/kpi/extensions/research/gate.ts',
      'packages/coding-agent/src/kpi/extensions/research/index.ts',
      'packages/coding-agent/src/kpi/extensions/onboarding.ts (create)',
      'packages/coding-agent/src/kpi/extensions/index.ts',
      'packages/coding-agent/src/kpi/extensions/settings.ts',
      'test/extension.test.ts',
      'test/onboarding.test.ts (create)',
      'test/research-control-plane.test.ts',
      'test/research-clients.test.ts',
    ],
    decisions: `
- accounts/index.ts changed in wave 1 (official slots, reconcileOfficialCredentials, needsLogin, parseClientVersionRejection). Read the current file; apply only your Slice A hunks (widen the four context types to ExtensionContext, extract defaultLogin(pi), export loginPoolInteractively) and Slice B one-liners (isResearchService via RESEARCH_SERVICES, saveResearchKeys spread). Do not alter the wave-1 behaviour.
- append-log.ts ResearchPayload.mode and event.schema.json service/researchMode enums ALREADY include "firecrawl" (wave 1). Verify with grep; do not edit those files.
- board.ts is NOT yours in this wave: the board-live engineer applies the RESEARCH_MARKS change in parallel. Do not touch board.ts; note it under handover as already delegated.
- First-run trigger and marker: accept the design (session_start, reason "startup", mode "tui", hasUI, every pool has zero slots AND modelRegistry.getAvailable() is empty; no persisted marker; "Not now" closes for this launch). An official slot (wave 1: slot.official === true, credential-free) counts as a slot.
- Firecrawl: v2 search as designed (POST /v2/search, Bearer, body { query ≤500, limit 1..10, sources: [{type:"web"}], timeout }, never scrapeOptions); failure classes as designed; 10,000-char field cap; auto order exa → perplexity → firecrawl.
- /onboarding welcome copy must mention: the plan-approval gate before implement and the release gate (both exist now), and that reviewer/tester workers are separate kpi processes on the bus (see /agents).
- docs/remediation-plan.md, scripts/generate-traceability-map.mjs, docs/traceability-map.json and test/traceability.test.ts are the docs wave's: hand over RP-20 text, AC-31.1–AC-31.5 and AC-28.8 rows, the US-31 story and the traceability test loop change (US-01..US-31) as exact hunks.`,
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
INTEGRATION PLAN (shared_contracts and the ownership rows naming your files): ${SCRATCH}/plan.json
WAVE-1 REPORTS (hand-over hunks and the current API of wave-1 code): ${SCRATCH}/wave1-reports.json

OWNED FILES (the only files you may create, edit, or delete):
${p.owned.map(f => `- ${f}`).join('\n')}

DECISIONS THAT OVERRIDE THE DESIGN WHERE THEY DIFFER:
${p.decisions}

When done: run \`npx biome check --error-on-warnings\` on your owned source and test files, \`npx tsc --noEmit\` (report errors in your files only), and every scoped test file you own; include the exact commands with exit codes. List every file you changed (git status --short filtered to your files).`

phase('Implement')
log('Wave 2: implementing board-live and onboarding in parallel')
const reports = await parallel(PACKAGES.map(p => () =>
  agent(implPrompt(p), { label: `impl:${p.key}`, phase: 'Implement', schema: REPORT_SCHEMA, effort: 'high' })
    .then(r => ({ pkg: p, report: r }))
))
const done = reports.filter(Boolean)
log(`${done.length}/${PACKAGES.length} implementers reported`)

phase('Verify')
const verified = await parallel(done.map(d => () =>
  agent(`You are an adversarial verifier for the package "${d.pkg.key}" in ${REPO} (branch fix/operator-issues-0.3.0). Another package is being edited in the same tree; judge ONLY the owned files below. You may edit nothing and run no git command that changes the tree.

1. Read the design ${d.pkg.design} and the decisions below. 2. Read the implementer's report (below). 3. Run \`git diff -- <owned files>\` and \`git status --short\` and read every changed owned file in full. 4. Run each owned test file with \`node --test --experimental-strip-types <file>\` and \`npx biome check --error-on-warnings <owned source/test files>\`; record exact exit codes. 5. Try hard to refute: does the change do what the design and the decisions require (not more, not less)? Does any edit land outside the owned files? Any silent catch, shim, alias, hard-coded model id, missing "K-π " prefix, renamed bound test title, docs edit, or a hand-over hunk that was not applied? Does a new test actually exercise the behaviour? For board-live: paint the compact widget and the full overlay at 200/120/80/60 columns with a scratch script (PLAIN_PALETTE) and check every required field survives and no framed line exceeds the width; for onboarding: drive runOnboarding with a scripted UI in a temp agent dir and confirm skipped steps write nothing.
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