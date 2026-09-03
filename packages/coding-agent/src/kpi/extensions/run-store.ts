import { createHash, randomUUID } from "node:crypto";
import { closeSync, type Dirent, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CONFIG_DIR_NAME } from "../../config.ts";

import type { JsonValue } from "./append-log.ts";

/** The four run states. Only RUNNING is live; NEEDS_HUMAN and STOPPED resume with `/kpi <job>`. */
export const RUN_STATUSES = ["RUNNING", "NEEDS_HUMAN", "DONE", "STOPPED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Why a run paused NEEDS_HUMAN: what the operator must do before `/kpi <job>` continues. */
export const LOOP_RECOVERIES = [
	"approval",
	"provider",
	"delivery",
	"ship",
	"bounds",
	"review",
	"no_progress",
	"research",
	"stack",
	"contract",
	"ac_quality",
] as const;
export type LoopRecovery = (typeof LOOP_RECOVERIES)[number];

/**
 * Status tokens written by earlier releases. Each was a death the loop chose on
 * its own; every one reads as a pause the operator can resume.
 */
const LEGACY_NEEDS_HUMAN_STATUSES: Record<string, true> = {
	BLOCKED: true,
	EXHAUSTED: true,
	NO_PROGRESS: true,
	UNSAFE: true,
};

/** The run state a raw status token denotes, or undefined for anything outside the vocabulary. */
export function runStatus(raw: unknown): RunStatus | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	if ((RUN_STATUSES as readonly string[]).includes(raw)) {
		return raw as RunStatus;
	}
	return LEGACY_NEEDS_HUMAN_STATUSES[raw] === true ? "NEEDS_HUMAN" : undefined;
}

export type CheckKind =
	| "command"
	| "file_exists"
	| "file_absent"
	| "grep_empty"
	| "grep_matches"
	| "json_path"
	| "http_probe";

export interface AcceptanceCriterion {
	id: string;
	statement: string;
	required: boolean;
	check?: {
		kind: CheckKind;
		cmd?: string;
		expect?: {
			exit?: number;
			stdout_includes?: string[];
		};
		[key: string]: unknown;
	};
	bounds?: {
		write_allow?: string[];
		write_deny?: string[];
	};
}

export interface Task {
	job_id: string;
	mode: "gated" | "autopilot";
	goal: string;
	nongoals: string[];
	acceptance: AcceptanceCriterion[];
	constraints: string[];
	quality_gates: string[];
	ac: {
		quality: "executable" | "partial" | "narrative";
	};
	/**
	 * Frozen K-stack playbook name selected at job create. Immutable for the life
	 * of the job: re-matching mid-run would change what the run was for.
	 */
	playbook?: string;
	/**
	 * Frozen ordered steps for `playbook`. Each entry is `{ node, text, skip? }`.
	 * State rendering and resume read only this snapshot — never process-global
	 * K-mode plan state or live generated skills.
	 */
	playbook_steps?: FrozenPlaybookStep[];
	runtime_dependencies?: string[];
	dependency_baseline?: string[];
	/** The one slice an implement round ships. Never inferred from modules[0]. */
	current_module_id?: string;
	/**
	 * The operator's own network decision for this job's research.
	 *
	 * On the contract rather than in process state so a resumed job stays offline:
	 * a job the operator declared offline must not quietly reach the network
	 * because a later process forgot the flag. Absent means `auto`.
	 */
	research_network?: "auto" | "offline";
}

/** One step frozen into `task.json` with the selected playbook. */
export interface FrozenPlaybookStep {
	node: string;
	text: string;
	skip?: string;
}

export function writeAllowForTask(task: Pick<Task, "acceptance">): string[] {
	return task.acceptance.flatMap((criterion) => criterion.bounds?.write_allow ?? []);
}

export interface Evidence {
	head: string;
	commands: Array<{
		cmd: string;
		exit: number;
		excerpt?: string;
	}>;
	ac_results: Array<{
		id: string;
		passed: boolean;
	}>;
}

export interface Verdict {
	status: "PASS" | "REVISE" | "BLOCKED";
	approved: boolean;
	blockingIssues: string[];
	nonBlockingIssues: string[];
	evidence: string[];
	round: number;
	output_fingerprint: string;
}

export interface Job {
	jobId: string;
	directory: string;
	task: Task;
	context: string;
	eventsPath: string;
}

/** A run's progress document, as written to `state.json`. */
export type RunState = Record<string, JsonValue>;

export interface ActiveJob {
	directory: string;
	eventsPath: string;
	jobId: string;
	state: RunState;
	statePath: string;
}

