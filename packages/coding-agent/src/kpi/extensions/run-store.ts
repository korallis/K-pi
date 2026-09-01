import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CONFIG_DIR_NAME } from "../../config.ts";

import type { JsonValue } from "./append-log.ts";
import { validateBudgetOverrides } from "./graph/budget.ts";
import type { GraphBudgetOverrides } from "./graph/schema.ts";

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
	playbook?: string;
	runtime_dependencies?: string[];
	dependency_baseline?: string[];
	/**
	 * Caps this job runs under. Anything absent falls back to the graph file,
	 * then to the spec default. Validated before the engine reads it.
	 */
	limits?: GraphBudgetOverrides;
	/** The one slice an implement round ships. Never inferred from modules[0]. */
	current_module_id?: string;
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

const JOB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

export async function createJob(projectRoot: string, task: Task, context = ""): Promise<Job> {
	assertJobId(task.job_id);
	validateBudgetOverrides(task.limits, `task ${task.job_id} limits`);
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
 * `current_module_id` and `playbook` are deliberately excluded. They select
 * which slice this round owns and which rigor playbook shapes its steps, and
 * both are set by an editor that runs while the job is already open - the plan
 * re-freezing the slice, the K-mode matcher naming the playbook. Folding them in
 * would make every selection look like a changed contract and stale the research
 * and stack bound to it. Goal, non-goals, acceptance, constraints, gates and
 * caps - the things the job is judged against - are all still covered.
 */
export function contractHash(task: Task): string {
	const { current_module_id: _slice, playbook: _playbook, ...contract } = task;
	return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
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
	validateBudgetOverrides(task.limits, `task ${jobId} limits`);

	return {
		jobId,
		directory,
		task,
		context,
		eventsPath: join(directory, "events.jsonl"),
	};
}

async function readStateCandidate(directory: string): Promise<(ActiveJob & { modifiedAt: number }) | undefined> {
	const statePath = join(directory, "state.json");
	try {
		const [source, metadata] = await Promise.all([readFile(statePath, "utf8"), stat(statePath)]);
		const state = JSON.parse(source) as RunState;
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
 * The product terminals a run can end at. A job whose state document carries one
 * of these is finished: it is still the newest run on disk, but it is no longer
 * the run a follow-up belongs to.
 */
const TERMINAL_RUN_STATUSES = new Set(["DONE", "BLOCKED", "EXHAUSTED", "NO_PROGRESS", "UNSAFE", "NEEDS_HUMAN"]);

export function isFinishedRunStatus(status: unknown): boolean {
	return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status);
}

/** Whether this job is still the one a bare follow-up should steer. */
export function isLiveJob(job: ActiveJob | undefined): job is ActiveJob {
	return job !== undefined && !isFinishedRunStatus(job.state.status);
}

export async function readActiveJob(cwd: string): Promise<ActiveJob | undefined> {
	const runsDirectory = join(cwd, CONFIG_DIR_NAME, "runs");
	let entries: Dirent[];
	try {
		entries = await readdir(runsDirectory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
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
	return candidates[0];
}
