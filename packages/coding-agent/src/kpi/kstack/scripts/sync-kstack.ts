import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
	assertGeneratedTree,
	KStackTransformError,
	MAINTAINER_TEST_FILE,
	matchesGlob,
	type OverlayConfig,
	renamePath,
	transformFile,
} from "../overlay/transforms.ts";
import { applyPatches } from "./patches.ts";
import {
	assertLicense,
	assertModelsJson,
	assertRecordsAgree,
	computeTransformVersion,
	deriveLicense,
	type Provenance,
	ProvenanceError,
	parseUpstreamDocument,
	readProvenance,
	resolvePatchSet,
} from "./provenance.ts";
import {
	assertEmptyDirectory,
	computeTreeOid,
	digestTree,
	isTextFile,
	readTree,
	type Tree,
	type TreeEntry,
	writeMarker,
	writeTree,
} from "./tree.ts";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");

export const paths = {
	root,
	generated: join(root, "generated"),
	upstream: join(root, "upstream"),
	overlay: join(root, "overlay"),
	overlaySource: join(root, "overlay", "source"),
	patches: join(root, "overlay", "patches"),
	upstreamDocument: join(root, "UPSTREAM.md"),
	provenance: join(root, "provenance.json"),
} as const;

/** Left behind only between the two promotion renames. Recovered on next run. */
export const PROMOTION_MARKER = "generated.PROMOTION_INCOMPLETE";

export interface SyncOptions {
	check: boolean;
	pin?: string;
	/** A vendored or fixture subtree to build from. Never a network fetch. */
	source?: string;
	/** Explicit opt-in to the network. Absent means offline. */
	fetch: boolean;
	patches?: string;
	/** Overridden by tests so a fixture drives the whole pipeline. */
	layout?: Partial<typeof paths>;
}

export function parseOptions(args: readonly string[]): SyncOptions {
	const options: SyncOptions = { check: args.includes("--check"), fetch: args.includes("--fetch") };
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--pin") options.pin = args[++index];
		if (args[index] === "--source") options.source = args[++index];
		if (args[index] === "--patches") options.patches = args[++index];
	}
	if (options.check && options.pin !== undefined) {
		throw new Error("--check and --pin are mutually exclusive");
	}
	if (options.check && options.fetch) {
		throw new Error("--check never reaches the network; drop --fetch");
	}
	if (options.pin !== undefined && !/^[0-9a-f]{40}$/u.test(options.pin)) {
		throw new Error(`--pin needs a full 40-character commit sha, got ${options.pin}`);
	}
	// Moving the pin is the one operation that must reach upstream, so `--pin`
	// carries its own network consent. `--source` still overrides it, which is how
	// a fixture drives the same pipeline offline.
	if (options.pin !== undefined) {
		options.fetch = true;
	}
	return options;
}

function layoutFor(options: SyncOptions): typeof paths {
	return { ...paths, ...options.layout };
}

export interface DroppedEntry {
	/** The path that would have shipped, after renames. */
	path: string;
	/** The upstream path it came from, so a maintainer can find it again. */
	source: string;
	reason: string;
}

export interface BuildResult {
	files: Tree;
	dropped: DroppedEntry[];
}

/**
 * The overlay's three data files, read as one config.
 *
 * `rename-map.json` and `forbidden.txt` keep the names and jobs `docs/kstack.md`
 * gives them - the rename data and the plain list of strings that must not
 * survive. `config.json` holds what that layout does not name: which paths are
 * dropped and why, which orchestration operators are understood, and which
 * shapes must fail closed with a location.
 */
export async function readOverlayConfig(directory = paths.overlay): Promise<OverlayConfig> {
	const [config, renames, forbidden] = await Promise.all([
		readFile(join(directory, "config.json"), "utf8"),
		readFile(join(directory, "rename-map.json"), "utf8"),
		readFile(join(directory, "forbidden.txt"), "utf8"),
	]);
	const parsed = JSON.parse(config) as Omit<OverlayConfig, "pathRenames" | "tokenRenames" | "forbidden">;
	const renameMap = JSON.parse(renames) as Pick<OverlayConfig, "pathRenames" | "tokenRenames">;
	return {
		...parsed,
		pathRenames: renameMap.pathRenames,
		tokenRenames: renameMap.tokenRenames,
		forbidden: forbidden
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#")),
	};
}

