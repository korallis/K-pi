#!/usr/bin/env node

/**
 * Build the `@korallis/k-pi` publish payload from the built harness.
 *
 * The workspace package keeps its upstream name (`@earendil-works/pi-coding-agent`)
 * purely for merge hygiene and is never published. What K-π ships is derived
 * from it here: the self-contained CLI bundle (`dist/bundle`), the runtime
 * resources the bundle resolves relative to its `package.json`
 * (`getPackageDir()` in `packages/coding-agent/src/config.ts`), and a manifest
 * named `@korallis/k-pi` whose only dependencies are the bundle's real
 * externals. The unbundled library build (`dist/*.js`, `.d.ts`, `.map`) is
 * left out: it imports the workspace packages by name and would resolve to
 * upstream Pi from the registry.
 *
 * After packing, the tarball is installed under a throwaway prefix and
 * `kpi --version` must print the packed version, so a broken payload fails
 * here rather than on the registry.
 *
 * Usage: node scripts/pack-kpi.mjs [--out <dir>]      (default: release/)
 * Writes <out>/korallis-k-pi-<version>.tgz and <out>/pack-meta.json.
 * Exit codes: 0 packed and verified, 1 otherwise.
 *
 * This script never publishes. `.github/workflows/release.yml` publishes the
 * tarball with npm trusted publishing (OIDC) on a tag push.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED_NAME = "@korallis/k-pi";
const REPOSITORY_URL = "git+https://github.com/korallis/K-pi.git";

/** Packages the bundle still imports at runtime (see scripts/build-coding-agent-bundle.mjs). */
const RUNTIME_DEPENDENCIES = ["@silvia-odwyer/photon-node", "jiti"];
/** Native accelerator loaded through createRequire; the caller falls back when absent. */
const OPTIONAL_DEPENDENCIES = ["@mariozechner/clipboard"];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distDir = join(packageDir, "dist");

/**
 * Everything the payload carries, relative to `packages/coding-agent` (or the
 * repository root for the licence files). Directories are copied whole; the
 * `dist/kpi` entries mirror `copy-kpi-assets` in the package manifest so the
 * payload cannot drift from what the build declares as runtime resources.
 */
const PAYLOAD = [
	{ from: "dist/bundle" },
	{ from: "dist/modes/interactive/theme", filter: (path) => path.endsWith(".json") },
	{ from: "dist/modes/interactive/assets" },
	{ from: "dist/core/export-html/template.html" },
	{ from: "dist/core/export-html/template.css" },
	{ from: "dist/core/export-html/template.js" },
	{ from: "dist/core/export-html/vendor" },
	{ from: "dist/kpi/graphs" },
	{ from: "dist/kpi/prompts" },
	{ from: "dist/kpi/schemas" },
	{ from: "dist/kpi/skills" },
	{ from: "dist/kpi/templates" },
	{ from: "dist/kpi/themes" },
	{ from: "dist/kpi/kstack/generated" },
	{ from: "dist/kpi/kstack/NOTICE" },
	{ from: "dist/kpi/kstack/UPSTREAM.md" },
	{ from: "dist/kpi/kstack/provenance.json" },
	{ from: "dist/kpi/kstack/model-ladder.md" },
	{ from: "docs" },
	{ from: "examples", filter: (path) => !/(^|\/)node_modules(\/|$)/.test(path) },
	{ from: "README.md" },
	{ from: "CHANGELOG.md" },
	{ from: "LICENSE", root: repoRoot },
	{ from: "NOTICE", root: repoRoot },
];

/** Paths that must never ship, checked against the staged tree. */
const FORBIDDEN_IN_PAYLOAD =
	/(^|\/)(fixtures|test|tests|__tests__|node_modules|accounts\.secrets|auth\.json|\.env)(\/|$)|\.(pem|key|rej)$/i;

function fail(message, detail) {
	const error = new Error(message);
	error.detail = detail;
	throw error;
}

