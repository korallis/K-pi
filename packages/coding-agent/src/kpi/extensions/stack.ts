import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { isJsonObject } from "./graph/schema.ts";
import { atomicWrite, contractHash, type Task } from "./run-store.ts";

export interface StackModule {
	id: string;
	purpose: string;
	folder: string;
	interface: string;
	allowed_paths: string[];
	depends_on: string[];
}

export interface DuneStack {
	version: 1;
	shape: "dune";
	delivery: "vertical" | "horizontal";
	delivery_reason?: string;
	root: string;
	modules: StackModule[];
	scaffold_first: true;
	/**
	 * The `task.json` this stack was frozen against. Present once the control
	 * plane has frozen the contract; an absent hash falls back to file order.
	 */
	task_hash?: string;
	/**
	 * The slice the plan selected for the next implement round. The control plane
	 * freezes this into `task.json.current_module_id`; it is never a default and
	 * never a position.
	 */
	current_module_id?: string;
}

/** Folders that are a layer, not a capability. Legal inside a feature, never as the map. */
const LAYER_FOLDERS = new Set([
	"components",
	"hooks",
	"lib",
	"libs",
	"services",
	"controllers",
	"models",
	"views",
	"api",
	"apis",
	"ui",
	"frontend",
	"backend",
	"routes",
	"handlers",
	"middleware",
	"pages",
]);

/** Folders that mean "somewhere else": allowed only with a tight purpose. */
const GENERIC_FOLDERS = new Set(["utils", "helpers", "common", "misc", "core", "shared-utils"]);

/** Files a generic folder may hold before it stops being tight. */
export const GENERIC_FOLDER_FILE_BUDGET = 5;

/** Playbooks that legitimately touch code without a capability map. */
export const NO_STACK_PLAYBOOKS = new Set(["typo", "unslop", "comment-strip"]);

/** Staging language that describes a layer sweep rather than a slice. */
const LAYER_SWEEP_PATTERN =
	/\ball\s+(?:the\s+)?(?:apis?|endpoints?|controllers?|routes?|screens?|uis?|views?|pages?|components?)\b/iu;

export class DuneStackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DuneStackError";
	}
}

/** A repository-relative POSIX path, or nothing when the value escapes the tree. */
export function normalizeProjectPath(projectRoot: string, value: string): string | undefined {
	if (value.length === 0) {
		return undefined;
	}
	const absolute = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
	const relativePath = relative(resolve(projectRoot), absolute);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		// Traversal, or an absolute path pointing outside the project: not a path
		// this project can claim.
		return undefined;
	}
	return relativePath.split(sep).join("/");
}

function patternSegments(pattern: string): string[] {
	return pattern
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== ".");
}

function segmentMatcher(segment: string): RegExp {
	// `*` and `?` stay inside one segment; everything else is literal.
	const source = segment
		.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&")
		.replaceAll("*", "[^/]*")
		.replaceAll("?", "[^/]");
	return new RegExp(`^${source}$`, "u");
}

/**
 * Segment-wise glob match.
 *
 * Matching on string prefixes is what lets `src/auth-admin` pass for
 * `src/auth/**`: the characters line up even though the folders are different
 * capabilities. Comparing whole segments makes the boundary the folder boundary,
 * which is what the map means. `**` spans any number of segments, `*` and `?`
 * stay inside one, and `\` is accepted so a Windows-shaped path is still a path.
 */
export function matchesPathPattern(pattern: string, candidate: string): boolean {
	const patternParts = patternSegments(pattern);
	const candidateParts = patternSegments(candidate);

	const walk = (patternIndex: number, candidateIndex: number): boolean => {
		if (patternIndex === patternParts.length) {
			return candidateIndex === candidateParts.length;
		}
		const part = patternParts[patternIndex];
		if (part === "**") {
			for (let skip = candidateIndex; skip <= candidateParts.length; skip += 1) {
				if (walk(patternIndex + 1, skip)) {
					return true;
				}
			}
			return false;
		}
		if (candidateIndex === candidateParts.length) {
			return false;
		}
		return segmentMatcher(part).test(candidateParts[candidateIndex]) && walk(patternIndex + 1, candidateIndex + 1);
	};

	if (walk(0, 0)) {
		return true;
	}
	// A pattern naming a folder covers what is inside that folder: `src/auth`
	// admits `src/auth/api.ts`, but never `src/auth-admin/api.ts`.
	//
	// Only a literal folder does. A wildcard pattern means exactly what its
	// segments say: `src/*` is one level deep, and letting it imply descendants
	// would quietly turn every single-level glob into a `**`.
	const hasWildcard = patternParts.some((part) => part.includes("*") || part.includes("?"));
	if (!hasWildcard && candidateParts.length > patternParts.length) {
		return patternParts.every((part, index) => part === candidateParts[index]);
	}
	return false;
}

