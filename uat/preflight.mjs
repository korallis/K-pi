#!/usr/bin/env node
/**
 * UAT E0 preflight gate.
 *
 * Runs against the **built** dist under a clean HOME. Evidence → `.kpi/uat/E0/`.
 *
 * Checks:
 *   1. Build hash + dist/kpi inventory
 *   2. Screenplay schema_payloads validate against shipped dist/kpi/schemas/*.json
 *   3. Stub round-trip through the built bundle (RPC prompt → model-requests.jsonl)
 *   4. egress-guard self-test (public host refused + logged)
 *   5. PTY truecolor self-test at a set width
 *   6. Canaries planted in fixture subject + session prompt file
 *   7. Forbidden-import scan of uat/
 *
 * Usage:
 *   node uat/preflight.mjs
 *   node uat/preflight.mjs --out .kpi/uat/E0
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
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
import { createServer } from "node:net";
import { CANARIES, scanHarness, writeGrade } from "./grade.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliPath = join(repoRoot, "packages/coding-agent/dist/bundle/cli.js");
const distKpi = join(repoRoot, "packages/coding-agent/dist/kpi");
const schemasDir = join(distKpi, "schemas");
const guardPath = join(here, "egress-guard.cjs");
const stubPath = join(here, "stub-model.mjs");
const ptyPath = join(here, "pty_drive.py");
const screenplayPath = join(here, "fixtures/e0-screenplay.json");

function sha256File(path) {
	const h = createHash("sha256");
	h.update(readFileSync(path));
	return h.digest("hex");
}

function listFiles(root) {
	const out = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, name.name);
			if (name.isDirectory()) walk(path);
			else out.push(relative(root, path).replaceAll("\\", "/"));
		}
	};
	walk(root);
	return out.sort();
}

function fail(step, message, detail) {
	const err = new Error(`${step}: ${message}`);
	err.step = step;
	err.detail = detail;
	throw err;
}

/* -------------------- minimal JSON Schema (draft subset) -------------------- */

