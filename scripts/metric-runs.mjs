/**
 * M-01..M-06 against the built binary.
 *
 * RP-19 step 5 asks for the deterministic fixtures exercised through
 * `dist/bundle/cli.js` under a clean HOME and a scratch Git repository. Every
 * verdict here is read back out of something the product itself wrote -
 * `state.json`, `events.jsonl`, git history, the run store, or the session's own
 * `get_last_assistant_text` - never from a unit test and never by importing
 * product source. The only injected component is the loopback stub provider that
 * already ships for UAT (`uat/stub-model.mjs`), plus its egress guard, which
 * refuses any connection that is not loopback so a metric cannot silently
 * depend on the network.
 *
 * The sandbox helpers below duplicate a little of `uat/run-row.mjs`. That file is
 * owned by the UAT workstream and exports nothing, so the choice was to copy
 * ~120 lines of plumbing or to reach into a module we do not own. Copying keeps
 * this proof independent of a layout we cannot change.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliPath = join(repoRoot, "packages/coding-agent/dist/bundle/cli.js");
const uatDir = join(repoRoot, "uat");
const stubPath = join(uatDir, "stub-model.mjs");
const guardPath = join(uatDir, "egress-guard.cjs");
const loopScreenplay = join(uatDir, "fixtures/uat-04-screenplay.json");
const metricFixtures = join(scriptDir, "metric-fixtures");

/** Conventional Commits subject, which AC-08.5 and M-02 both require. */
const CONVENTIONAL_SUBJECT = /^(?:feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(?:\([^)]+\))?!?: .+/;

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolvePort(port)));
		});
		server.on("error", reject);
	});
}

function git(cwd, ...args) {
	const result = spawnSyncCapture("git", args, cwd);
	return result.stdout.trim();
}

function spawnSyncCapture(command, args, cwd) {
	// Only git inspection uses this; the CLI itself is always driven async.
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function initGit(dir) {
	for (const args of [
		["init", "--quiet", "-b", "main"],
		["config", "user.email", "proof@k-pi.invalid"],
		["config", "user.name", "K-pi proof"],
		["add", "--all"],
		["commit", "--quiet", "-m", "chore: fixture baseline"],
	]) {
		git(dir, ...args);
	}
}

function copyFixture(name, destination) {
	const source = join(repoRoot, "fixtures", name);
	if (!existsSync(source)) {
		throw new Error(`missing fixture: ${relative(repoRoot, source)}`);
	}
	cpSync(source, destination, { recursive: true });
	initGit(destination);
}

function fixtureGoal(name) {
	return readFileSync(join(repoRoot, "fixtures", name, "task.txt"), "utf8").trim();
}

function gitSnapshot(dir) {
	return {
		head: git(dir, "rev-parse", "HEAD"),
		count: Number(git(dir, "rev-list", "--count", "HEAD") || "0"),
		subject: git(dir, "log", "-1", "--pretty=%s"),
		body: git(dir, "log", "-1", "--pretty=%B"),
		status: spawnSyncCapture("git", ["status", "--porcelain"], dir).stdout,
		log: spawnSyncCapture("git", ["log", "--oneline", "-5"], dir).stdout,
	};
}

function walkFind(root, name) {
	if (!existsSync(root)) return undefined;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			const found = walkFind(path, name);
			if (found) return found;
		} else if (entry.name === name) {
			return path;
		}
	}
	return undefined;
}

function readJson(path, fallback = null) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function readJsonl(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

/**
 * One local slot, and the persisted default that graph nodes and worker children
 * actually resolve. Parent `--model` pins only the parent, so the settings
 * default is what makes every node reach the stub.
 */
function pinLocalSlot(agentDir, baseUrl) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: "local-openai", defaultModel: "uat-stub" }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "accounts.json"),
		`${JSON.stringify(
			{
				version: 1,
				pools: { "local-openai": { strategy: "round-robin", slots: [{ id: "a", kind: "local", label: "a", baseUrl }] } },
				fallback: ["local-openai"],
				stickiness: "session-until-exhausted",
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(agentDir, "local-openai-models.json"),
		`${JSON.stringify([{ id: "uat-stub", name: "uat-stub", baseUrl }], null, 2)}\n`,
	);
	// The OpenAI client cannot be constructed without some key; the accounts hook
	// nulls the header before the request leaves.
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify({ "local-openai": { type: "api_key", key: "proof-local-no-op" } }, null, 2)}\n`,
	);
}

/**
 * Two credentialed siblings in one rotating pool, both served by the loopback
 * stub.
 *
 * A local pool cannot express this: a local model carries the origin it was
 * discovered on, so selection is origin-pinned rather than rotated. `zai` is
 * OpenAI-compatible and `models.json` rewrites a provider's base URL for every
 * one of its models, which is the documented way to point a credentialed pool
 * somewhere else. The two slots differ only by credential, and the stub records
 * a hash of the bearer it was sent, so "which slot served this request" is
 * answerable from the stub's own log.
 */
