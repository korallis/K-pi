import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

const projectContract = "AGENTS.md";
const activePlan = "docs/remediation-plan.md";
const remediationResearch = "docs/remediation-research.md";
const featureAcceptance = "docs/uat.md";
const planBasename = "remediation-plan.md";
const acceptanceBasename = "uat.md";

/** Every file that has to send a reader to the active queue: the contract, its pointers, the entry points. */
const routingSurfaces = [
	projectContract,
	"docs/AGENTS.md",
	"START-HERE.md",
	"docs/START-HERE.md",
	"docs/BUILD-PROMPT.md",
	"docs/README.md",
	"docs/PRD.md",
] as const;

/**
 * Redirect-only stubs, and the file each one must land a reader on. They exist so
 * someone who opens `docs/` still reaches the contract; they are not second copies
 * of it. A rule restated here is a rule that can drift from the original.
 */
const pointerSurfaces: Record<string, string> = {
	"docs/AGENTS.md": projectContract,
	"docs/START-HERE.md": "START-HERE.md",
};

const historicalRecords = ["docs/roadmap.md", "docs/implementation-plan.md"] as const;

const gateIds = ["NH-01", "NH-02", "NH-03", "NH-04"] as const;

/** Headings that carry normative weight. Only the project contract may own them. */
const normativeHeading =
	/^#{2,3}\s+(?:hard rules|gates|quality gates|how to work|do not|read order|non-negotiables|stack)\b/iu;

/** A rule restated outside the contract. Pointer files must contain none. */
const restatedRule = /^\s*(?:[-*]|\d+\.)\s.*\b(?:MUST(?:\s+NOT)?|never|do not|does not|cannot|always)\b/u;

/**
 * Claims that a *named* package is the one to work on now. Only the queue may make
 * one; every other file names the queue and lets it answer. Each pattern here is a
 * phrasing that actually drifted once.
 */
const currentPackageClaims = [
	/\bcurrently\s+\**`?RP-\d{2}[A-Z]?/iu,
	/\b(?:start|starting|begin|beginning)\s+at\s+\**`?RP-\d{2}[A-Z]?/iu,
	/\bRP-\d{2}[A-Z]?\b[^.]{0,24}\bis\s+the\s+(?:current|lowest incomplete)\b/iu,
	/\bqueue,?\s+RP-\d{2}[A-Z]?\s+first\b/iu,
] as const;

/** Only the queue may call itself the queue or the completion authority. */
const authorityClaim = /\b(?:active (?:work |implementation )?queue|completion authority)\b/iu;

/** A next-step pointer says the plan is what to do now, rather than merely naming it. */
const activityMarker = /\b(?:active|next|queue|start|resumes?)\b|RP-00/iu;
/** Any reference to a historical record has to revoke its authority on the same line. */
const supersessionMarker =
	/historical|superseded|supersedes|non-authoritative|not authoritative|not current|not completion evidence|not evidence|no longer/iu;
const historicalFilename = /roadmap\.md|implementation-plan\.md/u;
const checkbox = /^\s*-\s\[[ xX]\]/u;
const checkedBox = /^\s*-\s\[[xX]\]/u;
const gapIdPattern = /^[A-Z]+-\d{2}$/u;
const placeholderCell = /^(?:|[-–—?]|tbd|n\/a|none|open|pending|unrecorded)$/iu;

type ProseLine = { text: string; number: number };

type Table = { headers: string[]; rows: string[][] };

type RemediationPackage = {
	id: string;
	number: number;
	/** Insertion suffix, e.g. the "A" in RP-01A. Empty for a plain numbered package. */
	suffix: string;
	line: number;
	dependsOn: string[];
	ownsGaps: string[];
};

type GateRecord = {
	status: string;
	human: string;
	date: string;
	decision: string;
	aligned: string;
};

const documents = new Map<string, string[]>();

async function documentLines(relativePath: string): Promise<string[]> {
	const cached = documents.get(relativePath);
	if (cached !== undefined) return cached;
	const source = await readFile(new URL(relativePath, repositoryRoot), "utf8");
	const parsed = source.split(/\r?\n/u);
	documents.set(relativePath, parsed);
	return parsed;
}

function required<T>(value: T | null | undefined, message: string): T {
	assert.ok(value !== null && value !== undefined, message);
	return value as T;
}

