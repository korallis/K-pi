#!/usr/bin/env node
/**
 * Machine-driven UAT row runner.
 * Boundary: no packages/.../src imports; no node --test; artifact-only grade.
 *
 *   node uat/run-row.mjs --row UAT-01
 *   node uat/run-row.mjs --row all-batch1
 *   node uat/run-row.mjs --row all-batch2
 *   node uat/run-row.mjs --row all-batch3
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { writeGrade } from "./grade.mjs";
import { createBatch23Runners } from "./batch23-rows.mjs";
import { createBatch45Runners } from "./batch45-rows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "packages/coding-agent/dist/bundle/cli.js");
const guardPath = join(here, "egress-guard.cjs");
const stubPath = join(here, "stub-model.mjs");
const ptyPath = join(here, "pty_drive.py");

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			s.close((err) => (err ? reject(err) : resolvePort(port)));
		});
		s.on("error", reject);
	});
}

function pinAgentDir(agentDir, baseUrl, extraSettings = {}) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: "local-openai", defaultModel: "uat-stub", ...extraSettings }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "accounts.json"),
		`${JSON.stringify(
			{
				version: 1,
				pools: {
					"local-openai": {
						strategy: "round-robin",
						slots: [{ id: "a", kind: "local", label: "a", baseUrl }],
					},
				},
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
	// Graph agent sessions call createAgentSession with the agentDir default model.
	// Local OpenAI-compatible servers need a configured credential so the client
	// can construct; accounts then null the Authorization header on the wire.
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify({ "local-openai": { type: "api_key", key: "uat-local-no-op" } }, null, 2)}\n`,
	);
}


/**
 * Credentialed OpenAI-compatible pool on the loopback stub, with catalog model
 * pricing intact. Local pools are intentionally $0 (AC-27.6); priced spend for
 * maxCostUsd / failover rows uses this pin instead.
 */
function pinZaiStubPool(agentDir, baseUrl, { modelId = "glm-5.3", slots = 2, extraFamilies = [] } = {}) {
	mkdirSync(agentDir, { recursive: true });
	const zaiSlots = [];
	const secrets = {};
	for (let i = 0; i < slots; i += 1) {
		const id = String.fromCharCode(97 + i); // a, b, …
		zaiSlots.push({ id, kind: "api_key", label: id });
		secrets[`zai/${id}`] = { type: "api_key", key: `uat-slot-${id}` };
	}
	const pools = {
		zai: { strategy: "round-robin", slots: zaiSlots },
	};
	const fallback = ["zai"];
	const providers = { zai: { baseUrl } };
	const auth = { zai: { type: "api_key", key: "uat-zai-preflight" } };
	for (const family of extraFamilies) {
		const fid = family.id;
		const fslots = (family.slots || ["a"]).map((sid) => ({ id: sid, kind: "api_key", label: sid }));
		pools[fid] = { strategy: "round-robin", slots: fslots };
		fallback.push(fid);
		providers[fid] = { baseUrl: family.baseUrl || baseUrl };
		auth[fid] = { type: "api_key", key: `uat-${fid}-preflight` };
		for (const s of fslots) {
			secrets[`${fid}/${s.id}`] = { type: "api_key", key: `uat-${fid}-slot-${s.id}` };
		}
	}
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: "zai", defaultModel: modelId }, null, 2)}\n`,
	);
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({ providers }, null, 2)}\n`);
	writeFileSync(
		join(agentDir, "accounts.json"),
		`${JSON.stringify({ version: 1, pools, fallback, stickiness: "session-until-exhausted" }, null, 2)}\n`,
	);
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`);
	writeFileSync(join(agentDir, "accounts.secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}

function startStub(port, logFile, screenplayPath, stubEnv = {}) {
	return new Promise((resolveStub, reject) => {
		const args = [stubPath, "--port", String(port), "--log", logFile];
		if (screenplayPath) args.push("--screenplay", screenplayPath);
		const child = spawn(process.execPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...stubEnv },
		});
		let buf = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("stub boot timeout"));
		}, 8_000);
		child.stdout.on("data", (c) => {
			buf += c.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				clearTimeout(timer);
				try {
					resolveStub({ child, info: JSON.parse(buf.slice(0, nl)) });
				} catch (e) {
					reject(e);
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
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		FORCE_COLOR: "3",
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${guardPath}`,
		UAT_EGRESS_LOG: egressLog,
	};
	delete env.NO_COLOR;
	return env;
}