function pinRotatingPool(agentDir, baseUrl, modelId) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: "zai", defaultModel: modelId }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({ providers: { zai: { baseUrl } } }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "accounts.json"),
		`${JSON.stringify(
			{
				version: 1,
				pools: {
					zai: {
						strategy: "round-robin",
						slots: [
							{ id: "a", kind: "api_key", label: "a" },
							{ id: "b", kind: "api_key", label: "b" },
						],
					},
				},
				fallback: ["zai"],
				stickiness: "session-until-exhausted",
			},
			null,
			2,
		)}\n`,
	);
	// The model runtime's own preflight ("No API key found for <provider>") runs
	// before the accounts hook ever sees the request, so the provider needs a
	// configured credential to be selectable at all. The per-slot secret below is
	// what actually reaches the wire, and the two differ, which is how the stub can
	// tell the siblings apart.
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify({ zai: { type: "api_key", key: "proof-zai-preflight" } }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "accounts.secrets.json"),
		`${JSON.stringify(
			{
				"zai/a": { type: "api_key", key: "proof-slot-a" },
				"zai/b": { type: "api_key", key: "proof-slot-b" },
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
}

function startStub(port, logFile, screenplayPath) {
	return new Promise((resolveStub, reject) => {
		const args = [stubPath, "--port", String(port), "--log", logFile];
		if (screenplayPath) args.push("--screenplay", screenplayPath);
		const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("stub provider did not boot"));
		}, 10_000);
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				clearTimeout(timer);
				try {
					resolveStub({ child, info: JSON.parse(buffer.slice(0, newline)) });
				} catch (error) {
					reject(error);
				}
			}
		});
		child.stderr.on("data", () => {});
		child.on("error", reject);
	});
}

function baseEnv({ home, agentDir, egressLog }) {
	const env = {
		...process.env,
		HOME: home,
		KPI_CODING_AGENT_DIR: agentDir,
		CI: "1",
		PI_SKIP_VERSION_CHECK: "1",
		NO_COLOR: "1",
		// Any connection that is not loopback is refused and logged, so a metric
		// cannot pass by quietly reaching a real provider.
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${guardPath}`,
		UAT_EGRESS_LOG: egressLog,
	};
	delete env.EXA_API_KEY;
	delete env.PERPLEXITY_API_KEY;
	return env;
}

/**
 * Drives the built CLI in RPC mode.
 *
 * Confirm dialogs are answered from `confirm`, and every request is captured so a
 * metric can assert on what the operator was actually asked - or assert that
 * nothing was asked at all, which is what M-02 needs.
 */
function runRpc(env, cwd, lines, options = {}) {
	const {
		timeoutMs = 240_000,
		confirm = true,
		model = "local-openai/uat-stub",
		stopWhen = "terminal",
		/** Lines held back until the stream shows the session is ready for them. */
		deferred = [],
	} = options;
	return new Promise((resolveRpc) => {
		const child = spawn(process.execPath, [cliPath, "--offline", "--mode", "rpc", "--model", model], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const confirms = [];
		const answered = new Set();
		const finish = () => {
			if (settled) return;
			settled = true;
			try {
				child.stdin.end();
			} catch {
				/* closing a dead pipe is not a failure */
			}
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			setTimeout(() => resolveRpc({ status: child.exitCode, stdout, stderr, confirms }), 250);
		};
		const answerConfirms = () => {
			for (const line of stdout.split("\n")) {
				if (!line.includes("extension_ui_request")) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.type !== "extension_ui_request" || message.method !== "confirm") continue;
				if (!message.id || answered.has(message.id)) continue;
				answered.add(message.id);
				confirms.push({ id: message.id, title: message.title ?? "", message: message.message ?? "", confirmed: confirm });
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, confirmed: confirm })}\n`);
			}
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			answerConfirms();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		for (const line of lines) {
			child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
		}
		const startedAt = Date.now();
		const sentDeferred = new Set();
		const timer = setInterval(() => {
			answerConfirms();
			// A follow-up command has to wait for the turn it asks about: sending
			// `get_last_assistant_text` before the assistant has finished speaking
			// reads an empty session, not a short answer.
			for (const [index, entry] of deferred.entries()) {
				if (sentDeferred.has(index) || !entry.after.test(stdout)) continue;
				sentDeferred.add(index);
				for (const line of entry.lines) {
					child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
				}
			}
			const terminal =
				/K-π job .+ (DONE|UNSAFE|BLOCKED|EXHAUSTED|NEEDS_HUMAN|NO_PROGRESS)\b/.test(stdout) ||
				/K-π loop failed/.test(stdout);
			if (stopWhen === "terminal" && terminal) {
				clearInterval(timer);
				finish();
				return;
			}
			if (stopWhen === "responses") {
				const responses = (stdout.match(/"type":"response"/g) ?? []).length;
				const deferredCount = deferred.reduce((total, entry) => total + entry.lines.length, 0);
				const wanted =
					lines.filter((line) => (typeof line === "object" ? line.type !== "set_model" : true)).length + deferredCount;
				if (responses >= wanted && (deferred.length === 0 || sentDeferred.size === deferred.length)) {
					clearInterval(timer);
					finish();
					return;
				}
			}
			if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				finish();
			}
		}, 150);
		child.on("exit", () => {
			clearInterval(timer);
			finish();
		});
	});
}

/**
 * One long-lived session, one prompt at a time.
 *
 * Writing every prompt up front does not produce one turn per prompt: the
 * session queues the rest as steering on the turn already running, so a hundred
 * prompts can produce a single model request. A selection metric needs a hundred
 * selections, so each prompt waits for the previous turn to settle.
 */
function runRpcSequential(env, cwd, steps, options = {}) {
	const { timeoutMs = 300_000, model = "local-openai/uat-stub", settleTimeoutMs = 15_000 } = options;
	return new Promise((resolveRpc, rejectRpc) => {
		const child = spawn(process.execPath, [cliPath, "--offline", "--mode", "rpc", "--model", model], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		const startedAt = Date.now();
		const settledCount = () => (stdout.match(/"type":"agent_settled"/g) ?? []).length;
		const respondedTo = (id) => stdout.includes(`"id":"${id}"`) && new RegExp(`"id":"${id}"[^\n]*"type":"response"`).test(stdout);

		const finish = () => {
			try {
				child.stdin.end();
			} catch {
				/* closing a dead pipe is not a failure */
			}
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			setTimeout(() => resolveRpc({ status: child.exitCode, stdout, stderr, confirms: [] }), 250);
		};

		const step = async (index) => {
			if (index >= steps.length) {
				finish();
				return;
			}
			const line = steps[index];
			const id = typeof line === "object" ? line.id : undefined;
			const settledBefore = settledCount();
			child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
			const isPrompt = typeof line === "object" && line.type === "prompt";
			const deadline = Date.now() + settleTimeoutMs;
			for (;;) {
				await new Promise((tick) => setTimeout(tick, 25));
				if (Date.now() - startedAt > timeoutMs) {
					finish();
					return;
				}
				const responded = id === undefined || respondedTo(id);
				const settled = !isPrompt || settledCount() > settledBefore;
				if (responded && settled) break;
				if (Date.now() > deadline) break;
			}
			await step(index + 1);
		};
		child.on("error", rejectRpc);
		void step(0);
	});
}

async function sandbox(id, { fixture, screenplay = loopScreenplay, pin = "local", modelId } = {}) {
	if (!existsSync(cliPath)) {
		throw new Error(`built CLI missing: ${relative(repoRoot, cliPath)} — run npm run build:offline`);
	}
	const home = mkdtempSync(join(tmpdir(), `kpi-proof-${id}-home-`));
	const agentDir = mkdtempSync(join(tmpdir(), `kpi-proof-${id}-agent-`));
	const subject = mkdtempSync(join(tmpdir(), `kpi-proof-${id}-subject-`));
	if (fixture) {
		copyFixture(fixture, subject);
	} else {
		writeFileSync(join(subject, "README.md"), `# ${id} scratch\n`);
		initGit(subject);
	}
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	if (pin === "rotating") {
		pinRotatingPool(agentDir, baseUrl, modelId);
	} else {
		pinLocalSlot(agentDir, baseUrl);
	}
	const modelLog = join(tmpdir(), `kpi-proof-${id}-model.jsonl`);
	writeFileSync(modelLog, "");
	const egressLog = join(tmpdir(), `kpi-proof-${id}-egress.log`);
	writeFileSync(egressLog, "");
	const { child: stub } = await startStub(port, modelLog, screenplay);
	return { home, agentDir, subject, port, baseUrl, modelLog, egressLog, stub, env: baseEnv({ home, agentDir, egressLog }) };
}

