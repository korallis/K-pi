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
