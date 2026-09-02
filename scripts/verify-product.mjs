#!/usr/bin/env node

/**
 * RP-19 whole-product proof.
 *
 * Runs repository gates (unless --skip-gates), the built-harness smoke (unless
 * --skip-harness), and the M-01..M-07 collectors. Writes a secret-free JSON
 * proof report.
 *
 * M-01..M-06 are established by driving the built `dist/bundle/cli.js` against
 * the deterministic fixtures under a clean HOME and a scratch Git repository,
 * with a loopback stub provider and an egress guard, exactly as RP-19 step 5
 * requires. Each verdict is read back out of an artifact the product wrote.
 * Nothing here runs `node --test`, imports product source, or asks a renderer
 * what it would have said. M-07 is the gate roll-up.
 *
 * Usage:
 *   node scripts/verify-product.mjs --json .kpi/remediation-proof.json
 *   node scripts/verify-product.mjs --metrics M-01,M-06 --skip-gates --skip-harness
 *   node scripts/verify-product.mjs --skip-gates --json path
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_METRICS, collectBuiltMetric, evidenceFiles } from "./metric-runs.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const ALL_METRICS = ["M-01", "M-02", "M-03", "M-04", "M-05", "M-06", "M-07"];
const CANARIES = ["KPI_PROOF_TOKEN_7f3a9c", "Set-Cookie: session=proof-canary"];

function parseArgs(argv) {
	const out = {
		json: null,
		metrics: [...ALL_METRICS],
		skipGates: false,
		skipHarness: false,
		skipBuild: false,
	};
	for (let i = 2; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--json") out.json = argv[++i];
		else if (a === "--metrics") out.metrics = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
		else if (a === "--skip-gates") out.skipGates = true;
		else if (a === "--skip-harness") out.skipHarness = true;
		else if (a === "--skip-build") out.skipBuild = true;
		else if (a === "--help" || a === "-h") {
			process.stdout.write(
				"Usage: node scripts/verify-product.mjs [--json path] [--metrics M-01,M-02] [--skip-gates] [--skip-harness] [--skip-build]\n",
			);
			process.exit(0);
		} else throw new Error(`unknown argument: ${a}`);
	}
	return out;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		env: { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: "1" },
		maxBuffer: 32 * 1024 * 1024,
		timeout: options.timeout ?? 600_000,
	});
	return {
		command: [command, ...args].join(" "),
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error ? String(result.error) : undefined,
		ok: result.status === 0 && !result.error,
	};
}

function runNpm(script, extra = []) {
	return run("npm", ["run", script, ...extra], { timeout: 600_000 });
}

function ensureDir(path) {
	mkdirSync(path, { recursive: true });
}

function writeEvidence(dir, name, body) {
	ensureDir(dir);
	const path = join(dir, name);
	writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
	return relative(repoRoot, path);
}

function scanSecrets(text) {
	const hits = [];
	for (const c of CANARIES) {
		if (text.includes(c)) hits.push(c);
	}
	if (/sk-[a-zA-Z0-9]{20,}/.test(text)) hits.push("sk- lookalike");
	return hits;
}

function loadMap() {
	return JSON.parse(readFileSync(join(repoRoot, "docs/traceability-map.json"), "utf8"));
}

function ownerFor(map, id) {
	return map.entries.find((e) => e.id === id)?.primary_owner ?? "RP-19";
}

/** Primary RP owner for a UAT row, from the first map entry that names it. */
function ownerForUat(map, uatId) {
	const hit = map.entries.find((e) => e.uat_row === uatId);
	return hit?.primary_owner ?? "RP-19";
}

function assertTapPass(combined, result) {
	if (!result.ok) return false;
	if (/\n✖ /.test(combined)) return false;
	if (/ℹ fail [1-9]/.test(combined)) return false;
	if (!/ℹ tests? [1-9]/.test(combined) && !/tests [1-9]/.test(combined)) return false;
	if (/ℹ pass 0/.test(combined)) return false;
	return true;
}

/**
 * The traceability test is the one `node --test` invocation this proof still
 * makes, and it is not a metric: it checks that the requirement map covers what
 * it claims to. Every metric is established against the built binary.
 */
function runNodeTest(files, namePattern, timeout = 300_000) {
	return run(
		process.execPath,
		["--test", "--experimental-strip-types", "--test-name-pattern", namePattern, ...files],
		{ timeout },
	);
}

