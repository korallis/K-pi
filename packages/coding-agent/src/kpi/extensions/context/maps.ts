import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { withLeaseLock } from "../bus/leases.ts";
import { atomicWrite } from "../run-store.ts";
import { canonicalProjectPath, type DuneStack, moduleOwnsPath } from "../stack.ts";
import { readLanguageServers, SemanticNavigation, type SemanticResult } from "./lsp.ts";

const exec = promisify(execFile);
export function contentHash(content: string | Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export interface RepositoryFile {
	path: string;
	hash: string;
	bytes: number;
	language: string;
	symbols: SemanticResult;
}
export interface RepositoryMap {
	version: 1;
	kind: "repository";
	revision: number;
	hash: string;
	toolingHash: string;
	files: RepositoryFile[];
}
export interface ProductFeatureMap {
	version: 1;
	kind: "product-features";
	hash: string;
	intentHash: string;
	stackHash?: string;
	features: Array<{
		id: string;
		purpose: string;
		ownership: string[];
		dependencies: string[];
		observedFiles: string[];
	}>;
}
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".kt",
	".c",
	".h",
	".cpp",
	".cs",
	".rb",
	".php",
	".swift",
	".scala",
	".sh",
	".vue",
	".svelte",
	".json",
	".yaml",
	".yml",
	".toml",
	".md",
	".css",
	".html",
	".sql",
]);
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".kpi",
	"node_modules",
	"vendor",
	"dist",
	"build",
	".venv",
	"venv",
	"__pycache__",
	"target",
]);
function eligible(path: string): boolean {
	const parts = path.split("/");
	return (
		!parts.some((part) => EXCLUDED_DIRECTORIES.has(part)) &&
		!/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|accounts\.secrets\.json|.*\.(?:pem|key))$/iu.test(path) &&
		SOURCE_EXTENSIONS.has(extname(path))
	);
}
async function inventory(root: string): Promise<string[]> {
	try {
		const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: root,
			maxBuffer: 32 * 1024 * 1024,
		});
		return [...new Set(stdout.split("\0").filter(eligible))].sort();
	} catch (error) {
		if (!(error instanceof Error) || !("stderr" in error) || !String(error.stderr).includes("not a git repository"))
			throw error;
		// Existing non-git projects are valid; never follow directory symlinks.
		const paths: string[] = [];
		const scan = async (directory: string): Promise<void> => {
			for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
				const path = directory ? `${directory}/${entry.name}` : entry.name;
				if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) await scan(path);
				else if (entry.isFile() && eligible(path)) paths.push(path);
			}
		};
		await scan("");
		return paths.sort();
	}
}

export interface RepositoryMapOptions {
	projectRoot: string;
	runDirectory: string;
	affectedPaths?: string[];
}

/** Serialize incremental cache promotion across agent processes using the existing native lock. */
export function updateRepositoryMap(options: RepositoryMapOptions): Promise<RepositoryMap> {
	return withLeaseLock(join(options.runDirectory, "context"), () => rebuildRepositoryMap(options));
}

/** Affected-file updates retain all untouched records; a full refresh detects additions/deletions. */
async function rebuildRepositoryMap(options: RepositoryMapOptions): Promise<RepositoryMap> {
	const path = join(options.runDirectory, "context", "repository-map.json");
	let previous: RepositoryMap | undefined;
	try {
		previous = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (previous && (previous.version !== 1 || previous.kind !== "repository" || !Array.isArray(previous.files)))
		throw new Error(`Invalid repository projection: ${path}`);
	const configs = await readLanguageServers(options.projectRoot);
	const toolingHash = contentHash(JSON.stringify(configs));
	const incremental =
		previous !== undefined && options.affectedPaths !== undefined && previous.toolingHash === toolingHash;
	const targets = incremental ? [...new Set(options.affectedPaths)].sort() : await inventory(options.projectRoot);
	const files = new Map<string, RepositoryFile>(
		incremental && previous ? previous.files.map((file) => [file.path, file]) : [],
	);
	const old = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
	const semantic = new SemanticNavigation(options.projectRoot, configs);
	try {
		for (const target of targets) {
			const canonical = await canonicalProjectPath(options.projectRoot, target);
			files.delete(target);
			if (!eligible(canonical)) continue;
			let bytes: Buffer;
			try {
				const info = await lstat(join(options.projectRoot, canonical));
				if (!info.isFile()) continue;
				bytes = await readFile(join(options.projectRoot, canonical));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			const hash = contentHash(bytes);
			const cached = old.get(canonical);
			if (
				cached?.hash === hash &&
				previous?.toolingHash === toolingHash &&
				(cached.symbols.status === "available" ||
					!configs.some((config) => config.extensions.includes(extname(canonical))))
			) {
				files.set(canonical, cached);
				continue;
			}
			files.set(canonical, {
				path: canonical,
				hash,
				bytes: bytes.length,
				language: extname(canonical).slice(1),
				symbols: await semantic.retrieve(canonical, "symbols", 0, 0, bytes),
			});
		}
	} finally {
		await semantic.close();
	}
	const records = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
	const hash = contentHash(JSON.stringify({ toolingHash, files: records }));
	const map: RepositoryMap = {
		version: 1,
		kind: "repository",
		revision: previous ? previous.revision + Number(previous.hash !== hash) : 1,
		hash,
		toolingHash,
		files: records,
	};
	if (previous?.hash !== hash) await atomicWrite(path, `${JSON.stringify(map)}\n`);
	return map;
}

export function buildProductFeatureMap(
	projectRoot: string,
	intentHash: string,
	stack: DuneStack | undefined,
	repository: RepositoryMap,
): ProductFeatureMap {
	const features = (stack?.modules ?? []).map((module) => ({
		id: module.id,
		purpose: module.purpose,
		ownership: module.allowed_paths,
		dependencies: module.depends_on,
		observedFiles: repository.files
			.filter((file) => moduleOwnsPath(projectRoot, module, file.path))
			.map((file) => file.path),
	}));
	const body = { intentHash, stackHash: stack ? contentHash(JSON.stringify(stack)) : undefined, features };
	return { version: 1, kind: "product-features", hash: contentHash(JSON.stringify(body)), ...body };
}

/** Deterministic feature/dependency proximity, then actual server-provided symbol/name matches. */
export function rankRepositoryFiles(
	repository: RepositoryMap,
	product: ProductFeatureMap,
	currentModule: string | undefined,
	query: string,
): RepositoryFile[] {
	const current = product.features.find((feature) => feature.id === currentModule);
	const owned = new Set(current?.observedFiles ?? []);
	const dependencies = new Set(
		product.features
			.filter((feature) => current?.dependencies.includes(feature.id))
			.flatMap((feature) => feature.observedFiles),
	);
	const terms = [
		...new Set(
			query
				.toLowerCase()
				.split(/[^\p{L}\p{N}_]+/u)
				.filter((term) => term.length > 2),
		),
	];
	const score = (file: RepositoryFile): number => {
		const text =
			`${file.path} ${file.symbols.status === "available" ? JSON.stringify(file.symbols.result) : ""}`.toLowerCase();
		return (
			(owned.has(file.path) ? 100 : 0) +
			(dependencies.has(file.path) ? 50 : 0) +
			terms.reduce((sum, term) => sum + Number(text.includes(term)), 0)
		);
	};
	return repository.files
		.map((file) => ({ file, score: score(file) }))
		.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path, "en"))
		.map(({ file }) => file);
}
