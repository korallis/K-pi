import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type ClaimStatus = "proposed" | "verified" | "rejected" | "superseded";

export interface GraphNode {
  id: string;
  kind: string;
  source_ids: string[];
  status: ClaimStatus;
  rev: number;
  observed_at: string;
  [key: string]: unknown;
}

export interface GraphPatch {
  node: Omit<GraphNode, "rev"> & { rev?: number };
}

async function readLines<T>(path: string): Promise<T[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export class KnowledgeGraphStore {
  readonly root: string;
  readonly inbox: string;
  readonly snapshots: string;
  readonly nodesPath: string;
  private mutations: Promise<void> = Promise.resolve();

  constructor(cwd: string) {
    this.root = join(cwd, ".pi", "kg");
    this.inbox = join(this.root, "inbox");
    this.snapshots = join(this.root, "snapshots");
    this.nodesPath = join(this.root, "nodes.jsonl");
  }

  async propose(patch: GraphPatch): Promise<string> {
    await mkdir(this.inbox, { recursive: true });
    const path = join(this.inbox, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(path, `${JSON.stringify(patch)}\n`, { flag: "wx" });
    return path;
  }

  async query(text = ""): Promise<GraphNode[]> {
    const nodes = await readLines<GraphNode>(this.nodesPath);
    if (text.length === 0) return nodes;
    const needle = text.toLowerCase();
    return nodes.filter((node) => JSON.stringify(node).toLowerCase().includes(needle));
  }

  accept(patchPath: string): Promise<GraphNode> {
    let accepted!: GraphNode;
    const operation = this.mutations.then(async () => {
      if (join(this.inbox, basename(patchPath)) !== patchPath) {
        throw new Error("Knowledge graph accepts inbox patches only");
      }
      const patch = JSON.parse(await readFile(patchPath, "utf8")) as GraphPatch;
      const existing = (await this.query()).filter((node) => node.id === patch.node.id);
      const rev = Math.max(0, ...existing.map((node) => node.rev)) + 1;
      accepted = { ...patch.node, rev } as GraphNode;
      await this.snapshot();
      await mkdir(this.root, { recursive: true });
      await appendFile(this.nodesPath, `${JSON.stringify(accepted)}\n`, "utf8");
      await rm(patchPath);
    });
    this.mutations = operation.catch(() => undefined);
    return operation.then(() => accepted);
  }

  private async snapshot(): Promise<void> {
    const target = join(this.snapshots, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
    await mkdir(target, { recursive: true });
    for (const name of ["nodes.jsonl", "edges.jsonl", "sources.jsonl"]) {
      await cp(join(this.root, name), join(target, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const marker = join(target, ".complete.tmp");
    await writeFile(marker, "ok\n");
    await rename(marker, join(target, ".complete"));
  }
}
