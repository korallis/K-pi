/**
 * PTY row harness for UAT-06, UAT-15, UAT-16, UAT-25.
 *
 * Every verdict here is decided from `frame.raw` - the bytes the product wrote
 * to a real terminal - so a row can only pass if the operator would actually
 * have seen the thing. No product renderer is imported: `renderBoard` and
 * `assembleFooter` are exactly the functions under test, and calling them would
 * prove only that they still return what they return.
 *
 * `uat/pty_drive.py`, `uat/stub-model.mjs` and `uat/egress-guard.cjs` are inputs
 * owned by the UAT workstream and are read and invoked, never modified.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
export const cliPath = join(repoRoot, "packages/coding-agent/dist/bundle/cli.js");
const driverPath = join(repoRoot, "uat/pty_drive.py");
const stubPath = join(repoRoot, "uat/stub-model.mjs");
const guardPath = join(repoRoot, "uat/egress-guard.cjs");

/** Local model context window, from `localModel()` - the divisor for every context percentage. */
export const LOCAL_CONTEXT_WINDOW = 32_768;

export function freePort() {
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

/**
 * SGR truecolor introducer for a hex colour, as the bytes a terminal receives.
 *
 * Grading on this string is what makes "amber while running" a claim about the
 * wire rather than about a theme file: a renderer that resolved the wrong theme,
 * or dropped colour entirely, cannot produce these bytes.
 */
export function fgTruecolor(hex) {
	const value = hex.replace("#", "");
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m`;
}

export const AMBER = "#ff6a1a";
export const PROTOCOL_BLUE = "#3da9fc";
/** loop-amber theme vars, which is where the four context colours resolve from. */
export const THEME_SUCCESS = "#3dff6a";
export const THEME_WARNING = "#ffb020";
export const THEME_ERROR = "#ff3b3b";

/**
 * A literal cell as it appears inside `frame.raw`.
 *
 * `frame.raw` is read as latin1 so every byte survives, which means a
 * multi-byte glyph like `▦` or `π` is several latin1 characters. Grading has to
 * search for those bytes, not for the decoded character, or an assertion about
 * a visible cell silently never matches and the row passes for the wrong
 * reason.
 */
export function bytesOf(text) {
	return Buffer.from(text, "utf8").toString("latin1");
}

export function startStub(port, logFile, screenplayPath) {
	return new Promise((resolveStub, reject) => {
		const args = [stubPath, "--port", String(port), "--log", logFile];
		if (screenplayPath) args.push("--screenplay", screenplayPath);
		const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const onData = (chunk) => {
			out += String(chunk);
			if (/listening|ready/i.test(out)) resolveStub(child);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", reject);
		setTimeout(() => resolveStub(child), 1200);
	});
}

/**
 * A clean HOME, a scratch git repository, and a provider that only resolves to
 * loopback. `egress-guard.cjs` is preloaded so a row cannot pass by quietly
 * reaching a real provider.
 */
export function sandbox(label, { baseUrl, port, contextModel = "uat-stub" } = {}) {
	const home = mkdtempSync(join(tmpdir(), `kpi-pty-${label}-`));
	const project = join(home, "proj");
	const agentDir = join(home, ".kpi", "agent");
	const egressLog = join(home, "egress.log");
	mkdirSync(project, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
	git("init", "-q", ".");
	git("config", "user.email", "pty@local");
	git("config", "user.name", "pty");
	git("checkout", "-q", "-b", "main");
	writeFileSync(join(project, "README.md"), "# scratch\n");
	git("add", "-A");
	git("commit", "-q", "-m", "chore: scratch");

	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: "local-openai", defaultModel: contextModel }, null, 2)}\n`,
	);
	writeFileSync(
		join(agentDir, "local-openai-models.json"),
		`${JSON.stringify([{ id: contextModel, name: contextModel, baseUrl }], null, 2)}\n`,
	);
	// A local pool with one slot pinned to the stub's origin. Without a slot the
	// accounts layer has nothing to select, the model never registers, and the
	// footer reports `unknown` - which would make every footer assertion vacuous.
	writeFileSync(
		join(agentDir, "accounts.json"),
		`${JSON.stringify(
			{
				version: 1,
				pools: {
					"local-openai": { strategy: "round-robin", slots: [{ id: "a", kind: "local", label: "a", baseUrl }] },
				},
				fallback: ["local-openai"],
				stickiness: "session-until-exhausted",
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify({ "local-openai": { type: "api_key", key: "pty-local-no-op" } }, null, 2)}\n`,
	);

	const env = {
		HOME: home,
		KPI_CODING_AGENT_DIR: agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		CI: "",
		UAT_EGRESS_LOG: egressLog,
		NODE_OPTIONS: `--require ${guardPath}`,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		FORCE_COLOR: "3",
	};

	return { home, project, agentDir, egressLog, env };
}