function teardown(box) {
	try {
		box.stub.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	for (const path of [box.home, box.agentDir, box.subject]) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function evidenceWriter(proofRoot, id) {
	const dir = join(proofRoot, id);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "artifacts"), { recursive: true });
	return {
		dir,
		write(name, body) {
			const path = join(dir, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
			return relative(repoRoot, path);
		},
		/** Copies the run store verbatim, plus the named artifacts beside it. */
		captureRun(subject) {
			const runs = join(subject, ".kpi/runs");
			if (existsSync(runs)) cpSync(runs, join(dir, "artifacts/runs"), { recursive: true });
			const found = {};
			for (const name of ["task.json", "state.json", "events.jsonl", "evidence.json", "verdict.json", "candidate.json"]) {
				const path = walkFind(join(dir, "artifacts/runs"), name);
				if (path) {
					copyFileSync(path, join(dir, "artifacts", name));
					found[name] = readFileSync(path, "utf8");
				}
			}
			return found;
		},
	};
}

/** One assertion, named, with the artifact it was decided from. */
function check(id, artifact, ok, observed) {
	return { id, artifact, ok: Boolean(ok), observed: String(observed).slice(0, 400) };
}

function verdict(id, owner, checks, evidenceDir, extra = {}) {
	const failed = checks.filter((entry) => !entry.ok);
	return {
		pass: failed.length === 0,
		owner,
		evidence: relative(repoRoot, evidenceDir),
		checks,
		detail:
			failed.length === 0
				? extra.okDetail ?? `${checks.length} product-artifact checks passed`
				: `failed: ${failed.map((entry) => entry.id).join(", ")}`,
		...extra,
	};
}

function egressClean(box) {
	const text = existsSync(box.egressLog) ? readFileSync(box.egressLog, "utf8").trim() : "";
	return { clean: text.length === 0, text };
}

// ---------------------------------------------------------------------------
// M-01  gated healthcheck fixture reaches human confirmation with green receipts
// ---------------------------------------------------------------------------

async function collectM01(proofRoot) {
	const out = evidenceWriter(proofRoot, "M-01");
	const box = await sandbox("m01", { fixture: "healthcheck-gated" });
	try {
		const goal = fixtureGoal("healthcheck-gated");
		out.write("cmd.txt", `rpc prompt: /kpi ${goal}\n`);
		const before = gitSnapshot(box.subject);
		const rpc = await runRpc(box.env, box.subject, [{ id: "1", type: "prompt", message: `/kpi ${goal}` }], {
			confirm: true,
		});
		out.write("rpc.jsonl", rpc.stdout);
		out.write("stderr.log", rpc.stderr);
		out.write("exit", `${rpc.status ?? "null"}\n`);
		out.write("confirms.json", rpc.confirms);
		const found = out.captureRun(box.subject);
		const after = gitSnapshot(box.subject);
		out.write("git.txt", `BEFORE ${before.head}\nAFTER ${after.head}\nLOG\n${after.log}\nSTATUS\n${after.status}\n`);
		const egress = egressClean(box);
		out.write("egress.log", egress.text);
		out.write("model-requests.jsonl", existsSync(box.modelLog) ? readFileSync(box.modelLog, "utf8") : "");

		const task = readJson(join(out.dir, "artifacts/task.json"), {});
		const state = readJson(join(out.dir, "artifacts/state.json"), {});
		const evidence = readJson(join(out.dir, "artifacts/evidence.json"), {});
		const verdictDoc = readJson(join(out.dir, "artifacts/verdict.json"), {});
		const events = readJsonl(join(out.dir, "artifacts/events.jsonl"));
		const acResults = Array.isArray(evidence.ac_results) ? evidence.ac_results : [];

		const checks = [
			check("run-store-created", "artifacts/task.json", typeof task.goal === "string" && task.goal.length > 0, task.goal ?? "absent"),
			check("gated-mode", "artifacts/task.json", task.mode === "gated", task.mode ?? "absent"),
			check(
				"contract-fields",
				"artifacts/task.json",
				Array.isArray(task.acceptance) && task.acceptance.length > 0 && Array.isArray(task.quality_gates),
				`acceptance=${task.acceptance?.length ?? 0} gates=${task.quality_gates?.length ?? 0}`,
			),
			check("event-log", "artifacts/events.jsonl", events.length > 0, `${events.length} records`),
			check(
				"human-confirmation",
				"confirms.json",
				rpc.confirms.length > 0,
				rpc.confirms.map((entry) => entry.title).join(" | ") || "none",
			),
			check(
				"green-receipts",
				"artifacts/evidence.json",
				acResults.length > 0 && acResults.every((entry) => entry.passed === true),
				`${acResults.filter((entry) => entry.passed === true).length}/${acResults.length} AC green`,
			),
			check("review-approved", "artifacts/verdict.json", verdictDoc.approved === true, `approved=${verdictDoc.approved}`),
			check("terminal-done", "artifacts/state.json", state.status === "DONE", `status=${state.status ?? "absent"}`),
			check("no-push", "git.txt", !/git push/.test(rpc.stdout), "no push in the session transcript"),
			check("loopback-only", "egress.log", egress.clean, egress.clean ? "no outbound attempt" : egress.text.slice(0, 200)),
		];
		out.write("result.json", { id: "M-01", checks, found: Object.keys(found) });
		return verdict("M-01", "RP-05", checks, out.dir, {
			fixture: "fixtures/healthcheck-gated",
			okDetail: "gated healthcheck reached human confirmation with green receipts and DONE",
		});
	} finally {
		teardown(box);
	}
}

// ---------------------------------------------------------------------------
// M-02  autopilot fixture: DONE, no human node, exactly one job-marked commit
// ---------------------------------------------------------------------------

async function collectM02(proofRoot) {
	const out = evidenceWriter(proofRoot, "M-02");
	const box = await sandbox("m02", { fixture: "healthcheck-auto" });
	try {
		const goal = fixtureGoal("healthcheck-auto");
		out.write("cmd.txt", `rpc prompt: /kpi --mode autopilot <5 executable AC from fixtures/healthcheck-auto/task.txt>\n`);
		const before = gitSnapshot(box.subject);
		const rpc = await runRpc(box.env, box.subject, [
			{ id: "1", type: "prompt", message: `/kpi --mode autopilot ${goal}` },
		]);
		out.write("rpc.jsonl", rpc.stdout);
		out.write("stderr.log", rpc.stderr);
		out.write("exit", `${rpc.status ?? "null"}\n`);
		out.write("confirms.json", rpc.confirms);
		out.captureRun(box.subject);
		const after = gitSnapshot(box.subject);
		out.write("git.txt", `BEFORE ${before.head} (${before.count})\nAFTER ${after.head} (${after.count})\nSUBJECT ${after.subject}\nBODY\n${after.body}\nLOG\n${after.log}\n`);
		const egress = egressClean(box);
		out.write("egress.log", egress.text);

		const task = readJson(join(out.dir, "artifacts/task.json"), {});
		const state = readJson(join(out.dir, "artifacts/state.json"), {});
		const events = readJsonl(join(out.dir, "artifacts/events.jsonl"));
		const verdictEvents = events.filter((event) => event.type === "review.verdict");
		const terminalEvents = events.filter((event) => event.type === "loop.terminal");
		const newCommits = after.count - before.count;
		// The job id is the marker the loop stamps on its own commit.
		const jobMarked = typeof task.job_id === "string" && task.job_id.length > 0 && after.body.includes(task.job_id);

		const checks = [
			check("autopilot-mode", "artifacts/task.json", task.mode === "autopilot", task.mode ?? "absent"),
			check(
				"executable-ac",
				"artifacts/task.json",
				task.ac?.quality === "executable",
				`quality=${task.ac?.quality ?? "absent"}`,
			),
			check("terminal-done", "artifacts/state.json", state.status === "DONE", `status=${state.status ?? "absent"}`),
			// A finished run is legible from the event log alone: DONE goes through
			// the same one terminal writer as every other outcome, exactly once.
			check(
				"exactly-one-terminal-done",
				"artifacts/events.jsonl",
				terminalEvents.length === 1 && terminalEvents[0]?.status === "DONE",
				`${terminalEvents.length} loop.terminal record(s): ${terminalEvents.map((record) => record.status).join(", ") || "none"}`,
			),
			check(
				"review-receipt-on-record",
				"artifacts/events.jsonl",
				verdictEvents.length >= 1 && verdictEvents.at(-1)?.approved === true,
				`${verdictEvents.length} review.verdict record(s), last approved=${verdictEvents.at(-1)?.approved}`,
			),
			check("exactly-one-commit", "git.txt", newCommits === 1, `${newCommits} new commit(s)`),
			check("conventional-subject", "git.txt", CONVENTIONAL_SUBJECT.test(after.subject), after.subject || "absent"),
			check("job-marked-commit", "git.txt", jobMarked, jobMarked ? `body names ${task.job_id}` : "job id absent from commit body"),
			check(
				"no-human-node",
				"confirms.json",
				rpc.confirms.length === 0,
				`${rpc.confirms.length} confirm request(s)`,
			),
			check("loopback-only", "egress.log", egress.clean, egress.clean ? "no outbound attempt" : egress.text.slice(0, 200)),
		];
		out.write("result.json", { id: "M-02", checks });
		return verdict("M-02", "RP-05", checks, out.dir, {
			fixture: "fixtures/healthcheck-auto",
			okDetail: "autopilot reached DONE with one job-marked Conventional Commit and no human node",
			scope: "decided from the artifacts the product wrote: task.json, state.json, events.jsonl, and git history",
		});
	} finally {
		teardown(box);
	}
}

// ---------------------------------------------------------------------------
// M-03  narrative AC refuse autopilot; coding-loop.auto.json never loads
// ---------------------------------------------------------------------------

async function collectM03(proofRoot) {
	const out = evidenceWriter(proofRoot, "M-03");
	const box = await sandbox("m03", { fixture: "narrative-ac" });
	try {
		const goal = fixtureGoal("narrative-ac");
		out.write("cmd.txt", `rpc prompt: /kpi --mode autopilot ${goal}\n`);
		const before = gitSnapshot(box.subject);
		const rpc = await runRpc(
			box.env,
			box.subject,
			[{ id: "1", type: "prompt", message: `/kpi --mode autopilot ${goal}` }],
			{ timeoutMs: 120_000, stopWhen: "responses" },
		);
		out.write("rpc.jsonl", rpc.stdout);
		out.write("stderr.log", rpc.stderr);
		out.write("exit", `${rpc.status ?? "null"}\n`);
		out.captureRun(box.subject);
		const after = gitSnapshot(box.subject);
		out.write("git.txt", `BEFORE ${before.head} (${before.count})\nAFTER ${after.head} (${after.count})\n`);
		const egress = egressClean(box);
		out.write("egress.log", egress.text);

		const events = readJsonl(join(out.dir, "artifacts/events.jsonl"));
		const refused = events.filter((event) => event.type === "ac.refused");
		const state = readJson(join(out.dir, "artifacts/state.json"), {});
		// The graph writes a checkpoint on its first superstep, so the absence of
		// one is how "coding-loop.auto.json never loaded" is observable.
		const runsRoot = join(out.dir, "artifacts/runs");
		const checkpoint = walkFind(runsRoot, "checkpoint-000000.json") ?? walkFind(runsRoot, "graph");
		out.write("graph-dir.txt", checkpoint ? `present: ${relative(runsRoot, checkpoint)}\n` : "absent\n");

		const checks = [
			check(
				"ac-refused-recorded",
				"artifacts/events.jsonl",
				refused.length === 1 && typeof refused[0].reason === "string" && refused[0].reason.length > 0,
				refused.length === 1 ? refused[0].reason : `${refused.length} ac.refused records`,
			),
			check(
				"narrative-quality",
				"artifacts/events.jsonl",
				refused[0]?.quality === "narrative" || refused[0]?.quality === "partial",
				`quality=${refused[0]?.quality ?? "absent"}`,
			),
			check("no-graph-checkpoint", "graph-dir.txt", checkpoint === undefined, checkpoint ? "graph state exists" : "no graph directory"),
			check(
				"not-done",
				"artifacts/state.json",
				state.status !== "DONE",
				`status=${state.status ?? "absent"}`,
			),
			check("no-commit", "git.txt", after.count === before.count, `${after.count - before.count} new commit(s)`),
			check("loopback-only", "egress.log", egress.clean, egress.clean ? "no outbound attempt" : egress.text.slice(0, 200)),
		];
		out.write("result.json", { id: "M-03", checks });
		return verdict("M-03", "RP-05", checks, out.dir, {
			fixture: "fixtures/narrative-ac",
			okDetail: "narrative AC refused autopilot, ac.refused written, no graph state created",
		});
	} finally {
		teardown(box);
	}
}

// ---------------------------------------------------------------------------
// M-04  bounds violation reaches UNSAFE and creates no commit
// ---------------------------------------------------------------------------

async function collectM04(proofRoot) {
	const out = evidenceWriter(proofRoot, "M-04");
	const box = await sandbox("m04", { fixture: "bounds-violation" });
	try {
		const goal = fixtureGoal("bounds-violation");
		out.write("cmd.txt", `rpc prompt: /kpi --mode autopilot ${goal}\n`);
		const before = gitSnapshot(box.subject);
		const rpc = await runRpc(box.env, box.subject, [
			{ id: "1", type: "prompt", message: `/kpi --mode autopilot ${goal}` },
		]);
		out.write("rpc.jsonl", rpc.stdout);
		out.write("stderr.log", rpc.stderr);
		out.write("exit", `${rpc.status ?? "null"}\n`);
		out.captureRun(box.subject);
		const after = gitSnapshot(box.subject);
		out.write("git.txt", `BEFORE ${before.head} (${before.count})\nAFTER ${after.head} (${after.count})\nSTATUS\n${after.status}\n`);
		const egress = egressClean(box);
		out.write("egress.log", egress.text);

		const state = readJson(join(out.dir, "artifacts/state.json"), {});
		const events = readJsonl(join(out.dir, "artifacts/events.jsonl"));
		const terminal = events.filter((event) => event.type === "loop.terminal");
		// The write-attempt record RP-11 needs for ordering: a refused write is on
		// the log before the run stops.
		const denied = events.filter((event) => event.type === "tool.request" && event.decision === "deny");

		const checks = [
			check("terminal-unsafe", "artifacts/state.json", state.status === "UNSAFE", `status=${state.status ?? "absent"}`),
			check(
				"one-loop-terminal-unsafe",
				"artifacts/events.jsonl",
				terminal.length === 1 && terminal[0].status === "UNSAFE",
				`${terminal.length} loop.terminal (${terminal.map((event) => event.status).join(",")})`,
			),
			check(
				"reason-recorded",
				"artifacts/state.json",
				typeof state.reason === "string" && state.reason.length > 0,
				state.reason ?? "absent",
			),
			check("zero-commits", "git.txt", after.count === before.count, `${after.count - before.count} new commit(s)`),
			check(
				"refused-write-on-record",
				"artifacts/events.jsonl",
				denied.length > 0,
				`${denied.length} denied tool.request(s): ${denied.map((event) => event.path ?? event.tool).join(",")}`,
			),
			check("loopback-only", "egress.log", egress.clean, egress.clean ? "no outbound attempt" : egress.text.slice(0, 200)),
		];
		out.write("result.json", { id: "M-04", checks });
		return verdict("M-04", "RP-05", checks, out.dir, {
			fixture: "fixtures/bounds-violation",
			okDetail: "a write outside the declared bounds stopped the run UNSAFE with no commit",
		});
	} finally {
		teardown(box);
	}
}

// ---------------------------------------------------------------------------
// M-05  an exhausted sibling is never selected while a healthy sibling exists
// ---------------------------------------------------------------------------

const M05_REQUESTS = 100;

/** The accounts widget's own words for a slot's remaining quota. */
function accountsWidgetStates(stdout) {
	const states = [];
	for (const line of stdout.split("\n")) {
		if (!line.includes('"statusKey":"accounts"')) continue;
		try {
			const message = JSON.parse(line);
			const text = message.statusText ?? "";
			if (states.at(-1) !== text) states.push(text);
		} catch {
			/* not this line */
		}
	}
	return states;
}

async function collectM05(proofRoot) {
	const out = evidenceWriter(proofRoot, "M-05");
	const modelId = "glm-5.3";

	// Phase 1 isolates the question. A 200 carrying quota headers must reach the
	// accounts layer, or nothing downstream could ever be tested. The widget is
	// the product's own report of what it recorded.
	const probe = await sandbox("m05-probe", {
		screenplay: join(metricFixtures, "m05-headers-screenplay.json"),
		pin: "rotating",
		modelId,
	});
	let headerStates = [];
	try {
		const rpc = await runRpcSequential(
			probe.env,
			probe.subject,
			[
				{ id: "off", type: "prompt", message: "/kpi off" },
				{ id: "p", type: "prompt", message: "quota header probe" },
			],
			{ model: `zai/${modelId}`, timeoutMs: 60_000, settleTimeoutMs: 8_000 },
		);
		headerStates = accountsWidgetStates(rpc.stdout);
		out.write("phase1-success-headers.jsonl", rpc.stdout.slice(0, 200_000));
		out.write("phase1-widget-states.json", headerStates);
	} finally {
		teardown(probe);
	}
	const recordedOnSuccess = headerStates.some((state) => /\ba \d+%/.test(state));

	// Phase 2 is the metric proper: one credential is answered 429, then a hundred
	// selections follow.
	const box = await sandbox("m05", {
		screenplay: join(metricFixtures, "m05-screenplay.json"),
		pin: "rotating",
		modelId,
	});
	try {
		out.write(
			"cmd.txt",
			[
				"phase 1: rpc prompt against a 200 carrying x-ratelimit headers (does the accounts layer record a live response?)",
				`phase 2: ${M05_REQUESTS} sequential prompts on one session, pool zai with sibling slots a and b, first request answered 429`,
				"",
			].join("\n"),
		);
		const lines = [
			// Transport auto-retry would hold the 429'd request and swallow the
			// remaining prompts behind its backoff. Selection is what this measures,
			// so each prompt gets its own selection instead.
			{ id: "retry", type: "set_auto_retry", enabled: false },
			{ id: "off", type: "prompt", message: "/kpi off" },
		];
		for (let index = 0; index < M05_REQUESTS; index += 1) {
			lines.push({ id: `p${index}`, type: "prompt", message: `selection probe ${index}` });
		}
		const rpc = await runRpcSequential(box.env, box.subject, lines, {
			model: `zai/${modelId}`,
			timeoutMs: 420_000,
			settleTimeoutMs: 8_000,
		});
		out.write("rpc.jsonl", rpc.stdout.slice(0, 400_000));
		out.write("stderr.log", rpc.stderr);
		out.write("exit", `${rpc.status ?? "null"}\n`);
		const requests = readJsonl(box.modelLog);
		out.write("model-requests.jsonl", existsSync(box.modelLog) ? readFileSync(box.modelLog, "utf8") : "");
		const widgetStates = accountsWidgetStates(rpc.stdout);
		out.write("widget-states.json", widgetStates);
		const egress = egressClean(box);
		out.write("egress.log", egress.text);

		// Which slot served each request, by the hash of the bearer the accounts
		// hook attached. The stub never logs a token, only its hash.
		const byToken = new Map();
		for (const record of requests) {
			const token = record.auth_token_sha256 ?? "none";
			byToken.set(token, (byToken.get(token) ?? 0) + 1);
		}
		const cooled = requests.find((record) => record.response_status === 429);
		const cooledToken = cooled?.auth_token_sha256 ?? null;
		const afterCooling = cooledToken
			? requests.slice(requests.indexOf(cooled) + 1).filter((record) => record.auth_token_sha256 === cooledToken)
			: [];
		const distinct = [...byToken.keys()].filter((token) => token !== "none");
		const routes = [...new Set(widgetStates.flatMap((state) => state.match(/via (\S+)/g) ?? []))];
		// `cd 60m` is the accounts widget's own notation for a slot in cooldown,
		// and 60m is the `retry-after` the stub served - so this is the product
		// echoing the provider's window back, not a default.
		const cooldownState = widgetStates.find((state) => /\bcd\s+\d+\s*m\b/u.test(state));
		out.write("selection-tally.json", {
			total_requests: requests.length,
			distinct_credentials: distinct.length,
			per_credential: Object.fromEntries(byToken),
			cooled_credential: cooledToken,
			requests_to_cooled_after_429: afterCooling.length,
			routes_observed: routes,
			recorded_quota_on_success: recordedOnSuccess,
			widget_cooldown: cooldownState?.replaceAll("\n", " | "),
		});

		const checks = [
			check(
				"requests-reached-the-pool",
				"model-requests.jsonl",
				requests.length >= M05_REQUESTS,
				`${requests.length} requests for ${M05_REQUESTS} prompts`,
			),
			check("one-429-served", "model-requests.jsonl", cooled !== undefined, cooled ? "429 served once" : "no 429 observed"),
			check(
				"live-response-recorded-on-success",
				"phase1-widget-states.json",
				recordedOnSuccess,
				recordedOnSuccess
					? "a 200 with x-ratelimit headers moved the slot's remaining percentage"
					: "even a successful response was not recorded",
			),
			// The premise of the metric: something has to become exhausted first.
			// The widget is the product's own report, and `cd <n>m` is how it names
			// a cooling slot - so this reads the cooldown the product published,
			// not an inference from where traffic went.
			check(
				"429-classified-and-slot-cooled",
				"widget-states.json",
				cooldownState !== undefined,
				cooldownState === undefined
					? `no widget state reported a cooling slot; states: ${widgetStates.length}`
					: `the widget published the cooldown: ${cooldownState.replaceAll("\n", " | ")}`,
			),
			check(
				"route-moved-to-a-healthy-sibling",
				"widget-states.json",
				routes.length > 1 && routes.at(-1) !== routes[0],
				`routes observed: ${routes.join(" -> ") || "none"}`,
			),
			check(
				"cooled-sibling-never-reselected",
				"selection-tally.json",
				cooled !== undefined && afterCooling.length === 0,
				`${afterCooling.length} of ${requests.length - 1} later requests still carried the 429'd credential`,
			),
			check("loopback-only", "egress.log", egress.clean, egress.clean ? "no outbound attempt" : egress.text.slice(0, 200)),
		];
		out.write("result.json", { id: "M-05", checks });
		return verdict("M-05", "RP-06", checks, out.dir, {
			fixture: "loopback rotating pool (zai) with two credentialed siblings",
			okDetail: `the cooled sibling served 0 of the remaining requests across ${M05_REQUESTS} selections`,
			scope:
				"the failure arrives through the real transport: the stub answers 429 with retry-after, and the cooldown, the route move and the credential on every later request are read back from the product's own widget and the stub's request log",
		});
	} finally {
		teardown(box);
	}
}

// ---------------------------------------------------------------------------
// M-06  the session's own visible assistant reply is under 800 characters
// ---------------------------------------------------------------------------

async function collectM06(proofRoot) {
	const out = evidenceWriter(proofRoot, "M-06");
	const box = await sandbox("m06", { screenplay: join(metricFixtures, "m06-screenplay.json") });
	try {
		out.write(
			"cmd.txt",
			"rpc: prompt for a verdict summary, then get_last_assistant_text; the stub answers concisely only when the brevity instruction is on the wire\n",
		);
		// One session, in a fresh agent directory. The product installs its brevity
		// prompt while its extensions register, which is before the resource loader
		// discovers the append file - so the rule is in force on the first turn an
		// operator ever takes, and this metric is allowed no warm-up session.
		const rpc = await runRpc(
			box.env,
			box.subject,
			[
				// Automatic goal wrapping would turn a bare question into a `/kpi` job,
				// which is the documented default (AC-24.1) and not what this measures.
				{ id: "0", type: "prompt", message: "/kpi off" },
				{ id: "1", type: "prompt", message: "Summarise the review verdict for round 2." },
			],
			{
				timeoutMs: 120_000,
				stopWhen: "responses",
				// Asked only once the assistant has finished its turn.
				deferred: [
					{
						after: /"type":"(?:turn_end|agent_settled|message_end)"/,
						lines: [{ id: "2", type: "get_last_assistant_text" }],
					},
				],
			},
		);
		out.write("rpc.jsonl", rpc.stdout);
		out.write("stderr.log", rpc.stderr);
		out.write("exit", `${rpc.status ?? "null"}\n`);
		const egress = egressClean(box);
		out.write("egress.log", egress.text);

		// The product's own answer to "what did you last say to the user".
		let reply = null;
		for (const line of rpc.stdout.split("\n")) {
			if (!line.includes("get_last_assistant_text")) continue;
			try {
				const message = JSON.parse(line);
				if (message.type === "response" && message.command === "get_last_assistant_text") {
					reply = message.data?.text ?? "";
				}
			} catch {
				/* not this line */
			}
		}
		out.write("last-assistant.txt", reply ?? "");
		const requests = readJsonl(box.modelLog);
		out.write("model-requests.jsonl", existsSync(box.modelLog) ? readFileSync(box.modelLog, "utf8") : "");
		// The concise scene only matches when the shipped brevity instruction is in
		// the prompt, so a matched "concise" node is evidence the rule was on the
		// wire rather than an assumption that it was.
		const conciseServed = requests.some((record) => record.matched_node === "concise");
		const appendSystem = join(box.agentDir, "APPEND_SYSTEM.md");
		const appendText = existsSync(appendSystem) ? readFileSync(appendSystem, "utf8") : "";
		out.write("append-system.md", appendText);

		const checks = [
			check(
				"append-system-installed",
				"append-system.md",
				/Keep user-visible answers short/.test(appendText),
				appendText.length > 0 ? "brevity rule present in the agent directory" : "APPEND_SYSTEM.md absent",
			),
			check(
				"brevity-rule-on-the-wire-first-turn",
				"model-requests.jsonl",
				conciseServed,
				conciseServed
					? "the concise scene matched the very first prompt of a fresh agent directory"
					: "the brevity instruction was not in the prompt",
			),
			check("reply-captured", "last-assistant.txt", typeof reply === "string" && reply.length > 0, `${reply?.length ?? 0} characters`),
			check("under-800", "last-assistant.txt", typeof reply === "string" && reply.length > 0 && reply.length < 800, `${reply?.length ?? 0} < 800`),
			check("loopback-only", "egress.log", egress.clean, egress.clean ? "no outbound attempt" : egress.text.slice(0, 200)),
		];
		out.write("result.json", {
			id: "M-06",
			checks,
			length: reply?.length ?? null,
			scope:
				"measures the product path (APPEND_SYSTEM install, prompt assembly, get_last_assistant_text) with a deterministic provider standing in for the model; it does not measure a live model's obedience",
		});
		return verdict("M-06", "RP-18", checks, out.dir, {
			fixture: "loopback provider that answers concisely only when the brevity rule is sent",
			okDetail: `the session's own last assistant text measured ${reply?.length ?? 0} characters`,
			scope:
				"product path only: a deterministic provider stands in for the model, so this proves the rule is installed, sent, and measurable - not that a live model obeys it",
		});
	} finally {
		teardown(box);
	}
}

const COLLECTORS = {
	"M-01": collectM01,
	"M-02": collectM02,
	"M-03": collectM03,
	"M-04": collectM04,
	"M-05": collectM05,
	"M-06": collectM06,
};

export const BUILT_METRICS = Object.keys(COLLECTORS);

/**
 * Runs one metric against the built binary. A thrown setup failure becomes a
 * failing metric with its reason, never a crash that loses the other metrics.
 */
export async function collectBuiltMetric(id, proofRoot) {
	const collector = COLLECTORS[id];
	if (!collector) {
		throw new Error(`no built-binary collector for ${id}`);
	}
	const startedAt = new Date().toISOString();
	try {
		const result = await collector(proofRoot);
		return { ...result, started: startedAt, finished: new Date().toISOString() };
	} catch (error) {
		const dir = join(proofRoot, id);
		mkdirSync(dir, { recursive: true });
		const message = error instanceof Error ? error.message : String(error);
		writeFileSync(join(dir, "result.json"), `${JSON.stringify({ id, pass: false, error: message }, null, 2)}\n`);
		return {
			pass: false,
			owner: "RP-19",
			evidence: relative(repoRoot, dir),
			checks: [],
			detail: `collector failed before it could decide: ${message}`,
			started: startedAt,
			finished: new Date().toISOString(),
		};
	}
}

/**
 * Every file under the proof tree, for the canary sweep.
 *
 * `id` narrows it to one metric; omitting it walks the whole tree, which is what
 * the sweep needs: evidence left by an earlier partial run is still evidence
 * shipped in `.kpi/proof/`, and a sweep that only looked at this invocation's
 * metrics would walk straight past it.
 */
export function evidenceFiles(proofRoot, id) {
	const dir = id === undefined ? proofRoot : join(proofRoot, id);
	if (!existsSync(dir)) return [];
	const files = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (statSync(path).size < 4 * 1024 * 1024) files.push(path);
		}
	};
	walk(dir);
	return files;
}
