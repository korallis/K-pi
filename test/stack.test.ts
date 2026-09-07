import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { contractHash, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import {
	assertClaimInModule,
	assertDuneStack,
	type DuneStack,
	DuneStackError,
	freezeCurrentSlice,
	MAX_LINK_RESOLUTION_STEPS,
	matchesPathPattern,
	moduleOwnsPath,
	normalizeProjectPath,
	PLAN_SUMMARY_MAX_MODULES,
	readDuneStack,
	renderPlanSummary,
	resolveCurrentModule,
	type StackModule,
	scaffoldModule,
	stackRequiredFor,
	stackTaskHash,
} from "../packages/coding-agent/src/kpi/extensions/stack.ts";

function module_(overrides: Partial<StackModule> = {}): StackModule {
	return {
		id: "auth",
		purpose: "login and sessions",
		folder: "src/auth",
		interface: "src/auth/api.ts",
		allowed_paths: ["src/auth/**", "test/auth/**"],
		depends_on: [],
		...overrides,
	};
}

function stack_(overrides: Partial<DuneStack> = {}): DuneStack {
	return {
		version: 1,
		shape: "dune",
		delivery: "vertical",
		root: "src",
		modules: [module_()],
		scaffold_first: true,
		...overrides,
	};
}

function task_(overrides: Partial<Task> = {}): Task {
	return {
		job_id: "2026-09-01-dune",
		mode: "gated",
		goal: "add login",
		nongoals: [],
		acceptance: [{ id: "AC-01", statement: "login works", required: true }],
		constraints: [],
		quality_gates: ["npm test"],
		ac: { quality: "executable" },
		...overrides,
	} as unknown as Task;
}

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "kpi-dune-"));
	await mkdir(join(directory, "run"), { recursive: true });
	return directory;
}

async function writeStack(directory: string, stack: unknown): Promise<void> {
	await writeFile(join(directory, "run", "stack.json"), `${JSON.stringify(stack, null, 2)}\n`);
}

async function writeTask(directory: string, task: Task): Promise<void> {
	await writeFile(join(directory, "run", "task.json"), `${JSON.stringify(task, null, 2)}\n`);
}

test("a module boundary is folder segments, never a string prefix", () => {
	const directory = "/project";
	const auth = module_();

	// The finding: `src/auth-admin` shares every character of `src/auth`, and a
	// prefix comparison hands one capability's files to another.
	assert.equal(moduleOwnsPath(directory, auth, "src/auth/login.ts"), true);
	assert.equal(moduleOwnsPath(directory, auth, "src/auth/nested/deep/login.ts"), true);
	assert.equal(moduleOwnsPath(directory, auth, "test/auth/login.test.ts"), true);
	for (const outside of [
		"src/auth-admin/login.ts",
		"src/authx/login.ts",
		"src/auth.ts",
		"src/authentication/login.ts",
		"test/auth-admin/login.test.ts",
		"src/billing/invoice.ts",
		"package.json",
	]) {
		assert.equal(moduleOwnsPath(directory, auth, outside), false, outside);
	}

	// Test ownership is explicit, not invented from the feature's id.
	const spare = module_({ allowed_paths: ["src/auth/**"] });
	assert.equal(moduleOwnsPath(directory, spare, "test/auth/login.test.ts"), false);
});

