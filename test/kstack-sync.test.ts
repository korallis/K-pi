import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { KStackTransformError } from "../packages/coding-agent/src/kpi/kstack/overlay/transforms.ts";
import {
	applyPatches,
	PatchError,
	parseCanonicalPath,
	patchTargets,
} from "../packages/coding-agent/src/kpi/kstack/scripts/patches.ts";
import {
	assertLicense,
	assertModelsJson,
	assertRecordsAgree,
	computeTransformVersion,
	digestBytes,
	type Provenance,
	ProvenanceError,
	parseProvenance,
	parseUpstreamDocument,
	readProvenance,
	resolvePatchSet,
} from "../packages/coding-agent/src/kpi/kstack/scripts/provenance.ts";
import {
	exitCodeFor,
	inspectLocal,
	runStatus,
	summarize,
} from "../packages/coding-agent/src/kpi/kstack/scripts/status.ts";
import {
	buildCandidate,
	inspectTransaction,
	PROMOTION_MARKER,
	parseOptions,
	publishArtifacts,
	readOverlayConfig,
	type paths as realPaths,
	recoverIncompleteTransaction,
	renderUpstreamDocument,
	runSync,
	stagePinnedSubtree,
	textOf,
} from "../packages/coding-agent/src/kpi/kstack/scripts/sync-kstack.ts";
import {
	computeTreeOid,
	confinePath,
	digestTree,
	findPatchDebris,
	isTextFile,
	readTree,
	TreeError,
	writeTree,
} from "../packages/coding-agent/src/kpi/kstack/scripts/tree.ts";

const execFile = promisify(execFileCallback);
const REPO = new URL("..", import.meta.url).pathname;
const FIXTURES = join(REPO, "fixtures");
const REAL_KSTACK = join(REPO, "packages", "coding-agent", "src", "kpi", "kstack");

// ---------------------------------------------------------------------------
// A complete synthetic layout, so the whole pipeline runs offline on a fixture
// ---------------------------------------------------------------------------

interface Layout {
	root: string;
	generated: string;
	upstream: string;
	overlay: string;
	overlaySource: string;
	patches: string;
	upstreamDocument: string;
	provenance: string;
	/** The fixture's real pstack tree id, recorded beside it. */
	treeOid: string;
	cleanup: () => Promise<void>;
}

interface LayoutOptions {
	fixture?: string;
	patchFixture?: string;
	/** Overrides merged into the copied overlay config.json. */
	config?: Record<string, unknown>;
	/** Mutates provenance after it is computed, to build malformed cases. */
	provenance?: (value: Provenance) => Provenance;
	/** Written into UPSTREAM.md instead of the agreeing table. */
	upstreamDocument?: string;
}

/**
 * Copies the real overlay so every transform, sentinel and forbidden string is
 * the production one, and scopes only `requiredSkills` to the fixture: the rules
 * under test are real, the required set is a property of which tree is being
 * built.
 */
