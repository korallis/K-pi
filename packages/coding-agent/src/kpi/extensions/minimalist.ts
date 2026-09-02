import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Task } from "./run-store.ts";

/**
 * Documented efficiency-ladder vocabulary from `docs/minimalist.md`.
 * Stop at the first rung that holds; the candidate must name one of these.
 */
export const LADDER_RUNGS = [
	"yagni",
	"reuse",
	"standard-library",
	"native-platform",
	"existing-dependency",
	"one-liner",
	"minimum-code",
] as const;

export type LadderRung = (typeof LADDER_RUNGS)[number];

export interface LadderDecision {
	ladder: LadderRung;
	/** What was used (existing path, stdlib symbol, expression, …). Non-empty. */
	used: string;
	/** What was deliberately not built. Non-empty. */
	skipped: string;
}

/** One path the implementer touched relative to the job baseline. */
export interface ObservedChange {
	path: string;
	kind: "added" | "modified" | "deleted";
	/** File text after the change when still present. */
	after?: string;
	/** File text before the change when it existed at baseline. */
	before?: string;
}

interface PackageDocument {
	dependencies?: Record<string, string>;
}

const RUNG_SET = new Set<string>(LADDER_RUNGS);

const FUNCTION_PATTERN = /\b(?:export\s+)?(?:async\s+)?function\b|\b(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/u;
const CLASS_PATTERN = /\b(?:export\s+)?(?:abstract\s+)?class\b/u;
const ABSTRACTION_PATTERN = /\b(?:export\s+)?(?:interface|type|abstract\s+class|enum)\b|\bextends\b|\bimplements\b/u;

function meaningfulText(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new Error(`candidate.json.ladder.${field} must be a non-empty string`);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`candidate.json.ladder.${field} must be a non-empty string`);
	}
	if (/^(n\/?a|none|todo|tbd|\.+|-)$/i.test(trimmed)) {
		throw new Error(`candidate.json.ladder.${field} must name a real decision, not ${JSON.stringify(trimmed)}`);
	}
	return trimmed;
}

function normalizeRung(raw: unknown): LadderRung {
	if (typeof raw !== "string") {
		throw new Error("candidate.json.ladder must name a known rung");
	}
	const rung = raw
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-");
	if (!RUNG_SET.has(rung)) {
		throw new Error(`unknown ladder rung ${JSON.stringify(raw)}; expected one of ${LADDER_RUNGS.join(", ")}`);
	}
	return rung as LadderRung;
}

/**
 * Parse and validate the ladder decision shape. Presence alone is not enough:
 * rung vocabulary, used, and skipped are all required and meaningful.
 */
export function parseLadderDecision(candidate: unknown): LadderDecision {
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
		throw new Error("candidate.json.ladder is required before implementation");
	}
	const root = candidate as Record<string, unknown>;
	let ladderRaw: unknown = root.ladder;
	let usedRaw: unknown = root.used;
	let skippedRaw: unknown = root.skipped;
	if (ladderRaw !== undefined && typeof ladderRaw === "object" && ladderRaw !== null && !Array.isArray(ladderRaw)) {
		const nested = ladderRaw as Record<string, unknown>;
		ladderRaw = nested.ladder ?? nested.rung ?? nested.name;
		usedRaw = nested.used ?? usedRaw;
		skippedRaw = nested.skipped ?? skippedRaw;
	}
	if (ladderRaw === undefined) {
		throw new Error("candidate.json.ladder is required before implementation");
	}
	return {
		ladder: normalizeRung(ladderRaw),
		used: meaningfulText(usedRaw, "used"),
		skipped: meaningfulText(skippedRaw, "skipped"),
	};
}

function stripStringsAndComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/.*$/gm, "$1")
		.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
}

function splitLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n");
	if (normalized.length === 0) return [];
	const parts = normalized.split("\n");
	if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}

function countMatches(source: string, pattern: RegExp): number {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	return [...source.matchAll(new RegExp(pattern.source, flags))].length;
}

/**
 * True when `after` is `before` with exactly one line replaced, inserted, or deleted.
 * Equal-length multi-line rewrites fail even when net line count is unchanged.
 */
export function isSingleLineEdit(before: string, after: string): boolean {
	const left = splitLines(before);
	const right = splitLines(after);
	if (left.length === right.length) {
		let differing = 0;
		for (let index = 0; index < left.length; index += 1) {
			if (left[index] !== right[index]) differing += 1;
		}
		return differing === 1;
	}
	if (Math.abs(left.length - right.length) !== 1) return false;
	const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
	let shortIndex = 0;
	let longIndex = 0;
	let skipped = 0;
	while (shortIndex < shorter.length && longIndex < longer.length) {
		if (shorter[shortIndex] === longer[longIndex]) {
			shortIndex += 1;
			longIndex += 1;
			continue;
		}
		skipped += 1;
		longIndex += 1;
		if (skipped > 1) return false;
	}
	skipped += longer.length - longIndex;
	return skipped === 1 && shortIndex === shorter.length;
}