test("the path predicate keeps legitimate globs and accepts both separators", () => {
	assert.equal(matchesPathPattern("src/auth/**", "src/auth/a/b/c.ts"), true);
	assert.equal(matchesPathPattern("src/auth/**", "src/auth"), true, "a folder matches its own glob");
	assert.equal(matchesPathPattern("src/*/api.ts", "src/auth/api.ts"), true);
	assert.equal(matchesPathPattern("src/*/api.ts", "src/auth/deep/api.ts"), false, "* stays inside one segment");
	assert.equal(matchesPathPattern("src/auth/*.ts", "src/auth/login.ts"), true);
	assert.equal(matchesPathPattern("src/auth/*.ts", "src/auth/deep/login.ts"), false);
	assert.equal(matchesPathPattern("src/auth/api.?s", "src/auth/api.ts"), true);
	assert.equal(matchesPathPattern("src/**/*.test.ts", "src/auth/login.test.ts"), true);
	// A Windows-shaped path is still that path.
	assert.equal(matchesPathPattern("src\\auth\\**", "src/auth/login.ts"), true);
	assert.equal(matchesPathPattern("src/auth/**", "src\\auth\\login.ts"), true);
	// Dots are literal, not wildcards.
	assert.equal(matchesPathPattern("src/auth/api.ts", "src/auth/apiXts"), false);
});

test("traversal, absolute escapes, and links out of the tree are refused", async () => {
	const directory = await fixture();
	try {
		const auth = module_();
		assert.equal(normalizeProjectPath(directory, "../outside.ts"), undefined);
		// This one stays inside the project but leaves the module: the module check
		// is what refuses it.
		assert.equal(normalizeProjectPath(directory, "src/auth/../../outside.ts"), "outside.ts");
		assert.equal(normalizeProjectPath(directory, "/etc/passwd"), undefined);
		assert.equal(normalizeProjectPath(directory, "src/auth/../auth/login.ts"), "src/auth/login.ts");
		assert.equal(normalizeProjectPath(directory, join(directory, "src", "auth", "login.ts")), "src/auth/login.ts");

		for (const path of ["../outside.ts", "src/auth/../../outside.ts", "/etc/passwd", "src/auth/../billing/x.ts"]) {
			await assert.rejects(assertClaimInModule(directory, path, auth), DuneStackError, path);
		}
		await assertClaimInModule(directory, "src/auth/login.ts", auth);

		// A link inside the folder that points out of the tree is an escape: the
		// boundary is about where the bytes land.
		await mkdir(join(directory, "src", "auth"), { recursive: true });
		await mkdir(join(directory, "elsewhere"), { recursive: true });
		await symlink(join(directory, "elsewhere"), join(directory, "src", "auth", "linked"));
		await assert.rejects(
			assertClaimInModule(directory, "src/auth/linked/escape.ts", auth),
			/after link resolution|escapes the project/u,
		);

		// A link that stays inside the module is fine.
		await mkdir(join(directory, "src", "auth", "real"), { recursive: true });
		await symlink(join(directory, "src", "auth", "real"), join(directory, "src", "auth", "alias"));
		await assertClaimInModule(directory, "src/auth/alias/login.ts", auth);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("existing Python layers and feature names retain explicit ownership without layout ceremony", async () => {
	const directory = await fixture();
	try {
		const feature = module_({
			id: "login",
			folder: "src/core",
			interface: "src/core/login.py",
			allowed_paths: ["src/core/**", "tests/login_test.py"],
		});
		const stack = stack_({ modules: [feature], current_module_id: feature.id });
		const task = task_({ current_module_id: feature.id });
		await mkdir(join(directory, "src/core"), { recursive: true });
		for (let index = 0; index < 8; index++)
			await writeFile(join(directory, `src/core/module_${index}.py`), `VALUE = ${index}\n`);
		await writeFile(join(directory, feature.interface), "def login():\n    return True\n");
		await writeTask(directory, task);
		await writeStack(directory, { ...stack, task_hash: stackTaskHash(task) });
		const frozen = await freezeCurrentSlice(directory, join(directory, "run"), task);
		await scaffoldModule(directory, frozen.module);
		assert.equal(await readFile(join(directory, feature.interface), "utf8"), "def login():\n    return True\n");
		assert.equal(moduleOwnsPath(directory, feature, "tests/login_test.py"), true);
		assert.equal(moduleOwnsPath(directory, feature, "tests/unrelated.py"), false);
		await assert.rejects(stat(join(directory, "test/login/index.test.ts")), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	const rootFeature = module_({
		id: "script",
		folder: ".",
		interface: "main.py",
		allowed_paths: ["main.py", "test_main.py"],
	});
	assertDuneStack(stack_({ root: ".", modules: [rootFeature] }));
	assert.equal(moduleOwnsPath("/project", rootFeature, "main.py"), true);
	assert.equal(moduleOwnsPath("/project", rootFeature, "unrelated.py"), false);
});

test("unknown and cyclic dependencies fail while shared ownership is explicitly declared", () => {
	const shared = module_({
		id: "shared",
		folder: "src/shared",
		interface: "src/shared/api.ts",
		allowed_paths: ["src/shared/**"],
	});
	assertDuneStack(stack_({ modules: [module_({ depends_on: ["shared"] }), shared] }));
	assert.throws(() => assertDuneStack(stack_({ modules: [module_({ depends_on: ["absent"] })] })), DuneStackError);
	assert.throws(() => assertDuneStack(stack_({ modules: [module_({ depends_on: ["auth"] })] })), DuneStackError);
	assert.throws(
		() =>
			assertDuneStack(
				stack_({ modules: [module_({ depends_on: ["shared"] }), { ...shared, depends_on: ["auth"] }] }),
			),
		DuneStackError,
	);
	assert.throws(() => assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["**"] })] })), DuneStackError);
});

