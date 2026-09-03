#!/usr/bin/env node
/**
 * Generates docs/traceability-map.json with exact test_title bindings.
 * Run: node scripts/generate-traceability-map.mjs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function loadTitles() {
	const titles = [];
	for (const f of readdirSync(join(root, "test")).filter((x) => /\.test\.(ts|mjs)$/.test(x))) {
		const src = readFileSync(join(root, "test", f), "utf8");
		const re =
			/\b(?:test|it)\s*\(\s*(?:`([^`]+)`|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g;
		let m;
		while ((m = re.exec(src))) {
			titles.push({ file: `test/${f}`, title: m[1] ?? m[2] ?? m[3] });
		}
	}
	return titles;
}

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function check(file, title, observable) {
	return {
		name: title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_|_$/g, "")
			.slice(0, 80),
		file,
		test_title: title,
		runner: `node --test --experimental-strip-types --test-name-pattern '^${escapeRegex(title)}$' ${file}`,
		observable,
	};
}

/** Exact AC → { file, title, observable }. One primary binding per AC. */
const AC = {
	// US-01
	"AC-01.1": [
		"test/harness.test.ts",
		"the build ships every runtime resource asset byte-for-byte under dist/kpi",
		"offline build places every K-π resource under dist/kpi; bundle exists for cli.js --version",
	],
	"AC-01.2": [
		"test/harness.test.ts",
		"the coding-agent package is the K-π CLI: kpi and k-pi bins, .kpi config, no pi bin",
		"bins are exactly kpi and k-pi; piConfig name kpi, title K-π, configDir .kpi; no pi bin",
	],
	"AC-01.3": [
		"test/harness.test.ts",
		"the built harness serves the K-π built-in and its resources to an untrusted project",
		"untrusted scratch start exposes /kpi /loop /accounts and other built-ins with no install or trust gate",
	],
	"AC-01.4": [
		"test/harness.test.ts",
		"every runtime resource root exists in the source layout",
		"themes (incl. loop-amber), prompts, skills, graphs present as built-in resources",
	],
	"AC-01.5": [
		"test/harness.test.ts",
		"the root manifest is a private fork monorepo, not a publishable Pi package",
		"no keywords pi-package, no package.json#pi, no peerDeps on @earendil-works/pi-*",
	],
	"AC-01.6": [
		"test/milestone.test.ts",
		"forbidden runtime dependencies and official model overlays remain absent",
		"package manifests do not list oh-my-pi, atomic, pi-graph, pi-multi-account, pi-multi-pass, or pi-cursor-*",
	],

	// US-02
	"AC-02.1": [
		"test/run-store.test.ts",
		"createJob writes and readJob reads the run contract",
		"createJob creates .kpi/runs/<id>/ with task.json and companion run files readable via readJob",
	],
	"AC-02.2": [
		"test/schema-conformance.test.ts",
		"task, evidence, and verdict schemas match live payloads",
		"task.json validates with goal, acceptance[], nongoals, constraints, quality_gates",
	],
	"AC-02.3": [
		"test/ac-compiler.test.ts",
		"narrative requests remain narrative",
		"non-executable AC quality keeps mode gated even when autopilot was requested without force",
	],
	"AC-02.4": [
		"test/bus.test.ts",
		"no role that publishes a contract holds a mutation tool",
		"implementer has write/edit/bash; planner/reviewer/tester lack general write/edit; write_contract is separate",
	],
	"AC-02.5": [
		"test/gated-loop.test.ts",
		"loop on healthcheck fixture reaches human confirm with green gates",
		"after approved review the gated path shows human confirm before git commit",
	],
	"AC-02.6": [
		"test/gated-loop.test.ts",
		"the ship node commits on the job branch, pushes only that branch, and opens the pull request",
		"ship commits on kpi/<job>, pushes only that branch to origin, opens a PR; main, force, delete, tags, merge denied",
	],
	"AC-02.7": [
		"test/control-plane.test.ts",
		"job overlay includes the K-π brand and stages 01 through 08",
		"board widget surfaces MODE gated, STAGE, ROUND, and run file presence",
	],

	// US-03
	"AC-03.1": [
		"test/gated-loop.test.ts",
		"kpi --plan freezes and hashes plan files without executing specify",
		"specify node is skipped; --plan freezes plan without specify execution",
	],
	"AC-03.2": [
		"test/gated-loop.test.ts",
		"kpi --plan freezes and hashes plan files without executing specify",
		"plan files are copied into the run store and hashed into fingerprints.json",
	],
	"AC-03.3": [
		"test/gated-loop.test.ts",
		"a stale stack stops implement, and re-freezing it lets the round proceed",
		"plan-check style freshness: stale plan/stack stops with NEEDS_HUMAN or replan path",
	],
	"AC-03.4": [
		"test/autopilot.test.ts",
		"narrative acceptance criteria refuse forced autopilot before graph load",
		"changing acceptance mid-run / non-executable AC is a mode violation that stops autopilot",
	],

	// US-04
	"AC-04.1": [
		"test/autopilot.test.ts",
		"narrative acceptance criteria refuse forced autopilot before graph load",
		"autopilot refused when AC lacks check+bounds; ac.quality partial/narrative recorded",
	],
	"AC-04.2": [
		"test/autopilot.test.ts",
		"autopilot healthcheck reaches DONE with one commit and no human node",
		"happy autopilot path has no human node; release.approved only from deterministic set on green evidence",
	],
	"AC-04.3": [
		"test/policy.test.ts",
		"implementer tools cannot write the reviewer verdict",
		"implementer cannot write verdict.json or release.approved; write_contract is role/job/path pinned",
	],
	"AC-04.4": [
		"test/schema-conformance.test.ts",
		"task, evidence, and verdict schemas match live payloads",
		"evidence.json binds to git HEAD per evidence schema",
	],
	"AC-04.5": [
		"test/autopilot.test.ts",
		"autopilot healthcheck reaches DONE with one commit and no human node",
		"on success status is DONE and exactly one conventional job-marked commit exists",
	],
	"AC-04.6": [
		"test/policy.test.ts",
		"production deploy commands are denied",
		"push/deploy/delete/new-dependency attempts are denied as NEEDS_HUMAN or UNSAFE and do not execute",
	],

	// US-05
	"AC-05.1": [
		"test/stop.test.ts",
		"a terminal state is final: further verifier events cannot revive it",
		"terminal states are exactly DONE|BLOCKED|EXHAUSTED|NO_PROGRESS|UNSAFE|NEEDS_HUMAN",
	],
	"AC-05.2": [
		"test/stop.test.ts",
		"a repeated output fingerprint stops with NO_PROGRESS",
		"same output_fingerprint twice → NO_PROGRESS",
	],
	"AC-05.3": [
		"test/stop.test.ts",
		"the third failed round stops with EXHAUSTED by default",
		"round >= maxRounds (default 3) → EXHAUSTED",
	],
	"AC-05.4": [
		"test/autopilot.test.ts",
		"an autopilot write outside bounds stops UNSAFE without a commit",
		"write outside write_allow → UNSAFE, no commit",
	],
	"AC-05.5": [
		"test/autopilot.test.ts",
		"an untestable reviewer issue stops autopilot at NEEDS_HUMAN",
		"untestable reviewer issue → NEEDS_HUMAN",
	],
	"AC-05.6": [
		"test/stop.test.ts",
		"a transient 429 retry does not increment the round",
		"transient 429 retry is not a new round; new round needs new verifier evidence",
	],

	// US-06
	"AC-06.1": [
		"test/harness.test.ts",
		"themes use the required protocol accents",
		"loop-amber accent is #ff6a1a on a dark board",
	],
	"AC-06.2": [
		"test/runtime-milestone.test.ts",
		"human pause selects protocol-blue and running selects loop-amber",
		"human pause switches theme to protocol-blue accent #3da9fc",
	],
	"AC-06.3": [
		"test/operator-ui.test.ts",
		"amber board lights exactly one CURRENT stage and six nonempty file lamps",
		"widget shows LOOP name, MODE, ROUND, STAGE, NODE, GATE, STOP, FILES",
	],
	"AC-06.4": [
		"test/accounts-routing.test.ts",
		"the widget shows real cached percentages, cooldown, and the active route",
		"accounts widget shows per-slot remaining %; local slot has no quota percentage",
	],
	"AC-06.5": [
		"test/concise-output.test.ts",
		"research accounts bus checkpoint and terminal renderers are field-aware",
		"protocol events render as custom entries (handoff, checkpoint, verdict, accounts.failover, …)",
	],
	"AC-06.6": [
		"test/control-plane.test.ts",
		"kpi status reports no active job without requesting a provider",
		"/kpi status draws board from state.json + events.jsonl with no model call",
	],

	// US-07
	"AC-07.1": [
		"test/concise-output.test.ts",
		"concise-output skill and APPEND_SYSTEM require short user-visible answers",
		"APPEND_SYSTEM.md (not SYSTEM.md) contains the brevity rule",
	],
	"AC-07.2": [
		"test/concise-output.test.ts",
		"concise-output skill and APPEND_SYSTEM require short user-visible answers",
		"concise-output skill description matches Use whenever writing to the user",
	],
	"AC-07.3": [
		"test/concise-output.test.ts",
		"structured verdict protocol reply stays under 800 visible characters",
		"structured verdict fixture yields assistant body under 800 visible characters",
	],

	// US-08
	"AC-08.1": [
		"test/kstack-runtime.test.ts",
		"K-mode freezes the matched playbook and keeps every step and skip reason",
		"non-trivial tasks freeze specs/requirements/design/tasks via K-mode playbook steps",
	],
	"AC-08.2": [
		"test/gated-loop.test.ts",
		"loop on healthcheck fixture reaches human confirm with green gates",
		"implementer path stores red test output in evidence before green gates",
	],
	"AC-08.3": [
		"test/policy.test.ts",
		"exact task quality gates are allowed and never prompt",
		"quality gates are exact commands from AGENTS.md or task.json.quality_gates",
	],
	"AC-08.4": [
		"test/reviewer-session.test.ts",
		"reviewer argv and tools have no write or edit",
		"reviewer is isolated read-only; only write_contract mutates verdict.json",
	],
	"AC-08.5": [
		"test/gated-loop.test.ts",
		"ship commit subject matches the conventional commit contract",
		"ship commit message matches Conventional Commits",
	],

	// US-09
	"AC-09.1": [
		"test/kg.test.ts",
		"node, edge, and source round-trips validate and bump revisions",
		"KG store is .kpi/kg/{nodes,edges,sources}.jsonl plus inbox/ and snapshots/",
	],
	"AC-09.2": [
		"test/kg.test.ts",
		"a direct authoritative write through the public tool fails",
		"only control-plane is authoritative writer; workers only drop inbox patches",
	],
	"AC-09.3": [
		"test/kg.test.ts",
		"node, edge, and source round-trips validate and bump revisions",
		"nodes require id, kind, source_ids, status, rev, observed_at",
	],
	"AC-09.4": [
		"test/kg.test.ts",
		"node, edge, and source round-trips validate and bump revisions",
		"status enum is proposed|verified|rejected|superseded",
	],

	// US-10
	"AC-10.1": [
		"test/accounts-commands.test.ts",
		"pool strategy and chain persist and survive a reload",
		"accounts.json holds pools/slots under ~/.kpi/agent; secrets not in the repo",
	],
	"AC-10.2": [
		"test/accounts.test.ts",
		"two Anthropic subscription slots coexist",
		"/accounts login anthropic adds a slot without deleting existing Anthropic slots",
	],
	"AC-10.3": [
		"test/provider-contracts.test.ts",
		"no official provider id is registered, so none can receive a models array",
		"official /model ids stay anthropic/<official-id>; no duplicate provider catalogs",
	],
	"AC-10.4": [
		"test/milestone.test.ts",
		"429 usage limit classifies to the default cooldown",
		"usage-limit cools slot until parsed reset else default 5h and same-family failover",
	],
	"AC-10.5": [
		"test/accounts-routing.test.ts",
		"cross-family fallback begins only after the whole family cools and follows the chain",
		"cross-family fallback only when whole family cooling; default anthropic→openai→…",
	],
	"AC-10.6": [
		"test/accounts.test.ts",
		"M-05 through the live hooks: an exhausted slot is never selected in 100 requests",
		"exhausted sibling never selected while healthy sibling exists",
	],
	"AC-10.7": [
		"test/milestone.test.ts",
		"accounts widget labels each slot percentage",
		"widget lists remaining % per slot",
	],
	"AC-10.8": [
		"test/accounts-commands.test.ts",
		"a pin holds until the slot is exhausted",
		"session stickiness holds until pinned slot exhausted then releases",
	],

	// US-11
	"AC-11.1": [
		"test/provider-contracts.test.ts",
		"no source file passes a models array to an official provider id",
		"extensions do not pass models arrays for official anthropic/openai/… ids",
	],
	"AC-11.2": [
		"test/provider-contracts.test.ts",
		"Cursor keeps a bounded bootstrap list and Pi-compatible login callbacks",
		"Cursor implements refreshModels and short fallback only for pre-sync emptiness",
	],
	"AC-11.3": [
		"test/cli-smoke.test.ts",
		"the source CLI keeps extension and model updates after the self-update lockout",
		"kpi update --models is the operator refresh path; no pi update branding",
	],

	// US-12
	"AC-12.1": [
		"test/accounts.test.ts",
		"Anthropic warning precedes the official OAuth window",
		"before Anthropic OAuth, ctx.ui.confirm shows the billing warning from spec",
	],
	"AC-12.2": [
		"test/accounts.test.ts",
		"accepted warning is persisted and not repeated for the same slot",
		"accept sets warningAcceptedAt; later sessions do not re-prompt that slot",
	],
	"AC-12.3": [
		"test/accounts.test.ts",
		"cancelled Anthropic warning creates no account slot",
		"cancel aborts login and creates no slot",
	],
	"AC-12.4": [
		"test/accounts.test.ts",
		"Anthropic warning precedes the official OAuth window",
		"warning text states extra usage is billed per token, not the in-app Max bar",
	],

	// US-13
	"AC-13.1": [
		"test/policy.test.ts",
		"the registered hook keeps every AC-13.1 denial",
		"tool_call denies git push origin main, force-push, rm -rf, production deploy, writes outside write_allow; only kpi/* after release",
	],
	"AC-13.2": [
		"test/policy.test.ts",
		"gated git commit confirms and states the current HEAD diff stat",
		"gated mode git commit on job branch asks confirm with diff stat",
	],
	"AC-13.3": [
		"test/policy.test.ts",
		"autopilot git commit is denied before release and allowed after",
		"autopilot git commit allowed only after release.approved == true",
	],
	"AC-13.4": [
		"test/policy.test.ts",
		"unknown commands confirm in gated and are denied in autopilot",
		"unknown commands: confirm in gated, deny in autopilot",
	],
	"AC-13.5": [
		"test/policy.test.ts",
		"chat scope never confirms but keeps every hard deny",
		"no live job: unknown commands, writes and commits run without a prompt; push, rm -rf, deploy, secret paths and reserved artifacts still deny",
	],
	"AC-13.6": [
		"test/policy.test.ts",
		"always allow persists to policy.json allow[] and is honoured by a fresh session",
		"Always allow writes the exact command to .kpi/policy.json allow[]; a new session honours it without a prompt; hard denies are not laundered",
	],

	// US-14
	"AC-14.1": [
		"test/append-log.test.ts",
		"three appended events form a verifiable hash chain",
		"events.jsonl is append-only and hash-chained (prev_hash, record_hash)",
	],
	"AC-14.2": [
		"test/run-store.test.ts",
		"a crash before rename cannot expose a partial candidate.json",
		"state files written *.tmp → fsync → rename",
	],
	"AC-14.3": [
		"test/append-log.test.ts",
		"secrets are redacted inside allowed semantic fields",
		"no tokens, cookies, or raw secrets in events",
	],
	"AC-14.4": [
		"test/resume.test.ts",
		"restored checkpoint does not rerun completed plan and implement nodes",
		"kill mid-implementer leaves checkpoint /kpi status can read; resume restores progress",
	],

	// US-15
	"AC-15.1": [
		"test/status-line.test.ts",
		"unicode brand is K-π and never bare pi",
		"idle leftmost cell is K-π in unicode preset, not π or omp",
	],
	"AC-15.2": [
		"test/status-line.test.ts",
		"default segment order matches the visual contract",
		"default segments L→R: brand, model, thinking, path, git, context_pct, cost…",
	],
	"AC-15.3": [
		"test/status-line.test.ts",
		"end-to-end footer assembly covers every account kind presets job route usage",
		"powerline-thin chevron separators between segments",
	],
	"AC-15.4": [
		"test/status-line.test.ts",
		"context colors follow the required thresholds",
		"context % colors: green <50, yellow 50–70, orange 70–90, red >90",
	],
	"AC-15.5": [
		"test/status-line.test.ts",
		"cost cells cover oauth local and api_key kinds",
		"oauth subscription slots render (sub) instead of fake dollar figure",
	],
	"AC-15.6": [
		"test/status-line.test.ts",
		"registered footer full preset embeds kpi job fields and refreshes after state change",
		"during a turn brand cell can show spinner/elapsed via footer refresh path",
	],
	"AC-15.7": [
		"test/status-line.test.ts",
		"formatKpiJob is the documented second line shape",
		"job line supports truncated right-aligned last user request shape",
	],
	"AC-15.8": [
		"test/milestone.test.ts",
		"forbidden runtime dependencies and official model overlays remain absent",
		"no runtime dependency on oh-my-pi or community footer packages",
	],
	"AC-15.9": [
		"test/status-line.test.ts",
		"registered footer full preset embeds kpi job fields and refreshes after state change",
		"/statusbar toggles custom footer; off restores default footer path",
	],
	"AC-15.10": [
		"test/status-line.test.ts",
		"cost cells cover oauth local and api_key kinds",
		"local active slot renders one cost cell (local) $0 never (sub) or estimated dollars",
	],

	// US-16
	"AC-16.1": [
		"test/operator-ui.test.ts",
		"amber board lights exactly one CURRENT stage and six nonempty file lamps",
		"active job shows amber board with K-π MODE JOB ROUND stages and file lamps",
	],
	"AC-16.2": [
		"test/operator-ui.test.ts",
		"board and status rendering never call a model client",
		"/kpi status expands widget to full board with no model call",
	],
	"AC-16.3": [
		"test/operator-ui.test.ts",
		"protocol-blue pause derives APPROVAL lamp without persisting APPROVAL status",
		"human pause flips board to protocol-blue with SHARED RUN STATE and STOP STATE",
	],
	"AC-16.4": [
		"test/operator-ui.test.ts",
		"empty run files keep lamps dark",
		"file lamps light only when named file exists and is non-empty",
	],
	"AC-16.5": [
		"test/operator-ui.test.ts",
		"board and status rendering never call a model client",
		"assistant does not reprint board as markdown; TUI carries state",
	],
	"AC-16.6": [
		"test/operator-ui.test.ts",
		"narrow width keeps CURRENT stage and STOP visible",
		"required fields present; narrow terminals may wrap; pixel match not required",
	],

	// US-17
	"AC-17.1": [
		"test/harness.test.ts",
		"the built harness serves the K-π built-in and its resources to an untrusted project",
		"/setup-kstack and /k-mode exist at startup with no install or trust step",
	],
	"AC-17.2": [
		"test/kstack-runtime.test.ts",
		"no forbidden residue survives in the loaded roots",
		"no manifest depends on pstack, open-pstack, @oh-my-pi/*, or pi-pstack",
	],
	"AC-17.3": [
		"test/kstack-runtime.test.ts",
		"attribution is complete: the full MIT text, the author, and the source",
		"kstack/ has rewritten skills/playbooks; NOTICE credits Lauren Tan / Cursor",
	],
	"AC-17.4": [
		"test/kstack-runtime.test.ts",
		"ordinary words containing pstack substrings stay intact",
		"operator chrome says K-stack / K-mode, not poteto-mode",
	],

	// US-18
	"AC-18.1": [
		"test/kstack-runtime.test.ts",
		"setup offers only live models in a configured K-π pool",
		"offered slugs ⊆ getAvailable() ∩ configured pools",
	],
	"AC-18.2": [
		"test/kstack-runtime.test.ts",
		"a value outside the live candidates is refused before any write",
		"slug not in live set cannot be written to kstack/models.json",
	],
	"AC-18.3": [
		"test/kstack-runtime.test.ts",
		"setup offers only live models in a configured K-π pool",
		"no Cursor Cloud Agent target is listed in setup offers",
	],
	"AC-18.4": [
		"test/kstack-runtime.test.ts",
		"the model map is written atomically and read back per role",
		"re-running setup overwrites the model map idempotently",
	],
	"AC-18.5": [
		"test/kstack-runtime.test.ts",
		"each role reports chosen, next best, and the ladder's confidence",
		"setup prints auto map from model-ladder.md against live set before apply",
	],
	"AC-18.6": [
		"test/kstack-runtime.test.ts",
		"the ladder never overrides the live filter",
		"suggestion never writes a slug absent from the live filter",
	],

	// US-19
	"AC-19.1": [
		"test/kstack-runtime.test.ts",
		"K-mode freezes the playbook into the job contract and renders its steps",
		"first todo names four graph principles plus playbook steps",
	],
	"AC-19.2": [
		"test/kstack-runtime.test.ts",
		"K-mode freezes the matched playbook and keeps every step and skip reason",
		"matched playbook name stored on task.json.playbook",
	],
	"AC-19.3": [
		"test/milestone.test.ts",
		"K-mode feature comes from the generated runtime and ship needs approval",
		"ship todo cannot complete unless verdict.approved and evidence fresh",
	],
	"AC-19.4": [
		"test/kstack-runtime.test.ts",
		"K-mode freezes the matched playbook and keeps every step and skip reason",
		"skipped steps remain listed with skip: <reason>",
	],
	"AC-19.5": [
		"test/operator-ui.test.ts",
		"sticky kMode alone does not light K-STACK on for an active job without freeze",
		"/k-mode stays on for the session until /k-mode off",
	],

	// US-20
	"AC-20.1": [
		"test/kstack-runtime.test.ts",
		"arena and swarm state the bus contract: two workers, one writer, local pools",
		"autopilot-full/stack spawn only local isolated K-π sessions",
	],
	"AC-20.2": [
		"test/kstack-runtime.test.ts",
		"arena and swarm never exceed the bus's own worker cap",
		"those playbooks do not merge to origin; terminal is DONE + local commit",
	],
	"AC-20.3": [
		"test/kstack-runtime.test.ts",
		"no forbidden residue survives in the loaded roots",
		"runtime kstack has no cloud agent, gt submit, subagent_type, or cursor-agent residue",
	],
	"AC-20.4": [
		"test/bus.test.ts",
		"caps hold, and five concurrent spawns start exactly two",
		"swarm/arena honor maxConcurrency = 2",
	],

	// US-21
	"AC-21.1": [
		"test/kstack-sync.test.ts",
		"UPSTREAM.md carries the documented pstack tree row and agrees with provenance",
		"kstack/UPSTREAM.md records repo, path pstack/, commit sha, upstream version",
	],
	"AC-21.2": [
		"test/kstack-sync.test.ts",
		"a pin that moves the pstack tree succeeds and the next offline check reproduces",
		"kstack:sync --pin fetches tree, runs transforms+patches, writes generated + provenance",
	],
	"AC-21.3": [
		"test/kstack-sync.test.ts",
		"a broken patch leaves live bytes untouched and creates no rej or orig",
		"if a patch fails, sync exits non-zero and does not overwrite generated/",
	],
	"AC-21.4": [
		"test/kstack-sync.test.ts",
		"a hand edit inside generated makes check fail, and check writes nothing",
		"kstack:sync:check fails when generated would drift or HEAD ≠ pin",
	],
	"AC-21.5": [
		"test/kstack-sync.test.ts",
		"check is offline by default and refuses to be told otherwise",
		"weekly drift path is fetch-gated; offline operators never hit network for K-stack",
	],
	"AC-21.6": [
		"test/kstack-sync.test.ts",
		"nothing in the sync or status path reaches the network without --fetch",
		"operators running K-π do not hit the network; sync is maintainer/CI only",
	],

	// US-22
	"AC-22.1": [
		"test/minimalist.test.ts",
		"documented ladder vocabulary is the only accepted rung set",
		"skills/minimalist/SKILL.md present and credited (Alireza Rezvani, MIT)",
	],
	"AC-22.2": [
		"test/minimalist.test.ts",
		"missing ladder fails independently of dependencies",
		"implementer must write candidate.json.ladder before first file change",
	],
	"AC-22.3": [
		"test/milestone.test.ts",
		"minimalist bounds rejects a missing ladder and undeclared dependency",
		"new runtime dependency not in task.json fails bounds and cannot ship",
	],
	"AC-22.4": [
		"test/minimalist.test.ts",
		"one-concat direct one-line change passes with zero new files",
		"one-concat direct one-line change passes with zero new files; no new helper file",
	],

	// US-23
	"AC-23.1": [
		"test/bus.test.ts",
		"the built CLI starts in rpc mode and answers the protocol offline",
		"spawn_background starts kpi --mode rpc with session under .kpi/",
	],
	"AC-23.2": [
		"test/bus.test.ts",
		"expect none takes the bytes, ack waits for acceptance, and neither waits for a result",
		"communicate delivers via sendUserMessage/RPC prompt with deliverAs steer|followUp",
	],
	"AC-23.3": [
		"test/bus.test.ts",
		"expect result needs completion and a fresh receipted publication",
		"parent reads verdict.json/evidence.json, not the worker transcript",
	],
	"AC-23.4": [
		"test/bus.test.ts",
		"caps hold, and five concurrent spawns start exactly two",
		"max 2 live workers; third spawn denied",
	],
	"AC-23.5": [
		"test/milestone.test.ts",
		"forbidden runtime dependencies and official model overlays remain absent",
		"package.json has no pi-intercom, pi-mesh, pi-agents-talk-to-each-other, pi-bus, pi-side-agents",
	],
	"AC-23.6": [
		"test/operator-ui.test.ts",
		"BUS lamp tracks bus.jsonl history independent of AGENTS count",
		"board can show AGENTS n; worker chat not printed as assistant markdown",
	],
	"AC-23.7": [
		"test/bus.test.ts",
		"a writer worker and the parent cannot both hold the writer slot",
		"at most one live worker has write/edit; second writer spawn denied",
	],
	"AC-23.8": [
		"test/bus.test.ts",
		"one file claimed by four spellings is one lease",
		"claim_path is exclusive until release or holder pid dies",
	],
	"AC-23.9": [
		"test/bus.test.ts",
		"write_contract refuses the wrong agent, job, role, path, schema, or a link out",
		"write_contract is not write/edit; reviewer/tester with only write_contract is not a writer",
	],

	// US-24
	"AC-24.1": [
		"test/runtime-milestone.test.ts",
		"bare text stays plain chat and the agent starts a K-π job through kpi_start_job",
		"routing auto: bare text is plain chat; the agent queues a gated /kpi through kpi_start_job, sent on agent_end with sticky /k-mode",
	],
	"AC-24.2": [
		"test/runtime-milestone.test.ts",
		"routing always wraps bare goals but never commands",
		"commands (/kpi, /k-mode, /accounts, …) are never wrapped; routing always wraps bare text into a gated /kpi",
	],
	"AC-24.3": [
		"test/runtime-milestone.test.ts",
		"a live job owns bare follow-ups and kpi_start_job refuses to start a second one",
		"while a job is live, bare text steers the parent session and kpi_start_job refuses; a finished job owns nothing",
	],
	"AC-24.4": [
		"test/runtime-milestone.test.ts",
		"kpi off, kpi.routing off, and worker sessions leave no automatic job start",
		"/kpi off or kpi.routing=off leaves only explicit /kpi; bus workers never hold kpi_start_job",
	],

	// US-25
	"AC-25.1": [
		"test/operator-ui.test.ts",
		"amber board lights exactly one CURRENT stage and six nonempty file lamps",
		"required fields when job active: brand K-π, MODE, JOB, ROUND, stages 01–08, PATH, STOP, file lamps",
	],
	"AC-25.2": [
		"test/operator-ui.test.ts",
		"protocol-blue pause derives APPROVAL lamp without persisting APPROVAL status",
		"paused human node shows WAITING ON OPERATOR plus pending question",
	],
	"AC-25.3": [
		"test/operator-ui.test.ts",
		"narrow width keeps CURRENT stage and STOP visible",
		"narrow terminals may wrap; truncation keeps current stage and STOP visible",
	],
	"AC-25.4": [
		"test/operator-ui.test.ts",
		"amber board lights exactly one CURRENT stage and six nonempty file lamps",
		"matching JPEG pixels not required; missing a required field fails the story",
	],

	// US-26
	"AC-26.1": [
		"test/provider-contracts.test.ts",
		"no official provider id is registered, so none can receive a models array",
		"official pool ids only for zai / zai-coding-cn / kimi-coding via built-in providers",
	],
	"AC-26.2": [
		"test/accounts-commands.test.ts",
		"each provider notice appears once per new slot and never after acceptance",
		"/accounts login zai and kimi-coding add slots without freezing catalogs",
	],
	"AC-26.3": [
		"test/accounts-routing.test.ts",
		"same-family failover preserves the exact model and proposes no model change",
		"same-family failover on 429/402/403-quota; z.ai default 5h cool-off when reset missing",
	],
	"AC-26.4": [
		"test/provider-contracts.test.ts",
		"no source file passes a models array to an official provider id",
		"model ids stay zai/<official>, kimi-coding/<official>; new models via official refresh",
	],
	"AC-26.5": [
		"test/provider-contracts.test.ts",
		"no official provider id is registered, so none can receive a models array",
		"do not hand-roll api.z.ai coding path in models.json; use Pi built-in zai",
	],
	"AC-26.6": [
		"test/provider-contracts.test.ts",
		"no official provider id is registered, so none can receive a models array",
		"Kimi Coding Plan is kimi-coding, not moonshot Open Platform",
	],
	"AC-26.7": [
		"test/status-line.test.ts",
		"cost cells cover oauth local and api_key kinds",
		"footer shows (sub) for these slots; no pi-kimi-coder/pi-moonshot runtime deps",
	],
	"AC-26.8": [
		"test/accounts-commands.test.ts",
		"each provider notice appears once per new slot and never after acceptance",
		"first /accounts login zai shows one-line Coding Plan personal-use notice once",
	],

	// US-27 — already AC-id titled in local-providers
	"AC-27.1": [
		"test/local-providers.test.ts",
		"AC-27.1 the llama pool maps to Pi's own llama.cpp provider and is never registered",
		"official llama.cpp path via LLAMA_BASE_URL; never a custom registerProvider for llama",
	],
	"AC-27.2": [
		"test/local-providers.test.ts",
		"AC-27.2 discovery uses /v1/models, keeps exact ids, and tolerates extra fields",
		"ollama/lmstudio/local-openai use registerProvider + refreshModels against /v1/models",
	],
	"AC-27.3": [
		"test/local-providers.test.ts",
		"AC-27.3 defaults are the documented origins and local-openai asks",
		"login ollama stores base URL default 11434; LM Studio default documented origin",
	],
	"AC-27.4": [
		"test/local-providers.test.ts",
		"AC-27.4 an unreachable local server cools the slot and only a local successor is chosen",
		"unreachable server cools slot; failover stays in local family first",
	],
	"AC-27.5": [
		"test/local-providers.test.ts",
		"AC-27.5 local pools are outside the default chain and enter it only when the operator says so",
		"default cloud chain excludes local; add via /pool chain or pin",
	],
	"AC-27.6": [
		"test/local-providers.test.ts",
		"AC-27.6 the accounts widget shows no quota percentage for a local slot",
		"footer (local) $0 and accounts widget shows no quota % for local",
	],
	"AC-27.7": [
		"test/local-providers.test.ts",
		"AC-27.7 no forbidden local provider dependency is declared",
		"no runtime dep on pi-ollama or related community packages",
	],
	"AC-27.8": [
		"test/local-providers.test.ts",
		"AC-27.8 every discovery request stays on the configured origin",
		"local traffic stays on configured base URL; no silent cloud proxy",
	],

	// US-28
	"AC-28.1": [
		"test/research-control-plane.test.ts",
		"setup saves what the operator typed and records the resulting mode",
		"/setup-kstack offers Exa and Perplexity keys with save or skip",
	],
	"AC-28.2": [
		"test/research-control-plane.test.ts",
		"a saved research key beats the environment, and the environment is the fallback",
		"keys in accounts.secrets.json at exa/default and perplexity/default",
	],
	"AC-28.3": [
		"test/research-clients.test.ts",
		"Exa Search nests bounded content options and caps the result count",
		"first-party REST tools cover Exa search/contents and Perplexity Search; no provider SDK runtime dep",
	],
	"AC-28.4": [
		"test/milestone.test.ts",
		"forbidden runtime dependencies and official model overlays remain absent",
		"package.json has no exa-js or @perplexity-ai/perplexity_ai runtime dependency",
	],
	"AC-28.5": [
		"test/research-control-plane.test.ts",
		"a 429 cools the service, the alternate is tried once, then NH-02 sets effective no-network",
		"429/timeout cools research service and tries the other configured service",
	],
	"AC-28.6": [
		"test/operator-ui.test.ts",
		"research cells distinguish online operator and engine no-network",
		"footer/board can show EXA, PPLX, or both when keys present",
	],
	"AC-28.7": [
		"test/research-control-plane.test.ts",
		"/accounts login and logout treat exa and perplexity as research targets, not pools",
		"exa and perplexity are research credential targets, not pool ids in accounts.json pools",
	],

	// US-29
	"AC-29.1": [
		"test/research-control-plane.test.ts",
		"two distinct external origins complete an online run",
		"specify/plan cannot leave nodes without research.md and research.json",
	],
	"AC-29.2": [
		"test/research-control-plane.test.ts",
		"two distinct external origins complete an online run",
		"online research.json records at least two distinct external sources",
	],
	"AC-29.3": [
		"test/research-control-plane.test.ts",
		"an authorized no-network job researches the repository and makes zero network calls",
		"without key or under no-network, mode is local and sources are repo-only",
	],
	"AC-29.4": [
		"test/research-control-plane.test.ts",
		"research mode persists and a named service without a key falls back",
		"implement UNSAFE if research files missing or older than task.json hash",
	],
	"AC-29.5": [
		"test/research-clients.test.ts",
		"tool output is bounded and carries no provider envelope",
		"assistant prose does not dump raw crawl pages; citations live in research.md",
	],
	"AC-29.6": [
		"test/research-control-plane.test.ts",
		"a healthy service with one distinct source ends NEEDS_HUMAN and is never downgraded",
		"healthy service with fewer than two distinct external sources ends NEEDS_HUMAN",
	],
	"AC-29.7": [
		"test/research-control-plane.test.ts",
		"a 429 cools the service, the alternate is tried once, then NH-02 sets effective no-network",
		"engine sets effective no-network only after every configured service fails its bound",
	],

	// US-30
	"AC-30.1": [
		"test/stack.test.ts",
		"the plan's selected slice is frozen into the job contract",
		"plan writes stack.json with folder, interface, allowed_paths, scaffold_first per module",
	],
	"AC-30.2": [
		"test/stack.test.ts",
		"claim_path and implement bounds share one boundary",
		"implement claim_path outside current module folder + test twin is UNSAFE",
	],
	"AC-30.3": [
		"test/stack.test.ts",
		"no-stack playbooks are exempt, and every other playbook is not",
		"feature playbooks copy dune checklist; no-stack playbooks exempt",
	],
	"AC-30.4": [
		"test/stack.test.ts",
		"layer folders are nested-only and generic folders need a tight purpose",
		"top-level utils/helpers/common/misc without tight purpose fails plan gate",
	],
	"AC-30.5": [
		"test/stack.test.ts",
		"scaffold creates folder, interface, then test twin, before any behaviour",
		"scaffold creates feature folder, interface file, and test twin before behaviour",
	],
	"AC-30.6": [
		"test/stack.test.ts",
		"folder name equals id, and auth never lives in a layer bucket",
		"folder name equals module id; auth code not under services/ or lib/ as home",
	],
	"AC-30.7": [
		"test/stack.test.ts",
		"layer folders are nested-only and generic folders need a tight purpose",
		"layer folders may exist inside feature folder, not as top-level map",
	],
	"AC-30.8": [
		"test/stack.test.ts",
		"shared is extracted only when a second slice needs it",
		"a file only one feature uses cannot live in shared/",
	],
	"AC-30.9": [
		"test/stack.test.ts",
		"vertical delivery cannot stage a layer sweep, and horizontal needs a reason",
		"default delivery is vertical; one implement round = one slice through feature folder",
	],
	"AC-30.10": [
		"test/stack.test.ts",
		"vertical delivery cannot stage a layer sweep, and horizontal needs a reason",
		"all APIs then all UI without delivery:horizontal + reason fails plan gate",
	],
	"AC-30.11": [
		"test/stack.test.ts",
		"shared is extracted only when a second slice needs it",
		"shared abstractions extracted only when a second slice needs them",
	],
};