async function makeLayout(options: LayoutOptions = {}): Promise<Layout> {
	const fixture = options.fixture ?? "kstack-upstream-offline";
	const root = await mkdtemp(join(tmpdir(), "kstack-layout-"));
	const overlay = join(root, "overlay");
	await mkdir(overlay, { recursive: true });
	for (const name of ["transforms.ts", "rename-map.json", "forbidden.txt"]) {
		await cp(join(REAL_KSTACK, "overlay", name), join(overlay, name));
	}
	const config = JSON.parse(await readFile(join(REAL_KSTACK, "overlay", "config.json"), "utf8")) as Record<
		string,
		unknown
	>;
	await writeFile(
		join(overlay, "config.json"),
		`${JSON.stringify({ ...config, requiredSkills: ["fixture-skill"], ...options.config }, null, "\t")}\n`,
	);
	await mkdir(join(overlay, "source"), { recursive: true });

	const upstream = join(root, "upstream");
	await cp(join(FIXTURES, fixture, "pstack"), upstream, { recursive: true });
	const treeOid = (await readFile(join(FIXTURES, fixture, "tree-oid.txt"), "utf8")).trim();

	const patches = join(root, "patches");
	if (options.patchFixture === undefined) {
		await mkdir(patches, { recursive: true });
	} else {
		await cp(join(FIXTURES, options.patchFixture), patches, { recursive: true });
	}

	const patchRecords = (await readdir(patches))
		.filter((name) => name.endsWith(".patch"))
		.sort()
		.map((name) => ({ name, path: join(patches, name) }));
	const patchDigests = [];
	for (const entry of patchRecords) {
		patchDigests.push({ name: entry.name, sha256: digestBytes(await readFile(entry.path)) });
	}

	const licenseBytes = await readFile(join(upstream, "LICENSE"));
	const holder = /Copyright \(c\) \d{4} (.+)/u.exec(licenseBytes.toString("utf8"))?.[1]?.trim() ?? "unknown";
	let provenance: Provenance = {
		origin: {
			repository: "https://github.com/cursor/plugins.git",
			path: "pstack/",
			commit: "b9ddc83c32972210b8a94d389130713e8eed346e",
			treeOid,
		},
		transformVersion: await computeTransformVersion(overlay),
		patches: patchDigests,
		license: { path: "LICENSE", spdx: "MIT", holder, sha256: digestBytes(licenseBytes) },
		overlayVersion: 1,
	};
	provenance = options.provenance === undefined ? provenance : options.provenance(provenance);
	await writeFile(join(root, "provenance.json"), `${JSON.stringify(provenance, null, "\t")}\n`);

	const document =
		options.upstreamDocument ??
		[
			"# K-stack upstream",
			"",
			`| Source | ${provenance.origin.repository} |`,
			"|---|---|",
			`| Path | ${provenance.origin.path} |`,
			`| Commit | ${provenance.origin.commit} |`,
			`| pstack tree | ${provenance.origin.treeOid} |`,
			"| Upstream version | fixture |",
			`| K-stack overlay | ${provenance.overlayVersion} |`,
			"",
		].join("\n");
	await writeFile(join(root, "UPSTREAM.md"), document);

	return {
		root,
		generated: join(root, "generated"),
		upstream,
		overlay,
		overlaySource: join(overlay, "source"),
		patches,
		upstreamDocument: join(root, "UPSTREAM.md"),
		provenance: join(root, "provenance.json"),
		treeOid,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

function optionsFor(layout: Layout, extra: Partial<Parameters<typeof runSync>[0]> = {}) {
	return {
		check: false,
		fetch: false,
		...extra,
		layout: {
			root: layout.root,
			generated: layout.generated,
			upstream: layout.upstream,
			overlay: layout.overlay,
			overlaySource: layout.overlaySource,
			patches: layout.patches,
			upstreamDocument: layout.upstreamDocument,
			provenance: layout.provenance,
		},
	};
}

/** Live bytes, modes and mtimes, for proving a failure changed nothing. */
async function snapshot(directory: string): Promise<{ digest: string; mtimes: Map<string, number> }> {
	const tree = await readTree(directory);
	const mtimes = new Map<string, number>();
	for (const path of tree.keys()) {
		mtimes.set(path, (await stat(join(directory, path))).mtimeMs);
	}
	return { digest: digestTree(tree), mtimes };
}

// ---------------------------------------------------------------------------
// Provenance: strict parsing and the two-record cross-check
// ---------------------------------------------------------------------------

test("provenance records origin, commit, tree, transform version, patches and licence", async () => {
	const provenance = await readProvenance(join(REAL_KSTACK, "provenance.json"));
	assert.equal(provenance.origin.repository, "https://github.com/cursor/plugins.git");
	assert.equal(provenance.origin.path, "pstack/");
	assert.match(provenance.origin.commit, /^[0-9a-f]{40}$/u);
	assert.match(provenance.origin.treeOid, /^[0-9a-f]{40}$/u);
	assert.match(provenance.transformVersion, /^[0-9a-f]{64}$/u);
	assert.equal(provenance.license.spdx, "MIT");
	assert.match(provenance.license.sha256, /^[0-9a-f]{64}$/u);
	assert.ok(provenance.license.holder.length > 0);
	assert.ok(Array.isArray(provenance.patches));

	// The committed record describes the committed bytes.
	assert.equal(await computeTreeOid(join(REAL_KSTACK, "upstream")), provenance.origin.treeOid);
	assert.equal(await computeTransformVersion(join(REAL_KSTACK, "overlay")), provenance.transformVersion);
	assertLicense(await readTree(join(REAL_KSTACK, "generated")), provenance);
});

test("UPSTREAM.md carries the documented pstack tree row and agrees with provenance", async () => {
	const table = parseUpstreamDocument(await readFile(join(REAL_KSTACK, "UPSTREAM.md"), "utf8"));
	assert.equal(table.path, "pstack/");
	assert.match(table.commit ?? "", /^[0-9a-f]{40}$/u);
	assert.match(table.treeOid ?? "", /^[0-9a-f]{40}$/u);
	const provenance = await readProvenance(join(REAL_KSTACK, "provenance.json"));
	assert.doesNotThrow(() => assertRecordsAgree(provenance, table));
});

test("a malformed provenance record is refused field by field", () => {
	const base = {
		origin: {
			repository: "https://example.invalid/repo.git",
			path: "pstack/",
			commit: "b9ddc83c32972210b8a94d389130713e8eed346e",
			treeOid: "950b90234c17babd00c43e32b19ae50abb4720f5",
		},
		transformVersion: "a".repeat(64),
		patches: [],
		license: { path: "LICENSE", spdx: "MIT", holder: "Someone", sha256: "b".repeat(64) },
		overlayVersion: 1,
	};
	assert.doesNotThrow(() => parseProvenance(JSON.stringify(base)));

	const cases: { name: string; mutate: (value: Record<string, any>) => void; pattern: RegExp }[] = [
		{
			name: "short commit",
			mutate: (v) => {
				v.origin.commit = "b9ddc83";
			},
			pattern: /40-character hex/u,
		},
		{
			name: "missing tree",
			mutate: (v) => {
				delete v.origin.treeOid;
			},
			pattern: /origin\.treeOid/u,
		},
		{
			name: "non-hex tree",
			mutate: (v) => {
				v.origin.treeOid = "z".repeat(40);
			},
			pattern: /40-character hex/u,
		},
		{
			name: "no origin",
			mutate: (v) => {
				delete v.origin;
			},
			pattern: /origin is missing/u,
		},
		{
			name: "no licence",
			mutate: (v) => {
				delete v.license;
			},
			pattern: /license is missing/u,
		},
		{
			name: "licence digest not a sha",
			mutate: (v) => {
				v.license.sha256 = "nope";
			},
			pattern: /sha256 digest/u,
		},
		{
			name: "transform version not a sha",
			mutate: (v) => {
				v.transformVersion = "1";
			},
			pattern: /sha256 digest/u,
		},
		{
			name: "patches not an array",
			mutate: (v) => {
				v.patches = {};
			},
			pattern: /patches must be an array/u,
		},
		{
			name: "patch with a path",
			mutate: (v) => {
				v.patches = [{ name: "sub/0001.patch", sha256: "c".repeat(64) }];
			},
			pattern: /bare \*\.patch file/u,
		},
		{
			name: "patch listed twice",
			mutate: (v) => {
				v.patches = [
					{ name: "0001.patch", sha256: "c".repeat(64) },
					{ name: "0001.patch", sha256: "d".repeat(64) },
				];
			},
			pattern: /same patch twice/u,
		},
		{
			name: "path is not a subtree",
			mutate: (v) => {
				v.origin.path = "pstack";
			},
			pattern: /ending in/u,
		},
		{
			name: "overlay version not an integer",
			mutate: (v) => {
				v.overlayVersion = "1";
			},
			pattern: /integer/u,
		},
	];
	for (const scenario of cases) {
		const value = JSON.parse(JSON.stringify(base)) as Record<string, any>;
		scenario.mutate(value);
		assert.throws(() => parseProvenance(JSON.stringify(value)), scenario.pattern, scenario.name);
	}
	assert.throws(() => parseProvenance("{not json"), /not valid JSON/u);
	assert.throws(() => parseProvenance("[]"), /not an object/u);
});

test("the human and machine records disagreeing is a refusal", async () => {
	const layout = await makeLayout({
		upstreamDocument: [
			"# K-stack upstream",
			"",
			"| Source | https://github.com/cursor/plugins.git |",
			"|---|---|",
			"| Path | pstack/ |",
			"| Commit | 0000000000000000000000000000000000000000 |",
			"| pstack tree | 1111111111111111111111111111111111111111 |",
			"| K-stack overlay | 1 |",
			"",
		].join("\n"),
	});
	try {
		await assert.rejects(runSync(optionsFor(layout, { check: true })), (error: unknown) => {
			assert.ok(error instanceof ProvenanceError);
			assert.match(error.message, /disagree/u);
			assert.match(error.message, /commit:/u);
			assert.match(error.message, /pstack tree:/u);
			return true;
		});
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined, "nothing was generated");
	} finally {
		await layout.cleanup();
	}
});

test("a missing provenance file is a refusal, not a default", async () => {
	const layout = await makeLayout();
	try {
		await rm(layout.provenance);
		await assert.rejects(runSync(optionsFor(layout, { check: true })), /provenance\.json is missing/u);
	} finally {
		await layout.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Pinned staging: byte and mode fidelity, verified tree id
// ---------------------------------------------------------------------------

test("a candidate is built entirely outside the repository", async () => {
	const layout = await makeLayout();
	const work = await mkdtemp(join(tmpdir(), "kstack-candidate-"));
	try {
		const candidate = await buildCandidate(optionsFor(layout), work);
		assert.ok(candidate.tree.size > 0);
		assert.equal(candidate.sourceTreeOid, layout.treeOid);
		assert.match(candidate.digest, /^[0-9a-f]{64}$/u);
		// This fixture has nothing to drop; the real tree and the residue fixture
		// are where dropping is proven.
		assert.deepEqual(candidate.dropped, []);
		assert.deepEqual([...candidate.tree.keys()].sort(), [
			"LICENSE",
			"assets/pixel.png",
			"skills/fixture-skill/SKILL.md",
			"skills/fixture-skill/scripts/run.sh",
		]);
		// Building a candidate creates nothing in the live layout.
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined);
		assert.deepEqual(
			(await readdir(layout.root)).filter((name) => name.startsWith("generated")),
			[],
		);
		// And the candidate really is on disk under the work directory.
		assert.equal(digestTree(await readTree(join(work, "candidate"))), candidate.digest);
	} finally {
		await rm(work, { recursive: true, force: true });
		await layout.cleanup();
	}
});

test("writing a tree round-trips bytes and modes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kstack-roundtrip-"));
	try {
		const tree = new Map([
			["text.md", { bytes: Buffer.from("# hi\n", "utf8"), executable: false }],
			["bin.dat", { bytes: Buffer.from([0, 1, 2, 0, 255]), executable: false }],
			["run.sh", { bytes: Buffer.from("#!/bin/sh\n", "utf8"), executable: true }],
		]);
		await writeTree(directory, tree);
		const read = await readTree(directory);
		assert.equal(digestTree(read), digestTree(tree));
		assert.equal(read.get("run.sh")?.executable, true);
		assert.equal(read.get("bin.dat")?.bytes.equals(Buffer.from([0, 1, 2, 0, 255])), true);
		assert.equal(isTextFile("bin.dat", read.get("bin.dat")!.bytes), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("staging copies only the pinned subtree into a new empty tree", async () => {
	const layout = await makeLayout();
	const work = await mkdtemp(join(tmpdir(), "kstack-stage-"));
	try {
		const staging = join(work, "staging");
		const tree = await stagePinnedSubtree(layout.upstream, staging);
		assert.deepEqual(digestTree(tree), digestTree(await readTree(staging)));
		assert.equal(await computeTreeOid(staging), layout.treeOid, "the staged tree is the pinned tree");

		// A staging directory that already holds anything is refused: reusing one is
		// how bytes from a previous run survive into a "reproducible" tree.
		await writeFile(join(staging, "leftover.txt"), "stale\n");
		await assert.rejects(stagePinnedSubtree(layout.upstream, staging), /not empty/u);
	} finally {
		await rm(work, { recursive: true, force: true });
		await layout.cleanup();
	}
});

test("modes and binary bytes survive staging and promotion unchanged", async () => {
	const layout = await makeLayout();
	try {
		const report = await runSync(optionsFor(layout));
		assert.equal(report.status, "promoted");

		const generated = await readTree(layout.generated);
		const script = generated.get("skills/fixture-skill/scripts/run.sh");
		assert.ok(script !== undefined, "the script shipped");
		assert.equal(script.executable, true, "the executable bit survived");
		assert.notEqual(
			(await lstat(join(layout.generated, "skills/fixture-skill/scripts/run.sh"))).mode & 0o111,
			0,
			"and the bit is on the file itself, not only in the model",
		);

		const png = generated.get("assets/pixel.png");
		const source = await readTree(layout.upstream);
		assert.ok(png !== undefined, "the binary shipped");
		assert.equal(png.bytes.equals(source.get("assets/pixel.png")!.bytes), true, "byte for byte");
		assert.equal(isTextFile("assets/pixel.png", png.bytes), false, "and it was never treated as text");
		assert.equal(png.bytes.includes(0), true, "a utf8 round trip would have destroyed these bytes");
	} finally {
		await layout.cleanup();
	}
});

test("a pinned subtree whose tree id disagrees with the record is refused", async () => {
	const layout = await makeLayout();
	try {
		// One byte of the pinned bytes changed: the recorded identity no longer holds.
		await writeFile(
			join(layout.upstream, "skills", "fixture-skill", "SKILL.md"),
			"---\nname: fixture-skill\ndescription: edited\n---\n",
		);
		await assert.rejects(runSync(optionsFor(layout)), (error: unknown) => {
			assert.ok(error instanceof ProvenanceError);
			assert.match(error.message, /pinned subtree has tree id [0-9a-f]{40}, provenance records/u);
			return true;
		});
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined);
	} finally {
		await layout.cleanup();
	}
});

test("a symlink or a non-regular file in a pinned tree is refused", async () => {
	const layout = await makeLayout();
	try {
		await symlink(join(layout.upstream, "LICENSE"), join(layout.upstream, "link-to-license"));
		await assert.rejects(readTree(layout.upstream), (error: unknown) => {
			assert.ok(error instanceof TreeError);
			assert.match(error.message, /refusing a symlink in a pinned tree: link-to-license/u);
			return true;
		});
	} finally {
		await layout.cleanup();
	}
});

test("the tree id is mode-sensitive, so a lost execute bit cannot pass as the same tree", async () => {
	const layout = await makeLayout();
	try {
		const before = await computeTreeOid(layout.upstream);
		await chmod(join(layout.upstream, "skills", "fixture-skill", "scripts", "run.sh"), 0o644);
		const after = await computeTreeOid(layout.upstream);
		assert.notEqual(before, after);
		assert.equal(before, layout.treeOid);
	} finally {
		await layout.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Transforms over the fixture, and transform drift
// ---------------------------------------------------------------------------

test("the fixture skill is translated by the real transforms", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		const skill =
			(await readTree(layout.generated)).get("skills/fixture-skill/SKILL.md")?.bytes.toString("utf8") ?? "";
		assert.match(skill, /spawn_background tool/u);
		assert.match(skill, /role per reviewer/u);
		assert.match(skill, /~\/\.kpi\/agent\/kstack\/models\.json/u);
		assert.match(skill, /its own branch/u);
		assert.match(skill, /An upstack helper is an ordinary word/u);
		assert.equal(/claude-fable-5|gpt-5\.6-sol|subagent|worktree|\.cursor\/rules/u.test(skill), false);
	} finally {
		await layout.cleanup();
	}
});

test("editing the overlay without re-syncing makes check fail on transform drift", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");

		const before = await snapshot(layout.generated);
		const forbidden = join(layout.overlay, "forbidden.txt");
		await writeFile(forbidden, `${await readFile(forbidden, "utf8")}\nnewly-forbidden-token\n`);
		await assert.rejects(runSync(optionsFor(layout, { check: true })), (error: unknown) => {
			assert.ok(error instanceof ProvenanceError);
			assert.match(error.message, /the overlay has changed: transformVersion is/u);
			assert.match(error.message, /Re-run kstack:sync/u);
			return true;
		});
		assert.equal((await snapshot(layout.generated)).digest, before.digest, "check wrote nothing");
	} finally {
		await layout.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Patches: ordered, digest-bound, path-confined, all-or-nothing
// ---------------------------------------------------------------------------

test("patch targets are read from every header that names a path", () => {
	const source = [
		"diff --git a/one.md b/one.md",
		"--- a/one.md",
		"+++ b/one.md",
		"@@ -1 +1 @@",
		"-a",
		"+b",
		"diff --git a/two.md b/three.md",
		"similarity index 100%",
		"rename from two.md",
		"rename to three.md",
		"diff --git a/new.md b/new.md",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/new.md",
		"@@ -0,0 +1 @@",
		"+n",
	].join("\n");
	assert.deepEqual(patchTargets(source), ["new.md", "one.md", "three.md", "two.md"]);
	// `/dev/null` is not a target, and a patch that names nothing is not a patch.
	assert.deepEqual(patchTargets("no headers here\n"), []);
});

test("an ordered patch set applies in order and its digests are bound", async () => {
	const layout = await makeLayout({ patchFixture: "kstack-good-patch" });
	try {
		const report = await runSync(optionsFor(layout));
		assert.equal(report.status, "promoted");
		const generated = await readTree(layout.generated);
		assert.equal(generated.get("skills/fixture-skill/references/notes.md")?.bytes.toString("utf8"), "patched note\n");
		assert.equal(generated.get("skills/fixture-skill/references/second.md")?.bytes.toString("utf8"), "second note\n");

		// Editing a patch after it was recorded is a refusal.
		const before = await snapshot(layout.generated);
		const first = join(layout.patches, "0001-applies.patch");
		await writeFile(first, (await readFile(first, "utf8")).replace("patched note", "tampered note"));
		await assert.rejects(
			runSync(optionsFor(layout, { check: true })),
			/has digest [0-9a-f]{64}, provenance records/u,
		);
		assert.equal((await snapshot(layout.generated)).digest, before.digest);
	} finally {
		await layout.cleanup();
	}
});

test("an unrecorded, missing or reordered patch is refused", async () => {
	const layout = await makeLayout({ patchFixture: "kstack-good-patch" });
	try {
		const provenance = await readProvenance(layout.provenance);
		await writeFile(join(layout.patches, "0003-extra.patch"), "diff --git a/x b/x\n");
		await assert.rejects(resolvePatchSet(layout.patches, provenance.patches), /patch set does not match provenance/u);
		await rm(join(layout.patches, "0003-extra.patch"));
		await rm(join(layout.patches, "0002-also-applies.patch"));
		await assert.rejects(resolvePatchSet(layout.patches, provenance.patches), /patch set does not match/u);
	} finally {
		await layout.cleanup();
	}
});

test("a broken patch leaves live bytes untouched and creates no rej or orig", async () => {
	const layout = await makeLayout({ patchFixture: "kstack-good-patch" });
	try {
		// A good tree first, so there are live bytes to protect.
		await runSync(optionsFor(layout));
		const before = await snapshot(layout.generated);

		await assert.rejects(
			runSync(optionsFor(layout, { patches: join(FIXTURES, "kstack-ordered-patch") })),
			(error: unknown) => {
				// The digest check fires first because the patch set changed; point the
				// pipeline at a matching provenance to reach the apply failure itself.
				return error instanceof ProvenanceError || error instanceof PatchError;
			},
		);

		// Now with provenance that records the broken set, so the failure is the apply.
		const ordered = await makeLayout({ patchFixture: "kstack-ordered-patch" });
		try {
			await assert.rejects(runSync(optionsFor(ordered)), (error: unknown) => {
				assert.ok(error instanceof PatchError, `expected a PatchError, got ${String(error)}`);
				assert.equal(error.patch, "0002-does-not-apply.patch");
				assert.match(error.message, /does not apply cleanly/u);
				return true;
			});
			assert.equal(await stat(ordered.generated).catch(() => undefined), undefined, "nothing was promoted");
			assert.deepEqual(await findPatchDebris(ordered.root), [], "no .rej or .orig anywhere");
		} finally {
			await ordered.cleanup();
		}

		const after = await snapshot(layout.generated);
		assert.equal(after.digest, before.digest, "live bytes are unchanged");
		for (const [path, mtime] of before.mtimes) {
			assert.equal(after.mtimes.get(path), mtime, `${path} was not rewritten`);
		}
	} finally {
		await layout.cleanup();
	}
});

test("a patch that escapes the staging tree is refused before git runs", async () => {
	const layout = await makeLayout({ patchFixture: "kstack-unsafe-patch" });
	try {
		await assert.rejects(runSync(optionsFor(layout)), (error: unknown) => {
			assert.ok(error instanceof PatchError, `expected a PatchError, got ${String(error)}`);
			assert.equal(error.patch, "0001-parent-escape.patch");
			// The parser refuses it before confinement is even reached, and says where.
			assert.equal(error.line, 1);
			assert.match(error.message, /traversal or empty segment/u);
			return true;
		});
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined);
		// And nothing was written where the patch pointed.
		assert.equal(await stat(join(layout.root, "escape.txt")).catch(() => undefined), undefined);
	} finally {
		await layout.cleanup();
	}
});

test("absolute paths, rename escapes and symlinked parents are all refused", async () => {
	const staging = await mkdtemp(join(tmpdir(), "kstack-confine-"));
	try {
		await mkdir(join(staging, "inside"), { recursive: true });
		assert.equal(confinePath(staging, "inside/file.md"), join(staging, "inside/file.md"));
		for (const bad of ["../escape.txt", "/etc/passwd", "C:\\Windows\\x", "a/../../b", ""]) {
			assert.throws(() => confinePath(staging, bad), TreeError, `${bad} must be refused`);
		}

		// Each unsafe fixture is refused, naming its own patch.
		for (const name of ["0001-parent-escape.patch", "0002-absolute.patch", "0003-delete-side-escape.patch"]) {
			await assert.rejects(
				applyPatches(staging, join(FIXTURES, "kstack-unsafe-patch"), [name]),
				(error: unknown) => {
					assert.ok(error instanceof PatchError);
					assert.equal(error.patch, name);
					return true;
				},
			);
		}

		// A confined path whose parent is a symlink is still an escape.
		const outside = await mkdtemp(join(tmpdir(), "kstack-outside-"));
		await symlink(outside, join(staging, "linked"));
		await writeFile(
			join(staging, "via-link.patch"),
			"diff --git a/linked/x.md b/linked/x.md\nnew file mode 100644\n--- /dev/null\n+++ b/linked/x.md\n@@ -0,0 +1 @@\n+x\n",
		);
		await assert.rejects(applyPatches(staging, staging, ["via-link.patch"]), /passes through a symlink/u);
		await rm(outside, { recursive: true, force: true });
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
});

test("the applier never offers git an unsafe or partial mode", async () => {
	const source = await readFile(join(REAL_KSTACK, "scripts", "patches.ts"), "utf8");
	// Comments explain why these flags are refused, so the scan is over code only.
	const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
	for (const flag of ["--unsafe-paths", "--reject", "--3way", "-p0", "--exclude"]) {
		assert.equal(code.includes(flag), false, `patches.ts must never pass ${flag}`);
	}
	assert.match(code, /"apply", "--check"/u, "every patch is checked before it is applied");
	// The prohibition is also written down where a future reader will see it.
	assert.match(source, /--unsafe-paths/u, "the comment records why the flag is refused");
});

// ---------------------------------------------------------------------------
// Semantic, licence and models validation before promotion
// ---------------------------------------------------------------------------

test("invalid frontmatter in the pinned tree fails before promotion", async () => {
	const layout = await makeLayout({ config: { requiredSkills: [] } });
	try {
		await mkdir(join(layout.upstream, "skills", "Bad_Name"), { recursive: true });
		await writeFile(
			join(layout.upstream, "skills", "Bad_Name", "SKILL.md"),
			"---\nname: Bad_Name\ndescription: d\n---\n",
		);
		await refreshPin(layout);
		await assert.rejects(runSync(optionsFor(layout)), (error: unknown) => {
			assert.ok(error instanceof KStackTransformError);
			assert.ok(
				error.diagnostics.some((entry) => entry.rule === "skill-name" || entry.rule === "skill-parent"),
				"the identity diagnostic fired",
			);
			return true;
		});
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined);
	} finally {
		await layout.cleanup();
	}
});

test("forbidden residue in the pinned tree fails before promotion", async () => {
	const layout = await makeLayout();
	try {
		await mkdir(join(layout.upstream, "skills", "fixture-skill", "references"), { recursive: true });
		await writeFile(
			join(layout.upstream, "skills", "fixture-skill", "references", "cloud.md"),
			"Wake the Cursor Cloud agent when the run stalls.\n",
		);
		await refreshPin(layout);
		await assert.rejects(runSync(optionsFor(layout)), (error: unknown) => {
			assert.ok(error instanceof KStackTransformError);
			const located = error.diagnostics.find((entry) => entry.rule === "cloud-worker");
			assert.ok(located !== undefined);
			assert.equal(located.path, "skills/fixture-skill/references/cloud.md");
			assert.equal(located.line, 1);
			return true;
		});
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined);
	} finally {
		await layout.cleanup();
	}
});

test("a missing or altered licence fails before promotion", async () => {
	const missing = await makeLayout();
	try {
		await rm(join(missing.upstream, "LICENSE"));
		await refreshPin(missing);
		await assert.rejects(runSync(optionsFor(missing)), /the licence is missing from the generated tree: LICENSE/u);
		assert.equal(await stat(missing.generated).catch(() => undefined), undefined);
	} finally {
		await missing.cleanup();
	}

	const altered = await makeLayout();
	try {
		await writeFile(join(altered.upstream, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Someone Else\n");
		await refreshPin(altered, { keepLicense: true });
		await assert.rejects(runSync(optionsFor(altered)), /LICENSE has digest [0-9a-f]{64}, provenance records/u);
	} finally {
		await altered.cleanup();
	}

	const gutted = await makeLayout();
	try {
		const stripped = "MIT License\n\nCopyright (c) 2026 Fixture Author\n\nAll rights reserved.\n";
		await writeFile(join(gutted.upstream, "LICENSE"), stripped);
		await refreshPin(gutted);
		await assert.rejects(runSync(optionsFor(gutted)), /is missing the clause: Permission is hereby granted/u);
	} finally {
		await gutted.cleanup();
	}

	const unattributed = await makeLayout();
	try {
		const original = await readFile(join(unattributed.upstream, "LICENSE"), "utf8");
		await writeFile(join(unattributed.upstream, "LICENSE"), original.replace("Fixture Author", "Nobody"));
		await refreshPin(unattributed, { keepHolder: true });
		await assert.rejects(runSync(optionsFor(unattributed)), /no longer names Fixture Author/u);
	} finally {
		await unattributed.cleanup();
	}
});

test("a malformed models map fails before promotion", async () => {
	const layout = await makeLayout();
	try {
		await writeFile(join(layout.upstream, "skills", "fixture-skill", "models.json"), "{ not json\n");
		await refreshPin(layout);
		await assert.rejects(runSync(optionsFor(layout)), /models\.json is not parseable JSON/u);
	} finally {
		await layout.cleanup();
	}

	const wrongShape = await makeLayout();
	try {
		await writeFile(
			join(wrongShape.upstream, "skills", "fixture-skill", "models.json"),
			`${JSON.stringify({ version: 2, roles: {} })}\n`,
		);
		await refreshPin(wrongShape);
		await assert.rejects(runSync(optionsFor(wrongShape)), /is not a version 1 K-stack models map/u);
	} finally {
		await wrongShape.cleanup();
	}

	// And a valid one passes.
	assert.doesNotThrow(() =>
		assertModelsJson(
			new Map([
				[
					"skills/x/models.json",
					{ bytes: Buffer.from(JSON.stringify({ version: 1, roles: { fast: "a/b", panel: ["a/b"] } })) },
				],
			]),
		),
	);
	assert.throws(
		() =>
			assertModelsJson(
				new Map([["m/models.json", { bytes: Buffer.from(JSON.stringify({ version: 1, roles: { fast: 7 } })) }]]),
			),
		/has a non-string model/u,
	);
});

/** Recomputes the pin after a fixture's pinned bytes were deliberately edited. */
async function refreshPin(
	layout: Layout,
	options: { keepLicense?: boolean; keepHolder?: boolean } = {},
): Promise<void> {
	const provenance = await readProvenance(layout.provenance);
	const licenseBytes = await readFile(join(layout.upstream, "LICENSE")).catch(() => undefined);
	const treeOid = await computeTreeOid(layout.upstream);
	const updated = {
		...provenance,
		origin: { ...provenance.origin, treeOid },
		license: {
			...provenance.license,
			sha256:
				options.keepLicense === true || licenseBytes === undefined
					? provenance.license.sha256
					: digestBytes(licenseBytes),
			holder: provenance.license.holder,
		},
	};
	void options.keepHolder;
	await writeFile(layout.provenance, `${JSON.stringify(updated, null, "\t")}\n`);
	const document = await readFile(layout.upstreamDocument, "utf8");
	await writeFile(
		layout.upstreamDocument,
		document.replace(/\| pstack tree \| [0-9a-f]{40} \|/u, `| pstack tree | ${treeOid} |`),
	);
}

// ---------------------------------------------------------------------------
// Promotion, no-op, drift, stale deletion, crash recovery
// ---------------------------------------------------------------------------

test("the same pin twice is a byte and mtime no-op", async () => {
	const layout = await makeLayout();
	try {
		assert.equal((await runSync(optionsFor(layout))).status, "promoted");
		const before = await snapshot(layout.generated);

		await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
		const second = await runSync(optionsFor(layout));
		assert.equal(second.status, "unchanged");
		assert.equal(second.digest, second.liveDigest);

		const after = await snapshot(layout.generated);
		assert.equal(after.digest, before.digest);
		for (const [path, mtime] of before.mtimes) {
			assert.equal(after.mtimes.get(path), mtime, `${path} was rewritten by a no-op sync`);
		}
		// And no staging leftovers.
		const entries = await readdir(layout.root);
		assert.deepEqual(
			entries.filter((name) => name.startsWith("generated.")),
			[],
		);
	} finally {
		await layout.cleanup();
	}
});

test("a hand edit inside generated makes check fail, and check writes nothing", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");

		const target = join(layout.generated, "skills", "fixture-skill", "SKILL.md");
		await writeFile(target, `${await readFile(target, "utf8")}\nhand edited\n`);
		const edited = await snapshot(layout.generated);

		await assert.rejects(
			runSync(optionsFor(layout, { check: true })),
			/generated tree drifted: live [0-9a-f]{12} vs rebuilt/u,
		);
		assert.equal((await snapshot(layout.generated)).digest, edited.digest, "check did not repair or rewrite");
		const entries = await readdir(layout.root);
		assert.deepEqual(
			entries.filter((name) => name.startsWith("generated.")),
			[],
			"check left no staging directories",
		);

		// A plain sync repairs it, because the rebuild is the authority.
		assert.equal((await runSync(optionsFor(layout))).status, "promoted");
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");
	} finally {
		await layout.cleanup();
	}
});

test("a mode-only edit inside generated is drift too", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		await chmod(join(layout.generated, "skills", "fixture-skill", "scripts", "run.sh"), 0o644);
		await assert.rejects(runSync(optionsFor(layout, { check: true })), /drifted/u);
	} finally {
		await layout.cleanup();
	}
});

test("a file deleted upstream is removed from generated", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		assert.ok((await readTree(layout.generated)).has("assets/pixel.png"), "the file shipped first");

		// Swap in the pinned tree that no longer has it, and move the pin honestly.
		await rm(layout.upstream, { recursive: true, force: true });
		await cp(join(FIXTURES, "kstack-stale-file", "pstack"), layout.upstream, { recursive: true });
		await refreshPin(layout);

		const report = await runSync(optionsFor(layout));
		assert.equal(report.status, "promoted");
		const generated = await readTree(layout.generated);
		assert.equal(generated.has("assets/pixel.png"), false, "the stale file is gone, not merged forward");
		assert.equal(
			generated.get("skills/fixture-skill/references/added.md")?.bytes.toString("utf8"),
			"# added upstream\n",
		);
		assert.equal(
			await stat(join(layout.generated, "assets")).catch(() => undefined),
			undefined,
			"and so is its folder",
		);
	} finally {
		await layout.cleanup();
	}
});