function plainCell(value: string): string {
	return value.replaceAll("`", "").replaceAll("*", "").trim();
}

function isRecorded(value: string): boolean {
	return !placeholderCell.test(plainCell(value));
}

function packageId(value: number, suffix = ""): string {
	return `RP-${String(value).padStart(2, "0")}${suffix}`;
}

/**
 * Sortable key for a package id. The suffix is padded to one character with a
 * space, which sorts before any letter, so `RP-01 < RP-01A < RP-02` — a package
 * deliberately inserted after RP-01 ranks between RP-01 and RP-02.
 */
function packageOrder(id: string): string {
	const [, number, suffix] = required(/^RP-(\d{2})([A-Z]?)$/u.exec(id), `${id} is not a package id`);
	return `${number}${suffix || " "}`;
}

function directoryOf(relativePath: string): string {
	const cut = relativePath.lastIndexOf("/");
	return cut === -1 ? "" : relativePath.slice(0, cut);
}

/** Collapses `.` and `..` into a repository-root-relative path, or null when it escapes the repository. */
function normalizePath(value: string): string | null {
	const segments: string[] = [];
	for (const segment of value.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.length === 0 ? null : segments.join("/");
}

async function exists(relativePath: string): Promise<boolean> {
	try {
		await access(new URL(relativePath, repositoryRoot));
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves a documented pointer to a repository-root-relative file that exists on disk.
 * Link destinations resolve against the referring file's directory. Inline-code paths are
 * prose, so they may also be written from the repository root, which is how paste-ready
 * instructions address the tree.
 */
async function resolvePointer(
	fromDirectory: string,
	raw: string,
	allowRepositoryRoot: boolean,
): Promise<string | null> {
	const candidates = [normalizePath(`${fromDirectory}/${raw}`)];
	if (allowRepositoryRoot) candidates.push(normalizePath(raw));
	for (const candidate of candidates) {
		if (candidate !== null && (await exists(candidate))) return candidate;
	}
	return null;
}

/** Fenced blocks are sample transcripts, not routing prose. */
function proseLines(source: string[]): ProseLine[] {
	const lines: ProseLine[] = [];
	let fenced = false;
	for (let index = 0; index < source.length; index += 1) {
		const text = source[index];
		if (/^\s*(?:```|~~~)/u.test(text)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) lines.push({ text, number: index + 1 });
	}
	return lines;
}

/**
 * Splits a line into markdown link destinations and standalone inline-code paths.
 * A backticked link label is display text, not a pointer, so it is dropped with its link.
 */
function pointersIn(line: string): { destinations: string[]; inlineCode: string[] } {
	const destinations: string[] = [];
	const residue = line.replace(/\[[^\]]*\]\(([^)]+)\)/gu, (_match, target: string) => {
		destinations.push(target.trim().split(/\s+/u)[0]);
		return " ";
	});
	const inlineCode = [...residue.matchAll(/`([^`]+)`/gu)].map((match) => match[1].trim());
	return { destinations, inlineCode };
}

type DocPointer = { raw: string; resolved: string | null; line: number };

/** Every way `surface` names a file ending in `basename`, with where each pointer actually lands. */
async function pointersTo(surface: string, basename: string): Promise<DocPointer[]> {
	const directory = directoryOf(surface);
	const pointers: DocPointer[] = [];
	for (const { text, number } of proseLines(await documentLines(surface))) {
		const { destinations, inlineCode } = pointersIn(text);
		for (const [raws, allowRepositoryRoot] of [
			[destinations, false],
			[inlineCode, true],
		] as const) {
			for (const raw of raws) {
				if (!raw.endsWith(basename)) continue;
				pointers.push({
					raw,
					resolved: await resolvePointer(directory, raw, allowRepositoryRoot),
					line: number,
				});
			}
		}
	}
	return pointers;
}

/** Splits one markdown row, honouring `\|` escapes so pipes inside cells never shift columns. */
function splitRow(line: string): string[] {
	const cells: string[] = [];
	let cell = "";
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (character === "\\" && line[index + 1] === "|") {
			cell += "|";
			index += 1;
			continue;
		}
		if (character === "|") {
			cells.push(cell);
			cell = "";
			continue;
		}
		cell += character;
	}
	cells.push(cell);
	return cells.slice(1, -1).map((value) => value.trim());
}

/** Body of the first heading matching `heading`, up to the next heading of equal or higher rank. */
function sectionLines(source: string[], heading: RegExp): string[] {
	const start = source.findIndex((line) => heading.test(line));
	assert.notEqual(start, -1, `no heading matches ${heading}`);
	const marker = required(/^(#+)\s/u.exec(source[start]), `heading matching ${heading} is not a markdown heading`);
	const depth = marker[1].length;
	const body = source.slice(start + 1);
	const end = body.findIndex((line) => {
		const next = /^(#+)\s/u.exec(line);
		return next !== null && next[1].length <= depth;
	});
	return end === -1 ? body : body.slice(0, end);
}

function firstTable(source: string[], label: string): Table {
	const headerIndex = source.findIndex((line) => /^\s*\|/u.test(line));
	assert.notEqual(headerIndex, -1, `${label} contains no markdown table`);
	const headers = splitRow(source[headerIndex]).map((header) => plainCell(header).toLowerCase().replace(/\s+/gu, " "));
	const delimiter = splitRow(source[headerIndex + 1]);
	assert.ok(
		delimiter.length === headers.length && delimiter.every((cell) => /^:?-{3,}:?$/u.test(cell)),
		`${label} table has no delimiter row matching its ${headers.length} headers`,
	);
	const rows: string[][] = [];
	for (let index = headerIndex + 2; index < source.length; index += 1) {
		if (!/^\s*\|/u.test(source[index])) break;
		const row = splitRow(source[index]);
		assert.equal(
			row.length,
			headers.length,
			`${label} row "${plainCell(row[0] ?? "")}" has ${row.length} cells; the header declares ${headers.length}`,
		);
		rows.push(row);
	}
	assert.ok(rows.length > 0, `${label} table has no rows`);
	return { headers, rows };
}

function columnIndex(table: Table, pattern: RegExp, label: string): number {
	const index = table.headers.findIndex((header) => pattern.test(header));
	assert.notEqual(
		index,
		-1,
		`${label} table has no column matching ${pattern}; headers are: ${table.headers.join(" | ")}`,
	);
	return index;
}

/**
 * Expands `RP-02–RP-18` ranges alongside plain comma-separated ids. Ranges stay
 * numeric-only: the lookaheads keep `RP-01A` out of a range endpoint so a list
 * like `RP-01A, RP-02–RP-18` parses as the insertion plus the expanded range.
 */
function parseDependencies(value: string): string[] {
	const ids = new Set<string>();
	const range = /RP-(\d{2})(?![A-Z])\s*[–—-]\s*RP-(\d{2})(?![A-Z])/gu;
	for (const match of value.matchAll(range)) {
		for (let number = Number(match[1]); number <= Number(match[2]); number += 1) ids.add(packageId(number));
	}
	for (const match of value.replace(range, " ").matchAll(/RP-(\d{2})([A-Z]?)/gu)) {
		ids.add(packageId(Number(match[1]), match[2]));
	}
	return [...ids].sort();
}

async function remediationPackages(): Promise<RemediationPackage[]> {
	const source = await documentLines(activePlan);
	const packages: RemediationPackage[] = [];
	for (let index = 0; index < source.length; index += 1) {
		const line = source[index];
		const heading = /^##\s+RP-(\d{2})([A-Z]?)\s/u.exec(line);
		if (heading !== null) {
			packages.push({
				id: packageId(Number(heading[1]), heading[2]),
				number: Number(heading[1]),
				suffix: heading[2],
				line: index + 1,
				dependsOn: [],
				ownsGaps: [],
			});
			continue;
		}
		if (packages.length === 0) continue;
		const current = packages[packages.length - 1];
		const dependsOn = /^\*\*Depends on:\*\*(.*)$/u.exec(line);
		if (dependsOn !== null) {
			current.dependsOn = parseDependencies(dependsOn[1]);
			continue;
		}
		const ownsGaps = /^\*\*Owns gaps:\*\*(.*)$/u.exec(line);
		if (ownsGaps !== null) {
			current.ownsGaps = [...ownsGaps[1].matchAll(/[A-Z]+-\d{2}/gu)].map((match) => match[0]);
		}
	}
	assert.ok(packages.length > 1, `${activePlan} declares no remediation packages`);
	return packages;
}

async function gapRegister(): Promise<Map<string, string>> {
	const section = sectionLines(await documentLines(remediationResearch), /^##\s+Confirmed gap register\s*$/u);
	const table = firstTable(section, "gap register");
	const gap = columnIndex(table, /^gap$/u, "gap register");
	const owner = columnIndex(table, /^owner$/u, "gap register");
	const register = new Map<string, string>();
	for (const row of table.rows) {
		const id = plainCell(row[gap]);
		assert.match(id, gapIdPattern, `gap register lists a malformed gap id "${row[gap]}"`);
		assert.ok(!register.has(id), `gap ${id} is registered twice`);
		register.set(id, plainCell(row[owner]));
	}
	return register;
}

async function gateRecords(path: string): Promise<Map<string, GateRecord>> {
	const section = sectionLines(await documentLines(path), /^##\s+`NEEDS_HUMAN`.*gates\s*$/u);
	const label = `${path} NEEDS_HUMAN gate`;
	const table = firstTable(section, label);
	const id = columnIndex(table, /^id$/u, label);
	const status = columnIndex(table, /^status$/u, label);
	const human = columnIndex(table, /decided by|deciding human|^human$/u, label);
	const date = columnIndex(table, /decided on|decision date|^date$/u, label);
	const decision = columnIndex(table, /selected|recorded decision/u, label);
	const aligned = columnIndex(table, /aligned/u, label);

	const records = new Map<string, GateRecord>();
	for (const row of table.rows) {
		const gate = plainCell(row[id]);
		assert.match(gate, /^NH-\d{2}$/u, `${label} table lists a malformed gate id "${row[id]}"`);
		assert.ok(!records.has(gate), `${label} ${gate} is recorded twice`);
		records.set(gate, {
			status: plainCell(row[status]),
			human: plainCell(row[human]),
			date: plainCell(row[date]),
			decision: row[decision].trim(),
			aligned: row[aligned].trim(),
		});
	}
	assert.deepEqual(
		[...records.keys()].sort(),
		[...gateIds],
		`${label} table must record exactly ${gateIds.join(", ")}`,
	);
	return records;
}

test("every routing surface resolves its next step to the active remediation plan", async () => {
	for (const surface of routingSurfaces) {
		const pointers = await pointersTo(surface, planBasename);
		assert.ok(pointers.length > 0, `${surface} never points at ${planBasename}`);

		const misrouted = pointers
			.filter((pointer) => pointer.resolved !== activePlan)
			.map((pointer) => `${surface}:${pointer.line}: "${pointer.raw}" resolves to ${pointer.resolved ?? "nothing"}`);
		assert.deepEqual(misrouted, [], `every ${planBasename} pointer must resolve to ${activePlan}`);

		const nextSteps = proseLines(await documentLines(surface)).filter(
			({ text, number }) =>
				activityMarker.test(text) &&
				pointers.some((pointer) => pointer.line === number && pointer.resolved === activePlan),
		);
		assert.ok(nextSteps.length > 0, `${surface} has no next-step pointer resolving to ${activePlan}`);
	}
});

test("historical build records are demoted before their original instructions", async () => {
	for (const record of historicalRecords) {
		const source = await documentLines(record);
		const banner = source.findIndex((line) => line.includes("STATUS: HISTORICAL"));
		const firstSection = source.findIndex((line) => /^##\s/u.test(line));
		const firstCheckbox = source.findIndex((line) => checkbox.test(line));
		assert.notEqual(banner, -1, `${record} must carry a STATUS: HISTORICAL banner`);
		assert.notEqual(firstSection, -1, `${record} must preserve its original sections`);
		assert.notEqual(firstCheckbox, -1, `${record} must preserve its original checkboxes`);
		assert.ok(
			banner < firstSection,
			`${record} banner is on line ${banner + 1} but its first section starts on line ${firstSection + 1}`,
		);
		assert.ok(
			banner < firstCheckbox,
			`${record} banner is on line ${banner + 1} but its first checkbox is on line ${firstCheckbox + 1}`,
		);
		assert.ok(
			source.some((line) => checkedBox.test(line)),
			`${record} must preserve its historical checked boxes`,
		);

		const directory = directoryOf(record);
		const preamble = source.slice(0, firstSection);
		const redirects: (string | null)[] = [];
		for (const { text } of proseLines(preamble)) {
			const { destinations, inlineCode } = pointersIn(text);
			for (const raw of destinations) {
				if (raw.endsWith(planBasename)) redirects.push(await resolvePointer(directory, raw, false));
			}
			for (const raw of inlineCode) {
				if (raw.endsWith(planBasename)) redirects.push(await resolvePointer(directory, raw, true));
			}
		}
		assert.ok(
			redirects.includes(activePlan),
			`${record} banner must redirect to ${activePlan}; it resolved ${JSON.stringify(redirects)}`,
		);
	}

	for (const surface of routingSurfaces) {
		const undemoted = proseLines(await documentLines(surface))
			.filter(({ text }) => historicalFilename.test(text) && !supersessionMarker.test(text))
			.map(({ text, number }) => `${surface}:${number}: ${text.trim()}`);
		assert.deepEqual(undemoted, [], `${surface} must mark every roadmap/implementation-plan reference as historical`);
	}
});

test("every registered gap is owned by exactly one remediation package", async () => {
	const register = await gapRegister();
	const packages = await remediationPackages();

	const owners = new Map<string, string[]>();
	for (const entry of packages) {
		for (const gap of entry.ownsGaps) {
			owners.set(gap, [...(owners.get(gap) ?? []), entry.id]);
		}
	}

	const unowned = [...register.keys()]
		.filter((gap) => (owners.get(gap) ?? []).length !== 1)
		.map((gap) => `${gap} owned by [${(owners.get(gap) ?? []).join(", ")}]`);
	assert.deepEqual(unowned, [], `${activePlan} must give every registered gap exactly one "Owns gaps" occurrence`);

	const unregistered = [...owners.keys()].filter((gap) => !register.has(gap));
	assert.deepEqual(unregistered, [], `${activePlan} owns gaps that the research register does not define`);

	const disagreements = [...register.entries()]
		.filter(([gap, owner]) => (owners.get(gap) ?? [])[0] !== owner)
		.map(([gap, owner]) => `${gap}: register says ${owner}, plan says ${(owners.get(gap) ?? [])[0]}`);
	assert.deepEqual(disagreements, [], "the research register Owner column must stay one-to-one with the plan");

	const prefixes = [...new Set([...register.keys()].map((gap) => gap.split("-")[0]))];
	const gapToken = new RegExp(String.raw`\b(?:${prefixes.join("|")})-\d+`, "gu");
	const strays = new Set<string>();
	for (const line of await documentLines(remediationResearch)) {
		for (const match of line.matchAll(gapToken)) {
			if (!register.has(match[0])) strays.add(match[0]);
		}
	}
	assert.deepEqual([...strays], [], `${remediationResearch} names gap ids that are absent from the register`);
});

test("remediation package ids are unique and every dependency names an existing lower package", async () => {
	const packages = await remediationPackages();
	const ids = packages.map((entry) => entry.id);
	assert.deepEqual(
		ids.filter((id, index) => ids.indexOf(id) !== index),
		[],
		`${activePlan} declares a duplicate package id`,
	);

	const known = new Set(ids);
	const violations: string[] = [];
	for (const entry of packages) {
		if (entry.number === 0 && entry.suffix === "") {
			if (entry.dependsOn.length > 0) {
				violations.push(`${entry.id} (line ${entry.line}) must not depend on any package`);
			}
			continue;
		}
		if (entry.dependsOn.length === 0) {
			violations.push(`${entry.id} (line ${entry.line}) declares no dependency`);
		}
		for (const dependency of entry.dependsOn) {
			if (!known.has(dependency)) {
				violations.push(`${entry.id} depends on ${dependency}, which no package declares`);
			} else if (packageOrder(dependency) >= packageOrder(entry.id)) {
				violations.push(`${entry.id} depends on ${dependency}, which is not a lower package`);
			}
		}
	}
	assert.deepEqual(violations, [], `${activePlan} dependencies must name existing lower packages`);
});

test("every NEEDS_HUMAN gate is closed with complete decision metadata", async () => {
	const planGates = await gateRecords(activePlan);
	const researchGates = await gateRecords(remediationResearch);

	for (const [path, gates] of [
		[activePlan, planGates],
		[remediationResearch, researchGates],
	] as const) {
		for (const gate of gateIds) {
			const record = required(gates.get(gate), `${path} does not record ${gate}`);
			assert.equal(record.status, "CLOSED", `${path} ${gate} must be CLOSED before RP-00 can complete`);
			assert.ok(isRecorded(record.human), `${path} ${gate} must name the deciding human`);
			assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/u, `${path} ${gate} must record an ISO decision date`);
			assert.ok(isRecorded(record.decision), `${path} ${gate} must record the selected decision`);
			assert.ok(
				isRecorded(record.aligned) && /[\w-]+\.md/u.test(record.aligned),
				`${path} ${gate} must name the aligned normative files`,
			);
		}
	}

	for (const gate of gateIds) {
		const inPlan = required(planGates.get(gate), `${activePlan} does not record ${gate}`);
		const inResearch = required(researchGates.get(gate), `${remediationResearch} does not record ${gate}`);
		assert.deepEqual(
			{ status: inResearch.status, human: inResearch.human, date: inResearch.date },
			{ status: inPlan.status, human: inPlan.human, date: inPlan.date },
			`${gate} must be recorded identically in the plan and the research register`,
		);
	}

	const dod = sectionLines(sectionLines(await documentLines(activePlan), /^##\s+RP-00\s/u), /^###\s+DoD\s*$/u).filter(
		(line) => checkbox.test(line),
	);
	assert.ok(dod.length > 0, "RP-00 must declare DoD checkboxes");

	const open = [...planGates].filter(([, record]) => record.status !== "CLOSED").map(([gate]) => gate);
	if (open.length > 0) {
		assert.deepEqual(
			dod.filter((line) => checkedBox.test(line)),
			[],
			`RP-00 DoD must stay unchecked while ${open.join(", ")} remain open`,
		);
	}
});

test("the project contract is the only file that carries project rules", async () => {
	const contract = await documentLines(projectContract);
	const owned = contract.filter((line) => normativeHeading.test(line));
	assert.ok(
		owned.length >= 3,
		`${projectContract} must own the normative sections; it has ${owned.length}: ${owned.join(" / ")}`,
	);

	for (const surface of routingSurfaces) {
		if (surface === projectContract) continue;
		const duplicated = proseLines(await documentLines(surface))
			.filter(({ text }) => normativeHeading.test(text))
			.map(({ text, number }) => `${surface}:${number}: ${text.trim()}`);
		assert.deepEqual(
			duplicated,
			[],
			`only ${projectContract} may own a normative section heading; a second copy drifts from the first`,
		);
	}
});

test("docs pointers redirect and restate nothing", async () => {
	for (const [surface, target] of Object.entries(pointerSurfaces)) {
		const source = await documentLines(surface);
		const body = source.filter((line) => line.trim() !== "");
		assert.ok(body.length <= 12, `${surface} is a pointer, not a copy, but carries ${body.length} non-empty lines`);

		const found = await pointersTo(surface, target.slice(target.lastIndexOf("/") + 1));
		const landed = found.map((pointer) => pointer.resolved);
		assert.ok(
			landed.includes(target),
			`${surface} must resolve a pointer to ${target}; it resolved ${JSON.stringify(landed)}`,
		);

		const restated = proseLines(source)
			.filter(({ text }) => restatedRule.test(text))
			.map(({ text, number }) => `${surface}:${number}: ${text.trim()}`);
		assert.deepEqual(restated, [], `${surface} must not restate a rule that lives in ${target}`);
	}
});

test("only the active queue names the current package", async () => {
	for (const surface of [...routingSurfaces, featureAcceptance]) {
		if (surface === activePlan) continue;
		const claims = proseLines(await documentLines(surface))
			.filter(({ text }) => currentPackageClaims.some((pattern) => pattern.test(text)))
			.map(({ text, number }) => `${surface}:${number}: ${text.trim()}`);
		assert.deepEqual(
			claims,
			[],
			`${surface} must name ${activePlan} and let it say which package is current, not pin one itself`,
		);
	}
});

test("feature acceptance is routed from the contract and the final package, and is not a second queue", async () => {
	const source = await documentLines(featureAcceptance);

	for (const surface of [projectContract, activePlan]) {
		const pointers = await pointersTo(surface, acceptanceBasename);
		const landed = pointers.filter((pointer) => pointer.resolved === featureAcceptance);
		assert.ok(landed.length > 0, `${surface} must point at ${featureAcceptance}`);
	}

	const finalPackage = sectionLines(await documentLines(activePlan), /^##\s+RP-19\s/u);
	assert.ok(
		finalPackage.some((line) => line.includes(acceptanceBasename)),
		`RP-19 must hand off to ${featureAcceptance}; nothing else runs after it`,
	);
	const productDoD = sectionLines(
		await documentLines(activePlan),
		/^##\s+Definition of done for the whole product\s*$/u,
	);
	assert.ok(
		productDoD.some((line) => line.includes(acceptanceBasename)),
		`the whole-product definition of done must require ${featureAcceptance}`,
	);

	const packages = source.filter((line) => /^##\s+RP-\d{2}/u.test(line));
	assert.deepEqual(packages, [], `${featureAcceptance} is acceptance, not a work queue; it declares no RP packages`);

	const usurped = proseLines(source)
		.filter(({ text }) => authorityClaim.test(text) && !text.includes(planBasename))
		.map(({ text, number }) => `${featureAcceptance}:${number}: ${text.trim()}`);
	assert.deepEqual(
		usurped,
		[],
		`${featureAcceptance} may only use queue-authority wording while naming ${planBasename} on the same line`,
	);

	const misrouted = (await pointersTo(featureAcceptance, planBasename))
		.filter((pointer) => pointer.resolved !== activePlan)
		.map(
			(pointer) =>
				`${featureAcceptance}:${pointer.line}: "${pointer.raw}" resolves to ${pointer.resolved ?? "nothing"}`,
		);
	assert.deepEqual(
		misrouted,
		[],
		`every ${planBasename} pointer in ${featureAcceptance} must resolve to ${activePlan}`,
	);
});

test("every product story has exactly one acceptance row owned by a real package", async () => {
	const source = await documentLines(featureAcceptance);
	const declaredPackages = new Set((await remediationPackages()).map((entry) => entry.id));

	const rows = new Map<string, { row: string; line: number }>();
	for (let index = 0; index < source.length; index += 1) {
		const heading = /^###\s+UAT-(\d{2})\s+[—-]\s+US-(\d{2})\b/u.exec(source[index]);
		if (heading === null) continue;
		const [, rowNumber, storyNumber] = heading;
		assert.equal(
			rowNumber,
			storyNumber,
			`${featureAcceptance}:${index + 1}: UAT-${rowNumber} must accept US-${rowNumber}, not US-${storyNumber}`,
		);
		const story = `US-${storyNumber}`;
		assert.ok(!rows.has(story), `${story} has more than one acceptance row`);
		rows.set(story, { row: `UAT-${rowNumber}`, line: index + 1 });
	}

	const stories = await documentLines("docs/PRD.md");
	const declaredStories = stories
		.map((line) => /^###\s+(US-\d{2})\s/u.exec(line)?.[1])
		.filter((story): story is string => story !== undefined);
	assert.ok(declaredStories.length > 0, "docs/PRD.md declares no user stories");
	assert.deepEqual(
		[...rows.keys()].sort(),
		[...declaredStories].sort(),
		`${featureAcceptance} must carry exactly one row per PRD story`,
	);

	for (const [story, { row, line }] of rows) {
		const body = source.slice(line, line + 12);
		const owner = body.find((text) => /\*\*Owner:\*\*/u.test(text));
		assert.ok(owner !== undefined, `${row} (${story}) must name an owning package`);
		const owners = [...owner.matchAll(/RP-(\d{2})([A-Z]?)/gu)].map((match) => packageId(Number(match[1]), match[2]));
		assert.ok(owners.length > 0, `${row} (${story}) names no RP owner: ${owner.trim()}`);
		const unknown = owners.filter((id) => !declaredPackages.has(id));
		assert.deepEqual(unknown, [], `${row} (${story}) names ${unknown.join(", ")}, absent from ${activePlan}`);
	}
});

test("every PRD success metric has an acceptance row", async () => {
	const source = await documentLines(featureAcceptance);
	const metrics = sectionLines(await documentLines("docs/PRD.md"), /^##\s+\d+\.\s+Success metrics\s*$/u);
	const table = firstTable(metrics, "PRD success metrics");
	const id = columnIndex(table, /^id$/u, "PRD success metrics");

	const missing = table.rows
		.map((row) => plainCell(row[id]))
		.filter((metric) => !source.some((line) => line.includes(metric)));
	assert.deepEqual(missing, [], `${featureAcceptance} must carry a row for every PRD success metric`);
});