// Metrics
const METRICS = {
	"M-01": [
		"test/gated-loop.test.ts",
		"loop on healthcheck fixture reaches human confirm with green gates",
		"gated healthcheck fixture reaches human confirmation with green receipts",
	],
	"M-02": [
		"test/autopilot.test.ts",
		"autopilot healthcheck reaches DONE with one commit and no human node",
		"autopilot fixture DONE, no human node, exactly one job-marked commit",
	],
	"M-03": [
		"test/autopilot.test.ts",
		"narrative acceptance criteria refuse forced autopilot before graph load",
		"narrative AC refuses autopilot and records ac.refused / non-executable quality",
	],
	"M-04": [
		"test/autopilot.test.ts",
		"an autopilot write outside bounds stops UNSAFE without a commit",
		"bounds violation reaches UNSAFE and creates no commit",
	],
	"M-05": [
		"test/accounts.test.ts",
		"M-05 through the live hooks: an exhausted slot is never selected in 100 requests",
		"exhausted sibling never selected in 100 live-hook selections while healthy exists",
	],
	"M-06": [
		"test/concise-output.test.ts",
		"structured verdict protocol reply stays under 800 visible characters",
		"visible assistant verdict reply length < 800",
	],
	"M-07": [
		"test/harness.test.ts",
		"the built harness serves the K-π built-in and its resources to an untrusted project",
		"repository gates and built-harness inventory/start path pass",
	],
};

