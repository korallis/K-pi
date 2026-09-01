import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { CONFIG_DIR_NAME } from "../../config.ts";

import type { ExtensionCommandContext } from "../../core/extensions/types.ts";

import { appendEvent } from "./append-log.ts";
import { compileAcceptanceCriteria } from "./graph/ac-compiler.ts";
import { type GraphAgentSessionFactory, GraphEngine, loadNamedGraph } from "./graph/engine.ts";
import { type GraphRunState, isJsonObject, type JsonObject } from "./graph/schema.ts";
import {
	canonicalFingerprint,
	createStopState,
	DEFAULT_MAX_ROUNDS,
	MAX_TRANSIENT_RETRIES,
	type Sleeper,
	type StopState,
	stopFingerprint,
	type TerminalStatus,
	transitionStopState,
} from "./graph/stop.ts";
import { assertMinimalistBounds } from "./minimalist.ts";
import { isWriteAllowed } from "./policy.ts";
import { assertResearchFresh, conductResearch } from "./research/gate.ts";
import { ResearchShortfallError, resolveResearchKeys } from "./research/session.ts";
import { atomicWrite, createJob, type Task, writeAllowForTask } from "./run-store.ts";
import { readKpiSettings } from "./settings.ts";
import { readDuneStack, scaffoldModule } from "./stack.ts";

const execFile = promisify(execFileCallback);
const PLAN_FILES = ["requirements.md", "design.md", "tasks.md"] as const;
const DEFAULT_QUALITY_GATES = ["pnpm test", "pnpm lint", "pnpm typecheck"];

export const CONVENTIONAL_COMMIT_PATTERN = /^(feat|fix|docs|refactor|test|chore)(\(.+\))?: /u;

export interface LoopDependencies {
	createAgentSession?: GraphAgentSessionFactory;
	onStateChange?: () => Promise<void>;
	jobId?: string;
	/** Injected wall clock in epoch milliseconds. */
	now?: () => number;
	/** Injected accumulated job cost in USD. */
	accumulatedCostUsd?: () => number;
	/** Injected transient-retry backoff. */
	sleep?: Sleeper;
	/** First backoff step; each further retry doubles it. */
	retryBaseDelayMs?: number;
}

export interface LoopInvocation {
	goal: string;
	mode: "gated" | "autopilot";
	planPath?: string;
}

export interface LoopOutcome {
	jobId: string;
	status: TerminalStatus;
	graphState?: Readonly<GraphRunState>;
}

interface PlanFile {
	destination: string;
	source: string;
	content: string;
	fingerprint: string;
}

interface PlanSnapshot {
	label: string;
	files: PlanFile[];
}

function unwrapPath(value: string): string {
	const trimmed = value.trim();
	const quote = trimmed[0];
	return trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.at(-1) === quote
		? trimmed.slice(1, -1)
		: trimmed;
}

export function parseLoopInvocation(args: string): LoopInvocation {
	const input = args.trim();
	if (input.startsWith("--mode")) {
		const match = /^--mode\s+(\S+)(?:\s+([\s\S]+))?$/u.exec(input);
		if (match === null) {
			throw new Error("/kpi --mode requires gated or autopilot and a goal");
		}
		const mode = match[1];
		if (mode !== "gated" && mode !== "autopilot") {
			throw new Error(`/kpi --mode must be gated or autopilot, received ${mode}`);
		}
		const goal = match[2]?.trim() ?? "";
		if (goal.length === 0) {
			throw new Error(`/kpi --mode ${mode} requires a goal`);
		}
		return { goal, mode };
	}
	if (input.startsWith("--until-green")) {
		const separator = input[13];
		if (separator !== undefined && !/\s/u.test(separator)) {
			throw new Error(`Unknown /kpi option: ${input.split(/\s/u, 1)[0]}`);
		}
		const goal = input.slice(13).trim();
		if (goal.length === 0) {
			throw new Error("/kpi --until-green requires a goal");
		}
		return { goal, mode: "autopilot" };
	}
	if (input.startsWith("--plan")) {
		const separator = input[6];
		if (separator !== undefined && !/\s/u.test(separator)) {
			throw new Error(`Unknown /kpi option: ${input.split(/\s/u, 1)[0]}`);
		}
		const planPath = unwrapPath(input.slice(6));
		if (planPath.length === 0) {
			throw new Error("/kpi --plan requires a file or directory");
		}
		return {
			goal: `Implement frozen plan from ${planPath}`,
			mode: "gated",
			planPath,
		};
	}
	if (input.startsWith("--")) {
		throw new Error(`Unknown /kpi option: ${input.split(/\s/u, 1)[0]}`);
	}
	if (input.length === 0) {
		throw new Error("/kpi requires a goal");
	}
	return { goal: input, mode: "gated" };
}

function makeJobId(goal: string): string {
	const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
	const slug =
		goal
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-|-$/gu, "")
			.slice(0, 32) || "job";
	return `${date}-${slug}-${randomUUID().slice(0, 8)}`;
}

function isOutside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === ".." || path.startsWith(`..${sep}`);
}

async function snapshotPlan(projectRoot: string, requestedPath: string): Promise<PlanSnapshot> {
	const [root, source] = await Promise.all([realpath(projectRoot), realpath(resolve(projectRoot, requestedPath))]);
	if (isOutside(root, source)) {
		throw new Error("Frozen plan must be inside the project");
	}

	const metadata = await stat(source);
	const sources = metadata.isDirectory() ? PLAN_FILES.map((name) => join(source, name)) : [source];
	const files = await Promise.all(
		sources.map(async (path) => {
			const content = await readFile(path, "utf8");
			const name = basename(path);
			return {
				source: path,
				destination: join("plan", name),
				content,
				fingerprint: `sha256:${createHash("sha256").update(content).digest("hex")}`,
			};
		}),
	);
	return { label: relative(root, source), files };
}

