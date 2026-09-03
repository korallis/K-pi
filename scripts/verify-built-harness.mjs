#!/usr/bin/env node

/**
 * RP-19 built-harness smoke.
 *
 * Subject under test: packages/coding-agent/dist/bundle/cli.js from this repo.
 * No install step, no trust decision, temporary HOME + KPI_CODING_AGENT_DIR.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
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
const distKpi = join(repoRoot, "packages/coding-agent/dist/kpi");

const CANARIES = ["KPI_PROOF_TOKEN_7f3a9c", "Set-Cookie: session=proof-canary"];

function fail(message, detail) {
	const err = new Error(message);
	err.detail = detail;
	throw err;
}

function listFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, name.name);
			if (name.isDirectory()) walk(path);
			else out.push(relative(root, path).replaceAll("\\", "/"));
		}
	};
	if (existsSync(root)) walk(root);
	return out.sort();
}

function assertInventory() {
	if (!existsSync(cliPath)) {
		fail("built cli missing — run npm run build:offline first", { cliPath });
	}
	if (!existsSync(distKpi)) {
		fail("dist/kpi missing — build did not copy K-π resources", { distKpi });
	}
	const requiredRoots = ["graphs", "prompts", "schemas", "skills", "templates", "themes"];
	for (const root of requiredRoots) {
		const path = join(distKpi, root);
		if (!existsSync(path) || !statSync(path).isDirectory()) {
			fail(`dist/kpi/${root} missing`, { path });
		}
	}
	const kstack = join(distKpi, "kstack");
	for (const name of ["provenance.json", "UPSTREAM.md", "generated/LICENSE"]) {
		const path = join(kstack, name);
		if (!existsSync(path)) fail(`dist/kpi/kstack/${name} missing`, { path });
	}
	if (!existsSync(join(kstack, "generated/skills"))) {
		fail("dist/kpi/kstack/generated/skills missing");
	}
	if (existsSync(join(kstack, "scripts"))) {
		fail("dist/kpi/kstack/scripts must not ship (build input)");
	}
	const shipped = listFiles(distKpi);
	const forbidden = shipped.filter(
		(p) =>
			/(^|\/)(fixtures|test|tests|__tests__|\.rej$|transaction|accounts\.secrets)/i.test(p) ||
			/\.(env|pem|key)$/i.test(p),
	);
	if (forbidden.length > 0) {
		fail("forbidden paths in dist/kpi", { forbidden: forbidden.slice(0, 20) });
	}
	return { shippedCount: shipped.length, requiredRoots };
}

function runCli(args, env, cwd, input = null, timeoutMs = 15_000) {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		env,
		input: input ?? undefined,
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
	});
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error ? String(result.error) : undefined,
	};
}

function assertNoDiagnostics(label, combined) {
	const bad = [
		/Failed to load skill/i,
		/Skill warning/i,
		/(?<![a-zA-Z0-9_-])pi install\b/i,
		/trust this project/i,
		/keywords:\s*\[\s*["']pi-package["']/i,
	];
	for (const re of bad) {
		if (re.test(combined)) {
			fail(`${label}: forbidden diagnostic matched ${re}`, { excerpt: combined.slice(0, 800) });
		}
	}
	for (const canary of CANARIES) {
		if (combined.includes(canary)) {
			fail(`${label}: canary leaked into output`, { canary });
		}
	}
}

function assertVersion(env, scratch) {
	const result = runCli(["--version"], env, scratch);
	if (result.status !== 0) fail("cli --version failed", result);
	const text = `${result.stdout}\n${result.stderr}`.trim();
	if (!/\b0\.3\.0\b/.test(text)) {
		fail("cli --version must report fork version 0.3.0", { text });
	}
	assertNoDiagnostics("version", text);
	return text.split("\n")[0]?.trim() ?? text;
}

function assertHelp(env, scratch) {
	const result = runCli(["--help"], env, scratch);
	if (result.status !== 0) fail("cli --help failed", result);
	const text = `${result.stdout}\n${result.stderr}`;
	if (!/\bkpi\b/i.test(text)) fail("help must mention kpi", { text: text.slice(0, 400) });
	assertNoDiagnostics("help", text);
	return true;
}

function assertRpcOffline(env, scratch) {
	const result = runCli(["--mode", "rpc"], env, scratch, "\n", 8_000);
	const combined = `${result.stdout}\n${result.stderr}`;
	assertNoDiagnostics("rpc", combined);
	return {
		status: result.status,
		hadExtensionUi: /extension_ui_request/.test(combined),
		bytes: combined.length,
	};
}

function assertPackageIdentity() {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
	const bins = Object.keys(pkg.bin ?? {}).sort();
	if (JSON.stringify(bins) !== JSON.stringify(["k-pi", "kpi"])) {
		fail("coding-agent bins must be exactly kpi and k-pi", { bins });
	}
	if (pkg.bin?.pi) fail("pi bin must not exist");
	const piConfig = pkg.piConfig ?? {};
	if (piConfig.name !== "kpi" || piConfig.title !== "K-π" || piConfig.configDir !== ".kpi") {
		fail("piConfig must be kpi / K-π / .kpi", { piConfig });
	}
	if (pkg.keywords?.includes("pi-package")) fail("keywords must not include pi-package");
	if (pkg.pi) fail("package.json#pi manifest must not exist");
	const peers = Object.keys(pkg.peerDependencies ?? {});
	if (peers.some((p) => p.startsWith("@earendil-works/pi-"))) {
		fail("must not peer-depend on @earendil-works/pi-*", { peers });
	}
	return { bins, piConfig };
}

function main() {
	const jsonOut = process.argv.includes("--json");
	const home = mkdtempSync(join(tmpdir(), "kpi-proof-home-"));
	const agentDir = mkdtempSync(join(tmpdir(), "kpi-proof-agent-"));
	const scratch = mkdtempSync(join(tmpdir(), "kpi-proof-scratch-"));
	const summary = {
		ok: false,
		cliPath: relative(repoRoot, cliPath),
	};
	try {
		writeFileSync(join(scratch, "README.md"), "# scratch\n");
		const env = {
			...process.env,
			HOME: home,
			KPI_CODING_AGENT_DIR: agentDir,
			CI: "1",
			PI_SKIP_VERSION_CHECK: "1",
			NO_COLOR: "1",
		};
		summary.inventory = assertInventory();
		summary.package = assertPackageIdentity();
		summary.version = assertVersion(env, scratch);
		summary.help = assertHelp(env, scratch);
		summary.rpc = assertRpcOffline(env, scratch);
		summary.ok = true;
		if (jsonOut) {
			process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		} else {
			process.stdout.write(
				`verify-built-harness: ok version=${summary.version} shipped=${summary.inventory.shippedCount} rpc_ui=${summary.rpc.hadExtensionUi}\n`,
			);
		}
		process.exitCode = 0;
	} catch (error) {
		summary.ok = false;
		summary.error = error instanceof Error ? error.message : String(error);
		if (error && typeof error === "object" && "detail" in error) {
			summary.detail = error.detail;
		}
		if (jsonOut) {
			process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		} else {
			process.stderr.write(`verify-built-harness: FAIL ${summary.error}\n`);
			if (summary.detail) {
				process.stderr.write(`${JSON.stringify(summary.detail, null, 2)}\n`);
			}
		}
		process.exitCode = 1;
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
}

main();
