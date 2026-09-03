# UPSTREAM.md — K-π's fork contract with Pi

K-π is a **maintained fork** of [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). This file is the normative policy for how that fork tracks, merges, and diverges from upstream. If a code change contradicts this file, the change is wrong unless this file is updated with it.

## 1. Pinned base

| Fact | Value |
|---|---|
| Upstream project | Pi, by Mario Zechner / Earendil Works |
| Upstream repository | `https://github.com/earendil-works/pi.git` |
| Pinned base version | `v0.84.4` |
| Pinned base commit | `b79e4cc834970cca69daebffab7df1da7d1e52c4` (`Release v0.84.4`) |
| Fork origin | `https://github.com/korallis/K-pi.git` |
| Upstream license | MIT — see `LICENSE` and `NOTICE` |
| Machine-readable pin | `upstream.json` at the repository root |
| Drift report | `npm run upstream:check` (read-only; `-- --offline` in CI) |

The entire upstream monorepo under `packages/` is **K-π source**. It is not a dependency, not a peer dependency, and not something an operator installs separately. K-π builds and ships it.

`upstream.json` is the single machine-readable source for the repository URL, tag, commit, and remote name. When §1 changes, `upstream.json` changes in the same commit. `npm run upstream:check` reports drift and never mutates the tree; the weekly `.github/workflows/upstream-drift.yml` runs it and never merges, publishes, releases, or opens a PR.

## 2. Remotes

```sh
git remote -v
# origin    https://github.com/korallis/K-pi.git      (fetch/push)
# upstream  https://github.com/earendil-works/pi.git  (fetch/push)
```

`upstream` is fetch-only in practice. Never push to `upstream`.

## 3. Preserved upstream-compatible namespaces

Workspace packages keep their upstream names — `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-protocol`, `@earendil-works/pi-client`, and siblings.

This is **merge hygiene, not a dependency claim**. Keeping the internal names means an upstream release diff applies with minimal conflict. It does not mean K-π requires, resolves, or downloads anything from npm under those names, and no document may describe them as external requirements of K-π.

Renaming a workspace package is a breaking merge cost. Do not do it without recording the decision here.

## 4. What K-π owns

| Area | Rule |
|---|---|
| `packages/coding-agent/src/kpi/**` | K-π-only source: extensions, graphs, prompts, schemas, skills, templates, themes, K-stack. Upstream never touches it, so it never conflicts. |
| `packages/coding-agent/package.json` | Fork identity: `bin` is `kpi` + `k-pi`, `piConfig` is `{ name: "kpi", title: "K-π", configDir: ".kpi" }`. Expect a conflict here on every upstream bump; resolve in K-π's favour. |
| Root `package.json` | `k-pi-monorepo`, private, npm workspaces. K-π's own `pack` script (`node scripts/pack-kpi.mjs`); upstream publish, version, and shrinkwrap scripts stay removed. |
| Root `test/**` | K-π's node tests, importing `../packages/coding-agent/src/kpi/...`. |
| Root product docs | `README.md`, `AGENTS.md`, `START-HERE.md`, `docs/**`, `design/**`, this file, `NOTICE`. |
| Everything else under `packages/` | Upstream code. Patch it only when K-π genuinely needs the behaviour; record the patch in §6. |

## 5. What K-π never imports from upstream

Do not copy, sync, or resurrect any of these from the upstream tree:

- Upstream `.github/**` — workflows, issue and PR templates, governance, auto-close bots, release automation. K-π has its own workflows; none of them are upstream's.
- Publish and release tooling: `scripts/publish*.mjs`, `scripts/release*.mjs`, `scripts/local-release.mjs`, `scripts/publish-release-announcement*`, npm shrinkwrap/install-lock publish gates. K-π's own distribution path is `scripts/pack-kpi.mjs` plus `.github/workflows/release.yml`; neither comes from upstream, and neither weakens this exclusion.
- `CONTRIBUTING.md`, code of conduct, funding, and community policy files.
- Anything that advertises this tree as the official Pi distribution.

K-π's CI is adapted from Ray Fernando's Actions templates, plus the fork-integrity guard `scripts/check-ci-contract.mjs`. The guard keeps every write escalation on an exact-path allowlist — `release.yml` (npm publish, GitHub release, `id-token`), `auto-merge.yml` (queued merge), `ai-review.yml` (pull-request comment) — and forbids `git push`, long-lived registry tokens, `pull_request_target`, and upstream governance workflows. It also requires `check.yml` and `release.yml` to exist, and blocklists every retired review workflow by exact filename — `cursor-review.yml` and the two that NH-04 deleted — so removing the gate or resurrecting a retired reviewer fails `check` instead of passing quietly. The guard is the contract; the templates are where the workflows came from. Upstream CI is not adopted.