function validateSchema(schema, data, rootSchema = schema, path = "$") {
	const errors = [];
	const push = (msg) => errors.push(`${path}: ${msg}`);

	const resolveRef = (ref) => {
		if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
		const parts = ref.slice(2).split("/");
		let cur = rootSchema;
		for (const p of parts) {
			cur = cur?.[p];
			if (cur === undefined) throw new Error(`unresolved $ref ${ref}`);
		}
		return cur;
	};

	const run = (sch, val, p) => {
		if (!sch || typeof sch !== "object") return;
		if (sch.$ref) {
			run(resolveRef(sch.$ref), val, p);
			return;
		}
		if (Array.isArray(sch.oneOf)) {
			const ok = sch.oneOf.some((branch) => validateSchema(branch, val, rootSchema, p).length === 0);
			if (!ok) push("oneOf matched no branch");
			return;
		}
		if (Array.isArray(sch.anyOf)) {
			const ok = sch.anyOf.some((branch) => validateSchema(branch, val, rootSchema, p).length === 0);
			if (!ok) push("anyOf matched no branch");
			return;
		}
		if (sch.const !== undefined && val !== sch.const) push(`const ${JSON.stringify(sch.const)}`);
		if (sch.enum && !sch.enum.includes(val)) push(`enum ${JSON.stringify(sch.enum)}`);
		if (sch.type) {
			const types = Array.isArray(sch.type) ? sch.type : [sch.type];
			const t =
				val === null
					? "null"
					: Array.isArray(val)
						? "array"
						: typeof val === "number" && Number.isInteger(val)
							? "integer"
							: typeof val;
			const ok = types.some((want) => {
				if (want === "integer") return typeof val === "number" && Number.isInteger(val);
				if (want === "number") return typeof val === "number";
				if (want === "object") return val !== null && typeof val === "object" && !Array.isArray(val);
				return t === want;
			});
			// integer satisfies number
			const ok2 =
				ok ||
				(types.includes("number") && typeof val === "number") ||
				(types.includes("integer") && typeof val === "number" && Number.isInteger(val));
			if (!ok2) push(`type want ${types.join("|")} got ${t}`);
		}
		if (typeof val === "string") {
			if (sch.minLength != null && val.length < sch.minLength) push(`minLength ${sch.minLength}`);
			if (sch.maxLength != null && val.length > sch.maxLength) push(`maxLength ${sch.maxLength}`);
			if (sch.pattern) {
				const re = new RegExp(sch.pattern);
				if (!re.test(val)) push(`pattern ${sch.pattern}`);
			}
		}
		if (typeof val === "number") {
			if (sch.minimum != null && val < sch.minimum) push(`minimum ${sch.minimum}`);
			if (sch.maximum != null && val > sch.maximum) push(`maximum ${sch.maximum}`);
		}
		if (Array.isArray(val)) {
			if (sch.minItems != null && val.length < sch.minItems) push(`minItems ${sch.minItems}`);
			if (sch.maxItems != null && val.length > sch.maxItems) push(`maxItems ${sch.maxItems}`);
			if (sch.items) {
				if (Array.isArray(sch.items)) {
					sch.items.forEach((itemSch, i) => run(itemSch, val[i], `${p}[${i}]`));
				} else {
					val.forEach((item, i) => run(sch.items, item, `${p}[${i}]`));
				}
			}
		}
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const req = sch.required ?? [];
			for (const key of req) {
				if (!Object.hasOwn(val, key)) push(`missing required ${key}`);
			}
			const props = sch.properties ?? {};
			for (const [key, child] of Object.entries(val)) {
				if (props[key]) run(props[key], child, `${p}.${key}`);
				else if (sch.additionalProperties === false) push(`additional property ${key}`);
				else if (sch.additionalProperties && typeof sch.additionalProperties === "object") {
					run(sch.additionalProperties, child, `${p}.${key}`);
				}
			}
		}
	};

	run(schema, data, path);
	return errors;
}

/* --------------------------------- steps ---------------------------------- */

function stepInventory(outDir) {
	if (!existsSync(cliPath)) fail("inventory", "built cli missing — run npm run build:offline", { cliPath });
	if (!existsSync(distKpi)) fail("inventory", "dist/kpi missing", { distKpi });
	const hash = sha256File(cliPath);
	writeFileSync(join(outDir, "cli.sha256"), `${hash}  ${cliPath}\n`);
	const shipped = listFiles(distKpi);
	writeFileSync(join(outDir, "dist-inventory.txt"), `${shipped.join("\n")}\n`);
	const required = ["graphs", "prompts", "schemas", "skills", "templates", "themes"];
	for (const r of required) {
		if (!existsSync(join(distKpi, r))) fail("inventory", `dist/kpi/${r} missing`);
	}
	for (const s of ["event.schema.json", "task.schema.json", "verdict.schema.json", "evidence.schema.json"]) {
		if (!existsSync(join(schemasDir, s))) fail("inventory", `schema ${s} missing`);
	}
	return { hash, shippedCount: shipped.length };
}

function stepScreenplaySchemas(outDir) {
	const sp = JSON.parse(readFileSync(screenplayPath, "utf8"));
	const payloads = sp.schema_payloads ?? [];
	if (payloads.length === 0) fail("schemas", "e0-screenplay has no schema_payloads");
	const report = [];
	for (const entry of payloads) {
		const schemaFile = join(schemasDir, entry.schema);
		if (!existsSync(schemaFile)) fail("schemas", `missing shipped schema ${entry.schema}`);
		const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
		const errors = validateSchema(schema, entry.payload, schema);
		report.push({ schema: entry.schema, ok: errors.length === 0, errors });
		if (errors.length) fail("schemas", `${entry.schema} rejected payload`, { errors });
	}
	// also validate tool-call argument objects are plain JSON (round-trip safety)
	for (const scene of sp.scenes ?? []) {
		for (const turn of scene.turns ?? []) {
			for (const tc of turn.tool_calls ?? []) {
				const args = typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments;
				if (args === null || typeof args !== "object") {
					fail("schemas", `tool ${tc.name} arguments not an object`);
				}
			}
		}
	}
	writeFileSync(join(outDir, "schema-validation.json"), `${JSON.stringify(report, null, 2)}\n`);
	return { validated: report.length };
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close((err) => (err ? reject(err) : resolvePort(port)));
		});
		s.on("error", reject);
	});
}