async function qualityGates(projectRoot: string): Promise<string[]> {
	let source: string;
	try {
		source = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [...DEFAULT_QUALITY_GATES];
		}
		throw error;
	}

	const section = /^#{1,6}\s+Quality gates[^\n]*\n[\s\S]*?```(?:bash|sh)?\s*\n([\s\S]*?)```/imu.exec(source);
	if (section === null) {
		return [...DEFAULT_QUALITY_GATES];
	}
	const commands = section[1]
		.split("\n")
		.map((line) => line.trim().replace(/^\$\s*/u, ""))
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	return commands.length > 0 ? commands : [...DEFAULT_QUALITY_GATES];
}
async function runtimeDependencies(projectRoot: string): Promise<string[]> {
	try {
		const document = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		return Object.keys(document.dependencies ?? {});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function contextFor(invocation: LoopInvocation, plan?: PlanSnapshot): string {
	const lines = [`# K-π ${invocation.mode} job`, "", `Goal: ${invocation.goal}`, `Mode: ${invocation.mode}`];
	if (plan !== undefined) {
		lines.push("", `Frozen plan: ${plan.label}`);
		for (const file of plan.files) {
			lines.push("", `## ${basename(file.source)}`, "", file.content.trimEnd());
		}
	}
	return `${lines.join("\n")}\n`;
}

async function writePlanSnapshot(runDirectory: string, plan: PlanSnapshot): Promise<void> {
	for (const file of plan.files) {
		await atomicWrite(join(runDirectory, file.destination), file.content);
	}
	const fingerprints = Object.fromEntries(plan.files.map((file) => [file.destination, file.fingerprint]));
	await atomicWrite(join(runDirectory, "fingerprints.json"), `${JSON.stringify({ plan: fingerprints }, null, 2)}\n`);
}

function activeNode(state: Readonly<GraphRunState>): string {
	return state.pendingHuman?.nodeId ?? state.active[0] ?? "done";
}

function stageFor(node: string): string {
	if (node === "quality-green") {
		return "test";
	}
	if (node === "plan-check") {
		return "plan";
	}
	return node;
}

function stateDocument(
	task: Task,
	state: Readonly<GraphRunState>,
	stop: StopState,
	terminalStatus?: TerminalStatus,
	reason?: string,
): Record<string, unknown> {
	const node = activeNode(state);
	return {
		job_id: task.job_id,
		mode: task.mode,
		round: stop.round,
		maxRounds: stop.maxRounds,
		stage: stageFor(node),
		node,
		passed: isJsonObject(state.values.test) ? state.values.test.passed : undefined,
		bounds: state.values.bounds,
		review: state.values.review,
		release: state.values.release,
		ac: task.ac,
		status:
			terminalStatus ??
			(state.status === "interrupted"
				? "APPROVAL"
				: state.status === "completed"
					? "DONE"
					: state.status.toUpperCase()),
		reason,
		graph_status: state.status,
		superstep: state.superstep,
		pending_question: state.pendingHuman?.question,
		limits: state.budget.limits,
		started_at_ms: state.budget.startedAtMs,
		elapsed_ms: state.budget.elapsedMs,
		cost_usd: state.budget.costUsd,
		graph_round: state.budget.round,
		batches: state.budget.batches,
		exhausted_limit: state.terminal?.limit,
		// Stop-safety state. A resume that lost any of these would re-approve work
		// it already rejected, or retry past its budget.
		evidence_fingerprints: [...stop.evidenceFingerprints],
		output_fingerprints: [...stop.outputFingerprints],
		failing_ac_sets: [...stop.failingAcSets],
		retries: stop.retries,
		retry_delays_ms: [...stop.retryDelaysMs],
	};
}

/**
 * Persists the run and its stop state. Exported so the stop-safety contract can
 * be proven as a round trip against `restoreStopState`.
 */
export async function writeState(
	runDirectory: string,
	task: Task,
	state: Readonly<GraphRunState>,
	stop: StopState,
	terminalStatus?: TerminalStatus,
	reason?: string,
): Promise<void> {
	await atomicWrite(
		join(runDirectory, "state.json"),
		`${JSON.stringify(stateDocument(task, state, stop, terminalStatus, reason), null, 2)}\n`,
	);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Rebuilds the stop state a resumed job left behind. Every field matters: a run
 * that lost its fingerprints would re-accept output it already called stuck, and
 * one that lost its retry counter would retry past its budget.
 */
export function restoreStopState(document: Record<string, unknown>, maxRounds: number): StopState {
	const retries = typeof document.retries === "number" && Number.isInteger(document.retries) ? document.retries : 0;
	return {
		...createStopState(maxRounds),
		round: typeof document.round === "number" ? document.round : 0,
		// Normalized on the way back in, so a comparison after a resume is made on
		// the same terms the reducer used before the kill.
		evidenceFingerprints: stringArray(document.evidence_fingerprints).map(stopFingerprint),
		outputFingerprints: stringArray(document.output_fingerprints).map(stopFingerprint),
		failingAcSets: stringArray(document.failing_ac_sets),
		retries: Math.max(0, Math.min(MAX_TRANSIENT_RETRIES, retries)),
		retryDelaysMs: Array.isArray(document.retry_delays_ms)
			? document.retry_delays_ms.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
			: [],
	};
}

async function gitHead(projectRoot: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFile("git", ["rev-parse", "--verify", "HEAD"], {
			cwd: projectRoot,
		});
		return stdout.trim();
	} catch {
		return undefined;
	}
}

async function createJobBranch(projectRoot: string, jobId: string): Promise<void> {
	await execFile("git", ["switch", "-c", `kpi/${jobId}`], {
		cwd: projectRoot,
	});
}

/**
 * Trees the harness owns or that no product change can live in. Everything else
 * ignored by git - `dist/`, `coverage/`, a local `.env` - is still a real file a
 * node can write, so it stays inside the snapshot.
 */
const SNAPSHOT_EXCLUDED_TREES = ["node_modules", ".git", CONFIG_DIR_NAME] as const;

/**
 * Every path in the worktree a node could have touched, with a content hash.
 *
 * Ignored files are included on purpose: `git status` hides them by default, so
 * a write to `dist/` or `.env.local` used to be invisible to the bounds check -
 * exactly the paths a policy would refuse. The harness's own trees are excluded
 * by pathspec instead, which also keeps `node_modules` out of the hashing.
 */
async function worktreeSnapshot(projectRoot: string): Promise<Map<string, string>> {
	const { stdout } = await execFile(
		"git",
		[
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--ignored=matching",
			"--",
			".",
			...SNAPSHOT_EXCLUDED_TREES.map((tree) => `:(exclude)${tree}`),
		],
		{ cwd: projectRoot },
	);
	const records = stdout.split("\0");
	const paths = new Set<string>();
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4) {
			continue;
		}
		const status = record.slice(0, 2);
		paths.add(record.slice(3));
		if (/[RC]/u.test(status)) {
			const source = records[index + 1];
			if (source !== undefined && source.length > 0) {
				paths.add(source);
				index += 1;
			}
		}
	}

	const runsPrefix = `${CONFIG_DIR_NAME}/runs`;
	const snapshot = new Map<string, string>();
	for (const path of paths) {
		if (path === runsPrefix || path.startsWith(`${runsPrefix}/`)) {
			continue;
		}
		try {
			const content = await readFile(join(projectRoot, path));
			snapshot.set(path, createHash("sha256").update(content).digest("hex"));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				snapshot.set(path, "<absent>");
				continue;
			}
			if (code !== "EISDIR") {
				throw error;
			}
			// git reports a wholly ignored directory as one entry. Its listing is the
			// witness: a file appearing inside it is still a change to the worktree.
			const entries = (await readdir(join(projectRoot, path))).sort();
			snapshot.set(path, `<dir>${createHash("sha256").update(entries.join("\u0000")).digest("hex")}`);
		}
	}
	return snapshot;
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths].filter((path) => before.get(path) !== after.get(path));
}

