import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { assertRecordsAgree, type Provenance, parseUpstreamDocument, readProvenance } from "./provenance.ts";
import { paths } from "./sync-kstack.ts";
import { computeTreeOid } from "./tree.ts";

const exec = promisify(execFile);

/**
 * Read-only git. Nothing here fetches into the repository, merges, checks out a
 * branch, tags, pushes, or writes a pin. `fetch` appears once, into a throwaway
 * clone, because a tree id cannot be read from `ls-remote`.
 */
const READ_ONLY_GIT = new Set(["ls-remote", "fetch", "rev-parse", "init", "config"]);

const DEFAULT_TIMEOUT_MS = 30_000;

async function git(args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
	if (!READ_ONLY_GIT.has(args[0])) {
		throw new Error(`refusing a non-read-only git subcommand: ${args[0]}`);
	}
	const { stdout } = await exec("git", [...args], {
		cwd: options.cwd,
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
	return stdout.trim();
}

export type LocalPinState =
	| { readonly kind: "honest"; readonly treeOid: string }
	| { readonly kind: "dishonest"; readonly recorded: string; readonly actual: string };

export type RemoteState =
	| { readonly kind: "skipped" }
	| { readonly kind: "unreachable"; readonly reason: string }
	/** The repository moved but the subtree we vendor did not. Informational. */
	| { readonly kind: "head-moved"; readonly head: string; readonly treeOid: string }
	| { readonly kind: "current"; readonly head: string; readonly treeOid: string }
	/** A different subtree exists upstream. Available, never applied. */
	| { readonly kind: "update-available"; readonly head: string; readonly treeOid: string };

export interface StatusReport {
	readonly origin: Provenance["origin"];
	readonly local: LocalPinState;
	readonly remote: RemoteState;
	readonly summary: string;
	/** Always false. Reporting drift is not applying it. */
	readonly pinChanged: false;
}

/**
 * Whether the vendored bytes really are the pinned tree.
 *
 * The one question that can be answered with no network, and the one that matters
 * most: a pin nobody can verify locally is a claim, not a pin.
 */
export async function inspectLocal(provenance: Provenance, upstreamDirectory: string): Promise<LocalPinState> {
	const actual = await computeTreeOid(upstreamDirectory, provenance.origin.path.replace(/\/$/u, ""));
	return actual === provenance.origin.treeOid
		? { kind: "honest", treeOid: actual }
		: { kind: "dishonest", recorded: provenance.origin.treeOid, actual };
}

/**
 * Whether upstream has moved, and whether that movement touched our subtree.
 *
 * `ls-remote` gives a commit, not a tree, so the subtree id needs the commit's
 * tree objects: a depth-1 `--filter=blob:none` fetch into a throwaway clone
 * brings the trees without the blobs. An unreachable remote is reported, not
 * failed - scheduled maintenance must not turn into a red gate.
 */
export async function inspectRemote(provenance: Provenance, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RemoteState> {
	const subtree = provenance.origin.path.replace(/\/$/u, "");
	let head: string;
	try {
		const output = await git(["ls-remote", provenance.origin.repository, "HEAD"], { timeoutMs });
		head = output.split(/\s+/u)[0] ?? "";
		if (!/^[0-9a-f]{40}$/u.test(head)) {
			return { kind: "unreachable", reason: "remote returned no HEAD commit" };
		}
	} catch (error) {
		return { kind: "unreachable", reason: firstLine(error) };
	}

	const scratch = await mkdtemp(join(tmpdir(), "kstack-status-"));
	try {
		const clone = join(scratch, "probe");
		await git(["init", "--quiet", clone], { timeoutMs });
		await git(["fetch", "--depth=1", "--filter=blob:none", "--no-tags", provenance.origin.repository, head], {
			cwd: clone,
			timeoutMs,
		});
		const treeOid = await git(["rev-parse", `FETCH_HEAD:${subtree}`], { cwd: clone, timeoutMs });
		if (!/^[0-9a-f]{40}$/u.test(treeOid)) {
			return { kind: "unreachable", reason: `remote HEAD has no ${subtree} subtree` };
		}
		if (treeOid !== provenance.origin.treeOid) {
			return { kind: "update-available", head, treeOid };
		}
		return head === provenance.origin.commit
			? { kind: "current", head, treeOid }
			: { kind: "head-moved", head, treeOid };
	} catch (error) {
		return { kind: "unreachable", reason: firstLine(error) };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

function firstLine(error: unknown): string {
	const stderr = (error as { stderr?: string }).stderr;
	return (typeof stderr === "string" && stderr.trim().length > 0 ? stderr : String(error)).trim().split("\n")[0];
}

export function summarize(local: LocalPinState, remote: RemoteState): string {
	const localLine =
		local.kind === "honest"
			? `local pin honest: vendored pstack tree is ${local.treeOid}`
			: `local pin DISHONEST: records ${local.recorded}, vendored bytes are ${local.actual}`;
	switch (remote.kind) {
		case "skipped":
			return `${localLine}\nremote: not consulted (offline)`;
		case "unreachable":
			return `${localLine}\nremote: unreachable (${remote.reason})`;
		case "current":
			return `${localLine}\nremote: current at ${remote.head}`;
		case "head-moved":
			return `${localLine}\nremote: HEAD moved to ${remote.head}, pstack tree unchanged — informational, no update needed`;
		case "update-available":
			return `${localLine}\nremote: update available — HEAD ${remote.head} has pstack tree ${remote.treeOid}. Move the pin with: npm run kstack:sync -- --pin ${remote.head}`;
	}
}

export interface StatusOptions {
	offline: boolean;
	timeoutMs?: number;
	layout?: Partial<typeof paths>;
}

export async function runStatus(options: StatusOptions): Promise<StatusReport> {
	const layout = { ...paths, ...options.layout };
	const provenance = await readProvenance(layout.provenance);
	assertRecordsAgree(provenance, parseUpstreamDocument(await readFile(layout.upstreamDocument, "utf8")));
	const local = await inspectLocal(provenance, layout.upstream);
	const remote: RemoteState = options.offline
		? { kind: "skipped" }
		: await inspectRemote(provenance, options.timeoutMs);
	return { origin: provenance.origin, local, remote, summary: summarize(local, remote), pinChanged: false };
}

/**
 * Exit codes. A dishonest local pin is the only failure: it means the vendored
 * bytes are not what the record claims, which every other check silently trusts.
 * Remote drift, however large, is always exit 0.
 */
export function exitCodeFor(report: StatusReport): 0 | 1 {
	return report.local.kind === "honest" ? 0 : 1;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const report = await runStatus({ offline: args.includes("--offline") });
	process.stdout.write(`${report.summary}\n`);
	const jsonIndex = args.indexOf("--json");
	if (jsonIndex !== -1 && args[jsonIndex + 1] !== undefined) {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(args[jsonIndex + 1], `${JSON.stringify(report, null, 2)}\n`);
	}
	process.exitCode = exitCodeFor(report);
}

if (import.meta.filename === process.argv[1]) {
	await main();
}