/**
 * A path a stack may declare: repository-relative, POSIX, no absolute root, no
 * `.` or `..`, no empty or doubled separator.
 *
 * Checked rather than normalized, because `patternSegments` drops empty
 * segments: without this, a declared `/etc/passwd` would lose its leading slash
 * and read as the repository-relative `etc/passwd`, and `src/auth/../billing`
 * would read as a path inside `src/auth`.
 */
function assertDeclaredPath(value: unknown, label: string, options: { allowGlob: boolean }): string[] {
	if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
		throw new DuneStackError(`${label} must be a trimmed, non-empty path`);
	}
	if (/^[/\\]/u.test(value) || /^[A-Za-z]:[/\\]/u.test(value)) {
		throw new DuneStackError(`${label} must be repository-relative, not absolute: ${value}`);
	}
	const parts = value.replaceAll("\\", "/").split("/");
	for (const part of parts) {
		if (part.length === 0) {
			throw new DuneStackError(`${label} must not contain an empty path segment: ${value}`);
		}
		if (part === "." || part === "..") {
			throw new DuneStackError(`${label} must not contain a ${part} segment: ${value}`);
		}
	}
	if (!options.allowGlob && /[*?[\]]/u.test(value)) {
		throw new DuneStackError(`${label} must name an exact path, not a pattern: ${value}`);
	}
	return parts;
}

/** The test twin a module owns, whether or not it is spelled in `allowed_paths`. */
export function testTwinFor(module: StackModule): string {
	return `test/${module.id}`;
}

/**
 * Whether this module may write this path. One predicate, used by implement
 * bounds and by `claim_path`, so a worker and the graph cannot disagree about
 * where the current slice ends.
 */
export function moduleOwnsPath(projectRoot: string, module: StackModule, path: string): boolean {
	const normalized = normalizeProjectPath(projectRoot, path);
	if (normalized === undefined) {
		return false;
	}
	const patterns = [...module.allowed_paths, module.folder, module.interface, testTwinFor(module)];
	return patterns.some((pattern) => matchesPathPattern(pattern, normalized));
}

function assertStringField(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new DuneStackError(`${label} must be a non-empty string`);
	}
}

function assertModuleShape(value: unknown, index: number): asserts value is StackModule {
	if (!isJsonObject(value)) {
		throw new DuneStackError(`modules[${index}] must be an object`);
	}
	assertStringField(value.id, `modules[${index}].id`);
	if (assertDeclaredPath(value.id, `modules[${index}].id`, { allowGlob: false }).length !== 1) {
		throw new DuneStackError(`modules[${index}].id must be a single path segment: ${String(value.id)}`);
	}
	assertStringField(value.purpose, `modules[${index}].purpose`);
	assertDeclaredPath(value.folder, `modules[${index}].folder`, { allowGlob: false });
	assertDeclaredPath(value.interface, `modules[${index}].interface`, { allowGlob: false });
	if (!Array.isArray(value.allowed_paths) || value.allowed_paths.some((entry) => typeof entry !== "string")) {
		throw new DuneStackError(`modules[${index}].allowed_paths must be an array of strings`);
	}
	if (value.allowed_paths.length === 0) {
		throw new DuneStackError(`modules[${index}].allowed_paths must not be empty`);
	}
	for (const [entryIndex, entry] of value.allowed_paths.entries()) {
		assertDeclaredPath(entry, `modules[${index}].allowed_paths[${entryIndex}]`, { allowGlob: true });
	}
	if (!Array.isArray(value.depends_on) || value.depends_on.some((entry) => typeof entry !== "string")) {
		throw new DuneStackError(`modules[${index}].depends_on must be an array of strings`);
	}
}

/**
 * Validates the whole map. Every rule here is a plan-gate rule from
 * `dune-architecture.md`: a stranger must be able to read the product from the
 * folder names, and one implement round must be one slice.
 */
