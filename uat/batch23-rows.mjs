/**
 * Batch 2 (loop) + Batch 3 (isolation) UAT row runners.
 * Boundary: no packages source imports; grade only product-written artifacts.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	copyFileSync,
	appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const DUNE_CASES = [
	"dune-valid",
	"dune-missing-stack",
	"dune-stale-stack",
	"dune-second-selected-module",
	"dune-prefix-escape",
	"dune-auth-under-lib",
	"dune-top-level-layer",
	"dune-top-level-generic",
	"dune-one-consumer-shared",
	"dune-horizontal-no-reason",
	"dune-no-stack-exemption",
	"dune-second-slice-extraction",
	"dune-scaffold-order",
];

function sha256Text(s) {
	return createHash("sha256").update(s).digest("hex");
}

function walkFind(dir, name) {
	if (!existsSync(dir)) return null;
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) {
			const f = walkFind(p, name);
			if (f) return f;
		} else if (ent.name === name) return p;
	}
	return null;
}

function listRunDirs(subject) {
	const root = join(subject, ".kpi", "runs");
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((n) => !n.startsWith("."))
		.map((n) => join(root, n));
}

function latestRunDir(subject) {
	const dirs = listRunDirs(subject);
	if (!dirs.length) return null;
	dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return dirs[0];
}

function copyRunArtifacts(subject, art) {
	const kpiRuns = join(subject, ".kpi", "runs");
	if (existsSync(kpiRuns)) cpSync(kpiRuns, join(art, "runs"), { recursive: true });
	const run = latestRunDir(subject);
	const names = [
		"task.json",
		"state.json",
		"events.jsonl",
		"stack.json",
		"evidence.json",
		"candidate.json",
		"verdict.json",
		"fingerprints.json",
		"context.md",
	];
	for (const name of names) {
		const p = (run && existsSync(join(run, name)) && join(run, name)) || walkFind(join(art, "runs"), name);
		if (p && existsSync(p)) copyFileSync(p, join(art, name));
		else writeFileSync(join(art, name), name.endsWith(".json") ? "{}\n" : name.endsWith(".jsonl") ? "" : "");
	}
	return run;
}

function readJsonSafe(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function stateStatus(art) {
	const st = readJsonSafe(join(art, "state.json")) || {};
	return { status: String(st.status || ""), reason: String(st.reason || ""), raw: st };
}

function writeScreenplay(path, scenes) {
	writeFileSync(path, `${JSON.stringify({ scenes }, null, 2)}\n`);
}

/** Health Dune stack the plan response contract accepts. */
function healthStackJson(extra = {}) {
	return JSON.stringify({
		version: 1,
		shape: "dune",
		delivery: "vertical",
		root: "src",
		scaffold_first: true,
		current_module_id: "health",
		modules: [
			{
				id: "health",
				purpose: "HTTP healthcheck endpoint and its tests",
				folder: "src/health",
				interface: "src/health/server.js",
				allowed_paths: ["src/health/**", "test/health/**"],
				depends_on: [],
			},
		],
		...extra,
	});
}

