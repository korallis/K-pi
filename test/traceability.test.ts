import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mapPath = join(root, "docs/traceability-map.json");
const prdPath = join(root, "docs/PRD.md");
const planPath = join(root, "docs/remediation-plan.md");
const researchPath = join(root, "docs/remediation-research.md");
const specPath = join(root, "docs/spec.md");
const uatPath = join(root, "docs/uat.md");

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
	"agent.denied",
	"node.started",
	"node.finished",
	"node.retry",
] as const;

const GAP_ID = /^(?:DOC|STORE|ARCH|PKG|POL|GRAPH|ACCT|LOCAL|RESEARCH|DUNE|KG|BUS|MIN|KSTACK|UI|REL)-\d+$/;

type NamedCheck = {
	name: string;
	runner: string;
	file: string;
	test_title?: string;
	observable: string;
};

type MapEntry = {
	id: string;
	kind: string;
	primary_owner: string;
	coverage?: "covered" | "uncovered";
	named_checks: NamedCheck[];
	failure_route: string;
	prd_us?: string;
	uncovered_reason?: string;
	summary?: string;
};

type TraceMap = {
	schema_version: number;
	entries: MapEntry[];
	counts: Record<string, number>;
	rules: Record<string, boolean>;
	uncovered?: { id: string; owner: string; reason: string }[];
	shared_titles?: { key: string; ids: string[] }[];
};

async function loadMap(): Promise<TraceMap> {
	return JSON.parse(await readFile(mapPath, "utf8")) as TraceMap;
}

function parsePrdAcs(prd: string): { id: string; us: string }[] {
	const out: { id: string; us: string }[] = [];
	let currentUs: string | null = null;
	for (const line of prd.split("\n")) {
		const us = /^### (US-\d{2})\b/.exec(line);
		if (us) {
			currentUs = us[1];
			continue;
		}
		const ac = /^- \*\*(AC-\d+\.\d+)\*\*/.exec(line);
		if (ac && currentUs) out.push({ id: ac[1], us: currentUs });
	}
	return out;
}