test("promotion restores the live tree when the swap fails", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		const before = await snapshot(layout.generated);

		// A candidate directory that cannot be read: promotion must fail before it
		// has replaced anything, and leave the live tree exactly as it was.
		await assert.rejects(
			publishArtifacts(
				[
					{
						name: "generated",
						live: layout.generated,
						staged: { kind: "tree", directory: join(layout.root, "absent-candidate") },
					},
				],
				pathsFor(layout),
			),
			/ENOENT/u,
		);
		const after = await snapshot(layout.generated);
		assert.equal(after.digest, before.digest);
		assert.equal(await stat(join(layout.root, PROMOTION_MARKER)).catch(() => undefined), undefined, "no marker left");
	} finally {
		await layout.cleanup();
	}
});

test("a crashed promotion is recovered from its marker on the next run", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		const before = await snapshot(layout.generated);

		// Exactly the state a crash between the two renames leaves behind.
		await cp(layout.generated, `${layout.generated}.previous`, { recursive: true });
		await rm(layout.generated, { recursive: true, force: true });
		await writeFile(join(layout.root, PROMOTION_MARKER), `${JSON.stringify({ artifacts: ["generated"] })}\n`);

		assert.equal(await recoverIncompleteTransaction(pathsFor(layout)), "restored");
		assert.equal((await snapshot(layout.generated)).digest, before.digest, "the live tree came back");
		assert.equal(await stat(join(layout.root, PROMOTION_MARKER)).catch(() => undefined), undefined);
		assert.equal(await stat(`${layout.generated}.previous`).catch(() => undefined), undefined);

		// A marker with a live tree present is a completed swap: drop the leftovers.
		await cp(layout.generated, `${layout.generated}.previous`, { recursive: true });
		await writeFile(join(layout.root, PROMOTION_MARKER), `${JSON.stringify({ artifacts: ["generated"] })}\n`);
		assert.equal(await recoverIncompleteTransaction(pathsFor(layout)), "kept");
		assert.equal(await stat(`${layout.generated}.previous`).catch(() => undefined), undefined);
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");

		// No marker at all is nothing to do.
		assert.equal(await recoverIncompleteTransaction(pathsFor(layout)), "none");
	} finally {
		await layout.cleanup();
	}
});