function parseArgs(argv) {
	let out = join(repoRoot, "release");
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") {
			const value = argv[++i];
			if (!value) fail("--out requires a directory");
			out = resolve(value);
		} else {
			fail(`unknown argument ${argv[i]}`);
		}
	}
	return { out };
}

function listFiles(root) {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(relative(root, path).replaceAll("\\", "/"));
		}
	};
	walk(root);
	return files.sort();
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) fail(`${command} ${args.join(" ")} could not start`, { error: String(result.error) });
	return result;
}

function pick(source, names, label) {
	const picked = {};
	for (const name of names) {
		const range = source?.[name];
		if (!range) fail(`${label} ${name} is missing from packages/coding-agent/package.json`, { source });
		picked[name] = range;
	}
	return picked;
}

function stagePayload(staging) {
	for (const item of PAYLOAD) {
		const root = item.root ?? packageDir;
		const source = join(root, item.from);
		if (!existsSync(source)) fail(`payload input missing: ${relative(repoRoot, source)}`);
		const target = join(staging, item.from);
		mkdirSync(dirname(target), { recursive: true });
		if (statSync(source).isDirectory()) {
			cpSync(source, target, {
				recursive: true,
				filter: (path) => !item.filter || statSync(path).isDirectory() || item.filter(relative(source, path)),
			});
		} else {
			cpSync(source, target);
		}
	}

	const staged = listFiles(staging);
	const forbidden = staged.filter((path) => FORBIDDEN_IN_PAYLOAD.test(path));
	if (forbidden.length > 0) fail("forbidden paths in payload", { forbidden: forbidden.slice(0, 20) });
	return staged;
}

