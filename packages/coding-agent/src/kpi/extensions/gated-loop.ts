import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { CONFIG_DIR_NAME } from "../../config.ts";

import type { ExtensionCommandContext } from "../../core/extensions/types.ts";

import { appendEvent } from "./append-log.ts";
import { compileAcceptanceCriteria } from "./graph/ac-compiler.ts";
import { type GraphAgentSessionFactory, GraphEngine, loadNamedGraph } from "./graph/engine.ts";
import { type GraphRunState, isJsonObject } from "./graph/schema.ts";
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
import { atomicWrite, createJob, type Task, writeAllowForTask } from "./run-store.ts";
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

async function worktreeSnapshot(projectRoot: string): Promise<Map<string, string>> {
	const { stdout } = await execFile("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: projectRoot,
	});
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
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			snapshot.set(path, "<absent>");
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

function reviewStatus(state: Readonly<GraphRunState>): string | undefined {
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

async function releaseReady(
	state: Readonly<GraphRunState>,
	projectRoot: string,
	runDirectory: string,
	task: Task,
): Promise<boolean> {
	const test = state.values.test;
	const bounds = state.values.bounds;
	const fingerprints = state.values.fingerprints;
	let evidence: unknown;
	try {
		evidence = JSON.parse(await readFile(join(runDirectory, "evidence.json"), "utf8"));
	} catch {
		return false;
	}
	return (
		isJsonObject(test) &&
		test.passed === true &&
		isJsonObject(bounds) &&
		bounds.held === true &&
		isJsonObject(fingerprints) &&
		fingerprints.fresh === true &&
		isJsonObject(evidence) &&
		evidencePasses(task, evidence) &&
		reviewApproved(state) &&
		typeof evidence.head === "string" &&
		evidence.head === (await gitHead(projectRoot))
	);
}

interface DriveResult {
	state: Readonly<GraphRunState>;
	stopState: StopState;
	terminalStatus?: TerminalStatus;
	reason?: string;
	/** The engine already emitted the one `loop.terminal` event for this run. */
	terminalEmitted?: boolean;
}

async function driveUntilPause(
	engine: GraphEngine,
	projectRoot: string,
	jobDirectory: string,
	task: Task,
	baseline: ReadonlyMap<string, string>,
	stopState: StopState,
	onStateChange?: () => Promise<void>,
): Promise<DriveResult> {
	let state = engine.state;
	let currentStopState = stopState;
	while (state.status === "running") {
		if (state.active.some((node) => node === "specify" || node === "plan" || node === "plan-check")) {
			try {
				await assertResearchFresh(jobDirectory, task);
			} catch {
				await conductResearch(projectRoot, jobDirectory, task, {
					exaKey: process.env.EXA_API_KEY,
					perplexityKey: process.env.PERPLEXITY_API_KEY,
				});
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
					terminalStatus: "UNSAFE",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		}
		if (state.active.includes("bounds")) {
			const current = await worktreeSnapshot(projectRoot);
			const violations = changedPaths(baseline, current).filter(
				(path) => !isWriteAllowed(projectRoot, path, writeAllowForTask(task)),
			);
			if (violations.length > 0) {
				return {
					state,
					stopState: currentStopState,
					terminalStatus: "UNSAFE",
					reason: `write outside write_allow: ${violations.join(", ")}`,
				};
			}
			try {
				await assertMinimalistBounds(projectRoot, jobDirectory, task);
			} catch (error) {
				return {
					state,
					stopState: currentStopState,
					terminalStatus: "UNSAFE",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		}
		if (state.active.includes("release.set") && !(await releaseReady(state, projectRoot, jobDirectory, task))) {
			return {
				state,
				stopState: currentStopState,
				terminalStatus: "NEEDS_HUMAN",
				reason: "release evidence is incomplete or stale",
			};
		}

		const completedNodes = [...state.active];
		state = await engine.runSuperstep();
		if (state.status === "exhausted") {
			// The engine owns cap exhaustion end to end: it has already written the
			// durable EXHAUSTED checkpoint and the single terminal event.
			return {
				state,
				stopState: currentStopState,
				terminalStatus: "EXHAUSTED",
				reason: state.terminal?.reason ?? "graph exhausted a configured cap",
				terminalEmitted: true,
			};
		}
		if (completedNodes.includes("review")) {
			if (reviewStatus(state) === "BLOCKED") {
				return {
					state,
					stopState: currentStopState,
					terminalStatus: "NEEDS_HUMAN",
					reason: "review reported an untestable blocking issue",
				};
			}
			const outputFingerprint = reviewFingerprint(state);
			if (outputFingerprint === undefined) {
				return {
					state,
					stopState: currentStopState,
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
	return { state, stopState: currentStopState };
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

export async function verifyShippedCommit(projectRoot: string, previousHead: string | undefined): Promise<string> {
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
	return subject;
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
	const engine = await GraphEngine.restore(graph, {
		projectRoot: ctx.cwd,
		jobId,
		createAgentSession: dependencies.createAgentSession,
		now: dependencies.now,
		accumulatedCostUsd: dependencies.accumulatedCostUsd,
		limits: task.limits,
		sleep: dependencies.sleep,
		retryBaseDelayMs: dependencies.retryBaseDelayMs,
	});
	const baselineSource = JSON.parse(await readFile(join(jobDirectory, "baseline.json"), "utf8")) as Record<
		string,
		string
	>;
	const baseline = new Map(Object.entries(baselineSource));
	const eventsPath = join(jobDirectory, "events.jsonl");
	const stopState = restoreStopState(stateDocument, engine.limits.maxRounds);
	try {
		let result = await driveUntilPause(
			engine,
			ctx.cwd,
			jobDirectory,
			task,
			baseline,
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
				baseline,
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
		const previousHead = (await readFile(join(jobDirectory, "previous-head.txt"), "utf8")).trim() || undefined;
		await verifyShippedCommit(ctx.cwd, previousHead);
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
	const loadedGraph = await loadNamedGraph(ctx.cwd, graphName);
	const graph = plan === undefined ? loadedGraph : { ...loadedGraph, entry: "plan-check" };
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
	const engine = new GraphEngine(graph, {
		projectRoot: ctx.cwd,
		jobId: job.jobId,
		createAgentSession: dependencies.createAgentSession,
		now: dependencies.now,
		accumulatedCostUsd: dependencies.accumulatedCostUsd,
		limits: task.limits,
		sleep: dependencies.sleep,
		retryBaseDelayMs: dependencies.retryBaseDelayMs,
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
			baseline,
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
				baseline,
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
			await verifyShippedCommit(ctx.cwd, previousHead);
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
