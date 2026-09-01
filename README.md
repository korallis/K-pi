# K-π (`k-pi`)

K-π is a first-party Pi package for a gated or autonomous engineering loop: specify, research, plan, implement, test, bounds, isolated review, and one local ship commit.

## Install

Requires Node 22.19 or newer and `@earendil-works/pi-coding-agent >=0.84.0`. CI and this repository test against `0.84.4`.

```sh
pnpm install
pi install -l ./
```

After trusting the package, `/login` includes the first-party Cursor provider. Cursor begins with the documented bootstrap fallback `cursor-small`; `refreshModels` replaces that list from the live service. Official provider catalogs are never frozen. Refresh them with:

```sh
pi update --models
```

## Workflows

```text
# WF-01: gated task
/kpi add a healthcheck; verify GET /health returns 200

# WF-02: frozen plan
/kpi --plan specs/healthcheck/

# WF-03: executable autopilot
/kpi --mode autopilot add /health; check: curl -fsS localhost:3000/health

# WF-04: inspect or stop
/kpi status
/kpi stop

# WF-05: account pools
/accounts login anthropic home
/accounts login openai-codex work
/accounts
```

A bare non-command goal starts gated `/kpi` with sticky K-mode when automatic wrapping is enabled. `/kpi off` restores plain Pi input. `/k-mode off` disables K-mode.

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

Secrets stay in `~/.pi/agent/accounts.secrets.json` with mode `0600`; never commit it.

## K-stack and research

Run `/setup-kstack` to map only models in Pi's live configured registry, then optionally save Exa and Perplexity keys. `/k-mode <task>` selects a local K-stack playbook. Research artifacts are mandatory before implementation; without keys, K-π performs local repository research.

## Read-only print profile

The package treats Pi's one-shot print mode as a read-only profile. It keeps only `read`, `grep`, `find`, and `ls`; `write` and `edit` are always excluded in v1.

```sh
pi -p "Summarize this repository"
cat README.md | pi -p "Review these instructions"
```

## Unattended and containers

Autopilot is unattended only for machine-executable acceptance criteria. It may create one local commit after deterministic approval; it cannot push, deploy, force-push, run production migrations, or add undeclared runtime dependencies. Process-level policy is not an operating-system sandbox. Use Docker or Gondolin when filesystem, network, or process isolation is required.

## TUI honesty

The status board guarantees information, not pixel identity: K-π, MODE, JOB, ROUND, stages 01–08, PASS/FAIL, six file lamps, GATE, and STOP. Narrow terminals may wrap. Human approval switches to the protocol-blue theme and shows the pending question.

## Non-goals

K-π does not fork Pi, install community account/provider packs, replace official model catalogs, run remote hosted workers, merge origin branches, or claim in-process hooks are an OS sandbox.

Visual reference: https://x.com/av1dlive/status/2092622516544270781
