# K-stack

**Normative.** K-stack is k-pi’s forked, rebranded engineering skill pack. It is not a runtime dependency on Cursor pstack, open-pstack, or pi-pstack.

| Upstream | Ours |
|---|---|
| [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) MIT | first-party tree `kstack/` inside the k-pi package |
| `/setup-pstack` | `/setup-kstack` |
| `/poteto-mode` | `/k-mode` (sticky). Alias `/poteto-mode` may print “use /k-mode” once, then stop. |
| `poteto-agent` | `k-agent` |
| `~/.cursor/rules/pstack-models.mdc` | `~/.kpi/agent/kstack/models.json` |
| Cursor Cloud agents, Graphite `gt`, `/loop` sleeper | **forbidden** |
| cursor-team-kit `/deslop`, Bugbot | **forbidden** as deps |
| [ericlitman/open-pstack](https://github.com/ericlitman/open-pstack) | reference only |
| [kkgogogo17/pi-pstack](https://github.com/kkgogogo17/pi-pstack) | reference only |

Upstream says “fork it, make it yours.” We do. We never install those repos as packages; K-stack is vendored source inside K-π.

---

## 1. Why it exists here

K-stack vendors the MIT-licensed Cursor `pstack` plugin: a set of engineering principles, playbooks, and workflow skills. Attribution lives in the root `NOTICE` and in `kstack/UPSTREAM.md`, which is a licence obligation and stays. Upstream's `/poteto-mode` matches a task to a playbook, copies the steps into a todo list, and fires other skills as those steps need them; ours is `/k-mode`.

That is the missing middle of k-pi: our graph owns order and gates; the vendored skills supply node-local engineering technique. They are a library, not an authority — where a vendored skill contradicts `spec.md`, `PRD.md`, or `AGENTS.md`, ours wins and the vendored text is overlay-patched rather than obeyed.

```
operator
  /kpi          → graph (ac-compile → … → ship)
  /k-mode       → playbook + principles inside those nodes
  /setup-kstack → map roles onto models already wired in k-pi
```

A `/kpi` job without K-stack still runs the graph. A `/k-mode` task without a graph still gets rigor. Together they are the product: playbook steps must not skip graph gates.

---

## 2. Upstream stays source of truth

Cursor pstack remains **upstream**. Our edits are an overlay that is **replayed** onto every new pstack tree. We do not hand-merge forever. We never load pstack as a runtime package.

This is closer to [pstack-grok’s apply script](https://github.com/praveen221/pstack-grok/blob/main/UPSTREAM.md) than to [open-pstack’s manual commit review](https://github.com/ericlitman/open-pstack/blob/main/UPSTREAM.md), with invariants so a failed replay cannot ship.

### Layout

```
kstack/
  UPSTREAM.md                 # pinned repo, path, sha, upstream version
  upstream/                   # clean pstack tree. Generated. Do not edit.
  overlay/
    rename-map.json           # poteto-mode→k-mode, setup-pstack→setup-kstack, …
    transforms.ts             # deterministic rewrites (cloud strip, model wiring, graph principles)
    patches/0001-*.patch      # ordered leftover diffs quilt cannot express as transforms
    forbidden.txt             # strings that must not survive in generated/
  generated/                  # result of sync. This is what Pi loads.
  scripts/sync-kstack.ts
```

`UPSTREAM.md` shape (same idea as open-pstack’s table):

```md
| Source | https://github.com/cursor/plugins.git |
| Path   | pstack/ |
| Commit | <sha> |
| pstack tree | <tree id the pinned commit resolves to> |
| Upstream version | <plugin version if tagged> |
| K-stack overlay | <our overlay version> |
```

### Sync pipeline (`npm run kstack:sync`)

1. Sparse-fetch `cursor/plugins` `pstack/` at `--pin <sha>` or `origin/main`.
2. Replace `kstack/upstream/` with that tree (delete + copy). Never edit files in `upstream/` by hand.
3. Copy `upstream/` → working tree.
4. Run `transforms.ts` in order:
   - rename commands and agent ids per `rename-map.json`
   - replace Cursor `Task` / `subagent_type` with Pi isolated sessions
   - rewrite model defaults to role names resolved from `kstack/models.json`
   - strip Cursor Cloud owners, `gt submit`, Bugbot, cursor-team-kit requires, `/loop` sleeper
   - inject the four graph principles and the `never-block-on-the-human` override
   - retarget setup output to `~/.kpi/agent/kstack/models.json`
5. Apply `overlay/patches/*.patch` in sort order. **Stop the sync** if any patch fails. Do not ship a partial tree.
6. Write `kstack/generated/`.
7. Run invariants:
   - `forbidden.txt` matches in `generated/` → fail
   - every generated skill still has `name` + `description` frontmatter
   - `/setup-kstack` and `/k-mode` exist
   - package.json still has no pstack / open-pstack / pi-pstack dep
8. Update `UPSTREAM.md` sha + date.
9. If generated files changed, the command exits 2 so CI can open a PR. It does not push.

`npm run kstack:sync:check` is dry-run: fail if `generated/` would change, or if the pinned `pstack/` tree is not the tree `generated/` was produced from (used on main CI).

`npm run kstack:sync -- --pin <sha>` is the only way to move the pin.

### Drift is a tree, not a HEAD

The pin is content, not activity. `cursor/plugins` carries many plugins, so most of its commits never touch `pstack/`.

- `UPSTREAM.md` records the pinned commit **and the `pstack/` tree id that commit resolves to**. Drift compares the tree.
- Upstream repository HEAD moving while that tree id is unchanged is not drift. Report it as informational state: no PR, no CI failure, no pin change.
- A different `pstack/` tree id is a real update. Report it as available and still change nothing until a human moves the pin.
- Hand edits inside `generated/`, or transforms and patches that no longer reproduce those bytes, are local drift and fail `--check` whatever upstream is doing.

### What is automatic vs human

| Automatic | Human (`NEEDS_HUMAN`) |
|---|---|
| Fetch, copy, transforms, patches that apply cleanly | A patch rejects |
| Rename map hits | New upstream skill/playbook with no transform rule |
| Invariant grep | New cloud/gt primitive we have not banned yet |
| PR opened from CI weekly | Merge of that PR after reading the diff |

New upstream files land in `generated/` via the copy step. If they contain forbidden strings, sync fails until we add a transform. That is how “auto re-apply” stays safe.

### Runtime

`kstack/generated/` is the **sole runtime truth for K-stack**. Pi loads that tree for K-stack content and nothing else — not `upstream/`, not `overlay/`, not a hand-written K-stack skill parked elsewhere in the repo. Where two versions of a K-stack rule exist, the generated one is the rule.

K-π's own first-party skills under `packages/coding-agent/src/kpi/skills/` (`concise-output`, `context-pack`, `conventional-commit`, `isolated-review`, `minimalist`, `quality-gates`, `spec-first`, `tdd-cycle`) are a separate, deliberate tree. They are not K-stack, they are not generated, and this section does not ask for them to be moved or deleted.

Everything we add *to K-stack* reaches the runtime by being generated:

- First-party K-stack principles, playbooks, and agent guidance are overlay-owned inputs. They are not a second K-stack runtime tree standing beside `generated/`.
- A K-stack behaviour that lives only in a hand-maintained file or a hard-coded table in k-pi source is not part of K-stack. Move it into the overlay so sync emits it, or delete it.
- Overlay additions must be Pi-loadable once generated: valid frontmatter, unique names, support files carried with them.
- Editing `generated/` by hand is not a change. The next sync overwrites it and `--check` fails on it first.

Operators never see `upstream/`. The built `dist` carries `generated/` + `overlay/` + `UPSTREAM.md`; nothing here is published to a registry. Fetch happens in maintainer/CI, not when a user runs `/k-mode`.

Do not use a git submodule of `cursor/plugins` inside this repository. Fetch is a sync-time network call.

---

## 3. Commands

| Command | Behavior |
|---|---|
| `/setup-kstack` | Detect models. Print auto map from `model-ladder.md`. Apply or tweak. Then offer Exa and Perplexity keys (save either, both, or skip). Offer a project `verify-*` skill. |
| `/k-mode [task]` | Sticky rigor mode. Match a playbook, copy steps into the job todo, fire skills, stay on until `/k-mode off`. |
| `/k-mode off` | Clear sticky flag. |
| `/how` `/why` `/teach` `/recall` | Understanding skills. Read-only. |
| `/architect` | Isolated design node. Writes design notes, not production code. |
| `/arena` | N local isolated attempts, same brief, graft the best. Models from the panel list. Cap N = 2, the same `maxConcurrency` every other fan-out obeys (AC-20.4). |
| `/swarm` | Coverage fan-out. Cap 2 concurrent (k-pi `maxConcurrency`). Local only. |
| `/interrogate` | Isolated multi-model review → `verdict.json` shape. |
| `/tdd` | Same contract as k-pi `tdd-cycle` skill. |
| `/no-comments` | Comment-strip pass over the current diff. Deletes comments that restate the code; keeps comments a contract, an AC, or a named constraint requires. |
| `/unslop` | Strip AI tells from user-facing prose. |
| `/figure-it-out` | Author a one-off playbook when none match; store under `.kpi/kstack/playbooks/`. |
| `/show-me-your-work` | Append decisions to `.kpi/runs/<job>/decisions.tsv`. |
| `/create-verification-skill` | Project-local verify skill whose commands become `task.json.quality_gates`. |
| `/reflect` | After DONE, propose skill/playbook edits. Does not auto-merge them. |

`/kpi` remains the graph entry. If `/k-mode` is on when `/kpi` starts, the matched playbook is frozen into `task.json.playbook` and each playbook step is a named gate on the graph.

---

## 4. Model wiring — no cloud, no frozen slugs

`/setup-kstack` may only offer slugs returned by `ctx.modelRegistry.getAvailable()` that belong to a healthy k-pi pool (`anthropic`, `openai`, `openai-codex`, `xai`, `zai`, `zai-coding-cn`, `kimi-coding`, `cursor`, `llama`, `ollama`, `lmstudio`, `local-openai`).

It must not:

- offer Cursor Cloud Agent as a worker
- write `composer-*` or other Cursor-only hosted workers unless that slug is in the live registry
- hard-code `claude-fable-5-*`, `gpt-5.6-sol-*`, `grok-4.6-fast-*` as required defaults
- call Cursor Cloud wake chains or `run_in_background` cloud tasks

### `~/.kpi/agent/kstack/models.json`

```json
{
  "version": 1,
  "roles": {
    "implementer": "anthropic/<id>",
    "frontend": "kimi-coding/<id>",
    "judgment": "anthropic/<id>",
    "precise": "openai-codex/<id>",
    "fast": "xai/<id>",
    "review_panel": ["anthropic/<id>", "openai-codex/<id>"]
  },
  "inherit_parent": false
}
```

Roles with no line inherit the parent k-pi session model. `/setup-kstack` rewrites the whole file.

### Auto suggestion

Setup must print a proposed map before writing.

1. Intersect live registry with healthy pools.
2. For each role, walk the prefer list in `model-ladder.md`. First hit wins.
3. `review_panel` takes two different families, cap 3. UI slices use the `frontend` role (`kimi-k3` first).
4. Show: role → suggested slug → next-best → confidence.
5. Operator picks **apply** or edits any line, then write.
6. Never write a slug that failed the live filter, even if the ladder names it.

Hard-coded pstack ids are still forbidden as *required* defaults. The ladder is a suggestion table, not a lock.

Failover still goes through the k-pi accounts balancer. A K-stack role is a model id, not a slot. Slots stay in `accounts.json`.

---

## 5. Playbooks we keep, rewrite, or drop

Keep and rewrite for local Pi + graph gates:

| Playbook | Maps onto |
|---|---|
| investigation | isolated read-only graph, no ship |
| bug-fix | plan-check → implement → test → review |
| perf | same + bounds on allowed files + measured baseline in evidence.json |
| hillclimb | loop with maxRounds; each accepted win is one commit in gated/auto per mode |
| runtime-forensics | read-only then gated fix |
| feature | specify → plan → implement → test → review → ship |
| refactoring | plan → implement → test (behavior preserved) → review |
| prototype | isolated; no ship; write under `scratch/` |
| authoring-a-skill | writes under `kstack/skills/` or project skills |
| eval | fixtures in `fixtures/` |
| babysit | drive gates to green; **does not merge** |
| shipping | our ship node (gated confirm or release.set) |
| autonomous-run | our autopilot graph only if AC executable |
| session-pickup | resume from `.kpi/runs/<id>/` |
| pause-safely | `/kpi stop` + checkpoint |
| multi-phase-plan | frozen plan entry `/kpi --plan` |
| figure-it-out | custom playbook |

Rewrite hard (cloud stripped):

| Upstream | K-stack rule |
|---|---|
| autopilot-full | Local isolated owners only. **No merge to origin.** Terminal is `DONE` + optional PR body written to disk. Human or release.set still owns commit. |
| autopilot-stack | Same. No Graphite `gt`, no cloud sleeper. Linear commits on the job branch. |
| orchestrate | Coordinator is the k-pi graph engine, not a Cursor cloud root. |
| worktree-cleanup | Optional later. v1 works in-tree on a feature branch. |

Drop as runtime. This list is normative: a dropped pack must not appear in `generated/`, and renaming or token-replacing it does not count as handling it.

- cursor-team-kit `/deslop`, control-cli, control-ui
- Bugbot triage as a required step (replace with `/interrogate` + our reviewer)
- `make-bot-ui` — a Cursor Routines / Grok Bot webhook skill with no Pi equivalent. Out of scope for k-pi v1 and excluded whole: not rebranded, not stubbed, not half-translated.
- Benny Slack pack
- Cursor Cloud agents, Graphite `gt`, and the `/loop` sleeper as runtime content

An upstream skill that matches no keep, rewrite, or drop rule is the `NEEDS_HUMAN` row in §2, not a silent passenger in `generated/`.

---

## 6. Principles

Carry every upstream principle that survives the §5 keep/rewrite/drop rules as `kstack/skills/principle-*`. The set is whatever the pinned sync emits; no count is normative, so a routine `--pin` cannot falsify this document or an AC.

**Override** `never-block-on-the-human`:

> Reversible work proceeds. Irreversible effects (commit in gated mode, push, deploy, delete, new runtime deps) still hit the k-pi human node or are denied in autopilot. The outer loop owns those gates. This principle must not delete US-02 AC-02.5 or US-13.

**Add** four graph principles (ours):

| id | rule |
|---|---|
| outer-loop-owns-return | The graph decides the next node. A playbook step cannot jump to ship. |
| shared-files-are-the-contract | Handoffs are `task.json` / `candidate.json` / `evidence.json` / `verdict.json`, not chat memory. |
| proof-or-stop | No DONE without HEAD-bound receipts. LLM “tests passed” is not evidence. |
| executable-ac-or-gated | Autopilot playbooks refuse to start unless `ac.quality == executable`. |

The four graph principles above are always in force. Beyond them, a `/k-mode` todo list loads only the principle skills whose frontmatter `description` matches the current node — the same on-demand dispatch `spec.md` §9 already specifies as the last entry in the context-pack load order ("Skills on demand"). There is no blanket principle read, and no todo list opens by reading the whole index.

---

## 7. How a K-stack step uses the graph

When both `/kpi` and `/k-mode` are active:

1. `/k-mode` matches playbook P.
2. Control plane writes `task.json.playbook = P` and expands P’s steps into `state.json.todos[]`.
3. Each todo is tagged with the graph node that may complete it (`specify|plan|implement|test|review|ship`).
4. The implementer may only complete implementer todos. Reviewer writes `verdict.json` only.
5. Skipped steps stay visible: `skip: <reason>`.
6. Board file lamps and stage rail still follow spec.md. Playbook todos are an extra widget row `K-STACK  feature  4/9`.

When only `/k-mode` is used (no `/kpi` job):

- Create a lightweight job anyway so events.jsonl and the board have somewhere to live.
- Default mode `gated`.

---

## 8. Swarm / arena — background K-π sessions, not subagents

See `agents-bus.md`. `/swarm` and `/arena` call `spawn_background` + `communicate`. No `subagent_type`.

- `maxConcurrency = 2`
- arena panel length = 2 in v1, matching `maxConcurrency` and AC-20.4
- every worker is a background `kpi --mode rpc` session
- models from K-π pools only
- parent reads contract files, not worker transcripts

---

## 9. Brand

- Product pack name: **K-stack**
- Mode name: **K-mode**
- Do not print “pstack” or “poteto-mode” in operator chrome after setup.
- Principles files may keep upstream filenames `principle-laziness-protocol` so diffs against upstream stay reviewable.
- Footer / board may show `K-STACK on` next to `MODE`.

---

## 10. Acceptance criteria (stories live in PRD US-17–US-20)

See PRD. Tests that must exist:

- `/setup-kstack` dry-run with a fake registry of two models writes models.json containing only those two slugs
- setup refuses a slug not in the registry
- `/k-mode add healthcheck` matches feature playbook and first todo is principles
- feature playbook cannot mark ship complete while `verdict.json.approved != true`
- grep of `kstack/` for `cloud agent`, `cursor cloud`, `subagent_type`, `graphite`, `gt submit` returns no runtime hits (comments in NOTICE allowed)
- no manifest declares a pstack / open-pstack / pi-pstack dependency
- `npm run kstack:sync:check` is green on main against the pinned `pstack/` tree, and unrelated `cursor/plugins` HEAD movement does not fail it
- moving the pin with `npm run kstack:sync -- --pin <new>` reapplies overlay; generated diff is the PR
- a deliberately broken patch fixture makes sync exit non-zero and leaves `generated/` untouched
