import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * A tree of files, read as bytes with their executable bit.
 *
 * Bytes rather than strings because the pinned upstream subtree contains images,
 * and a utf8 round trip silently rewrites them. Modes because a git tree object
 * hashes `100644` and `100755` differently, so a pin verified from a tree that
 * lost its execute bits would be verified against the wrong identity.
 */
export interface TreeEntry {
	readonly bytes: Buffer;
	/** True when the file is executable; git stores only that one bit. */
	readonly executable: boolean;
}

export type Tree = Map<string, TreeEntry>;

export class TreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TreeError";
	}
}

function toPosix(path: string): string {
	return path.split("\\").join("/");
}

/**
 * Reads a directory into a tree.
 *
 * A symlink is refused rather than followed. The pinned subtree is content we did
 * not write, and a link inside it could point anywhere; resolving one would make
 * the staged bytes depend on the machine doing the staging.
 */
export async function readTree(directory: string): Promise<Tree> {
	const tree: Tree = new Map();
	async function visit(current: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isSymbolicLink()) {
				throw new TreeError(`refusing a symlink in a pinned tree: ${toPosix(relative(directory, path))}`);
			}
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isFile()) {
				throw new TreeError(`refusing a non-regular file in a pinned tree: ${toPosix(relative(directory, path))}`);
			}
			const info = await lstat(path);
			tree.set(toPosix(relative(directory, path)), {
				bytes: await readFile(path),
				executable: (info.mode & 0o111) !== 0,
			});
		}
	}
	try {
		await visit(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	return tree;
}

/** Writes a tree, preserving the executable bit. */
export async function writeTree(directory: string, tree: ReadonlyMap<string, TreeEntry>): Promise<void> {
	for (const [path, entry] of tree) {
		const target = join(directory, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, entry.bytes);
		await chmod(target, entry.executable ? 0o755 : 0o644);
	}
}

/**
 * A stable digest over paths, modes and bytes.
 *
 * Mode is part of the digest because a file that becomes executable is a real
 * change to what ships, and a digest that ignored it would call that a no-op.
 */
export function digestTree(tree: ReadonlyMap<string, TreeEntry>): string {
	const hash = createHash("sha256");
	for (const [path, entry] of [...tree].sort(([left], [right]) => left.localeCompare(right))) {
		hash
			.update(path)
			.update("\0")
			.update(entry.executable ? "x" : "-")
			.update("\0");
		hash.update(entry.bytes).update("\0");
	}
	return hash.digest("hex");
}

/** A directory is empty when it has no entries at all. */
export async function assertEmptyDirectory(directory: string): Promise<void> {
	const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	});
	if (entries !== undefined && entries.length > 0) {
		throw new TreeError(`staging directory is not empty: ${directory}`);
	}
	await mkdir(directory, { recursive: true });
}

/**
 * Extensions that are binary even when their first bytes happen to be clean.
 *
 * Small on purpose. The default is text, because a new upstream text extension
 * must be transformed rather than silently copied through with its residue
 * intact - which is what an allowlist would do the first time upstream added a
 * `.tsv` or a `.mdc`.
 */
const BINARY_EXTENSIONS = new Set([
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"avif",
	"ico",
	"icns",
	"pdf",
	"zip",
	"gz",
	"tgz",
	"bz2",
	"xz",
	"zst",
	"7z",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"wasm",
	"lockb",
	"node",
	"dylib",
	"so",
	"dll",
	"exe",
	"class",
	"jar",
	"mp3",
	"mp4",
	"mov",
	"webm",
	"wav",
]);

/**
 * Whether a path carries text the transforms may rewrite.
 *
 * A NUL byte in the head is the decisive signal, with the extension denylist
 * ahead of it for a binary format that starts clean. A file this returns false
 * for is copied byte for byte and never interpreted.
 */
export function isTextFile(path: string, bytes: Buffer): boolean {
	const name = path.split("/").at(-1) ?? path;
	const extension = name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
	if (BINARY_EXTENSIONS.has(extension)) {
		return false;
	}
	return !bytes.subarray(0, 8192).includes(0);
}

/**
 * The git tree object id this directory's contents would have.
 *
 * Computed locally in a throwaway repository, so the identity a pin records is
 * verifiable with no network and no remote. `-c core.autocrlf=false` and
 * `--force` matter: line-ending translation or an ignore file inside the pinned
 * tree would otherwise change the object being hashed.
 */
export async function computeTreeOid(directory: string, prefix = "pstack"): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "kstack-oid-"));
	try {
		const repository = join(scratch, "repo");
		await mkdir(join(repository, prefix), { recursive: true });
		await writeTree(join(repository, prefix), await readTree(directory));
		const base = [
			"-c",
			"core.autocrlf=false",
			"-c",
			"core.safecrlf=false",
			"-c",
			"core.fileMode=true",
			"-c",
			"user.name=kstack",
			"-c",
			"user.email=kstack@localhost",
		];
		await exec("git", [...base, "init", "--quiet", repository]);
		await exec("git", [...base, "add", "--force", "--all", prefix], { cwd: repository });
		const { stdout } = await exec("git", [...base, "write-tree", `--prefix=${prefix}`], { cwd: repository });
		const oid = stdout.trim();
		if (!/^[0-9a-f]{40}$/u.test(oid)) {
			throw new TreeError(`git produced no tree id for ${directory}`);
		}
		return oid;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Files left behind by a partial patch application. Never acceptable. */
export const PATCH_DEBRIS = /\.(rej|orig)$/u;

export async function findPatchDebris(directory: string): Promise<string[]> {
	const tree = await readTree(directory).catch(() => new Map<string, TreeEntry>());
	return [...tree.keys()].filter((path) => PATCH_DEBRIS.test(path)).sort();
}

/**
 * Resolves a patch target against a root and refuses anything that escapes it.
 *
 * `git apply` already refuses `..` and absolute paths, but this is checked before
 * git runs so the refusal is ours, is located, and does not depend on an exit
 * code that `--unsafe-paths` would turn into success.
 */
export function confinePath(root: string, candidate: string): string {
	if (candidate.length === 0) {
		throw new TreeError("patch names an empty path");
	}
	const normalized = toPosix(candidate);
	if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
		throw new TreeError(`patch names an absolute path: ${candidate}`);
	}
	if (normalized.split("/").includes("..")) {
		throw new TreeError(`patch path escapes the staging tree: ${candidate}`);
	}
	const absolute = resolve(root, normalized);
	const inside = relative(resolve(root), absolute);
	if (inside.startsWith("..") || inside.length === 0) {
		throw new TreeError(`patch path escapes the staging tree: ${candidate}`);
	}
	return absolute;
}

/**
 * Refuses a target whose parent chain contains a symlink.
 *
 * A confined relative path can still land outside the tree if a directory on the
 * way is a link, and `git apply` writing through it would be a write we approved
 * without meaning to.
 */
export async function assertNoSymlinkedParent(root: string, candidate: string): Promise<void> {
	const segments = toPosix(candidate).split("/").slice(0, -1);
	let current = resolve(root);
	for (const segment of segments) {
		current = join(current, segment);
		const info = await lstat(current).catch(() => undefined);
		if (info?.isSymbolicLink() === true) {
			throw new TreeError(`patch path passes through a symlink: ${candidate}`);
		}
	}
}

/** Writes a file only when absent, used for the promotion marker. */
export async function writeMarker(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const file = await open(path, "w", 0o600);
	try {
		await file.writeFile(contents);
		await file.sync();
	} finally {
		await file.close();
	}
}