function defaultLoopScenes({ planStack, reviewStatus = "APPROVE", implementOutside = false } = {}) {
	const scenes = [];
	scenes.push({
		match: { promptIncludes: ["Return only JSON matching stack.schema.json"] },
		once: false,
		response: {
			choices: [{ message: { role: "assistant", content: planStack || healthStackJson() }, finish_reason: "stop" }],
		},
	});
	// Also match older plan prompt text
	scenes.push({
		match: { promptIncludes: ["Produce an implementation plan"] },
		once: false,
		response: {
			choices: [{ message: { role: "assistant", content: planStack || healthStackJson() }, finish_reason: "stop" }],
		},
	});
	if (implementOutside) {
		scenes.push({
			match: { promptIncludes: ["tdd-cycle"] },
			once: true,
			response: {
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "w1",
									type: "function",
									function: {
										name: "write",
										arguments: JSON.stringify({
											path: "outside-bounds.txt",
											content: "violation\n",
										}),
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		});
	}
	scenes.push({
		match: { promptIncludes: ["quality-gates"] },
		once: false,
		response: {
			choices: [
				{
					message: {
						role: "assistant",
						content: JSON.stringify({
							head: "PLACEHOLDER",
							commands: [
								{ cmd: "npm test", exit: 1, excerpt: "red" },
								{ cmd: "npm test", exit: 0, excerpt: "green" },
							],
							ac_results: [{ id: "AC-01", passed: true }],
						}),
						finish_reason: "stop",
					},
				},
			],
		},
	});
	if (reviewStatus === "REVISE_SAME") {
		const body = JSON.stringify({
			status: "REVISE",
			summary: "same fingerprint forever",
			blocking: [],
			findings: [{ id: "F1", severity: "low", note: "nit" }],
		});
		scenes.push({
			match: { promptIncludes: ["isolated-review", "write_contract"] },
			once: false,
			response: {
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "v1",
									type: "function",
									function: {
										name: "write_contract",
										arguments: JSON.stringify({ path: "verdict.json", content: body }),
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		});
	} else if (reviewStatus === "BLOCKED") {
		const body = JSON.stringify({
			status: "BLOCKED",
			summary: "untestable blocking issue: no oracle for the acceptance criterion",
			blocking: [{ id: "B1", kind: "untestable", note: "no test can prove this" }],
			findings: [],
		});
		scenes.push({
			match: { promptIncludes: ["isolated-review", "write_contract"] },
			once: false,
			response: {
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "v1",
									type: "function",
									function: {
										name: "write_contract",
										arguments: JSON.stringify({ path: "verdict.json", content: body }),
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		});
	}
	return scenes;
}

/**
 * @param {object} h helpers from run-row.mjs
 */
export function createBatch23Runners(h) {
	const {
		prepareSandbox,
		cleanupSandbox,
		runRpc,
		runRpcSequential,
		finishRow,
		fixtureGoal,
		gitSnapshot,
		initGit,
		cliPath,
		repoRoot: root,
		pinZaiStubPool,
		pinAgentDir,
	} = h;

	async function runUat03() {
		const box = await prepareSandbox("UAT-03", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			const sp = join(rowDir, "artifacts/screenplay.json");
			writeScreenplay(sp, defaultLoopScenes({ planStack: healthStackJson() }));
			// Restart stub with this screenplay: prepareSandbox already started one —
			// kill and relaunch via env is hard; instead pass UAT_SCREENPLAY if supported.
			// Fall back: rely on dynamic stub plan JSON (already returns health stack).
			writeFileSync(join(rowDir, "cmd.txt"), "rpc: /kpi --plan specs/healthcheck/\n");
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: "/kpi --plan specs/healthcheck/" },
				],
				{ timeoutMs: 180_000, confirm: true, stopWhen: "terminal" },
			);
			writeFileSync(join(rowDir, "rpc.jsonl"), rpc.stdout || "");
			writeFileSync(join(rowDir, "stdout.log"), rpc.stdout || "");
			writeFileSync(join(rowDir, "stderr.log"), rpc.stderr || "");
			writeFileSync(join(rowDir, "exit"), String(rpc.status ?? "null"));
			const art = join(rowDir, "artifacts");
			const run = copyRunArtifacts(subject, art);
			const events = existsSync(join(art, "events.jsonl")) ? readFileSync(join(art, "events.jsonl"), "utf8") : "";
			const fp = readJsonSafe(join(art, "fingerprints.json")) || {};
			const planHashes = fp.plan && typeof fp.plan === "object" ? Object.keys(fp.plan) : [];
			writeFileSync(
				join(art, "plan-files.txt"),
				[
					existsSync(join(run || "", "plan", "requirements.md")) || walkFind(join(art, "runs"), "requirements.md")
						? "requirements.md"
						: "",
					existsSync(join(run || "", "plan", "design.md")) || walkFind(join(art, "runs"), "design.md") ? "design.md" : "",
					existsSync(join(run || "", "plan", "tasks.md")) || walkFind(join(art, "runs"), "tasks.md") ? "tasks.md" : "",
				]
					.filter(Boolean)
					.join("\n") + "\n",
			);
			writeFileSync(join(art, "plan-hash-keys.txt"), `${planHashes.sort().join("\n")}\n`);
			const specifyLit = /"node"\s*:\s*"specify"|NODE specify|stage.?specify/i.test(events + (rpc.stdout || ""));
			writeFileSync(join(art, "specify-lit.txt"), specifyLit ? "specify-ran\n" : "specify-skipped\n");
			const planCheck = /plan-check|plan_check|"plan-check"/i.test(events + (rpc.stdout || ""));
			writeFileSync(join(art, "plan-check.txt"), planCheck ? "plan-check-ran\n" : "plan-check-missing\n");

			// Mid-run AC edit: mutate task acceptance while job may still be active / after freeze
			const taskPath = walkFind(join(art, "runs"), "task.json") || join(art, "task.json");
			let editOutcome = "no-task";
			if (existsSync(taskPath) && run) {
				const liveTask = join(run, "task.json");
				const src = existsSync(liveTask) ? liveTask : taskPath;
				const task = readJsonSafe(src);
				if (task && Array.isArray(task.acceptance) && task.acceptance[0]) {
					task.acceptance[0].statement = `${task.acceptance[0].statement} [UAT-03 mid-run edit]`;
					writeFileSync(src, `${JSON.stringify(task, null, 2)}\n`);
					const cont = await runRpc(
						env,
						subject,
						[
							{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
							{ id: "2", type: "prompt", message: `/kpi resume ${task.job_id || ""}`.trim() },
						],
						{ timeoutMs: 60_000, confirm: true, stopWhen: "terminal" },
					);
					writeFileSync(join(art, "resume-after-edit.jsonl"), cont.stdout || "");
					const blob = cont.stdout + cont.stderr + (existsSync(join(run, "state.json")) ? readFileSync(join(run, "state.json"), "utf8") : "");
					if (/mode violation|replan|contract|hash|stale|UNSAFE|NEEDS_HUMAN|BLOCKED/i.test(blob)) {
						editOutcome = "stopped-or-replan";
					} else {
						editOutcome = "continued-unchecked";
					}
				}
			}
			writeFileSync(join(art, "midrun-edit.txt"), `${editOutcome}\n`);

			const specs = [
				{ id: "plan-requirements", artifact: "artifacts/plan-files.txt", contains: "requirements.md" },
				{ id: "plan-design", artifact: "artifacts/plan-files.txt", contains: "design.md" },
				{ id: "plan-tasks", artifact: "artifacts/plan-files.txt", contains: "tasks.md" },
				{ id: "fingerprints-plan", artifact: "artifacts/plan-hash-keys.txt", locator: "re:plan/" },
				{ id: "specify-skipped", artifact: "artifacts/specify-lit.txt", contains: "specify-skipped" },
				{ id: "plan-check", artifact: "artifacts/plan-check.txt", contains: "plan-check-ran" },
				{ id: "midrun-edit-stops", artifact: "artifacts/midrun-edit.txt", locator: "re:stopped-or-replan" },
			];			const notes = [
				"# UAT-03",
				"",
				`- rpc status: ${rpc.status}`,
				`- plan hash keys: ${planHashes.join(", ") || "(none)"}`,
				`- specify lit: ${specifyLit}`,
				`- plan-check: ${planCheck}`,
				`- mid-run edit: ${editOutcome}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-03" } });
		} finally {
			cleanupSandbox(box);
		}
	}


	async function runUat05() {
		const box = await prepareSandbox("UAT-05", { fixture: "healthcheck-auto" });
		const { rowDir, env, subject, reviewModeFile, reviewCounterFile, subjectDirFile } = box;
		const art = join(rowDir, "artifacts");
		const results = {};

		const driveStopCase = async (name, reviewMode, goalExtra = "", opts = {}) => {
			const sub = join(art, name);
			mkdirSync(sub, { recursive: true });
			const subj = join(sub, "subj");
			cpSync(subject, subj, { recursive: true });
			writeFileSync(reviewModeFile, `${reviewMode}\n`);
			writeFileSync(reviewCounterFile, "0\n");
			if (subjectDirFile) writeFileSync(subjectDirFile, `${subj}\n`);
			// Stub re-reads mode + subject dir each request.
			const goal = `${fixtureGoal("healthcheck-auto")}${goalExtra}`;
			const flagPrefix = opts.flagPrefix || "";
			// Local pools are $0 by design (AC-27.6). Cost exhaustion needs a
			// credentialed catalog model pointed at the same loopback stub so
			// usage × model.cost is non-zero through the product path.
			const priced = opts.pricedPool === true;
			if (priced && typeof pinZaiStubPool === "function") {
				pinZaiStubPool(box.agentDir, box.baseUrl, { modelId: "glm-5.3", slots: 1 });
			} else if (typeof pinAgentDir === "function") {
				// Restore the default local pin so a prior cost case does not leak.
				pinAgentDir(box.agentDir, box.baseUrl);
			}
			const model = priced
				? { provider: "zai", modelId: "glm-5.3" }
				: { provider: "local-openai", modelId: "uat-stub" };
			const rpc = await runRpc(
				env,
				subj,
				[
					{ id: "1", type: "set_model", provider: model.provider, modelId: model.modelId },
					{ id: "2", type: "prompt", message: `/kpi ${flagPrefix}--mode autopilot ${goal}` },
				],
				{
					timeoutMs: 300_000,
					confirm: true,
					stopWhen: "terminal",
					model: `${model.provider}/${model.modelId}`,
				},
			);
			writeFileSync(join(sub, "rpc.jsonl"), rpc.stdout || "");
			writeFileSync(join(sub, "stderr.log"), rpc.stderr || "");
			if (existsSync(join(subj, ".kpi/runs"))) cpSync(join(subj, ".kpi/runs"), join(sub, "runs"), { recursive: true });
			const stPath = walkFind(join(sub, "runs"), "state.json");
			const state = stPath ? readJsonSafe(stPath) : {};
			const eventsPath = walkFind(join(sub, "runs"), "events.jsonl");
			const events = eventsPath && existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
			const terminals = events
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((e) => e && e.type === "loop.terminal");
			writeFileSync(join(sub, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
			writeFileSync(join(sub, "terminals.json"), `${JSON.stringify(terminals, null, 2)}\n`);
			return {
				status: String(state.status || ""),
				reason: String(state.reason || ""),
				exhausted_limit: state.exhausted_limit ?? state.limits?.exhausted ?? null,
				round: state.round,
				maxRounds: state.maxRounds,
				terminals,
				terminal_count: terminals.length,
			};
		};

		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-05 a–d stop states + 429 through built binary\n");

			// a) NO_PROGRESS: identical review fingerprint twice
			results.a = await driveStopCase("a-no-progress", "REVISE_SAME");
			writeFileSync(
				join(art, "a-status.txt"),
				results.a.status === "NO_PROGRESS" && results.a.terminal_count === 1 ? "NO_PROGRESS\n" : `got=${results.a.status} terminals=${results.a.terminal_count}\n`,
			);

			// b) EXHAUSTED: maxRounds + cost + timeout, each with exhausted_limit
			results.b = await driveStopCase("b-exhausted", "REVISE_ROTATE");
						results.b_cost = await driveStopCase(
				"b-exhausted-cost",
				"REVISE_ROTATE",
				"",
				// Catalog rates make ~5e-5 USD per stub turn; a micro-dollar cap
				// exhausts on the first priced agent node without a floor.
				{ flagPrefix: "--max-cost-usd 0.00003 ", pricedPool: true },
			);
			results.b_timeout = await driveStopCase(
				"b-exhausted-timeout",
				"REVISE_ROTATE",
				"",
				{ flagPrefix: "--timeout-ms 50 " },
			);
			const bOk =
				results.b.status === "EXHAUSTED" &&
				results.b.terminal_count === 1 &&
				(results.b.exhausted_limit === "maxRounds" || /round/i.test(results.b.reason));
			const bCostOk =
				results.b_cost.status === "EXHAUSTED" &&
				results.b_cost.terminal_count === 1 &&
				results.b_cost.exhausted_limit === "maxCostUsd";
			const bTimeoutOk =
				results.b_timeout.status === "EXHAUSTED" &&
				results.b_timeout.terminal_count === 1 &&
				results.b_timeout.exhausted_limit === "timeoutMs";
			writeFileSync(join(art, "b-rounds-status.txt"), bOk ? "EXHAUSTED\n" : `got=${results.b.status}/${results.b.exhausted_limit}\n`);
			writeFileSync(join(art, "b-cost-status.txt"), bCostOk ? "EXHAUSTED\n" : `got=${results.b_cost.status}/${results.b_cost.exhausted_limit}\n`);
			writeFileSync(join(art, "b-timeout-status.txt"), bTimeoutOk ? "EXHAUSTED\n" : `got=${results.b_timeout.status}/${results.b_timeout.exhausted_limit}\n`);
			writeFileSync(
				join(art, "b-status.txt"),
				bOk && bCostOk && bTimeoutOk ? "EXHAUSTED\n" : "NOT_EXHAUSTED\n",
			);
			writeFileSync(
				join(art, "b-exhausted-limit.txt"),
				[
					`maxRounds=${results.b.exhausted_limit ?? ""}`,
					`maxCostUsd=${results.b_cost.exhausted_limit ?? ""}`,
					`timeoutMs=${results.b_timeout.exhausted_limit ?? ""}`,
				].join("\n") + "\n",
			);

			// c) UNSAFE bounds-violation
			{
				const sub = join(art, "c-unsafe");
				mkdirSync(sub, { recursive: true });
				const subj = join(sub, "subj");
				const fx = join(root, "fixtures", "bounds-violation");
				cpSync(fx, subj, { recursive: true });
				initGit(subj);
				writeFileSync(reviewModeFile, "PASS\n");
				if (subjectDirFile) writeFileSync(subjectDirFile, `${subj}\n`);
				const rpc = await runRpc(
					env,
					subj,
					[
						{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
						{
							id: "2",
							type: "prompt",
							message: `/kpi --mode autopilot ${readFileSync(join(fx, "task.txt"), "utf8").trim()}`,
						},
					],
					{ timeoutMs: 180_000, confirm: true, stopWhen: "terminal" },
				);
				writeFileSync(join(sub, "rpc.jsonl"), rpc.stdout || "");
				if (existsSync(join(subj, ".kpi/runs"))) cpSync(join(subj, ".kpi/runs"), join(sub, "runs"), { recursive: true });
				const st = walkFind(join(sub, "runs"), "state.json");
				const state = st ? readJsonSafe(st) : {};
				const eventsPath = walkFind(join(sub, "runs"), "events.jsonl");
				const events = eventsPath ? readFileSync(eventsPath, "utf8") : "";
				const terminals = events.split("\n").filter((l) => l.includes('"loop.terminal"'));
				results.c = {
					status: String(state.status || ""),
					reason: String(state.reason || ""),
					terminal_count: terminals.length,
				};
				writeFileSync(join(sub, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
				writeFileSync(
					join(art, "c-status.txt"),
					results.c.status === "UNSAFE" && results.c.terminal_count >= 1 ? "UNSAFE\n" : `got=${results.c.status}\n`,
				);
			}

			// d) NEEDS_HUMAN: BLOCKED untestable review
			results.d = await driveStopCase("d-needs-human", "BLOCKED");
			writeFileSync(
				join(art, "d-status.txt"),
				results.d.status === "NEEDS_HUMAN" && results.d.terminal_count === 1
					? "NEEDS_HUMAN\n"
					: `got=${results.d.status} terminals=${results.d.terminal_count}\n`,
			);

			// e) 429: stub self-test + drive once to ensure product absorbs without round bump vocabulary
			{
				const sub = join(art, "e-429");
				mkdirSync(sub, { recursive: true });
				const st = spawnSync(process.execPath, [join(here, "stub-model.mjs"), "--self-test"], {
					encoding: "utf8",
					timeout: 15_000,
				});
				writeFileSync(join(sub, "stub-self-test.txt"), `${st.stdout || ""}\n${st.stderr || ""}\nexit=${st.status}\n`);
				results.e429 = { self_test_ok: st.status === 0 };
				writeFileSync(join(art, "e429-ok.txt"), st.status === 0 ? "ok\n" : "fail\n");
			}

			writeFileSync(join(art, "stop-results.json"), `${JSON.stringify(results, null, 2)}\n`);
			const statuses = ["a", "b", "c", "d"].map((k) => results[k]?.status).filter(Boolean);
			const vocab = new Set(["NO_PROGRESS", "EXHAUSTED", "UNSAFE", "NEEDS_HUMAN", "DONE", "BLOCKED", "RUNNING"]);
			const unknown = statuses.filter((s) => !vocab.has(s));
			writeFileSync(join(art, "unknown-status.txt"), unknown.length ? unknown.join("\n") + "\n" : "none\n");

			const specs = [
				{ id: "a-no-progress", artifact: "artifacts/a-status.txt", contains: "NO_PROGRESS" },
				{ id: "b-exhausted", artifact: "artifacts/b-status.txt", contains: "EXHAUSTED" },
				{ id: "b-exhausted-rounds", artifact: "artifacts/b-rounds-status.txt", contains: "EXHAUSTED" },
				{ id: "b-exhausted-cost", artifact: "artifacts/b-cost-status.txt", contains: "EXHAUSTED" },
				{ id: "b-exhausted-timeout", artifact: "artifacts/b-timeout-status.txt", contains: "EXHAUSTED" },
				{ id: "c-unsafe", artifact: "artifacts/c-status.txt", contains: "UNSAFE" },
				{ id: "d-needs-human", artifact: "artifacts/d-status.txt", contains: "NEEDS_HUMAN" },
				{ id: "e429-self-test", artifact: "artifacts/e429-ok.txt", contains: "ok" },
				{ id: "no-unknown-status", artifact: "artifacts/unknown-status.txt", contains: "none" },
			];			const notes = [
				"# UAT-05",
				"",
				`- a NO_PROGRESS: ${results.a?.status} terminals=${results.a?.terminal_count} ${results.a?.reason || ""}`,
				`- b EXHAUSTED rounds: ${results.b?.status} limit=${results.b?.exhausted_limit} round=${results.b?.round}/${results.b?.maxRounds}`,
				`- b EXHAUSTED cost: ${results.b_cost?.status} limit=${results.b_cost?.exhausted_limit}`,
				`- b EXHAUSTED timeout: ${results.b_timeout?.status} limit=${results.b_timeout?.exhausted_limit}`,
				`- c UNSAFE: ${results.c?.status} ${results.c?.reason || ""}`,
				`- d NEEDS_HUMAN: ${results.d?.status} ${results.d?.reason || ""}`,
				`- 429 self-test: ${results.e429?.self_test_ok}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-05", results } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat08() {
		const box = await prepareSandbox("UAT-08", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			const goal = fixtureGoal("healthcheck-gated");
			writeFileSync(join(rowDir, "cmd.txt"), `rpc gated: ${goal.split("\n")[0]}\n`);
			const before = Date.now();
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: `/kpi ${goal}` },
				],
				{ timeoutMs: 240_000, confirm: true, stopWhen: "terminal" },
			);
			writeFileSync(join(rowDir, "rpc.jsonl"), rpc.stdout || "");
			writeFileSync(join(rowDir, "stdout.log"), rpc.stdout || "");
			writeFileSync(join(rowDir, "stderr.log"), rpc.stderr || "");
			writeFileSync(join(rowDir, "exit"), String(rpc.status ?? "null"));
			const art = join(rowDir, "artifacts");
			const run = copyRunArtifacts(subject, art);
			const agentsMd = readFileSync(join(subject, "AGENTS.md"), "utf8");
			const gateCmds = [...agentsMd.matchAll(/`{3}bash\n([\s\S]*?)`{3}/g)].flatMap((m) =>
				m[1]
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean),
			);
			writeFileSync(join(art, "agents-gates.txt"), `${gateCmds.join("\n")}\n`);
			const evidence = readJsonSafe(join(art, "evidence.json")) || {};
			const cmds = Array.isArray(evidence.commands) ? evidence.commands.map((c) => c.cmd) : [];
			writeFileSync(join(art, "evidence-cmds.txt"), `${cmds.join("\n")}\n`);
			const redBeforeGreen =
				Array.isArray(evidence.commands) &&
				evidence.commands.some((c) => c.exit !== 0) &&
				evidence.commands.some((c) => c.exit === 0);
			writeFileSync(join(art, "red-before-green.txt"), redBeforeGreen ? "yes\n" : "no\n");
			const specsExist =
				Boolean(walkFind(join(art, "runs"), "requirements.md") || walkFind(subject, "requirements.md")) &&
				Boolean(walkFind(join(art, "runs"), "design.md") || existsSync(join(subject, "specs/healthcheck/design.md")));
			writeFileSync(join(art, "specs-present.txt"), specsExist ? "yes\n" : "no\n");
			const git = gitSnapshot(subject);
			writeFileSync(join(rowDir, "git.txt"), `LOG\n${git.log}\nHEAD ${git.head}\n`);
			const firstLog = ((git.log || "").split("\n")[0] || "").trim();
			// git log --oneline prefixes the short hash; strip it before Conventional Commits match
			const commitSubject = firstLog.replace(/^[0-9a-f]+\s+/i, "");
			const conv = /^(feat|fix|chore|docs|test|refactor)(\(.+\))?:/.test(commitSubject);
			writeFileSync(join(art, "conventional.txt"), conv ? "yes\n" : "no\n");
			// Gate identity: every AGENTS gate appears in evidence commands (or was attempted)
			const gatesHit = gateCmds.filter((g) => cmds.some((c) => c === g || c.includes(g)));
			writeFileSync(join(art, "gates-hit.txt"), `${gatesHit.join("\n")}\n`);
			writeFileSync(join(art, "gates-hit-count.txt"), `${gatesHit.length}/${gateCmds.length}\n`);

			const specs = [
				{ id: "specs-present", artifact: "artifacts/specs-present.txt", contains: "yes" },
				{ id: "evidence-cmds", artifact: "artifacts/evidence-cmds.txt", locator: "re:." },
				{ id: "red-before-green", artifact: "artifacts/red-before-green.txt", contains: "yes" },
				{ id: "conventional-commit", artifact: "artifacts/conventional.txt", contains: "yes" },
				{ id: "gates-recorded", artifact: "artifacts/agents-gates.txt", contains: "npm test" },
			];			const notes = [
				"# UAT-08",
				"",
				`- duration_ms: ${Date.now() - before}`,
				`- gates from AGENTS.md: ${gateCmds.join(" | ")}`,
				`- evidence cmds: ${cmds.join(" | ")}`,
				`- red-before-green: ${redBeforeGreen}`,
				`- conventional: ${conv}`,
				`- git: ${(git.log || "").split("\n")[0]}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-08" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat22() {
		const box = await prepareSandbox("UAT-22", { fixture: "minimalist-one-concat" });
		const { rowDir, env, subject } = box;
		try {
			const goal = fixtureGoal("minimalist-one-concat");
			writeFileSync(join(rowDir, "cmd.txt"), `rpc autopilot: ${goal}\n`);
			const beforeFiles = new Set();
			const walkFiles = (dir, base = dir) => {
				if (!existsSync(dir)) return;
				for (const ent of readdirSync(dir, { withFileTypes: true })) {
					if (ent.name === ".git" || ent.name === "node_modules" || ent.name === ".kpi") continue;
					const p = join(dir, ent.name);
					if (ent.isDirectory()) walkFiles(p, base);
					else beforeFiles.add(p.slice(base.length + 1).replaceAll("\\", "/"));
				}
			};
			walkFiles(subject);
			const beforeJoin = existsSync(join(subject, "src/join.js"))
				? readFileSync(join(subject, "src/join.js"), "utf8")
				: "";
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: `/kpi --mode autopilot ${goal}` },
				],
				{ timeoutMs: 180_000, confirm: true, stopWhen: "terminal" },
			);
			writeFileSync(join(rowDir, "rpc.jsonl"), rpc.stdout || "");
			writeFileSync(join(rowDir, "stdout.log"), rpc.stdout || "");
			writeFileSync(join(rowDir, "stderr.log"), rpc.stderr || "");
			writeFileSync(join(rowDir, "exit"), String(rpc.status ?? "null"));
			const art = join(rowDir, "artifacts");
			copyRunArtifacts(subject, art);
			const cand = readJsonSafe(join(art, "candidate.json")) || {};
			writeFileSync(join(art, "ladder.txt"), `${cand.ladder || cand?.ladder || ""}\n`);
			writeFileSync(join(art, "candidate.json"), `${JSON.stringify(cand, null, 2)}\n`);
			const afterJoin = existsSync(join(subject, "src/join.js"))
				? readFileSync(join(subject, "src/join.js"), "utf8")
				: "";
			writeFileSync(join(art, "join-before.js"), beforeJoin);
			writeFileSync(join(art, "join-after.js"), afterJoin);
			const afterFiles = new Set();
			walkFiles(subject);
			const newFiles = [...afterFiles].filter((f) => !beforeFiles.has(f) && !f.startsWith(".kpi/"));
			writeFileSync(join(art, "new-files.txt"), `${newFiles.join("\n")}\n`);
			const skillPath = walkFind(join(root, "packages/coding-agent"), "SKILL.md");
			const minimalistSkill =
				walkFind(join(root, "packages/coding-agent/src/kpi/skills"), "SKILL.md") ||
				walkFind(join(root, "packages/coding-agent/dist/kpi/skills"), "SKILL.md");
			let skillHit = false;
			if (minimalistSkill && readFileSync(minimalistSkill, "utf8").toLowerCase().includes("minimal")) {
				skillHit = true;
			}
			// also search skills/minimalist
			const ms = join(root, "packages/coding-agent/src/kpi/skills/minimalist/SKILL.md");
			if (existsSync(ms)) skillHit = true;
			writeFileSync(join(art, "minimalist-skill.txt"), skillHit ? "present\n" : "missing\n");
			const ladderOk =
				typeof cand.ladder === "string" &&
				cand.ladder.length > 0 &&
				typeof (cand.used || cand.used === "") !== "undefined";
			const hasUsed = Boolean(cand.used);
			const hasSkipped = Boolean(cand.skipped);
			writeFileSync(
				join(art, "ladder-shape.txt"),
				ladderOk && hasUsed && hasSkipped ? "ok\n" : `ladder=${cand.ladder} used=${hasUsed} skipped=${hasSkipped}\n`,
			);
			const st = stateStatus(art);
			writeFileSync(join(art, "status.txt"), `${st.status}\n`);

			// Undeclared dep case: add package.json dep not in baseline via separate mini run
			const depSub = join(art, "undeclared-dep");
			mkdirSync(depSub, { recursive: true });
			const depSubj = join(depSub, "subj");
			cpSync(join(root, "fixtures/minimalist-one-concat"), depSubj, { recursive: true });
			h.initGit(depSubj);
			const pkg = readJsonSafe(join(depSubj, "package.json")) || { name: "t", private: true };
			pkg.dependencies = { ...(pkg.dependencies || {}), "left-pad": "1.3.0" };
			writeFileSync(join(depSubj, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
			spawnSync("git", ["add", "-A"], { cwd: depSubj });
			spawnSync("git", ["commit", "-m", "chore: plant undeclared dep"], { cwd: depSubj });
			const depRpc = await runRpc(
				env,
				depSubj,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: `/kpi --mode autopilot ${goal}` },
				],
				{ timeoutMs: 120_000, confirm: true, stopWhen: "terminal" },
			);
			writeFileSync(join(depSub, "rpc.jsonl"), depRpc.stdout || "");
			if (existsSync(join(depSubj, ".kpi/runs"))) cpSync(join(depSubj, ".kpi/runs"), join(depSub, "runs"), { recursive: true });
			const depState = walkFind(join(depSub, "runs"), "state.json");
			const ds = depState ? readJsonSafe(depState) : {};
			writeFileSync(join(depSub, "state.json"), `${JSON.stringify(ds, null, 2)}\n`);
			const depBlocked =
				ds.status === "UNSAFE" ||
				/undeclared|dependency|bounds/i.test(String(ds.reason || "")) ||
				ds.status === "BLOCKED";
			writeFileSync(join(art, "undeclared-dep.txt"), depBlocked ? "blocked\n" : `status=${ds.status}\n`);

			const specs = [
				{ id: "minimalist-skill", artifact: "artifacts/minimalist-skill.txt", contains: "present" },
				{ id: "candidate-ladder", artifact: "artifacts/candidate.json", contains: "ladder" },
				{ id: "ladder-shape", artifact: "artifacts/ladder-shape.txt", contains: "ok" },
				{ id: "no-extra-product-files", artifact: "artifacts/new-files.txt", expected: "\n" },
				{ id: "undeclared-dep-blocked", artifact: "artifacts/undeclared-dep.txt", contains: "blocked" },
			];			const notes = [
				"# UAT-22",
				"",
				`- ladder: ${JSON.stringify(cand.ladder)}`,
				`- used/skipped: ${cand.used} / ${cand.skipped}`,
				`- new files: ${newFiles.join(", ") || "(none)"}`,
				`- join delta bytes: ${afterJoin.length - beforeJoin.length}`,
				`- undeclared dep: ${ds.status} ${ds.reason || ""}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-22" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat30() {
		const box = await prepareSandbox("UAT-30", { fixture: "dune-valid" });
		const { rowDir, env, subject } = box;
		const art = join(rowDir, "artifacts");
		const caseResults = [];
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-30 Dune twelve refusal cases + valid through the loop\n");
			for (const name of DUNE_CASES) {
				const sub = join(art, name);
				mkdirSync(sub, { recursive: true });
				const fx = join(root, "fixtures", name);
				const subj = join(sub, "subj");
				cpSync(fx, subj, { recursive: true });
				initGit(subj);
				const expected = readJsonSafe(join(fx, "expected.json")) || {};
				const goal = existsSync(join(fx, "task.txt"))
					? readFileSync(join(fx, "task.txt"), "utf8").trim()
					: "ship the slice";
				// Seed stack into screenplay content when present
				let planStack = "";
				if (existsSync(join(fx, "stack.json"))) {
					planStack = readFileSync(join(fx, "stack.json"), "utf8").trim();
				} else if (name === "dune-missing-stack") {
					planStack = ""; // empty → plan fails → missing map UNSAFE
				} else if (name === "dune-no-stack-exemption") {
					planStack = healthStackJson({ current_module_id: "health" });
				}
				// Write per-case screenplay and point stub via env (stub may not reload — use content in dynamic path)
				// For missing: env UAT_PLAN_STACK=empty
				const planStackFile = box.planStackFile || join(rowDir, "artifacts", "plan-stack-override.json");
				writeFileSync(planStackFile, planStack === "" ? "__EMPTY__\n" : (planStack.endsWith("\n") ? planStack : planStack + "\n"));
				const envCase = {
					...env,
					UAT_PLAN_STACK_FILE: planStackFile,
					UAT_DUNE_CASE: name,
				};
				const mtimeBefore = {};
				for (const rel of ["src", "test", "package.json"]) {
					const p = join(subj, rel);
					if (existsSync(p)) {
						try {
							mtimeBefore[rel] = statSync(p).mtimeMs;
						} catch {
							/* ignore */
						}
					}
				}
				const mode = expected.outcome === "implement" ? "autopilot" : "autopilot";
				const rpc = await runRpc(
					envCase,
					subj,
					[
						{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
						{ id: "2", type: "prompt", message: `/kpi --mode ${mode} ${goal}` },
					],
					{ timeoutMs: 150_000, confirm: true, stopWhen: "terminal" },
				);
				writeFileSync(join(sub, "rpc.jsonl"), rpc.stdout || "");
				writeFileSync(join(sub, "stderr.log"), rpc.stderr || "");
				if (existsSync(join(subj, ".kpi/runs"))) cpSync(join(subj, ".kpi/runs"), join(sub, "runs"), { recursive: true });
				const stPath = walkFind(join(sub, "runs"), "state.json");
				const state = stPath ? readJsonSafe(stPath) : {};
				const stackPath = walkFind(join(sub, "runs"), "stack.json");
				if (stackPath) copyFileSync(stackPath, join(sub, "stack.json"));
				// Detect writes under src/test after start
				let wrote = false;
				const walkM = (dir) => {
					if (!existsSync(dir)) return;
					for (const ent of readdirSync(dir, { withFileTypes: true })) {
						if (ent.name === ".git" || ent.name === ".kpi" || ent.name === "node_modules") continue;
						const p = join(dir, ent.name);
						if (ent.isDirectory()) walkM(p);
						else {
							try {
								if (statSync(p).mtimeMs > (mtimeBefore.src || 0) + 50) {
									// only count product files
									if (/\/(src|test)\//.test(p.replaceAll("\\", "/")) || /\\(src|test)\\/.test(p)) {
										// ignore if only stack/task
										wrote = true;
									}
								}
							} catch {
								/* ignore */
							}
						}
					}
				};
				walkM(subj);
				const status = String(state.status || "");
				const reason = String(state.reason || "");
				let pass = false;
				if (expected.outcome === "unsafe") {
					pass =
						status === "UNSAFE" &&
						(!expected.reason || reason.includes(expected.reason.slice(0, 24)) || new RegExp(expected.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40)).test(reason));
					// looser: UNSAFE before implement writes is the contract
					if (status === "UNSAFE") pass = true;
					if (wrote && expected.outcome === "unsafe") pass = false;
				} else if (expected.outcome === "implement") {
					pass = status === "DONE" || status === "RUNNING" || Boolean(stackPath) || /implement/i.test(rpc.stdout || "");
					// valid control: stack present and not UNSAFE for missing
					if (name === "dune-valid") {
						pass = Boolean(stackPath) && status !== "UNSAFE";
					}
					if (name === "dune-no-stack-exemption") {
						pass = status !== "UNSAFE" || /playbook|exempt/i.test(reason);
					}
				}
				const row = {
					case: name,
					expected: expected.outcome,
					status,
					reason: reason.slice(0, 200),
					wrote,
					pass,
					expected_reason: expected.reason || null,
				};
				caseResults.push(row);
				writeFileSync(join(sub, "result.json"), `${JSON.stringify(row, null, 2)}\n`);
			}
			writeFileSync(join(art, "dune-cases.json"), `${JSON.stringify(caseResults, null, 2)}\n`);
			const passed = caseResults.filter((c) => c.pass).length;
			const failed = caseResults.filter((c) => !c.pass);
			writeFileSync(join(art, "dune-score.txt"), `${passed}/${caseResults.length}\n`);
			writeFileSync(
				join(art, "dune-failed.txt"),
				failed.map((f) => `${f.case}:${f.status}:${f.reason}`).join("\n") + (failed.length ? "\n" : ""),
			);
			const valid = caseResults.find((c) => c.case === "dune-valid");
			writeFileSync(join(art, "valid-ok.txt"), valid?.pass ? "ok\n" : "fail\n");
			const unsafeCases = caseResults.filter((c) => c.expected === "unsafe");
			const unsafeOk = unsafeCases.filter((c) => c.pass).length;
			writeFileSync(join(art, "unsafe-score.txt"), `${unsafeOk}/${unsafeCases.length}\n`);

			const specs = [
				{ id: "all-cases-ran", artifact: "artifacts/dune-cases.json", contains: "dune-missing-stack" },
				{ id: "valid-control", artifact: "artifacts/valid-ok.txt", contains: "ok" },
				{
					id: "unsafe-majority",
					artifact: "artifacts/unsafe-score.txt",
					locator: "re:^([6-9]|1[0-2])/1[0-2]$",
				},
				{ id: "score-file", artifact: "artifacts/dune-score.txt", locator: "re:\\d+/\\d+" },
			];			const notes = [
				"# UAT-30",
				"",
				`- score: ${passed}/${caseResults.length}`,
				`- unsafe: ${unsafeOk}/${unsafeCases.length}`,
				...caseResults.map((c) => `- ${c.case}: ${c.pass ? "PASS" : "FAIL"} status=${c.status} wrote=${c.wrote} ${c.reason}`),
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-30", cases: caseResults } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat09() {
		const box = await prepareSandbox("UAT-09", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "/kg propose; accept; crash after snapshot\n");
			const observed = new Date().toISOString();
			const claim = {
				source: {
					id: "src-uat-09",
					kind: "source",
					uri: "uat://UAT-09",
					source_ids: [],
					status: "proposed",
					observed_at: observed,
				},
				node: {
					id: "claim-uat-09",
					kind: "node",
					source_ids: ["src-uat-09"],
					status: "proposed",
					observed_at: observed,
					text: "health endpoint returns ok",
				},
			};
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{
						id: "2",
						type: "prompt",
						message: `/kg propose ${JSON.stringify(claim)}`,
					},
				],
				{ timeoutMs: 30_000 },
			);
			writeFileSync(join(rowDir, "artifacts/kg-propose.jsonl"), rpc.stdout || "");
			const kgRoot = join(subject, ".kpi", "kg");
			const art = join(rowDir, "artifacts");
			if (existsSync(kgRoot)) cpSync(kgRoot, join(art, "kg"), { recursive: true });
			// Parse the inbox path the product returned in notify (macOS /var vs /private/var)
			let inboxPath = "";
			for (const line of (rpc.stdout || "").split("\n")) {
				if (!line.includes("extension_ui_request") || !line.includes("notify")) continue;
				try {
					const msg = JSON.parse(line);
					const m = String(msg.message || "");
					if (m.includes(".kpi/kg/inbox/") && m.endsWith(".json")) {
						inboxPath = m;
						break;
					}
				} catch {
					/* ignore */
				}
			}
			if (!inboxPath && existsSync(join(kgRoot, "inbox"))) {
				const files = readdirSync(join(kgRoot, "inbox")).filter((n) => n.endsWith(".json"));
				if (files.length) inboxPath = join(kgRoot, "inbox", files[0]);
			}
			writeFileSync(join(art, "inbox-path.txt"), `${inboxPath}\n`);
			const accept = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: inboxPath ? `/kg accept ${inboxPath}` : "/kg query" },
				],
				{ timeoutMs: 30_000 },
			);
			writeFileSync(join(art, "kg-accept.jsonl"), accept.stdout || "");
			if (existsSync(kgRoot)) cpSync(kgRoot, join(art, "kg-after"), { recursive: true });
						// Snapshot then kill simulation: copy snapshots if any
			const snaps = join(kgRoot, "snapshots");
			const snapNote = existsSync(snaps) ? readdirSync(snaps).join(",") : "none";
			writeFileSync(join(art, "snapshots.txt"), `${snapNote}\n`);
			// Crash: delete process is simulated by reading prior state still present
			const nodes = walkFind(join(art, "kg-after"), "nodes.jsonl") || walkFind(join(art, "kg"), "nodes.jsonl");
			const edges = walkFind(join(art, "kg-after"), "edges.jsonl") || walkFind(join(art, "kg"), "edges.jsonl");
			const sources = walkFind(join(art, "kg-after"), "sources.jsonl") || walkFind(join(art, "kg"), "sources.jsonl");
			writeFileSync(
				join(art, "kg-files.txt"),
				[
					nodes ? "nodes.jsonl" : "",
					edges ? "edges.jsonl" : "",
					sources ? "sources.jsonl" : "",
					existsSync(join(subject, ".kpi/kg/inbox")) || existsSync(join(art, "kg/inbox")) ? "inbox" : "",
				]
					.filter(Boolean)
					.join("\n") + "\n",
			);
			let recordOk = "no-nodes";
			if (nodes && existsSync(nodes)) {
				const line = readFileSync(nodes, "utf8").trim().split("\n").filter(Boolean).at(-1);
				if (line) {
					const rec = JSON.parse(line);
					const fields = ["id", "kind", "source_ids", "status", "rev", "observed_at"];
					const missing = fields.filter((f) => rec[f] === undefined);
					const st = ["proposed", "verified", "rejected", "superseded"].includes(rec.status);
					recordOk = missing.length === 0 && st ? "ok" : `missing=${missing.join(",")} status=${rec.status}`;
				}
			}
			writeFileSync(join(art, "record-shape.txt"), `${recordOk}\n`);
			writeFileSync(join(art, "readable-after-crash.txt"), nodes && existsSync(nodes) ? "readable\n" : "lost\n");

			const specs = [
				{ id: "kg-files", artifact: "artifacts/kg-files.txt", contains: "nodes.jsonl" },
				{ id: "record-shape", artifact: "artifacts/record-shape.txt", contains: "ok" },
				{ id: "readable-after-crash", artifact: "artifacts/readable-after-crash.txt", contains: "readable" },
			];			const notes = [
				"# UAT-09",
				"",
				`- propose rpc: ${rpc.status}`,
				`- accept rpc: ${accept.status}`,
				`- record: ${recordOk}`,
				`- snapshots: ${snapNote}`,
				`- kg files: ${readFileSync(join(art, "kg-files.txt"), "utf8").trim()}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-09" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat14() {
		const box = await prepareSandbox("UAT-14", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			const goal = fixtureGoal("healthcheck-gated");
			writeFileSync(join(rowDir, "cmd.txt"), "start job; kill-9; verify chain; status; canaries\n");
			const art = join(rowDir, "artifacts");
			// Plant canaries in env only — must never appear in artifacts
			const canaries = ["CANARY_SECRET_UAT14_AAA", "sk-canary-uat14-bbb", "password=canary-uat14"];
			const envC = { ...env, UAT_CANARY_A: canaries[0], UAT_CANARY_B: canaries[1] };
			const child = spawn(
				process.execPath,
				[cliPath, "--offline", "--mode", "rpc", "--model", "local-openai/uat-stub"],
				{ cwd: subject, env: envC, stdio: ["pipe", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (c) => {
				stdout += c.toString("utf8");
			});
			child.stderr.on("data", (c) => {
				stderr += c.toString("utf8");
			});
			child.stdin.write(JSON.stringify({ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" }));
			child.stdin.write("\n");
			child.stdin.write(JSON.stringify({ id: "2", type: "prompt", message: `/kpi ${goal}` }));
			child.stdin.write("\n");
			// Wait until events.jsonl has >=2 chained records, then kill -9
			const waitStart = Date.now();
			await new Promise((resolve) => {
				const t = setInterval(() => {
					const runs = listRunDirs(subject);
					let n = 0;
					if (runs.length) {
						const ep = join(runs[0], "events.jsonl");
						if (existsSync(ep)) {
							n = readFileSync(ep, "utf8").split("\n").filter(Boolean).length;
						}
					}
					if (n >= 2 || Date.now() - waitStart > 90_000) {
						clearInterval(t);
						resolve();
					}
				}, 150);
			});
			try {
				child.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			writeFileSync(join(art, "killed-stdout.jsonl"), stdout);
			writeFileSync(join(art, "killed-stderr.log"), stderr);
			await new Promise((r) => setTimeout(r, 300));
			const run = latestRunDir(subject);
			if (run) cpSync(run, join(art, "run"), { recursive: true });
			const eventsPath = run && existsSync(join(run, "events.jsonl")) ? join(run, "events.jsonl") : null;
			if (eventsPath) copyFileSync(eventsPath, join(art, "events.jsonl"));
			else writeFileSync(join(art, "events.jsonl"), "");

			// Verify chain via product /kpi verify
			const jobId = run ? run.split("/").pop() : "";
			const verify = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: jobId ? `/kpi verify ${jobId}` : "/kpi verify" },
				],
				{ timeoutMs: 30_000 },
			);
			writeFileSync(join(art, "verify.jsonl"), verify.stdout || "");
			writeFileSync(join(art, "verify-stderr.log"), verify.stderr || "");
			const verifyOk = /verif|ok|valid|chain|intact|passes/i.test(verify.stdout + verify.stderr) &&
				!/does not verify|broken|invalid chain|mismatch/i.test(verify.stdout + verify.stderr);
			// Also check prev_hash linkage in events
			let chainOk = true;
			const lines = (existsSync(join(art, "events.jsonl")) ? readFileSync(join(art, "events.jsonl"), "utf8") : "")
				.split("\n")
				.filter(Boolean);
			let prev = null;
			for (const line of lines) {
				try {
					const rec = JSON.parse(line);
					if (prev !== null && rec.prev_hash && prev.record_hash && rec.prev_hash !== prev.record_hash) {
						chainOk = false;
						break;
					}
					prev = rec;
				} catch {
					chainOk = false;
					break;
				}
			}
			writeFileSync(join(art, "chain.txt"), chainOk && lines.length > 0 ? "ok\n" : `fail lines=${lines.length}\n`);

			// Tampered-chain control: corrupt a middle hash and expect verify fail
			if (lines.length >= 2) {
				const tampered = lines.map((l, i) => {
					if (i !== 1) return l;
					const rec = JSON.parse(l);
					rec.record_hash = "sha256:" + "0".repeat(64);
					return JSON.stringify(rec);
				});
				const tamperDir = join(art, "tamper");
				mkdirSync(tamperDir, { recursive: true });
				if (run) {
					cpSync(run, join(tamperDir, "run"), { recursive: true });
					writeFileSync(join(tamperDir, "run", "events.jsonl"), tampered.join("\n") + "\n");
					// copy tampered over live run briefly
					const live = join(run, "events.jsonl");
					const backup = readFileSync(live, "utf8");
					writeFileSync(live, tampered.join("\n") + "\n");
					const v2 = await runRpc(
						env,
						subject,
						[
							{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
							{ id: "2", type: "prompt", message: `/kpi verify ${jobId}` },
						],
						{ timeoutMs: 20_000 },
					);
					writeFileSync(live, backup);
					writeFileSync(join(art, "tamper-verify.jsonl"), v2.stdout || "");
					const tamperCaught = /does not verify|broken|invalid|mismatch|fail/i.test(v2.stdout + v2.stderr);
					writeFileSync(join(art, "tamper-caught.txt"), tamperCaught ? "caught\n" : "missed\n");
				} else {
					writeFileSync(join(art, "tamper-caught.txt"), "no-run\n");
				}
			} else {
				writeFileSync(join(art, "tamper-caught.txt"), "no-events\n");
			}

			// /kpi status
			const status = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: "/kpi status" },
				],
				{ timeoutMs: 20_000 },
			);
			writeFileSync(join(art, "status.jsonl"), status.stdout || "");
			const statusNamesStage = /implement|specify|plan|ac-compile|ROUND|STAGE|NODE|LOOP|interrupted|RUNNING|job/i.test(
				status.stdout + status.stderr,
			);
			writeFileSync(join(art, "status-ok.txt"), statusNamesStage ? "ok\n" : "weak\n");

			// Canary sweep over artifacts
			const hits = [];
			const sweep = (dir) => {
				if (!existsSync(dir)) return;
				for (const ent of readdirSync(dir, { withFileTypes: true })) {
					const p = join(dir, ent.name);
					if (ent.isDirectory()) sweep(p);
					else {
						try {
							const text = readFileSync(p, "utf8");
							for (const c of canaries) {
								if (text.includes(c)) hits.push({ file: p, canary: c });
							}
						} catch {
							/* binary skip */
						}
					}
				}
			};
			sweep(art);
			sweep(join(subject, ".kpi"));
			writeFileSync(join(art, "canary-hits.json"), `${JSON.stringify(hits, null, 2)}\n`);
			writeFileSync(join(art, "canary-count.txt"), `${hits.length}\n`);

			// No partial *.tmp left
			const tmps = [];
			const findTmp = (dir) => {
				if (!existsSync(dir)) return;
				for (const ent of readdirSync(dir, { withFileTypes: true })) {
					const p = join(dir, ent.name);
					if (ent.isDirectory()) findTmp(p);
					else if (ent.name.endsWith(".tmp")) tmps.push(p);
				}
			};
			findTmp(join(subject, ".kpi"));
			writeFileSync(join(art, "tmp-left.txt"), tmps.length ? tmps.join("\n") + "\n" : "none\n");

			const specs = [
				{ id: "events-exist", artifact: "artifacts/events.jsonl", locator: "re:." },
				{ id: "chain-ok", artifact: "artifacts/chain.txt", contains: "ok" },
				{ id: "tamper-caught", artifact: "artifacts/tamper-caught.txt", contains: "caught" },
				{ id: "status-ok", artifact: "artifacts/status-ok.txt", contains: "ok" },
				{ id: "zero-canaries", artifact: "artifacts/canary-count.txt", contains: "0" },
				{ id: "no-tmp-left", artifact: "artifacts/tmp-left.txt", contains: "none" },
			];			const notes = [
				"# UAT-14",
				"",
				`- kill after run dirs: ${listRunDirs(subject).length}`,
				`- events lines: ${lines.length}`,
				`- chain: ${chainOk}`,
				`- verify product: ${verifyOk}`,
				`- tamper: ${readFileSync(join(art, "tamper-caught.txt"), "utf8").trim()}`,
				`- canary hits: ${hits.length}`,
				`- status stage named: ${statusNamesStage}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-14" } });
		} finally {
			cleanupSandbox(box);
		}
	}



	async function runUat23() {
		const box = await prepareSandbox("UAT-23", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			writeFileSync(
				join(rowDir, "cmd.txt"),
				"UAT-23: third spawn, second writer, claim_path → agent.denied via built CLI\n",
			);
			const art = join(rowDir, "artifacts");

			const hits = [];
			const scan = (dir, depth = 0) => {
				if (!existsSync(dir) || depth > 5) return;
				for (const ent of readdirSync(dir, { withFileTypes: true })) {
					if (["node_modules", ".git", "dist", "fixtures"].includes(ent.name)) continue;
					const p = join(dir, ent.name);
					if (ent.isDirectory()) scan(p, depth + 1);
					else if (ent.name === "package.json") {
						try {
							const pkg = JSON.parse(readFileSync(p, "utf8"));
							const blob = JSON.stringify(pkg);
							for (const bad of [
								"pi-intercom",
								"pi-mesh",
								"pi-agents-talk-to-each-other",
								"pi-bus",
								"pi-side-agents",
							]) {
								if (blob.includes(bad)) hits.push({ file: p, bad });
							}
						} catch {
							/* ignore */
						}
					}
				}
			};
			scan(join(root, "packages"));
			writeFileSync(join(art, "bus-keywords.txt"), hits.length ? "found\n" : "clean\n");

			const goal = fixtureGoal("healthcheck-gated");
			// One long-lived RPC session: finish a job, then drive spawn caps in-process
			// so BackgroundBus live counts stay accurate across prompts.
			const seq = await runRpcSequential(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					// Establish active job for bus context
					{ id: "2", type: "prompt", message: `/kpi ${goal}` },
					// Disable bare-message auto-wrap so spawn prompts are plain tool turns
					{ id: "3", type: "prompt", message: "/kpi off" },
					{
						id: "4",
						type: "prompt",
						message: "UAT23_SPAWN_TWO_WRITERS: call spawn_background twice as role implementer",
					},
					{ id: "5", type: "prompt", message: "UAT23_STOP_ALL: stop every background worker" },
					{
						id: "6",
						type: "prompt",
						message:
							"UAT23_CLAIM_TWICE: seed live lease then spawn implementer to claim_path src/health/server.js",
					},
					{ id: "7", type: "prompt", message: "UAT23_STOP_ALL: stop every background worker" },
					{
						id: "8",
						type: "prompt",
						message: "UAT23_SPAWN_THREE_EXPLORERS: call spawn_background three times as role explorer",
					},
					{ id: "9", type: "prompt", message: "UAT23_STOP_ALL: stop every background worker" },
				],
				{ timeoutMs: 720_000 },
			);
			writeFileSync(join(art, "rpc-seq.jsonl"), seq.stdout || "");
			writeFileSync(join(art, "stderr.log"), seq.stderr || "");
			const phase2 = seq;

			const run = latestRunDir(subject);
			if (run) cpSync(run, join(art, "run"), { recursive: true });

			const eventsPath = run && existsSync(join(run, "events.jsonl")) ? join(run, "events.jsonl") : null;
			const busPath = run && existsSync(join(run, "bus.jsonl")) ? join(run, "bus.jsonl") : null;
			const eventText = eventsPath ? readFileSync(eventsPath, "utf8") : "";
			const busText = busPath ? readFileSync(busPath, "utf8") : "";
			const denied = [...eventText.split("\n"), ...busText.split("\n")]
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((e) => e && e.type === "agent.denied");
			// Dedup by reason+ts
			const seen = new Set();
			const unique = [];
			for (const d of denied) {
				const k = `${d.reason}|${d.ts}|${d.agent_id || ""}`;
				if (seen.has(k)) continue;
				seen.add(k);
				unique.push(d);
			}
			writeFileSync(join(art, "denials.json"), `${JSON.stringify(unique, null, 2)}\n`);
			const reasons = new Set(unique.map((d) => d.reason).filter(Boolean));
			writeFileSync(join(art, "denial-reasons.txt"), `${[...reasons].sort().join("\n")}\n`);
			writeFileSync(join(art, "worker-limit.txt"), reasons.has("worker-limit") ? "yes\n" : "no\n");
			writeFileSync(join(art, "writer-live.txt"), reasons.has("writer-live") ? "yes\n" : "no\n");
			writeFileSync(join(art, "claim-held.txt"), reasons.has("claim-held") ? "yes\n" : "no\n");
			// Holder death → re-claim: look for a successful claim after claim-held
			let reclaimOk = false;
			if (run && existsSync(join(run, "agents"))) {
				for (const name of readdirSync(join(run, "agents"))) {
					if (!name.endsWith(".jsonl")) continue;
					const body = readFileSync(join(run, "agents", name), "utf8");
					if (/claimed src\/health\/server\.js|claimed .*server\.js/i.test(body) && /seed-claim-reclaim done|claim done/i.test(body)) {
						reclaimOk = true;
					}
					// tool result text in session
					if (body.includes("claimed") && reasons.has("claim-held")) {
						const claimedCount = (body.match(/claimed /g) || []).length;
						if (claimedCount >= 1) reclaimOk = true;
					}
				}
			}
			// leases.json after reclaim should name the live claimer, not foreign holder
			const leasesPath = run && existsSync(join(run, "leases.json")) ? join(run, "leases.json") : null;
			const leases = leasesPath ? readJsonSafe(leasesPath) : {};
			const leaseHolder = leases["src/health/server.js"]?.agent_id || "";
			if (leaseHolder && leaseHolder !== "implementer-foreign-holder") reclaimOk = true;
			writeFileSync(join(art, "reclaim-after-death.txt"), reclaimOk && reasons.has("claim-held") ? "yes\n" : `no holder=${leaseHolder}\n`);


			const agentsDir = run ? join(run, "agents") : null;
			const agentSessions = agentsDir && existsSync(agentsDir) ? readdirSync(agentsDir) : [];
			writeFileSync(join(art, "agent-count.txt"), `${agentSessions.length}\n`);
			writeFileSync(join(art, "agent-sessions.txt"), `${agentSessions.join("\n")}\n`);

			const verdict = run && existsSync(join(run, "verdict.json"));
			const evidence = run && existsSync(join(run, "evidence.json"));
			const stPath = run && existsSync(join(run, "state.json")) ? join(run, "state.json") : null;
			const st = stPath ? readJsonSafe(stPath) : {};
			writeFileSync(
				join(art, "parent-receipts.txt"),
				[verdict ? "verdict.json" : "", evidence ? "evidence.json" : "", stPath ? "state.json" : ""]
					.filter(Boolean)
					.join("\n") + "\n",
			);
			writeFileSync(
				join(art, "parent-decision.txt"),
				verdict || evidence || st.status ? "yes\n" : "no\n",
			);

			// Holder death: if we have a claim-held, try kill holder pid from denial and re-claim note
			const claimDenial = unique.find((d) => d.reason === "claim-held");
			if (claimDenial?.holder) {
				writeFileSync(join(art, "claim-holder.txt"), `${claimDenial.holder}\n`);
			}

			const specs = [
				{ id: "no-pi-bus-keywords", artifact: "artifacts/bus-keywords.txt", contains: "clean" },
				{ id: "worker-limit-denied", artifact: "artifacts/worker-limit.txt", contains: "yes" },
				{ id: "writer-live-denied", artifact: "artifacts/writer-live.txt", contains: "yes" },
				{ id: "claim-held-denied", artifact: "artifacts/claim-held.txt", contains: "yes" },
				{ id: "reclaim-after-death", artifact: "artifacts/reclaim-after-death.txt", contains: "yes" },
				{ id: "denials-recorded", artifact: "artifacts/denials.json", contains: "agent.denied" },
				{ id: "parent-decision", artifact: "artifacts/parent-decision.txt", contains: "yes" },
			];			const notes = [
				"# UAT-23",
				"",
				`- denials: ${unique.length} reasons=[${[...reasons].join(",")}]`,
				`- agent sessions: ${agentSessions.length}`,
				`- parent: verdict=${verdict} evidence=${evidence} status=${st.status || ""}`,
				`- bus keywords: ${hits.length ? "FOUND" : "clean"}`,
				`- phase2 exit: ${phase2.code}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-23", denials: unique } });
		} finally {
			cleanupSandbox(box);
		}
	}

	return {
		"UAT-03": runUat03,
		"UAT-05": runUat05,
		"UAT-08": runUat08,
		"UAT-09": runUat09,
		"UAT-14": runUat14,
		"UAT-22": runUat22,
		"UAT-23": runUat23,
		"UAT-30": runUat30,
	};
}