export function assertDuneStack(value: unknown): asserts value is DuneStack {
	if (!isJsonObject(value)) {
		throw new DuneStackError("stack must be an object");
	}
	if (value.version !== 1 || value.shape !== "dune" || value.scaffold_first !== true) {
		throw new DuneStackError("Invalid Dune stack header");
	}
	if (value.delivery !== "vertical" && value.delivery !== "horizontal") {
		throw new DuneStackError("delivery must be vertical or horizontal");
	}
	if (
		value.delivery === "horizontal" &&
		(typeof value.delivery_reason !== "string" || value.delivery_reason.trim().length === 0)
	) {
		throw new DuneStackError("Horizontal delivery requires a reason");
	}
	assertStringField(value.root, "root");
	assertDeclaredPath(value.root, "root", { allowGlob: false });
	if (!Array.isArray(value.modules) || value.modules.length === 0) {
		throw new DuneStackError("stack must declare at least one module");
	}

	const ids = new Set<string>();
	const modules: StackModule[] = [];
	for (const [index, entry] of value.modules.entries()) {
		assertModuleShape(entry, index);
		if (ids.has(entry.id)) {
			throw new DuneStackError(`duplicate module id: ${entry.id}`);
		}
		ids.add(entry.id);
		modules.push(entry);
	}

	const root = patternSegments(value.root);
	for (const module of modules) {
		const folder = patternSegments(module.folder);
		if (folder.length === 0) {
			throw new DuneStackError(`Module ${module.id} has no folder`);
		}
		// Folder name is the capability name. No clever aliases.
		if (folder.at(-1) !== module.id) {
			throw new DuneStackError(`Module folder must match id: ${module.id}`);
		}
		// A layer is not a capability, and a layer folder is legal only inside a
		// feature folder - never as the top-level map.
		// The map lives under the declared root; a module folder outside it is not
		// part of the map at all.
		if (folder.length <= root.length || !root.every((part, index) => part === folder[index])) {
			throw new DuneStackError(`Module ${module.id} folder must live under root ${value.root}: ${module.folder}`);
		}
		const isTopLevel = folder.length === root.length + 1;
		if (LAYER_FOLDERS.has(module.id) && isTopLevel) {
			throw new DuneStackError(`Layer folder ${module.id} cannot be a top-level module`);
		}
		if (GENERIC_FOLDERS.has(module.id) && module.purpose.trim().split(/\s+/u).length < 3) {
			throw new DuneStackError(`Generic module needs a tight purpose: ${module.id}`);
		}
		// Auth's home is its own folder, not a layer bucket.
		if (module.id === "auth" && folder.slice(0, -1).some((part) => LAYER_FOLDERS.has(part))) {
			throw new DuneStackError("Auth must live in its auth folder");
		}
		if (!matchesPathPattern(module.folder, module.interface)) {
			throw new DuneStackError(`Interface must live inside ${module.folder}`);
		}
		// Coverage is asked the way a claim asks it: does some declared pattern
		// admit a representative path inside the folder? Matching pattern against
		// pattern is the inverted question and answers a different one.
		const folderProbe = `${folder.join("/")}/index.ts`;
		if (!module.allowed_paths.some((pattern) => matchesPathPattern(pattern, folderProbe))) {
			throw new DuneStackError(`Module ${module.id} does not allow its own folder`);
		}
		const twinProbe = `${testTwinFor(module)}/index.test.ts`;
		if (!module.allowed_paths.some((pattern) => matchesPathPattern(pattern, twinProbe))) {
			throw new DuneStackError(`Module ${module.id} lacks its test twin`);
		}
		for (const dependency of module.depends_on) {
			if (!ids.has(dependency)) {
				throw new DuneStackError(`Module ${module.id} depends on unknown module ${dependency}`);
			}
		}
	}

	// `shared/` holds what two or more slices need. One consumer means it belongs
	// inside that consumer, and a shared abstraction with no second slice is an
	// extraction that has not earned itself yet.
	for (const module of modules) {
		if (module.id !== "shared") {
			continue;
		}
		const consumers = modules.filter((candidate) => candidate.depends_on.includes(module.id));
		if (consumers.length < 2) {
			throw new DuneStackError(`shared needs two consuming slices before extraction; ${consumers.length} declared`);
		}
	}

	// Vertical delivery ships one capability at a time. A plan that stages every
	// API and then every screen is horizontal work, and must say so with a reason.
	if (value.delivery === "vertical") {
		for (const module of modules) {
			if (LAYER_SWEEP_PATTERN.test(module.purpose) || LAYER_SWEEP_PATTERN.test(module.id)) {
				throw new DuneStackError(`Vertical delivery cannot stage a layer sweep: ${module.id} (${module.purpose})`);
			}
		}
		const layerModules = modules.filter((module) => LAYER_FOLDERS.has(module.id));
		if (layerModules.length >= 2) {
			throw new DuneStackError(
				`Vertical delivery cannot be a layer staging plan: ${layerModules.map((module) => module.id).join(", ")}`,
			);
		}
	}
}