/**
 * The verifier's evidence, fingerprinted canonically so reformatting the same
 * receipts cannot look like progress. Unparseable evidence falls back to its
 * bytes, which is still a stable witness of the same file.
 */
async function evidenceFingerprint(runDirectory: string): Promise<string> {
	const content = await readFile(join(runDirectory, "evidence.json"));
	try {
		return canonicalFingerprint(JSON.parse(content.toString("utf8")));
	} catch {
		return `sha256:${createHash("sha256").update(content).digest("hex")}`;
	}
}

/**
 * The acceptance criteria the latest evidence reports as failing. Order does not
 * matter: the stop reducer canonicalizes the set, so the same failures found in
 * a different order are the same set.
 */
async function failingAcIds(runDirectory: string): Promise<string[]> {
	let evidence: unknown;
	try {
		evidence = JSON.parse(await readFile(join(runDirectory, "evidence.json"), "utf8"));
	} catch {
		return [];
	}
	if (!isJsonObject(evidence) || !Array.isArray(evidence.ac_results)) {
		return [];
	}
	return evidence.ac_results.flatMap((result) =>
		isJsonObject(result) && typeof result.id === "string" && result.passed !== true ? [result.id] : [],
	);
}

function reviewFingerprint(state: Readonly<GraphRunState>): string | undefined {
	const review = state.values.review;
	if (!isJsonObject(review)) {
		return undefined;
	}
	return typeof review.output_fingerprint === "string" ? review.output_fingerprint : undefined;
}

function reviewApproved(state: Readonly<GraphRunState>): boolean {
	const review = state.values.review;
	return isJsonObject(review) && review.approved === true;
}

function _reviewStatus(state: Readonly<GraphRunState>): string | undefined {
	const review = state.values.review;
	return isJsonObject(review) && typeof review.status === "string" ? review.status : undefined;
}

function evidencePasses(task: Task, evidence: unknown): boolean {
	if (!isJsonObject(evidence)) {
		return false;
	}
	const commands = evidence.commands;
	const acResults = evidence.ac_results;
	if (!Array.isArray(commands) || !Array.isArray(acResults)) {
		return false;
	}
	const latestCommandExit = new Map<string, number>();
	for (const command of commands) {
		if (isJsonObject(command) && typeof command.cmd === "string" && typeof command.exit === "number") {
			latestCommandExit.set(command.cmd, command.exit);
		}
	}
	if (latestCommandExit.size === 0 || [...latestCommandExit.values()].some((exit) => exit !== 0)) {
		return false;
	}
	const passedIds = new Set(
		acResults.flatMap((result) =>
			isJsonObject(result) && typeof result.id === "string" && result.passed === true ? [result.id] : [],
		),
	);
	return task.acceptance.filter((criterion) => criterion.required).every((criterion) => passedIds.has(criterion.id));
}

/**
 * Whether this job was started from a frozen plan. The snapshot on disk is the
 * record, so a resumed run routes past the specification step exactly as the
 * original did.
 */