/** A text view of the tree, for the parts of the pipeline that read text. */
export function textOf(tree: ReadonlyMap<string, TreeEntry>): Map<string, string> {
	const text = new Map<string, string>();
	for (const [path, entry] of tree) {
		if (isTextFile(path, entry.bytes)) {
			text.set(path, entry.bytes.toString("utf8"));
		}
	}
	return text;
}

/**
 * Builds the generated tree from a pinned upstream subtree plus overlay-owned
 * first-party source.
 *
 * Order matters. Upstream is transformed first, so a dropped path never reaches
 * the operator rules and never has to be explained twice. Overlay source is
 * applied last and wins any collision, because first-party content is the
 * authority where the two disagree - that is what makes it an overlay rather
 * than a second tree standing beside `generated/`.
 *
 * Binary files are copied byte for byte and never interpreted; the transforms
 * only ever see text.
 */
export async function buildGeneratedTree(
	upstreamTree: ReadonlyMap<string, TreeEntry>,
	overlayTree: ReadonlyMap<string, TreeEntry>,
	config: OverlayConfig,
): Promise<BuildResult> {
	const dropped: DroppedEntry[] = [];
	const diagnostics = [];
	const output: Tree = new Map();
	// A path the overlay owns is never validated as upstream content: upstream's
	// version of it is a build input that does not ship, so reporting its residue
	// would be reporting a file nobody loads.
	const owned = new Set(overlayTree.keys());

	for (const [rawPath, entry] of upstreamTree) {
		if (MAINTAINER_TEST_FILE.test(rawPath)) {
			dropped.push({ path: rawPath, source: rawPath, reason: "upstream maintainer test collateral" });
			continue;
		}
		const path = renamePath(rawPath, config.pathRenames);
		const rule = config.dropPaths.find(
			(candidate) => matchesGlob(path, candidate.pattern) || matchesGlob(rawPath, candidate.pattern),
		);
		if (rule !== undefined) {
			dropped.push({ path, source: rawPath, reason: rule.reason });
			continue;
		}
		if (owned.has(path)) {
			dropped.push({ path, source: rawPath, reason: "replaced by overlay-owned first-party source" });
			continue;
		}
		if (!isTextFile(path, entry.bytes)) {
			output.set(path, entry);
			continue;
		}
		const outcome = transformFile(path, entry.bytes.toString("utf8"), config);
		diagnostics.push(...outcome.diagnostics);
		for (const line of outcome.dropped) {
			dropped.push({ path: `${path}:${line.line}`, source: `${rawPath}:${line.line}`, reason: line.reason });
		}
		output.set(path, { bytes: Buffer.from(outcome.text, "utf8"), executable: entry.executable });
	}

	// First-party overlay source is authored against these rules already, so it is
	// validated rather than rewritten: a residue here is an authoring mistake.
	for (const [path, entry] of overlayTree) {
		if (isTextFile(path, entry.bytes)) {
			const outcome = transformFile(path, entry.bytes.toString("utf8"), config);
			diagnostics.push(...outcome.diagnostics);
		}
		output.set(path, entry);
	}

	if (diagnostics.length > 0) {
		throw new KStackTransformError(diagnostics);
	}
	return { files: output, dropped };
}

/**
 * Copies only the pinned subtree into a new empty staging tree.
 *
 * The staging directory is asserted empty first. Reusing one is how bytes from a
 * previous run survive into a tree that is then declared reproducible.
 */
export async function stagePinnedSubtree(source: string, staging: string): Promise<Tree> {
	await assertEmptyDirectory(staging);
	const tree = await readTree(source);
	if (tree.size === 0) {
		throw new Error(`pinned subtree is empty: ${source}`);
	}
	await writeTree(staging, tree);
	return tree;
}