function startStub(port, logFile) {
	const child = spawn(process.execPath, [stubPath, "--port", String(port), "--screenplay", screenplayPath, "--log", logFile], {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	});
	return new Promise((resolveStart, reject) => {
		let buf = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("stub start timeout"));
		}, 10_000);
		child.stdout.on("data", (c) => {
			buf += c.toString("utf8");
			if (buf.includes('"ok":true') || buf.includes('"port"')) {
				clearTimeout(timer);
				try {
					const line = buf.trim().split("\n").find((l) => l.includes('"port"'));
					resolveStart({ child, info: JSON.parse(line) });
				} catch (e) {
					reject(e);
				}
			}
		});
		child.stderr.on("data", (c) => {
			buf += c.toString("utf8");
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`stub exited early code=${code} out=${buf.slice(0, 400)}`));
		});
	});
}

function pinAgentDir(agentDir, baseUrl) {
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
}

function runRpcPrompt({ env, cwd, message, modelLog, timeoutMs = 45_000 }) {
	return new Promise((resolveRpc) => {
		const child = spawn(
			process.execPath,
			[cliPath, "--offline", "--mode", "rpc", "--model", "local-openai/uat-stub"],
			{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += c.toString("utf8");
		});
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf8");
		});
		const input = [
			JSON.stringify({ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" }),
			JSON.stringify({ id: "2", type: "prompt", message }),
			"",
		].join("\n");
		child.stdin.write(input);
		// leave stdin open until settled — some builds exit on stdin end
		const started = Date.now();
		const timer = setInterval(() => {
			let hit = false;
			try {
				if (modelLog && existsSync(modelLog) && readFileSync(modelLog, "utf8").trim().length > 0) hit = true;
			} catch {
				/* ignore */
			}
			const settled = /agent_settled|"type":"response","command":"prompt"/.test(stdout);
			if (hit || settled || Date.now() - started > timeoutMs) {
				clearInterval(timer);
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
				setTimeout(() => {
					resolveRpc({
						status: child.exitCode,
						signal: child.signalCode,
						stdout,
						stderr,
						hit,
						settled,
					});
				}, 200);
			}
		}, 150);
		child.on("exit", () => {
			/* interval handles resolve */
		});
	});
}