function pathsFor(layout: Layout): typeof realPaths {
	return {
		root: layout.root,
		generated: layout.generated,
		upstream: layout.upstream,
		overlay: layout.overlay,
		overlaySource: layout.overlaySource,
		patches: layout.patches,
		upstreamDocument: layout.upstreamDocument,
		provenance: layout.provenance,
	};
}

// ---------------------------------------------------------------------------
// Options, offline guarantees
// ---------------------------------------------------------------------------

test("check is offline by default and refuses to be told otherwise", () => {
	assert.deepEqual(parseOptions(["--check"]), { check: true, fetch: false });
	assert.deepEqual(parseOptions([]), { check: false, fetch: false });
	assert.equal(parseOptions(["--fetch"]).fetch, true);
	assert.throws(() => parseOptions(["--check", "--fetch"]), /never reaches the network/u);
	assert.throws(() => parseOptions(["--check", "--pin", "a".repeat(40)]), /mutually exclusive/u);
	assert.throws(() => parseOptions(["--pin", "b9ddc83"]), /full 40-character commit sha/u);
});

test("nothing in the sync or status path reaches the network without --fetch", async () => {
	const sync = await readFile(join(REAL_KSTACK, "scripts", "sync-kstack.ts"), "utf8");
	// The only clone lives behind the explicit opt-in.
	const cloneIndex = sync.indexOf('"clone"');
	assert.ok(cloneIndex > 0, "the fetch path exists");
	assert.match(sync.slice(0, cloneIndex), /if \(!options\.fetch\) \{\s*return layout\.upstream;/u);

	// And the default really is the vendored tree: a check run with no source and
	// no fetch succeeds against the committed bytes.
	assert.equal((await runSync({ check: true, fetch: false })).status, "checked");
});

test("status reports the local pin offline and never mutates it", async () => {
	const layout = await makeLayout();
	try {
		const report = await runStatus({ offline: true, layout: pathsFor(layout) });
		assert.equal(report.local.kind, "honest");
		assert.equal(report.remote.kind, "skipped");
		assert.equal(report.pinChanged, false);
		assert.match(report.summary, /local pin honest/u);
		assert.match(report.summary, /not consulted \(offline\)/u);
		assert.equal(exitCodeFor(report), 0);

		const provenanceBefore = await readFile(layout.provenance, "utf8");
		await runStatus({ offline: true, layout: pathsFor(layout) });
		assert.equal(await readFile(layout.provenance, "utf8"), provenanceBefore, "status wrote nothing");
	} finally {
		await layout.cleanup();
	}
});

test("status fails only when the local pin is dishonest", async () => {
	const layout = await makeLayout();
	try {
		await writeFile(join(layout.upstream, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Fixture Author\n");
		const report = await runStatus({ offline: true, layout: pathsFor(layout) });
		assert.equal(report.local.kind, "dishonest");
		assert.equal(exitCodeFor(report), 1);
		assert.match(report.summary, /local pin DISHONEST/u);
		assert.equal(report.pinChanged, false);
	} finally {
		await layout.cleanup();
	}
});

test("a moved HEAD with the same pstack tree is informational, a changed tree is available", async () => {
	const honest = { kind: "honest", treeOid: "a".repeat(40) } as const;

	const moved = summarize(honest, { kind: "head-moved", head: "b".repeat(40), treeOid: "a".repeat(40) });
	assert.match(moved, /HEAD moved to b{40}, pstack tree unchanged/u);
	assert.match(moved, /informational, no update needed/u);
	assert.equal(/update available/u.test(moved), false);

	const changed = summarize(honest, { kind: "update-available", head: "c".repeat(40), treeOid: "d".repeat(40) });
	assert.match(changed, /update available/u);
	assert.match(changed, /has pstack tree d{40}/u);
	assert.match(changed, /npm run kstack:sync -- --pin c{40}/u, "the operator is told how, and it is not automatic");

	assert.match(summarize(honest, { kind: "current", head: "e".repeat(40), treeOid: "a".repeat(40) }), /current at/u);
	assert.match(summarize(honest, { kind: "unreachable", reason: "no route" }), /unreachable \(no route\)/u);

	// Neither remote state can fail the command: only a dishonest local pin does.
	for (const remote of [
		{ kind: "head-moved", head: "b".repeat(40), treeOid: "a".repeat(40) },
		{ kind: "update-available", head: "c".repeat(40), treeOid: "d".repeat(40) },
		{ kind: "unreachable", reason: "offline" },
	] as const) {
		assert.equal(
			exitCodeFor({
				origin: { repository: "r", path: "pstack/", commit: "f".repeat(40), treeOid: "a".repeat(40) },
				local: honest,
				remote,
				summary: "",
				pinChanged: false,
			}),
			0,
			`${remote.kind} must not fail the gate`,
		);
	}
});

test("the local pin inspection is the tree comparison, not a file comparison", async () => {
	const layout = await makeLayout();
	try {
		const provenance = await readProvenance(layout.provenance);
		assert.deepEqual(await inspectLocal(provenance, layout.upstream), { kind: "honest", treeOid: layout.treeOid });
		await chmod(join(layout.upstream, "skills", "fixture-skill", "scripts", "run.sh"), 0o644);
		const after = await inspectLocal(provenance, layout.upstream);
		assert.equal(after.kind, "dishonest");
	} finally {
		await layout.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The real repository, end to end
// ---------------------------------------------------------------------------

test("the committed generated tree is byte and semantically reproducible offline", async () => {
	const report = await runSync({ check: true, fetch: false });
	assert.equal(report.status, "checked");
	assert.equal(report.digest, report.liveDigest);
	assert.equal(report.sourceTreeOid, (await readProvenance(join(REAL_KSTACK, "provenance.json"))).origin.treeOid);
	assert.ok(report.dropped > 0, "the drop list did work");
});

test("check proves semantics, not only bytes", async () => {
	// The semantic half is reachable from the same config the check uses, so a tree
	// that matched byte for byte but broke a rule would still be refused.
	const config = await readOverlayConfig(join(REAL_KSTACK, "overlay"));
	const tree = await readTree(join(REAL_KSTACK, "generated"));
	const text = textOf(tree);
	assert.ok(text.size > 0 && text.size < tree.size + 1);
	const { validateGeneratedTree } = await import("../packages/coding-agent/src/kpi/kstack/overlay/transforms.ts");
	assert.deepEqual(validateGeneratedTree(text, config), []);

	// And a candidate carrying residue is refused by the same call.
	const poisoned = new Map(text);
	poisoned.set("skills/fixture/SKILL.md", "---\nname: fixture\ndescription: d\n---\n\nWake the Cursor Cloud agent.\n");
	assert.ok(validateGeneratedTree(poisoned, config).some((entry) => entry.rule === "cloud-worker"));
});

test("the built inventory ships provenance and no build input", async () => {
	const manifest = JSON.parse(await readFile(join(REPO, "packages", "coding-agent", "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	const copy = manifest.scripts["copy-kpi-assets"];
	assert.match(copy, /kstack\/provenance\.json/u, "provenance ships");
	assert.match(copy, /kstack\/UPSTREAM\.md/u);
	assert.match(copy, /kstack\/NOTICE/u);
	for (const input of ["kstack/overlay", "kstack/upstream", "kstack/scripts", ".patch"]) {
		assert.equal(copy.includes(input), false, `${input} must not ship`);
	}

	const root = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
	};
	assert.match(root.scripts["kstack:sync:check"], /--check/u);
	assert.equal(root.scripts["kstack:sync:check"].includes("--source"), false, "the gate is offline by default");
	assert.equal(root.scripts["kstack:sync:check"].includes("--fetch"), false);
	assert.match(root.scripts["kstack:status"], /status\.ts/u);
});

test("git is only ever invoked read-only from the status path", async () => {
	const status = await readFile(join(REAL_KSTACK, "scripts", "status.ts"), "utf8");
	assert.match(status, /READ_ONLY_GIT = new Set\(\["ls-remote", "fetch", "rev-parse", "init", "config"\]\)/u);
	for (const forbidden of ["push", "merge", "commit", "tag", "reset", "checkout"]) {
		assert.equal(
			new RegExp(`"${forbidden}"`, "u").test(status),
			false,
			`status.ts must never invoke git ${forbidden}`,
		);
	}
});

test("a real git apply outside a repository still refuses an escaping path", async () => {
	// The behaviour the confinement rests on, asserted rather than assumed.
	const staging = await mkdtemp(join(tmpdir(), "kstack-gitapply-"));
	try {
		await writeFile(join(staging, "a.txt"), "old\n");
		const patch = join(staging, "escape.patch");
		await cp(join(FIXTURES, "kstack-unsafe-patch", "0001-parent-escape.patch"), patch);
		await assert.rejects(execFile("git", ["apply", "--check", patch], { cwd: staging }), (error: unknown) => {
			assert.match(String((error as { stderr?: string }).stderr ?? ""), /invalid path/u);
			return true;
		});
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Path confinement: every path-bearing header is parsed, or the patch is refused
// ---------------------------------------------------------------------------

/** A git runner that fails the test if it is ever reached. */
function forbiddenGit(): { git: Parameters<typeof applyPatches>[3]; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		git: async (args) => {
			calls.push([...args]);
			throw new Error("git must not be invoked for a refused patch");
		},
	};
}

test("a malicious header cannot ride along beside a safe target", async () => {
	const staging = await mkdtemp(join(tmpdir(), "kstack-malicious-"));
	const directory = join(FIXTURES, "kstack-malicious-patch");
	try {
		await mkdir(join(staging, "skills", "fixture-skill", "references"), { recursive: true });
		const cases: { patch: string; pattern: RegExp }[] = [
			{ patch: "0001-quoted-space.patch", pattern: /quoted path|names exactly two unquoted paths/u },
			{ patch: "0002-c-escape.patch", pattern: /quoted path, which is not canonical/u },
			{ patch: "0003-copy-escape.patch", pattern: /traversal or empty segment/u },
			{ patch: "0004-binary.patch", pattern: /binary patch carries no reviewable text/u },
			{ patch: "0005-space-unquoted.patch", pattern: /names exactly two unquoted paths; got 4/u },
			{ patch: "0006-backslash.patch", pattern: /escaped or backslash path/u },
			{ patch: "0007-one-field.patch", pattern: /names exactly two unquoted paths; got 1/u },
			{ patch: "0008-combined.patch", pattern: /combined diff names more than one parent/u },
			{ patch: "0009-binary-differ.patch", pattern: /cannot be split into two paths unambiguously/u },
			{ patch: "0010-absolute.patch", pattern: /absolute path/u },
			{ patch: "0011-rename-escape.patch", pattern: /traversal or empty segment/u },
		];

		for (const scenario of cases) {
			const spy = forbiddenGit();
			// Every one of these patches begins with a target that parses and confines
			// cleanly, so an incomplete parser would accept the file and hand the rest
			// to git.
			const source = await readFile(join(directory, scenario.patch), "utf8");
			assert.match(source, /^diff --git a\/skills\/fixture-skill\/references\/safe\.md/u, scenario.patch);

			await assert.rejects(applyPatches(staging, directory, [scenario.patch], spy.git), (error: unknown) => {
				assert.ok(error instanceof PatchError, `${scenario.patch}: expected a PatchError`);
				assert.equal(error.patch, scenario.patch);
				assert.match(error.message, scenario.pattern, scenario.patch);
				assert.ok((error.line ?? 0) > 0, `${scenario.patch}: the refusal names a line`);
				return true;
			});
			assert.deepEqual(spy.calls, [], `${scenario.patch}: git was invoked`);
		}

		// Nothing was created anywhere, inside the staging tree or outside it.
		assert.deepEqual([...(await readTree(staging)).keys()], []);
		for (const outside of ["escape.txt", "copied.md", "renamed.md", "x y.txt"]) {
			assert.equal(await stat(join(staging, "..", outside)).catch(() => undefined), undefined, outside);
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
});

test("a hunk body that looks like headers is still just a body", async () => {
	// The parser tracks hunks, so quoted and escaped text inside added lines is
	// content. Without that, this legitimate patch would be refused.
	const source = await readFile(join(FIXTURES, "kstack-headerish-body", "0001-headerish.patch"), "utf8");
	assert.deepEqual(patchTargets(source, "headerish"), ["skills/fixture-skill/references/notes.md"]);

	const staging = await mkdtemp(join(tmpdir(), "kstack-headerish-"));
	try {
		await mkdir(join(staging, "skills", "fixture-skill", "references"), { recursive: true });
		await applyPatches(staging, join(FIXTURES, "kstack-headerish-body"), ["0001-headerish.patch"]);
		const written = (await readTree(staging)).get("skills/fixture-skill/references/notes.md")?.bytes.toString("utf8");
		assert.match(written ?? "", /diff --git "a\/x y" "b\/x y"/u, "the body survived verbatim");
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
});

test("the parser refuses every non-canonical path shape", () => {
	for (const bad of ['"a/x"', "a/x\\y", "a/x y", "a/../x", "/abs/x", "C:/x", "a//x", "a/./x", "a/x\ty"]) {
		assert.throws(() => parseCanonicalPath(bad.replace(/^[ab]\//u, "")), TreeError, bad);
	}
	for (const good of ["x.md", "skills/a/SKILL.md", "a-b_c.1/x"]) {
		assert.equal(parseCanonicalPath(good), good);
	}
});

test("a hunk before any path header, and a malformed hunk header, are refused", () => {
	assert.throws(() => patchTargets("@@ -1 +1 @@\n-a\n+b\n", "orphan"), /hunk appears before any path-bearing header/u);
	assert.throws(
		() => patchTargets("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ nonsense @@\n", "bad"),
		/malformed hunk header/u,
	);
});

// ---------------------------------------------------------------------------
// Moving the pin: one recoverable transaction over four artifacts
// ---------------------------------------------------------------------------

const NEW_PIN = "1234567890abcdef1234567890abcdef12345678";

async function liveState(layout: Layout): Promise<{
	generated: { digest: string; mtimes: Map<string, number> };
	upstream: { digest: string; mtimes: Map<string, number> };
	provenance: string;
	document: string;
	provenanceMtime: number;
	documentMtime: number;
}> {
	return {
		generated: await snapshot(layout.generated),
		upstream: await snapshot(layout.upstream),
		provenance: await readFile(layout.provenance, "utf8"),
		document: await readFile(layout.upstreamDocument, "utf8"),
		provenanceMtime: (await stat(layout.provenance)).mtimeMs,
		documentMtime: (await stat(layout.upstreamDocument)).mtimeMs,
	};
}

test("a pin that moves the pstack tree succeeds and the next offline check reproduces", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		const before = await liveState(layout);
		const changedTree = (await readFile(join(FIXTURES, "kstack-tree-changed", "tree-oid.txt"), "utf8")).trim();
		assert.notEqual(changedTree, layout.treeOid, "the fixture really is a different tree");

		const report = await runSync(
			optionsFor(layout, { pin: NEW_PIN, fetch: true, source: join(FIXTURES, "kstack-tree-changed", "pstack") }),
		);
		assert.equal(report.status, "promoted");
		assert.equal(report.commit, NEW_PIN);
		assert.equal(report.sourceTreeOid, changedTree);
		assert.deepEqual(report.published, ["generated", "upstream", "provenance.json", "UPSTREAM.md"]);

		// All four artifacts moved, with no hand editing.
		const provenance = await readProvenance(layout.provenance);
		assert.equal(provenance.origin.commit, NEW_PIN);
		assert.equal(provenance.origin.treeOid, changedTree);
		// The new pin brought a new licence; its provenance was re-derived, not
		// validated against the old digest, and the holder came from the new file.
		assert.notEqual(provenance.license.sha256, JSON.parse(before.provenance).license.sha256);
		assert.equal(provenance.license.holder, "Fixture Author and Contributors");
		assert.equal(provenance.license.spdx, "MIT");

		const table = parseUpstreamDocument(await readFile(layout.upstreamDocument, "utf8"));
		assert.equal(table.commit, NEW_PIN);
		assert.equal(table.treeOid, changedTree);
		assert.doesNotThrow(() => assertRecordsAgree(provenance, table));

		// The newly vendored subtree is the one the record names.
		assert.equal(await computeTreeOid(layout.upstream), changedTree);
		assert.notEqual((await snapshot(layout.upstream)).digest, before.upstream.digest);
		assert.notEqual((await snapshot(layout.generated)).digest, before.generated.digest);
		assert.ok(
			(await readTree(layout.generated)).has("skills/fixture-skill/references/new-at-pin.md"),
			"the new upstream content shipped",
		);

		// And the next offline check reproduces from the newly vendored bytes.
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");
		// Twice, with nothing rewritten.
		const settled = await liveState(layout);
		assert.equal((await runSync(optionsFor(layout))).status, "unchanged");
		assert.equal((await snapshot(layout.generated)).digest, settled.generated.digest);
		assert.equal((await stat(layout.provenance)).mtimeMs, settled.provenanceMtime);
	} finally {
		await layout.cleanup();
	}
});

test("a pin whose subtree is unchanged updates the commit and rewrites nothing else", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		const before = await liveState(layout);

		const report = await runSync(optionsFor(layout, { pin: NEW_PIN, fetch: true, source: layout.upstream }));
		assert.equal(report.status, "promoted");
		assert.deepEqual(report.published, ["provenance.json", "UPSTREAM.md"], "only the records moved");

		const provenance = await readProvenance(layout.provenance);
		assert.equal(provenance.origin.commit, NEW_PIN);
		assert.equal(provenance.origin.treeOid, layout.treeOid, "the tree id did not change");

		// The two heavy artifacts were not touched at all.
		const after = await liveState(layout);
		assert.equal(after.generated.digest, before.generated.digest);
		assert.equal(after.upstream.digest, before.upstream.digest);
		for (const [path, mtime] of before.generated.mtimes) {
			assert.equal(after.generated.mtimes.get(path), mtime, `generated/${path} was rewritten`);
		}
		for (const [path, mtime] of before.upstream.mtimes) {
			assert.equal(after.upstream.mtimes.get(path), mtime, `upstream/${path} was rewritten`);
		}
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");
	} finally {
		await layout.cleanup();
	}
});

test("a failure at every publication boundary restores all four live artifacts", async () => {
	const boundaries = [
		"stage:generated",
		"stage:upstream",
		"stage:provenance.json",
		"stage:UPSTREAM.md",
		"retire:generated",
		"retire:upstream",
		"retire:provenance.json",
		"retire:UPSTREAM.md",
		"install:generated",
		"install:upstream",
		"install:provenance.json",
		"install:UPSTREAM.md",
		"commit",
	];
	for (const boundary of boundaries) {
		const layout = await makeLayout();
		try {
			await runSync(optionsFor(layout));
			const before = await liveState(layout);

			await assert.rejects(
				runSync({
					...optionsFor(layout, {
						pin: NEW_PIN,
						fetch: true,
						source: join(FIXTURES, "kstack-tree-changed", "pstack"),
					}),
					hooks: {
						onBoundary: (name) => {
							if (name === boundary) {
								throw new Error(`injected failure at ${name}`);
							}
						},
					},
				}),
				new RegExp(`injected failure at ${boundary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
			);

			const after = await liveState(layout);
			assert.equal(after.generated.digest, before.generated.digest, `${boundary}: generated changed`);
			assert.equal(after.upstream.digest, before.upstream.digest, `${boundary}: upstream changed`);
			assert.equal(after.provenance, before.provenance, `${boundary}: provenance.json changed`);
			assert.equal(after.document, before.document, `${boundary}: UPSTREAM.md changed`);
			for (const [path, mtime] of before.generated.mtimes) {
				assert.equal(after.generated.mtimes.get(path), mtime, `${boundary}: generated/${path} mtime moved`);
			}
			for (const [path, mtime] of before.upstream.mtimes) {
				assert.equal(after.upstream.mtimes.get(path), mtime, `${boundary}: upstream/${path} mtime moved`);
			}

			// No marker and no staging leftovers survive a failed publication.
			assert.equal((await inspectTransaction(pathsFor(layout))).incomplete, false, `${boundary}: marker left`);
			assert.deepEqual(
				(await readdir(layout.root)).filter((name) => name.endsWith(".next") || name.endsWith(".previous")),
				[],
				`${boundary}: staging directories left`,
			);
			// And the tree is still verifiable offline.
			assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");
		} finally {
			await layout.cleanup();
		}
	}
});

test("a pin whose new licence or content is invalid never mutates any artifact", async () => {
	for (const scenario of [
		{ fixture: "kstack-pin-bad-license", pattern: /missing the clause/u },
		{ fixture: "kstack-pin-residue", pattern: /cloud-worker|Cursor Cloud/u },
	]) {
		const layout = await makeLayout();
		try {
			await runSync(optionsFor(layout));
			const before = await liveState(layout);

			await assert.rejects(
				runSync(
					optionsFor(layout, { pin: NEW_PIN, fetch: true, source: join(FIXTURES, scenario.fixture, "pstack") }),
				),
				(error: unknown) => {
					assert.match(
						error instanceof KStackTransformError
							? error.diagnostics.map((entry) => entry.rule).join(",")
							: String((error as Error).message),
						scenario.pattern,
						scenario.fixture,
					);
					return true;
				},
			);

			const after = await liveState(layout);
			assert.equal(after.generated.digest, before.generated.digest, scenario.fixture);
			assert.equal(after.upstream.digest, before.upstream.digest, scenario.fixture);
			assert.equal(after.provenance, before.provenance, scenario.fixture);
			assert.equal(after.document, before.document, scenario.fixture);
			assert.equal(after.provenanceMtime, before.provenanceMtime, scenario.fixture);
			assert.equal(after.documentMtime, before.documentMtime, scenario.fixture);
		} finally {
			await layout.cleanup();
		}
	}
});

test("a broken patch during a pin leaves all four artifacts alone", async () => {
	const layout = await makeLayout({ patchFixture: "kstack-ordered-patch" });
	try {
		// A tree that already exists, produced with the same broken patch set absent.
		const good = await makeLayout();
		await runSync(optionsFor(good));
		await good.cleanup();

		const before = await stat(layout.provenance).then((info) => info.mtimeMs);
		await assert.rejects(
			runSync(
				optionsFor(layout, { pin: NEW_PIN, fetch: true, source: join(FIXTURES, "kstack-tree-changed", "pstack") }),
			),
			(error: unknown) => error instanceof PatchError,
		);
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined, "nothing was generated");
		assert.equal((await stat(layout.provenance)).mtimeMs, before, "the record was not touched");
		assert.equal(await computeTreeOid(layout.upstream), layout.treeOid, "upstream was not replaced");
		assert.deepEqual(await findPatchDebris(layout.root), []);
	} finally {
		await layout.cleanup();
	}
});

test("--pin carries its own network consent, and --source still overrides it", () => {
	const pinned = parseOptions(["--pin", NEW_PIN]);
	assert.equal(pinned.fetch, true, "moving the pin is the one operation that reaches upstream");
	assert.equal(pinned.pin, NEW_PIN);
	const sourced = parseOptions(["--pin", NEW_PIN, "--source", "/tmp/x"]);
	assert.equal(sourced.source, "/tmp/x", "a fixture drives the same pipeline offline");
	assert.throws(() => parseOptions(["--check", "--pin", NEW_PIN]), /mutually exclusive/u);
});

// ---------------------------------------------------------------------------
// --check never repairs an interrupted publication
// ---------------------------------------------------------------------------

test("check reports an interrupted publication as a failure and repairs nothing", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));

		// Exactly the state a crash between retire and install leaves behind.
		await cp(layout.generated, `${layout.generated}.previous`, { recursive: true });
		const saved = await snapshot(`${layout.generated}.previous`);
		await rm(layout.generated, { recursive: true, force: true });
		await writeFile(
			join(layout.root, PROMOTION_MARKER),
			`${JSON.stringify({ artifacts: ["generated", "upstream"] })}\n`,
		);
		const markerBefore = await readFile(join(layout.root, PROMOTION_MARKER), "utf8");
		const upstreamBefore = await snapshot(layout.upstream);

		await assert.rejects(
			runSync(optionsFor(layout, { check: true })),
			/interrupted K-stack publication is still open \(generated, upstream\)/u,
		);

		// A dry run repaired nothing: the marker, the saved copy and the live
		// artifacts are all exactly as they were.
		assert.equal(await readFile(join(layout.root, PROMOTION_MARKER), "utf8"), markerBefore);
		assert.equal(await stat(layout.generated).catch(() => undefined), undefined, "check restored the tree");
		assert.equal((await snapshot(`${layout.generated}.previous`)).digest, saved.digest);
		for (const [path, mtime] of saved.mtimes) {
			assert.equal((await snapshot(`${layout.generated}.previous`)).mtimes.get(path), mtime, path);
		}
		const upstreamAfter = await snapshot(layout.upstream);
		assert.equal(upstreamAfter.digest, upstreamBefore.digest);
		for (const [path, mtime] of upstreamBefore.mtimes) {
			assert.equal(upstreamAfter.mtimes.get(path), mtime, `upstream/${path} moved`);
		}
		assert.equal((await inspectTransaction(pathsFor(layout))).incomplete, true, "the marker is still open");

		// A mutating sync is what finishes it.
		assert.equal((await runSync(optionsFor(layout))).status, "unchanged");
		assert.equal((await inspectTransaction(pathsFor(layout))).incomplete, false);
		assert.equal((await snapshot(layout.generated)).digest, saved.digest, "the live tree came back");
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");
	} finally {
		await layout.cleanup();
	}
});

test("the transaction marker names the artifacts it was publishing", async () => {
	const layout = await makeLayout();
	try {
		assert.deepEqual(await inspectTransaction(pathsFor(layout)), { incomplete: false, artifacts: [] });
		await writeFile(
			join(layout.root, PROMOTION_MARKER),
			`${JSON.stringify({ artifacts: ["provenance.json", "UPSTREAM.md"], at: "now" })}\n`,
		);
		assert.deepEqual(await inspectTransaction(pathsFor(layout)), {
			incomplete: true,
			artifacts: ["provenance.json", "UPSTREAM.md"],
		});
		// An unreadable marker is still an open transaction: fail closed.
		await writeFile(join(layout.root, PROMOTION_MARKER), "not json\n");
		assert.deepEqual(await inspectTransaction(pathsFor(layout)), { incomplete: true, artifacts: [] });
	} finally {
		await layout.cleanup();
	}
});

test("the UPSTREAM table is rendered, not rewritten wholesale", async () => {
	const provenance = await readProvenance(join(REAL_KSTACK, "provenance.json"));
	const document = await readFile(join(REAL_KSTACK, "UPSTREAM.md"), "utf8");
	const moved = renderUpstreamDocument(document, {
		...provenance,
		origin: { ...provenance.origin, commit: NEW_PIN, treeOid: "f".repeat(40) },
	});
	assert.match(moved, new RegExp(`\\| Commit \\| ${NEW_PIN} \\|`, "u"));
	assert.match(moved, /\| pstack tree \| f{40} \|/u);
	// Every other row and all the prose survive.
	assert.match(moved, /\| Path \| pstack\/ \|/u);
	assert.match(moved, /Upstream version/u);
	assert.match(moved, /Drift is a tree, not a HEAD/u);
	assert.throws(() => renderUpstreamDocument(`| Commit | ${"a".repeat(40)} |\n`, provenance), /no `pstack tree` row/u);
});

// ---------------------------------------------------------------------------
// Editing the overlay is the reason to sync, not a reason to refuse
// ---------------------------------------------------------------------------

test("a mutating sync adopts an overlay edit and records the new transform version", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		const before = await readProvenance(layout.provenance);

		// One net entry added, which is what editing the overlay looks like.
		const netPath = join(layout.overlay, "forbidden.txt");
		await writeFile(netPath, `${(await readFile(netPath, "utf8")).trimEnd()}\nnever-ship-this-word\n`);

		// A dry run calls it what it is: the tree on disk came from rules that no
		// longer exist.
		await assert.rejects(
			runSync(optionsFor(layout, { check: true })),
			/the overlay has changed: transformVersion is [0-9a-f]{64}, provenance records [0-9a-f]{64}/u,
		);

		// The mutating run adopts it. Without this the record could only be changed
		// by hand-writing the file the pipeline exists to own.
		const report = await runSync(optionsFor(layout));
		assert.equal(report.status, "promoted");
		assert.ok(report.published.includes("provenance.json"), "the new version was published");
		const after = await readProvenance(layout.provenance);
		assert.notEqual(after.transformVersion, before.transformVersion);
		assert.match(after.transformVersion, /^[0-9a-f]{64}$/u);
		// Everything else about the pin is untouched by an overlay edit.
		assert.equal(after.origin.commit, before.origin.commit);
		assert.equal(after.origin.treeOid, before.origin.treeOid);
		assert.equal(after.license.sha256, before.license.sha256);

		// And the next check is clean again.
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");
	} finally {
		await layout.cleanup();
	}
});

test("an overlay edit is published even when it changes no generated byte", async () => {
	const layout = await makeLayout();
	try {
		await runSync(optionsFor(layout));
		const before = await snapshot(layout.generated);
		const netPath = join(layout.overlay, "forbidden.txt");
		// A comment line: real edit, zero effect on the produced tree.
		await writeFile(netPath, `${(await readFile(netPath, "utf8")).trimEnd()}\n# an added comment\n`);

		const report = await runSync(optionsFor(layout));
		assert.equal(report.status, "promoted");
		assert.deepEqual(report.published, ["provenance.json", "UPSTREAM.md"], "only the records moved");
		const after = await snapshot(layout.generated);
		assert.equal(after.digest, before.digest, "no generated byte changed");
		for (const [path, mtime] of before.mtimes) {
			assert.equal(after.mtimes.get(path), mtime, `generated/${path} was rewritten`);
		}
		assert.equal((await runSync(optionsFor(layout, { check: true }))).status, "checked");
	} finally {
		await layout.cleanup();
	}
});