/**
 * Materializes the pinned subtree.
 *
 * Offline by default, from the vendored snapshot, which *is* the pinned tree. The
 * network is reached only when a maintainer asks for it with `--fetch`, and even
 * then the checkout is verified against the recorded tree id before a byte of it
 * is used.
 */
export async function materializeSource(
	options: SyncOptions,
	work: string,
	provenance: Provenance,
	layout: typeof paths,
): Promise<string> {
	if (options.source !== undefined) {
		return resolve(options.source);
	}
	if (!options.fetch) {
		return layout.upstream;
	}
	const clone = join(work, "clone");
	const subtree = provenance.origin.path.replace(/\/$/u, "");
	await exec("git", ["clone", "--filter=blob:none", "--no-checkout", provenance.origin.repository, clone]);
	await exec("git", ["sparse-checkout", "set", subtree], { cwd: clone });
	await exec("git", ["checkout", options.pin ?? provenance.origin.commit], { cwd: clone });
	return join(clone, subtree);
}

export interface Candidate {
	tree: Tree;
	digest: string;
	dropped: DroppedEntry[];
	/** The staged subtree's own tree id, derived rather than assumed. */
	sourceTreeOid: string;
	/** The record this candidate would publish. */
	provenance: Provenance;
	/** The staged pinned subtree, so a moved pin can vendor exactly these bytes. */
	stagingDirectory: string;
	candidateDirectory: string;
	/** True when the pin moved the subtree, so `upstream/` must be republished. */
	upstreamChanged: boolean;
}

/**
 * Everything up to but not including publication.
 *
 * Structured so the whole pipeline can be proven without writing into the
 * repository: staging, transforms, patches and every validation happen inside a
 * temporary directory, and no live artifact is opened for writing until this has
 * returned a fully validated candidate.
 *
 * The provenance it returns is *effective*, not the file on disk. Without `--pin`
 * the two are identical and every field is checked against the record. With
 * `--pin` the commit, the tree id and the licence come from the newly staged
 * subtree, because a pin that could only ever confirm the tree it already had
 * could not move the pin at all - which is exactly the state this package found.
 */
export async function buildCandidate(options: SyncOptions, work: string): Promise<Candidate> {
	const layout = layoutFor(options);
	const recorded = await readProvenance(layout.provenance);
	assertRecordsAgree(recorded, parseUpstreamDocument(await readFile(layout.upstreamDocument, "utf8")));

	const transformVersion = await computeTransformVersion(layout.overlay);
	if (transformVersion !== recorded.transformVersion) {
		throw new ProvenanceError(
			`the overlay has changed: transformVersion is ${transformVersion}, provenance records ${recorded.transformVersion}. Re-run kstack:sync.`,
		);
	}

	const patchDirectory = options.patches === undefined ? layout.patches : resolve(options.patches);
	const ordered = await resolvePatchSet(patchDirectory, recorded.patches);

	const source = await materializeSource(options, work, recorded, layout);
	const staging = join(work, "staging");
	await stagePinnedSubtree(source, staging);
	const stagedTree = await readTree(staging);

	const subtree = recorded.origin.path.replace(/\/$/u, "");
	const sourceTreeOid = await computeTreeOid(staging, subtree);

	// Without a pin the tree id is a claim to verify. With one it is a fact to
	// record, alongside the licence that came with it.
	let provenance: Provenance;
	if (options.pin === undefined) {
		if (sourceTreeOid !== recorded.origin.treeOid) {
			throw new ProvenanceError(
				`pinned subtree has tree id ${sourceTreeOid}, provenance records ${recorded.origin.treeOid}`,
			);
		}
		provenance = recorded;
	} else {
		provenance = {
			...recorded,
			origin: { ...recorded.origin, commit: options.pin, treeOid: sourceTreeOid },
			license: deriveLicense(stagedTree, recorded.license.path, recorded.license.spdx),
		};
	}

	const config = await readOverlayConfig(layout.overlay);
	const built = await buildGeneratedTree(stagedTree, await readTree(layout.overlaySource), config);

	const candidateDirectory = join(work, "candidate");
	await mkdir(candidateDirectory, { recursive: true });
	await writeTree(candidateDirectory, built.files);
	await applyPatches(candidateDirectory, patchDirectory, ordered);

	const finalTree = await readTree(candidateDirectory);
	assertGeneratedTree(textOf(finalTree), config);
	assertLicense(finalTree, provenance);
	assertModelsJson(finalTree);

	return {
		tree: finalTree,
		digest: digestTree(finalTree),
		dropped: built.dropped,
		sourceTreeOid,
		provenance,
		stagingDirectory: staging,
		candidateDirectory,
		upstreamChanged: sourceTreeOid !== recorded.origin.treeOid,
	};
}

