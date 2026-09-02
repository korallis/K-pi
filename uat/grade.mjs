#!/usr/bin/env node
/**
 * UAT grader — artifact-only.
 *
 * Reads a row evidence directory and optional assertion specs; emits
 * assertions.json + result.json. Also:
 *   - canary sweep over captured streams
 *   - fail-closed scan: harness must never import product source under
 *     packages/<pkg>/src, and must never invoke the node test runner
 *
 * Usage:
 *   node uat/grade.mjs --row-dir .kpi/uat/UAT-01 --assertions assertions.spec.json
 *   node uat/grade.mjs --scan-harness
 *   node uat/grade.mjs --self-test
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = here;

export const CANARIES = [
	"KPI_PROOF_TOKEN_7f3a9c",
	"Set-Cookie: session=proof-canary",
	"Bearer uat-bearer-tail",
	"sk-ant-uat-tail",
	"ghp_UatTail",
	"AKIA1234567890UATTAIL",
];

function listFiles(root, { ignoreDirNames = new Set() } = {}) {
	const out = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			if (ignoreDirNames.has(name.name)) continue;
			const path = join(dir, name.name);
			if (name.isDirectory()) walk(path);
			else out.push(path);
		}
	};
	walk(root);
	return out;
}

/**
 * Fail-closed scan of the harness tree.
 * Only real import/require / node-test invocations count — prose that
 * documents the ban does not.
 * @returns {{ ok: boolean, violations: Array<{file:string,kind:string,line:number,excerpt:string}> }}
 */