function runRpc(env, cwd, lines, { timeoutMs = 30_000, confirm = true, onConfirm, stopWhen = "response", model = "local-openai/uat-stub" } = {}) {
	return new Promise((resolveRpc) => {
		const child = spawn(
			process.execPath,
			[cliPath, "--offline", "--mode", "rpc", "--model", model],
			{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		let done = false;
		const confirms = [];
		const answered = new Set();
		const finish = () => {
			if (done) return;
			done = true;
			try {
				child.stdin.end();
			} catch {
				/* ignore */
			}
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			setTimeout(
				() =>
					resolveRpc({
						status: child.exitCode,
						signal: child.signalCode,
						stdout,
						stderr,
						confirms,
					}),
				200,
			);
		};
		const maybeAnswerConfirms = () => {
			for (const line of stdout.split("\n")) {
				if (!line.includes("extension_ui_request")) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.type !== "extension_ui_request" || msg.method !== "confirm") continue;
				if (!msg.id || answered.has(msg.id)) continue;
				answered.add(msg.id);
				const entry = {
					id: msg.id,
					title: msg.title || "",
					message: msg.message || "",
					confirmed: Boolean(confirm),
				};
				confirms.push(entry);
				if (typeof onConfirm === "function") onConfirm(entry);
				child.stdin.write(
					JSON.stringify({
						type: "extension_ui_response",
						id: msg.id,
						confirmed: entry.confirmed,
					}),
				);
				child.stdin.write("\n");
			}
		};
		child.stdout.on("data", (c) => {
			stdout += c.toString("utf8");
			maybeAnswerConfirms();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf8");
		});
		for (const line of lines) {
			child.stdin.write(typeof line === "string" ? line : JSON.stringify(line));
			child.stdin.write("\n");
		}
		const started = Date.now();
		const timer = setInterval(() => {
			maybeAnswerConfirms();
			// K-π loop finished: notify carries terminal status (DONE/UNSAFE/…).
			const terminalNotify =
				/K-π job .+ (DONE|UNSAFE|BLOCKED|EXHAUSTED|NEEDS_HUMAN|NO_PROGRESS)\b/.test(stdout) ||
				/"STOP (DONE|UNSAFE|BLOCKED|EXHAUSTED|NEEDS_HUMAN|NO_PROGRESS)"/.test(stdout);
			if (stopWhen === "terminal" && terminalNotify) {
				clearInterval(timer);
				finish();
				return;
			}
			if (stopWhen === "job-started") {
				const runsDir = join(cwd, ".kpi", "runs");
				let started = false;
				try {
					if (existsSync(runsDir)) {
						started = readdirSync(runsDir).some((n) => !n.startsWith("."));
					}
				} catch {
					started = false;
				}
				// Also accept widget evidence a LOOP is running.
				if (started || /NODE (ac-compile|specify|plan|implement)/.test(stdout)) {
					clearInterval(timer);
					finish();
					return;
				}
			}
			if (stopWhen === "response" && terminalNotify) {
				clearInterval(timer);
				finish();
				return;
			}
			const responses = (stdout.match(/"type":"response"/g) || []).length;
			const want = lines.filter((l) => {
				const t = typeof l === "string" ? l : l.type;
				return t && t !== "set_model";
			}).length;
			if (responses >= want && want > 0) {
				const isPrompt = lines.some((l) => (typeof l === "object" ? l.type === "prompt" : false));
				if (!isPrompt || /agent_settled|"command":"prompt"/.test(stdout) || Date.now() - started > timeoutMs - 500) {
					// keep waiting while a confirm is outstanding and loop may continue
					if (
						isPrompt &&
						/extension_ui_request/.test(stdout) &&
						!/agent_settled/.test(stdout) &&
						!terminalNotify &&
						Date.now() - started < timeoutMs - 200
					) {
						return;
					}
					clearInterval(timer);
					finish();
				}
			}
			if (Date.now() - started > timeoutMs) {
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

/** Sequential RPC prompts on one long-lived session (keeps in-memory extension state). */
function runRpcSequential(env, cwd, steps, { timeoutMs = 60_000, model = "local-openai/uat-stub" } = {}) {
	return new Promise((resolveRpc) => {
		const child = spawn(
			process.execPath,
			[cliPath, "--offline", "--mode", "rpc", "--model", model],
			{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			try {
				child.stdin.end();
			} catch {
				/* ignore */
			}
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			setTimeout(
				() => resolveRpc({ status: child.exitCode, signal: child.signalCode, stdout, stderr, confirms }),
				250,
			);
		};
		const answered = new Set();
		const confirms = [];
		const maybeAnswerConfirms = () => {
			for (const line of stdout.split("\n")) {
				if (!line.includes('"method":"confirm"') && !line.includes('"method": "confirm"')) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.type !== "extension_ui_request" || msg.method !== "confirm" || !msg.id) continue;
				if (answered.has(msg.id)) continue;
				answered.add(msg.id);
				confirms.push({ id: msg.id, title: msg.title || "", message: msg.message || "", confirmed: true });
				child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: true }));
				child.stdin.write("\n");
			}
		};
		child.stdout.on("data", (c) => {
			stdout += c.toString("utf8");
			maybeAnswerConfirms();
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf8");
		});
		child.on("exit", () => finish());

		let i = 0;
		const started = Date.now();
		const sendNext = () => {
			if (i >= steps.length) {
				finish();
				return;
			}
			if (Date.now() - started > timeoutMs) {
				finish();
				return;
			}
			const step = steps[i];
			const isPrompt = step.type === "prompt";
			const stepId = step.id != null ? String(step.id) : "";
			let attempts = 0;
			const maxAttempts = isPrompt ? 3 : 1;

			const runAttempt = () => {
				attempts += 1;
				const beforeLen = stdout.length;
				child.stdin.write(JSON.stringify(step));
				child.stdin.write("\n");
				const waitStart = Date.now();
				const wait = setInterval(() => {
					const chunk = stdout.slice(beforeLen);
					// Require this step's own prompt response — a mid-turn agent_settled
					// from a prior multi-tool prompt must not unlock the next send.
					const idPat = stepId
						? new RegExp(
								`"id"\\s*:\\s*"${stepId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^\\n]*"command"\\s*:\\s*"prompt"`,
							)
						: /"command":"prompt"/;
					const successMatch = isPrompt ? chunk.match(/"success"\s*:\s*(true|false)/) : null;
					const settled = isPrompt
						? idPat.test(chunk) && successMatch !== null
						: /"type":"response"/.test(chunk);
					const settledTurn = !isPrompt || chunk.includes('"type":"agent_settled"');
					// Multi-tool spawn/claim turns (UAT-23) need far more than 20s.
					const remaining = timeoutMs - (Date.now() - started);
					const stepBudget = Math.min(180_000, Math.max(45_000, remaining));
					const timedOut = Date.now() - waitStart > stepBudget;
					const failedBusy =
						isPrompt &&
						successMatch &&
						successMatch[1] === "false" &&
						/already processing/i.test(chunk);
					if (failedBusy && attempts < maxAttempts && !timedOut) {
						// Wait for the prior turn to finish, then resend the same step.
						if (chunk.includes('"type":"agent_settled"') || Date.now() - waitStart > 5_000) {
							clearInterval(wait);
							setTimeout(runAttempt, 400);
						}
						return;
					}
					if ((settled && settledTurn && !failedBusy) || timedOut) {
						clearInterval(wait);
						i += 1;
						setTimeout(sendNext, timedOut ? 500 : 200);
					}
				}, 100);
			};
			runAttempt();
		};
		// kick off
		sendNext();
		setTimeout(finish, timeoutMs + 1000);
	});
}

function initGit(dir) {
	spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
	spawnSync("git", ["config", "user.email", "uat@example.com"], { cwd: dir, encoding: "utf8" });
	spawnSync("git", ["config", "user.name", "UAT"], { cwd: dir, encoding: "utf8" });
	spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
	spawnSync("git", ["commit", "-m", "chore: uat fixture baseline", "--allow-empty"], {
		cwd: dir,
		encoding: "utf8",
	});
}

function gitSnapshot(dir) {
	const log = spawnSync("git", ["log", "--oneline", "-5"], { cwd: dir, encoding: "utf8" });
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
	return {
		log: log.stdout || "",
		status: status.stdout || "",
		head: (head.stdout || "").trim(),
	};
}

function copyFixture(name, dest) {
	const src = join(repoRoot, "fixtures", name);
	if (!existsSync(src)) throw new Error(`fixture missing: ${name}`);
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, { recursive: true });
	initGit(dest);
}

function listPkgJsonFiles(root) {
	const out = [];
	const skip = new Set(["node_modules", ".git", "dist", "examples", "test", "tests", "fixtures", "selftest"]);
	const walk = (dir, depth = 0) => {
		if (!existsSync(dir) || depth > 6) return;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (skip.has(ent.name)) continue;
			const p = join(dir, ent.name);
			if (ent.isDirectory()) walk(p, depth + 1);
			else if (ent.name === "package.json") out.push(p);
		}
	};
	walk(root);
	return out;
}

function scanManifests(root) {
	const hits = [];
	for (const file of listPkgJsonFiles(root)) {
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		const rel = relative(root, file).replaceAll("\\", "/");
		if (Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package")) {
			hits.push({ file: rel, kind: "keywords:pi-package" });
		}
		if (pkg.pi != null) hits.push({ file: rel, kind: "pi-key" });
		const peers = pkg.peerDependencies || {};
		for (const k of Object.keys(peers)) {
			if (k.startsWith("@earendil-works/pi-")) hits.push({ file: rel, kind: `peer:${k}` });
		}
	}
	return hits;
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

function fixtureGoal(name) {
	const path = join(repoRoot, "fixtures", name, "task.txt");
	if (!existsSync(path)) throw new Error(`missing fixture goal: ${path}`);
	return readFileSync(path, "utf8").trim();
}

function ensureCli() {
	if (!existsSync(cliPath)) throw new Error(`built CLI missing: ${cliPath}`);
}

function finishRow(rowDir, specs, { notes, extra = {}, forceFail = false, forceFailReason } = {}) {
	const grade = writeGrade(rowDir, specs);
	let ok = grade.result.ok;
	let fail_reason;
	if (forceFail) {
		ok = false;
		fail_reason = forceFailReason || "forced fail: incomplete real-user path";
	}
	const final = {
		...grade.result,
		...extra,
		ok,
		verdict: ok ? "PASS" : "FAIL",
	};
	if (fail_reason) final.fail_reason = fail_reason;
	writeFileSync(join(rowDir, "result.json"), `${JSON.stringify(final, null, 2)}\n`);
	if (notes) writeFileSync(join(rowDir, "notes.md"), notes.endsWith("\n") ? notes : `${notes}\n`);
	return final;
}

async function prepareSandbox(rowId, { fixture } = {}) {
	const rowDir = join(repoRoot, ".kpi/uat", rowId);
	rmSync(rowDir, { recursive: true, force: true });
	mkdirSync(join(rowDir, "artifacts"), { recursive: true });
	const home = mkdtempSync(join(tmpdir(), `uat-${rowId}-home-`));
	const agentDir = mkdtempSync(join(tmpdir(), `uat-${rowId}-agent-`));
	const subject = mkdtempSync(join(tmpdir(), `uat-${rowId}-subj-`));
	if (fixture) copyFixture(fixture, subject);
	else {
		writeFileSync(join(subject, "README.md"), `# ${rowId} scratch\n`);
		initGit(subject);
	}
	const modelLog = join(rowDir, "model-requests.jsonl");
	writeFileSync(modelLog, "");
	const egressLog = join(rowDir, "egress.log");
	writeFileSync(egressLog, "");
	const planStackFile = join(rowDir, "artifacts", "plan-stack-override.json");
	writeFileSync(planStackFile, ""); // empty = use stub default health stack
	const reviewModeFile = join(rowDir, "artifacts", "review-mode.txt");
	const reviewCounterFile = join(rowDir, "artifacts", "review-counter.txt");
	writeFileSync(reviewModeFile, "PASS\n");
	writeFileSync(reviewCounterFile, "0\n");
	const subjectDirFile = join(rowDir, "artifacts", "subject-dir.txt");
	writeFileSync(subjectDirFile, `${subject}\n`);
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	pinAgentDir(agentDir, baseUrl);
	const screenplay = join(here, "fixtures", `${rowId.toLowerCase()}-screenplay.json`);
	const sp = existsSync(screenplay) ? screenplay : join(here, "fixtures/loop-agent-screenplay.json");
	const { child: stub, info } = await startStub(port, modelLog, sp, {
		UAT_PLAN_STACK_FILE: planStackFile,
		UAT_REVIEW_MODE_FILE: reviewModeFile,
		UAT_REVIEW_COUNTER_FILE: reviewCounterFile,
		UAT_SUBJECT_DIR: subject,
		UAT_SUBJECT_DIR_FILE: subjectDirFile,
	});
	const env = baseEnv({ home, agentDir, egressLog });
	return {
		rowDir,
		home,
		agentDir,
		subject,
		modelLog,
		egressLog,
		port,
		baseUrl,
		stub,
		info,
		env,
		planStackFile,
		reviewModeFile,
		reviewCounterFile,
		subjectDirFile,
	};
}

function cleanupSandbox(box) {
	try {
		box.stub.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	for (const p of [box.home, box.agentDir, box.subject]) {
		try {
			rmSync(p, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

async function runUat01() {
	const box = await prepareSandbox("UAT-01");
	const { rowDir, env, subject } = box;
	try {
		writeFileSync(
			join(rowDir, "cmd.txt"),
			["node cli --version", "rpc get_commands", "pty interactive /", "manifest scan"].join("\n") + "\n",
		);

		const ver = spawnSync(process.execPath, [cliPath, "--version"], {
			cwd: subject,
			env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
			encoding: "utf8",
			timeout: 10_000,
		});
		writeFileSync(join(rowDir, "stdout.log"), ver.stdout || "");
		writeFileSync(join(rowDir, "stderr.log"), ver.stderr || "");
		writeFileSync(join(rowDir, "exit"), String(ver.status ?? "null"));
		writeFileSync(join(rowDir, "artifacts/version.txt"), `${(ver.stdout || "").trim()}\n`);

		const rpc = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "get_commands" },
			],
			{ timeoutMs: 25_000 },
		);
		writeFileSync(join(rowDir, "rpc.jsonl"), rpc.stdout || "");
		writeFileSync(join(rowDir, "artifacts/rpc-stderr.log"), rpc.stderr || "");

		let commands = [];
		for (const line of (rpc.stdout || "").split("\n")) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.type === "response" && msg.command === "get_commands" && msg.success) {
					if (Array.isArray(msg.data)) commands = msg.data;
					else if (msg.data?.commands) commands = msg.data.commands;
				}
			} catch {
				/* ignore */
			}
		}
		writeFileSync(join(rowDir, "artifacts/commands.json"), `${JSON.stringify(commands, null, 2)}\n`);
		const names = commands.map((c) => String(c.name || c.id || c).replace(/^\//, ""));
		writeFileSync(join(rowDir, "artifacts/command-names.txt"), `${names.sort().join("\n")}\n`);

		const ptyOut = join(rowDir, "pty");
		mkdirSync(ptyOut, { recursive: true });
		const script = JSON.stringify([
			{ expect: "K-\\u03c0|kpi v0|escape interrupt", send: "/\\n", timeout: 25, drain: 0.7 },
			{ expect: "settings|accounts|statusbar|kpi|specify|loop", send: "settings\\n", timeout: 12, drain: 0.8 },
			{ expect: "Theme|theme|Appearance|dark|light|loop|settings", send: "\\x1b", timeout: 10, after: 0.5 },
		]);
		const pty = spawnSync(
			"python3",
			[
				ptyPath,
				"--cols",
				"120",
				"--rows",
				"40",
				"--out-dir",
				ptyOut,
				"--cwd",
				subject,
				"--timeout",
				"45",
				"--script",
				script,
				"--",
				process.execPath,
				cliPath,
				"--offline",
				"--model",
				"local-openai/uat-stub",
			],
			{ cwd: repoRoot, env, encoding: "utf8", timeout: 55_000 },
		);
		writeFileSync(join(rowDir, "artifacts/pty-drive.json"), pty.stdout || "");
		writeFileSync(join(rowDir, "artifacts/pty-drive.err"), pty.stderr || "");
		if (existsSync(join(ptyOut, "frame.raw"))) {
			copyFileSync(join(ptyOut, "frame.raw"), join(rowDir, "frame.raw"));
			copyFileSync(join(ptyOut, "frame.txt"), join(rowDir, "frame.txt"));
		} else {
			writeFileSync(join(rowDir, "frame.raw"), "");
			writeFileSync(join(rowDir, "frame.txt"), "");
		}

		const manifestHits = [
			...scanManifests(join(repoRoot, "packages")),
			...scanManifests(repoRoot).filter((h) => h.file === "package.json"),
		];
		writeFileSync(join(rowDir, "artifacts/manifest-scan.json"), `${JSON.stringify(manifestHits, null, 2)}\n`);

		const required = ["kpi", "loop", "accounts", "specify", "plan", "review", "verify", "ship", "statusbar"];
		const missingCmds = required.filter((r) => !names.some((n) => n === r || n.endsWith(r)));
		writeFileSync(
			join(rowDir, "artifacts/required-commands.json"),
			`${JSON.stringify({ required, names, missing: missingCmds }, null, 2)}\n`,
		);

		const specs = [
			{ id: "version-0.1.0", artifact: "artifacts/version.txt", contains: "0.1.0" },
			{ id: "has-kpi-cmd", artifact: "artifacts/command-names.txt", contains: "kpi" },
			{ id: "has-loop-cmd", artifact: "artifacts/command-names.txt", contains: "loop" },
			{ id: "has-accounts-cmd", artifact: "artifacts/command-names.txt", contains: "accounts" },
			{ id: "has-statusbar-cmd", artifact: "artifacts/command-names.txt", contains: "statusbar" },
			{ id: "frame-brand", artifact: "frame.txt", contains: "K-π" },
			{ id: "frame-sgr", artifact: "frame.raw", locator: "re:\u001b\\[" },
			{ id: "no-pi-package-keyword", artifact: "artifacts/manifest-scan.json", expected: "[]\n" },
		];

		const frameTxt = existsSync(join(rowDir, "frame.txt")) ? readFileSync(join(rowDir, "frame.txt"), "utf8") : "";
		const frameRaw = existsSync(join(rowDir, "frame.raw")) ? readFileSync(join(rowDir, "frame.raw")) : Buffer.alloc(0);
		const notes = [
			"# UAT-01",
			"",
			`- CLI sha256: ${sha256File(cliPath)}`,
			`- version: ${(ver.stdout || "").trim()}`,
			`- commands: ${names.length}; missing: ${missingCmds.join(", ") || "none"}`,
			`- frame bytes: ${frameRaw.length}; brand: ${frameTxt.includes("K-π")}; truecolor: ${frameRaw.includes(Buffer.from("38;2"))}`,
			`- manifest hits: ${manifestHits.length}`,
		].join("\n");

		return finishRow(rowDir, specs, { notes, extra: { row: "UAT-01" } });
	} finally {
		cleanupSandbox(box);
	}
}

async function runUat02() {
	const box = await prepareSandbox("UAT-02", { fixture: "healthcheck-gated" });
	const { rowDir, env, subject } = box;
	try {
		const goal = fixtureGoal("healthcheck-gated");
		writeFileSync(join(rowDir, "cmd.txt"), `rpc: /kpi ${goal.split("\n")[0]}…\n`);
		// Snapshot staged stat when commit confirm appears (M-01)
		let cachedStatAtConfirm = null;
		const rpc = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "prompt", message: `/kpi ${goal}` },
			],
			{
				timeoutMs: 180_000,
				confirm: true,
				stopWhen: "terminal",
				onConfirm: (c) => {
					if (/Approve git commit/i.test(c.title || "")) {
						const st = spawnSync("git", ["diff", "--stat", "--cached", "HEAD"], {
							cwd: subject,
							encoding: "utf8",
						});
						const short = spawnSync("git", ["diff", "--shortstat", "HEAD"], {
							cwd: subject,
							encoding: "utf8",
						});
						cachedStatAtConfirm = {
							diff_stat_cached: (st.stdout || "").trim(),
							diff_shortstat_HEAD: (short.stdout || "").trim(),
							confirm_message: c.message,
						};
					}
				},
			},
		);
		writeFileSync(join(rowDir, "rpc.jsonl"), rpc.stdout || "");
		writeFileSync(join(rowDir, "stdout.log"), rpc.stdout || "");
		writeFileSync(join(rowDir, "stderr.log"), rpc.stderr || "");
		writeFileSync(join(rowDir, "exit"), String(rpc.status ?? "null"));

		const art = join(rowDir, "artifacts");
		const kpiRuns = join(subject, ".kpi/runs");
		if (existsSync(kpiRuns)) cpSync(kpiRuns, join(art, "runs"), { recursive: true });
		const git = gitSnapshot(subject);
		writeFileSync(join(rowDir, "git.txt"), `HEAD ${git.head}\nSTATUS\n${git.status}\nLOG\n${git.log}\n`);

		for (const name of ["task.json", "events.jsonl", "context.md"]) {
			const p = walkFind(join(art, "runs"), name) || walkFind(kpiRuns, name);
			if (p) copyFileSync(p, join(art, name));
			else writeFileSync(join(art, name), name.endsWith(".json") ? "{}\n" : "");
		}

		const confirms = rpc.confirms || [];
		writeFileSync(join(art, "confirms.json"), `${JSON.stringify(confirms, null, 2)}\n`);
		writeFileSync(
			join(art, "commit-confirm-stat.json"),
			`${JSON.stringify(cachedStatAtConfirm || { missing: true }, null, 2)}\n`,
		);
		const commitConfirm = confirms.find((c) => /Approve git commit/i.test(c.title || ""));
		const releaseConfirm = confirms.find((c) => /release|Approve gated/i.test(c.title || c.message || ""));
		writeFileSync(
			join(art, "confirm-kinds.txt"),
			[
				commitConfirm ? "commit-confirm" : "no-commit-confirm",
				releaseConfirm ? "release-confirm" : "no-release-confirm",
			].join("\n") + "\n",
		);

		// Diff-stat parity: policy question embeds shortstat-style summary
		let statMatch = "n/a";
		if (commitConfirm && cachedStatAtConfirm) {
			const msg = commitConfirm.message || "";
			const m = /(\d+) files? changed, (\d+) insertions?\(\+\), (\d+) deletions?\(-\)/.exec(msg);
			const short = cachedStatAtConfirm.diff_shortstat_HEAD || "";
			const sm = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(short);
			if (m && sm) {
				statMatch =
					m[1] === sm[1] && (m[2] || "0") === (sm[2] || "0") && (m[3] || "0") === (sm[3] || "0")
						? "match"
						: "mismatch";
			} else if (m && !short) {
				// empty tree / no diff — still require the dialog carried a real stat line
				statMatch = "dialog-has-stat";
			} else {
				statMatch = "parse-failed";
			}
		}
		writeFileSync(join(art, "stat-match.txt"), `${statMatch}\n`);

		const specs = [
			{ id: "task-goal", artifact: "artifacts/task.json", contains: "goal" },
			{ id: "task-acceptance", artifact: "artifacts/task.json", contains: "acceptance" },
			{ id: "events-exist", artifact: "artifacts/events.jsonl", locator: "re:." },
			{ id: "mode-gated", artifact: "artifacts/task.json", contains: "gated" },
			{ id: "commit-confirm", artifact: "artifacts/confirm-kinds.txt", locator: "re:^commit-confirm$" },
			{ id: "release-confirm", artifact: "artifacts/confirm-kinds.txt", locator: "re:^release-confirm$" },
			{ id: "stat-match", artifact: "artifacts/stat-match.txt", locator: "re:^(match|dialog-has-stat)$" },
			{ id: "no-push", artifact: "git.txt", absent: "git push" },
		];		const notes = [
			"# UAT-02",
			"",
			`- fixture: healthcheck-gated (executable goal from task.txt)`,
			`- rpc status: ${rpc.status}`,
			`- confirms: ${confirms.length} (commit=${Boolean(commitConfirm)} release=${Boolean(releaseConfirm)})`,
			`- stat-match: ${statMatch}`,
			`- task bytes: ${readFileSync(join(art, "task.json")).length}`,
			`- git head: ${git.head}`,
			`- stderr: ${(rpc.stderr || "").slice(0, 400)}`,
		].join("\n");
		return finishRow(rowDir, specs, { notes, extra: { row: "UAT-02" } });
	} finally {
		cleanupSandbox(box);
	}
}

async function runUat04() {
	const box = await prepareSandbox("UAT-04", { fixture: "healthcheck-auto" });
	const { rowDir, env, subject } = box;
	try {
		const goal = fixtureGoal("healthcheck-auto");
		writeFileSync(join(rowDir, "cmd.txt"), "rpc: /kpi --mode autopilot <executable ACs from task.txt>\n");
		const before = gitSnapshot(subject);
		const rpc = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "prompt", message: `/kpi --mode autopilot ${goal}` },
			],
			{ timeoutMs: 240_000, confirm: true, stopWhen: "terminal" },
		);
		writeFileSync(join(rowDir, "rpc.jsonl"), rpc.stdout || "");
		writeFileSync(join(rowDir, "stdout.log"), rpc.stdout || "");
		writeFileSync(join(rowDir, "stderr.log"), rpc.stderr || "");
		writeFileSync(join(rowDir, "exit"), String(rpc.status ?? "null"));
		const after = gitSnapshot(subject);
		writeFileSync(
			join(rowDir, "git.txt"),
			`BEFORE ${before.head}\nAFTER ${after.head}\nSTATUS\n${after.status}\nLOG\n${after.log}\n`,
		);
		const art = join(rowDir, "artifacts");
		const kpiRuns = join(subject, ".kpi/runs");
		if (existsSync(kpiRuns)) cpSync(kpiRuns, join(art, "runs"), { recursive: true });
		for (const name of ["task.json", "evidence.json", "verdict.json", "events.jsonl"]) {
			const p = walkFind(join(art, "runs"), name) || walkFind(kpiRuns, name);
			if (p) copyFileSync(p, join(art, name));
			else writeFileSync(join(art, name), name.endsWith(".json") ? "{}\n" : "");
		}
		writeFileSync(join(art, "runs-present.txt"), existsSync(join(art, "runs")) ? "yes\n" : "no\n");
		const doneMarker = existsSync(join(art, "events.jsonl"))
			? readFileSync(join(art, "events.jsonl"), "utf8")
			: "";
		const stateJson = walkFind(join(art, "runs"), "state.json");
		const stateText = stateJson && existsSync(stateJson) ? readFileSync(stateJson, "utf8") : "";
		const hasDone =
			/"status"\s*:\s*"DONE"/.test(doneMarker) ||
			/"status"\s*:\s*"DONE"/.test(stateText) ||
			/K-π job .+ DONE\b/.test(rpc.stdout || "") ||
			/"STOP DONE"/.test(rpc.stdout || "");
		writeFileSync(join(art, "done-marker.txt"), hasDone ? "status=DONE\n" : "status=INCOMPLETE\n");
		writeFileSync(
			join(art, "commit-delta.txt"),
			before.head !== after.head ? "commit=created\n" : "commit=absent\n",
		);
		const specs = [
			{ id: "runs-present", artifact: "artifacts/runs-present.txt", contains: "yes" },
			{ id: "task-exists", artifact: "artifacts/task.json", contains: "goal" },
			{ id: "autopilot-mode", artifact: "artifacts/task.json", contains: "autopilot" },
			{ id: "terminal-done", artifact: "artifacts/done-marker.txt", contains: "status=DONE" },
			{ id: "one-new-commit", artifact: "artifacts/commit-delta.txt", contains: "commit=created" },
			{ id: "no-push", artifact: "git.txt", absent: "git push" },
		];		const notes = [
			"# UAT-04",
			"",
			`- head before/after: ${before.head} → ${after.head}`,
			`- new commit: ${before.head !== after.head}`,
			`- rpc status: ${rpc.status}`,
		].join("\n");
		return finishRow(rowDir, specs, { notes, extra: { row: "UAT-04" } });
	} finally {
		cleanupSandbox(box);
	}
}