async function stepStubRoundTrip(outDir) {
	const home = mkdtempSync(join(tmpdir(), "uat-e0-home-"));
	const agentDir = mkdtempSync(join(tmpdir(), "uat-e0-agent-"));
	const subject = mkdtempSync(join(tmpdir(), "uat-e0-subj-"));
	const modelLog = join(outDir, "model-requests.jsonl");
	writeFileSync(modelLog, "");
	writeFileSync(join(subject, "README.md"), "# E0 subject\n");
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	pinAgentDir(agentDir, baseUrl);

	const egressLog = join(outDir, "egress-roundtrip.log");
	writeFileSync(egressLog, "");
	const env = {
		...process.env,
		HOME: home,
		KPI_CODING_AGENT_DIR: agentDir,
		CI: "1",
		PI_SKIP_VERSION_CHECK: "1",
		NO_COLOR: "1",
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--require ${guardPath}`,
		UAT_EGRESS_LOG: egressLog,
	};

	const { child, info } = await startStub(port, modelLog);
	try {
		if (info.port !== port) {
			// stub may have bound requested port
		}
		const rpc = await runRpcPrompt({
			env,
			cwd: subject,
			message: "E0_SIMPLE please reply with a short acknowledgement only.",
			modelLog,
		});
		writeFileSync(join(outDir, "rpc-stdout.log"), rpc.stdout);
		writeFileSync(join(outDir, "rpc-stderr.log"), rpc.stderr);
		writeFileSync(join(outDir, "rpc-exit.txt"), String(rpc.status ?? rpc.signal ?? "null"));

		const logText = existsSync(modelLog) ? readFileSync(modelLog, "utf8") : "";
		writeFileSync(join(outDir, "model-requests.copy.jsonl"), logText);
		const lines = logText
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
		if (lines.length < 1) {
			fail("stub-roundtrip", "model-requests.jsonl empty — bundle never hit the stub", {
				rpcStatus: rpc.status,
				stderr: rpc.stderr.slice(0, 800),
				stdout: rpc.stdout.slice(0, 800),
			});
		}
		// prove no raw secrets in model log
		if (/Bearer\s+\S+/i.test(logText) || /sk-ant-|ghp_|AKIA/.test(logText)) {
			fail("stub-roundtrip", "model-requests log leaked a raw token");
		}
		return { requests: lines.length, rpcStatus: rpc.status, stubPort: port };
	} finally {
		child.kill("SIGTERM");
		try {
			rmSync(home, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(subject, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function stepEgressGuard(outDir) {
	const log = join(outDir, "egress-selftest.log");
	writeFileSync(log, "");
	const script = `
const net = require("net");
const fs = require("fs");
let blocked = false;
try {
  net.connect({ host: "example.com", port: 80 });
} catch (e) {
  blocked = e && e.code === "EUATEGRESS";
  fs.writeFileSync(${JSON.stringify(join(outDir, "egress-error.json"))}, JSON.stringify({
    code: e.code,
    message: e.message,
    egress: e.egress || null
  }, null, 2));
}
if (!blocked) {
  console.error("expected EUATEGRESS on public host");
  process.exit(2);
}
const srv = net.createServer((sock) => { sock.end("ok"); });
srv.listen(0, "127.0.0.1", () => {
  const { port } = srv.address();
  const c = net.connect({ host: "127.0.0.1", port });
  let got = "";
  c.on("data", (d) => { got += d; });
  c.on("end", () => {
    srv.close();
    if (!got.includes("ok")) {
      console.error("loopback read failed", got);
      process.exit(3);
    }
    console.log(JSON.stringify({ ok: true, loopback: true, port, blocked: true }));
  });
  c.on("error", (e) => {
    // ECONNRESET after end is fine if we already got data
    if (got.includes("ok")) {
      srv.close();
      console.log(JSON.stringify({ ok: true, loopback: true, port, blocked: true, note: e.code }));
      return;
    }
    console.error(e);
    process.exit(3);
  });
});
`;
	const probe = join(outDir, "egress-probe.cjs");
	writeFileSync(probe, script);
	const result = spawnSync(process.execPath, [probe], {
		env: {
			...process.env,
			NODE_OPTIONS: `--require ${guardPath}`,
			UAT_EGRESS_LOG: log,
		},
		encoding: "utf8",
		timeout: 10_000,
	});
	writeFileSync(join(outDir, "egress-probe-stdout.log"), result.stdout ?? "");
	writeFileSync(join(outDir, "egress-probe-stderr.log"), result.stderr ?? "");
	if (result.status !== 0) {
		fail("egress", "guard self-test failed", {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
		});
	}
	const logText = readFileSync(log, "utf8");
	if (!logText.includes("example.com")) {
		fail("egress", "egress log missing blocked host", { logText });
	}
	return { ok: true, logBytes: logText.length };
}

function stepPty(outDir) {
	const ptyOut = join(outDir, "pty");
	mkdirSync(ptyOut, { recursive: true });
	// First: harness self-test (truecolor)
	const st = spawnSync("python3", [ptyPath, "--self-test"], {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: 15_000,
	});
	writeFileSync(join(outDir, "pty-selftest.log"), `${st.stdout}\n${st.stderr}`);
	if (st.status !== 0) fail("pty", "pty_drive --self-test failed", { stdout: st.stdout, stderr: st.stderr });

	// Second: exercise built binary under PTY at fixed width (version banner)
	const home = mkdtempSync(join(tmpdir(), "uat-e0-pty-home-"));
	const agentDir = mkdtempSync(join(tmpdir(), "uat-e0-pty-agent-"));
	const subject = mkdtempSync(join(tmpdir(), "uat-e0-pty-subj-"));
	try {
		const script = JSON.stringify([
			{ expect: String.raw`0\.\d|kpi|K-`, send: "\u0003", timeout: 12 },
		]);
		const env = {
			...process.env,
			HOME: home,
			KPI_CODING_AGENT_DIR: agentDir,
			CI: "1",
			PI_SKIP_VERSION_CHECK: "1",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			FORCE_COLOR: "3",
			NODE_OPTIONS: `--require ${guardPath}`,
			UAT_EGRESS_LOG: join(outDir, "egress-pty.log"),
		};
		// clear any inherited NO_COLOR for the python child env file via python -- 
		const result = spawnSync(
			"python3",
			[
				ptyPath,
				"--cols",
				"100",
				"--rows",
				"30",
				"--out-dir",
				ptyOut,
				"--timeout",
				"20",
				"--script",
				script,
				"--",
				process.execPath,
				cliPath,
				"--version",
			],
			{ cwd: subject, env, encoding: "utf8", timeout: 30_000 },
		);
		writeFileSync(join(outDir, "pty-bundle.log"), `${result.stdout}\n${result.stderr}`);
		const rawPath = join(ptyOut, "frame.raw");
		const txtPath = join(ptyOut, "frame.txt");
		if (!existsSync(rawPath) || !existsSync(txtPath)) {
			fail("pty", "bundle PTY did not write frames", {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
			});
		}
		const txt = readFileSync(txtPath, "utf8");
		if (!/0\.1\.0|kpi/i.test(txt) && result.status !== 0 && !txt.trim()) {
			// version may print and exit before expect; accept non-empty frame from --version
			fail("pty", "bundle PTY frame empty", { txt, status: result.status });
		}
		// record winsize claim
		writeFileSync(
			join(outDir, "pty-width.json"),
			`${JSON.stringify({ cols: 100, rows: 30, frame_bytes: statSync(rawPath).size, text_sample: txt.slice(0, 200) }, null, 2)}\n`,
		);
		return { ok: true, frameBytes: statSync(rawPath).size };
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(subject, { recursive: true, force: true });
	}
}

function stepCanaries(outDir) {
	const fixture = join(outDir, "canary-subject");
	mkdirSync(fixture, { recursive: true });
	const planted = [];
	for (const c of CANARIES) {
		const name = `canary-${createHash("sha256").update(c).digest("hex").slice(0, 8)}.txt`;
		writeFileSync(join(fixture, name), `${c}\n`);
		planted.push(name);
	}
	writeFileSync(
		join(outDir, "session-prompt-canaries.txt"),
		`Prompt must not echo: ${CANARIES.join(" | ")}\n`,
	);
	writeFileSync(join(outDir, "canaries-planted.json"), `${JSON.stringify({ canaries: CANARIES, files: planted }, null, 2)}\n`);
	return { planted: planted.length };
}

function stepForbiddenScan(outDir) {
	const scan = scanHarness(here);
	writeFileSync(join(outDir, "harness-scan.json"), `${JSON.stringify(scan, null, 2)}\n`);
	if (!scan.ok) fail("forbidden-import", "harness imports product src or runs node --test", scan);
	return scan;
}

function stepComponentSelfTests(outDir) {
	const results = {};
	for (const [name, args] of [
		["stub", [stubPath, "--self-test"]],
		["grade", [join(here, "grade.mjs"), "--self-test"]],
	]) {
		const r = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
		results[name] = { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
		writeFileSync(join(outDir, `selftest-${name}.log`), `${r.stdout}\n${r.stderr}`);
		if (r.status !== 0) fail("selftest", `${name} --self-test failed`, results[name]);
	}
	return results;
}

async function main() {
	const args = process.argv.slice(2);
	let outDir = join(repoRoot, ".kpi/uat/E0");
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out") outDir = resolve(args[++i]);
	}
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "head.txt"), spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout);

	const summary = { ok: false, steps: {}, at: new Date().toISOString(), outDir };

	try {
		summary.steps.inventory = stepInventory(outDir);
		summary.steps.schemas = stepScreenplaySchemas(outDir);
		summary.steps.selftests = stepComponentSelfTests(outDir);
		summary.steps.egress = stepEgressGuard(outDir);
		summary.steps.pty = stepPty(outDir);
		summary.steps.canaries = stepCanaries(outDir);
		summary.steps.forbidden = stepForbiddenScan(outDir);
		summary.steps.stubRoundTrip = await stepStubRoundTrip(outDir);

		// grade the E0 evidence directory itself
		const grade = writeGrade(outDir, [
			{ id: "cli-hash", artifact: "cli.sha256", locator: "re:[a-f0-9]{64}" },
			{ id: "inventory", artifact: "dist-inventory.txt", contains: "schemas/task.schema.json" },
			{ id: "schema-validation", artifact: "schema-validation.json", contains: "\"ok\": true" },
			{ id: "model-log", artifact: "model-requests.jsonl", locator: "re:prompt_sha256" },
			{ id: "egress-log", artifact: "egress-selftest.log", contains: "example.com" },
			{ id: "pty-frame", artifact: "pty/frame.raw" },
			{ id: "harness-scan", artifact: "harness-scan.json", contains: "\"ok\": true" },
			{ id: "canaries", artifact: "canaries-planted.json", contains: "KPI_PROOF_TOKEN_7f3a9c" },
		]);
		summary.grade = grade.result;
		if (!grade.result.ok) fail("grade", "E0 evidence grade failed", grade.result);

		summary.ok = true;
		writeFileSync(join(outDir, "E0-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
		writeFileSync(
			join(outDir, "notes.md"),
			[
				"# E0 preflight",
				"",
				"Clean HOME + KPI_CODING_AGENT_DIR. Subject under test: built `packages/coding-agent/dist/bundle/cli.js`.",
				`CLI sha256: ${summary.steps.inventory.hash}`,
				`Stub requests logged: ${summary.steps.stubRoundTrip.requests}`,
				"Egress guard blocked example.com; loopback still works.",
				"PTY self-test captured truecolor SGR; bundle --version framed at 100×30.",
				"Harness scan: no packages/<pkg>/src imports, no node --test.",
				"",
			].join("\n"),
		);
		process.stdout.write(`E0 preflight: ok\n${JSON.stringify(summary, null, 2)}\n`);
		process.exitCode = 0;
	} catch (error) {
		summary.ok = false;
		summary.error = error instanceof Error ? error.message : String(error);
		summary.detail = error && typeof error === "object" && "detail" in error ? error.detail : undefined;
		summary.step = error && typeof error === "object" && "step" in error ? error.step : undefined;
		writeFileSync(join(outDir, "E0-result.json"), `${JSON.stringify(summary, null, 2)}\n`);
		process.stderr.write(`E0 preflight: FAIL ${summary.error}\n`);
		if (summary.detail) process.stderr.write(`${JSON.stringify(summary.detail, null, 2)}\n`);
		process.exitCode = 1;
	}
}

main();
