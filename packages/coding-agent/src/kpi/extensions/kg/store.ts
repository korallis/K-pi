import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { CONFIG_DIR_NAME } from "../../../config.ts";

import {
	type AcceptedRecords,
	type KnowledgeGraphEdge,
	type KnowledgeGraphNode,
	type KnowledgeGraphSource,
	type KnowledgeGraphState,
	PATCH_KINDS,
	RECORD_FILES,
	resolveAcceptance,
	validatePatch,
} from "./schema.ts";

/** The marker that makes a snapshot trustworthy as the complete prior state. */
export const SNAPSHOT_COMPLETE_MARKER = ".complete";

export interface KnowledgeGraphPaths {
	root: string;
	inbox: string;
	snapshots: string;
	sources: string;
	nodes: string;
	edges: string;
}

export function knowledgeGraphPaths(cwd: string): KnowledgeGraphPaths {
	const root = join(cwd, CONFIG_DIR_NAME, "kg");
	return {
		root,
		inbox: join(root, "inbox"),
		snapshots: join(root, "snapshots"),
		sources: join(root, RECORD_FILES.source),
		nodes: join(root, RECORD_FILES.node),
		edges: join(root, RECORD_FILES.edge),
	};
}

/**
 * Recognizes a write only the control plane may perform: the authoritative
 * JSONL files and the snapshot tree. `inbox/` stays open so workers and public
 * tools can propose.
 */
export function isAuthoritativeKnowledgeGraphPath(cwd: string, path: string): boolean {
	const relativePath = relative(resolve(cwd), resolve(cwd, path)).split(sep).join("/");
	if (relativePath.length === 0 || relativePath.startsWith("../")) {
		return false;
	}
	const segments = relativePath.split("/");
	if (segments.length < 3 || segments[0] !== CONFIG_DIR_NAME || segments[1] !== "kg") {
		return false;
	}
	return segments[2] !== "inbox";
}

export interface KnowledgeGraphOptions {
	/** Injected clock in epoch milliseconds. */
	now?: () => number;
	/**
	 * Runs after the prior state is snapshotted and marked complete, before the
	 * new revision is promoted. Throwing from here is the injected crash.
	 */
	afterSnapshot?: (snapshotPath: string) => void | Promise<void>;
}

/**
 * One in-process write queue per store root. Proposals and acceptances share
 * it, so concurrent writers inside a process never interleave a record.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function serialize<T>(root: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeQueues.get(root) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	writeQueues.set(
		root,
		result.catch(() => undefined),
	);
	return result;
}

async function readRecords<T>(path: string): Promise<T[]> {
	try {
		return (await readFile(path, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as T);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

/**
 * Read access plus the proposal path. This is the whole surface a worker or a
 * public tool gets: it can add an inbox patch and nothing else.
 */
export class KnowledgeGraphProposals {
	readonly paths: KnowledgeGraphPaths;
	protected readonly now: () => number;

	constructor(cwd: string, options: KnowledgeGraphOptions = {}) {
		this.paths = knowledgeGraphPaths(cwd);
		this.now = options.now ?? Date.now;
	}

	/** Writes one shape-valid patch to the inbox and returns its path. */
	async propose(patch: unknown): Promise<string> {
		validatePatch(patch);
		return serialize(this.paths.root, async () => {
			await mkdir(this.paths.inbox, { recursive: true });
			const path = join(this.paths.inbox, `${this.now()}-${randomUUID()}.json`);
			await writeFile(path, `${JSON.stringify(patch)}\n`, { flag: "wx" });
			return path;
		});
	}

	/** The authoritative state as stored, every revision in append order. */
	async read(): Promise<KnowledgeGraphState> {
		const [sources, nodes, edges] = await Promise.all([
			readRecords<KnowledgeGraphSource>(this.paths.sources),
			readRecords<KnowledgeGraphNode>(this.paths.nodes),
			readRecords<KnowledgeGraphEdge>(this.paths.edges),
		]);
		return { sources, nodes, edges };
	}

	/** Node claims whose JSON contains `text`. */
	async query(text = ""): Promise<KnowledgeGraphNode[]> {
		const { nodes } = await this.read();
		if (text.length === 0) {
			return nodes;
		}
		const needle = text.toLowerCase();
		return nodes.filter((node) => JSON.stringify(node).toLowerCase().includes(needle));
	}
}

/**
 * The only authoritative writer. Acceptance snapshots the complete prior
 * state, marks that snapshot complete, and only then promotes the new
 * revision, so a crash in between leaves the prior state readable.
 */
export class KnowledgeGraphControlPlane extends KnowledgeGraphProposals {
	private readonly afterSnapshot?: (snapshotPath: string) => void | Promise<void>;

	constructor(cwd: string, options: KnowledgeGraphOptions = {}) {
		super(cwd, options);
		this.afterSnapshot = options.afterSnapshot;
	}

	/** Rejects any path that is not an inbox patch. */
	assertInboxPatch(patchPath: string): void {
		if (resolve(this.paths.inbox, basename(patchPath)) !== resolve(patchPath)) {
			throw new Error(`Knowledge graph accepts inbox patches only: ${patchPath}`);
		}
	}

	accept(patchPath: string): Promise<AcceptedRecords> {
		return serialize(this.paths.root, async () => {
			this.assertInboxPatch(patchPath);
			const patch: unknown = JSON.parse(await readFile(patchPath, "utf8"));
			validatePatch(patch);
			const accepted = resolveAcceptance(patch, await this.read());

			const snapshotPath = await this.snapshot();
			await this.afterSnapshot?.(snapshotPath);

			for (const kind of PATCH_KINDS) {
				const record = accepted[kind];
				if (record !== undefined) {
					await appendFile(join(this.paths.root, RECORD_FILES[kind]), `${JSON.stringify(record)}\n`, "utf8");
				}
			}
			await rm(patchPath);
			return accepted;
		});
	}

	/**
	 * Copies the complete prior authoritative state, describes it in a
	 * manifest, then renames the completion marker into place.
	 */
	private async snapshot(): Promise<string> {
		const stamp = new Date(this.now()).toISOString().replaceAll(":", "-");
		const target = join(this.paths.snapshots, `${stamp}-${randomUUID()}`);
		await mkdir(target, { recursive: true });

		const files: Record<string, { records: number; sha256: string }> = {};
		for (const kind of PATCH_KINDS) {
			const name = RECORD_FILES[kind];
			// An absent file is still part of the prior state: capture it as empty
			// so a restore never has to guess which files existed.
			let content = "";
			try {
				content = await readFile(join(this.paths.root, name), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
			await writeFile(join(target, name), content);
			files[name] = {
				records: content.split("\n").filter((line) => line.length > 0).length,
				sha256: createHash("sha256").update(content).digest("hex"),
			};
		}
		const manifest = { capturedAt: stamp, files };
		await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

		const marker = join(target, `${SNAPSHOT_COMPLETE_MARKER}.tmp`);
		await writeFile(marker, "ok\n");
		await rename(marker, join(target, SNAPSHOT_COMPLETE_MARKER));
		return target;
	}
}
