---
name: kpi-release-process
description: "How K-π releases actually work as of 2026-09-03 — tag-driven release.yml with npm trusted publishing, the gotchas that broke the first OIDC publish, the removed two-day npm release-age rule, and the full version-bump checklist"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5bab7cfd-2837-4d6a-a3a8-7a93dfef5a77
  modified: 2026-09-03T10:29:35.900Z
---

K-π publishes `@korallis/k-pi` from `.github/workflows/release.yml` on a `v<version>` tag that must equal `packages/coding-agent/package.json#version`. First OIDC release was 0.2.0 on 2026-09-03 (0.1.0 had been published by hand). 0.2.1 shipped 2026-09-03 (PRs #14, #15; tag v0.2.1; release run 33748075241): a job now pushes only `kpi/<job>` and opens a PR. The advisory AI review re-raises minors every round; the working rule was merge once a review has no [major].

Gotchas learned the hard way:
- npm trusted publisher on npmjs.com: Organization/user `korallis`, Repository `K-pi` (bare name, case-sensitive; a full URL there makes npm fail the OIDC exchange silently and `npm publish` returns E404 on PUT with no provenance in the notice), workflow `release.yml`, environment blank, "Allow npm publish" checked.
- On the Node 22.22.x toolcache, `npm install -g npm@11` in place dies with MODULE_NOT_FOUND; release.yml installs npm 11 into `$RUNNER_TEMP/npm11` and prepends it to GITHUB_PATH.
- Repo `.npmrc` used to set `min-release-age=2` (only versions ≥2 days old installable); removed 2026-09-03 (PR #16) so a fresh `@korallis/k-pi` resolves at once. Dependency bumps are no longer age-gated.
- Version bump touches: root + coding-agent `package.json`, `package-lock.json` (root name/version twice, `packages/coding-agent` entry, and the evals `^x.y.z` range), `packages/evals` range, `test/cli-smoke.test.ts` (two asserts), `scripts/verify-built-harness.mjs` (regex + message), `docs/uat.md` UAT-01, README verify-built line.
- `test/harness.test.ts` compares `src/kpi` resources byte-for-byte with `dist/kpi`: after editing graphs/templates/prompts/skills, rebuild `packages/coding-agent` (`npm run build` there) or `test:kpi` fails on a stale dist.
- `docs/traceability-map.json` is generated (`node scripts/generate-traceability-map.mjs`) from titles hard-coded in the generator; renaming a test title breaks `test/traceability.test.ts` until the generator is updated and the map regenerated.

**Why:** three release runs failed before these were found. **How to apply:** for the next release, bump the version through the checklist, rebuild dist, run `npm run check`, `npm run test:kpi`, `npm run verify:built`, PR, tag the merge commit, and expect `release.yml` to publish with provenance; verify with `npm view @korallis/k-pi versions` and a scratch `npm install`. See [[kpi-fixes-queue-2026-09]].
