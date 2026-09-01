import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const agentPackage = new URL("packages/coding-agent/", repoRoot);
const sourceKpiDir = fileURLToPath(new URL("src/kpi", agentPackage));
const distRoot = new URL("dist/", agentPackage);
const distDir = fileURLToPath(new URL("dist", agentPackage));
const distKpiDir = join(distDir, "kpi");

/**
 * Extension packages published for someone else's Pi install. K-π is a harness,
 * not an extension package, so none of these may reappear as a dependency and no
 * `pi install <pkg>` step may be required to get K-π's own commands.
 */
const forbiddenDependencies = [
	"oh-my-pi",
	"pi-status-bar",
	"pi-vitals",
	"pi-powerline-footer",
	"atomic",
	"pi-graph",
	"pi-multi-account",
	"pi-multi-pass",
	"pi-cursor-oauth",
	"pi-cursor-provider",
	"exa-js",
	"@perplexity-ai/perplexity_ai",
	"pstack",
	"open-pstack",
	"pi-pstack",
	"pi-intercom",
	"pi-mesh",
	"pi-agents-talk-to-each-other",
	"pi-bus",
	"pi-side-agents",
] as const;

/**
 * Resource roots the K-π loop reads at runtime, relative to the harness resource
 * root (`src/kpi/` in a source tree, `dist/kpi/` in a build). `skills`, `prompts`
 * and `themes` are handed to the resource loader by the built-in extension's
 * `resources_discover` handler; `graphs`, `schemas` and `templates` are read
 * directly by the graph engine and the policy bootstrap.
 */
const runtimeResourceRoots: readonly string[] = [
	"graphs",
	"kstack/generated/skills",
	"prompts",
	"schemas",
	"skills",
	"templates",
	"themes",
];

const secretShapedPath =
	/(^|\/)(\.env(\.[^/]+)?|\.netrc|\.npmrc|\.pgpass|id_[a-z]+|[^/]*(secret|credential|password|token)[^/]*|[^/]+\.(pem|key|p12|pfx|jks|keystore|asc))$/i;

/**
 * Paths that must never reach a K-π user. The shipped resource tree is the
 * harness's own runtime data, so upstream test suites, fixture corpora and the
 * K-stack maintainer tooling that regenerates `kstack/generated` are all debris
 * there, however legitimate they are in the source tree.
 */
const forbiddenShippedPaths: ReadonlyArray<{ label: string; pattern: RegExp }> = [
	{ label: "test and spec sources", pattern: /(^|\/)[^/]*\.(test|spec|test-helper)\.[^/]+$/i },
	{
		label: "test scaffolding directories",
		pattern: /(^|\/)(__tests__|__mocks__|__snapshots__|tests?|fixtures?|testdata|coverage|node_modules|\.git)(\/|$)/i,
	},
	{ label: "K-stack maintainer tooling", pattern: /(^|\/)kstack\/(scripts|overlay|upstream)(\/|$)/i },
	{
		label: "editor and build debris",
		pattern: /(^|\/)(\.DS_Store|Thumbs\.db|[^/]+\.(orig|rej|bak|swp|tsbuildinfo|log|patch|diff)|[^/]+~)$/i,
	},
];

type RootManifest = {
	name?: string;
	private?: boolean;
	keywords?: string[];
	workspaces?: string[];
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	pi?: unknown;
};

type AgentManifest = {
	name?: string;
	bin?: Record<string, string>;
	piConfig?: { name?: string; title?: string; configDir?: string };
	scripts?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	pi?: unknown;
};

async function readJson<T>(relativePath: string): Promise<T> {
	return JSON.parse(await readFile(new URL(relativePath, repoRoot), "utf8")) as T;
}

/** Every file below `root`, as sorted `/`-joined relative paths, or undefined when `root` is absent. */
async function listFiles(root: string, prefix = ""): Promise<string[] | undefined> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			files.push(...((await listFiles(join(root, entry.name), `${prefix}${entry.name}/`)) ?? []));
			continue;
		}
		files.push(`${prefix}${entry.name}`);
	}
	return files.sort();
}