## 6. Sync procedure

Upstream releases are reviewed, never auto-merged.

```sh
git fetch upstream --tags
git log --oneline b79e4cc834970cca69daebffab7df1da7d1e52c4..upstream/main -- packages/
git checkout -b upstream/v<next>
git merge v<next>          # upstream release tag
```

Review rules:

1. **Read the diff before resolving.** An upstream refactor that moves a hook K-π depends on is a behaviour change even when it merges cleanly.
2. **Fork identity always wins** in `packages/coding-agent/package.json`: `bin`, `piConfig`, and the removal of the `pi` bin are K-π's, permanently.
3. **Built-in registration always wins.** Upstream may add or reorder built-in extensions; K-π's extension factory must stay registered and visible after the merge.
4. **`src/kpi/**` is never resolved against upstream** — upstream has no opinion there.
5. Build, run the gates, and launch the built `kpi` binary before the merge lands. A clean textual merge is not evidence:

   ```sh
   npm ci --ignore-scripts
   npm run build:offline
   npm run check && npm test && npm run test:kpi
   node packages/coding-agent/dist/bundle/cli.js --version
   ```

6. Update §1's pinned version and commit, and `upstream.json`, in the same change. A merged upstream release with a stale pin is an incomplete merge.
7. Record every upstream file K-π had to patch, and why, in the register below.

### Patched upstream files

Verified against `git diff b79e4cc..worktree`, upstream-owned paths only. `src/kpi/**`, root `test/**`, `docs/**`, `design/**`, `fixtures/**`, and the new root files (`UPSTREAM.md`, `NOTICE`, `START-HERE.md`, `upstream.json`, CI guard scripts) are K-π-owned and never conflict; they are not listed here.

**Fork identity — `packages/coding-agent/` (high risk: expect a conflict per release; K-π always wins)**

| File | Patch |
|---|---|
| `package.json` | Version `0.1.0` (fork versions, decoupled from upstream `0.84.x`). `bin` is exactly `kpi` + `k-pi`; the `pi` bin is gone. `piConfig` is `{ name: "kpi", title: "K-π", configDir: ".kpi" }`. Publish metadata is removed. The build cleans `dist` first and copies K-π's runtime assets into `dist/kpi`. |
| `src/config.ts` | Adds the `piConfig.title` reader (`APP_TITLE` = `K-π`) and `getKpiResourceDir()`, resolving the K-π resource root identically across Bun binary (`kpi/` beside the executable), Node dist (`dist/kpi/`), and tsx source (`src/kpi/`). |
| `src/extensions/index.ts` | Registers the K-π extension factory as a **visible** built-in (`{ name: "k-pi", factory: kpiExtension }`) ahead of upstream's hidden `llama.cpp` entry. Upstream reordering here must not drop it. |
| `src/cli.ts` | `AI_AGENT` env uses `APP_NAME` instead of literal `"pi"`; sets `PI_SKIP_VERSION_CHECK` for any non-`pi` identity so the inherited release check cannot advertise upstream Pi builds to a K-π user. |
| `src/rpc-entry.ts` | Same `AI_AGENT = APP_NAME` substitution for the RPC entry. |
| `src/cli/args.ts` | Help text: `update` usage line derives from `APP_NAME` and drops the literal `pi` target. |
| `src/core/model-registry.ts` | Exposes the existing runtime-owned `login()` operation so K-π pooled login can use provider OAuth while preserving official auth storage and refresh semantics. No catalog is overlaid. |
| `src/core/agent-session.ts` | Exposes the finalized assistant provider error to graph sessions and retries an error only when K-π's account extension diagnostic proves the route already moved to another healthy slot/model. |
| `src/modes/interactive/interactive-mode.ts` | Subscription OAuth for a K-π pool delegates `/login` to the built-in pooled account command; non-pool OAuth and API-key login keep upstream behavior. |
| `src/package-manager-cli.ts` | **Narrow self-update guard, no machinery deleted.** Every self-update form (`update --self`, `update --all`, `update self`, `update pi`, bare `update`) is rejected locally before any network or package-manager work, because self-update resolves the upstream Pi release and K-π is never distributed through pi.dev or a registry. `update --extensions` and `update --models` still work. The update machinery itself is untouched so upstream changes to it merge normally. |
| `test/package-command-paths.test.ts` | Project fixtures and command help derive from `CONFIG_DIR_NAME`/`APP_NAME`. Upstream self-update cases remain gated behind `APP_NAME === "pi"`, so they resurrect on an upstream merge; K-π's local self-update refusal remains active. |
| `test/{credential-print,package-distribution,session-file-invalid,session-manager/file-operations,stdout-cleanliness}.test.ts` | Branding and executable assertions derive from the fork identity; distribution asserts exactly the `kpi` and `k-pi` bins. |
| `test/{package-manager,resource-loader,settings-manager,settings-manager-bug,trust-manager,theme-export,theme-picker}.test.ts` | Project config fixtures derive from `CONFIG_DIR_NAME`; user-dir environment fixtures derive from `ENV_AGENT_DIR`. No runtime assertion uses upstream's `.pi` path. |
| `test/suite/regressions/{2781-skill-collision-precedence,2791-fswatch-error-crash,8337-utf8-bom-parsing}.test.ts` | Regression fixtures derive project resource paths from `CONFIG_DIR_NAME`. |
| `test/first-time-setup.test.ts` | Keeps upstream's first-time-setup mechanics tested under the official Pi identity and explicitly proves that the rebranded K-π distribution does not enter Pi's analytics/theme onboarding. |
| `test/agent-session-concurrent.test.ts` | Uses in-memory credentials and condition-based streaming waits; this suite tests session concurrency, not auth-file revisions or scheduler timing. |
| `test/agent-session-retry.test.ts` | Proves a quota refusal is retried only when K-π's pooled-account diagnostic states that routing already moved; an unchanged exhausted route is not retried. |
| `test/version-check.test.ts` | Clears the inherited `PI_SKIP_VERSION_CHECK` before each case and restores it afterward, so K-π's parent process cannot make upstream's version-check unit cases order- or environment-dependent. |
| `vitest.config.ts` | Excludes the vendored K-stack subtree (its maintainer tests target Bun, not Vitest) and caps workers at four so filesystem-watcher contracts are not invalidated by per-process watcher exhaustion. |
| `tsconfig.build.json` | Excludes `src/kpi/kstack/{generated,upstream,overlay,scripts}` from the package build. |