/** A stack is required unless the playbook is one of the named exemptions. */
export function stackRequiredFor(task: Pick<Task, "playbook">): boolean {
	const playbook = task.playbook?.trim().toLowerCase();
	return playbook === undefined || !NO_STACK_PLAYBOOKS.has(playbook);
}

/** The stack binds to the same contract hash research does. */
export function stackTaskHash(task: Task): string {
	return contractHash(task);
}

/**
 * The one slice this implement round owns.
 *
 * Position is not identity: `modules[0]` is never the current slice, not as a
 * default and not as a fallback after a failed lookup. A missing, empty, or
 * unmatched `current_module_id` stops the round.
 */
export function resolveCurrentModule(stack: DuneStack, task: Pick<Task, "current_module_id">): StackModule {
	const requested = task.current_module_id?.trim();
	if (requested === undefined || requested.length === 0) {
		throw new DuneStackError("task.json must name current_module_id; modules[0] is never the current slice");
	}
	const matches = stack.modules.filter((module) => module.id === requested);
	if (matches.length !== 1) {
		throw new DuneStackError(`current_module_id ${requested} does not name exactly one module`);
	}
	return matches[0];
}

/**
 * Files under a folder. Only an absent folder is empty: a permission or I/O
 * failure must not make a generic folder look small enough to pass its budget.
 */
async function countFiles(directory: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return 0;
		}
		throw error;
	}
	let total = 0;
	for (const entry of entries) {
		total += entry.isDirectory() ? await countFiles(join(directory, entry.name)) : 1;
	}
	return total;
}

/**
 * A generic folder stays legal only while it is small. Past the budget it is the
 * soup the map exists to prevent, whatever its purpose field claims.
 */
export async function assertGenericFolderBudget(projectRoot: string, stack: DuneStack): Promise<void> {
	for (const module of stack.modules) {
		if (!GENERIC_FOLDERS.has(module.id)) {
			continue;
		}
		const files = await countFiles(join(projectRoot, module.folder));
		if (files >= GENERIC_FOLDER_FILE_BUDGET) {
			throw new DuneStackError(
				`Generic folder ${module.folder} holds ${files} files; the budget is ${GENERIC_FOLDER_FILE_BUDGET}`,
			);
		}
	}
}

/**
 * Reads and validates the frozen stack. `ENOENT` is not swallowed: a missing
 * stack is the absence of the precondition, not a reason to proceed.
 */