async function requireBuiltHarness(): Promise<void> {
	const stats = await stat(distKpiDir).catch(() => undefined);
	assert.ok(
		stats?.isDirectory(),
		"packages/coding-agent/dist/kpi is missing: run `npm run build` before the K-π architecture proof",
	);
}

test("the root manifest is a private fork monorepo, not a publishable Pi package", async () => {
	const manifest = await readJson<RootManifest>("package.json");

	assert.equal(manifest.name, "k-pi-monorepo");
	assert.equal(manifest.private, true);
	assert.ok(manifest.workspaces?.includes("packages/*"), "the fork builds from its own workspaces");

	assert.equal(manifest.pi, undefined, "package.json#pi described a Pi extension package");
	assert.equal(manifest.peerDependencies, undefined, "K-π must not peer-depend on a Pi install");
	assert.ok(!(manifest.keywords ?? []).includes("pi-package"));

	for (const scope of [manifest.dependencies, manifest.devDependencies]) {
		for (const name of Object.keys(scope ?? {})) {
			assert.ok(
				!name.startsWith("@earendil-works/"),
				`${name} is a workspace in this repo, never an installed dependency`,
			);
		}
		for (const name of forbiddenDependencies) {
			assert.equal(scope?.[name], undefined, `${name} must not be a dependency`);
		}
	}
});

test("root scripts cover build, check, test and upstream tracking, and nothing publishes", async () => {
	const { scripts = {} } = await readJson<RootManifest>("package.json");

	for (const name of [
		"build",
		"build:offline",
		"check",
		"test",
		"test:kpi",
		"kstack:sync",
		"kstack:sync:check",
		"upstream:check",
	]) {
		assert.ok(scripts[name], `root script ${name} is missing`);
	}

	assert.match(scripts["test:kpi"], /node --test .*test\/\*\.test\.ts/, "test:kpi must run the root K-π suite");
	for (const name of ["kstack:sync", "kstack:sync:check"]) {
		assert.match(
			scripts[name],
			/packages\/coding-agent\/src\/kpi\/kstack\/scripts\/sync-kstack\.ts/,
			`${name} must point at the relocated K-stack sync script`,
		);
	}

	const publishing = Object.keys(scripts).filter((name) =>
		/^(publish|release|version|prepublish|shrinkwrap|install-lock)/.test(name),
	);
	assert.deepEqual(publishing, [], "the fork has no publish, release or version flow");
});

test("the coding-agent package is the K-π CLI: kpi and k-pi bins, .kpi config, no pi bin", async () => {
	const manifest = await readJson<AgentManifest>("packages/coding-agent/package.json");

	const entry = "dist/bundle/cli.js";
	const bins: Record<string, string> = manifest.bin ?? {};
	assert.equal(bins.pi, undefined, "the pi bin must not survive the fork");
	assert.deepEqual(bins, { kpi: entry, "k-pi": entry });

	assert.deepEqual(manifest.piConfig, { name: "kpi", title: "K-π", configDir: ".kpi" });

	assert.equal(manifest.peerDependencies, undefined);
	assert.equal(manifest.pi, undefined);

	const publishing = Object.keys(manifest.scripts ?? {}).filter((name) =>
		/^(publish|prepublish|shrinkwrap)/.test(name),
	);
	assert.deepEqual(publishing, [], "the harness package is built from source, never published");
});

test("the fork installs with npm workspaces and keeps no pnpm files", async () => {
	const lock = await readJson<{ name?: string; version?: string }>("package-lock.json");
	const manifest = await readJson<RootManifest>("package.json");
	assert.equal(lock.name, manifest.name, "package-lock.json must agree with the renamed root");

	for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
		await assert.rejects(stat(new URL(path, repoRoot)), { code: "ENOENT" }, `${path} must be gone`);
	}
});

test("every runtime resource root exists in the source layout", async () => {
	for (const root of runtimeResourceRoots) {
		const stats = await stat(new URL(`packages/coding-agent/src/kpi/${root}`, repoRoot));
		assert.ok(stats.isDirectory(), `src/kpi/${root} must be a directory`);
	}
});