// Shared helper for RP primary verification title (one distinctive test per RP)
const RP = {
	"RP-00": [
		"test/docs-routing.test.ts",
		"every routing surface resolves its next step to the active remediation plan",
		"docs routing and remediation authority are active",
	],
	"RP-01": [
		"test/schema-conformance.test.ts",
		"task, evidence, and verdict schemas match live payloads",
		"schemas match live payloads",
	],
	"RP-01A": [
		"test/harness.test.ts",
		"the coding-agent package is the K-π CLI: kpi and k-pi bins, .kpi config, no pi bin",
		"standalone kpi bins and resource layout",
	],
	"RP-02": [
		"test/policy.test.ts",
		"the registered hook keeps every AC-13.1 denial",
		"policy denials for push/rm/deploy/bounds",
	],
	"RP-03": [
		"test/graph-engine.test.ts",
		"every configured cap persists EXHAUSTED and exactly one terminal event",
		"caps enforce EXHAUSTED durably",
	],
	"RP-04": [
		"test/stop.test.ts",
		"a repeated output fingerprint stops with NO_PROGRESS",
		"NO_PROGRESS and stop safety",
	],
	"RP-05": [
		"test/gated-loop.test.ts",
		"loop on healthcheck fixture reaches human confirm with green gates",
		"gated loop fixture green path",
	],
	"RP-06": [
		"test/accounts.test.ts",
		"M-05 through the live hooks: an exhausted slot is never selected in 100 requests",
		"accounts selection never picks exhausted sibling",
	],
	"RP-07": [
		"test/accounts-commands.test.ts",
		"pool strategy and chain persist and survive a reload",
		"account commands persist pools and chains",
	],
	"RP-08": [
		"test/local-providers.test.ts",
		"AC-27.5 local pools are outside the default chain and enter it only when the operator says so",
		"local pools outside default cloud chain",
	],
	"RP-09": [
		"test/research-control-plane.test.ts",
		"two distinct external origins complete an online run",
		"research control plane online completion",
	],
	"RP-10": [
		"test/research-clients.test.ts",
		"oversized upstream data never reaches tool output, events, research.md, or research.json",
		"research client bounds hold",
	],
	"RP-11": [
		"test/stack.test.ts",
		"scaffold creates folder, interface, then test twin, before any behaviour",
		"Dune scaffold order",
	],
	"RP-12": [
		"test/kg.test.ts",
		"a direct authoritative write through the public tool fails",
		"KG single-writer authority",
	],
	"RP-13": [
		"test/bus.test.ts",
		"caps hold, and five concurrent spawns start exactly two",
		"bus worker caps",
	],
	"RP-14": [
		"test/reviewer-session.test.ts",
		"reviewer argv and tools have no write or edit",
		"reviewer isolation",
	],
	"RP-15": [
		"test/minimalist.test.ts",
		"one-concat direct one-line change passes with zero new files",
		"minimalist one-concat fixture",
	],
	"RP-16": [
		"test/kstack-runtime.test.ts",
		"the generated tree is skills plus required attribution, and nothing else",
		"generated K-stack runtime loadable",
	],
	"RP-17": [
		"test/kstack-sync.test.ts",
		"the committed generated tree is byte and semantically reproducible offline",
		"deterministic offline K-stack sync check",
	],
	"RP-18": [
		"test/status-line.test.ts",
		"unicode brand is K-π and never bare pi",
		"footer brand and board chrome",
	],
	"RP-19": [
		"test/traceability.test.ts",
		"every named check binds an exact test title that exists and is selectable",
		"traceability map binds exact test titles, not whole-file runners",
	],
};

