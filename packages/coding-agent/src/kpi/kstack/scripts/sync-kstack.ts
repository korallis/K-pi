import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const generatedPath = join(root, "generated");
const upstreamPath = join(root, "upstream");
const overlayPath = join(root, "overlay");
const overlaySourcePath = join(overlayPath, "source");
const upstreamDocument = join(root, "UPSTREAM.md");

interface Options {
	check: boolean;
	pin?: string;
	source?: string;
	patches?: string;
}

function parseOptions(args: string[]): Options {
	const options: Options = { check: args.includes("--check") };
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--pin") options.pin = args[++index];
		if (args[index] === "--source") options.source = args[++index];
		if (args[index] === "--patches") options.patches = args[++index];
	}
	if (options.check && options.pin !== undefined) throw new Error("--check and --pin are mutually exclusive");
	return options;
}

async function pinnedSha(): Promise<string> {
	const source = await readFile(upstreamDocument, "utf8");
	const match = source.match(/\| Commit \| ([0-9a-f]{40}) \|/u);
	if (match === null) throw new Error("UPSTREAM.md has no pinned commit");
	return match[1];
}

export async function files(directory: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	async function visit(current: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile())
				result.set(relative(directory, path).split("\\").join("/"), await readFile(path, "utf8"));
		}
	}
	try {
		await visit(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return result;
}

function digest(entries: ReadonlyMap<string, string>): string {
	const hash = createHash("sha256");
	for (const [path, source] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(path).update("\0").update(source).update("\0");
	}
	return hash.digest("hex");
}

async function materializeSource(options: Options, work: string, sha: string): Promise<string> {
	if (options.source !== undefined) return resolve(options.source);
	const clone = join(work, "clone");
	await exec("git", ["clone", "--filter=blob:none", "--no-checkout", "https://github.com/cursor/plugins.git", clone]);
	await exec("git", ["sparse-checkout", "set", "pstack"], { cwd: clone });
	await exec("git", ["checkout", sha], { cwd: clone });
	return join(clone, "pstack");
}

async function writeTree(directory: string, entries: ReadonlyMap<string, string>): Promise<void> {
	for (const [path, source] of entries) {
		const target = join(directory, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, source);
	}
}

async function applyPatches(directory: string, patchDirectory: string): Promise<void> {
	let patches: string[] = [];
	try {
		patches = (await readdir(patchDirectory)).filter((name) => name.endsWith(".patch")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const patch of patches) {
		const path = join(patchDirectory, patch);
		await exec("git", ["apply", "--check", path], { cwd: directory });
		await exec("git", ["apply", path], { cwd: directory });
	}
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
export async function readOverlayConfig(directory = overlayPath): Promise<OverlayConfig> {
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

export interface DroppedEntry {
	/** The path that would have shipped, after renames. */
	path: string;
	/** The upstream path it came from, so a maintainer can find it again. */
	source: string;
	reason: string;
}

export interface BuildResult {
	files: Map<string, string>;
	dropped: DroppedEntry[];
}

/**
 * Builds the generated tree from a vendored upstream tree plus overlay-owned
 * first-party source.
 *
 * Order matters. Upstream is transformed first, so a dropped path never reaches
 * the operator rules and never has to be explained twice. Overlay source is
 * applied last and wins any collision, because first-party content is the
 * authority where the two disagree - that is what makes it an overlay rather
 * than a second tree standing beside `generated/`.
 */
export async function buildGeneratedTree(
	upstreamFiles: ReadonlyMap<string, string>,
	overlayFiles: ReadonlyMap<string, string>,
	config: OverlayConfig,
): Promise<BuildResult> {
	const dropped: DroppedEntry[] = [];
	const diagnostics = [];
	const output = new Map<string, string>();
	// A path the overlay owns is never validated as upstream content: upstream's
	// version of it is a build input that does not ship, so reporting its residue
	// would be reporting a file nobody loads.
	const owned = new Set(overlayFiles.keys());

	for (const [rawPath, rawSource] of upstreamFiles) {
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
		const outcome = transformFile(path, rawSource, config);
		diagnostics.push(...outcome.diagnostics);
		for (const entry of outcome.dropped) {
			dropped.push({ path: `${path}:${entry.line}`, source: `${rawPath}:${entry.line}`, reason: entry.reason });
		}
		output.set(path, outcome.text);
	}

	// First-party overlay source is authored against these rules already, so it is
	// validated rather than rewritten: a residue here is an authoring mistake.
	for (const [rawPath, source] of overlayFiles) {
		const path = rawPath;
		const outcome = transformFile(path, source, config);
		diagnostics.push(...outcome.diagnostics);
		output.set(path, source);
	}

	if (diagnostics.length > 0) {
		throw new KStackTransformError(diagnostics);
	}
	return { files: output, dropped };
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const oldPin = await pinnedSha();
	const sha = options.pin ?? oldPin;
	const work = await mkdtemp(join(tmpdir(), "kstack-sync-"));
	try {
		const source = await materializeSource(options, work, sha);
		const config = await readOverlayConfig();
		const raw = await files(source);
		const overlaySource = await files(overlaySourcePath);
		const built = await buildGeneratedTree(raw, overlaySource, config);

		const candidate = join(work, "generated");
		await writeTree(candidate, built.files);
		await applyPatches(
			candidate,
			options.patches === undefined ? join(overlayPath, "patches") : resolve(options.patches),
		);
		const finalFiles = await files(candidate);
		assertGeneratedTree(finalFiles, config);

		const current = await files(generatedPath);
		if (options.check) {
			if (sha !== oldPin || digest(current) !== digest(finalFiles)) {
				throw new Error("K-stack generated tree drifted");
			}
			return;
		}
		if (digest(current) === digest(finalFiles) && options.pin === undefined) return;
		const next = `${generatedPath}.next`;
		const previous = `${generatedPath}.previous`;
		await rm(next, { recursive: true, force: true });
		await cp(candidate, next, { recursive: true });
		await rm(previous, { recursive: true, force: true });
		if ((await stat(generatedPath).catch(() => undefined)) !== undefined) await rename(generatedPath, previous);
		await rename(next, generatedPath);
		await rm(previous, { recursive: true, force: true });
		if (options.source === undefined) {
			await rm(upstreamPath, { recursive: true, force: true });
			await cp(source, upstreamPath, { recursive: true });
		}
		if (options.pin !== undefined && sha !== oldPin) {
			const document = (await readFile(upstreamDocument, "utf8")).replace(oldPin, sha);
			await writeFile(upstreamDocument, document);
		}
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

if (import.meta.filename === process.argv[1]) {
	await main();
}
