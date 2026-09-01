import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, sep } from "node:path";

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
}

const GENERIC = new Set(["utils", "helpers", "common", "misc"]);

export function assertDuneStack(stack: DuneStack): void {
	if (stack.version !== 1 || stack.shape !== "dune" || stack.scaffold_first !== true)
		throw new Error("Invalid Dune stack header");
	if (stack.delivery === "horizontal" && !stack.delivery_reason?.trim())
		throw new Error("Horizontal delivery requires a reason");
	for (const module of stack.modules) {
		if (basename(normalize(module.folder)) !== module.id)
			throw new Error(`Module folder must match id: ${module.id}`);
		if (GENERIC.has(module.id) && module.purpose.trim().split(/\s+/u).length < 3)
			throw new Error(`Generic module needs a tight purpose: ${module.id}`);
		const folder = `${normalize(module.folder)}${sep}`;
		if (!normalize(module.interface).startsWith(folder))
			throw new Error(`Interface must live inside ${module.folder}`);
		if (module.id === "auth" && /(?:^|\/)(?:lib|services)(?:\/|$)/u.test(module.folder))
			throw new Error("Auth must live in its auth folder");
		if (!module.allowed_paths.some((path) => path.startsWith(`${module.folder}/`)))
			throw new Error(`Module ${module.id} does not allow its own folder`);
		if (!module.allowed_paths.some((path) => path.startsWith(`test/${module.id}/`)))
			throw new Error(`Module ${module.id} lacks its test twin`);
	}
}

function globPrefix(pattern: string): string {
	const wildcard = pattern.search(/[?*[]/u);
	return normalize(wildcard < 0 ? pattern : pattern.slice(0, wildcard));
}

export function assertClaimInModule(projectRoot: string, path: string, module: StackModule): void {
	const projectPath = normalize(relative(projectRoot, join(projectRoot, path)));
	if (
		projectPath.startsWith("..") ||
		!module.allowed_paths.some((pattern) => projectPath.startsWith(globPrefix(pattern)))
	) {
		throw new Error(`UNSAFE claim outside module ${module.id}: ${path}`);
	}
}
export async function scaffoldModule(
	projectRoot: string,
	module: StackModule,
): Promise<{ folder: string; interface: string; testTwin: string }> {
	const folder = join(projectRoot, module.folder);
	const interfacePath = join(projectRoot, module.interface);
	const testTwin = join(projectRoot, "test", module.id, "index.test.ts");
	await mkdir(folder, { recursive: true });
	await mkdir(dirname(interfacePath), { recursive: true });
	await mkdir(dirname(testTwin), { recursive: true });
	await writeFile(interfacePath, "export {};\n", { flag: "a" });
	await writeFile(testTwin, "export {};\n", { flag: "a" });
	return { folder, interface: interfacePath, testTwin };
}

export async function readDuneStack(runDirectory: string): Promise<DuneStack> {
	const stack = JSON.parse(await readFile(join(runDirectory, "stack.json"), "utf8")) as DuneStack;
	assertDuneStack(stack);
	return stack;
}