interface StructureSignals {
	addedPaths: string[];
	deletedPaths: string[];
	modifiedPaths: string[];
	addedFunctions: boolean;
	addedClasses: boolean;
	addedAbstraction: boolean;
}

function analyzeStructure(changes: readonly ObservedChange[]): StructureSignals {
	const addedPaths = changes.filter((c) => c.kind === "added").map((c) => c.path);
	const deletedPaths = changes.filter((c) => c.kind === "deleted").map((c) => c.path);
	const modifiedPaths = changes.filter((c) => c.kind === "modified").map((c) => c.path);
	let addedFunctions = false;
	let addedClasses = false;
	let addedAbstraction = false;

	for (const change of changes) {
		if (change.kind === "deleted") continue;
		const afterMasked = stripStringsAndComments(change.after ?? "");
		const beforeMasked = stripStringsAndComments(change.before ?? "");
		if (countMatches(afterMasked, FUNCTION_PATTERN) > countMatches(beforeMasked, FUNCTION_PATTERN)) {
			addedFunctions = true;
		}
		if (countMatches(afterMasked, CLASS_PATTERN) > countMatches(beforeMasked, CLASS_PATTERN)) {
			addedClasses = true;
		}
		if (countMatches(afterMasked, ABSTRACTION_PATTERN) > countMatches(beforeMasked, ABSTRACTION_PATTERN)) {
			addedAbstraction = true;
		}
	}

	return {
		addedPaths,
		deletedPaths,
		modifiedPaths,
		addedFunctions,
		addedClasses,
		addedAbstraction,
	};
}

