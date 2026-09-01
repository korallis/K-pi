import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

const activePlan = "docs/remediation-plan.md";
const remediationResearch = "docs/remediation-research.md";
const planBasename = "remediation-plan.md";

const routingSurfaces = [
  "AGENTS.md",
  "docs/AGENTS.md",
  "START-HERE.md",
  "docs/START-HERE.md",
  "docs/BUILD-PROMPT.md",
  "docs/README.md",
  "docs/PRD.md",
] as const;

const historicalRecords = ["docs/roadmap.md", "docs/implementation-plan.md"] as const;

const gateIds = ["NH-01", "NH-02", "NH-03"] as const;

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

function packageId(value: number): string {
  return `RP-${String(value).padStart(2, "0")}`;
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

type PlanPointer = { raw: string; resolved: string | null; line: number };

/** Every way the file names `remediation-plan.md`, with where each pointer actually lands. */
async function planPointers(surface: string): Promise<PlanPointer[]> {
  const directory = directoryOf(surface);
  const pointers: PlanPointer[] = [];
  for (const { text, number } of proseLines(await documentLines(surface))) {
    const { destinations, inlineCode } = pointersIn(text);
    for (const [raws, allowRepositoryRoot] of [
      [destinations, false],
      [inlineCode, true],
    ] as const) {
      for (const raw of raws) {
        if (!raw.endsWith(planBasename)) continue;
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
  const headers = splitRow(source[headerIndex]).map((header) =>
    plainCell(header).toLowerCase().replace(/\s+/gu, " "),
  );
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

/** Expands `RP-02–RP-18` ranges alongside plain comma-separated ids. */
function parseDependencies(value: string): string[] {
  const ids = new Set<string>();
  const range = /RP-(\d{2})\s*[–—-]\s*RP-(\d{2})/gu;
  for (const match of value.matchAll(range)) {
    for (let number = Number(match[1]); number <= Number(match[2]); number += 1) ids.add(packageId(number));
  }
  for (const match of value.replace(range, " ").matchAll(/RP-(\d{2})/gu)) {
    ids.add(packageId(Number(match[1])));
  }
  return [...ids].sort();
}

async function remediationPackages(): Promise<RemediationPackage[]> {
  const source = await documentLines(activePlan);
  const packages: RemediationPackage[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const heading = /^##\s+RP-(\d{2})\s/u.exec(line);
    if (heading !== null) {
      packages.push({
        id: packageId(Number(heading[1])),
        number: Number(heading[1]),
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
    const pointers = await planPointers(surface);
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
    assert.deepEqual(
      undemoted,
      [],
      `${surface} must mark every roadmap/implementation-plan reference as historical`,
    );
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
  assert.deepEqual(
    unowned,
    [],
    `${activePlan} must give every registered gap exactly one "Owns gaps" occurrence`,
  );

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
    if (entry.number === 0) {
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
      } else if (Number(dependency.slice("RP-".length)) >= entry.number) {
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

  const dod = sectionLines(
    sectionLines(await documentLines(activePlan), /^##\s+RP-00\s/u),
    /^###\s+DoD\s*$/u,
  ).filter((line) => checkbox.test(line));
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