/** One live thing a publication replaces, and the bytes that will replace it. */
export interface Artifact {
	readonly name: string;
	readonly live: string;
	/** A directory to copy, or the bytes of a file. */
	readonly staged:
		| { readonly kind: "tree"; readonly directory: string }
		| { readonly kind: "file"; readonly bytes: Buffer };
}

export interface TransactionState {
	readonly incomplete: boolean;
	readonly artifacts: readonly string[];
}

/** Simulates a crash at a named boundary, so recovery can be proven. */
export interface PublicationHooks {
	readonly onBoundary?: (boundary: string) => void | Promise<void>;
}

function markerPath(layout: typeof paths): string {
	return join(layout.root, PROMOTION_MARKER);
}

/**
 * Reads the transaction marker without touching anything.
 *
 * `--check` needs to know a publication was interrupted, and must not be the
 * thing that fixes it: a dry run that renames a live directory is not a dry run.
 */
export async function inspectTransaction(layout: typeof paths = paths): Promise<TransactionState> {
	const source = await readFile(markerPath(layout), "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	});
	if (source === undefined) {
		return { incomplete: false, artifacts: [] };
	}
	let artifacts: string[] = [];
	try {
		const parsed: unknown = JSON.parse(source);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			Array.isArray((parsed as { artifacts?: unknown }).artifacts)
		) {
			artifacts = (parsed as { artifacts: unknown[] }).artifacts.filter(
				(entry): entry is string => typeof entry === "string",
			);
		}
	} catch {
		artifacts = [];
	}
	return { incomplete: true, artifacts };
}

/**
 * Recovers a publication that died mid-swap.
 *
 * Only a mutating sync calls this. For each artifact the marker names, a saved
 * `.previous` beside a missing live path is a thing to put back; a live path that
 * is already there means that artifact landed, so the leftovers are dropped.
 */
export async function recoverIncompleteTransaction(
	layout: typeof paths = paths,
): Promise<"none" | "restored" | "kept"> {
	const state = await inspectTransaction(layout);
	if (!state.incomplete) {
		return "none";
	}
	let restored = false;
	for (const name of state.artifacts.length > 0 ? state.artifacts : ["generated"]) {
		const live = join(layout.root, name);
		const previous = `${live}.previous`;
		const next = `${live}.next`;
		const hasLive = (await stat(live).catch(() => undefined)) !== undefined;
		const hasPrevious = (await stat(previous).catch(() => undefined)) !== undefined;
		if (!hasLive && hasPrevious) {
			await rename(previous, live);
			restored = true;
		} else {
			await rm(previous, { recursive: true, force: true });
		}
		await rm(next, { recursive: true, force: true });
	}
	await rm(markerPath(layout), { force: true });
	return restored ? "restored" : "kept";
}

/** Backwards-compatible name for the single-artifact recovery. */
export const recoverIncompletePromotion = recoverIncompleteTransaction;