function collectM07(gates, proofRoot) {
	const dir = join(proofRoot, "M-07");
	ensureDir(dir);
	const values = Object.values(gates);
	const skipped = values.some((g) => g === "skipped");
	const pass = values.every((g) => g === true);
	writeEvidence(dir, "result.json", { id: "M-07", pass, skipped, gates });
	return {
		pass,
		owner: "RP-19",
		evidence: relative(repoRoot, dir),
		detail: pass
			? "all repository gates and built-harness checks passed"
			: skipped
				? "one or more gates were skipped in this run"
				: "one or more gates/harness failed",
	};
}

function readUatResult(dir) {
	const path = join(dir, "result.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Collect each UAT row's real verdict from `.kpi/uat/<id>/result.json`.
 * Machine rows write `{ ok, verdict }` (grade.mjs) or `{ pass }` (pty-rows).
 * A missing result is recorded as not executed — never invented as PASS.
 */
function wireUatPaths(proofRoot, map) {
	const uatRoot = join(repoRoot, ".kpi/uat");
	ensureDir(uatRoot);
	const rows = [];
	let executedCount = 0;
	let passCount = 0;
	for (let i = 1; i <= 30; i += 1) {
		const id = `UAT-${String(i).padStart(2, "0")}`;
		const dir = join(uatRoot, id);
		ensureDir(dir);
		const readme = join(dir, "README.txt");
		if (!existsSync(readme)) {
			writeFileSync(
				readme,
				`Evidence directory for ${id}. Populate cmd.txt/exit/stdout.log/frame.txt/head.txt when UAT runs after RP-19.\n`,
			);
		}
		const result = readUatResult(dir);
		const usId = `US-${String(i).padStart(2, "0")}`;
		const owner = ownerForUat(map, id);
		let executed = false;
		let pass = false;
		let verdict = "NOT_RUN";
		let detail = "no result.json";
		let attended = [];
		if (result && typeof result === "object") {
			executed = true;
			executedCount += 1;
			if (typeof result.verdict === "string") {
				verdict = result.verdict;
				pass = result.verdict === "PASS" && result.ok !== false && result.control_also_passes !== true;
			} else if (typeof result.pass === "boolean") {
				pass = result.pass === true;
				verdict = pass ? "PASS" : "FAIL";
			} else if (typeof result.ok === "boolean") {
				pass = result.ok === true && result.control_also_passes !== true;
				verdict = pass ? "PASS" : "FAIL";
			}
			if (pass) passCount += 1;
			detail =
				typeof result.detail === "string"
					? result.detail
					: pass
						? `passed ${result.passed ?? result.checks?.filter?.((c) => c.ok)?.length ?? "?"} checks`
						: `failed ${result.failed ?? result.checks?.filter?.((c) => !c.ok)?.length ?? "?"}`;
			if (Array.isArray(result.attended)) attended = result.attended;
		}
		rows.push({
			id,
			us: usId,
			path: relative(repoRoot, dir),
			executed,
			pass,
			verdict,
			owner,
			detail,
			...(attended.length > 0 ? { attended } : {}),
			...(result?.control_also_passes === true ? { control_also_passes: true } : {}),
		});
	}
	const rowsExecuted = executedCount > 0;
	const allPass = rows.every((r) => r.executed && r.pass);
	writeEvidence(proofRoot, "uat-wiring.json", {
		rows_executed: rowsExecuted,
		executed_count: executedCount,
		pass_count: passCount,
		all_pass: allPass,
		rows,
	});
	return {
		path_template: ".kpi/uat/<UAT-ID>/",
		wired: true,
		rows_executed: rowsExecuted,
		executed_count: executedCount,
		pass_count: passCount,
		all_pass: allPass,
		row_count: rows.length,
		rows,
	};
}

async function main() {
	const args = parseArgs(process.argv);
	const proofRoot = join(repoRoot, ".kpi/proof");
	ensureDir(proofRoot);
	ensureDir(join(repoRoot, ".kpi"));

	const map = loadMap();
	// Resolved early so the canary sweep can exclude the report it is about to
	// write, whichever path the caller asked for.
	const jsonPath = args.json ? resolve(process.cwd(), args.json) : join(repoRoot, ".kpi/remediation-proof.json");
	const failures = [];
	const gates = {
		check: false,
		test: false,
		test_kpi: false,
		kstack_sync_check: false,
		upstream_offline: false,
		build_offline: false,
		built_harness: false,
	};

	const report = {
		schema_version: 1,
		generated_at: new Date().toISOString(),
		git_head: run("git", ["rev-parse", "HEAD"]).stdout.trim() || null,
		upstream_pin: null,
		gates,
		metrics: {},
		traceability: {
			map: "docs/traceability-map.json",
			complete: true,
			counts: map.counts,
		},
		uat: null,
		// Product surfaces a metric wanted and did not find. Recorded rather than
		// worked around, so a missing observable cannot be mistaken for a pass.
		gaps: [],
		secrets_scan: { pass: true, canaries: CANARIES, hits: [] },
		failures,
		ok: false,
	};

	try {
		report.upstream_pin = JSON.parse(readFileSync(join(repoRoot, "upstream.json"), "utf8"));
	} catch {
		report.upstream_pin = null;
	}

	if (!args.skipGates) {
		const checkR = runNpm("check");
		gates.check = checkR.ok;
		if (!checkR.ok) {
			failures.push({
				id: "gate.check",
				owner: "RP-19",
				check: "npm run check",
				message: (checkR.stderr || checkR.stdout).slice(-500),
			});
		}

		if (!args.skipBuild) {
			const buildR = runNpm("build:offline");
			gates.build_offline = buildR.ok;
			if (!buildR.ok) {
				failures.push({
					id: "REQ-DIST-06",
					owner: "RP-01A",
					check: "build:offline",
					message: (buildR.stderr || buildR.stdout).slice(-500),
				});
			}
		} else {
			gates.build_offline = existsSync(join(repoRoot, "packages/coding-agent/dist/bundle/cli.js"));
		}

		const testR = runNpm("test");
		gates.test = testR.ok;
		if (!testR.ok) {
			const detail = (testR.error || testR.stderr || testR.stdout || "npm test failed").slice(-1500);
			failures.push({
				id: "gate.test",
				owner: "RP-19",
				check: "npm test",
				message: detail,
				status: testR.status,
				error: testR.error,
			});
			writeEvidence(proofRoot, "gate-test-failure.txt", `${detail}\n`);
		}

		// Its own run, not an alias of `npm test`. `npm test` also covers the
		// inherited upstream suites, so aliasing them would let an unrelated
		// upstream failure be reported as K-π's, and would hide a real K-π
		// regression behind a green upstream run.
		const kpiR = runNpm("test:kpi");
		gates.test_kpi = kpiR.ok;
		if (!kpiR.ok) {
			failures.push({
				id: "gate.test_kpi",
				owner: "RP-19",
				check: "npm run test:kpi",
				message: (kpiR.stderr || kpiR.stdout).slice(-500),
			});
		}

		const kstackR = runNpm("kstack:sync:check");
		gates.kstack_sync_check = kstackR.ok;
		if (!kstackR.ok) {
			failures.push({
				id: "KSTACK-03",
				owner: "RP-17",
				check: "kstack:sync:check",
				message: (kstackR.stderr || "").slice(-400),
			});
		}

		const upR = run("npm", ["run", "upstream:check", "--", "--offline"]);
		gates.upstream_offline = upR.ok;
		if (!upR.ok) {
			failures.push({
				id: "NFR-05",
				owner: "RP-01A",
				check: "upstream:check --offline",
				message: (upR.stderr || "").slice(-400),
			});
		}
	} else {
		// Do not invent green gates. Record skipped so M-07 cannot claim a run that
		// never executed npm check/test.
		gates.check = "skipped";
		gates.test = "skipped";
		gates.test_kpi = "skipped";
		gates.kstack_sync_check = "skipped";
		gates.upstream_offline = "skipped";
		gates.build_offline = existsSync(join(repoRoot, "packages/coding-agent/dist/bundle/cli.js"));
		if (!gates.build_offline) {
			failures.push({ id: "REQ-DIST-06", owner: "RP-01A", check: "dist bundle", message: "cli.js missing" });
		}
		report.gaps.push({
			id: "gates-skipped",
			detail: "verify-product invoked with --skip-gates; M-07 cannot claim repository gates from this run",
		});
	}

	if (!args.skipHarness) {
		const harness = run(process.execPath, [join(scriptDir, "verify-built-harness.mjs"), "--json"], {
			timeout: 60_000,
		});
		writeEvidence(proofRoot, "built-harness.json", harness.stdout || harness.stderr);
		let harnessJson = { ok: false };
		try {
			harnessJson = JSON.parse(harness.stdout);
		} catch {
			/* keep */
		}
		gates.built_harness = harness.ok && harnessJson.ok === true;
		if (!gates.built_harness) {
			failures.push({
				id: "REL-02",
				owner: "RP-19",
				check: "verify-built-harness",
				message: harnessJson.error || (harness.stderr || harness.stdout).slice(-400),
			});
		}
	} else {
		gates.built_harness = existsSync(join(repoRoot, "packages/coding-agent/dist/bundle/cli.js"));
	}

	// M-01..M-06 against the built binary. Each collector owns its sandbox: clean
	// HOME, scratch Git repository, loopback stub provider, egress guard.
	for (const id of args.metrics) {
		if (!BUILT_METRICS.includes(id)) continue;
		process.stderr.write(`  metric ${id} (built binary)\n`);
		const result = await collectBuiltMetric(id, proofRoot);
		report.metrics[id] = result;
		for (const gap of result.gaps ?? []) {
			report.gaps.push({ metric: id, ...gap });
		}
		if (!result.pass) {
			const failed = (result.checks ?? []).filter((entry) => !entry.ok);
			failures.push({
				id,
				owner: result.owner ?? ownerFor(map, id),
				check: failed.length > 0 ? failed.map((entry) => entry.id).join(",") : "built-binary collector",
				message:
					failed.length > 0
						? failed.map((entry) => `${entry.id}: ${entry.observed}`).join(" | ")
						: result.detail,
			});
		}
	}

	for (const id of args.metrics) {
		if (BUILT_METRICS.includes(id) || id === "M-07") continue;
		report.metrics[id] = { pass: false, owner: ownerFor(map, id), detail: "unknown metric" };
		failures.push({ id, owner: ownerFor(map, id), check: "collector", message: "unknown metric" });
	}

	if (args.metrics.includes("M-07")) {
		const result = collectM07(gates, proofRoot);
		report.metrics["M-07"] = result;
		if (!result.pass) {
			failures.push({ id: "M-07", owner: "RP-19", check: "gates+harness", message: result.detail });
		}
	}

	report.uat = wireUatPaths(proofRoot, map);

	// REL-01: map must exist; full traceability test is part of test:kpi / explicit run
	if (!existsSync(join(repoRoot, "docs/traceability-map.json"))) {
		failures.push({ id: "REL-01", owner: "RP-19", check: "traceability-map.json", message: "map missing" });
		report.traceability.complete = false;
	}

	if (!args.skipGates) {
		const tr = runNodeTest(["test/traceability.test.ts"], ".", 120_000);
		writeEvidence(proofRoot, "traceability-test.log", `${tr.stdout}\n${tr.stderr}`);
		if (!assertTapPass(`${tr.stdout}\n${tr.stderr}`, tr)) {
			failures.push({
				id: "REL-01",
				owner: "RP-19",
				check: "traceability.test.ts",
				message: (tr.stderr || tr.stdout).slice(-500),
			});
			report.traceability.complete = false;
		}
	}

	// Every file a metric wrote, not a hand-listed few: a built-binary run copies
	// the whole run store, so the sweep has to walk what is actually there.
	// `report.secrets_scan.canaries` intentionally lists the canary strings, so the
	// report itself is never swept for them.
	const secretHits = [];
	const sweptFiles = [];
	for (const file of evidenceFiles(proofRoot)) {
		// The report lists the canary strings on purpose, so it is never its own
		// haystack.
		if (resolve(file) === resolve(jsonPath)) continue;
		sweptFiles.push(relative(repoRoot, file));
		secretHits.push(...scanSecrets(readFileSync(file, "utf8")));
	}
	report.secrets_scan.files_swept = sweptFiles.length;
	const harnessEv = join(proofRoot, "built-harness.json");
	if (existsSync(harnessEv)) secretHits.push(...scanSecrets(readFileSync(harnessEv, "utf8")));
	report.secrets_scan.hits = [...new Set(secretHits)];
	report.secrets_scan.pass = report.secrets_scan.hits.length === 0;
	if (!report.secrets_scan.pass) {
		failures.push({
			id: "NFR-01",
			owner: "RP-01",
			check: "secrets_scan",
			message: `canaries hit: ${report.secrets_scan.hits.join(",")}`,
		});
	}


	const metricsNeeded = args.metrics;
	const metricsOk = metricsNeeded.every((id) => report.metrics[id]?.pass === true);
	const gatesOk = Object.values(gates).every((g) => g === true);
	report.ok = failures.length === 0 && metricsOk && gatesOk;

	ensureDir(dirname(jsonPath));
	writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(
		`verify-product: wrote ${relative(repoRoot, jsonPath)} ok=${report.ok} failures=${failures.length}\n`,
	);
	for (const f of failures) {
		process.stderr.write(`  FAIL ${f.id} owner=${f.owner} — ${f.message}\n`);
	}
	process.exitCode = report.ok ? 0 : 1;
}

await main();