export function scanHarness(root = harnessRoot) {
	const violations = [];
	const files = listFiles(root, { ignoreDirNames: new Set(["node_modules", ".git", "evidence"]) });
	for (const file of files) {
		if (!/\.(mjs|cjs|js|py|ts)$/.test(file)) continue;
		const rel = relative(root, file).replaceAll("\\", "/");
		if (rel === "grade.mjs") continue;
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/);
		lines.forEach((line, i) => {
			const trimmed = line.trim();
			if (/^(\/\/|#|\*|\/\*)/.test(trimmed)) return;
			if (
				/\bfrom\s+['"][^'"]*packages\/[^'"]+\/src/.test(line) ||
				/require\s*\(\s*['"][^'"]*packages\/[^'"]+\/src/.test(line) ||
				/import\s*\(\s*['"][^'"]*packages\/[^'"]+\/src/.test(line)
			) {
				violations.push({
					file: rel,
					kind: "packages_src_import",
					line: i + 1,
					excerpt: trimmed.slice(0, 200),
				});
			}
			if (
				/(?:spawn|spawnSync|exec|execSync|execFile)\s*\([^;]*--test/.test(line) ||
				/['"`]node\s+--test\b/.test(line)
			) {
				violations.push({
					file: rel,
					kind: "node_test_runner",
					line: i + 1,
					excerpt: trimmed.slice(0, 200),
				});
			}
		});
	}
	return { ok: violations.length === 0, violations };
}

/**
 * Sweep captured text artifacts for canary leakage.
 */
export function sweepCanaries(rowDir, canaries = CANARIES) {
	const hits = [];
	const names = [
		"stdout.log",
		"stderr.log",
		"frame.txt",
		"frame.raw",
		"rpc.jsonl",
		"model-requests.jsonl",
		"notes.md",
		"git.txt",
		"cmd.txt",
	];
	for (const name of names) {
		const path = join(rowDir, name);
		if (!existsSync(path)) continue;
		let text;
		try {
			text = readFileSync(path).toString("utf8");
		} catch {
			continue;
		}
		for (const canary of canaries) {
			if (text.includes(canary)) hits.push({ artifact: name, canary });
		}
	}
	const art = join(rowDir, "artifacts");
	if (existsSync(art)) {
		for (const file of listFiles(art).slice(0, 500)) {
			let text;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const canary of canaries) {
				if (text.includes(canary)) {
					hits.push({ artifact: relative(rowDir, file).replaceAll("\\", "/"), canary });
				}
			}
		}
	}
	return { ok: hits.length === 0, hits };
}

function locate(artifactText, locator) {
	if (locator == null || locator === "") return artifactText;
	if (typeof locator !== "string") return null;
	if (locator.startsWith("re:")) {
		const re = new RegExp(locator.slice(3), "m");
		const m = artifactText.match(re);
		return m ? m[0] : null;
	}
	if (locator.startsWith("jsonpath:")) {
		try {
			const obj = JSON.parse(artifactText);
			const path = locator.slice("jsonpath:".length).split(".").filter(Boolean);
			let cur = obj;
			for (const p of path) {
				if (cur == null) return null;
				cur = cur[p];
			}
			return cur == null ? null : typeof cur === "string" ? cur : JSON.stringify(cur);
		} catch {
			return null;
		}
	}
	return artifactText.includes(locator) ? locator : null;
}

/**
 * Evaluate assertion specs against a row directory.
 * Spec: { id, artifact, locator?, expected?, contains?, absent?, deterministic?=true }
 */
export function gradeRow(rowDir, specs = []) {
	const assertions = [];
	for (const spec of specs) {
		const artifactPath = join(rowDir, spec.artifact);
		const exists = existsSync(artifactPath);
		let actual = null;
		let pass = false;
		let detail = "";
		if (!exists) {
			detail = "artifact missing";
		} else {
			const text = readFileSync(artifactPath, "utf8");
			const located = locate(text, spec.locator);
			actual = located;
			if (spec.absent != null) {
				pass = !text.includes(spec.absent);
				detail = pass ? "absent ok" : `found forbidden ${spec.absent}`;
				actual = pass ? null : spec.absent;
			} else if (spec.contains != null) {
				pass = text.includes(spec.contains);
				detail = pass ? "contains ok" : "contains missing";
				actual = pass ? spec.contains : null;
			} else if (spec.notContains != null) {
				pass = !text.includes(spec.notContains);
				detail = pass ? "notContains ok" : `found forbidden ${spec.notContains}`;
				actual = pass ? null : spec.notContains;
			} else if (spec.expected != null) {
				const exp = String(spec.expected);
				pass = located != null && String(located) === exp;
				if (!pass && located == null && text.trim() === exp) {
					pass = true;
					actual = exp;
				}
				detail = pass ? "expected ok" : `expected ${JSON.stringify(exp)} got ${JSON.stringify(located)}`;
			} else if (spec.locator) {
				pass = located != null;
				detail = pass ? "locator matched" : "locator miss";
			} else {
				pass = true;
				detail = "artifact exists";
			}
		}
		assertions.push({
			id: spec.id ?? spec.artifact,
			artifact: spec.artifact,
			locator: spec.locator ?? null,
			expected: spec.expected ?? spec.contains ?? null,
			actual,
			pass,
			detail,
			deterministic: spec.deterministic !== false,
		});
	}

	const canary = sweepCanaries(rowDir);
	if (!canary.ok) {
		for (const hit of canary.hits) {
			assertions.push({
				id: `canary:${hit.artifact}`,
				artifact: hit.artifact,
				locator: null,
				expected: "no canary",
				actual: hit.canary,
				pass: false,
				detail: "canary leaked into artifact",
				deterministic: true,
			});
		}
	}

	const failed = assertions.filter((a) => !a.pass);
	const result = {
		ok: failed.length === 0,
		row_dir: rowDir,
		passed: assertions.filter((a) => a.pass).length,
		failed: failed.length,
		assertions_total: assertions.length,
		canary_ok: canary.ok,
		at: new Date().toISOString(),
	};
	return { assertions, result };
}

export function writeGrade(rowDir, specs = []) {
	const { assertions, result } = gradeRow(rowDir, specs);
	mkdirSync(rowDir, { recursive: true });
	writeFileSync(join(rowDir, "assertions.json"), `${JSON.stringify(assertions, null, 2)}\n`);
	writeFileSync(join(rowDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	return { assertions, result };
}

function parseArgs(argv) {
	const out = { rowDir: null, assertions: null, scanHarness: false, selfTest: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--row-dir") out.rowDir = resolve(argv[++i]);
		else if (a === "--assertions") out.assertions = resolve(argv[++i]);
		else if (a === "--scan-harness") out.scanHarness = true;
		else if (a === "--self-test") out.selfTest = true;
	}
	return out;
}

function selfTest() {
	const scan = scanHarness(harnessRoot);
	if (!scan.ok) {
		console.error("harness scan failed", scan.violations);
		process.exit(1);
	}
	const tmp = mkdtempSync(join(tmpdir(), "uat-grade-"));
	try {
		writeFileSync(join(tmp, "stdout.log"), "version 0.1.0\nok\n");
		writeFileSync(join(tmp, "notes.md"), "operator saw version banner\n");
		const { result } = writeGrade(tmp, [
			{ id: "version", artifact: "stdout.log", contains: "0.1.0" },
			{ id: "notes", artifact: "notes.md", locator: "re:operator" },
		]);
		if (!result.ok) throw new Error("grade self-test expected pass");
		writeFileSync(join(tmp, "stderr.log"), `leak ${CANARIES[0]}\n`);
		const bad = gradeRow(tmp, []);
		if (bad.result.ok) throw new Error("canary should fail grade");
		process.stdout.write("grade self-test: ok\n");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function isMain() {
	const entry = process.argv[1] ? resolve(process.argv[1]) : "";
	return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
	const args = parseArgs(process.argv.slice(2));
	if (args.selfTest) {
		try {
			selfTest();
		} catch (e) {
			console.error(e);
			process.exit(1);
		}
	} else if (args.scanHarness) {
		const scan = scanHarness(harnessRoot);
		process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
		process.exit(scan.ok ? 0 : 1);
	} else if (args.rowDir) {
		let specs = [];
		if (args.assertions) {
			specs = JSON.parse(readFileSync(args.assertions, "utf8"));
			if (!Array.isArray(specs)) throw new Error("assertions file must be an array");
		}
		const { result } = writeGrade(args.rowDir, specs);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		process.exit(result.ok ? 0 : 1);
	} else {
		process.stderr.write(
			"usage: grade.mjs --row-dir DIR [--assertions spec.json] | --scan-harness | --self-test\n",
		);
		process.exit(2);
	}
}