export const JOB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertJobId(jobId: string): void {
	if (!JOB_ID_PATTERN.test(jobId)) {
		throw new Error(`Invalid job id: ${jobId}`);
	}
}

/**
 * A temp path no other writer can be holding. Two writers sharing one temp file
 * would let a rename publish the other's half-written bytes, so the name
 * carries the process and a random token, and the file is created exclusively.
 */
function tempPathFor(path: string): string {
	const base = path.endsWith(".json") ? path.slice(0, -5) : path;
	return `${base}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
}

export interface AtomicWriteOptions {
	/**
	 * Injected opener. Tests use it to fail the write or the sync deliberately
	 * and prove the destination is left exactly as it was.
	 */
	openFile?: typeof open;
}

/**
 * Publishes `data` at `path` or leaves the previous contents untouched.
 *
 * The rename happens only after the bytes are written and fsynced, so a crash
 * or a failing device can never make a partial document visible, and a failed
 * attempt removes its own temp file rather than leaving litter behind for a
 * later reader to trip over.
 */
export async function atomicWrite(
	path: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = tempPathFor(path);
	const file = await (options.openFile ?? open)(tempPath, "wx", 0o600);

	try {
		try {
			await file.writeFile(data);
			await file.sync();
		} finally {
			await file.close();
		}
		// Only now: the content is complete and durable.
		await rename(tempPath, path);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

/**
 * The same publish-or-leave-untouched guarantee for a caller that cannot await.
 *
 * Extension registration is synchronous, and a file the resource loader reads
 * while assembling the first system prompt has to exist before that read - so
 * one small install cannot be deferred to a promise the loader will not wait
 * for. Same temp-then-rename order, same fsync before the rename.
 */
export function atomicWriteSync(path: string, data: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = tempPathFor(path);
	const handle = openSync(tempPath, "wx", 0o600);

	try {
		try {
			writeFileSync(handle, data);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		// Only now: the content is complete and durable.
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

export async function createJob(projectRoot: string, task: Task, context = ""): Promise<Job> {
	assertJobId(task.job_id);
	assertPlaybookFreeze(task);
	const runsDirectory = join(projectRoot, CONFIG_DIR_NAME, "runs");
	const directory = join(runsDirectory, task.job_id);
	await mkdir(runsDirectory, { recursive: true });
	await mkdir(directory);

	await atomicWrite(join(directory, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
	await atomicWrite(join(directory, "context.md"), context);

	const eventsPath = join(directory, "events.jsonl");
	const eventsFile = await open(eventsPath, "wx", 0o600);
	try {
		await eventsFile.sync();
	} finally {
		await eventsFile.close();
	}

	return {
		jobId: task.job_id,
		directory,
		task,
		context,
		eventsPath,
	};
}

/**
 * The hash of what the job must achieve.
 *
 * Only `current_module_id` is excluded: the plan may re-freeze which slice this
 * round owns while the job is open. The selected playbook name and its ordered
 * step snapshot are part of the contract — changing either means a different
 * job. Goal, non-goals, acceptance, constraints, gates, playbook and steps are
 * all covered.
 */
export function contractHash(task: Task): string {
	const { current_module_id: _slice, ...contract } = task;
	return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
}

/**
 * Playbook name and steps travel together. Either both are absent, or the name
 * is non-empty and every step is a schema-valid `{ node, text, skip? }` in order.
 */
export function assertPlaybookFreeze(task: Pick<Task, "playbook" | "playbook_steps">): void {
	const name = task.playbook;
	const steps = task.playbook_steps;
	if (name === undefined && steps === undefined) {
		return;
	}
	if (typeof name !== "string" || name.trim().length === 0) {
		throw new Error("task.playbook must be a non-empty string when playbook_steps are frozen");
	}
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error(`task.playbook ${name} requires a non-empty playbook_steps snapshot`);
	}
	for (const [index, step] of steps.entries()) {
		if (step === null || typeof step !== "object" || Array.isArray(step)) {
			throw new Error(`task.playbook_steps[${index}] must be an object`);
		}
		if (typeof step.node !== "string" || step.node.trim().length === 0) {
			throw new Error(`task.playbook_steps[${index}].node must be a non-empty string`);
		}
		if (typeof step.text !== "string" || step.text.trim().length === 0) {
			throw new Error(`task.playbook_steps[${index}].text must be a non-empty string`);
		}
		if (step.skip !== undefined && (typeof step.skip !== "string" || step.skip.trim().length === 0)) {
			throw new Error(`task.playbook_steps[${index}].skip must be a non-empty string when present`);
		}
	}
}

/** The frozen task contract for a job, without its context pack. */
export async function readTaskForJob(projectRoot: string, jobId: string): Promise<Task> {
	assertJobId(jobId);
	const source = await readFile(join(projectRoot, CONFIG_DIR_NAME, "runs", jobId, "task.json"), "utf8");
	const task = JSON.parse(source) as Task;
	if (task.job_id !== jobId) {
		throw new Error(`Job id mismatch: expected ${jobId}, found ${task.job_id}`);
	}
	return task;
}

export async function readJob(projectRoot: string, jobId: string): Promise<Job> {
	assertJobId(jobId);
	const directory = join(projectRoot, CONFIG_DIR_NAME, "runs", jobId);
	const [taskSource, context] = await Promise.all([
		readFile(join(directory, "task.json"), "utf8"),
		readFile(join(directory, "context.md"), "utf8"),
	]);
	const task = JSON.parse(taskSource) as Task;

	if (task.job_id !== jobId) {
		throw new Error(`Job id mismatch: expected ${jobId}, found ${task.job_id}`);
	}

	return {
		jobId,
		directory,
		task,
		context,
		eventsPath: join(directory, "events.jsonl"),
	};
}

/** Paths already reported so a torn write does not spam every footer refresh. */
const reportedUnreadableStates = new Set<string>();

function noteUnreadableState(statePath: string, reason: string): void {
	if (reportedUnreadableStates.has(statePath)) return;
	reportedUnreadableStates.add(statePath);
	console.warn(`[kpi/run-store] skipping unreadable state.json (${reason}): ${statePath}`);
}

/** Test hook: clear the once-per-path report set. */
export function resetUnreadableStateReportsForTests(): void {
	reportedUnreadableStates.clear();
}

async function readStateCandidate(directory: string): Promise<(ActiveJob & { modifiedAt: number }) | undefined> {
	const statePath = join(directory, "state.json");
	try {
		const [source, metadata] = await Promise.all([readFile(statePath, "utf8"), stat(statePath)]);
		// Empty or torn mid-write is "not a started run" — never throw into the
		// fire-and-forget footer refresh path (unhandledRejection under the suite).
		// Still report once so the operator can see a real corrupt file.
		if (source.trim().length === 0) {
			noteUnreadableState(statePath, "empty");
			return undefined;
		}
		let state: RunState;
		try {
			state = JSON.parse(source) as RunState;
		} catch (error) {
			if (error instanceof SyntaxError) {
				noteUnreadableState(statePath, "invalid JSON");
				return undefined;
			}
			throw error;
		}
		const jobId = typeof state.job_id === "string" ? state.job_id : basename(directory);
		return {
			directory,
			eventsPath: join(directory, "events.jsonl"),
			jobId,
			modifiedAt: metadata.mtimeMs,
			state,
			statePath,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * The run the operator is working in: the most recently written `state.json`
 * under `.kpi/runs`. A run directory without a progress document has not
 * started and is skipped.
 */
/**
 * Whether a run has finished: every state but RUNNING (legacy tokens included,
 * through runStatus()). Such a job is still the newest run on disk, but it is
 * no longer the run a follow-up belongs to. NEEDS_HUMAN and STOPPED are
 * finished-but-resumable.
 */
export function isFinishedRunStatus(status: unknown): boolean {
	const resolved = runStatus(status);
	return resolved !== undefined && resolved !== "RUNNING";
}

/** Whether this job is still the one a bare follow-up should steer. */
export function isLiveJob(job: ActiveJob | undefined): job is ActiveJob {
	return job !== undefined && !isFinishedRunStatus(job.state.status);
}

/** Every started run under `.kpi/runs`, newest progress document first. */
async function stateCandidates(cwd: string): Promise<(ActiveJob & { modifiedAt: number })[]> {
	const runsDirectory = join(cwd, CONFIG_DIR_NAME, "runs");
	let entries: Dirent[];
	try {
		entries = await readdir(runsDirectory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const candidates = (
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => readStateCandidate(join(runsDirectory, entry.name))),
		)
	).filter((candidate) => candidate !== undefined);
	candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
	return candidates;
}

export async function readActiveJob(cwd: string): Promise<ActiveJob | undefined> {
	return (await stateCandidates(cwd))[0];
}

/**
 * The run that is still open: the newest job that has not reached a product
 * terminal, or nothing when every run has ended.
 *
 * This is what the widget, the footer, and the policy hook read. A finished run
 * is still the newest document on disk, but it owns no follow-up, sets no policy
 * mode, and receives no tool.request records - drawing it above the editor as if
 * it were live is exactly how a dead `UNSAFE` job haunted a whole session.
 */
export async function readLiveJob(cwd: string): Promise<ActiveJob | undefined> {
	const newest = (await stateCandidates(cwd))[0];
	return isLiveJob(newest) ? newest : undefined;
}
