export type RenameMap = Record<string, string>;

const STRIPPED = [
	["cloud", "agent"].join(" "),
	["cursor", "cloud"].join(" "),
	["gt", "submit"].join(" "),
	["subagent", "type"].join("_"),
	["cursor", "team", "kit"].join("-"),
	["graph", "ite"].join(""),
	// Upstream author self-branding. The rename map rewrites every meaningful
	// occurrence first; whatever line still carries the name (the README
	// self-introduction) is dropped, and the generated-tree invariant below
	// keeps it from ever coming back.
	["pot", "eto"].join(""),
] as const;

/**
 * Maintainer test collateral vendored beside upstream skill scripts. It is
 * development tooling for the upstream repo, not runtime skill content, so the
 * sync pipeline drops matching paths and the generated-tree invariant below
 * keeps them from ever shipping.
 */
export const MAINTAINER_TEST_FILE = /\.test(-helper)?\.ts$/u;

export function transformKStackText(source: string, renames: RenameMap): string {
	let transformed = source;
	for (const [from, to] of Object.entries(renames)) {
		transformed = transformed.replaceAll(from, to);
	}
	for (const phrase of STRIPPED) {
		transformed = transformed
			.split("\n")
			.filter((line) => !line.toLowerCase().includes(phrase))
			.join("\n");
	}
	return transformed.replaceAll("run_in_background", "spawn_background").replaceAll("Task(", "spawn_background(");
}

export function assertGeneratedInvariants(files: ReadonlyMap<string, string>): void {
	const all = [...files.values()].join("\n").toLowerCase();
	for (const phrase of STRIPPED) {
		if (all.includes(phrase)) throw new Error(`Forbidden generated phrase: ${phrase}`);
	}
	const skillFiles = [...files].filter(([path]) => path.endsWith("SKILL.md"));
	for (const [path, source] of skillFiles) {
		const frontmatter = source.startsWith("---\n") ? source.slice(4, source.indexOf("\n---", 4)) : "";
		if (!/^name:\s*[a-z0-9][a-z0-9-]*$/mu.test(frontmatter) || !/^description:\s*.+$/mu.test(frontmatter)) {
			throw new Error(`Generated skill lacks a kebab-case name and a description: ${path}`);
		}
	}
	const maintainerFiles = [...files.keys()].filter((path) => MAINTAINER_TEST_FILE.test(path));
	if (maintainerFiles.length > 0) {
		throw new Error(`Maintainer test files must not ship in generated: ${maintainerFiles.join(", ")}`);
	}
	const names = [...files.keys()].join("\n");
	if (!names.includes("setup-kstack") || !names.includes("k-mode")) {
		throw new Error("Generated K-stack commands are missing");
	}
}