test("the build ships every runtime resource asset byte-for-byte under dist/kpi", async () => {
	await requireBuiltHarness();

	for (const root of runtimeResourceRoots) {
		const sourceFiles = await listFiles(join(sourceKpiDir, root));
		assert.ok(sourceFiles && sourceFiles.length > 0, `src/kpi/${root} ships no assets`);

		const shippedFiles = await listFiles(join(distKpiDir, root));
		assert.notEqual(shippedFiles, undefined, `dist/kpi/${root} is missing from the build`);
		assert.deepEqual(shippedFiles, sourceFiles, `dist/kpi/${root} does not mirror src/kpi/${root}`);

		for (const file of sourceFiles) {
			const [source, shipped] = await Promise.all([
				readFile(join(sourceKpiDir, root, file)),
				readFile(join(distKpiDir, root, file)),
			]);
			assert.ok(shipped.equals(source), `dist/kpi/${root}/${file} is not a byte-for-byte copy of the source asset`);
		}
	}
});

test("the shipped K-π resource tree carries no secrets and no test, fixture or maintainer debris", async () => {
	await requireBuiltHarness();

	const shippedFiles = await listFiles(distKpiDir);
	assert.ok(shippedFiles && shippedFiles.length > 0, "dist/kpi shipped no files at all");

	assert.deepEqual(
		shippedFiles.filter((path) => secretShapedPath.test(path)),
		[],
		"secret-shaped paths must never ship with the harness",
	);

	for (const { label, pattern } of forbiddenShippedPaths) {
		assert.deepEqual(
			shippedFiles.filter((path) => pattern.test(path)),
			[],
			`${label} must not ship inside dist/kpi`,
		);
	}

	for (const canary of [
		"themes/.env",
		"extensions/.env.local",
		"skills/id_rsa",
		"prompts/.npmrc",
		"graphs/api-token.txt",
		"templates/service-account.pem",
		"kstack/overlay/credentials.json",
		"schemas/private.key",
	]) {
		assert.ok(secretShapedPath.test(canary), `${canary} must be treated as secret-shaped`);
	}
});

type Theme = {
	name: string;
	colors: Record<string, string>;
};

async function readTheme(name: string): Promise<Theme> {
	return readJson<Theme>(`packages/coding-agent/src/kpi/themes/${name}.json`);
}

test("themes expose required semantic colors", async () => {
	for (const name of ["loop-amber", "protocol-blue"]) {
		const theme = await readTheme(name);
		for (const color of ["accent", "success", "error", "warning"]) {
			assert.ok(theme.colors[color], `${name} must define ${color}`);
		}
	}
});

test("themes use the required protocol accents", async () => {
	const amber = await readTheme("loop-amber");
	const blue = await readTheme("protocol-blue");

	assert.equal(amber.name, "loop-amber");
	assert.equal(amber.colors.accent, "#ff6a1a");
	assert.equal(amber.colors.borderAccent, "#ff6a1a");
	assert.equal(blue.name, "protocol-blue");
	assert.equal(blue.colors.accent, "#3da9fc");
	assert.equal(blue.colors.borderAccent, "#3da9fc");
});

test("APPEND_SYSTEM is additive and concise-output is progressive", async () => {
	const appendSystem = await readFile(
		new URL("packages/coding-agent/src/kpi/templates/APPEND_SYSTEM.md", repoRoot),
		"utf8",
	);
	const skill = await readFile(
		new URL("packages/coding-agent/src/kpi/skills/concise-output/SKILL.md", repoRoot),
		"utf8",
	);

	assert.match(appendSystem, /Keep user-visible answers short/);
	assert.doesNotMatch(appendSystem, /\breplac\w*\b[^\n]*\bsystem prompt\b/i);
	assert.match(skill, /^description: Use whenever writing to the user\.$/m);
});

test("templates do not contain SYSTEM.md", async () => {
	await assert.rejects(readFile(new URL("packages/coding-agent/src/kpi/templates/SYSTEM.md", repoRoot), "utf8"), {
		code: "ENOENT",
	});
});

/**
 * Structural views of the built harness. The proof below loads `dist/` through a
 * runtime-computed specifier so it exercises the artifact a K-π user runs, which
 * means the module graph carries no compile-time types of its own here.
 */
