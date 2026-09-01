import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkerRole = "implementer" | "reviewer" | "tester" | "arena" | "explorer";

export interface WorkerLaunch {
  process?: ChildProcess;
  pid: number;
  send(message: string, deliverAs: "steer" | "followUp"): Promise<void>;
  stop(): Promise<void>;
}

export type WorkerLauncher = (options: {
  cwd: string;
  prompt: string;
  sessionPath: string;
  model?: string;
  tools: string[];
}) => Promise<WorkerLaunch>;

export interface WorkerRecord {
  agentId: string;
  role: WorkerRole;
  pid: number;
  sessionPath: string;
  tools: string[];
  launch: WorkerLaunch;
}

const defaultLauncher: WorkerLauncher = async (options) => {
  const args = ["--mode", "rpc", "--session", options.sessionPath];
  if (options.model !== undefined) args.push("--model", options.model);
  const child = spawn("pi", args, { cwd: options.cwd, stdio: ["pipe", "ignore", "ignore"] });
  const send = async (message: string, deliverAs: "steer" | "followUp") => {
    child.stdin?.write(`${JSON.stringify({ type: "prompt", message, deliverAs })}\n`);
  };
  await send(options.prompt, "followUp");
  return {
    process: child,
    pid: child.pid ?? -1,
    send,
    stop: async () => { child.kill("SIGTERM"); },
  };
};

export class BackgroundBus {
  readonly agentsDirectory: string;
  readonly busPath: string;
  readonly leasesPath: string;
  readonly cwd: string;
  readonly runDirectory: string;
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly launcher: WorkerLauncher;

  constructor(cwd: string, runDirectory: string, launcher: WorkerLauncher = defaultLauncher) {
    this.cwd = cwd;
    this.runDirectory = runDirectory;
    this.agentsDirectory = join(runDirectory, "agents");
    this.busPath = join(runDirectory, "bus.jsonl");
    this.leasesPath = join(runDirectory, "leases.json");
    this.launcher = launcher;
  }

  async spawn(options: { role: WorkerRole; prompt: string; model?: string; tools?: string[] }): Promise<WorkerRecord> {
    this.reap();
    if (this.workers.size >= 2) throw new Error("Background worker limit is 2");
    const tools = options.tools ?? (options.role === "reviewer" ? ["read", "grep", "bash"] : ["read", "grep"]);
    const wantsWrite = tools.includes("write") || tools.includes("edit");
    if (wantsWrite && [...this.workers.values()].some((worker) => worker.tools.includes("write") || worker.tools.includes("edit"))) {
      throw new Error("A writer worker is already live");
    }
    await mkdir(this.agentsDirectory, { recursive: true });
    const agentId = `${options.role}-${randomUUID()}`;
    const sessionPath = join(this.agentsDirectory, `${agentId}.jsonl`);
    await writeFile(sessionPath, "", { flag: "a" });
    const launch = await this.launcher({ cwd: this.cwd, prompt: options.prompt, sessionPath, model: options.model, tools });
    const record = { agentId, role: options.role, pid: launch.pid, sessionPath, tools, launch };
    this.workers.set(agentId, record);
    await this.log({ type: "agent.spawned", agent_id: agentId, pid: launch.pid, role: options.role });
    return record;
  }

  get(agentId: string): WorkerRecord | undefined { this.reap(); return this.workers.get(agentId); }
  list(): WorkerRecord[] { this.reap(); return [...this.workers.values()]; }

  async communicate(agentId: string, message: string, deliverAs: "steer" | "followUp" = "followUp"): Promise<void> {
    const worker = this.get(agentId);
    if (worker === undefined) throw new Error(`Unknown or stopped worker: ${agentId}`);
    await worker.launch.send(message, deliverAs);
    await this.log({ type: "agent.message", agent_id: agentId, deliverAs });
  }

  async stop(agentId: string): Promise<void> {
    const worker = this.workers.get(agentId);
    if (worker === undefined) return;
    await worker.launch.stop();
    this.workers.delete(agentId);
    await this.releaseAll(agentId);
  }

  async claim(agentId: string, path: string): Promise<void> {
    const leases = await this.readLeases();
    const holder = leases[path];
    if (holder !== undefined && holder !== agentId && this.get(holder) !== undefined) throw new Error(`Path already claimed: ${path}`);
    leases[path] = agentId;
    await writeFile(this.leasesPath, `${JSON.stringify(leases, null, 2)}\n`);
  }

  async release(agentId: string, path: string): Promise<void> {
    const leases = await this.readLeases();
    if (leases[path] === agentId) delete leases[path];
    await writeFile(this.leasesPath, `${JSON.stringify(leases, null, 2)}\n`);
  }

  private async releaseAll(agentId: string): Promise<void> {
    const leases = await this.readLeases();
    for (const [path, holder] of Object.entries(leases)) if (holder === agentId) delete leases[path];
    await writeFile(this.leasesPath, `${JSON.stringify(leases, null, 2)}\n`);
  }

  private reap(): void {
    for (const [id, worker] of this.workers) {
      if (
        worker.launch.process !== undefined &&
        worker.launch.process.exitCode !== null
      ) this.workers.delete(id);
    }
  }

  private async readLeases(): Promise<Record<string, string>> {
    await mkdir(this.runDirectory, { recursive: true });
    try { return JSON.parse(await readFile(this.leasesPath, "utf8")) as Record<string, string>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }

  private async log(value: Record<string, unknown>): Promise<void> {
    await appendFile(this.busPath, `${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`);
  }
}