/**
 * Seeds one run directory.
 *
 * The board is documented as a pure render from run-owned state, so seeding that
 * state and asking the product to draw is the product's own path - and it is the
 * only way to reach `/kpi status` "with the provider unreachable", which is what
 * the row asks for.
 */
export function seedRun(project, jobId, { state, task, files = {}, active = true }) {
	const runDirectory = join(project, ".kpi", "runs", jobId);
	mkdirSync(runDirectory, { recursive: true });
	writeFileSync(join(runDirectory, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
	writeFileSync(join(runDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
	writeFileSync(join(runDirectory, "context.md"), "scratch context\n");
	for (const [name, contents] of Object.entries(files)) {
		if (contents === null) continue;
		writeFileSync(join(runDirectory, name), contents);
	}
	if (active) {
		writeFileSync(join(project, ".kpi", "active-job"), `${jobId}\n`);
	}
	return runDirectory;
}

/** Drives the real TUI over a PTY and returns the bytes it painted. */
export function drive({ env, cwd, cols, rows = 40, script, outDir, timeout = 90, args: cliArgs = [] }) {
	mkdirSync(outDir, { recursive: true });
	const args = [
		driverPath,
		"--cols",
		String(cols),
		"--rows",
		String(rows),
		"--out-dir",
		outDir,
		"--timeout",
		String(timeout),
		"--script",
		JSON.stringify(script),
		"--cwd",
		cwd,
		"--",
		process.execPath,
		cliPath,
		...cliArgs,
	];
	const child = spawn("python3", args, {
		env: { ...process.env, ...env, COLUMNS: String(cols), LINES: String(rows) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolveDrive) => {
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c) => {
			stdout += String(c);
		});
		child.stderr.on("data", (c) => {
			stderr += String(c);
		});
		child.on("close", () => {
			const rawPath = join(outDir, "frame.raw");
			const raw = existsSync(rawPath) ? readFileSync(rawPath, "latin1") : "";
			const txtPath = join(outDir, "frame.txt");
			const text = existsSync(txtPath) ? readFileSync(txtPath, "utf8") : "";
			let meta = {};
			const metaPath = join(outDir, "pty-result.json");
			if (existsSync(metaPath)) {
				try {
					meta = JSON.parse(readFileSync(metaPath, "utf8"));
				} catch {
					meta = {};
				}
			}
			resolveDrive({ raw, text, meta, stdout, stderr });
		});
	});
}

export function egressClean(box) {
	if (!existsSync(box.egressLog)) return { clean: true, text: "" };
	const text = readFileSync(box.egressLog, "utf8");
	return { clean: text.trim().length === 0, text };
}

export function check(id, evidence, ok, observed) {
	return { id, evidence, ok: Boolean(ok), observed: String(observed) };
}

/** A row's verdict plus its notes, written beside the frames it was decided from. */
export function writeRow(outDir, row, { checks, notes }) {
	mkdirSync(outDir, { recursive: true });
	const failed = checks.filter((c) => !c.ok);
	const verdict = { row, pass: failed.length === 0, checks };
	writeFileSync(join(outDir, "result.json"), `${JSON.stringify(verdict, null, 2)}\n`);
	const lines = [
		`# ${row}`,
		"",
		notes.trim(),
		"",
		"## Checks",
		"",
		...checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} \`${c.id}\` (${c.evidence}) — ${c.observed}`),
	];
	writeFileSync(join(outDir, "notes.md"), `${lines.join("\n")}\n`);
	return verdict;
}

export function sha256(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function teardown(box, stub) {
	try {
		stub?.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	try {
		rmSync(box.home, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