function writeManifest(staging, source) {
	if (!source.version) fail("packages/coding-agent/package.json has no version");
	const manifest = {
		name: PUBLISHED_NAME,
		version: source.version,
		description: source.description,
		license: source.license,
		type: "module",
		piConfig: source.piConfig,
		bin: source.bin,
		files: ["dist", "docs", "examples", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"],
		dependencies: pick(source.dependencies, RUNTIME_DEPENDENCIES, "runtime dependency"),
		optionalDependencies: pick(source.optionalDependencies, OPTIONAL_DEPENDENCIES, "optional dependency"),
		engines: source.engines,
		keywords: source.keywords,
		repository: { type: "git", url: REPOSITORY_URL, directory: "packages/coding-agent" },
		homepage: "https://github.com/korallis/K-pi#readme",
		bugs: { url: "https://github.com/korallis/K-pi/issues" },
		publishConfig: { access: "public" },
	};
	for (const bin of Object.values(manifest.bin ?? {})) {
		if (!existsSync(join(staging, bin))) fail(`bin target ${bin} is not in the payload`);
	}
	writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

function pack(staging, out) {
	mkdirSync(out, { recursive: true });
	const result = run(npmCommand(), ["pack", "--json", "--pack-destination", out], { cwd: staging });
	if (result.status !== 0) fail("npm pack failed", { stdout: result.stdout, stderr: result.stderr });
	const [entry] = JSON.parse(result.stdout);
	if (!entry?.filename) fail("npm pack returned no tarball", { stdout: result.stdout });
	return { tarball: join(out, entry.filename), files: entry.entryCount, bytes: entry.size };
}

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Install the tarball under a throwaway prefix, exactly as `npm install -g`
 * would, then run the installed `kpi` with a clean HOME.
 */
function assertInstalls(tarball, manifest) {
	const prefix = mkdtempSync(join(tmpdir(), "kpi-pack-prefix-"));
	const home = mkdtempSync(join(tmpdir(), "kpi-pack-home-"));
	const agentDir = mkdtempSync(join(tmpdir(), "kpi-pack-agent-"));
	try {
		// --prefer-offline: the persistent CI runner's cache serves the three
		// runtime dependencies, so a registry hiccup cannot fail the required gate;
		// a cold cache still fetches them.
		const install = run(
			npmCommand(),
			[
				"install",
				"--global",
				"--prefix",
				prefix,
				"--prefer-offline",
				"--no-audit",
				"--fund=false",
				"--loglevel=error",
				tarball,
			],
			{ cwd: home },
		);
		if (install.status !== 0) fail("tarball does not install", { stdout: install.stdout, stderr: install.stderr });

		const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
		for (const bin of Object.keys(manifest.bin)) {
			const path = join(binDir, bin);
			if (!existsSync(path)) fail(`installed bin ${bin} missing`, { path });
			const target = realpathSync(path);
			if (!target.endsWith(join("dist", "bundle", "cli.js"))) fail(`bin ${bin} points outside the bundle`, { target });
		}
		const installedRoot = dirname(dirname(dirname(realpathSync(join(binDir, "kpi")))));
		for (const required of ["dist/kpi/graphs", "dist/kpi/skills", "dist/modes/interactive/theme", "docs"]) {
			if (!existsSync(join(installedRoot, required))) fail(`installed package lacks ${required}`, { installedRoot });
		}

		const env = { ...process.env, HOME: home, KPI_CODING_AGENT_DIR: agentDir, CI: "1", PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" };
		const kpi = join(binDir, "kpi");
		const version = run(kpi, ["--version"], { cwd: home, env, timeout: 20_000 });
		const text = `${version.stdout}\n${version.stderr}`.trim();
		if (version.status !== 0 || text.split("\n")[0]?.trim() !== manifest.version) {
			fail(`installed kpi --version must print ${manifest.version}`, { status: version.status, text });
		}

		// Start RPC mode against an empty scratch project with no credentials. The
		// built-in K-π extension announces itself through an extension_ui_request,
		// which only happens when the resources under the installed dist/kpi
		// resolve from the payload's own package.json.
		const scratch = mkdtempSync(join(tmpdir(), "kpi-pack-scratch-"));
		try {
			writeFileSync(join(scratch, "README.md"), "# scratch\n");
			const rpc = run(kpi, ["--mode", "rpc"], { cwd: scratch, env, input: "\n", timeout: 8_000 });
			const combined = `${rpc.stdout}\n${rpc.stderr}`;
			if (!/extension_ui_request/.test(combined)) {
				fail("installed kpi did not load the built-in K-π extension in rpc mode", { excerpt: combined.slice(0, 800) });
			}
			if (/Failed to load skill|Skill warning|trust this project/i.test(combined)) {
				fail("installed kpi reported a resource diagnostic", { excerpt: combined.slice(0, 800) });
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		return installedRoot;
	} finally {
		rmSync(prefix, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function main() {
	const { out } = parseArgs(process.argv.slice(2));
	if (!existsSync(join(distDir, "bundle", "cli.js"))) {
		fail("packages/coding-agent/dist/bundle/cli.js is missing: run `npm run build:offline` first");
	}
	const source = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const staging = mkdtempSync(join(tmpdir(), "kpi-pack-staging-"));
	try {
		const staged = stagePayload(staging);
		const manifest = writeManifest(staging, source);
		const packed = pack(staging, out);
		assertInstalls(packed.tarball, manifest);
		const meta = {
			name: manifest.name,
			version: manifest.version,
			tarball: packed.tarball,
			files: packed.files,
			bytes: packed.bytes,
			staged: staged.length,
		};
		writeFileSync(join(out, "pack-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
		process.stdout.write(
			`pack-kpi: ${meta.name}@${meta.version} -> ${relative(process.cwd(), meta.tarball) || meta.tarball} (${meta.files} files, ${(meta.bytes / (1024 * 1024)).toFixed(1)} MiB, installs and runs)\n`,
		);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	process.stderr.write(`pack-kpi: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
	if (error && typeof error === "object" && "detail" in error && error.detail !== undefined) {
		process.stderr.write(`${JSON.stringify(error.detail, null, 2)}\n`);
	}
	process.exitCode = 1;
}