/**
 * Publishes every artifact, or none of them.
 *
 * `generated/`, `upstream/`, `provenance.json` and `UPSTREAM.md` describe one
 * another: a generated tree from a subtree that was never vendored cannot be
 * rebuilt offline, and a record naming a commit whose bytes are not there is a
 * pin nobody can verify. So they move together. Every artifact is staged first,
 * then retired, then installed; a failure at any boundary puts every retired
 * artifact back before rethrowing, and the marker lets a killed process finish
 * the same restore on its next run.
 */
export async function publishArtifacts(
	artifacts: readonly Artifact[],
	layout: typeof paths = paths,
	hooks: PublicationHooks = {},
): Promise<void> {
	if (artifacts.length === 0) {
		return;
	}
	const boundary = async (name: string): Promise<void> => {
		await hooks.onBoundary?.(name);
	};

	// Staging happens before the marker exists, so its own failure has to clean up
	// after itself: a leftover `.next` would look like an interrupted publication
	// to the next run.
	try {
		for (const artifact of artifacts) {
			await boundary(`stage:${artifact.name}`);
			const next = `${artifact.live}.next`;
			await rm(next, { recursive: true, force: true });
			await rm(`${artifact.live}.previous`, { recursive: true, force: true });
			if (artifact.staged.kind === "tree") {
				await writeTree(next, await readTree(artifact.staged.directory));
			} else {
				await mkdir(join(next, ".."), { recursive: true });
				await writeFile(next, artifact.staged.bytes);
			}
		}
	} catch (error) {
		for (const artifact of artifacts) {
			await rm(`${artifact.live}.next`, { recursive: true, force: true }).catch(() => undefined);
		}
		throw error;
	}

	await writeMarker(
		markerPath(layout),
		`${JSON.stringify({ artifacts: artifacts.map((entry) => entry.name), at: new Date().toISOString() })}\n`,
	);

	const retired: Artifact[] = [];
	const installed: Artifact[] = [];
	try {
		for (const artifact of artifacts) {
			await boundary(`retire:${artifact.name}`);
			if ((await stat(artifact.live).catch(() => undefined)) !== undefined) {
				await rename(artifact.live, `${artifact.live}.previous`);
			}
			retired.push(artifact);
		}
		for (const artifact of artifacts) {
			await boundary(`install:${artifact.name}`);
			await rename(`${artifact.live}.next`, artifact.live);
			installed.push(artifact);
		}
		await boundary("commit");
	} catch (error) {
		for (const artifact of [...installed].reverse()) {
			await rm(artifact.live, { recursive: true, force: true }).catch(() => undefined);
		}
		for (const artifact of [...retired].reverse()) {
			const previous = `${artifact.live}.previous`;
			if ((await stat(previous).catch(() => undefined)) !== undefined) {
				await rm(artifact.live, { recursive: true, force: true }).catch(() => undefined);
				await rename(previous, artifact.live).catch(() => undefined);
			}
		}
		for (const artifact of artifacts) {
			await rm(`${artifact.live}.next`, { recursive: true, force: true }).catch(() => undefined);
		}
		await rm(markerPath(layout), { force: true }).catch(() => undefined);
		throw error;
	}

	await rm(markerPath(layout), { force: true });
	for (const artifact of artifacts) {
		await rm(`${artifact.live}.previous`, { recursive: true, force: true });
		await rm(`${artifact.live}.next`, { recursive: true, force: true });
	}
}

/** Renders the human table for a moved pin, leaving every other row alone. */
export function renderUpstreamDocument(document: string, provenance: Provenance): string {
	const withCommit = document.replace(/\| Commit \| [0-9a-f]{40} \|/u, `| Commit | ${provenance.origin.commit} |`);
	if (/\| pstack tree \| [0-9a-f]{40} \|/u.test(withCommit)) {
		return withCommit.replace(/\| pstack tree \| [0-9a-f]{40} \|/u, `| pstack tree | ${provenance.origin.treeOid} |`);
	}
	throw new ProvenanceError("UPSTREAM.md has no `pstack tree` row to update");
}