function parsePlanGaps(plan: string): Map<string, string> {
	const owned = new Map<string, string>();
	const parts = plan.split(/^## (RP-\S+)/m).slice(1);
	for (let i = 0; i < parts.length; i += 2) {
		const rp = parts[i];
		const body = parts[i + 1] ?? "";
		const owns = /\*\*Owns gaps:\*\*\s*(.+)/.exec(body);
		if (!owns) continue;
		for (const g of owns[1].match(/[A-Z]+-\d+/g) ?? []) {
			assert.equal(owned.has(g), false, `gap ${g} owned twice`);
			owned.set(g, rp);
		}
	}
	return owned;
}

function parsePlanRps(plan: string): string[] {
	return [...plan.matchAll(/^## (RP-\S+)/gm)].map((m) => m[1]);
}

function extractTestTitles(source: string): string[] {
	const titles: string[] = [];
	const re = /\b(?:test|it)\s*\(\s*(?:`([^`]+)`|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g;
	for (const m of source.matchAll(re)) {
		titles.push(m[1] ?? m[2] ?? m[3] ?? "");
	}
	return titles;
}

function isForbiddenCheck(check: NamedCheck, entryId: string, coverage: string): string | undefined {
	if (coverage === "uncovered") return undefined;
	const blob = `${check.name}\n${check.runner}\n${check.file}\n${check.observable}\n${check.test_title ?? ""}`;
	if (/roadmap\.md|implementation-plan\.md/i.test(blob) && /\[x\]|checkbox/i.test(blob)) {
		return "historical checkbox evidence";
	}
	if (!check.observable || check.observable.trim().length < 8) {
		return "empty observable";
	}
	if (/^(true|echo|exit 0)\b/.test(check.runner.trim())) {
		return "no-op runner";
	}
	// Whole-file alias: runner lists a test file without --test-name-pattern
	if (
		/\.test\.(ts|mjs|js)\b/.test(check.runner) &&
		!/--test-name-pattern/.test(check.runner) &&
		!/verify-(?:built-harness|product)/.test(check.runner)
	) {
		return "whole-file runner without --test-name-pattern";
	}
	if (!check.test_title || check.test_title.trim().length < 8) {
		return "missing exact test_title";
	}
	// Template observables
	if (/^AC AC-\d+\.\d+ observable via RP-/.test(check.observable)) {
		return "templated AC observable";
	}
	if (
		check.file.includes("traceability-map.json") &&
		entryId !== "REL-01" &&
		entryId !== "RP-19" &&
		!/verify-product|verify-built|traceability\.test/.test(check.runner)
	) {
		return "self-referential map-only check";
	}
	return undefined;
}

test("traceability map exists and declares exact-title rules", async () => {
	const map = await loadMap();
	assert.ok(map.schema_version >= 2);
	assert.equal(map.rules.primary_owner_exactly_once, true);
	assert.equal(map.rules.historical_checkboxes_forbidden_as_evidence, true);
	assert.equal(map.rules.source_grep_only_checks_forbidden, true);
	assert.equal(map.rules.self_referential_map_only_checks_forbidden, true);
	assert.equal(map.rules.exact_test_title_required, true);
	assert.equal(map.rules.whole_file_runner_forbidden, true);
	assert.ok(map.entries.length >= 300, `expected full map, got ${map.entries.length}`);
});

test("every PRD AC appears exactly once with one primary owner and a US link", async () => {
	const map = await loadMap();
	const prd = await readFile(prdPath, "utf8");
	const prdAcs = parsePrdAcs(prd);
	const mapAcs = map.entries.filter((e) => e.kind === "ac");
	assert.equal(mapAcs.length, prdAcs.length);
	const byId = new Map(mapAcs.map((e) => [e.id, e]));
	for (const ac of prdAcs) {
		const entry = byId.get(ac.id);
		assert.ok(entry, `missing AC ${ac.id}`);
		assert.equal(entry!.prd_us, ac.us);
		assert.match(entry!.primary_owner, /^RP-/);
		assert.ok(entry!.failure_route.includes(entry!.primary_owner));
		assert.ok(entry!.coverage === "covered" || entry!.coverage === "uncovered");
		if (entry!.coverage === "covered") {
			assert.ok(entry!.named_checks.length >= 1);
		} else {
			assert.equal(entry!.named_checks.length, 0);
			assert.ok(entry!.uncovered_reason);
		}
	}
	assert.equal(byId.size, prdAcs.length, "duplicate AC ids in map");
});

test("every research gap is owned once in the plan and once in the map", async () => {
	const map = await loadMap();
	const plan = await readFile(planPath, "utf8");
	const research = await readFile(researchPath, "utf8");
	const planGaps = parsePlanGaps(plan);
	const researchGaps = [...new Set((research.match(/\b[A-Z]+-\d+\b/g) ?? []).filter((g) => GAP_ID.test(g)))].sort();
	for (const g of researchGaps) {
		assert.ok(planGaps.has(g), `research gap ${g} missing from plan Owns gaps`);
	}
	const mapGaps = map.entries.filter((e) => e.kind === "gap");
	assert.equal(mapGaps.length, planGaps.size);
	for (const e of mapGaps) {
		assert.equal(e.primary_owner, planGaps.get(e.id), `gap ${e.id} owner mismatch`);
	}
});

test("every RP, metric, REQ, NFR, schema, and event has exactly one map entry", async () => {
	const map = await loadMap();
	const plan = await readFile(planPath, "utf8");
	const spec = await readFile(specPath, "utf8");
	const rps = parsePlanRps(plan);
	const reqs = [...new Set(spec.match(/\bREQ-[A-Z]+-\d+\b/g) ?? [])].sort();
	const nfrs = [...new Set(spec.match(/\bNFR-\d+\b/g) ?? [])].sort();

	const byKind = (kind: string) => map.entries.filter((e) => e.kind === kind);
	assert.deepEqual(
		byKind("rp")
			.map((e) => e.id)
			.sort(),
		[...rps].sort(),
	);
	assert.deepEqual(
		byKind("metric")
			.map((e) => e.id)
			.sort(),
		["M-01", "M-02", "M-03", "M-04", "M-05", "M-06", "M-07"],
	);
	assert.deepEqual(
		byKind("req")
			.map((e) => e.id)
			.sort(),
		reqs,
	);
	assert.deepEqual(
		byKind("nfr")
			.map((e) => e.id)
			.sort(),
		nfrs,
	);
	assert.deepEqual(
		byKind("schema")
			.map((e) => e.id)
			.sort(),
		["SCH-event", "SCH-evidence", "SCH-task", "SCH-verdict"],
	);
	assert.deepEqual(
		byKind("event")
			.map((e) => e.id)
			.sort(),
		EVENT_TYPES.map((e) => `EVT-${e}`).sort(),
	);

	const ids = map.entries.map((e) => e.id);
	assert.equal(ids.length, new Set(ids).size, "duplicate ids");
	assert.equal(map.counts.total, map.entries.length);
});

test("named checks point at real files and are observable, not no-ops", async () => {
	const map = await loadMap();
	const missing: string[] = [];
	const forbidden: string[] = [];
	for (const entry of map.entries) {
		assert.match(entry.primary_owner, /^RP-/);
		assert.ok(entry.failure_route?.length > 0, `${entry.id} needs failure_route`);
		if (entry.coverage === "uncovered") {
			assert.equal(entry.named_checks.length, 0, `${entry.id} uncovered must have empty named_checks`);
			continue;
		}
		assert.ok(entry.named_checks?.length >= 1, `${entry.id} needs a named check`);
		for (const check of entry.named_checks) {
			assert.ok(check.name, `${entry.id} check name`);
			assert.ok(check.runner, `${entry.id} check runner`);
			assert.ok(check.file, `${entry.id} check file`);
			const reason = isForbiddenCheck(check, entry.id, entry.coverage ?? "covered");
			if (reason) forbidden.push(`${entry.id}: ${reason} (${check.name})`);
			const filePath = join(root, check.file.split("#")[0]!);
			try {
				await access(filePath);
			} catch {
				missing.push(`${entry.id} → ${check.file}`);
			}
		}
	}
	assert.deepEqual(forbidden, [], forbidden.join("\n"));
	assert.deepEqual(missing, [], `missing check files:\n${missing.join("\n")}`);
});

test("every named check binds an exact test title that exists and is selectable", async () => {
	const map = await loadMap();
	const fileCache = new Map<string, string[]>();
	const loadTitles = async (rel: string) => {
		if (!fileCache.has(rel)) {
			const src = await readFile(join(root, rel), "utf8");
			fileCache.set(rel, extractTestTitles(src));
		}
		return fileCache.get(rel)!;
	};

	const missingTitle: string[] = [];
	const patternMiss: string[] = [];
	const wholeFile: string[] = [];
	const templateObs: string[] = [];

	for (const entry of map.entries) {
		if (entry.coverage === "uncovered") continue;
		for (const check of entry.named_checks) {
			if (!check.test_title) {
				missingTitle.push(`${entry.id}: no test_title`);
				continue;
			}
			if (/^AC AC-\d/.test(check.observable) || /observable via RP-/.test(check.observable)) {
				templateObs.push(`${entry.id}: ${check.observable}`);
			}
			if (/\.test\.(ts|mjs)\b/.test(check.runner) && !/--test-name-pattern/.test(check.runner)) {
				wholeFile.push(`${entry.id}: ${check.runner}`);
			}
			const titles = await loadTitles(check.file);
			if (!titles.includes(check.test_title)) {
				missingTitle.push(`${entry.id}: title not in ${check.file}: ${check.test_title}`);
				continue;
			}
			// --test-name-pattern '^title$' must select ≥1 title in that file
			const pattern = new RegExp(`^${check.test_title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
			const selected = titles.filter((title) => pattern.test(title));
			if (selected.length < 1) {
				patternMiss.push(`${entry.id}: pattern selected 0 titles in ${check.file}: ${check.test_title}`);
			}
			// Runner must embed the same exact pattern + file (not a whole-file alias)
			if (!check.runner.includes("--test-name-pattern") || !check.runner.includes(check.file)) {
				patternMiss.push(`${entry.id}: runner must use --test-name-pattern and the check file`);
			}
		}
	}

	assert.deepEqual(templateObs, [], `templated observables:\n${templateObs.join("\n")}`);
	assert.deepEqual(wholeFile, [], `whole-file runners:\n${wholeFile.join("\n")}`);
	assert.deepEqual(missingTitle, [], `missing titles:\n${missingTitle.join("\n")}`);
	assert.deepEqual(patternMiss, [], `pattern misses:\n${patternMiss.join("\n")}`);
});

test("shared test titles are declared and only bind related requirements", async () => {
	const map = await loadMap();
	const byTitle = new Map<string, string[]>();
	for (const entry of map.entries) {
		for (const check of entry.named_checks ?? []) {
			if (!check.test_title) continue;
			const k = `${check.file}::${check.test_title}`;
			if (!byTitle.has(k)) byTitle.set(k, []);
			byTitle.get(k)!.push(entry.id);
		}
	}
	const declared = new Map((map.shared_titles ?? []).map((s) => [s.key, new Set(s.ids)]));
	const undeclared: string[] = [];
	for (const [k, ids] of byTitle) {
		if (ids.length < 2) continue;
		const d = declared.get(k);
		if (!d) {
			undeclared.push(`${k} → ${ids.join(",")}`);
			continue;
		}
		for (const id of ids) {
			if (!d.has(id)) undeclared.push(`${k} missing declared id ${id}`);
		}
	}
	assert.deepEqual(undeclared, [], `undeclared shared titles:\n${undeclared.join("\n")}`);
});

test("UAT rows cover US-01..US-31 and metrics M-01..M-07", async () => {
	const uat = await readFile(uatPath, "utf8");
	for (let i = 1; i <= 31; i += 1) {
		const id = `UAT-${String(i).padStart(2, "0")}`;
		assert.match(uat, new RegExp(`^### ${id}\\b`, "m"), `missing ${id}`);
	}
	for (const m of ["M-01", "M-02", "M-03", "M-04", "M-05", "M-06", "M-07"]) {
		assert.match(uat, new RegExp(`\\| ${m} \\|`), `uat metrics table missing ${m}`);
	}
});

test("RP-19 proof scripts and map are present for REL-01 and REL-02", async () => {
	for (const path of [
		"docs/traceability-map.json",
		"test/traceability.test.ts",
		"scripts/verify-built-harness.mjs",
		"scripts/verify-product.mjs",
		"scripts/generate-traceability-map.mjs",
	]) {
		await access(join(root, path));
	}
	const map = await loadMap();
	const rel01 = map.entries.find((e) => e.id === "REL-01");
	const rel02 = map.entries.find((e) => e.id === "REL-02");
	assert.equal(rel01?.primary_owner, "RP-19");
	assert.equal(rel02?.primary_owner, "RP-19");
});

test("counts in the map match live entry kinds", async () => {
	const map = await loadMap();
	const counts: Record<string, number> = {};
	for (const e of map.entries) {
		counts[e.kind] = (counts[e.kind] ?? 0) + 1;
	}
	assert.equal(counts.ac, map.counts.ac);
	assert.equal(counts.metric, map.counts.metric);
	assert.equal(counts.gap, map.counts.gap);
	assert.equal(counts.rp, map.counts.rp);
	assert.equal(counts.req, map.counts.req);
	assert.equal(counts.nfr, map.counts.nfr);
	assert.equal(counts.schema, map.counts.schema);
	assert.equal(counts.event, map.counts.event);
	assert.equal(
		Object.values(counts).reduce((a, b) => a + b, 0),
		map.counts.total,
	);
});

test("uncovered list is honest and every uncovered entry has an owner", async () => {
	const map = await loadMap();
	const uncoveredEntries = map.entries.filter((e) => e.coverage === "uncovered");
	const listed = new Set((map.uncovered ?? []).map((u) => u.id));
	for (const e of uncoveredEntries) {
		assert.ok(listed.has(e.id), `uncovered entry ${e.id} missing from map.uncovered`);
		assert.match(e.primary_owner, /^RP-/);
		assert.ok(e.uncovered_reason);
	}
	// Print for operators when the suite is run with reporter
	if (uncoveredEntries.length > 0) {
		process.stdout.write(
			`traceability uncovered (${uncoveredEntries.length}): ${uncoveredEntries.map((e) => e.id).join(", ")}\n`,
		);
	}
});

test("exact title patterns select exactly one title in their file", async () => {
	const map = await loadMap();
	const samples = map.entries.filter((e) => e.coverage === "covered" && e.named_checks[0]?.test_title).slice(0, 20);
	assert.ok(samples.length >= 10);
	for (const entry of samples) {
		const check = entry.named_checks[0]!;
		const src = await readFile(join(root, check.file), "utf8");
		const titles = extractTestTitles(src);
		const pattern = new RegExp(`^${check.test_title!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
		const selected = titles.filter((title) => pattern.test(title));
		assert.equal(
			selected.length,
			1,
			`${entry.id} pattern must select exactly one title in ${check.file}, got ${selected.length}`,
		);
		assert.equal(selected[0], check.test_title);
	}
});