**TUI renderer — `packages/tui/`**

| File | Patch |
|---|---|
| `src/tui-main-screen.ts` | Forces one full redraw when a growing live region first exceeds the terminal height, preventing the animated working row from being committed repeatedly into scrollback as reasoning or tool rows arrive. |
| `test/tui-render.test.ts` | Reproduces the five-row-to-six-row overflow with a working spinner and proves the transition clears before drawing the new frame. |

**Dependency refresh (2026-09-02, `fixes.md` FX-04)**

Every `packages/*/package.json`, the example-extension manifests and the root manifest pin newer versions than upstream `v0.84.4` (TypeScript 7 native `tsc` replaces `@typescript/native-preview`; openai 7, @google/genai 2, @anthropic-ai/sdk 0.122, highlight.js 11, diff 9, chalk 6, hosted-git-info 10, proxy agents 9, @xterm/headless 6, Biome 2.5, and every patch bump the registry's two-day release age allowed). On an upstream merge keep the higher version of each dependency and re-run FX-04's verification. Source patches the bump forced, all minimal:

| File | Patch |
|---|---|
| `packages/ai/src/api/google-shared.ts` | `FinishReason.TOO_MANY_TOOL_CALLS` added to the exhaustive stop-reason switch (@google/genai 2). |
| `packages/ai/src/api/openai-responses.ts` | Dropped the local `prompt_cache_options` type intersection; openai 7 types it. |
| `packages/ai/src/api/openai-codex-responses.ts` | Request body typed `Uint8Array<ArrayBuffer>` so it satisfies `BodyInit` under the newer fetch typings. |
| `packages/coding-agent/src/utils/syntax-highlight.ts` | highlight.js 11 `exports` subpaths (`lib/core`, `lib/languages/*`, root for the lazy all-languages load); `highlight-js.d.ts` deleted because v11 ships types. |
| `scripts/build-coding-agent-bundle.mjs` | `kerberos` allowlisted as an optional native external (proxy agents 9); bundle target `node22.22`. |
| `scripts/check-browser-smoke.mjs` | Stubs `node:fs`/`node:path` for `@anthropic-ai/sdk` only (its lazily imported credential-profile chain); K-π packages still must not touch Node builtins. |
| `scripts/check-ts-relative-imports.mjs` | Scans source text instead of the compiler API, which TypeScript 7 does not ship. |
| `tsconfig.base.json` | `target`/`lib` ES2024 (regex `v` flag under TS 7); unused `experimentalDecorators`/`emitDecoratorMetadata` removed. |
| `biome.json` | Biome 2.5 migration; `complexity/useOptionalChain` and `correctness/noUnsafeOptionalChaining` off because they flag 38 sites in upstream-owned files. |
| `package.json` `overrides.vitest` | One vitest for the whole tree; `vitest-evals` otherwise nests 4.1.9 and splits the `TaskMeta` augmentation. |
| `packages/coding-agent/test/mermaid.test.ts` | The two fallback fixtures use the invisible link `~~~`, which grok-mermaid 0.2.3 still drops with a warning; it now renders the `:::class` syntax they used before. |

**Root build system (medium risk: upstream edits these every release; resolve hunk-by-hunk, keeping K-π's workspace shape and the publish removals)**

| File | Patch |
|---|---|
| `package.json` | `k-pi-monorepo`, version `0.1.0`, MIT licence + fork repository URL. Publish, release, version, shrinkwrap/install-lock, and model-catalog pipeline scripts removed; `check` retains biome, pinned-deps, ts-imports, `tsgo --noEmit`, browser-smoke. `test:kpi` added for the root K-π tests, and `pack` for K-π's own tarball. |
| `package-lock.json` | Follows the manifest (name/version churn, removed script deps). Regenerate on merge; never hand-resolve. |
| `tsconfig.json` | Adds root `test/**/*.ts` to `include` (K-π's node tests live at the repo root and import `packages/coding-agent/src/kpi/...`). |
| `biome.json` | Adds root `test/**` to the checked set; ignores `src/kpi/kstack/{generated,upstream}` (vendored/generated trees are not lint subjects). |
| `.gitignore` | Ignores `.kpi/` (and pre-rebrand `.pi/`) project-local runtime state instead of upstream's maintainer-specific entries. |
| `.github/workflows/{ai-review,auto-merge,check,queue-stall-alarm,release,upstream-drift}.yml` | K-π-owned CI; the status context a workflow emits is its job name, which is what branch protection matches. `ai-review` → `AI review (advisory)`: z.ai review that comments and never blocks, and is never added to the required set. `auto-merge` → `enable`: green-only queued merge. `check` → `check`: adapted Ray Fernando hard verification on the self-hosted macOS runners, and the only required status check. `queue-stall-alarm` → `detect`: hosted watchdog for a stalled runner queue. `release` → `release`: tag-driven `@korallis/k-pi` publish with provenance from a GitHub-hosted runner. `upstream-drift` → `drift`: read-only weekly drift report. CI reads pre-provisioned GitHub secrets only (`ZAI_API_KEY`, variable `AI_REVIEW_MODEL`); it never calls 1Password or depends on an operator laptop. `scripts/check-ci-contract.mjs` keeps every write-enabled workflow on exact-path allowlists, forbids runtime 1Password access and obsolete Cursor credentials/workflows, and blocks pushes, long-lived registry tokens, `pull_request_target`, and upstream governance automation. Never merge upstream CI content into these files. |
| `pi-test.sh` → `kpi-test.sh` (+ `.ps1`, `.bat`) | Source-runner rename; `.bat` also edited for the new name. Git tracks these as renames, so upstream changes to `pi-test.*` follow to the new names with `merge.renames` on. |
| `packages/evals/package.json` | Workspace dependency range follows the fork version (`^0.1.0` instead of `^0.84.4`); corrected 2026-09-02, it had silently stayed at `^0.84.4` and made `npm ls` report the workspace invalid. |
| `AGENTS.md`, `README.md`, `packages/coding-agent/README.md` | Root docs replaced by K-π's authority docs; the package README keeps upstream's reference body under a fork banner (low risk — regenerate the banner side, take upstream's body updates). |

**Deleted upstream files (§5 policy; on merge, resolve as deleted — do not resurrect)**

- Upstream `.github/**` in full: workflows, issue/PR templates, approved-contributors gate, issue-triage/analysis bots, npm-audit, build-binaries, publish-model-catalog, and pr/issue gates.
- Publish and release tooling in `scripts/`: `publish*.mjs`, `release*.mjs`, `local-release.mjs`, `release-notes.mjs`, `release-packages.mjs`, `publish-release-announcement*`, `sync-versions*`, `generate-coding-agent-{shrinkwrap,install-lock}.mjs`, `package-workspaces.mjs`, `publish-model-catalog.mjs`, `diff-model-catalog.mjs`, `check-lockfile-commit.mjs`, `build-binaries.sh`, `create-source-archive.sh`.
- Governance and maintainer files: `CONTRIBUTING.md`, `SECURITY.md`, `.husky/pre-commit`, `tui-plan.md`, upstream's `.pi/` maintainer extensions/prompts/skills.

The generated model-data snapshot under `packages/ai` is **unchanged** from the base — catalog regeneration is not part of the fork surface.

Keep this register honest. An undocumented upstream patch is a merge trap for the next person: verify it after every upstream merge with `git diff <base-tag> --name-status` filtered to upstream-owned paths.

## 7. Base drift assessment

Standing assessment of the pin against upstream. Re-run the commands and rewrite
this section whenever the pin is considered; it is a dated reading, not a policy.

**As of 2026-09-02, against `upstream/main` at `96317e50b8d6e7f6d0e47fd29122baf1461c00f5`.**

`v0.84.4` is still the newest upstream release tag. `git fetch upstream --tags`
then `git tag -l --sort=-v:refname | head -3` returns `v0.84.4`, `v0.84.3`,
`v0.84.2`; there is no `v0.85`. The pin is on the latest release, and the 13
commits `main` carries beyond it are unreleased work behind an open
`[Unreleased]` changelog heading. Moving to them would pin the fork to an
untagged commit, which §1 and `upstream.json` do not describe and §6 step 6 does
not permit.

**Distance.** 13 commits, 49 files, +1024/-104, spanning 2026-08-28 to
2026-09-02.

**Overridden surfaces.** Of the surfaces K-π reaches into, the delta touches
only provider transport and the interactive component tree:

| Surface | Touched | Collides with a K-π patch |
|---|---|---|
| Provider transport (`packages/ai/src/api/**`, proxy, dispatcher) | yes | 3 files, non-overlapping hunks |
| Interactive components (`modes/interactive/components/**`) | yes, 5 selectors | no — K-π patches `interactive-mode.ts` and `theme/theme-controller.ts` |
| Agent session | `agent-session-runtime.ts`, 4 lines | no — K-π patches `agent-session.ts` |
| Resource loader | no | — |
| Footer and theme lifecycle | only the theme picker's list rendering | no |
| RPC | no | — |

**Dry merge.** `git merge-tree --write-tree --messages HEAD upstream/main`
reports exactly one conflict: `.github/APPROVED_CONTRIBUTORS`, modify/delete.
§6 already resolves it — upstream `.github/**` is deleted in full, including the
approved-contributors gate, and is not resurrected. The three provider-transport
files auto-merge: K-π's edits there thread the `onResponse` callback, upstream's
bump a user-agent constant and add a `supportsMaxOutputTokens` compat flag, and
the two sets never touch the same lines. Everything else merges clean.

**What a bump would buy.** Two items earn their keep. `fix(tui): wrap SIGWINCH
self-signal` stops a startup crash under restricted seccomp, which K-π's own
operator manual invites by recommending Docker or Gondolin for isolation.
`supportsMaxOutputTokens` unblocks Codex-protocol gateways that reject
`max_output_tokens`, which reaches K-π's `openai-codex` pool — local pools are on
the `openai-completions` client and are unaffected. The rest is proxy matching,
terminal detection, tool `cwd` handling, selector polish, and a theme-picker
checkmark that happens to suit a fork shipping two themes.

**Recommendation: hold the pin.** Nothing here is a security fix, and none of it
is release-tagged. Bump when upstream tags `v0.85.0`, take the whole tagged tree
in one reviewed merge per §6, and treat the SIGWINCH fix as the reason to do it
promptly rather than to do it early. If a container operator hits the seccomp
crash before that tag lands, cherry-picking `605a1b038` alone is a narrower and
more honest change than moving the base.

## 8. Divergence budget

Fork upstream files only when the alternative is worse. In order of preference:

1. Put the change in `src/kpi/**`.
2. Use an existing upstream extension point.
3. Add a narrow, upstream-shaped extension point and patch it in (a candidate to send upstream).
4. Fork the file, and record it in §6.

Every entry in §6 is a recurring cost paid on every upstream release.

## 9. Attribution

Pi is MIT-licensed. The upstream copyright and licence text are preserved in `LICENSE`, and attribution is recorded in `NOTICE`. Removing either is a licence violation. K-π is not affiliated with, endorsed by, or supported by the Pi maintainers; do not file K-π issues upstream.