async function planWasProvided(jobDirectory: string): Promise<boolean> {
	try {
		return (await readdir(join(jobDirectory, "plan"))).length > 0;
	} catch {
		return false;
	}
}

/** The durable record that this job's commit decision was already made. */
interface ShipMarker {
	job_id: string;
	head: string;
	subject: string;
	at: string;
}

function shipMarkerPath(jobDirectory: string): string {
	return join(jobDirectory, "ship.json");
}

/** The trailer that binds a commit to the job that decided to make it. */
export const SHIP_TRAILER_NAME = "KPI-Job";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

/** The marker's shape. Anything else is not this control plane's record. */
function parseShipMarker(value: unknown): ShipMarker | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}
	const { job_id: jobId, head, subject, at } = value;
	if (typeof jobId !== "string" || jobId.length === 0) return undefined;
	if (typeof head !== "string" || !COMMIT_SHA_PATTERN.test(head)) return undefined;
	if (typeof subject !== "string" || subject.length === 0) return undefined;
	if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
	if (Object.keys(value).length !== 4) return undefined;
	return { job_id: jobId, head, subject, at };
}

interface ShipCommit {
	head: string;
	subject: string;
}

async function commitsSince(
	projectRoot: string,
	previousHead: string | undefined,
): Promise<{ head: string; subject: string; body: string }[]> {
	const range = previousHead === undefined ? "HEAD" : `${previousHead}..HEAD`;
	let stdout: string;
	try {
		({ stdout } = await execFile("git", ["log", range, "--format=%H%x1f%s%x1f%B%x1e"], { cwd: projectRoot }));
	} catch {
		return [];
	}
	return stdout
		.split("\u001e")
		.map((record) => record.replace(/^\n/u, ""))
		.filter((record) => record.length > 0)
		.map((record) => {
			const [head, subject, body] = record.split("\u001f");
			return { head: head ?? "", subject: subject ?? "", body: body ?? "" };
		});
}

/** Whether a commit message carries this job's trailer on a line of its own. */
function carriesJobTrailer(body: string, jobId: string): boolean {
	return body.split(/\r?\n/u).some((line) => line.trimEnd() === `${SHIP_TRAILER_NAME}: ${jobId}`);
}

async function isAncestorOfHead(projectRoot: string, head: string): Promise<boolean> {
	try {
		await execFile("git", ["merge-base", "--is-ancestor", head, "HEAD"], { cwd: projectRoot });
		return true;
	} catch {
		return false;
	}
}

/**
 * This job's commit, identified by its own trailer rather than by HEAD having
 * moved. Unrelated commits - a hook, a concurrent operator, a later fix - are
 * not this job's decision and must never let a job skip shipping.
 *
 * Fails closed on ambiguity: two commits claiming the same job id mean nobody
 * can say which decision was recorded.
 */
export async function findJobCommit(
	projectRoot: string,
	jobId: string,
	previousHead: string | undefined,
): Promise<ShipCommit | undefined> {
	const marked = (await commitsSince(projectRoot, previousHead)).filter((commit) =>
		carriesJobTrailer(commit.body, jobId),
	);
	if (marked.length === 0) {
		return undefined;
	}
	if (marked.length > 1) {
		throw new Error(
			`Ambiguous ship commits for ${jobId}: ${marked.map((commit) => commit.head.slice(0, 8)).join(", ")}`,
		);
	}
	const [commit] = marked;
	if (!CONVENTIONAL_COMMIT_PATTERN.test(commit.subject)) {
		throw new Error(`Ship commit is not Conventional Commits: ${commit.subject}`);
	}
	if (!(await isAncestorOfHead(projectRoot, commit.head))) {
		throw new Error(`Ship commit ${commit.head.slice(0, 8)} is not an ancestor of HEAD`);
	}
	return { head: commit.head, subject: commit.subject };
}

/**
 * The marker only counts when it still describes a real commit of this job. A
 * marker that is malformed, names another job, or disagrees with the commit it
 * claims is not evidence - and must not let a job skip shipping.
 */
async function readShipMarker(
	projectRoot: string,
	jobDirectory: string,
	jobId: string,
): Promise<ShipMarker | undefined> {
	let parsed: ShipMarker | undefined;
	try {
		parsed = parseShipMarker(JSON.parse(await readFile(shipMarkerPath(jobDirectory), "utf8")));
	} catch {
		return undefined;
	}
	if (parsed === undefined || parsed.job_id !== jobId) {
		return undefined;
	}
	const commits = await commitsSince(projectRoot, undefined);
	const claimed = commits.find((commit) => commit.head === parsed.head);
	if (
		claimed === undefined ||
		claimed.subject !== parsed.subject ||
		!carriesJobTrailer(claimed.body, jobId) ||
		!(await isAncestorOfHead(projectRoot, parsed.head))
	) {
		return undefined;
	}
	return parsed;
}

