# K-π (`kpi`)

**K-π is a standalone terminal coding agent — a maintained fork of [Pi](https://github.com/earendil-works/pi), not a plugin for it.**

This repository is the whole harness: TUI, agent loop, providers, sessions, tools, RPC. On top of that base, K-π compiles in its own gated or autonomous engineering loop — specify, research, plan, implement, test, bounds, isolated review, and one local ship commit.

You do not install Pi. There is no `pi install`, no peer dependency, and no package to trust. You build this repository and run `kpi`.

| | |
|---|---|
| Executable | `kpi` (alias `k-pi`) |
| Project config | `.kpi/` |
| User config and secrets | `~/.kpi/agent/` |
| Environment overrides | `KPI_CODING_AGENT_DIR`, `KPI_CODING_AGENT_SESSION_DIR` |
| Upstream base | Pi `v0.84.4`, commit `b79e4cc834970cca69daebffab7df1da7d1e52c4` |
| Upstream remote | `upstream` → `https://github.com/earendil-works/pi.git` |
| Licence | MIT — see [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), [`UPSTREAM.md`](UPSTREAM.md) |

## Architecture

```
kpi (this repository, one process)
├── packages/**                    forked Pi harness — K-π source, not a dependency
│   └── coding-agent/
│       ├── src/**                 upstream harness: TUI, agent loop, providers, sessions, RPC
│       └── src/kpi/**             K-π: control plane, graph engine, accounts, K-stack, resources
└── test/**                        K-π's node tests
```

K-π's commands, prompts, skills, themes, and graphs are **built in**. The control plane is registered as a visible built-in extension and its resources are discovered by that built-in and copied into `dist`, so `/kpi`, `/accounts`, `/k-mode`, and `/setup-kstack` exist the moment the binary starts — no install step, no manifest, no trust gate. Project trust still governs a *user's* repo-local resources, exactly as in the base harness; it never gates K-π itself.

Workspace packages keep their upstream `@earendil-works/pi-*` names. That is merge hygiene so upstream releases apply cleanly — it is not a dependency on Pi. Nothing under those names is fetched at build or run time.

## Build and run

Requires Node 22.19 or newer. The repository uses npm workspaces.

```sh
git clone https://github.com/korallis/K-pi.git
cd K-pi
npm install
npm run build
```

Run the built harness:

```sh
node packages/coding-agent/dist/bundle/cli.js
```

Or put `kpi` and `k-pi` on your `PATH`:

```sh
npm link --workspace @earendil-works/pi-coding-agent
kpi
```

To run from source without building, use `./kpi-test.sh` (`kpi-test.ps1` / `kpi-test.bat` on Windows).

`/login` includes the first-party Cursor provider. Cursor begins with the documented bootstrap fallback `cursor-small`; `refreshModels` replaces that list from the live service. Official provider catalogs are never frozen. Refresh them with:

```sh
kpi update --models
```


## Verify the built product (RP-19)

After `npm run build:offline`:

```sh
npm run verify:built
node scripts/verify-product.mjs --skip-gates --json .kpi/remediation-proof.json
```

`verify:built` starts the built `kpi` binary under a temporary `HOME` and `KPI_CODING_AGENT_DIR`, checks the `dist/kpi` inventory, and exercises `--mode rpc` offline with no install or trust step.

`verify:product` re-runs M-01–M-07 against fixtures and live hooks, writes secret-free evidence under `.kpi/proof/`, wires `.kpi/uat/<UAT-ID>/` (rows not executed here), and emits `.kpi/remediation-proof.json`. Feature failures name the owning `RP-##` — they are not fixed inside the proof scripts.

Full local gate list (also what closes RP-19):

```sh
npm run check
npm test
npm run test:kpi
npm run kstack:sync:check
npm run upstream:check -- --offline
npm run build:offline
npm run verify:built
node scripts/verify-product.mjs --json .kpi/remediation-proof.json
```

## Workflows

```text
# WF-01: gated task
/kpi add a healthcheck; verify GET /health returns 200

# WF-02: frozen plan
/kpi --plan specs/healthcheck/

# WF-03: executable autopilot
/kpi --mode autopilot add /health; check: curl -fsS localhost:3000/health

# WF-03b: operator budget caps (freeze onto task.limits → graph EXHAUSTED)
/kpi --max-cost-usd 1.5 --mode autopilot <goal>   # stop when session usage×rates hit USD
/kpi --timeout-ms 600000 --mode autopilot <goal>  # wall-clock job cap
/kpi --max-rounds 3 --mode autopilot <goal>       # coding-loop round cap
# Flags compose with --mode / --plan / --until-green / --no-network.
# Local pools stay $0 (AC-27.6); maxCostUsd meters non-local catalog spend only.

# WF-04: inspect, stop, or audit
/kpi status
/kpi stop
/kpi verify              # recompute this job's events.jsonl hash chain

# WF-05: account pools
/accounts login anthropic home
/accounts login openai-codex work
/accounts

# WF-06: offline research
/kpi --no-network add /health   # composes with --mode, --plan, --until-green
```

A bare non-command goal starts gated `/kpi` with sticky K-mode when automatic wrapping is enabled. `/kpi off` restores plain harness input. `/k-mode off` disables K-mode.

`/kpi verify [job-id]` recomputes the RFC 8785 canonical hash of every record in
`.kpi/runs/<job>/events.jsonl` and names the first line that does not chain. It
reads no model and changes nothing.

`/append-system` installs K-π's concise-output system prompt at
`~/.kpi/agent/APPEND_SYSTEM.md`. A fresh agent directory gets it on first run; an
existing file is yours and is only replaced if you confirm.

## Accounts and billing

`/accounts login <provider> [slot]` adds subscription or key slots without replacing siblings. Supported cloud families include Anthropic, OpenAI Codex, xAI, z.ai, Kimi Coding, and Cursor. The default fallback chain is Anthropic → OpenAI Codex → xAI → z.ai → Kimi Coding → Cursor. Local pools are opt-in.

Anthropic login shows this warning before OAuth:

> Claude Pro/Max in this harness uses Anthropic’s subscription OAuth, same as Pi and Atomic.
>
> Anthropic’s own docs: third-party harness usage draws from extra usage and is billed per token, not against the in-app Claude plan bar.
>
> API keys (ANTHROPIC_API_KEY) are a separate pay-as-you-go path.
>
> You are responsible for the seats you attach.
>
> Continue?

Secrets stay in `~/.kpi/agent/accounts.secrets.json` with mode `0600`; never commit it.

## K-stack and research

Run `/setup-kstack` to map only models in K-π's live configured registry, then optionally save Exa and Perplexity keys. `/k-mode <task>` selects a local K-stack playbook. Research artifacts are mandatory before implementation; without keys, K-π performs local repository research.

## Read-only print profile

K-π treats one-shot print mode as a read-only profile. It keeps only `read`, `grep`, `find`, and `ls`; `write` and `edit` are always excluded in v1.

```sh
kpi -p "Summarize this repository"
cat README.md | kpi -p "Review these instructions"
```

## Unattended and containers

Autopilot is unattended only for machine-executable acceptance criteria. It may create one local commit after deterministic approval; it cannot push, deploy, force-push, run production migrations, or add undeclared runtime dependencies. Process-level policy is not an operating-system sandbox. Use Docker or Gondolin when filesystem, network, or process isolation is required.

## TUI honesty

The status board guarantees information, not pixel identity: K-π, MODE, JOB, ROUND, stages 01–08, PASS/FAIL, six file lamps, GATE, and STOP. Narrow terminals may wrap. Human approval switches to the protocol-blue theme and shows the pending question.

## Tracking upstream

K-π tracks Pi through the `upstream` git remote. Releases are fetched, reviewed, and merged deliberately; fork identity and the built-in registration always win. Full policy, patched-file register, and sync procedure: [`UPSTREAM.md`](UPSTREAM.md).

**External GitHub fork PRs do not run the self-hosted `check` gate.** Untrusted fork heads never schedule on the persistent Mac runner. Outside contributors need a maintainer-owned branch in `korallis/K-pi` (push access or a maintainer-created branch from the fork tip) so `pull_request` heads stay same-repository. The workflow does not use `pull_request_target` and does not expose secrets to PR code.


## Non-goals

K-π does not install community account/provider packs, replace official model catalogs, run remote hosted workers, merge origin branches, publish itself to npm, or claim in-process hooks are an OS sandbox. It is a fork, so it also does not pretend to be the official Pi distribution: bugs found here go to this repository, not upstream.

Visual reference: https://x.com/av1dlive/status/2092622516544270781