export interface SyncReport {
	status: "checked" | "unchanged" | "promoted";
	digest: string;
	liveDigest: string;
	sourceTreeOid: string;
	dropped: number;
	/** Which live artifacts the run replaced, in publication order. */
	published: string[];
	commit: string;
}

export interface RunOptions extends SyncOptions {
	hooks?: PublicationHooks;
}

export async function runSync(options: RunOptions): Promise<SyncReport> {
	const layout = layoutFor(options);

	// A dry run never repairs anything. An interrupted publication is reported as
	// the failure it is, and the artifacts are left exactly where they were for a
	// mutating run - or a human - to finish.
	const transaction = await inspectTransaction(layout);
	if (options.check) {
		if (transaction.incomplete) {
			throw new Error(
				`an interrupted K-stack publication is still open (${transaction.artifacts.join(", ") || "unknown artifacts"}); run kstack:sync to finish it`,
			);
		}
	} else if (transaction.incomplete) {
		await recoverIncompleteTransaction(layout);
	}

	const work = await mkdtemp(join(tmpdir(), "kstack-sync-"));
	try {
		const candidate = await buildCandidate(options, work);
		const live = await readTree(layout.generated);
		const liveDigest = digestTree(live);
		const recorded = await readProvenance(layout.provenance);
		const recordsChanged =
			candidate.provenance.origin.commit !== recorded.origin.commit ||
			candidate.provenance.origin.treeOid !== recorded.origin.treeOid ||
			candidate.provenance.license.sha256 !== recorded.license.sha256 ||
			candidate.provenance.license.holder !== recorded.license.holder;

		if (options.check) {
			if (candidate.digest !== liveDigest) {
				throw new Error(
					`K-stack generated tree drifted: live ${liveDigest.slice(0, 12)} vs rebuilt ${candidate.digest.slice(0, 12)}`,
				);
			}
			return {
				status: "checked",
				digest: candidate.digest,
				liveDigest,
				sourceTreeOid: candidate.sourceTreeOid,
				dropped: candidate.dropped.length,
				published: [],
				commit: candidate.provenance.origin.commit,
			};
		}

		// Only what actually differs is republished, so the same pin twice - and a
		// pin that moves the commit without moving the subtree - rewrite nothing
		// they do not have to.
		const artifacts: Artifact[] = [];
		if (candidate.digest !== liveDigest) {
			artifacts.push({
				name: "generated",
				live: layout.generated,
				staged: { kind: "tree", directory: candidate.candidateDirectory },
			});
		}
		if (candidate.upstreamChanged) {
			artifacts.push({
				name: "upstream",
				live: layout.upstream,
				staged: { kind: "tree", directory: candidate.stagingDirectory },
			});
		}
		if (recordsChanged) {
			artifacts.push({
				name: "provenance.json",
				live: layout.provenance,
				staged: {
					kind: "file",
					bytes: Buffer.from(`${JSON.stringify(candidate.provenance, null, "\t")}\n`, "utf8"),
				},
			});
			artifacts.push({
				name: "UPSTREAM.md",
				live: layout.upstreamDocument,
				staged: {
					kind: "file",
					bytes: Buffer.from(
						renderUpstreamDocument(await readFile(layout.upstreamDocument, "utf8"), candidate.provenance),
						"utf8",
					),
				},
			});
		}

		if (artifacts.length === 0) {
			return {
				status: "unchanged",
				digest: candidate.digest,
				liveDigest,
				sourceTreeOid: candidate.sourceTreeOid,
				dropped: candidate.dropped.length,
				published: [],
				commit: candidate.provenance.origin.commit,
			};
		}

		await publishArtifacts(artifacts, layout, options.hooks ?? {});
		return {
			status: "promoted",
			digest: candidate.digest,
			liveDigest,
			sourceTreeOid: candidate.sourceTreeOid,
			dropped: candidate.dropped.length,
			published: artifacts.map((entry) => entry.name),
			commit: candidate.provenance.origin.commit,
		};
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const report = await runSync(options);
	if (report.status !== "checked") {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	}
}

if (import.meta.filename === process.argv[1]) {
	await main();
}