function pathMatchesUsedClaim(used: string, path: string): boolean {
	const claimed = used.replace(/^\.\//, "").replace(/\\/g, "/");
	const observed = path.replace(/\\/g, "/");
	return observed === claimed || observed.endsWith(`/${claimed}`) || claimed.endsWith(`/${observed}`);
}

/** Optional task/candidate context used only for provable unrequested-structure checks. */
export interface LadderMatchEvidence {
	goal?: string;
	nongoals?: readonly string[];
	constraints?: readonly string[];
}

function evidenceCorpus(decision: LadderDecision, evidence?: LadderMatchEvidence): string {
	return [
		decision.skipped,
		decision.used,
		evidence?.goal ?? "",
		...(evidence?.nongoals ?? []),
		...(evidence?.constraints ?? []),
	]
		.join("\n")
		.toLowerCase();
}

/**
 * Structure is "provably unrequested" only when task/candidate text itself
 * forbids that form — never by guessing from the ladder name alone.
 */
function structureProvablyUnrequested(
	decision: LadderDecision,
	evidence: LadderMatchEvidence | undefined,
	kind: "class" | "function" | "abstraction",
): boolean {
	const corpus = evidenceCorpus(decision, evidence);
	if (kind === "class") {
		return (
			/\b(?:no|without|avoid)\s+classes?\b/.test(corpus) ||
			/\bclasses?\s+(?:not|un)requested\b/.test(corpus) ||
			/\bskip(?:ped)?\b[^\n]{0,48}\bclass/.test(corpus)
		);
	}
	if (kind === "function") {
		return (
			/\b(?:no|without|avoid)\s+(?:new\s+)?(?:helper|function)s?\b/.test(corpus) ||
			/\bskip(?:ped)?\b[^\n]{0,48}\b(?:helper|function)/.test(corpus)
		);
	}
	return (
		/\b(?:no|without|avoid)\s+(?:new\s+)?(?:abstraction|interface|type|enum)s?\b/.test(corpus) ||
		/\bskip(?:ped)?\b[^\n]{0,48}\b(?:abstraction|interface)/.test(corpus)
	);
}

/**
 * Reject only observable contradictions between the claimed rung and the diff.
 * Stdlib/native/reuse/existing-dependency/minimum-code may add required files or
 * classes; the gate does not invent categorical bans for those rungs.
 */
export function assertLadderMatchesChanges(
	decision: LadderDecision,
	changes: readonly ObservedChange[],
	evidence?: LadderMatchEvidence,
): void {
	const signals = analyzeStructure(changes);
	const { ladder } = decision;

	if (ladder === "reuse") {
		const usedPath = decision.used.replace(/^\.\//, "");
		if (signals.addedPaths.some((path) => pathMatchesUsedClaim(usedPath, path))) {
			throw new Error(
				`ladder reuse cannot claim used=${JSON.stringify(decision.used)} when that path was just added`,
			);
		}
	}

	if (ladder === "one-liner" && changes.length > 0) {
		if (signals.addedPaths.length > 0) {
			throw new Error(`ladder one-liner forbids new files; observed ${signals.addedPaths.join(", ")}`);
		}
		if (signals.deletedPaths.length > 0) {
			throw new Error(`ladder one-liner forbids deletions; observed ${signals.deletedPaths.join(", ")}`);
		}
		if (changes.length !== 1 || signals.modifiedPaths.length !== 1) {
			const touched = [...signals.modifiedPaths, ...signals.addedPaths, ...signals.deletedPaths];
			throw new Error(
				`ladder one-liner must touch exactly one pre-existing file; observed ${touched.join(", ") || "nothing"}`,
			);
		}
		const only = changes[0];
		if (only.kind !== "modified" || only.before === undefined || only.after === undefined) {
			throw new Error("ladder one-liner requires before/after text for the single modified file");
		}
		if (signals.addedFunctions) {
			throw new Error("ladder one-liner forbids adding a function or helper");
		}
		if (signals.addedClasses) {
			throw new Error("ladder one-liner forbids adding a class");
		}
		if (signals.addedAbstraction) {
			throw new Error("ladder one-liner forbids adding an abstraction (interface/type/enum)");
		}
		if (!isSingleLineEdit(only.before, only.after)) {
			throw new Error("ladder one-liner requires an actual one-line edit, not a multi-line rewrite");
		}
	}

	// YAGNI / minimum-code: never guess. Only fail structure when the task or
	// candidate itself proves that form was unrequested.
	if (ladder === "yagni" || ladder === "minimum-code") {
		if (signals.addedClasses && structureProvablyUnrequested(decision, evidence, "class")) {
			throw new Error(`ladder ${ladder} rejects a class the candidate/task marks unrequested`);
		}
		if (signals.addedFunctions && structureProvablyUnrequested(decision, evidence, "function")) {
			throw new Error(`ladder ${ladder} rejects a helper/function the candidate/task marks unrequested`);
		}
		if (signals.addedAbstraction && structureProvablyUnrequested(decision, evidence, "abstraction")) {
			throw new Error(`ladder ${ladder} rejects an abstraction the candidate/task marks unrequested`);
		}
	}
}

async function readOptionalFile(root: string, path: string): Promise<string | undefined> {
	try {
		return await readFile(join(root, path), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Build observed changes from two content-hash snapshots plus live file reads.
 * Optional `loadBefore` (typically `git show HEAD:path`) supplies prior text.
 */
export async function observedChangesFromSnapshots(
	projectRoot: string,
	baseline: ReadonlyMap<string, string>,
	current: ReadonlyMap<string, string>,
	loadBefore?: (path: string) => Promise<string | undefined>,
): Promise<ObservedChange[]> {
	const paths = new Set<string>([...baseline.keys(), ...current.keys()]);
	const changes: ObservedChange[] = [];
	for (const path of [...paths].sort()) {
		const beforeHash = baseline.get(path);
		const afterHash = current.get(path);
		if (beforeHash === afterHash) continue;
		if (beforeHash === undefined && afterHash !== undefined) {
			changes.push({
				path,
				kind: "added",
				after: await readOptionalFile(projectRoot, path),
			});
			continue;
		}
		if (beforeHash !== undefined && afterHash === undefined) {
			changes.push({
				path,
				kind: "deleted",
				before: loadBefore ? await loadBefore(path) : undefined,
			});
			continue;
		}
		changes.push({
			path,
			kind: "modified",
			before: loadBefore ? await loadBefore(path) : undefined,
			after: await readOptionalFile(projectRoot, path),
		});
	}
	return changes;
}

/**
 * Enforce the minimalist ladder decision and the undeclared-dependency baseline.
 *
 * When `changes` is provided, the claimed rung is checked against the observed
 * delta. When omitted, only the ladder document and dependency baseline run
 * (call sites that already know no files moved should pass `[]`).
 */
export async function assertMinimalistBounds(
	projectRoot: string,
	runDirectory: string,
	task: Task,
	changes?: readonly ObservedChange[],
): Promise<void> {
	let candidate: unknown;
	try {
		candidate = JSON.parse(await readFile(join(runDirectory, "candidate.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("candidate.json.ladder is required before implementation");
		}
		throw error;
	}

	const decision = parseLadderDecision(candidate);
	if (changes !== undefined) {
		assertLadderMatchesChanges(decision, changes, {
			goal: task.goal,
			nongoals: task.nongoals,
			constraints: task.constraints,
		});
	}

	const packageDocument = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as PackageDocument;
	const baseline = new Set(task.dependency_baseline ?? []);
	const allowed = new Set(task.runtime_dependencies ?? []);
	const declared = Object.keys(packageDocument.dependencies ?? {});
	const undeclared = declared.filter((name) => !baseline.has(name) && !allowed.has(name));
	if (undeclared.length > 0) {
		throw new Error(`undeclared runtime dependencies: ${undeclared.join(", ")}`);
	}

	// These rungs claim no new package was introduced. A dep absent from the
	// baseline is a contradiction even when task.runtime_dependencies names it
	// (existing-dependency means it was already there; stdlib/native/reuse/one-liner
	// claim they did not reach for a package). minimum-code may still take a
	// task-authorized new dep when truly required.
	const forbidsNewRuntimeDependencies: LadderRung[] = [
		"reuse",
		"standard-library",
		"native-platform",
		"existing-dependency",
		"one-liner",
	];
	if (forbidsNewRuntimeDependencies.includes(decision.ladder)) {
		const introduced = declared.filter((name) => !baseline.has(name));
		if (introduced.length > 0) {
			throw new Error(
				`ladder ${decision.ladder} forbids new runtime dependencies; observed ${introduced.join(", ")}`,
			);
		}
	}
}