export async function readDuneStack(runDirectory: string): Promise<DuneStack> {
	let raw: string;
	try {
		raw = await readFile(join(runDirectory, "stack.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new DuneStackError("stack.json is missing; implement has no frozen map to read");
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new DuneStackError("stack.json is not valid JSON");
	}
	assertDuneStack(parsed);
	return parsed;
}

/**
 * The stack must describe the task implement is about to run. A frozen hash is
 * exact; without one, a stack older than its `task.json` is stale, because the
 * plan that produced it predates the contract.
 */
export async function assertStackFresh(runDirectory: string, task: Task, stack: DuneStack): Promise<void> {
	if (stack.task_hash !== undefined) {
		if (stack.task_hash !== stackTaskHash(task)) {
			throw new DuneStackError("stack.json was frozen against a different task.json");
		}
		return;
	}
	const stackStat = await stat(join(runDirectory, "stack.json"));
	let taskStat: Stats;
	try {
		taskStat = await stat(join(runDirectory, "task.json"));
	} catch (error) {
		// A stack with no frozen hash can only be judged against the contract it
		// was written for. Without that contract there is nothing to judge, and an
		// unjudgeable stack is not a fresh one.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new DuneStackError("task.json is missing, so stack.json freshness cannot be established");
		}
		throw error;
	}
	if (stackStat.mtimeMs < taskStat.mtimeMs) {
		throw new DuneStackError("stack.json is older than task.json");
	}
}

export interface FrozenSlice {
	stack: DuneStack;
	module: StackModule;
}

/**
 * The whole precondition in one call: a stack exists, is valid, describes this
 * task, names this slice, and keeps its generic folders tight. Implement and
 * `claim_path` both go through here, so they cannot disagree.
 */
export async function freezeCurrentSlice(projectRoot: string, runDirectory: string, task: Task): Promise<FrozenSlice> {
	const stack = await readDuneStack(runDirectory);
	await assertStackFresh(runDirectory, task, stack);
	await assertGenericFolderBudget(projectRoot, stack);

	// The plan names the slice; the control plane writes it into the job contract
	// so implement reads a frozen pointer instead of guessing one. The contract
	// hash excludes this field, so freezing it does not stale anything bound to
	// the contract.
	if (
		task.current_module_id !== undefined &&
		stack.current_module_id !== undefined &&
		task.current_module_id.trim() !== stack.current_module_id.trim()
	) {
		throw new DuneStackError(
			`stack.json names slice ${stack.current_module_id} while task.json names ${task.current_module_id}`,
		);
	}
	if (task.current_module_id === undefined && stack.current_module_id !== undefined) {
		const frozen: Task = { ...task, current_module_id: stack.current_module_id };
		resolveCurrentModule(stack, frozen);
		await atomicWrite(join(runDirectory, "task.json"), `${JSON.stringify(frozen, null, 2)}\n`);
		task.current_module_id = stack.current_module_id;
	}
	return { stack, module: resolveCurrentModule(stack, task) };
}

/** How many symlinks a claim may follow before the answer is refused. */
export const MAX_LINK_RESOLUTION_STEPS = 64;

/** How many path components a claim may process. Bounds a pathological expansion. */
const MAX_PATH_COMPONENT_STEPS = 4_096;

/**
 * Escape is not a resolver outcome: the resolver answers where the path lands,
 * and the caller decides whether that is inside the project and the module.
 */
type ClaimResolution = { kind: "resolved"; absolute: string } | { kind: "exhausted" };

/** An absolute path split into its filesystem root and its segments. */
function splitAbsolute(absolute: string): { root: string; parts: string[] } {
	const parsed = parse(absolute);
	const remainder = absolute.slice(parsed.root.length);
	return { root: parsed.root, parts: remainder.split(/[/\\]+/u).filter((part) => part.length > 0) };
}

/**
 * Where a claimed path really lands, resolved one component at a time.
 *
 * Every existing component is inspected, and a symlink's target is pushed back
 * onto the queue in full - reset to that target's own filesystem root - so links
 * nested inside a target are inspected too. Collapsing a prefix with `realpath`
 * cannot do this: `realpath` stops at the deepest existing ancestor, and the tail
 * it appends may itself contain a dangling link that points anywhere.
 *
 * `ENOENT` is the one case where the remaining tail may be appended lexically:
 * nothing can exist beneath a parent that does not exist, so no component in that
 * tail can be a link.
 *
 * Both bounds refuse rather than answer, and macOS's `/var` -> `/private/var`
 * alias resolves naturally, because it is a component like any other.
 */
async function resolveClaimTarget(startAbsolute: string): Promise<ClaimResolution> {
	const start = splitAbsolute(resolve(startAbsolute));
	let base = start.root;
	let pending = start.parts;
	let hops = 0;
	let steps = 0;

	while (pending.length > 0) {
		steps += 1;
		if (steps > MAX_PATH_COMPONENT_STEPS) {
			return { kind: "exhausted" };
		}
		const segment = pending.shift() as string;
		if (segment === ".") {
			continue;
		}
		if (segment === "..") {
			// A link target may climb, and it climbs for real.
			base = dirname(base);
			continue;
		}
		const candidate = join(base, segment);

		let link: string | undefined;
		try {
			const info = await lstat(candidate);
			link = info.isSymbolicLink() ? await readlink(candidate) : undefined;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ELOOP") {
				return { kind: "exhausted" };
			}
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw error;
			}
			// Nothing exists here, so nothing deeper can either: the rest of the
			// path is where a write would land, and none of it can be a link.
			return { kind: "resolved", absolute: join(candidate, ...pending) };
		}

		if (link === undefined) {
			base = candidate;
			continue;
		}

		hops += 1;
		if (hops > MAX_LINK_RESOLUTION_STEPS) {
			return { kind: "exhausted" };
		}
		// The link's directory is `base`, so a relative target resolves against it.
		const target = splitAbsolute(isAbsolute(link) ? resolve(link) : resolve(base, link));
		base = target.root;
		pending = [...target.parts, ...pending];
	}

	return { kind: "resolved", absolute: base };
}