test("a module cannot expand the protected task's declared write bounds", async () => {
	const directory = await fixture();
	try {
		const task = task_({
			current_module_id: "auth",
			acceptance: [
				{ id: "AC-01", statement: "login works", required: true, bounds: { write_allow: ["src/auth/**"] } },
			],
		});
		await writeTask(directory, task);
		await writeStack(
			directory,
			stack_({
				task_hash: stackTaskHash(task),
				modules: [module_({ allowed_paths: ["src/auth/**", "src/billing/**"] })],
			}),
		);
		await assert.rejects(freezeCurrentSlice(directory, join(directory, "run"), task), DuneStackError);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("horizontal delivery requires a declared reason", () => {
	assert.throws(() => assertDuneStack(stack_({ delivery: "horizontal" })), DuneStackError);
	assertDuneStack(stack_({ delivery: "horizontal", delivery_reason: "existing API migration" }));
});

test("the current slice is named, never inferred from modules[0]", () => {
	const stack = stack_({
		modules: [
			module_(),
			module_({
				id: "billing",
				purpose: "invoices",
				folder: "src/billing",
				interface: "src/billing/api.ts",
				allowed_paths: ["src/billing/**", "test/billing/**"],
			}),
		],
	});

	// The second module is selectable, and selection is by name.
	assert.equal(resolveCurrentModule(stack, { current_module_id: "billing" }).id, "billing");
	assert.equal(resolveCurrentModule(stack, { current_module_id: " auth " }).id, "auth");

	for (const requested of [undefined, "", "   ", "nope", "Auth"]) {
		assert.throws(
			() => resolveCurrentModule(stack, { current_module_id: requested }),
			(error: unknown) =>
				error instanceof DuneStackError && /current_module_id|never the current slice/u.test(error.message),
			String(requested),
		);
	}
});

test("a missing, unparseable, or stale stack stops implement before any write", async () => {
	const directory = await fixture();
	const runDirectory = join(directory, "run");
	try {
		const task = task_({ current_module_id: "auth" });
		await writeTask(directory, task);

		await assert.rejects(readDuneStack(runDirectory), /stack\.json is missing/u);
		await assert.rejects(freezeCurrentSlice(directory, runDirectory, task), /stack\.json is missing/u);

		await writeFile(join(runDirectory, "stack.json"), "{not json");
		await assert.rejects(freezeCurrentSlice(directory, runDirectory, task), /not valid JSON/u);

		await writeStack(directory, { version: 1, shape: "dune" });
		await assert.rejects(freezeCurrentSlice(directory, runDirectory, task), DuneStackError);

		// Frozen against a different contract: stale.
		await writeStack(directory, stack_({ task_hash: `sha256:${"0".repeat(64)}` }));
		await assert.rejects(freezeCurrentSlice(directory, runDirectory, task), /frozen against a different task/u);

		// Bound to this contract: fresh.
		await writeStack(directory, stack_({ task_hash: stackTaskHash(task) }));
		assert.equal((await freezeCurrentSlice(directory, runDirectory, task)).module.id, "auth");
		assert.equal(stackTaskHash(task), contractHash(task), "the stack binds to the contract hash");

		// Without a hash, a stack older than its task.json is stale.
		await writeStack(directory, stack_());
		const old = new Date(Date.now() - 60_000);
		await utimes(join(runDirectory, "stack.json"), old, old);
		await assert.rejects(freezeCurrentSlice(directory, runDirectory, task), /older than task\.json/u);

		// Advancing the slice is a contract edit, not a hash change.
		const advanced = task_({ current_module_id: "billing" });
		assert.equal(contractHash(advanced), contractHash(task), "the slice pointer is not the contract");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the plan's selected slice is frozen into the job contract", async () => {
	const directory = await fixture();
	const runDirectory = join(directory, "run");
	try {
		const task = task_();
		await writeTask(directory, task);
		await writeStack(
			directory,
			stack_({
				current_module_id: "billing",
				modules: [
					module_(),
					module_({
						id: "billing",
						purpose: "invoices",
						folder: "src/billing",
						interface: "src/billing/api.ts",
						allowed_paths: ["src/billing/**", "test/billing/**"],
					}),
				],
			}),
		);

		const frozen = await freezeCurrentSlice(directory, runDirectory, task);
		assert.equal(frozen.module.id, "billing", "the plan's choice, not modules[0]");
		assert.equal(task.current_module_id, "billing", "the in-memory contract carries it");
		const persisted = JSON.parse(await readFile(join(runDirectory, "task.json"), "utf8")) as Task;
		assert.equal(persisted.current_module_id, "billing", "and so does the job contract on disk");

		// A stack that names nothing cannot be frozen into a slice.
		const bare = task_();
		await writeTask(directory, bare);
		await writeStack(directory, stack_());
		await assert.rejects(freezeCurrentSlice(directory, runDirectory, bare), /must name current_module_id/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("no-stack playbooks are exempt, and every other playbook is not", () => {
	for (const playbook of ["typo", "unslop", "comment-strip", "TYPO", " unslop "]) {
		assert.equal(stackRequiredFor({ playbook }), false, playbook);
	}
	for (const playbook of [undefined, "feature", "healthcheck", "refactor"]) {
		assert.equal(stackRequiredFor({ playbook }), true, String(playbook));
	}
});

test("scaffold creates only declared directories and never manufactures source or tests", async () => {
	const directory = await fixture();
	try {
		const feature = module_({ scaffold: ["src/auth", "test/auth"] });
		await scaffoldModule(directory, feature);
		assert.equal((await stat(join(directory, "src/auth"))).isDirectory(), true);
		assert.equal((await stat(join(directory, "test/auth"))).isDirectory(), true);
		await assert.rejects(stat(join(directory, feature.interface)), { code: "ENOENT" });
		await assert.rejects(stat(join(directory, "test/auth/index.test.ts")), { code: "ENOENT" });
		await writeFile(join(directory, feature.interface), "export const real = 1;\n");
		await scaffoldModule(directory, feature);
		assert.equal(await readFile(join(directory, feature.interface), "utf8"), "export const real = 1;\n");
		await assert.rejects(scaffoldModule(directory, { ...feature, scaffold: ["src/billing"] }), DuneStackError);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("claim_path and implement bounds share one boundary", async () => {
	const directory = await fixture();
	const runDirectory = join(directory, "run");
	try {
		const task = task_({ current_module_id: "billing" });
		await writeTask(directory, task);
		await writeStack(
			directory,
			stack_({
				modules: [
					module_(),
					module_({
						id: "billing",
						purpose: "invoices",
						folder: "src/billing",
						interface: "src/billing/api.ts",
						allowed_paths: ["src/billing/**", "test/billing/**"],
					}),
				],
			}),
		);
		const { module } = await freezeCurrentSlice(directory, runDirectory, task);

		// The union of every module is never the boundary: the other slice is out.
		for (const inside of [
			"src/billing/invoice.ts",
			"test/billing/invoice.test.ts",
			`src${sep}billing${sep}deep${sep}x.ts`,
		]) {
			await assertClaimInModule(directory, inside, module);
			assert.equal(moduleOwnsPath(directory, module, inside), true, inside);
		}
		for (const outside of ["src/auth/login.ts", "test/auth/login.test.ts", "src/billing-admin/x.ts", "README.md"]) {
			await assert.rejects(
				assertClaimInModule(directory, outside, module),
				/UNSAFE claim outside module billing/u,
				outside,
			);
			assert.equal(moduleOwnsPath(directory, module, outside), false, outside);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a wildcard pattern means exactly its segments, and only a literal folder implies descendants", () => {
	// The hole: `src/*` is one level. Letting it imply descendants turns every
	// single-level glob into a `**`.
	assert.equal(matchesPathPattern("src/*", "src/auth"), true);
	assert.equal(matchesPathPattern("src/*", "src/auth/deep/file.ts"), false);
	assert.equal(matchesPathPattern("src/*", "src/auth/file.ts"), false);
	assert.equal(matchesPathPattern("src/*/api.ts", "src/auth/deep/api.ts"), false);
	assert.equal(matchesPathPattern("src/auth/*.ts", "src/auth/deep/login.ts"), false);
	assert.equal(matchesPathPattern("test/?", "test/a/b"), false);
	// A literal folder still covers what is inside it.
	assert.equal(matchesPathPattern("src/auth", "src/auth/deep/file.ts"), true);
	assert.equal(matchesPathPattern("src/auth", "src/auth"), true);
	assert.equal(matchesPathPattern("src/auth", "src/auth-admin/file.ts"), false);
	// `**` still spans, including zero segments.
	assert.equal(matchesPathPattern("src/auth/**", "src/auth"), true);
	assert.equal(matchesPathPattern("src/auth/**", "src/auth/deep/file.ts"), true);

	// A module whose allowed paths are one level deep owns one level.
	const shallow = module_({ allowed_paths: ["src/auth/*", "test/auth/*"] });
	assert.equal(moduleOwnsPath("/project", shallow, "src/auth/login.ts"), true);
	assert.equal(
		moduleOwnsPath("/project", shallow, "src/auth/deep/login.ts"),
		false,
		"folder metadata cannot widen an explicit one-level allowed path",
	);
	const narrow = module_({ folder: "src/auth", allowed_paths: ["src/*"] });
	assert.equal(moduleOwnsPath("/project", narrow, "src/auth"), true);
	assert.equal(moduleOwnsPath("/project", narrow, "src/billing/deep/x.ts"), false, "src/* is not src/**");
});

test("a dangling link out of the project is refused, not reconstructed lexically", async () => {
	const parent = await mkdtemp(join(tmpdir(), "kpi-dune-parent-"));
	const directory = join(parent, "project");
	try {
		await mkdir(join(directory, "src", "auth"), { recursive: true });
		const auth = module_();

		// The link's target does not exist, so `realpath` reports ENOENT for it just
		// as it would for an absent file. Walking above it and rebuilding the path
		// lexically would accept this claim.
		await symlink(join(parent, "outside"), join(directory, "src", "auth", "escape"));
		await assert.rejects(
			assertClaimInModule(directory, "src/auth/escape/file.ts", auth),
			/escapes the project through a link/u,
			"a dangling link out of the tree is an escape",
		);
		// The same link, claimed directly.
		await assert.rejects(
			assertClaimInModule(directory, "src/auth/escape", auth),
			/escapes the project through a link/u,
		);

		// A relative dangling link that climbs out is the same escape.
		await symlink("../../../outside-relative", join(directory, "src", "auth", "climb"));
		await assert.rejects(
			assertClaimInModule(directory, "src/auth/climb/file.ts", auth),
			/escapes the project through a link/u,
		);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("a dangling link to another module inside the tree fails the module boundary", async () => {
	const directory = await fixture();
	try {
		const auth = module_();
		await mkdir(join(directory, "src", "auth"), { recursive: true });

		// Inside the project, outside the slice: `src/billing` need not exist for
		// the claim to be wrong.
		await symlink(join(directory, "src", "billing"), join(directory, "src", "auth", "sneak"));
		await assert.rejects(assertClaimInModule(directory, "src/auth/sneak/invoice.ts", auth), /after link resolution/u);

		// A relative dangling link to a sibling module is the same case.
		await symlink("../billing-admin", join(directory, "src", "auth", "sibling"));
		await assert.rejects(assertClaimInModule(directory, "src/auth/sibling/x.ts", auth), /after link resolution/u);

		// And a dangling link that stays inside the module is fine.
		await symlink("./real", join(directory, "src", "auth", "internal"));
		await assertClaimInModule(directory, "src/auth/internal/login.ts", auth);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a link chain longer than the bound fails closed", async () => {
	const directory = await fixture();
	try {
		const auth = module_();
		const folder = join(directory, "src", "auth");
		await mkdir(folder, { recursive: true });

		// Each hop stays inside the module, so nothing here is an escape: the claim
		// is refused because it cannot be resolved within the bound.
		const hops = MAX_LINK_RESOLUTION_STEPS + 8;
		for (let index = 0; index < hops; index += 1) {
			await symlink(`./hop-${index + 1}`, join(folder, `hop-${index}`));
		}
		await assert.rejects(
			assertClaimInModule(directory, `src/auth/hop-0/file.ts`, auth),
			/follows too many links to resolve/u,
			"an unresolvable claim is refused, never allowed",
		);

		// A short chain resolves normally.
		await symlink("./target", join(folder, "short"));
		await assertClaimInModule(directory, "src/auth/short/file.ts", auth);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("declared paths must be repository-relative, exact, and free of traversal", () => {
	// A leading slash used to be dropped by segment splitting and read as inside.
	for (const folder of ["/src/auth", "\\\\src\\\\auth", "C:/src/auth"]) {
		assert.throws(
			() => assertDuneStack(stack_({ modules: [module_({ folder, interface: `${folder}/api.ts` })] })),
			/must be repository-relative, not absolute/u,
			folder,
		);
	}
	for (const folder of ["src/../auth", "src/./auth", "src/auth/..", "./src/auth"]) {
		assert.throws(
			() => assertDuneStack(stack_({ modules: [module_({ folder })] })),
			/must not contain a \.\.? segment/u,
			folder,
		);
	}
	assert.throws(() => assertDuneStack(stack_({ modules: [module_({ folder: "src//auth" })] })), /empty path segment/u);
	assert.throws(() => assertDuneStack(stack_({ modules: [module_({ folder: "src/auth/" })] })), /empty path segment/u);
	// Globs belong in allowed_paths, not in the map's exact fields.
	assert.throws(
		() => assertDuneStack(stack_({ modules: [module_({ folder: "src/*", interface: "src/*/api.ts" })] })),
		/must name an exact path, not a pattern/u,
	);
	assert.throws(() => assertDuneStack(stack_({ root: "/src" })), /repository-relative/u);
	assert.throws(() => assertDuneStack(stack_({ root: "src/**" })), /exact path/u);
	// An allowed path may be a pattern, but never absolute or traversing.
	for (const allowed of ["/etc/passwd", "src/auth/../../etc", "src//auth/**"]) {
		assert.throws(
			() => assertDuneStack(stack_({ modules: [module_({ allowed_paths: [allowed, "test/auth/**"] })] })),
			/allowed_paths\[0\]/u,
			allowed,
		);
	}
	// An id is one segment.
	assert.throws(() => assertDuneStack(stack_({ modules: [module_({ id: "src/auth" })] })), /single path segment/u);
	// The folder has to live under the declared root.
	assert.throws(
		() =>
			assertDuneStack(
				stack_({
					root: "app",
					modules: [module_({ folder: "src/auth", interface: "src/auth/api.ts" })],
				}),
			),
		/must live under root app/u,
	);
});

test("allowed paths must admit the interface but tests have no prescribed layout", () => {
	assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["src/auth", "test/other/**"] })] }));
	assert.throws(
		() => assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["src/other/**"] })] })),
		DuneStackError,
	);
	assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["src/auth/*"] })] }));
});

test("a stack that disagrees with the contract about the slice is refused", async () => {
	const directory = await fixture();
	const runDirectory = join(directory, "run");
	try {
		const task = task_({ current_module_id: "auth" });
		await writeTask(directory, task);
		await writeStack(
			directory,
			stack_({
				current_module_id: "billing",
				modules: [
					module_(),
					module_({
						id: "billing",
						purpose: "invoices",
						folder: "src/billing",
						interface: "src/billing/api.ts",
						allowed_paths: ["src/billing/**", "test/billing/**"],
					}),
				],
			}),
		);
		await assert.rejects(
			freezeCurrentSlice(directory, runDirectory, task),
			/stack\.json names slice billing while task\.json names auth/u,
			"a disagreement is not a preference",
		);
		assert.equal(task.current_module_id, "auth", "and nothing was silently rewritten");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a stack with no hash and no contract to compare against is not fresh", async () => {
	const directory = await fixture();
	const runDirectory = join(directory, "run");
	try {
		await writeStack(directory, stack_({ current_module_id: "auth" }));
		await assert.rejects(
			freezeCurrentSlice(directory, runDirectory, task_({ current_module_id: "auth" })),
			/task\.json is missing, so stack\.json freshness cannot be established/u,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a link whose target hides another dangling link out of the project is refused", async () => {
	const parent = await mkdtemp(join(tmpdir(), "kpi-dune-nested-"));
	const directory = join(parent, "project");
	try {
		const auth = module_();
		await mkdir(join(directory, "src", "auth"), { recursive: true });

		// B is a dangling link out of the tree. A's target names B as an
		// intermediate component, so resolving A means inspecting B - collapsing
		// A's target with realpath stops above B and appends `B/file.ts` lexically,
		// which accepts the claim.
		await symlink(join(parent, "outside"), join(directory, "src", "auth", "B"));
		await symlink(join(directory, "src", "auth", "B", "file.ts"), join(directory, "src", "auth", "A"));

		await assert.rejects(
			assertClaimInModule(directory, "src/auth/A", auth),
			/escapes the project through a link/u,
			"a link reached through another dangling link is still an escape",
		);
		// Claiming through A as a directory component is the same escape.
		await symlink(join(directory, "src", "auth", "B"), join(directory, "src", "auth", "C"));
		await assert.rejects(
			assertClaimInModule(directory, "src/auth/C/deep/file.ts", auth),
			/escapes the project through a link/u,
		);
		// A relative nested chain climbs out just as well.
		await symlink("../../../outside-relative", join(directory, "src", "auth", "D"));
		await symlink("./D/file.ts", join(directory, "src", "auth", "E"));
		await assert.rejects(assertClaimInModule(directory, "src/auth/E", auth), /escapes the project through a link/u);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("a link whose target hides a dangling link to a sibling module fails the module boundary", async () => {
	const directory = await fixture();
	try {
		const auth = module_();
		await mkdir(join(directory, "src", "auth"), { recursive: true });

		// B dangles at another module inside the tree; A points through it.
		await symlink(join(directory, "src", "billing"), join(directory, "src", "auth", "B"));
		await symlink(join(directory, "src", "auth", "B", "invoice.ts"), join(directory, "src", "auth", "A"));
		await assert.rejects(
			assertClaimInModule(directory, "src/auth/A", auth),
			/after link resolution/u,
			"in the tree, outside the slice, reached through two links",
		);

		// A relative nested chain to a prefix-sibling is the same case.
		await symlink("../auth-admin", join(directory, "src", "auth", "P"));
		await symlink("./P/login.ts", join(directory, "src", "auth", "Q"));
		await assert.rejects(assertClaimInModule(directory, "src/auth/Q", auth), /after link resolution/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("nested links that stay inside the module resolve and are allowed", async () => {
	const directory = await fixture();
	try {
		const auth = module_();
		await mkdir(join(directory, "src", "auth", "real", "deep"), { recursive: true });
		await writeFile(join(directory, "src", "auth", "real", "deep", "login.ts"), "export {};\n");

		// A chain of links, each hop inside the slice, ending at a real file.
		await symlink(join(directory, "src", "auth", "real"), join(directory, "src", "auth", "alias"));
		await symlink("./alias/deep", join(directory, "src", "auth", "nested"));
		await symlink("./nested/login.ts", join(directory, "src", "auth", "entry"));

		await assertClaimInModule(directory, "src/auth/entry", auth);
		await assertClaimInModule(directory, "src/auth/nested/login.ts", auth);
		await assertClaimInModule(directory, "src/auth/alias/deep/login.ts", auth);
		// A dangling hop that stays inside the slice is still inside the slice.
		await symlink("./real/deep/absent.ts", join(directory, "src", "auth", "future"));
		await assertClaimInModule(directory, "src/auth/future", auth);
		// And the plain, linkless case is unaffected.
		await assertClaimInModule(directory, "src/auth/plain.ts", auth);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the plan summary names delivery, the current slice, and every module's bounds from stack.json alone", () => {
	// A plain object, no filesystem: the summary words a stack the driver already read.
	const stack = stack_({
		delivery: "horizontal",
		delivery_reason: "the schema must land before either slice",
		current_module_id: "auth",
		modules: [
			module_(),
			module_({
				id: "billing",
				purpose: "invoices and receipts",
				folder: "src/billing",
				interface: "src/billing/api.ts",
				allowed_paths: ["src/billing/**", "test/billing/**"],
				depends_on: ["auth"],
			}),
		],
	});
	assert.deepEqual(renderPlanSummary(stack).split("\n"), [
		"Delivery: horizontal — the schema must land before either slice",
		"Root: src",
		"Current slice: auth",
		"Modules (2):",
		"  1. auth — login and sessions",
		"     folder src/auth · interface src/auth/api.ts · 2 allowed path(s) · depends on nothing",
		"  2. billing — invoices and receipts",
		"     folder src/billing · interface src/billing/api.ts · 2 allowed path(s) · depends on auth",
	]);

	// A map that names no slice is still shown, and the operator is told what implement will do with it.
	const unnamed = renderPlanSummary(stack_()).split("\n");
	assert.equal(unnamed[0], "Delivery: vertical");
	assert.equal(unnamed[2], "Current slice: (none named — implement will refuse this map)");

	// The dialog is bounded: past the cap the summary points at the file.
	const many = stack_({
		current_module_id: "m1",
		modules: Array.from({ length: PLAN_SUMMARY_MAX_MODULES + 2 }, (_, index) =>
			module_({
				id: `m${index + 1}`,
				folder: `src/m${index + 1}`,
				interface: `src/m${index + 1}/api.ts`,
				allowed_paths: [`src/m${index + 1}/**`, `test/m${index + 1}/**`],
			}),
		),
	});
	const rendered = renderPlanSummary(many).split("\n");
	assert.equal(rendered[3], `Modules (${PLAN_SUMMARY_MAX_MODULES + 2}):`);
	assert.equal(rendered.filter((line) => /^ {2}\d+\. /u.test(line)).length, PLAN_SUMMARY_MAX_MODULES);
	assert.equal(rendered.at(-1), "  … and 2 more modules (see stack.json)");
});
