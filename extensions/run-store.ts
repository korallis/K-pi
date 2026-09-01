import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

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
}

export function writeAllowForTask(
  task: Pick<Task, "acceptance">,
): string[] {
  return task.acceptance.flatMap(
    (criterion) => criterion.bounds?.write_allow ?? [],
  );
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

const JOB_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
}

function tempPathFor(path: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -5)}.tmp` : `${path}.tmp`;
}

export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = tempPathFor(path);
  const file = await open(tempPath, "w", 0o600);

  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(tempPath, path);
}

export async function createJob(
  projectRoot: string,
  task: Task,
  context = "",
): Promise<Job> {
  assertJobId(task.job_id);
  const runsDirectory = join(projectRoot, ".pi", "runs");
  const directory = join(runsDirectory, task.job_id);
  await mkdir(runsDirectory, { recursive: true });
  await mkdir(directory);

  await atomicWrite(
    join(directory, "task.json"),
    `${JSON.stringify(task, null, 2)}\n`,
  );
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

export async function readJob(
  projectRoot: string,
  jobId: string,
): Promise<Job> {
  assertJobId(jobId);
  const directory = join(projectRoot, ".pi", "runs", jobId);
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