type InlineExtensionFactory = { name?: string; factory: unknown; hidden?: boolean };
type LoadedExtension = { path: string; commands: Map<string, unknown> };
type LoadedDiagnostic = { type: string; message: string; path?: string };
type DiscoveredResourcePath = { path: string; extensionPath: string };
type ExtensionResourcePath = {
	path: string;
	metadata: { source: string; scope: "temporary"; origin: "top-level" };
};

interface BuiltResourceLoader {
	reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
	getExtensions(): {
		extensions: LoadedExtension[];
		errors: Array<{ path: string; error: string }>;
		runtime: unknown;
	};
	getSkills(): { skills: Array<{ name: string; filePath: string }>; diagnostics: LoadedDiagnostic[] };
	getPrompts(): { prompts: Array<{ name: string }>; diagnostics: LoadedDiagnostic[] };
	getThemes(): { themes: Array<{ name: string }>; diagnostics: LoadedDiagnostic[] };
	extendResources(paths: {
		skillPaths: ExtensionResourcePath[];
		promptPaths: ExtensionResourcePath[];
		themePaths: ExtensionResourcePath[];
	}): void;
}

interface BuiltExtensionRunner {
	emitResourcesDiscover(
		cwd: string,
		reason: "startup" | "reload",
	): Promise<{
		skillPaths: DiscoveredResourcePath[];
		promptPaths: DiscoveredResourcePath[];
		themePaths: DiscoveredResourcePath[];
	}>;
}

/**
 * Dynamic import is required here, not a convenience: a static import of `dist/`
 * would bind this proof to the type-checked source tree, and `dist/**` is excluded
 * from the program on purpose. The specifier is resolved against the build output so
 * the proof runs the artifact a K-π user runs, and so a missing build fails loudly
 * instead of silently proving the source tree.
 */
