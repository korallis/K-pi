import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { CONFIG_DIR_NAME } from "../../config.ts";

import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { kModeState, renderTodos } from "../kstack/mode.ts";
import { appendEvent } from "./append-log.ts";
import type { BusDependencies } from "./bus/spawn.ts";
import { compileAcceptanceCriteria } from "./graph/ac-compiler.ts";
import {
	type GraphAgentSessionFactory,
	GraphEngine,
	type GraphEngineOptions,
	GraphNodeProviderError,
	loadNamedGraph,
	type NodeRetry,
	OperatorStopError,
} from "./graph/engine.ts";
import {
	type GraphDefinition,
	type GraphRunState,
	type HumanAnswer,
	type HumanGraphNode,
	isJsonObject,
	type JsonObject,
	type PendingHumanInput,
} from "./graph/schema.ts";
import {
	canonicalFingerprint,
	createStopState,
	MAX_AUTOMATIC_REPLANS,
	type PlanRepair,
	recordVerifier,
	repeatedWitness,
	type Sleeper,
	type StopState,
	stopFingerprint,
	type TransientReason,
	type VerifierEvent,
} from "./graph/stop.ts";
import { assertMinimalistBounds, observedChangesFromSnapshots } from "./minimalist.ts";
import { isWriteAllowed } from "./policy.ts";
import { resolveResearchEndpoints } from "./research/endpoints.ts";
import { assertResearchFresh, conductResearch } from "./research/gate.ts";
import { ResearchShortfallError, resolveResearchKeys } from "./research/session.ts";
import {
	atomicWrite,
	createJob,
	type LoopRecovery,
	type RunStatus,
	readTaskForJob,
	type Task,
	writeAllowForTask,
} from "./run-store.ts";
import { readKpiSettings } from "./settings.ts";
import {
	assertScaffoldedBeforeBehavior,
	freezeCurrentSlice,
	readDuneStack,
	renderPlanSummary,
	scaffoldModule,
	stackRequiredFor,
} from "./stack.ts";

const execFile = promisify(execFileCallback);
const PLAN_FILES = ["requirements.md", "design.md", "tasks.md"] as const;

export const CONVENTIONAL_COMMIT_PATTERN = /^(feat|fix|docs|refactor|test|chore)(\(.+\))?: /u;

/** What a plan gate offers; the operator's select answers with one of these. */
export const PLAN_GATE_OPTIONS = ["Approve plan", "Request changes", "Stop"] as const;
/** What the release gate offers: the change ships, goes back to implement with feedback, or the job stops. */
export const RELEASE_GATE_OPTIONS = ["Approve", "Request changes", "Stop"] as const;
/** The longest change request a gate accepts; longer text is refused and asked again. */
export const MAX_HUMAN_FEEDBACK_CHARS = 4000;
/** The operator's stop marker inside the run directory. */
const STOP_MARKER_NAME = "stop.json";
/** The planner's brief after a no-progress finding. */
const REPAIR_FILE_NAME = "repair.json";

export interface LoopDependencies {
	createAgentSession?: GraphAgentSessionFactory;
	/** RP-13 bus injections for graph nodes with workerRole (e.g. reviewer). */
	busDependencies?: BusDependencies;
	onStateChange?: () => Promise<void>;
	jobId?: string;
	/** Test/DI wall clock. Production uses Date.now. Not an operator flag. */
	now?: () => number;
	/**
	 * Test/DI cost meter. Production never sets this: spend is session usage ×
	 * model.cost, restored from the graph checkpoint. Not an operator flag and
	 * not a way to zero a live job's spend.
	 */
	accumulatedCostUsd?: () => number;
	/** Test/DI transient-retry backoff. Production uses real sleep. */
	sleep?: Sleeper;
	/** Test/DI first backoff step. Production uses DEFAULT_RETRY_BASE_MS. */
	retryBaseDelayMs?: number;
	/**
	 * How the pull request for a pushed job branch is looked up. Production asks
	 * `gh`; a test stands in for the GitHub it has no access to. Not an operator
	 * flag and not a way to skip the check.
	 */
	readPullRequest?: (projectRoot: string, branch: string) => Promise<PullRequestRecord | undefined>;
	/**
	 * The operator's stop: `/kpi stop` aborts it. Every in-flight session,
	 * backoff wait and open gate unwinds at once as an operator stop.
	 */
	signal?: AbortSignal;
}

export interface LoopInvocation {
	goal: string;
	mode: "gated" | "autopilot";
	planPath?: string;
	/** The operator declared this job offline for research. */
	noNetwork?: boolean;
}

export interface LoopOutcome {
	jobId: string;
	status: RunStatus;
	reason?: string;
	/** What a `NEEDS_HUMAN` is waiting on, as data; the control plane keys its recovery prompt off this. */
	recovery?: LoopRecovery;
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

/** The caps a retired release accepted. K-π runs have no caps; naming one is refused, wherever it appears. */
const RETIRED_CAP_FLAG = /(?:^|\s)--(max-cost-usd|timeout-ms|max-rounds)(?=\s|$)/u;
const NO_NETWORK_FLAG = /(?:^|\s)--no-network(?=\s|$)/u;

export function parseLoopInvocation(args: string): LoopInvocation {
	let input = args.trim();
	const retired = RETIRED_CAP_FLAG.exec(input);
	if (retired !== null) {
		throw new Error(
			`/kpi --${retired[1]} was removed: K-π runs have no caps; cost and elapsed time are reported on the board`,
		);
	}
	// The offline flag composes with every mode and may sit anywhere; it is the
	// operator's decision, never part of the goal.
	let noNetwork = false;
	for (let flag = NO_NETWORK_FLAG.exec(input); flag !== null; flag = NO_NETWORK_FLAG.exec(input)) {
		noNetwork = true;
		input = `${input.slice(0, flag.index)} ${input.slice(flag.index + flag[0].length)}`.trim().replace(/\s+/gu, " ");
	}
	const offline = noNetwork ? { noNetwork: true as const } : {};
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
		return { goal, mode, ...offline };
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
		return { goal, mode: "autopilot", ...offline };
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
			...offline,
		};
	}
	if (input.startsWith("--")) {
		throw new Error(`Unknown /kpi option: ${input.split(/\s/u, 1)[0]}`);
	}
	if (input.length === 0) {
		// Name the flag the operator used so a bare offline flag without a goal is legible.
		throw new Error(noNetwork ? "/kpi --no-network requires a goal" : "/kpi requires a goal");
	}
	return { goal: input, mode: "gated", ...offline };
}

export function makeJobId(goal: string): string {
	const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
	// Collapse non-alnum, then re-trim after the length cut so a mid-token slice
	// cannot leave a trailing "-" that becomes "--" before the uuid suffix
	// (job ids must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/).
	const slug =
		goal
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 32)
			.replace(/^-+|-+$/gu, "")
			.replace(/-+/gu, "-") || "job";
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