async function startingHeadFor(jobDirectory: string): Promise<string | undefined> {
	try {
		return (await readFile(join(jobDirectory, "previous-head.txt"), "utf8")).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether this job has already made its one commit decision.
 *
 * Checkpoints are at-least-once, so a replay has to be able to tell that the
 * commit already happened. The evidence is this job's own trailer: the validated
 * marker, or the commit carrying `KPI-Job: <job id>` in the range the job owns.
 *
 * HEAD having moved is deliberately not evidence. Any unrelated commit - a hook,
 * a concurrent operator, a later fix - would otherwise let a job skip shipping
 * and be accepted as DONE without ever having committed its own work.
 */
async function alreadyShipped(projectRoot: string, jobDirectory: string, jobId: string): Promise<boolean> {
	if ((await readShipMarker(projectRoot, jobDirectory, jobId)) !== undefined) {
		return true;
	}
	try {
		return (await findJobCommit(projectRoot, jobId, await startingHeadFor(jobDirectory))) !== undefined;
	} catch {
		// Ambiguous or malformed history: fail closed. The run does not get to
		// claim it shipped, and finalization will report why.
		return false;
	}
}

/**
 * Records the commit decision durably. Called after the ship node has run and
 * its commit has been verified, so a later replay sees the decision instead of
 * repeating it.
 */
async function writeShipMarker(
	projectRoot: string,
	jobDirectory: string,
	jobId: string,
	subject: string,
	head?: string,
): Promise<void> {
	// The marker names the commit that was verified, not whatever HEAD happens to
	// be when the record is written.
	const recorded = head ?? (await gitHead(projectRoot));
	if (recorded === undefined) {
		return;
	}
	const marker: ShipMarker = { job_id: jobId, head: recorded, subject, at: new Date().toISOString() };
	await atomicWrite(shipMarkerPath(jobDirectory), `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * The facts the topology routes on, and the detail behind them.
 *
 * These are the things only the driver can establish: whether a frozen plan was
 * supplied, whether the receipts on disk actually pass the task's required
 * acceptance criteria, whether every change stayed inside the declared bounds,
 * whether the evidence still describes the current HEAD, and whether this job
 * already committed. The graph reads them as data; nothing here decides where
 * the run goes next.
 */
interface LoopFacts {
	resolve: () => Promise<JsonObject>;
	/** Why bounds were last judged broken, for the terminal record. */
	boundsReason: () => string | undefined;
}

function loopFacts(
	projectRoot: string,
	jobDirectory: string,
	task: Task,
	baseline: ReadonlyMap<string, string>,
	planProvided: boolean,
): LoopFacts {
	let boundsReason: string | undefined;
	return {
		boundsReason: () => boundsReason,
		resolve: async (): Promise<JsonObject> => {
			let evidence: unknown;
			try {
				evidence = JSON.parse(await readFile(join(jobDirectory, "evidence.json"), "utf8"));
			} catch {
				evidence = undefined;
			}
			const testPassed = evidence !== undefined && evidencePasses(task, evidence);
			const evidenceHead = isJsonObject(evidence) && typeof evidence.head === "string" ? evidence.head : undefined;
			const fresh = evidenceHead !== undefined && evidenceHead === (await gitHead(projectRoot));

			boundsReason = undefined;
			const current = await worktreeSnapshot(projectRoot);
			const violations = changedPaths(baseline, current).filter(
				(path) => !isWriteAllowed(projectRoot, path, writeAllowForTask(task)),
			);
			if (violations.length > 0) {
				boundsReason = `write outside write_allow: ${violations.join(", ")}`;
			} else {
				try {
					await assertMinimalistBounds(projectRoot, jobDirectory, task);
				} catch (error) {
					boundsReason = error instanceof Error ? error.message : String(error);
				}
			}

			return {
				"plan.provided": planProvided,
				"test.passed": testPassed,
				"bounds.held": boundsReason === undefined,
				"fingerprints.fresh": fresh,
				"ship.shipped": await alreadyShipped(projectRoot, jobDirectory, task.job_id),
			};
		},
	};
}

interface DriveResult {
	state: Readonly<GraphRunState>;
	stopState: StopState;
	terminalStatus?: TerminalStatus;
	reason?: string;
	/**
	 * Whether the ship node ran during this pass. A run that shipped is held to
	 * the one-commit rule; a replay that recovered an earlier decision is not,
	 * because later unrelated commits are none of its business.
	 */
	shippedThisRun?: boolean;
	/** The engine already emitted the one `loop.terminal` event for this run. */
	terminalEmitted?: boolean;
}

async function driveUntilPause(
	engine: GraphEngine,
	projectRoot: string,
	jobDirectory: string,
	task: Task,
	facts: LoopFacts,
	stopState: StopState,
	onStateChange?: () => Promise<void>,
): Promise<DriveResult> {
	let state = engine.state;
	let currentStopState = stopState;
	let shippedThisRun = false;
	while (state.status === "running") {
		if (state.active.some((node) => node === "specify" || node === "plan" || node === "plan-check")) {
			try {
				await assertResearchFresh(jobDirectory, task);
			} catch {
				try {
					// The control plane owns keys, mode, budget, cooldown and events.
					await conductResearch(projectRoot, jobDirectory, task, {
						keys: await resolveResearchKeys(),
						mode: (await readKpiSettings(projectRoot)).research,
						eventsPath: join(jobDirectory, "events.jsonl"),
						round: currentStopState.round,
						node: state.active[0],
					});
				} catch (error) {
					if (!(error instanceof ResearchShortfallError)) {
						throw error;
					}
					// A healthy service that answered thinly is a human decision, per
					// AC-29.6: never a downgrade to local research.
					return {
						state,
						stopState: currentStopState,
						shippedThisRun,
						terminalStatus: "NEEDS_HUMAN",
						reason: error.message,
					};
				}
			}
		}
		if (state.active.includes("implement")) {
			try {
				await assertResearchFresh(jobDirectory, task);
				try {
					const stack = await readDuneStack(jobDirectory);
					const module = stack.modules[0];
					if (module === undefined) throw new Error("Dune stack has no current module");
					await scaffoldModule(projectRoot, module);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			} catch (error) {
				return {
					state,
					stopState: currentStopState,
					shippedThisRun,
					terminalStatus: "UNSAFE",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		}

		const completedNodes = [...state.active];
		if (completedNodes.includes("ship")) {
			// The commit decision is being made in this pass, whatever the superstep
			// goes on to do with it.
			shippedThisRun = true;
		}
		state = await engine.runSuperstep();
		if (state.status === "exhausted") {
			// The engine owns cap exhaustion end to end: it has already written the
			// durable EXHAUSTED checkpoint and the single terminal event.
			return {
				state,
				stopState: currentStopState,
				shippedThisRun,
				terminalStatus: "EXHAUSTED",
				reason: state.terminal?.reason ?? "graph exhausted a configured cap",
				terminalEmitted: true,
			};
		}
		if (state.status === "terminated") {
			// The topology routed to a terminal. The engine has written the durable
			// checkpoint and the single terminal event; the driver only supplies the
			// detail behind the fact that sent it there.
			const terminal = state.terminal;
			return {
				state,
				stopState: currentStopState,
				shippedThisRun,
				terminalStatus: terminal?.status ?? "BLOCKED",
				reason:
					terminal?.status === "UNSAFE"
						? (facts.boundsReason() ?? terminal.reason)
						: (terminal?.reason ?? "the graph routed to a terminal"),
				terminalEmitted: true,
			};
		}
		if (completedNodes.includes("review")) {
			const outputFingerprint = reviewFingerprint(state);
			if (outputFingerprint === undefined) {
				return {
					state,
					stopState: currentStopState,
					shippedThisRun,
					terminalStatus: "BLOCKED",
					reason: "review did not produce an output fingerprint",
				};
			}
			currentStopState = transitionStopState(currentStopState, {
				type: "verifier",
				passed: reviewApproved(state),
				evidenceFingerprint: await evidenceFingerprint(jobDirectory),
				outputFingerprint,
				failingAcIds: await failingAcIds(jobDirectory),
			});
			if (currentStopState.status === "NO_PROGRESS" || currentStopState.status === "EXHAUSTED") {
				return {
					state,
					stopState: currentStopState,
					shippedThisRun,
					terminalStatus: currentStopState.status,
					reason:
						currentStopState.status === "NO_PROGRESS"
							? "the same acceptance criteria failed in two rounds"
							: "maximum verifier rounds exhausted",
				};
			}
		}
		await writeState(jobDirectory, task, state, currentStopState);
		await onStateChange?.();
	}
	return { state, stopState: currentStopState, shippedThisRun };
}

async function writeTerminalState(
	jobDirectory: string,
	eventsPath: string,
	task: Task,
	result: DriveResult,
): Promise<void> {
	const status = result.terminalStatus;
	if (status === undefined) {
		return;
	}
	if (result.terminalEmitted !== true) {
		await appendEvent(eventsPath, {
			ts: new Date().toISOString(),
			type: "loop.terminal",
			job_id: task.job_id,
			round: result.stopState.round,
			node: activeNode(result.state),
			status,
			reason: result.reason,
		});
	}
	await writeState(jobDirectory, task, result.state, result.stopState, status, result.reason);
}

/**
 * Verifies the commit a ship node just made: exactly one commit, conventional
 * subject, and this job's trailer so the commit is attributable to the decision
 * that produced it.
 *
 * `jobId` is optional only so the commit-subject contract can be exercised on
 * its own; a run always passes it.
 */
export async function verifyShippedCommit(
	projectRoot: string,
	previousHead: string | undefined,
	jobId?: string,
): Promise<string> {
	const head = await gitHead(projectRoot);
	if (head === undefined || head === previousHead) {
		throw new Error("Ship node did not create a commit");
	}
	if (previousHead !== undefined) {
		const { stdout: count } = await execFile("git", ["rev-list", "--count", `${previousHead}..${head}`], {
			cwd: projectRoot,
		});
		if (count.trim() !== "1") {
			throw new Error(`Ship node created ${count.trim()} commits instead of one`);
		}
	}
	const { stdout } = await execFile("git", ["log", "-1", "--pretty=%s"], {
		cwd: projectRoot,
	});
	const subject = stdout.trim();
	if (!CONVENTIONAL_COMMIT_PATTERN.test(subject)) {
		throw new Error(`Ship commit is not Conventional Commits: ${subject}`);
	}
	if (jobId !== undefined) {
		const marked = await findJobCommit(projectRoot, jobId, previousHead);
		if (marked === undefined) {
			throw new Error(`Ship commit does not carry ${SHIP_TRAILER_NAME}: ${jobId}`);
		}
		if (marked.head !== head) {
			throw new Error(`Ship commit ${marked.head.slice(0, 8)} is not HEAD`);
		}
	}
	return subject;
}

/**
 * Records the one commit decision, whether this run made it or recovered it.
 *
 * A run that shipped in this pass is held to the one-commit rule. A replay whose
 * marker was lost finalizes the job's own marked commit instead - later
 * unrelated commits do not hide it, and nothing new is committed.
 */
async function finalizeShip(
	projectRoot: string,
	jobDirectory: string,
	jobId: string,
	previousHead: string | undefined,
	shippedThisRun: boolean,
): Promise<void> {
	if ((await readShipMarker(projectRoot, jobDirectory, jobId)) !== undefined) {
		return;
	}
	if (shippedThisRun) {
		const subject = await verifyShippedCommit(projectRoot, previousHead, jobId);
		await writeShipMarker(projectRoot, jobDirectory, jobId, subject);
		return;
	}
	const recovered = await findJobCommit(projectRoot, jobId, previousHead);
	if (recovered === undefined) {
		throw new Error(`No commit carries ${SHIP_TRAILER_NAME}: ${jobId}`);
	}
	await writeShipMarker(projectRoot, jobDirectory, jobId, recovered.subject, recovered.head);
}
export async function resumeLoop(
	jobId: string,
	ctx: ExtensionCommandContext,
	dependencies: LoopDependencies = {},
): Promise<LoopOutcome> {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(jobId)) {
		throw new Error(`Invalid job id: ${jobId}`);
	}
	const jobDirectory = join(ctx.cwd, CONFIG_DIR_NAME, "runs", jobId);
	const task = JSON.parse(await readFile(join(jobDirectory, "task.json"), "utf8")) as Task;
	const stateDocument = JSON.parse(await readFile(join(jobDirectory, "state.json"), "utf8")) as Record<
		string,
		unknown
	>;
	if (stateDocument.status === "DONE") {
		return { jobId, status: "DONE" };
	}
	const graph = await loadNamedGraph(ctx.cwd, task.mode === "autopilot" ? "coding-loop.auto" : "coding-loop.gated");
	const baselineSource = JSON.parse(await readFile(join(jobDirectory, "baseline.json"), "utf8")) as Record<
		string,
		string
	>;
	const baseline = new Map(Object.entries(baselineSource));
	// A resumed run re-derives its facts from the worktree it wakes up in: the
	// plan it was started with is recorded in the checkpoint it restores.
	const restoredPlanProvided = await planWasProvided(jobDirectory);
	const facts = loopFacts(ctx.cwd, jobDirectory, task, baseline, restoredPlanProvided);
	const engine = await GraphEngine.restore(graph, {
		projectRoot: ctx.cwd,
		jobId,
		createAgentSession: dependencies.createAgentSession,
		now: dependencies.now,
		accumulatedCostUsd: dependencies.accumulatedCostUsd,
		limits: task.limits,
		sleep: dependencies.sleep,
		retryBaseDelayMs: dependencies.retryBaseDelayMs,
		resolveFacts: facts.resolve,
	});
	const eventsPath = join(jobDirectory, "events.jsonl");
	const stopState = restoreStopState(stateDocument, engine.limits.maxRounds);
	try {
		let result = await driveUntilPause(
			engine,
			ctx.cwd,
			jobDirectory,
			task,
			facts,
			stopState,
			dependencies.onStateChange,
		);
		if (result.terminalStatus !== undefined) {
			await writeTerminalState(jobDirectory, eventsPath, task, result);
			return { jobId, status: result.terminalStatus, graphState: result.state };
		}
		while (result.state.status === "interrupted") {
			const pending = result.state.pendingHuman;
			if (pending === undefined) throw new Error("Interrupted graph has no pending human approval");
			const approved = await ctx.ui.confirm(pending.title, pending.question);
			await appendEvent(eventsPath, {
				ts: new Date().toISOString(),
				type: "approval.result",
				job_id: jobId,
				round: result.stopState.round,
				node: pending.nodeId,
				approved,
			});
			await engine.submitHuman(approved);
			result = await driveUntilPause(
				engine,
				ctx.cwd,
				jobDirectory,
				task,
				facts,
				result.stopState,
				dependencies.onStateChange,
			);
			if (result.terminalStatus !== undefined) {
				await writeTerminalState(jobDirectory, eventsPath, task, result);
				return { jobId, status: result.terminalStatus, graphState: result.state };
			}
		}
		if (result.state.status !== "completed") {
			throw new Error(`Cannot resume graph in ${result.state.status} state`);
		}
		// The same release gate the first run applies: a graph that ended without an
		// approved release is BLOCKED, not silently DONE.
		const release = result.state.values.release;
		if (!isJsonObject(release) || release.approved !== true) {
			const blocked: DriveResult = {
				state: result.state,
				stopState: result.stopState,
				terminalStatus: "BLOCKED",
				reason: "graph completed without release approval",
			};
			await writeTerminalState(jobDirectory, eventsPath, task, blocked);
			await dependencies.onStateChange?.();
			return { jobId, status: "BLOCKED", graphState: result.state };
		}
		// Same one-decision rule on resume: this job's own marked commit, or the
		// validated marker recording it, and never a second commit.
		try {
			await finalizeShip(
				ctx.cwd,
				jobDirectory,
				jobId,
				await startingHeadFor(jobDirectory),
				result.shippedThisRun === true,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const blocked: DriveResult = {
				state: result.state,
				stopState: result.stopState,
				terminalStatus: "BLOCKED",
				reason: message,
			};
			await writeTerminalState(jobDirectory, eventsPath, task, blocked);
			await dependencies.onStateChange?.();
			return { jobId, status: "BLOCKED", graphState: result.state };
		}
		await writeState(jobDirectory, task, result.state, result.stopState, "DONE");
		await dependencies.onStateChange?.();
		return { jobId, status: "DONE", graphState: result.state };
	} finally {
		engine.dispose();
	}
}

export async function runLoop(
	invocation: LoopInvocation,
	ctx: ExtensionCommandContext,
	dependencies: LoopDependencies = {},
): Promise<LoopOutcome> {
	const plan = invocation.planPath === undefined ? undefined : await snapshotPlan(ctx.cwd, invocation.planPath);
	const compilation = compileAcceptanceCriteria(invocation.goal);
	const task: Task = {
		job_id: dependencies.jobId ?? makeJobId(invocation.goal),
		mode: invocation.mode,
		goal: invocation.goal,
		nongoals: [],
		acceptance: compilation.acceptance,
		constraints:
			invocation.mode === "autopilot"
				? ["Never push", "Commit only after deterministic release approval"]
				: ["Never push", "Human approval is required before commit"],
		quality_gates: await qualityGates(ctx.cwd),
		ac: { quality: compilation.quality },
		dependency_baseline: await runtimeDependencies(ctx.cwd),
	};
	const job = await createJob(ctx.cwd, task, contextFor(invocation, plan));
	if (plan !== undefined) {
		await writePlanSnapshot(job.directory, plan);
	}

	if (invocation.mode === "autopilot" && compilation.quality !== "executable") {
		const reason = `autopilot requires executable acceptance criteria; received ${compilation.quality}`;
		await appendEvent(job.eventsPath, {
			ts: new Date().toISOString(),
			type: "ac.refused",
			job_id: job.jobId,
			round: 0,
			node: "ac-compiler",
			quality: compilation.quality,
			reason,
		});
		await atomicWrite(
			join(job.directory, "state.json"),
			`${JSON.stringify(
				{
					job_id: task.job_id,
					mode: task.mode,
					round: 0,
					maxRounds: task.limits?.maxRounds ?? DEFAULT_MAX_ROUNDS,
					stage: "ac-compile",
					node: "ac-compiler",
					ac: task.ac,
					status: "NEEDS_HUMAN",
					reason,
					graph_status: "not_started",
				},
				null,
				2,
			)}\n`,
		);
		await dependencies.onStateChange?.();
		return { jobId: job.jobId, status: "NEEDS_HUMAN" };
	}

	await appendEvent(job.eventsPath, {
		ts: new Date().toISOString(),
		type: "handoff.created",
		job_id: job.jobId,
		round: 0,
		node: plan === undefined ? "ac-compiler" : "plan-check",
		mode: invocation.mode,
	});

	const graphName = invocation.mode === "autopilot" ? "coding-loop.auto" : "coding-loop.gated";
	// The entry is the graph's own. Whether a frozen plan replaces the
	// specification step is a fact the topology routes on, not a rewrite the
	// driver performs on the graph it loaded.
	const graph = await loadNamedGraph(ctx.cwd, graphName);
	const previousHead = await gitHead(ctx.cwd);
	if (invocation.mode === "autopilot") {
		await createJobBranch(ctx.cwd, job.jobId);
	}
	const baseline = await worktreeSnapshot(ctx.cwd);
	await atomicWrite(
		join(job.directory, "baseline.json"),
		`${JSON.stringify(Object.fromEntries(baseline), null, 2)}\n`,
	);
	await atomicWrite(join(job.directory, "previous-head.txt"), `${previousHead ?? ""}\n`);
	const facts = loopFacts(ctx.cwd, job.directory, task, baseline, plan !== undefined);
	const engine = new GraphEngine(graph, {
		projectRoot: ctx.cwd,
		jobId: job.jobId,
		createAgentSession: dependencies.createAgentSession,
		now: dependencies.now,
		accumulatedCostUsd: dependencies.accumulatedCostUsd,
		limits: task.limits,
		sleep: dependencies.sleep,
		retryBaseDelayMs: dependencies.retryBaseDelayMs,
		resolveFacts: facts.resolve,
	});

	try {
		let stopState = createStopState(engine.limits.maxRounds);
		await writeState(job.directory, task, engine.state, stopState);
		await dependencies.onStateChange?.();
		let result = await driveUntilPause(
			engine,
			ctx.cwd,
			job.directory,
			task,
			facts,
			stopState,
			dependencies.onStateChange,
		);
		if (result.terminalStatus !== undefined) {
			await writeTerminalState(job.directory, job.eventsPath, task, result);
			await dependencies.onStateChange?.();
			return {
				jobId: job.jobId,
				status: result.terminalStatus,
				graphState: result.state,
			};
		}

		while (result.state.status === "interrupted") {
			const pending = result.state.pendingHuman;
			if (pending === undefined) {
				throw new Error("Interrupted graph has no pending human approval");
			}
			const approved = await ctx.ui.confirm(pending.title, pending.question);
			await appendEvent(job.eventsPath, {
				ts: new Date().toISOString(),
				type: "approval.result",
				job_id: job.jobId,
				round: result.stopState.round,
				node: pending.nodeId,
				approved,
			});
			const resumed = await engine.submitHuman(approved);
			stopState = result.stopState;
			result = await driveUntilPause(
				engine,
				ctx.cwd,
				job.directory,
				task,
				facts,
				stopState,
				dependencies.onStateChange,
			);
			if (result.terminalStatus !== undefined) {
				await writeTerminalState(job.directory, job.eventsPath, task, result);
				await dependencies.onStateChange?.();
				return {
					jobId: job.jobId,
					status: result.terminalStatus,
					graphState: result.state,
				};
			}
			if (resumed.status === "completed") {
				break;
			}
		}

		const state = result.state;
		const release = state.values.release;
		if (state.status !== "completed" || !isJsonObject(release) || release.approved !== true) {
			const blocked: DriveResult = {
				state,
				stopState: result.stopState,
				terminalStatus: "BLOCKED",
				reason: "graph completed without release approval",
			};
			await writeTerminalState(job.directory, job.eventsPath, task, blocked);
			return { jobId: job.jobId, status: "BLOCKED", graphState: state };
		}

		try {
			// One job, one commit decision, identified by this job's own trailer.
			await finalizeShip(ctx.cwd, job.directory, job.jobId, previousHead, result.shippedThisRun === true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const blocked: DriveResult = {
				state,
				stopState: result.stopState,
				terminalStatus: "BLOCKED",
				reason: message,
			};
			await writeTerminalState(job.directory, job.eventsPath, task, blocked);
			throw error;
		}
		await writeState(job.directory, task, state, result.stopState, "DONE");
		await dependencies.onStateChange?.();
		return { jobId: job.jobId, status: "DONE", graphState: state };
	} finally {
		engine.dispose();
	}
}