async function importBuilt<T>(relativePath: string): Promise<T> {
	return (await import(new URL(relativePath, distRoot).href)) as T;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

describe("architecture proof isolation", { concurrency: false }, () => {
	test("the built harness serves the K-π built-in and its resources to an untrusted project", async () => {
		await requireBuiltHarness();

		const previousPackageDir = process.env.PI_PACKAGE_DIR;
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const sandbox = await mkdtemp(join(tmpdir(), "kpi-architecture-proof-"));

		try {
			const packageDir = join(sandbox, "harness");
			const cwd = join(sandbox, "project");
			const agentDir = join(sandbox, "agent");
			await mkdir(packageDir);
			await mkdir(cwd);
			await mkdir(agentDir);
			// Only dist/ is staged, so the harness resolves its resources from build output
			// instead of silently falling back to the source tree it was compiled from.
			await symlink(distDir, join(packageDir, "dist"), "dir");

			process.env.PI_PACKAGE_DIR = packageDir;
			// An empty HOME keeps machine-global skills, prompts and themes out of the proof.
			process.env.HOME = sandbox;
			process.env.USERPROFILE = sandbox;

			const shippedResources = join(packageDir, "dist", "kpi");
			const { getKpiResourceDir } = await importBuilt<{ getKpiResourceDir: () => string }>("config.js");
			assert.equal(
				getKpiResourceDir(),
				shippedResources,
				"the built harness must serve K-π resources out of dist/kpi",
			);

			const { builtInExtensions } = await importBuilt<{ builtInExtensions: InlineExtensionFactory[] }>(
				"extensions/index.js",
			);
			const { DefaultResourceLoader } = await importBuilt<{
				DefaultResourceLoader: new (options: {
					cwd: string;
					agentDir: string;
					extensionFactories: InlineExtensionFactory[];
				}) => BuiltResourceLoader;
			}>("core/resource-loader.js");
			const { ExtensionRunner } = await importBuilt<{
				ExtensionRunner: new (extensions: LoadedExtension[], runtime: unknown, cwd: string) => BuiltExtensionRunner;
			}>("core/extensions/runner.js");

			let trustDecisions = 0;
			const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: builtInExtensions });
			await loader.reload({
				resolveProjectTrust: async () => {
					trustDecisions += 1;
					return false;
				},
			});
			assert.equal(trustDecisions, 1, "the proof must pass through the untrusted-project gate");

			const { extensions, errors, runtime } = loader.getExtensions();
			assert.deepEqual(errors, [], "the built-in extension set must load without errors or conflicts");
			assert.deepEqual(
				extensions.filter((extension) => !extension.path.startsWith("<inline:")).map((extension) => extension.path),
				[],
				"K-π must reach an untrusted project without an installed package",
			);

			const kpi = extensions.find((extension) => extension.path === "<inline:k-pi>");
			assert.ok(
				kpi,
				`the K-π built-in is not loaded; got ${extensions.map((extension) => extension.path).join(", ") || "nothing"}`,
			);
			for (const command of ["kpi", "accounts", "k-mode", "setup-kstack"]) {
				assert.ok(kpi.commands.has(command), `/${command} is not registered by the K-π built-in`);
			}

			const runner = new ExtensionRunner(extensions, runtime, cwd);
			const discovered = await runner.emitResourcesDiscover(cwd, "startup");

			for (const [kind, entries] of [
				["skill", discovered.skillPaths],
				["prompt", discovered.promptPaths],
				["theme", discovered.themePaths],
			] as const) {
				assert.ok(entries.length > 0, `the K-π built-in discovered no ${kind} paths`);
				for (const entry of entries) {
					assert.equal(entry.extensionPath, "<inline:k-pi>", `${entry.path} did not come from the K-π built-in`);
					assert.ok(
						entry.path.startsWith(`${shippedResources}${sep}`),
						`${entry.path} is not served out of the built resource tree`,
					);
				}
			}

			const asExtensionPaths = (entries: DiscoveredResourcePath[]): ExtensionResourcePath[] =>
				entries.map((entry) => ({
					path: entry.path,
					metadata: {
						source: `extension:${entry.extensionPath.replace(/[<>]/g, "")}`,
						scope: "temporary",
						origin: "top-level",
					},
				}));
			loader.extendResources({
				skillPaths: asExtensionPaths(discovered.skillPaths),
				promptPaths: asExtensionPaths(discovered.promptPaths),
				themePaths: asExtensionPaths(discovered.themePaths),
			});

			const skills = loader.getSkills();
			const prompts = loader.getPrompts();
			const themes = loader.getThemes();

			for (const [kind, diagnostics] of [
				["skill", skills.diagnostics],
				["prompt", prompts.diagnostics],
				["theme", themes.diagnostics],
			] as const) {
				assert.deepEqual(
					diagnostics.map(({ type, message, path }) => `${type}: ${message} (${path ?? "no path"})`),
					[],
					`the shipped K-π ${kind} tree must load without diagnostics`,
				);
			}

			const skillNames = new Set(skills.skills.map((skill) => skill.name));
			for (const name of [
				"concise-output",
				"context-pack",
				"conventional-commit",
				"isolated-review",
				"kg-claim",
				"minimalist",
				"quality-gates",
				"spec-first",
				"tdd-cycle",
			]) {
				assert.ok(skillNames.has(name), `the ${name} skill never reached the loop`);
			}
			const generatedSkills = join(shippedResources, "kstack", "generated", "skills");
			assert.ok(
				skills.skills.some((skill) => skill.filePath.startsWith(`${generatedSkills}${sep}`)),
				"K-stack generated skills never reached the loop",
			);

			const promptNames = new Set(prompts.prompts.map((prompt) => prompt.name));
			for (const name of ["implement", "plan", "review", "ship", "specify", "verify"]) {
				assert.ok(promptNames.has(name), `the ${name} prompt never reached the loop`);
			}

			const themeNames = new Set(themes.themes.map((theme) => theme.name));
			for (const name of ["loop-amber", "protocol-blue"]) {
				assert.ok(themeNames.has(name), `the ${name} theme never reached the loop`);
			}
		} finally {
			restoreEnv("PI_PACKAGE_DIR", previousPackageDir);
			restoreEnv("HOME", previousHome);
			restoreEnv("USERPROFILE", previousUserProfile);
			await rm(sandbox, { recursive: true, force: true });
		}
	});
});