export interface QualityGateDetection {
	commands: string[];
	source: "agents-md" | "package-scripts" | "none";
	/** Where the commands came from, or why there are none; recorded in context.md. */
	reason: string;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** The manager the repository actually uses: its own declaration, else its lockfile, else npm. */
async function detectPackageManager(projectRoot: string, declared: unknown): Promise<PackageManager> {
	const match = typeof declared === "string" ? /^(npm|pnpm|yarn|bun)(?:@|$)/u.exec(declared) : null;
	if (match !== null) return match[1] as PackageManager;
	if (await exists(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
	if (await exists(join(projectRoot, "yarn.lock"))) return "yarn";
	if ((await exists(join(projectRoot, "bun.lockb"))) || (await exists(join(projectRoot, "bun.lock")))) return "bun";
	return "npm";
}

function scriptCommand(manager: PackageManager, script: string): string {
	if (script === "test") {
		return manager === "bun" ? "bun run test" : `${manager} test`;
	}
	return `${manager} run ${script}`;
}

/**
 * The commands the test node runs and the policy allows without a prompt.
 *
 * An AGENTS.md "Quality gates" block is the operator's word and wins (AC-08.3).
 * Otherwise the gates are the repository's own scripts under its own package
 * manager - only scripts that exist, never a guessed `pnpm test` in an npm
 * repository. No gates is a recorded fact, not a silent default: a job whose
 * test node has nothing to run must say so where the operator reads.
 */
export async function detectQualityGates(projectRoot: string): Promise<QualityGateDetection> {
	const agents = await readIfPresent(join(projectRoot, "AGENTS.md"));
	if (agents !== undefined) {
		const section = /^#{1,6}\s+Quality gates[^\n]*\n[\s\S]*?```(?:bash|sh)?\s*\n([\s\S]*?)```/imu.exec(agents);
		const commands =
			section === null
				? []
				: section[1]
						.split("\n")
						.map((line) => line.trim().replace(/^\$\s*/u, ""))
						.filter((line) => line.length > 0 && !line.startsWith("#"));
		if (commands.length > 0) {
			return { commands, source: "agents-md", reason: "AGENTS.md Quality gates block" };
		}
	}

	const manifest = await readIfPresent(join(projectRoot, "package.json"));
	if (manifest !== undefined) {
		let document: { packageManager?: unknown; scripts?: unknown } = {};
		try {
			document = JSON.parse(manifest) as typeof document;
		} catch {
			document = {};
		}
		const scripts = isJsonObject(document.scripts) ? document.scripts : {};
		const manager = await detectPackageManager(projectRoot, document.packageManager);
		const wanted = ["test", "lint", ...(typeof scripts.typecheck === "string" ? ["typecheck"] : ["check"])];
		const commands = wanted
			.filter((script) => typeof scripts[script] === "string")
			.map((script) => scriptCommand(manager, script));
		if (commands.length > 0) {
			return { commands, source: "package-scripts", reason: `package.json scripts under ${manager}` };
		}
	}

	return {
		commands: [],
		source: "none",
		reason: "no AGENTS.md Quality gates block and package.json declares no test, lint, typecheck or check script",
	};
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

function contextFor(invocation: LoopInvocation, gates: QualityGateDetection, plan?: PlanSnapshot): string {
	const lines = [
		`# K-π ${invocation.mode} job`,
		"",
		`Goal: ${invocation.goal}`,
		`Mode: ${invocation.mode}`,
		`Quality gates: ${gates.source} — ${gates.reason}`,
	];
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
	if (node === "plan-check" || node === "plan-approval") {
		return "plan";
	}
	return node;
}

/** The backoff a node is waiting out, as state.json reports it while it lasts. */
interface RetryRow {
	node: string;
	attempt: number;
	reason: TransientReason;
	delay_ms: number;
	until_ms: number;
}

/** The first active node mid-backoff; the board's RETRY row and nothing else. */
function retryRow(state: Readonly<GraphRunState>): RetryRow | undefined {
	for (const nodeId of state.active) {
		const nodeState = state.nodes[nodeId];
		if (nodeState?.retryAtMs === undefined || nodeState.retryReason === undefined) {
			continue;
		}
		return {
			node: nodeId,
			attempt: nodeState.transientRetries ?? 0,
			reason: nodeState.retryReason,
			delay_ms: nodeState.retryDelaysMs?.at(-1) ?? 0,
			until_ms: nodeState.retryAtMs,
		};
	}
	return undefined;
}

function stateDocument(
	task: Task,
	state: Readonly<GraphRunState>,
	stop: StopState,
	terminalStatus?: RunStatus,
	reason?: string,
	recovery?: LoopRecovery,
): Record<string, unknown> {
	const node = activeNode(state);
	// A paused graph is waiting on the operator; a completed one is done; the
	// rest (running, interrupted at a gate) is a live run.
	const status =
		terminalStatus ?? (state.status === "paused" ? "NEEDS_HUMAN" : state.status === "completed" ? "DONE" : "RUNNING");
	return {
		job_id: task.job_id,
		mode: task.mode,
		round: stop.round,
		stage: stageFor(node),
		node,
		passed: isJsonObject(state.values.test) ? state.values.test.passed : undefined,
		bounds: state.values.bounds,
		review: state.values.review,
		release: state.values.release,
		ac: task.ac,
		status,
		reason,
		// What a NEEDS_HUMAN is waiting on, persisted with it: a later process
		// reading this file keys off the field, never off the wording of `reason`.
		recovery: recovery ?? (status === "NEEDS_HUMAN" ? state.pause?.recovery : undefined),
		graph_status: state.status,
		superstep: state.superstep,
		pending_question: state.pendingHuman?.question,
		limits: state.budget.limits,
		started_at_ms: state.budget.startedAtMs,
		// Report-only counters: nothing ends a run because of them.
		elapsed_ms: state.budget.elapsedMs,
		cost_usd: state.budget.costUsd,
		graph_round: state.budget.round,
		batches: state.budget.batches,
		// Stop-safety state. A resume that lost any of these would re-approve work
		// it already rejected, or forget the re-plans it already spent.
		evidence_fingerprints: [...stop.evidenceFingerprints],
		output_fingerprints: [...stop.outputFingerprints],
		failing_ac_sets: [...stop.failingAcSets],
		last_test_evidence: stop.lastTestEvidence,
		repaired: [...stop.repaired],
		plan_repair: stop.repair,
		retry: retryRow(state),
		// The playbook the job froze, and every step it declared. Todos come only
		// from task.playbook_steps so a fresh process resume cannot lose them when
		// kModeState is empty, and cannot invent them from a later match.
		playbook: task.playbook,
		todos: playbookTodos(task),
	};
}

/**
 * The frozen playbook's steps, rendered once per step from the task snapshot.
 *
 * Never reads `kModeState`: that is process-local match residue and is gone after
 * a restart. A job without a freeze has no todos to report.
 */
function playbookTodos(task: Task): string[] | undefined {
	if (task.playbook_steps === undefined || task.playbook_steps.length === 0) {
		return undefined;
	}
	return renderTodos(task.playbook_steps);
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
	terminalStatus?: RunStatus,
	reason?: string,
	recovery?: LoopRecovery,
): Promise<void> {
	await atomicWrite(
		join(runDirectory, "state.json"),
		`${JSON.stringify(stateDocument(task, state, stop, terminalStatus, reason, recovery), null, 2)}\n`,
	);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const EVIDENCE_REFS: Record<PlanRepair["evidence_ref"], true> = { "verdict.json": true, "evidence.json": true };

/** A persisted plan repair, or nothing when the document does not hold one. */
function parsePlanRepair(value: unknown): PlanRepair | undefined {
	if (
		!isJsonObject(value) ||
		typeof value.round !== "number" ||
		typeof value.reason !== "string" ||
		!Array.isArray(value.failing_ac) ||
		typeof value.evidence_ref !== "string" ||
		!(value.evidence_ref in EVIDENCE_REFS) ||
		typeof value.witness !== "string"
	) {
		return undefined;
	}
	return {
		round: value.round,
		reason: value.reason,
		failing_ac: stringArray(value.failing_ac),
		evidence_ref: value.evidence_ref as PlanRepair["evidence_ref"],
		witness: value.witness,
		...(typeof value.guidance === "string" ? { guidance: value.guidance } : {}),
	};
}

/**
 * Rebuilds the stop state a resumed job left behind. Every field matters: a run
 * that lost its fingerprints would re-accept output it already called stuck,
 * and one that lost its re-plans would spend them again instead of pausing.
 */
export function restoreStopState(document: Record<string, unknown>): StopState {
	const repair = parsePlanRepair(document.plan_repair);
	return {
		...createStopState(),
		round: typeof document.round === "number" ? document.round : 0,
		// Normalized on the way back in, so a comparison after a resume is made on
		// the same terms the reducer used before the kill.
		evidenceFingerprints: stringArray(document.evidence_fingerprints).map(stopFingerprint),
		outputFingerprints: stringArray(document.output_fingerprints).map(stopFingerprint),
		failingAcSets: stringArray(document.failing_ac_sets),
		...(typeof document.last_test_evidence === "string"
			? { lastTestEvidence: stopFingerprint(document.last_test_evidence) }
			: {}),
		repaired: stringArray(document.repaired),
		...(repair === undefined ? {} : { repair }),
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

/** The branch a job commits, pushes, and opens its pull request from. */
export function jobBranchName(jobId: string): string {
	return `kpi/${jobId}`;
}

async function currentBranch(projectRoot: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFile("git", ["branch", "--show-current"], { cwd: projectRoot });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
	try {
		await execFile("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: projectRoot });
		return true;
	} catch {
		return false;
	}
}

/**
 * Puts the worktree on the job branch, creating it from the current HEAD when
 * it does not exist yet. The control plane does this itself, right before the
 * ship node runs, so the commit, the push, and the pull request can only ever
 * be on `kpi/<job id>`: a branch the ship node did not have to get right.
 */
export async function ensureJobBranch(projectRoot: string, jobId: string): Promise<string> {
	const branch = jobBranchName(jobId);
	if ((await currentBranch(projectRoot)) === branch) {
		return branch;
	}
	const args = (await branchExists(projectRoot, branch)) ? ["switch", branch] : ["switch", "-c", branch];
	await execFile("git", args, { cwd: projectRoot });
	return branch;
}

async function hasRemote(projectRoot: string, remote: string): Promise<boolean> {
	try {
		await execFile("git", ["remote", "get-url", remote], { cwd: projectRoot });
		return true;
	} catch {
		return false;
	}
}

/** The ref a push of `branch` to `origin` leaves behind locally. */
async function pushedHead(projectRoot: string, branch: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFile("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
			cwd: projectRoot,
		});
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

interface ShipDelivery {
	branch: string;
	prUrl: string;
}

/**
 * The ship commit exists but has not reached origin, or has no pull request:
 * something the operator can finish by hand, after which resuming the job
 * finalizes the same commit. Distinct from an integrity failure (no commit,
 * two commits, a foreign commit), which is `BLOCKED` and not the operator's
 * to repair by pushing.
 */
export class ShipDeliveryError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ShipDeliveryError";
	}
}

/**
 * The one-commit contract refusing: no commit, two commits, a foreign or
 * unconventional commit, an ambiguous trailer. A fact about the repository,
 * distinct from a git or filesystem call that simply failed.
 */
export class ShipIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShipIntegrityError";
	}
}

/** A thrown value as a sentence: an Error's message, a string as is, anything else serialized. */
function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error === undefined) return "an undefined value was thrown";
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

const STACK_REFUSAL_PATTERN =
	/stack\.json|stack\.schema|assertDuneStack|Dune|Layer folder|Module folder|Horizontal delivery|layer sweep|shared module|failed response validation/iu;
const PLAN_VALIDATION_PATTERN = /^agent node plan failed response validation after (\d+) attempts?: (.+)$/su;

/**
 * The stack refusal behind a plan node's contract failure, worded as the
 * contract implement reads: the stable prefix, then the real cause, because
 * "missing" alone hid that the model never returned a JSON document at all.
 * Nothing when the failure is not about the map.
 */
function planStackRefusal(message: string): string | undefined {
	if (!STACK_REFUSAL_PATTERN.test(message)) {
		return undefined;
	}
	const validation = PLAN_VALIDATION_PATTERN.exec(message);
	return validation !== null &&
		/not valid JSON|assistant response text is unavailable|response must be a JSON object/iu.test(validation[2])
		? `stack.json is missing: plan response was not valid stack.json JSON after ${validation[1]} attempts (${validation[2]})`
		: message.replace(/^agent node plan failed response validation after \d+ attempts: /u, "");
}

/** What the operator does about each NEEDS_HUMAN before the resume command continues the job. */
const RECOVERY_ADVICE: Record<LoopRecovery, string> = {
	approval: "Answer it in an interactive K-π session",
	provider: "Select a healthy model or resolve that provider account",
	delivery: "Push the branch or open the pull request as named",
	ship: "Put the job branch and its commit right in the repository",
	bounds: "Revert the writes that left the declared bounds, or widen the task's bounds",
	review: "Address the reviewer's blocking issue, or make the receipts fresh again",
	no_progress: "Choose Give guidance, Keep going or Stop when the resume asks",
	research: "Repair the research service, or run the job offline with --no-network",
	stack: "Repair stack.json so implement has a valid frozen map",
	contract: "Fix the contract defect the reason names",
	ac_quality: "Rewrite the goal with executable acceptance criteria, or run it gated",
};

/**
 * The one place a NEEDS_HUMAN recovery is worded: the real reason, what the
 * operator does about it, and the exact resume command. `recovery` is the
 * signal the control plane keys off; this text is for the person reading it.
 */
function recoveryReason(kind: LoopRecovery, message: string, jobId: string): string {
	return `${message}. ${RECOVERY_ADVICE[kind]}, then resume with /kpi ${jobId}`;
}

/** A NEEDS_HUMAN drive result: the recovery and the reason worded for the operator, once. */
function needsHuman(
	base: Pick<DriveResult, "state" | "stopState" | "shippedThisRun">,
	recovery: LoopRecovery,
	message: string,
	jobId: string,
	terminalEmitted?: boolean,
): DriveResult {
	return {
		...base,
		terminalStatus: "NEEDS_HUMAN",
		recovery,
		reason: recoveryReason(recovery, message, jobId),
		...(terminalEmitted === undefined ? {} : { terminalEmitted }),
	};
}

/** The terminal a failed ship finalization writes, and how the operator gets past it. */
function shipFailure(
	error: unknown,
	jobId: string,
): { terminalStatus: RunStatus; reason: string; recovery: LoopRecovery } {
	const message = describeError(error);
	if (error instanceof ShipDeliveryError) {
		return {
			terminalStatus: "NEEDS_HUMAN",
			reason: recoveryReason("delivery", message, jobId),
			recovery: "delivery",
		};
	}
	if (error instanceof ShipIntegrityError) {
		// The one-commit contract refusing: a fact about the repository.
		return { terminalStatus: "NEEDS_HUMAN", reason: recoveryReason("ship", message, jobId), recovery: "ship" };
	}
	// A git or filesystem call that failed, or a value nothing here throws:
	// the loop's own trouble, labelled so the operator does not go looking for
	// a step they missed or a commit that is fine.
	return {
		terminalStatus: "NEEDS_HUMAN",
		reason: recoveryReason("ship", `ship finalization failed unexpectedly (not an operator step): ${message}`, jobId),
		recovery: "ship",
	};
}

/**
 * Verifies that the job's commit reached where the ship node was told to take
 * it: on the job branch, pushed to `origin`, and in front of the merge queue as
 * a pull request. Each failure names what is missing, because the fix is the
 * operator's: push the branch, sign `gh` in, or open the pull request, then
 * resume the job and the recovered commit is finalized without a second commit.
 *
 * A repository with no `origin` has nowhere to push and nothing to verify: the
 * commit alone is the ship, exactly as before.
 */
async function verifyShipDelivery(
	projectRoot: string,
	jobId: string,
	head: string,
	readPullRequest: LoopDependencies["readPullRequest"],
): Promise<ShipDelivery | undefined> {
	if (!(await hasRemote(projectRoot, "origin"))) {
		return undefined;
	}
	const branch = jobBranchName(jobId);
	const checkedOut = await currentBranch(projectRoot);
	if (checkedOut !== branch) {
		throw new ShipDeliveryError(`Ship commit is on ${checkedOut ?? "a detached HEAD"}, not the job branch ${branch}`);
	}
	const remoteHead = await pushedHead(projectRoot, branch);
	if (remoteHead === undefined) {
		throw new ShipDeliveryError(`Job branch ${branch} was not pushed to origin`);
	}
	if (remoteHead !== head && !(await isAncestor(projectRoot, head, remoteHead))) {
		throw new ShipDeliveryError(
			`origin/${branch} is at ${remoteHead.slice(0, 8)}, which does not carry the ship commit`,
		);
	}
	let pullRequest: PullRequestRecord | undefined;
	try {
		pullRequest = await (readPullRequest ?? readPullRequestWithGh)(projectRoot, branch);
	} catch (error) {
		// Only the reader's own named failure - gh missing, signed out, answering
		// badly - is the operator's to fix. A reader that throws anything else
		// has a fault of its own, and that is reported as the fault it is.
		if (error instanceof PullRequestLookupError) {
			throw new ShipDeliveryError(error.message, { cause: error });
		}
		throw error;
	}
	if (pullRequest === undefined) {
		throw new ShipDeliveryError(
			`No pull request is open for ${branch}; open one with gh pr create --head ${branch} --fill`,
		);
	}
	if (pullRequest.state !== "OPEN" && pullRequest.state !== "MERGED") {
		throw new ShipDeliveryError(`The pull request for ${branch} is ${pullRequest.state}: ${pullRequest.url}`);
	}
	return { branch, prUrl: pullRequest.url };
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

/** What the evidence on disk witnesses: its canonical fingerprint and the criteria it reports failing. */
interface EvidenceWitness {
	fingerprint: string;
	failingAcIds: string[];
}

/**
 * The verifier's evidence, fingerprinted canonically so reformatting the same
 * receipts cannot look like progress, with the acceptance criteria it reports
 * as failing (order does not matter: the reducer canonicalizes the set).
 * Unparseable evidence falls back to its bytes, which is still a stable
 * witness of the same file. No evidence.json at all is nothing to witness.
 */
async function readEvidenceWitness(runDirectory: string): Promise<EvidenceWitness | undefined> {
	let content: Buffer;
	try {
		content = await readFile(join(runDirectory, "evidence.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	let evidence: unknown;
	try {
		evidence = JSON.parse(content.toString("utf8"));
	} catch {
		return { fingerprint: `sha256:${createHash("sha256").update(content).digest("hex")}`, failingAcIds: [] };
	}
	return {
		fingerprint: canonicalFingerprint(evidence),
		failingAcIds:
			isJsonObject(evidence) && Array.isArray(evidence.ac_results)
				? evidence.ac_results.flatMap((result) =>
						isJsonObject(result) && typeof result.id === "string" && result.passed !== true ? [result.id] : [],
					)
				: [],
	};
}

/**
 * The verifier round the run files describe, as the stop reducer sees it: a
 * review verdict with its output fingerprint against the evidence beside it,
 * or a failed test round's evidence alone. Nothing when the files that make
 * the round are not there, or the verdict carries no fingerprint.
 */
async function verifierEventOnDisk(
	runDirectory: string,
	source: "review" | "test",
): Promise<VerifierEvent | undefined> {
	const evidence = await readEvidenceWitness(runDirectory);
	if (evidence === undefined) {
		return undefined;
	}
	if (source === "test") {
		return {
			type: "verifier",
			source,
			passed: false,
			evidenceFingerprint: evidence.fingerprint,
			failingAcIds: evidence.failingAcIds,
		};
	}
	let verdict: unknown;
	try {
		verdict = JSON.parse(await readFile(join(runDirectory, "verdict.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	if (!isJsonObject(verdict) || typeof verdict.output_fingerprint !== "string") {
		return undefined;
	}
	return {
		type: "verifier",
		source,
		passed: verdict.approved === true,
		evidenceFingerprint: evidence.fingerprint,
		outputFingerprint: verdict.output_fingerprint,
		failingAcIds: evidence.failingAcIds,
	};
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

/**
 * The durable record that this job's commit decision was already made, and -
 * when the repository has an origin - where it went: the job branch that was
 * pushed and the pull request that was opened. A marker written by an earlier
 * release carries only the commit; it stays valid evidence as it is.
 */
interface ShipMarker {
	job_id: string;
	head: string;
	subject: string;
	at: string;
	branch?: string;
	pr_url?: string;
}

/** The pull request the ship node opened for a job branch, as `gh` reports it. */
export interface PullRequestRecord {
	url: string;
	state: string;
}

/**
 * The pull-request reader could not answer: `gh` missing, signed out, or
 * answering in a shape it never documents. The operator's to repair. Any
 * other throw from a reader is not this, and is not dressed up as delivery.
 */
export class PullRequestLookupError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PullRequestLookupError";
	}
}

/**
 * Reads the pull request for a branch through `gh`. No pull request resolves to
 * nothing; a `gh` that is missing, signed out, or otherwise failing throws with
 * its own message, so the operator sees the real reason the ship could not be
 * verified.
 */
export async function readPullRequestWithGh(
	projectRoot: string,
	branch: string,
): Promise<PullRequestRecord | undefined> {
	let stdout: string;
	try {
		({ stdout } = await execFile("gh", ["pr", "view", branch, "--json", "url,state"], { cwd: projectRoot }));
	} catch (error) {
		const detail = error as NodeJS.ErrnoException & { stderr?: string };
		if (/no pull requests found/iu.test(detail.stderr ?? "")) {
			return undefined;
		}
		if (detail.code === "ENOENT") {
			throw new PullRequestLookupError(`No pull request could be verified for ${branch}: gh is not installed`);
		}
		// gh's own first line, not its whole stderr: an update notice or an auth
		// hint is not the reason, and the operator reads what is missing first.
		const firstLine =
			(detail.stderr ?? detail.message)
				.split(/\r?\n/u)
				.map((line) => line.trim())
				.find((line) => line.length > 0) ?? "gh gave no reason";
		// At most 160 characters shown, the ellipsis counted among them.
		const shown = firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
		throw new PullRequestLookupError(
			`No pull request could be verified for ${branch}: gh pr view failed (${shown})`,
			{
				cause: error,
			},
		);
	}
	const parsed = JSON.parse(stdout) as { url?: unknown; state?: unknown };
	if (typeof parsed.url !== "string" || typeof parsed.state !== "string") {
		throw new PullRequestLookupError(`gh pr view ${branch} returned no url and state`);
	}
	return { url: parsed.url, state: parsed.state };
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
	const { branch, pr_url: prUrl } = value;
	if (branch !== undefined && (typeof branch !== "string" || branch.length === 0)) return undefined;
	if (prUrl !== undefined && (typeof prUrl !== "string" || prUrl.length === 0)) return undefined;
	const known = 4 + (branch === undefined ? 0 : 1) + (prUrl === undefined ? 0 : 1);
	if (Object.keys(value).length !== known) return undefined;
	return {
		job_id: jobId,
		head,
		subject,
		at,
		...(branch === undefined ? {} : { branch }),
		...(prUrl === undefined ? {} : { pr_url: prUrl }),
	};
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

async function isAncestor(projectRoot: string, commit: string, of: string): Promise<boolean> {
	try {
		await execFile("git", ["merge-base", "--is-ancestor", commit, of], { cwd: projectRoot });
		return true;
	} catch {
		return false;
	}
}

function isAncestorOfHead(projectRoot: string, head: string): Promise<boolean> {
	return isAncestor(projectRoot, head, "HEAD");
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
		throw new ShipIntegrityError(
			`Ambiguous ship commits for ${jobId}: ${marked.map((commit) => commit.head.slice(0, 8)).join(", ")}`,
		);
	}
	const [commit] = marked;
	if (!CONVENTIONAL_COMMIT_PATTERN.test(commit.subject)) {
		throw new ShipIntegrityError(`Ship commit is not Conventional Commits: ${commit.subject}`);
	}
	if (!(await isAncestorOfHead(projectRoot, commit.head))) {
		throw new ShipIntegrityError(`Ship commit ${commit.head.slice(0, 8)} is not an ancestor of HEAD`);
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
	head: string | undefined,
	delivery: ShipDelivery | undefined,
): Promise<void> {
	// The marker names the commit that was verified, not whatever HEAD happens to
	// be when the record is written.
	const recorded = head ?? (await gitHead(projectRoot));
	if (recorded === undefined) {
		return;
	}
	const marker: ShipMarker = {
		job_id: jobId,
		head: recorded,
		subject,
		at: new Date().toISOString(),
		...(delivery === undefined ? {} : { branch: delivery.branch, pr_url: delivery.prUrl }),
	};
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
	/**
	 * The stop state and active set the next superstep's routing is judged
	 * against. Called before every superstep, so `progress.repeated` compares
	 * the round just produced with the rounds already on record.
	 */
	observe: (stop: StopState, active: readonly string[]) => void;
}

function loopFacts(
	projectRoot: string,
	jobDirectory: string,
	task: Task,
	baseline: ReadonlyMap<string, string>,
	planProvided: boolean,
): LoopFacts {
	let boundsReason: string | undefined;
	let observed: { stop: StopState; active: readonly string[] } = { stop: createStopState(), active: [] };
	return {
		boundsReason: () => boundsReason,
		observe: (stop, active) => {
			observed = { stop, active };
		},
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
					const changes = await observedChangesFromSnapshots(projectRoot, baseline, current, async (path) => {
						try {
							const { stdout } = await execFile("git", ["show", `HEAD:${path}`], {
								cwd: projectRoot,
								encoding: "utf8",
								maxBuffer: 2 * 1024 * 1024,
							});
							return stdout;
						} catch {
							return undefined;
						}
					});
					await assertMinimalistBounds(projectRoot, jobDirectory, task, changes);
				} catch (error) {
					boundsReason = error instanceof Error ? error.message : String(error);
				}
			}

			// Progress is judged against the rounds already recorded: a review
			// verdict that repeats an output or a failing set, or a failed test
			// round whose evidence is identical to the previous failed one, is
			// none. The topology decides what to do about it (re-plan or pause).
			let witness: string | undefined;
			if (observed.active.includes("review")) {
				const event = await verifierEventOnDisk(jobDirectory, "review");
				witness = event === undefined ? undefined : repeatedWitness(observed.stop, event);
			} else if (observed.active.includes("test") && !testPassed) {
				const event = await verifierEventOnDisk(jobDirectory, "test");
				witness = event === undefined ? undefined : repeatedWitness(observed.stop, event);
			}

			return {
				"plan.provided": planProvided,
				"test.passed": testPassed,
				"bounds.held": boundsReason === undefined,
				"fingerprints.fresh": fresh,
				"ship.shipped": await alreadyShipped(projectRoot, jobDirectory, task.job_id),
				"progress.repeated": witness !== undefined,
				"plan.repair_tried": observed.stop.repaired.length >= MAX_AUTOMATIC_REPLANS,
			};
		},
	};
}

interface DriveResult {
	state: Readonly<GraphRunState>;
	stopState: StopState;
	terminalStatus?: RunStatus;
	reason?: string;
	/**
	 * Whether the ship node ran during this pass. A run that shipped is held to
	 * the one-commit rule; a replay that recovered an earlier decision is not,
	 * because later unrelated commits are none of its business.
	 */
	shippedThisRun?: boolean;
	/** The engine already emitted the one `loop.terminal` event for this run. */
	terminalEmitted?: boolean;
	recovery?: LoopRecovery;
}

/**
 * The operator's stop marker (C9). `recorded` says who appends the STOPPED
 * terminal: the control plane when no loop was live (true), or the driver
 * whose loop the control plane aborted (false).
 */
export interface StopMarker {
	reason: "operator stop";
	at: string;
	recorded: boolean;
}

export async function writeStopMarker(runDirectory: string, recorded: boolean): Promise<StopMarker> {
	const marker: StopMarker = { reason: "operator stop", at: new Date().toISOString(), recorded };
	await atomicWrite(join(runDirectory, STOP_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);
	return marker;
}

/**
 * The marker, or nothing. A marker that is there but not readable as one is
 * still the operator's stop; the driver records the terminal itself then.
 */
async function readStopMarker(runDirectory: string): Promise<Pick<StopMarker, "recorded"> | undefined> {
	let content: string;
	try {
		content = await readFile(join(runDirectory, STOP_MARKER_NAME), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	try {
		const marker: unknown = JSON.parse(content);
		return { recorded: isJsonObject(marker) && marker.recorded === true };
	} catch {
		return { recorded: false };
	}
}

/**
 * Lets the next plan choose its slice: `current_module_id` is the freeze of
 * the plan that did not deliver, and implement re-freezes from the new map.
 */
async function unfreezeSlice(jobDirectory: string): Promise<void> {
	const path = join(jobDirectory, "task.json");
	const { current_module_id: _slice, ...contract } = JSON.parse(await readFile(path, "utf8")) as Task;
	await atomicWrite(path, `${JSON.stringify(contract, null, 2)}\n`);
}

/**
 * A repeated witness is no progress. The finding is written for the planner
 * (repair.json, kept with the stop state as `repair`) and the slice is
 * unfrozen so the next plan may choose another. When the topology routed
 * straight to plan, that re-plan is automatic: it is counted against the
 * allowance an operator touch resets, put on the record, and announced.
 */
async function recordNoProgress(
	ctx: ExtensionCommandContext,
	jobDirectory: string,
	task: Task,
	stop: StopState,
	event: VerifierEvent,
	witness: string,
	replanNow: boolean,
): Promise<StopState> {
	const cause =
		event.source === "test"
			? "test evidence repeated"
			: witness === stopFingerprint(event.outputFingerprint)
				? "review repeated the same output"
				: "review repeated the same failing criteria";
	const repair: PlanRepair = {
		round: stop.round,
		reason: `no progress: ${cause}`,
		failing_ac: [...(event.failingAcIds ?? [])],
		evidence_ref: event.source === "test" ? "evidence.json" : "verdict.json",
		witness,
		// The operator's words outlive one plan: they stand until the next touch.
		...(stop.repair?.guidance === undefined ? {} : { guidance: stop.repair.guidance }),
	};
	await atomicWrite(join(jobDirectory, REPAIR_FILE_NAME), `${JSON.stringify(repair, null, 2)}\n`);
	await unfreezeSlice(jobDirectory);
	if (!replanNow) {
		return { ...stop, repair };
	}
	await appendEvent(join(jobDirectory, "events.jsonl"), {
		ts: new Date().toISOString(),
		type: "checkpoint",
		job_id: task.job_id,
		round: stop.round,
		node: "plan",
		detail: `re-plan for witness ${witness}`,
	});
	ctx.ui.notify(`K-π ${task.job_id} re-planning: ${repair.reason}`, "warning");
	return { ...stop, repair, repaired: [...stop.repaired, witness] };
}

async function driveUntilPause(
	engine: GraphEngine,
	ctx: ExtensionCommandContext,
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
	const jobId = task.job_id;
	// The operator stopped the run: the engine's checkpoint keeps the
	// interrupted node resumable, and whoever wrote the marker says whether
	// the terminal is already on the record.
	const operatorStop = async (): Promise<DriveResult> => ({
		state: engine.state,
		stopState: currentStopState,
		shippedThisRun,
		terminalStatus: "STOPPED",
		reason: "operator stop",
		terminalEmitted: (await readStopMarker(jobDirectory))?.recorded === true,
	});
	while (state.status === "running") {
		// A marker written by another session lands here, before any work starts.
		if ((await readStopMarker(jobDirectory)) !== undefined) {
			return operatorStop();
		}
		if (state.active.some((node) => node === "specify" || node === "plan" || node === "plan-check")) {
			try {
				await assertResearchFresh(jobDirectory, task);
			} catch {
				try {
					// The control plane owns keys, mode, endpoints, budget, cooldown and
					// events. The operator's own offline decision travels on the frozen
					// contract, so a resumed job stays offline.
					const settings = await readKpiSettings(projectRoot);
					const { endpoints, timeoutMs } = resolveResearchEndpoints(settings.researchEndpoints);
					await conductResearch(projectRoot, jobDirectory, task, {
						keys: await resolveResearchKeys(),
						mode: settings.research,
						endpoints,
						timeoutMs,
						operatorNoNetwork: task.research_network === "offline",
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
					return needsHuman(
						{ state, stopState: currentStopState, shippedThisRun },
						"research",
						error.message,
						jobId,
					);
				}
			}
		}
		if (state.active.includes("implement")) {
			try {
				await assertResearchFresh(jobDirectory, task);
				// The contract is re-read here because advancing the slice, or naming a
				// playbook, is an edit that happens while the job is open. The map is a
				// precondition, not a convenience: it is read, validated and bound to
				// this contract before the node's first write, and a missing or stale
				// stack pauses the round rather than being regenerated.
				const contract = await readTaskForJob(projectRoot, jobId).catch(() => task);
				if (stackRequiredFor(contract)) {
					const { module } = await freezeCurrentSlice(projectRoot, jobDirectory, contract);
					await scaffoldModule(projectRoot, module);
					await assertScaffoldedBeforeBehavior(projectRoot, module);
				}
			} catch (error) {
				return needsHuman(
					{ state, stopState: currentStopState, shippedThisRun },
					"stack",
					describeError(error),
					jobId,
				);
			}
		}

		const completedNodes = [...state.active];
		if (completedNodes.includes("ship")) {
			// The commit decision is being made in this pass, whatever the superstep
			// goes on to do with it.
			shippedThisRun = true;
			// The branch is the control plane's to get right, not the model's: the
			// ship node commits, pushes, and opens its pull request from wherever
			// the worktree is, so the worktree is put on kpi/<job id> first.
			try {
				await ensureJobBranch(projectRoot, jobId);
			} catch (error) {
				return needsHuman(
					{ state, stopState: currentStopState, shippedThisRun },
					"ship",
					`could not switch to the job branch ${jobBranchName(jobId)}: ${describeError(error)}`,
					jobId,
				);
			}
		}
		const prePlan = completedNodes.includes("plan");
		facts.observe(currentStopState, completedNodes);
		try {
			state = await engine.runSuperstep();
		} catch (error) {
			if (error instanceof OperatorStopError) {
				return operatorStop();
			}
			if (error instanceof GraphNodeProviderError) {
				return needsHuman({ state, stopState: currentStopState, shippedThisRun }, "provider", error.message, jobId);
			}
			throw error;
		}

		// Every verifier round is a round: a review verdict, or a failed test
		// round (a passing one is judged by the review that follows it). The
		// witness is judged before the round is recorded, on the same terms the
		// facts merged before routing were.
		let event: VerifierEvent | undefined;
		if (completedNodes.includes("review")) {
			event = await verifierEventOnDisk(jobDirectory, "review");
			if (event === undefined) {
				return needsHuman(
					{ state, stopState: currentStopState, shippedThisRun },
					"contract",
					"review did not produce a verdict with an output fingerprint against evidence.json",
					jobId,
				);
			}
		} else if (
			completedNodes.includes("test") &&
			isJsonObject(state.values.test) &&
			state.values.test.passed === false &&
			isJsonObject(state.values.bounds) &&
			state.values.bounds.held === true
		) {
			event = await verifierEventOnDisk(jobDirectory, "test");
		}
		if (event !== undefined) {
			const witness = repeatedWitness(currentStopState, event);
			currentStopState = recordVerifier(currentStopState, event);
			if (witness !== undefined) {
				currentStopState = await recordNoProgress(
					ctx,
					jobDirectory,
					task,
					currentStopState,
					event,
					witness,
					state.status === "running" && state.active.includes("plan"),
				);
			}
		}
		if (state.status === "paused") {
			// The topology parked the run for the operator, or the engine refused a
			// contract defect. The engine has written the checkpoint; the driver
			// supplies the detail behind the fact and writes the one terminal.
			const pause = state.pause;
			if (pause === undefined) {
				throw new Error("paused graph carries no pause record");
			}
			const base = { state, stopState: currentStopState, shippedThisRun };
			if (pause.recovery === "bounds") {
				return needsHuman(base, "bounds", facts.boundsReason() ?? pause.reason, jobId);
			}
			// Plan owns stack.json via its response contract. A map the plan cannot
			// freeze is the same Dune refusal implement would raise: a stack pause
			// with the semantic reason, never a generic contract defect.
			const stackRefusal = pause.recovery === "contract" && prePlan ? planStackRefusal(pause.reason) : undefined;
			if (stackRefusal !== undefined) {
				return needsHuman(base, "stack", stackRefusal, jobId);
			}
			return needsHuman(base, pause.recovery, pause.reason, jobId);
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
	if (result.terminalEmitted !== true && status !== "RUNNING") {
		await appendEvent(eventsPath, {
			ts: new Date().toISOString(),
			type: "loop.terminal",
			job_id: task.job_id,
			round: result.stopState.round,
			node: activeNode(result.state),
			status,
			reason: result.reason,
			...(result.recovery === undefined ? {} : { recovery: result.recovery }),
		});
	}
	await writeState(jobDirectory, task, result.state, result.stopState, status, result.reason, result.recovery);
}

/** A terminal that leaves the gate pending, so a later interactive resume asks it again. */
type GateStop = DriveResult & { terminalStatus: "NEEDS_HUMAN" | "STOPPED" };

/** Waits on an operator dialog, unless the operator's stop lands first. */
function untilStop<T>(dialog: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) {
		return dialog;
	}
	if (signal.aborted) {
		return Promise.reject(new OperatorStopError());
	}
	const settled = Promise.withResolvers<T>();
	const onAbort = (): void => {
		settled.reject(new OperatorStopError());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	dialog.then(settled.resolve, settled.reject).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
	return settled.promise;
}

/** What a gate that takes feedback offers, and what its change request is about. */
interface FeedbackGate {
	options: typeof PLAN_GATE_OPTIONS | typeof RELEASE_GATE_OPTIONS;
	subject: "plan" | "release";
}

/** The operator's exit from a gate: an answer, a stop, or nothing (dismissed). */
type GateChoice = { answer: HumanAnswer } | { stopped: true } | undefined;

/**
 * Asks the operator a gate that takes feedback: a select over the gate's
 * options whose title carries the summary of the run file the node names, and
 * an editor for the change request. Nothing when the operator dismissed the
 * select; a stop when they chose it; every other exit is an answer.
 */
async function askGateWithFeedback(
	ctx: ExtensionCommandContext,
	node: HumanGraphNode,
	pending: PendingHumanInput,
	engine: GraphEngine,
	jobDirectory: string,
	jobId: string,
	gate: FeedbackGate,
	signal: AbortSignal | undefined,
): Promise<GateChoice> {
	// A summary that cannot be rendered is still a gate: the operator sees why
	// and can request changes, which is the answer a broken map needs.
	const summary =
		node.detail === undefined
			? ""
			: await readDuneStack(jobDirectory)
					.then(renderPlanSummary)
					.catch((error: unknown) => {
						const failure = `${node.detail} could not be summarised: ${describeError(error)}`;
						ctx.ui.notify(`K-π job ${jobId}: ${failure}`, "warning");
						return failure;
					});
	// The gate's own run count: the operator sees which revision this is. There
	// is no cap to show because there is none; the operator is the bound.
	const revision = engine.state.nodes[pending.nodeId]?.runs ?? 1;
	const title = [
		pending.title,
		pending.question,
		...(summary.length === 0 ? [] : ["", summary]),
		"",
		...(node.detail === undefined ? [] : [`Full plan: ${CONFIG_DIR_NAME}/runs/${jobId}/${node.detail}`]),
		`Revision ${revision}`,
	].join("\n");
	const [approve, requestChanges, stop] = gate.options;
	let previous = "";
	for (;;) {
		const choice = await untilStop(ctx.ui.select(title, [...gate.options]), signal);
		if (choice === undefined) {
			return undefined;
		}
		if (choice === approve) {
			return { answer: { approved: true } };
		}
		if (choice === stop) {
			return { stopped: true };
		}
		if (choice !== requestChanges) {
			throw new Error(`${pending.title} was answered with an option it did not offer: ${choice}`);
		}
		const text = await untilStop(
			ctx.ui.editor(`Request changes to ${node.detail ?? `the ${gate.subject}`}`, previous),
			signal,
		);
		if (text === undefined) {
			// A dismissed editor is not a decision: back to the select.
			continue;
		}
		const feedback = text.trim();
		if (feedback.length === 0) {
			ctx.ui.notify(`K-π feedback is required to request ${gate.subject} changes`, "warning");
			continue;
		}
		if (feedback.length > MAX_HUMAN_FEEDBACK_CHARS) {
			ctx.ui.notify(
				`K-π feedback must be at most ${MAX_HUMAN_FEEDBACK_CHARS} characters (got ${feedback.length})`,
				"warning",
			);
			previous = text;
			continue;
		}
		return { answer: { approved: false, feedback } };
	}
}

/**
 * Answers the gate an interrupted graph is waiting on, or says why it cannot.
 *
 * Without dialog UI the gate is never answered on the operator's behalf: the
 * run stops `NEEDS_HUMAN` with the resume command, the engine stays
 * interrupted with the gate pending, and an interactive resume asks it. An
 * answer is recorded as `approval.result`, submitted, and made durable before
 * the graph moves on. A Stop, or the operator's stop landing while the gate
 * is open, leaves it pending the same way and the job STOPPED.
 */
async function answerPendingHuman(
	engine: GraphEngine,
	graph: GraphDefinition,
	ctx: ExtensionCommandContext,
	jobDirectory: string,
	eventsPath: string,
	task: Task,
	stopState: StopState,
	signal: AbortSignal | undefined,
	onStateChange?: () => Promise<void>,
): Promise<GateStop | undefined> {
	const pending = engine.state.pendingHuman;
	if (pending === undefined) {
		throw new Error("Interrupted graph has no pending human approval");
	}
	const node = graph.nodes.find((candidate) => candidate.id === pending.nodeId);
	if (node?.type !== "human") {
		throw new Error(`pending human node does not exist: ${pending.nodeId}`);
	}
	const jobId = task.job_id;
	// The one notification a gate always gets; the TUI has no bell to ring.
	ctx.ui.notify(`K-π job ${jobId} is waiting on you: ${pending.title}`, "warning");
	const base = { state: engine.state, stopState };
	if (!ctx.hasUI) {
		return needsHuman(base, "approval", `${pending.title} needs an interactive session`, jobId) as GateStop;
	}
	let answer: HumanAnswer;
	try {
		if (node.feedbackPath === undefined) {
			answer = { approved: await untilStop(ctx.ui.confirm(pending.title, pending.question), signal) };
		} else {
			// The release gate is the one whose feedback goes back to implement;
			// every other feedback gate is a plan gate.
			const gate: FeedbackGate =
				node.statePath === "release.approved"
					? { options: RELEASE_GATE_OPTIONS, subject: "release" }
					: { options: PLAN_GATE_OPTIONS, subject: "plan" };
			const asked = await askGateWithFeedback(ctx, node, pending, engine, jobDirectory, jobId, gate, signal);
			if (asked === undefined) {
				return needsHuman(base, "approval", `${pending.title} was dismissed`, jobId) as GateStop;
			}
			if ("stopped" in asked) {
				return {
					...base,
					terminalStatus: "STOPPED",
					reason: `stopped by the operator at ${pending.title} (resume with /kpi ${jobId})`,
				};
			}
			answer = asked.answer;
		}
	} catch (error) {
		if (error instanceof OperatorStopError) {
			return {
				...base,
				terminalStatus: "STOPPED",
				reason: "operator stop",
				terminalEmitted: (await readStopMarker(jobDirectory))?.recorded === true,
			};
		}
		throw error;
	}
	await appendEvent(eventsPath, {
		ts: new Date().toISOString(),
		type: "approval.result",
		job_id: jobId,
		round: stopState.round,
		node: pending.nodeId,
		approved: answer.approved,
		question: pending.question,
		...(answer.feedback === undefined ? {} : { feedback: answer.feedback }),
	});
	await engine.submitHuman(answer);
	// The answer is durable before the next node runs: policy reads
	// `release.approved` from state.json, and a push or a pull request is
	// allowed on that flag alone.
	await writeState(jobDirectory, task, engine.state, stopState);
	await onStateChange?.();
	return undefined;
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
		throw new ShipIntegrityError("Ship node did not create a commit");
	}
	if (previousHead !== undefined) {
		const { stdout: count } = await execFile("git", ["rev-list", "--count", `${previousHead}..${head}`], {
			cwd: projectRoot,
		});
		if (count.trim() !== "1") {
			throw new ShipIntegrityError(`Ship node created ${count.trim()} commits instead of one`);
		}
	}
	const { stdout } = await execFile("git", ["log", "-1", "--pretty=%s"], {
		cwd: projectRoot,
	});
	const subject = stdout.trim();
	if (!CONVENTIONAL_COMMIT_PATTERN.test(subject)) {
		throw new ShipIntegrityError(`Ship commit is not Conventional Commits: ${subject}`);
	}
	if (jobId !== undefined) {
		const marked = await findJobCommit(projectRoot, jobId, previousHead);
		if (marked === undefined) {
			throw new ShipIntegrityError(`Ship commit does not carry ${SHIP_TRAILER_NAME}: ${jobId}`);
		}
		if (marked.head !== head) {
			throw new ShipIntegrityError(`Ship commit ${marked.head.slice(0, 8)} is not HEAD`);
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
	readPullRequest: LoopDependencies["readPullRequest"],
): Promise<void> {
	if ((await readShipMarker(projectRoot, jobDirectory, jobId)) !== undefined) {
		return;
	}
	if (shippedThisRun) {
		const subject = await verifyShippedCommit(projectRoot, previousHead, jobId);
		const head = await gitHead(projectRoot);
		const delivery =
			head === undefined ? undefined : await verifyShipDelivery(projectRoot, jobId, head, readPullRequest);
		await writeShipMarker(projectRoot, jobDirectory, jobId, subject, head, delivery);
		return;
	}
	const recovered = await findJobCommit(projectRoot, jobId, previousHead);
	if (recovered === undefined) {
		throw new Error(`No commit carries ${SHIP_TRAILER_NAME}: ${jobId}`);
	}
	// A recovered decision is held to the same delivery: a job whose push or
	// pull request failed resumes here once the operator has put it right.
	const delivery = await verifyShipDelivery(projectRoot, jobId, recovered.head, readPullRequest);
	await writeShipMarker(projectRoot, jobDirectory, jobId, recovered.subject, recovered.head, delivery);
}

/** What the no-progress prompt offers once the automatic re-plans are spent. */
export const NO_PROGRESS_OPTIONS = ["Give guidance", "Keep going", "Stop"] as const;

/** Everything a job's drive needs once its engine exists. */
interface JobRun {
	ctx: ExtensionCommandContext;
	dependencies: LoopDependencies;
	graph: GraphDefinition;
	engine: GraphEngine;
	jobId: string;
	jobDirectory: string;
	eventsPath: string;
	task: Task;
	facts: LoopFacts;
	/** The latest stop state; every drive and every touch replaces it. */
	stopState: StopState;
	previousHead: string | undefined;
	/** A resume into a no-progress pause asks the operator before it drives. */
	askNoProgressFirst: boolean;
}

/**
 * The engine options both entry points share. `onRetry` puts every backoff on
 * the record and on the board before the wait; `stopRequested` honours a
 * marker written by another session after every wait; `signal` is this
 * session's immediate stop.
 */
function engineOptions(
	ctx: ExtensionCommandContext,
	dependencies: LoopDependencies,
	jobId: string,
	jobDirectory: string,
	task: Task,
	facts: LoopFacts,
	current: () => { stop: StopState; state: Readonly<GraphRunState> },
): GraphEngineOptions {
	return {
		projectRoot: ctx.cwd,
		jobId,
		createAgentSession: dependencies.createAgentSession,
		busDependencies: dependencies.busDependencies,
		now: dependencies.now,
		accumulatedCostUsd: dependencies.accumulatedCostUsd,
		sleep: dependencies.sleep,
		retryBaseDelayMs: dependencies.retryBaseDelayMs,
		resolveFacts: facts.resolve,
		uiContext: ctx.ui,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		onSessionsChange: dependencies.onStateChange,
		signal: dependencies.signal,
		stopRequested: async () => (await readStopMarker(jobDirectory)) !== undefined,
		// The driver writes the one terminal of a pause itself, once it has
		// settled the recovery and worded the reason (writeTerminalState).
		emitTerminal: async () => {},
		onRetry: async (retry: NodeRetry) => {
			const { stop, state } = current();
			await appendEvent(join(jobDirectory, "events.jsonl"), {
				ts: new Date().toISOString(),
				type: "node.retry",
				job_id: jobId,
				round: stop.round,
				node: retry.nodeId,
				attempt: retry.attempt,
				reason: retry.reason,
				delay_ms: retry.delayMs,
				...(retry.status === undefined ? {} : { status: retry.status }),
				...(retry.message.length === 0 ? {} : { message: retry.message }),
			});
			await writeState(jobDirectory, task, state, stop);
			ctx.ui.notify(
				`K-π ${jobId} retry ${retry.attempt} on ${retry.nodeId}: ${retry.reason}; next in ${Math.ceil(retry.delayMs / 1000)}s (/kpi stop stops it)`,
				"warning",
			);
			await dependencies.onStateChange?.();
		},
	};
}

/**
 * The operator's answer to a run that repeated itself after its automatic
 * re-plans. Guidance goes to the planner through repair.json; guidance and
 * "Keep going" both start a fresh re-plan allowance and re-arm the run at
 * plan; "Stop" (or a dismissed prompt, or the operator's stop) ends it
 * STOPPED with everything intact for the next resume.
 */
async function settleNoProgress(run: JobRun): Promise<DriveResult | undefined> {
	const { ctx, engine, jobDirectory, task, dependencies } = run;
	const jobId = task.job_id;
	const stopped = (reason: string): DriveResult => ({
		state: engine.state,
		stopState: run.stopState,
		terminalStatus: "STOPPED",
		reason,
	});
	for (;;) {
		let choice: string | undefined;
		try {
			choice = await untilStop(
				ctx.ui.select(`K-π no progress after ${MAX_AUTOMATIC_REPLANS} re-plans`, [...NO_PROGRESS_OPTIONS]),
				dependencies.signal,
			);
		} catch (error) {
			if (error instanceof OperatorStopError) {
				return {
					...stopped("operator stop"),
					terminalEmitted: (await readStopMarker(jobDirectory))?.recorded === true,
				};
			}
			throw error;
		}
		if (choice === undefined || choice === NO_PROGRESS_OPTIONS[2]) {
			return stopped(`stopped by the operator after no progress (resume with /kpi ${jobId})`);
		}
		if (choice === NO_PROGRESS_OPTIONS[0]) {
			const repair = run.stopState.repair;
			if (repair === undefined) {
				// Nothing to guide: the state that paused carries no repair record.
				ctx.ui.notify(`K-π job ${jobId} has no ${REPAIR_FILE_NAME} to guide; choose Keep going or Stop`, "warning");
				continue;
			}
			const text = await untilStop(
				ctx.ui.editor("Guidance for the planner", repair.guidance ?? ""),
				dependencies.signal,
			);
			if (text === undefined) {
				// A dismissed editor is not a decision: back to the select.
				continue;
			}
			const guidance = text.trim();
			if (guidance.length === 0) {
				ctx.ui.notify(
					"K-π guidance is required to give guidance; choose Keep going to continue without it",
					"warning",
				);
				continue;
			}
			const guided: PlanRepair = { ...repair, guidance };
			await atomicWrite(join(jobDirectory, REPAIR_FILE_NAME), `${JSON.stringify(guided, null, 2)}\n`);
			run.stopState = { ...run.stopState, repair: guided, repaired: [] };
		} else if (choice === NO_PROGRESS_OPTIONS[1]) {
			run.stopState = { ...run.stopState, repaired: [] };
		} else {
			throw new Error(`the no-progress prompt was answered with an option it did not offer: ${choice}`);
		}
		engine.rearm();
		await writeState(jobDirectory, task, engine.state, run.stopState);
		await dependencies.onStateChange?.();
		return undefined;
	}
}

/**
 * Drives until the graph pauses, and settles a no-progress pause with the
 * operator when there is one to ask: an interactive session is offered
 * guidance, keep going, or stop and the run continues on the first two.
 * Without a UI the NEEDS_HUMAN stands, with the resume command.
 */
async function driveWithOperator(run: JobRun): Promise<DriveResult> {
	for (;;) {
		if (run.askNoProgressFirst) {
			run.askNoProgressFirst = false;
			const settled = await settleNoProgress(run);
			if (settled !== undefined) {
				return settled;
			}
		}
		const result = await driveUntilPause(
			run.engine,
			run.ctx,
			run.ctx.cwd,
			run.jobDirectory,
			run.task,
			run.facts,
			run.stopState,
			run.dependencies.onStateChange,
		);
		run.stopState = result.stopState;
		if (result.terminalStatus !== "NEEDS_HUMAN" || result.recovery !== "no_progress" || !run.ctx.hasUI) {
			return result;
		}
		// On the record before the operator is asked: a session lost mid-dialog
		// resumes into the same question.
		await writeTerminalState(run.jobDirectory, run.eventsPath, run.task, result);
		await run.dependencies.onStateChange?.();
		const settled = await settleNoProgress(run);
		if (settled !== undefined) {
			return settled;
		}
	}
}

/**
 * Drives a job from its current graph state to an outcome: every pause the
 * operator settles, every gate they answer, the release check, and the one
 * commit decision. Every terminal goes through the one writer, so a finished
 * run is legible from `events.jsonl` on its own.
 */
async function driveJob(run: JobRun): Promise<LoopOutcome> {
	const { ctx, engine, jobId, jobDirectory, eventsPath, task, dependencies } = run;
	const finish = async (result: DriveResult): Promise<LoopOutcome> => {
		await writeTerminalState(jobDirectory, eventsPath, task, result);
		await dependencies.onStateChange?.();
		return {
			jobId,
			status: result.terminalStatus ?? "RUNNING",
			reason: result.reason,
			recovery: result.recovery,
			graphState: result.state,
		};
	};
	let result = await driveWithOperator(run);
	while (result.terminalStatus === undefined && result.state.status === "interrupted") {
		const stopped = await answerPendingHuman(
			engine,
			run.graph,
			ctx,
			jobDirectory,
			eventsPath,
			task,
			run.stopState,
			dependencies.signal,
			dependencies.onStateChange,
		);
		if (stopped !== undefined) {
			return finish(stopped);
		}
		result = await driveWithOperator(run);
	}
	if (result.terminalStatus !== undefined) {
		return finish(result);
	}
	if (result.state.status !== "completed") {
		throw new Error(`Cannot continue graph in ${result.state.status} state`);
	}
	// The release gate the graph ends on: a graph that completed without an
	// approved release is not silently DONE. An operator who denied it under
	// a policy that ends the graph stopped the job for good; anything else is
	// a contract the graph did not keep.
	const release = result.state.values.release;
	if (!isJsonObject(release) || release.approved !== true) {
		return finish(
			isJsonObject(release) && release.approved === false
				? {
						...result,
						terminalStatus: "STOPPED",
						reason: "release denied by the operator (final: the graph completed)",
					}
				: needsHuman(result, "contract", "graph completed without release approval", jobId),
		);
	}
	try {
		// One job, one commit decision, identified by this job's own trailer:
		// this run's commit, or the marked one a replay recovers, never a second.
		await finalizeShip(
			ctx.cwd,
			jobDirectory,
			jobId,
			run.previousHead,
			result.shippedThisRun === true,
			dependencies.readPullRequest,
		);
	} catch (error) {
		// A failed finalization is a terminal the operator reads like any
		// other - the reason and the resume command - rather than a thrown
		// "loop failed" that hides which job stopped and why.
		return finish({ ...result, ...shipFailure(error, jobId) });
	}
	return finish({ ...result, terminalStatus: "DONE" });
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
	// The marker that stopped this job would stop it again at its first
	// superstep; resuming is the operator lifting it.
	await rm(join(jobDirectory, STOP_MARKER_NAME), { force: true });
	// Read leniently: a contract from the release that enforced caps still
	// carries `limits`. It is reported as ignored, never validated, and left on
	// the contract so the hashes research.json and stack.json bound to still hold.
	const task = JSON.parse(await readFile(join(jobDirectory, "task.json"), "utf8")) as Task & {
		limits?: Record<string, unknown>;
	};
	const legacyLimits = Object.keys(task.limits ?? {});
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
	const facts = loopFacts(ctx.cwd, jobDirectory, task, baseline, await planWasProvided(jobDirectory));
	const eventsPath = join(jobDirectory, "events.jsonl");
	let run: JobRun;
	const engine = await GraphEngine.restore(
		graph,
		engineOptions(ctx, dependencies, jobId, jobDirectory, task, facts, () => ({
			stop: run.stopState,
			state: run.engine.state,
		})),
	);
	run = {
		ctx,
		dependencies,
		graph,
		engine,
		jobId,
		jobDirectory,
		eventsPath,
		task,
		facts,
		stopState: restoreStopState(stateDocument),
		previousHead: await startingHeadFor(jobDirectory),
		askNoProgressFirst: stateDocument.recovery === "no_progress" && ctx.hasUI,
	};
	try {
		// Caps a retired release froze onto the contract or the checkpoint are
		// read, reported once, and never enforced: the run they ended continues.
		const retired = [...engine.retiredLimits, ...legacyLimits.filter((key) => !engine.retiredLimits.includes(key))];
		if (retired.length > 0) {
			const detail = `retired caps ignored: ${retired.join(", ")}`;
			await appendEvent(eventsPath, {
				ts: new Date().toISOString(),
				type: "checkpoint",
				job_id: jobId,
				round: run.stopState.round,
				node: activeNode(engine.state),
				detail,
			});
			ctx.ui.notify(`K-π job ${jobId}: ${detail}`, "info");
		}
		// The run is live again from here: a resumed pause or stop is RUNNING on
		// disk before its first superstep, not after.
		if (!run.askNoProgressFirst && engine.state.status === "running") {
			await writeState(jobDirectory, task, engine.state, run.stopState);
			await dependencies.onStateChange?.();
		}
		return await driveJob(run);
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
	const gates = await detectQualityGates(ctx.cwd);
	if (gates.source === "none") {
		ctx.ui.notify(`K-π quality gates: ${gates.reason}`, "warning");
	}
	const jobId = dependencies.jobId ?? makeJobId(invocation.goal);
	const task: Task = {
		job_id: jobId,
		mode: invocation.mode,
		goal: invocation.goal,
		nongoals: [],
		acceptance: compilation.acceptance,
		constraints:
			invocation.mode === "autopilot"
				? [
						"Commit only after deterministic release approval",
						`Push only the job branch kpi/${jobId} to origin after release approval, then open a pull request; never push another branch, force-push, push tags, delete a branch, or merge`,
					]
				: [
						"Human approval is required before commit",
						`Push only the job branch kpi/${jobId} to origin after approval, then open a pull request; never push another branch, force-push, push tags, delete a branch, or merge`,
					],
		quality_gates: gates.commands,
		ac: { quality: compilation.quality },
		dependency_baseline: await runtimeDependencies(ctx.cwd),
		...(invocation.noNetwork === true ? { research_network: "offline" as const } : {}),
		// K-mode's match is frozen here and nowhere else: name plus every ordered
		// step (including skip reasons). Re-matching mid-run would change what the
		// run was for; contractHash includes this freeze for the same reason.
		...(kModeState.plan === undefined
			? {}
			: {
					playbook: kModeState.plan.playbook,
					playbook_steps: kModeState.plan.steps.map((step) =>
						step.skip === undefined
							? { node: step.node, text: step.text }
							: { node: step.node, text: step.text, skip: step.skip },
					),
				}),
	};
	const job = await createJob(ctx.cwd, task, contextFor(invocation, gates, plan));
	if (plan !== undefined) {
		await writePlanSnapshot(job.directory, plan);
	}

	if (invocation.mode === "autopilot" && compilation.quality !== "executable") {
		const refusal = `autopilot requires executable acceptance criteria; received ${compilation.quality}`;
		const reason = recoveryReason("ac_quality", refusal, job.jobId);
		await appendEvent(job.eventsPath, {
			ts: new Date().toISOString(),
			type: "ac.refused",
			job_id: job.jobId,
			round: 0,
			node: "ac-compiler",
			quality: compilation.quality,
			reason: refusal,
		});
		await atomicWrite(
			join(job.directory, "state.json"),
			`${JSON.stringify(
				{
					job_id: task.job_id,
					mode: task.mode,
					round: 0,
					stage: "ac-compile",
					node: "ac-compiler",
					ac: task.ac,
					status: "NEEDS_HUMAN",
					reason,
					recovery: "ac_quality",
					graph_status: "not_started",
				},
				null,
				2,
			)}\n`,
		);
		await dependencies.onStateChange?.();
		return { jobId: job.jobId, status: "NEEDS_HUMAN", reason, recovery: "ac_quality" };
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
	const baseline = await worktreeSnapshot(ctx.cwd);
	await atomicWrite(
		join(job.directory, "baseline.json"),
		`${JSON.stringify(Object.fromEntries(baseline), null, 2)}\n`,
	);
	await atomicWrite(join(job.directory, "previous-head.txt"), `${previousHead ?? ""}\n`);
	const facts = loopFacts(ctx.cwd, job.directory, task, baseline, plan !== undefined);
	let run: JobRun;
	const engine = new GraphEngine(
		graph,
		engineOptions(ctx, dependencies, job.jobId, job.directory, task, facts, () => ({
			stop: run.stopState,
			state: run.engine.state,
		})),
	);
	run = {
		ctx,
		dependencies,
		graph,
		engine,
		jobId: job.jobId,
		jobDirectory: job.directory,
		eventsPath: job.eventsPath,
		task,
		facts,
		stopState: createStopState(),
		previousHead,
		askNoProgressFirst: false,
	};
	try {
		await writeState(job.directory, task, engine.state, run.stopState);
		await dependencies.onStateChange?.();
		return await driveJob(run);
	} finally {
		engine.dispose();
	}
}