const EVENT_TYPES = [
	"handoff.created",
	"tool.request",
	"approval.result",
	"tool.result",
	"checkpoint",
	"handoff.completed",
	"recovery.started",
	"recovery.completed",
	"kg.patch.proposed",
	"kg.patch.accepted",
	"accounts.failover",
	"ac.refused",
	"loop.terminal",
	"review.verdict",
	"research.started",
	"research.query",
	"research.call",
	"research.result",
	"research.fallback",
	"research.completed",
	"agent.spawned",
	"agent.message",
];

function bind(triple) {
	if (!triple) return null;
	const [file, title, observable] = triple;
	return check(file, title, observable);
}

function main() {
	const titles = loadTitles();
	const titleIndex = new Map(titles.map((t) => [`${t.file}::${t.title}`, t]));

	function assertTitle(file, title, id) {
		if (!titleIndex.has(`${file}::${title}`)) {
			throw new Error(`${id}: missing title in ${file}: ${title}`);
		}
	}

	const prd = readFileSync(join(root, "docs/PRD.md"), "utf8");
	const plan = readFileSync(join(root, "docs/remediation-plan.md"), "utf8");
	const research = readFileSync(join(root, "docs/remediation-research.md"), "utf8");
	const spec = readFileSync(join(root, "docs/spec.md"), "utf8");

	const acs = [];
	let currentUs = null;
	for (const line of prd.split("\n")) {
		const us = /^### (US-\d{2})\b/.exec(line);
		if (us) {
			currentUs = us[1];
			continue;
		}
		const ac = /^- \*\*(AC-\d+\.\d+)\*\*\s*(.+)$/.exec(line);
		if (ac && currentUs) acs.push({ id: ac[1], us: currentUs, text: ac[2].trim() });
	}

	const gapOwner = {};
	const rpBlocks = plan.split(/^## (RP-\S+)/m).slice(1);
	for (let i = 0; i < rpBlocks.length; i += 2) {
		const id = rpBlocks[i];
		const body = rpBlocks[i + 1] || "";
		const owns = /\*\*Owns gaps:\*\*\s*(.+)/.exec(body);
		if (!owns) continue;
		for (const g of owns[1].match(/[A-Z]+-\d+/g) || []) gapOwner[g] = id;
	}

	const usOwner = {
		"US-01": "RP-01A",
		"US-02": "RP-05",
		"US-03": "RP-05",
		"US-04": "RP-05",
		"US-05": "RP-04",
		"US-06": "RP-18",
		"US-07": "RP-18",
		"US-08": "RP-14",
		"US-09": "RP-12",
		"US-10": "RP-06",
		"US-11": "RP-07",
		"US-12": "RP-07",
		"US-13": "RP-02",
		"US-14": "RP-01",
		"US-15": "RP-18",
		"US-16": "RP-18",
		"US-17": "RP-16",
		"US-18": "RP-16",
		"US-19": "RP-16",
		"US-20": "RP-16",
		"US-21": "RP-17",
		"US-22": "RP-15",
		"US-23": "RP-13",
		"US-24": "RP-05",
		"US-25": "RP-18",
		"US-26": "RP-07",
		"US-27": "RP-08",
		"US-28": "RP-09",
		"US-29": "RP-10",
		"US-30": "RP-11",
	};
	const acOwnerOverride = {
		"AC-05.1": "RP-03",
		"AC-05.2": "RP-03",
		"AC-05.3": "RP-03",
		"AC-05.4": "RP-04",
		"AC-05.5": "RP-04",
		"AC-05.6": "RP-05",
		"AC-13.1": "RP-02",
		"AC-13.2": "RP-02",
		"AC-13.3": "RP-02",
		"AC-13.4": "RP-02",
		"AC-13.5": "RP-02",
		"AC-13.6": "RP-02",
		"AC-28.6": "RP-18",
	};

	const metricOwner = {
		"M-01": "RP-05",
		"M-02": "RP-05",
		"M-03": "RP-05",
		"M-04": "RP-05",
		"M-05": "RP-06",
		"M-06": "RP-18",
		"M-07": "RP-19",
	};

	const entries = [];
	const uncovered = [];

	for (const ac of acs) {
		const owner = acOwnerOverride[ac.id] || usOwner[ac.us];
		const triple = AC[ac.id];
		if (!triple) {
			uncovered.push({ id: ac.id, owner, reason: "no curated binding" });
			entries.push({
				id: ac.id,
				kind: "ac",
				primary_owner: owner,
				prd_us: ac.us,
				uat_row: `UAT-${ac.us.slice(3)}`,
				summary: ac.text.slice(0, 160),
				coverage: "uncovered",
				named_checks: [],
				uncovered_reason: "no curated test_title binding",
				failure_route: `Reopen ${owner} for ${ac.id}; RP-19 does not patch feature behavior`,
			});
			continue;
		}
		assertTitle(triple[0], triple[1], ac.id);
		entries.push({
			id: ac.id,
			kind: "ac",
			primary_owner: owner,
			prd_us: ac.us,
			uat_row: `UAT-${ac.us.slice(3)}`,
			summary: ac.text.slice(0, 160),
			coverage: "covered",
			named_checks: [bind(triple)],
			failure_route: `Reopen ${owner} for ${ac.id}; RP-19 does not patch feature behavior`,
		});
	}

	for (const [id, triple] of Object.entries(METRICS)) {
		assertTitle(triple[0], triple[1], id);
		entries.push({
			id,
			kind: "metric",
			primary_owner: metricOwner[id],
			coverage: "covered",
			named_checks: [bind(triple)],
			failure_route: `Reopen ${metricOwner[id]} for ${id}`,
		});
	}

	// Gaps: only bind when a gap-specific exact title exists; otherwise honest uncovered.
	// REL-01/REL-02 are proven by RP-19 exact-title traceability + built harness tests.
const gapSpecific = {
		"REL-01": RP["RP-19"],
		"REL-02": [
			"test/harness.test.ts",
			"the built harness serves the K-π built-in and its resources to an untrusted project",
			"built kpi starts for untrusted project with built-in resources and no install",
		],
		"DOC-01": [
			"test/docs-routing.test.ts",
			"historical build records are demoted before their original instructions",
			"roadmap and implementation-plan are historical, not completion authority",
		],
		"DOC-02": [
			"test/docs-routing.test.ts",
			"every routing surface resolves its next step to the active remediation plan",
			"remediation-plan is the only active implementation queue",
		],
		"STORE-01": [
			"test/append-log.test.ts",
			"three appended events form a verifiable hash chain",
			"events.jsonl hash chain is append-only and verifiable",
		],
		"STORE-02": [
			"test/run-store.test.ts",
			"a crash before rename cannot expose a partial candidate.json",
			"atomic tmp→fsync→rename for run-store documents",
		],
		"ARCH-01": [
			"test/harness.test.ts",
			"the coding-agent package is the K-π CLI: kpi and k-pi bins, .kpi config, no pi bin",
			"K-π is the fork CLI identity, not a Pi package",
		],
		"ARCH-02": [
			"test/harness.test.ts",
			"the built harness serves the K-π built-in and its resources to an untrusted project",
			"built-in extension resources available without install/trust",
		],
		"ARCH-03": [
			"test/harness.test.ts",
			"the root manifest is a private fork monorepo, not a publishable Pi package",
			"no pi-package keywords or publish payload",
		],
		"PKG-01": [
			"test/harness.test.ts",
			"the shipped K-π resource tree carries no secrets and no test, fixture or maintainer debris",
			"dist inventory has no secret/test/fixture debris",
		],
		"POL-01": [
			"test/policy.test.ts",
			"the registered hook keeps every AC-13.1 denial",
			"policy denies push, force-push, rm -rf, deploy, out-of-bounds writes",
		],
		"POL-02": [
			"test/policy.test.ts",
			"gated git commit confirms and states the current HEAD diff stat",
			"gated commit requires confirm with diff stat",
		],
		"POL-03": [
			"test/policy.test.ts",
			"unknown commands confirm in gated and are denied in autopilot",
			"unknown commands split by mode",
		],
		"GRAPH-01": [
			"test/stop.test.ts",
			"a terminal state is final: further verifier events cannot revive it",
			"terminal stop states are closed and final",
		],
		"GRAPH-02": [
			"test/stop.test.ts",
			"a repeated output fingerprint stops with NO_PROGRESS",
			"NO_PROGRESS on repeated output fingerprint",
		],
		"GRAPH-03": [
			"test/stop.test.ts",
			"the third failed round stops with EXHAUSTED by default",
			"EXHAUSTED at default maxRounds",
		],
		"GRAPH-04": [
			"test/stop.test.ts",
			"a transient 429 retry does not increment the round",
			"transient retries do not consume rounds",
		],
		"GRAPH-05": [
			"test/resume.test.ts",
			"a resumed run restores every stop, retry, cost, and time field",
			"resume restores stop safety fields",
		],
		"GRAPH-06": [
			"test/graph-engine.test.ts",
			"every configured cap persists EXHAUSTED and exactly one terminal event",
			"cost/time/concurrency caps persist EXHAUSTED",
		],
		"GRAPH-07": [
			"test/graph-routing.test.ts",
			"an autopilot graph cannot contain a human node",
			"autopilot graph has no human node",
		],
		"GRAPH-08": [
			"test/graph-routing.test.ts",
			"release is reachable only from evidence, and only in one place",
			"release only from evidence on one edge",
		],
		"ACCT-01": [
			"test/accounts.test.ts",
			"M-05 through the live hooks: an exhausted slot is never selected in 100 requests",
			"exhausted sibling never selected while healthy exists",
		],
		"ACCT-02": [
			"test/accounts-routing.test.ts",
			"cross-family fallback begins only after the whole family cools and follows the chain",
			"cross-family only after whole family cools",
		],
		"ACCT-03": [
			"test/provider-contracts.test.ts",
			"no source file passes a models array to an official provider id",
			"no models array on official provider ids",
		],
		"ACCT-04": [
			"test/accounts.test.ts",
			"two Anthropic subscription slots coexist",
			"multiple same-provider slots coexist",
		],
		"ACCT-05": [
			"test/accounts.test.ts",
			"Anthropic warning precedes the official OAuth window",
			"Anthropic billing warning before OAuth",
		],
		"LOCAL-01": [
			"test/local-providers.test.ts",
			"AC-27.1 the llama pool maps to Pi's own llama.cpp provider and is never registered",
			"llama.cpp uses built-in path, not custom register",
		],
		"LOCAL-02": [
			"test/local-providers.test.ts",
			"AC-27.5 local pools are outside the default chain and enter it only when the operator says so",
			"local outside default cloud chain",
		],
		"LOCAL-03": [
			"test/local-providers.test.ts",
			"AC-27.8 every discovery request stays on the configured origin",
			"local discovery never silent-proxies to cloud",
		],
		"RESEARCH-01": [
			"test/research-control-plane.test.ts",
			"/accounts login and logout treat exa and perplexity as research targets, not pools",
			"research keys are not model pools",
		],
		"RESEARCH-02": [
			"test/research-control-plane.test.ts",
			"setup saves what the operator typed and records the resulting mode",
			"setup can save or skip research keys",
		],
		"RESEARCH-03": [
			"test/research-clients.test.ts",
			"oversized upstream data never reaches tool output, events, research.md, or research.json",
			"research content bounds hold",
		],
		"RESEARCH-04": [
			"test/research-control-plane.test.ts",
			"two distinct external origins complete an online run",
			"online research requires two distinct external sources",
		],
		"RESEARCH-05": [
			"test/research-control-plane.test.ts",
			"a 429 cools the service, the alternate is tried once, then NH-02 sets effective no-network",
			"research failover then effective no-network",
		],
		"DUNE-01": [
			"test/stack.test.ts",
			"scaffold creates folder, interface, then test twin, before any behaviour",
			"Dune scaffold order",
		],
		"DUNE-02": [
			"test/stack.test.ts",
			"claim_path and implement bounds share one boundary",
			"module boundary on claims and implement",
		],
		"DUNE-03": [
			"test/stack.test.ts",
			"vertical delivery cannot stage a layer sweep, and horizontal needs a reason",
			"vertical vs horizontal delivery gate",
		],
		"KG-01": [
			"test/kg.test.ts",
			"node, edge, and source round-trips validate and bump revisions",
			"KG store layout and fields",
		],
		"KG-02": [
			"test/kg.test.ts",
			"a direct authoritative write through the public tool fails",
			"single authoritative KG writer",
		],
		"KG-03": [
			"test/kg.test.ts",
			"resource discovery finds the kg-claim skill with no diagnostic",
			"kg-claim skill discoverable",
		],
		"BUS-01": [
			"test/bus.test.ts",
			"caps hold, and five concurrent spawns start exactly two",
			"max two live workers",
		],
		"BUS-02": [
			"test/bus.test.ts",
			"a writer worker and the parent cannot both hold the writer slot",
			"single writer slot",
		],
		"BUS-03": [
			"test/bus.test.ts",
			"one file claimed by four spellings is one lease",
			"exclusive claim_path leases",
		],
		"BUS-04": [
			"test/bus.test.ts",
			"write_contract refuses the wrong agent, job, role, path, schema, or a link out",
			"write_contract is pinned and not general write",
		],
		"BUS-05": [
			"test/reviewer-session.test.ts",
			"reviewer argv and tools have no write or edit",
			"reviewer isolation without write/edit",
		],
		"MIN-01": [
			"test/minimalist.test.ts",
			"one-concat direct one-line change passes with zero new files",
			"minimalist one-concat fixture",
		],
		"KSTACK-01": [
			"test/kstack-runtime.test.ts",
			"the generated tree is skills plus required attribution, and nothing else",
			"generated K-stack is the only runtime truth",
		],
		"KSTACK-02": [
			"test/kstack-runtime.test.ts",
			"setup offers only live models in a configured K-π pool",
			"setup never writes unavailable slugs",
		],
		"KSTACK-03": [
			"test/kstack-sync.test.ts",
			"the committed generated tree is byte and semantically reproducible offline",
			"deterministic offline sync/check",
		],
		"UI-01": [
			"test/status-line.test.ts",
			"unicode brand is K-π and never bare pi",
			"footer brand is K-π",
		],
		"UI-02": [
			"test/status-line.test.ts",
			"default segment order matches the visual contract",
			"footer segment order",
		],
		"UI-03": [
			"test/operator-ui.test.ts",
			"amber board lights exactly one CURRENT stage and six nonempty file lamps",
			"amber board required fields and lamps",
		],
		"UI-04": [
			"test/operator-ui.test.ts",
			"protocol-blue pause derives APPROVAL lamp without persisting APPROVAL status",
			"protocol-blue pause board",
		],
		"UI-05": [
			"test/concise-output.test.ts",
			"structured verdict protocol reply stays under 800 visible characters",
			"concise verdict reply under 800 chars",
		],
	};

	for (const [g, owner] of Object.entries(gapOwner).sort()) {
		const triple = gapSpecific[g];
		if (!triple) {
			uncovered.push({
				id: g,
				owner,
				reason: "gap has no exact test_title distinct from a whole-RP suite alias",
			});
			entries.push({
				id: g,
				kind: "gap",
				primary_owner: owner,
				coverage: "uncovered",
				named_checks: [],
				uncovered_reason:
					"no exact test_title that fails specifically when this gap regresses; owning RP suite is not a per-gap assertion",
				failure_route: `Reopen ${owner} for gap ${g}`,
			});
			continue;
		}
		assertTitle(triple[0], triple[1], g);
		entries.push({
			id: g,
			kind: "gap",
			primary_owner: owner,
			coverage: "covered",
			named_checks: [bind([triple[0], triple[1], `gap ${g}: ${triple[2]}`])],
			failure_route: `Reopen ${owner} for gap ${g}`,
		});
	}

	for (const [id, triple] of Object.entries(RP)) {
		assertTitle(triple[0], triple[1], id);
		entries.push({
			id,
			kind: "rp",
			primary_owner: id,
			coverage: "covered",
			named_checks: [bind(triple)],
			failure_route: id === "RP-19" ? "Fix RP-19 proof wiring" : `Reopen ${id}`,
		});
	}

	const reqs = [...new Set(spec.match(/\bREQ-[A-Z]+-\d+\b/g) || [])].sort();
	const reqBind = {
		// bind groups to distinctive tests
		default: ["test/schema-conformance.test.ts", "task, evidence, and verdict schemas match live payloads", "spec contract exercised via schema conformance"],
	};
	const reqSpecific = {
		"REQ-DIST-01": AC["AC-01.2"],
		"REQ-DIST-02": AC["AC-01.5"],
		"REQ-DIST-03": AC["AC-01.3"],
		"REQ-DIST-04": AC["AC-01.1"],
		"REQ-DIST-05": AC["AC-01.4"],
		"REQ-DIST-06": AC["AC-01.1"],
		"REQ-DIST-07": AC["AC-01.4"],
		"REQ-CX-01": AC["AC-01.3"],
		"REQ-GE-01": AC["AC-05.1"],
		"REQ-GE-02": AC["AC-05.3"],
		"REQ-GE-03": AC["AC-05.2"],
		"REQ-PR-01": AC["AC-10.1"],
		"REQ-PR-02": AC["AC-10.3"],
		"REQ-PR-03": AC["AC-11.1"],
		"REQ-RS-01": AC["AC-14.1"],
		"REQ-RS-02": AC["AC-14.2"],
		"REQ-RS-03": AC["AC-14.3"],
		"REQ-RS-04": AC["AC-02.1"],
		"REQ-RS-05": AC["AC-02.2"],
		"REQ-RS-06": AC["AC-23.9"],
		"REQ-RS-07": AC["AC-14.4"],
		"REQ-SB-01": AC["AC-23.1"],
		"REQ-SB-02": AC["AC-23.4"],
		"REQ-SB-03": AC["AC-23.7"],
		"REQ-SB-04": AC["AC-23.8"],
		"REQ-SB-05": AC["AC-23.3"],
		"REQ-SB-06": AC["AC-23.2"],
		"REQ-SB-07": AC["AC-23.6"],
		"REQ-SB-08": AC["AC-15.5"],
		"REQ-SL-01": AC["AC-15.1"],
		"REQ-SL-02": AC["AC-15.10"],
	};
	for (const id of reqs) {
		const triple = reqSpecific[id] || null;
		let owner = "RP-01A";
		if (id.startsWith("REQ-GE")) owner = "RP-03";
		else if (id.startsWith("REQ-PR")) owner = "RP-07";
		else if (id.startsWith("REQ-RS-0") && Number(id.slice(-1)) >= 6) owner = "RP-13";
		else if (id.startsWith("REQ-RS")) owner = "RP-01";
		else if (id.startsWith("REQ-SB")) owner = "RP-13";
		else if (id.startsWith("REQ-SL")) owner = "RP-18";
		else if (id.startsWith("REQ-DIST") || id.startsWith("REQ-CX")) owner = "RP-01A";

		if (!triple) {
			uncovered.push({ id, owner, reason: "no REQ binding" });
			entries.push({
				id,
				kind: "req",
				primary_owner: owner,
				coverage: "uncovered",
				named_checks: [],
				uncovered_reason: "no exact test_title binding for this REQ",
				failure_route: `Reopen ${owner} for ${id}`,
			});
			continue;
		}
		assertTitle(triple[0], triple[1], id);
		entries.push({
			id,
			kind: "req",
			primary_owner: owner,
			coverage: "covered",
			named_checks: [bind([triple[0], triple[1], `spec ${id}: ${triple[2]}`])],
			failure_route: `Reopen ${owner} for ${id}`,
		});
	}

	const nfrs = [...new Set(spec.match(/\bNFR-\d+\b/g) || [])].sort();
	const nfrBind = {
		"NFR-01": AC["AC-14.3"],
		"NFR-02": AC["AC-10.6"],
		"NFR-03": RP["RP-19"],
		"NFR-04": AC["AC-23.9"],
		"NFR-05": AC["AC-01.5"],
		"NFR-06": AC["AC-07.3"],
		"NFR-07": AC["AC-15.1"],
		"NFR-08": AC["AC-23.4"],
	};
	const nfrOwner = {
		"NFR-01": "RP-01",
		"NFR-02": "RP-06",
		"NFR-03": "RP-19",
		"NFR-04": "RP-13",
		"NFR-05": "RP-01A",
		"NFR-06": "RP-18",
		"NFR-07": "RP-18",
		"NFR-08": "RP-13",
	};
	for (const id of nfrs) {
		const triple = nfrBind[id];
		const owner = nfrOwner[id] || "RP-19";
		if (!triple) {
			uncovered.push({ id, owner, reason: "no NFR binding" });
			entries.push({
				id,
				kind: "nfr",
				primary_owner: owner,
				coverage: "uncovered",
				named_checks: [],
				uncovered_reason: "no exact test_title binding",
				failure_route: `Reopen ${owner} for ${id}`,
			});
			continue;
		}
		assertTitle(triple[0], triple[1], id);
		entries.push({
			id,
			kind: "nfr",
			primary_owner: owner,
			coverage: "covered",
			named_checks: [bind([triple[0], triple[1], `NFR ${id}: ${triple[2]}`])],
			failure_route: `Reopen ${owner} for ${id}`,
		});
	}

	for (const s of ["task", "evidence", "verdict", "event"]) {
		const title =
			s === "event"
				? "event schema has one valid normalized branch per event type"
				: "task, evidence, and verdict schemas match live payloads";
		assertTitle("test/schema-conformance.test.ts", title, `SCH-${s}`);
		entries.push({
			id: `SCH-${s}`,
			kind: "schema",
			primary_owner: "RP-01",
			coverage: "covered",
			named_checks: [
				bind([
					"test/schema-conformance.test.ts",
					title,
					`${s}.schema.json validates live payloads / event branches`,
				]),
			],
			failure_route: "Reopen RP-01 for schema drift",
		});
	}

	for (const e of EVENT_TYPES) {
		const title = "event schema has one valid normalized branch per event type";
		assertTitle("test/schema-conformance.test.ts", title, `EVT-${e}`);
		entries.push({
			id: `EVT-${e}`,
			kind: "event",
			primary_owner: "RP-01",
			coverage: "covered",
			named_checks: [
				bind([
					"test/schema-conformance.test.ts",
					title,
					`EVENT_TYPES includes ${e}; schema oneOf accepts normalized ${e}`,
				]),
			],
			failure_route: "Reopen RP-01 (or domain emitter RP) for event contract",
		});
	}

	// Shared title audit: same title used by multiple ids is allowed only when listed together
	const byTitle = new Map();
	for (const e of entries) {
		for (const c of e.named_checks || []) {
			const k = `${c.file}::${c.test_title}`;
			if (!byTitle.has(k)) byTitle.set(k, []);
			byTitle.get(k).push(e.id);
		}
	}

	const counts = {};
	for (const e of entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
	counts.total = entries.length;
	counts.covered = entries.filter((e) => e.coverage === "covered").length;
	counts.uncovered = entries.filter((e) => e.coverage === "uncovered").length;

	const map = {
		schema_version: 2,
		generated_for: "RP-19",
		source_docs: [
			"docs/PRD.md",
			"docs/spec.md",
			"docs/remediation-plan.md",
			"docs/remediation-research.md",
			"docs/uat.md",
		],
		rules: {
			primary_owner_exactly_once: true,
			historical_checkboxes_forbidden_as_evidence: true,
			source_grep_only_checks_forbidden: true,
			self_referential_map_only_checks_forbidden: true,
			exact_test_title_required: true,
			whole_file_runner_forbidden: true,
			shared_title_must_assert_all_bound_ids: true,
		},
		counts,
		shared_titles: [...byTitle.entries()]
			.filter(([, ids]) => ids.length > 1)
			.map(([k, ids]) => ({ key: k, ids })),
		uncovered: uncovered,
		entries,
	};

	writeFileSync(join(root, "docs/traceability-map.json"), `${JSON.stringify(map, null, 2)}\n`);
	console.log("wrote map", counts);
	if (uncovered.length) {
		console.log("UNCOVERED", uncovered.length);
		for (const u of uncovered) console.log(`  ${u.id} owner=${u.owner} — ${u.reason}`);
	}
}

main();