async function runUat13() {
	const box = await prepareSandbox("UAT-13", { fixture: "healthcheck-gated" });
	const { rowDir, env, subject } = box;
	try {
		// Force unknown.gated=deny so the unrecognized command yields the product
		// denial string (gated default is confirm, which the RPC harness accepts).
		mkdirSync(join(subject, ".kpi"), { recursive: true });
		writeFileSync(
			join(subject, ".kpi/policy.json"),
			`${JSON.stringify(
				{
					deny: [],
					commit: { gated: "confirm", autopilot: "after-release" },
					unknown: { gated: "deny", autopilot: "deny" },
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(join(rowDir, "cmd.txt"), "rpc bash: push, force-push, rm, deploy, unknown\n");
		// Policy hooks on tool_call — drive via model tool calls (not raw RPC bash).
		// Unique last-user tags so the stub screenplay is not poisoned by chat history.
		const attempts = [
			{ id: "push", tag: "UAT13_POLICY_PUSH", command: "git push origin HEAD" },
			{ id: "force-push", tag: "UAT13_POLICY_FORCE", command: "git push --force origin HEAD" },
			{ id: "rm", tag: "UAT13_POLICY_RM", command: "rm -rf /tmp/uat-should-not-matter-but-deny" },
			{ id: "deploy", tag: "UAT13_POLICY_DEPLOY", command: "kubectl apply -f deploy.yaml" },
			{ id: "unknown", tag: "UAT13_POLICY_UNKNOWN", command: "totally-unknown-bin-xyz --force" },
		];
		const steps = [
			{ id: "0", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
			{ id: "off", type: "prompt", message: "/kpi off" },
		];
		for (let i = 0; i < attempts.length; i++) {
			const a = attempts[i];
			steps.push({
				id: `p${i}`,
				type: "prompt",
				message: `${a.tag} Run ONLY this bash tool call then stop: ${a.command}`,
			});
		}
		const rpc = await runRpcSequential(env, subject, steps, { timeoutMs: 240_000 });
		writeFileSync(join(rowDir, "artifacts/policy-session.jsonl"), rpc.stdout || "");
		const sessionText = `${rpc.stdout || ""}\n${rpc.stderr || ""}`;

		// Product denial strings only — never "any failing bash" and never harness attempt lists.
		const productDenialRes = [
			/Policy denied command: [^\n"\\]+/g,
			/Policy denied write outside write_allow: [^\n"\\]+/g,
			/Policy denied unrecognized command: [^\n"\\]+/g,
			/Policy denied git commit before release\.approved: [^\n"\\]+/g,
			/Policy denied a secret-shaped path: [^\n"\\]+/g,
		];
		const productDenialSet = new Set();
		for (const re of productDenialRes) {
			for (const m of sessionText.matchAll(re)) productDenialSet.add(m[0]);
		}
		const productDenials = [...productDenialSet];
		writeFileSync(join(rowDir, "artifacts/product-denials.json"), `${JSON.stringify(productDenials, null, 2)}\n`);

		const results = attempts.map((a) => {
			const exactCommand = `Policy denied command: ${a.command}`;
			const exactUnrecognized = `Policy denied unrecognized command: ${a.command}`;
			const exactCommit = `Policy denied git commit before release.approved: ${a.command}`;
			const denial = [exactCommand, exactUnrecognized, exactCommit].find((s) => sessionText.includes(s)) || null;
			return { id: a.id, command: a.command, tag: a.tag, product_denied: Boolean(denial), denial };
		});
		writeFileSync(join(rowDir, "artifacts/policy-attempt-grades.json"), `${JSON.stringify(results, null, 2)}\n`);
		for (const a of attempts) {
			writeFileSync(join(rowDir, `artifacts/bash-${a.id}.jsonl`), rpc.stdout || "");
		}
		const denied = results.filter((r) => r.product_denied);
		writeFileSync(join(rowDir, "artifacts/denied-count.txt"), `${denied.length}/${results.length}\n`);
		writeFileSync(
			join(rowDir, "artifacts/all-product-denied.txt"),
			denied.length === results.length ? "yes\n" : `no ${denied.length}/${results.length}\n`,
		);
		writeFileSync(
			join(rowDir, "artifacts/push-product-denial.txt"),
			sessionText.includes("Policy denied command: git push origin HEAD")
				? "Policy denied command: git push origin HEAD\n"
				: "missing\n",
		);

		// tool.request deny records when a job is active (/kpi off path may have none).
		const toolRequestLines = [];
		const walkEv = (dir) => {
			if (!existsSync(dir)) return;
			for (const ent of readdirSync(dir, { withFileTypes: true })) {
				const pth = join(dir, ent.name);
				if (ent.isDirectory()) walkEv(pth);
				else if (ent.name === "events.jsonl") {
					for (const line of readFileSync(pth, "utf8").split("\n")) {
						if (!line.trim()) continue;
						try {
							const ev = JSON.parse(line);
							if (ev.type === "tool.request" && ev.decision === "deny") toolRequestLines.push(ev);
						} catch {
							/* ignore */
						}
					}
				}
			}
		};
		walkEv(join(subject, ".kpi"));
		writeFileSync(
			join(rowDir, "artifacts/tool-request-denies.json"),
			`${JSON.stringify({ count: toolRequestLines.length, samples: toolRequestLines.slice(0, 8) }, null, 2)}\n`,
		);

		writeFileSync(join(rowDir, "rpc.jsonl"), rpc.stdout || "");
		writeFileSync(join(rowDir, "stdout.log"), rpc.stdout || "");
		writeFileSync(join(rowDir, "stderr.log"), rpc.stderr || "");
		writeFileSync(join(rowDir, "exit"), "0");
		writeFileSync(join(rowDir, "git.txt"), JSON.stringify(gitSnapshot(subject), null, 2));

		const safe = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "bash", command: "echo hello-uat-safe" },
			],
			{ timeoutMs: 15_000 },
		);
		writeFileSync(join(rowDir, "artifacts/safe-echo-bash.jsonl"), safe.stdout || "");
		const safeText = `${safe.stdout || ""}\n${safe.stderr || ""}`;
		const safeProductDenied = /Policy denied /.test(safeText);
		const safeOk = /hello-uat-safe/.test(safeText) && !safeProductDenied;
		writeFileSync(join(rowDir, "artifacts/safe-echo-ok.txt"), safeOk ? "ok\n" : "fail\n");

		const specs = [
			{
				id: "push-denied-by-product",
				artifact: "artifacts/push-product-denial.txt",
				contains: "Policy denied command: git push origin HEAD",
			},
			{ id: "all-product-denied", artifact: "artifacts/all-product-denied.txt", contains: "yes" },
			{ id: "full-denial-count", artifact: "artifacts/denied-count.txt", contains: "5/5" },
			{ id: "safe-echo-allowed", artifact: "artifacts/safe-echo-ok.txt", contains: "ok" },
		];
		const notes = [
			"# UAT-13",
			"",
			`- attempts: ${results.length}`,
			`- product-denied: ${denied.length}/${results.length}`,
			`- unique product denial strings: ${productDenials.length}`,
			`- tool.request deny records: ${toolRequestLines.length}`,
			`- safe echo ok: ${safeOk}`,
			`- coverage: model bash tool_call is gated by policy.ts tool_call hook (see packages/coding-agent/test/kpi-policy-tool-call.test.ts).`,
			`- RPC type=bash is an operator shell path and does not go through tool_call; that is intentional for an explicit host operator, not a model-reachable bypass.`,
		].join("\n");
		return finishRow(rowDir, specs, { notes, extra: { row: "UAT-13", attempt_grades: results } });
	} finally {
		cleanupSandbox(box);
	}
}

async function runUat24() {
	const box = await prepareSandbox("UAT-24", { fixture: "healthcheck-gated" });
	const { rowDir, env, subject } = box;
	try {
		writeFileSync(join(rowDir, "cmd.txt"), "bare msg; /accounts; follow-up; /kpi off\n");
		const bare = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "prompt", message: "add a healthcheck" },
			],
			{ timeoutMs: 60_000, stopWhen: "job-started", confirm: true },
		);
		writeFileSync(join(rowDir, "artifacts/bare.jsonl"), bare.stdout || "");
		const runs1 = existsSync(join(subject, ".kpi/runs"))
			? readdirSync(join(subject, ".kpi/runs")).filter((n) => !n.startsWith("."))
			: [];
		writeFileSync(join(rowDir, "artifacts/runs-after-bare.txt"), `${runs1.join("\n")}\n`);

		const accounts = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "prompt", message: "/accounts" },
			],
			{ timeoutMs: 30_000 },
		);
		writeFileSync(join(rowDir, "artifacts/accounts.jsonl"), accounts.stdout || "");
		const runs2 = existsSync(join(subject, ".kpi/runs"))
			? readdirSync(join(subject, ".kpi/runs")).filter((n) => !n.startsWith("."))
			: [];

		const follow = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "prompt", message: "prefer GET /healthz" },
			],
			{ timeoutMs: 20_000, stopWhen: "job-started", confirm: true },
		);
		writeFileSync(join(rowDir, "artifacts/follow.jsonl"), follow.stdout || "");
		const runs3 = existsSync(join(subject, ".kpi/runs"))
			? readdirSync(join(subject, ".kpi/runs")).filter((n) => !n.startsWith("."))
			: [];

		const off = await runRpc(
			env,
			subject,
			[
				{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
				{ id: "2", type: "prompt", message: "/kpi off" },
			],
			{ timeoutMs: 20_000 },
		);
		writeFileSync(join(rowDir, "artifacts/kpi-off.jsonl"), off.stdout || "");

		writeFileSync(
			join(rowDir, "rpc.jsonl"),
			[bare.stdout, accounts.stdout, follow.stdout, off.stdout].join("\n---\n"),
		);
		writeFileSync(join(rowDir, "stdout.log"), [bare.stdout, accounts.stdout, follow.stdout, off.stdout].join("\n"));
		writeFileSync(join(rowDir, "stderr.log"), [bare.stderr, accounts.stderr, follow.stderr, off.stderr].join("\n"));
		writeFileSync(join(rowDir, "exit"), "0");
		writeFileSync(join(rowDir, "git.txt"), JSON.stringify(gitSnapshot(subject), null, 2));
		writeFileSync(
			join(rowDir, "artifacts/run-counts.json"),
			`${JSON.stringify({ afterBare: runs1.length, afterAccounts: runs2.length, afterFollow: runs3.length }, null, 2)}\n`,
		);

		// Auto-wrap evidence: bare prompt becomes /kpi --mode gated ...
		const bareWrapped = /\/kpi --mode gated add a healthcheck/.test(bare.stdout || "");
		writeFileSync(join(rowDir, "artifacts/bare-wrap.txt"), bareWrapped ? "wrapped\n" : "not-wrapped\n");

		// /accounts must not create a second run directory when a job already exists
		const specs = [
			{ id: "run-counts-file", artifact: "artifacts/run-counts.json", contains: "afterBare" },
			{ id: "bare-auto-wrap", artifact: "artifacts/bare-wrap.txt", contains: "wrapped" },
		];
		if (runs1.length >= 1) {
			specs.push({
				id: "job-started",
				artifact: "artifacts/run-counts.json",
				locator: "re:\"afterBare\": [1-9]",
			});
			specs.push({
				id: "single-job-after-accounts",
				artifact: "artifacts/run-counts.json",
				contains: `"afterAccounts": ${runs1.length}`,
			});
			specs.push({
				id: "single-job-after-follow",
				artifact: "artifacts/run-counts.json",
				contains: `"afterFollow": ${runs1.length}`,
			});
		} else {
			// Product currently transforms bare→/kpi text but does not re-dispatch as command in RPC.
			// Still require a run dir for full PASS; record the gap.
			writeFileSync(join(rowDir, "artifacts/bare-started.txt"), "no\n");
			specs.push({ id: "bare-job-dir", artifact: "artifacts/bare-started.txt", contains: "yes" });
		}		const notes = [
			"# UAT-24",
			"",
			`- runs after bare: ${runs1.length} (${runs1.join(",")})`,
			`- after accounts: ${runs2.length}`,
			`- after follow: ${runs3.length}`,
		].join("\n");
		return finishRow(rowDir, specs, { notes, extra: { row: "UAT-24" } });
	} finally {
		cleanupSandbox(box);
	}
}

const BATCH1 = {
	"UAT-01": runUat01,
	"UAT-02": runUat02,
	"UAT-04": runUat04,
	"UAT-13": runUat13,
	"UAT-24": runUat24,
};

const BATCH23 = createBatch23Runners({
	prepareSandbox,
	cleanupSandbox,
	runRpc,
	runRpcSequential,
	finishRow,
	fixtureGoal,
	gitSnapshot,
	initGit,
	cliPath,
	repoRoot,
	pinZaiStubPool,
	pinAgentDir,
});

const BATCH45 = createBatch45Runners({
	prepareSandbox,
	cleanupSandbox,
	runRpc,
	runRpcSequential,
	finishRow,
	fixtureGoal,
	cliPath,
	repoRoot,
	pinZaiStubPool,
	pinAgentDir,
});

const ROWS = {
	...BATCH1,
	...BATCH23,
	...BATCH45,
};

const BATCH1_IDS = Object.keys(BATCH1);
const BATCH2_IDS = ["UAT-03", "UAT-05", "UAT-08", "UAT-22", "UAT-30"];
const BATCH3_IDS = ["UAT-09", "UAT-14", "UAT-23"];
const BATCH4_IDS = ["UAT-10", "UAT-11", "UAT-12", "UAT-26", "UAT-27", "UAT-28", "UAT-29"];
const BATCH5_IDS = ["UAT-17", "UAT-18", "UAT-19", "UAT-20", "UAT-21"];

async function main() {
	ensureCli();
	const args = process.argv.slice(2);
	let list = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--row") {
			const v = args[++i] || "";
			if (v === "all-batch1") list = [...BATCH1_IDS];
			else if (v === "all-batch2") list = [...BATCH2_IDS];
			else if (v === "all-batch3") list = [...BATCH3_IDS];
			else if (v === "all-batch4") list = [...BATCH4_IDS];
			else if (v === "all-batch5") list = [...BATCH5_IDS];
			else if (v === "all") list = [...BATCH1_IDS, ...BATCH2_IDS, ...BATCH3_IDS, ...BATCH4_IDS, ...BATCH5_IDS];
			else list = v.split(",").map((s) => s.trim()).filter(Boolean);
		}
	}
	if (!list.length) {
		console.error("usage: node uat/run-row.mjs --row UAT-01[,...] | all-batch1|all-batch2|all-batch3|all");
		process.exit(2);
	}
	const summary = [];
	for (const id of list) {
		const fn = ROWS[id];
		if (!fn) {
			summary.push({ row: id, verdict: "FAIL", error: "unknown row" });
			continue;
		}
		console.error(`→ running ${id}`);
		try {
			const result = await fn();
			summary.push({
				row: id,
				verdict: result.verdict,
				ok: result.ok,
				passed: result.passed,
				failed: result.failed,
				row_dir: result.row_dir,
			});
			console.error(`  ${result.verdict}  ${result.row_dir}`);
		} catch (e) {
			console.error(`  ERROR ${e.stack || e}`);
			summary.push({ row: id, verdict: "FAIL", error: String(e && e.message ? e.message : e) });
		}
	}
	const tag = list.every((id) => BATCH2_IDS.includes(id))
		? "batch2"
		: list.every((id) => BATCH3_IDS.includes(id))
			? "batch3"
			: list.every((id) => BATCH1_IDS.includes(id))
				? "batch1"
				: "mixed";
	const out = join(repoRoot, `.kpi/uat/${tag}-summary.json`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), summary }, null, 2)}\n`);
	console.log(JSON.stringify({ summary }, null, 2));
	process.exit(summary.some((s) => s.verdict !== "PASS") ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