/**
 * Refuses a claim outside the current slice.
 *
 * The lexical path must belong to the module, and so must the path it resolves
 * to: a link inside the folder that points elsewhere - existing, dangling, or
 * nested behind another link - is an escape, because the boundary is about where
 * the bytes land. Only the final resolved path is compared, so a project root
 * reached through an alias is not mistaken for an escape.
 */
export async function assertClaimInModule(projectRoot: string, path: string, module: StackModule): Promise<void> {
	const normalized = normalizeProjectPath(projectRoot, path);
	if (normalized === undefined || !moduleOwnsPath(projectRoot, module, normalized)) {
		throw new DuneStackError(`UNSAFE claim outside module ${module.id}: ${path}`);
	}

	// The root is resolved the same way, so both sides of the comparison are real
	// paths. An absent project root is the only tolerated failure.
	let realRoot: string;
	try {
		realRoot = await realpath(projectRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		realRoot = resolve(projectRoot);
	}

	const resolution = await resolveClaimTarget(join(projectRoot, normalized));
	if (resolution.kind === "exhausted") {
		throw new DuneStackError(`UNSAFE claim follows too many links to resolve: ${path}`);
	}
	const insideRoot = relative(realRoot, resolution.absolute);
	if (insideRoot === ".." || insideRoot.startsWith(`..${sep}`) || isAbsolute(insideRoot)) {
		throw new DuneStackError(`UNSAFE claim escapes the project through a link: ${path}`);
	}
	// The same predicate, asked again about where the write really goes.
	const resolved = insideRoot.split(sep).join("/");
	if (resolved.length > 0 && !moduleOwnsPath(projectRoot, module, resolved)) {
		throw new DuneStackError(`UNSAFE claim outside module ${module.id} after link resolution: ${path}`);
	}
}

/**
 * Creates an empty placeholder, or leaves what is already there alone. A later
 * round re-scaffolds the same module, and appending stubs to a real interface
 * would corrupt the file the map exists to publish.
 */
async function createIfAbsent(path: string): Promise<void> {
	try {
		await writeFile(path, "export {};\n", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
}

export interface ScaffoldResult {
	/** In order: the folder, the public interface, then the test twin. */
	steps: string[];
	folder: string;
	interface: string;
	testTwin: string;
}

/**
 * Creates the empty map before any behaviour: feature folder, public interface,
 * matching test folder. The order is the contract, so it is what this returns.
 */
export async function scaffoldModule(projectRoot: string, module: StackModule): Promise<ScaffoldResult> {
	const folder = join(projectRoot, module.folder);
	const interfacePath = join(projectRoot, module.interface);
	const testTwin = join(projectRoot, testTwinFor(module), "index.test.ts");
	const steps: string[] = [];

	await mkdir(folder, { recursive: true });
	steps.push(module.folder);

	await mkdir(dirname(interfacePath), { recursive: true });
	await createIfAbsent(interfacePath);
	steps.push(module.interface);

	await mkdir(dirname(testTwin), { recursive: true });
	await createIfAbsent(testTwin);
	steps.push(`${testTwinFor(module)}/index.test.ts`);

	return { steps, folder, interface: interfacePath, testTwin };
}

/**
 * Behaviour may only exist once the map does. A folder holding implementation
 * files while its public interface or test twin is missing is the case
 * `dune-architecture.md` calls UNSAFE.
 */
export async function assertScaffoldedBeforeBehavior(projectRoot: string, module: StackModule): Promise<void> {
	const behaviour: string[] = [];
	const scan = async (directory: string, prefix: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(join(projectRoot, directory), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = `${directory}/${entry.name}`;
			if (entry.isDirectory()) {
				await scan(child, prefix);
				continue;
			}
			if (child !== module.interface) {
				behaviour.push(child);
			}
		}
	};
	await scan(patternSegments(module.folder).join("/"), module.id);
	if (behaviour.length === 0) {
		return;
	}
	const missing: string[] = [];
	for (const required of [module.interface, `${testTwinFor(module)}/index.test.ts`]) {
		try {
			await stat(join(projectRoot, required));
		} catch {
			missing.push(required);
		}
	}
	if (missing.length > 0) {
		throw new DuneStackError(
			`Module ${module.id} has behaviour (${behaviour[0]}) before its scaffold: missing ${missing.join(", ")}`,
		);
	}
}
