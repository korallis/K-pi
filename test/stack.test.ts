import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { contractHash, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import {
	assertClaimInModule,
	assertDuneStack,
	assertScaffoldedBeforeBehavior,
	type DuneStack,
	DuneStackError,
	freezeCurrentSlice,
	GENERIC_FOLDER_FILE_BUDGET,
	MAX_LINK_RESOLUTION_STEPS,
	matchesPathPattern,
	moduleOwnsPath,
	normalizeProjectPath,
	readDuneStack,
	resolveCurrentModule,
	type StackModule,
	scaffoldModule,
	stackRequiredFor,
	stackTaskHash,
	testTwinFor,
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

	// The declared test twin is owned even when `allowed_paths` omits it.
	const spare = module_({ allowed_paths: ["src/auth/**"] });
	assert.equal(moduleOwnsPath(directory, spare, `${testTwinFor(spare)}/login.test.ts`), true);
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

test("folder name equals id, and auth never lives in a layer bucket", () => {
	assertDuneStack(stack_());
	assert.throws(
		() => assertDuneStack(stack_({ modules: [module_({ folder: "src/authentication" })] })),
		/must match id/u,
	);
	assert.throws(
		() =>
			assertDuneStack(
				stack_({
					modules: [
						module_({
							folder: "src/lib/auth",
							interface: "src/lib/auth/api.ts",
							allowed_paths: ["src/lib/auth/**", "test/auth/**"],
						}),
					],
				}),
			),
		/Auth must live in its auth folder/u,
	);
	assert.throws(
		() =>
			assertDuneStack(
				stack_({
					modules: [
						module_({
							folder: "src/services/auth",
							interface: "src/services/auth/api.ts",
							allowed_paths: ["src/services/auth/**", "test/auth/**"],
						}),
					],
				}),
			),
		/Auth must live in its auth folder/u,
	);
	// A non-auth capability may still be nested.
	assertDuneStack(
		stack_({
			modules: [
				module_({
					id: "invoices",
					purpose: "invoice rendering",
					folder: "src/billing/invoices",
					interface: "src/billing/invoices/api.ts",
					allowed_paths: ["src/billing/invoices/**", "test/invoices/**"],
				}),
			],
		}),
	);
	// The interface must live inside the folder it belongs to.
	assert.throws(
		() => assertDuneStack(stack_({ modules: [module_({ interface: "src/api.ts" })] })),
		/Interface must live inside/u,
	);
});

test("layer folders are nested-only and generic folders need a tight purpose", () => {
	for (const layer of ["components", "hooks", "services", "controllers", "api", "ui"]) {
		assert.throws(
			() =>
				assertDuneStack(
					stack_({
						modules: [
							module_({
								id: layer,
								purpose: `all ${layer} for the app`,
								folder: `src/${layer}`,
								interface: `src/${layer}/api.ts`,
								allowed_paths: [`src/${layer}/**`, `test/${layer}/**`],
							}),
						],
					}),
				),
			/cannot be a top-level module|layer sweep/u,
			layer,
		);
	}
	// The same layer name nested inside a feature is legal.
	assertDuneStack(
		stack_({
			modules: [
				module_({
					id: "components",
					purpose: "auth specific components",
					folder: "src/auth/components",
					interface: "src/auth/components/api.ts",
					allowed_paths: ["src/auth/components/**", "test/components/**"],
				}),
			],
		}),
	);

	for (const generic of ["utils", "helpers", "common", "misc"]) {
		assert.throws(
			() =>
				assertDuneStack(
					stack_({
						modules: [
							module_({
								id: generic,
								purpose: "stuff",
								folder: `src/${generic}`,
								interface: `src/${generic}/api.ts`,
								allowed_paths: [`src/${generic}/**`, `test/${generic}/**`],
							}),
						],
					}),
				),
			/tight purpose/u,
			generic,
		);
		assertDuneStack(
			stack_({
				modules: [
					module_({
						id: generic,
						purpose: "currency formatting helpers only",
						folder: `src/${generic}`,
						interface: `src/${generic}/api.ts`,
						allowed_paths: [`src/${generic}/**`, `test/${generic}/**`],
					}),
				],
			}),
		);
	}
});

test("a generic folder past its file budget fails the gate", async () => {
	const directory = await fixture();
	try {
		const stack = stack_({
			current_module_id: "utils",
			modules: [
				module_({
					id: "utils",
					purpose: "currency formatting helpers only",
					folder: "src/utils",
					interface: "src/utils/api.ts",
					allowed_paths: ["src/utils/**", "test/utils/**"],
				}),
			],
		});
		const task = task_({ current_module_id: "utils" });
		await writeTask(directory, task);
		await writeStack(directory, stack);
		await freezeCurrentSlice(directory, join(directory, "run"), task);

		await mkdir(join(directory, "src", "utils"), { recursive: true });
		for (let index = 0; index < GENERIC_FOLDER_FILE_BUDGET; index += 1) {
			await writeFile(join(directory, "src", "utils", `file-${index}.ts`), "export {};\n");
		}
		await assert.rejects(
			freezeCurrentSlice(directory, join(directory, "run"), task),
			/Generic folder src\/utils holds 5 files/u,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared is extracted only when a second slice needs it", () => {
	const shared = module_({
		id: "shared",
		purpose: "types used by two slices",
		folder: "src/shared",
		interface: "src/shared/api.ts",
		allowed_paths: ["src/shared/**", "test/shared/**"],
	});
	const auth = module_({ depends_on: ["shared"] });
	const billing = module_({
		id: "billing",
		purpose: "invoices and plans",
		folder: "src/billing",
		interface: "src/billing/api.ts",
		allowed_paths: ["src/billing/**", "test/billing/**"],
		depends_on: ["shared"],
	});

	// One consumer: it belongs inside that consumer.
	assert.throws(
		() => assertDuneStack(stack_({ modules: [shared, auth] })),
		/shared needs two consuming slices before extraction; 1 declared/u,
	);
	// No consumer at all is an extraction that has not earned itself.
	assert.throws(() => assertDuneStack(stack_({ modules: [shared] })), /0 declared/u);
	// Two consumers: legitimate.
	assertDuneStack(stack_({ modules: [shared, auth, billing] }));
});

test("vertical delivery cannot stage a layer sweep, and horizontal needs a reason", () => {
	assert.throws(
		() =>
			assertDuneStack(
				stack_({
					modules: [
						module_({
							id: "endpoints",
							purpose: "all APIs for every feature",
							folder: "src/endpoints",
							interface: "src/endpoints/api.ts",
							allowed_paths: ["src/endpoints/**", "test/endpoints/**"],
						}),
					],
				}),
			),
		/layer sweep/u,
	);
	assert.throws(
		() =>
			assertDuneStack(
				stack_({
					modules: [
						module_({
							id: "api",
							purpose: "http surface",
							folder: "src/nested/api",
							interface: "src/nested/api/api.ts",
							allowed_paths: ["src/nested/api/**", "test/api/**"],
						}),
						module_({
							id: "ui",
							purpose: "screens",
							folder: "src/nested/ui",
							interface: "src/nested/ui/api.ts",
							allowed_paths: ["src/nested/ui/**", "test/ui/**"],
						}),
					],
				}),
			),
		/layer staging plan/u,
		"API-then-UI staging is horizontal work, whatever the field says",
	);
	// Declared horizontal work with a reason is allowed.
	assertDuneStack(
		stack_({
			delivery: "horizontal",
			delivery_reason: "framework migration touches every route at once",
			modules: [
				module_({
					id: "api",
					purpose: "http surface",
					folder: "src/nested/api",
					interface: "src/nested/api/api.ts",
					allowed_paths: ["src/nested/api/**", "test/api/**"],
				}),
				module_({
					id: "ui",
					purpose: "screens",
					folder: "src/nested/ui",
					interface: "src/nested/ui/api.ts",
					allowed_paths: ["src/nested/ui/**", "test/ui/**"],
				}),
			],
		}),
	);
	assert.throws(() => assertDuneStack(stack_({ delivery: "horizontal" })), /Horizontal delivery requires a reason/u);
	assert.throws(
		() => assertDuneStack(stack_({ delivery: "horizontal", delivery_reason: "   " })),
		/requires a reason/u,
	);
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
		await assert.rejects(freezeCurrentSlice(directory, runDirectory, task), /Invalid Dune stack header/u);

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

test("scaffold creates folder, interface, then test twin, before any behaviour", async () => {
	const directory = await fixture();
	try {
		const auth = module_();
		const result = await scaffoldModule(directory, auth);
		assert.deepEqual(
			result.steps,
			["src/auth", "src/auth/api.ts", "test/auth/index.test.ts"],
			"the order is the contract",
		);
		assert.equal((await stat(join(directory, "src", "auth"))).isDirectory(), true);
		assert.equal((await stat(result.interface)).isFile(), true);
		assert.equal((await stat(result.testTwin)).isFile(), true);
		await assertScaffoldedBeforeBehavior(directory, auth);

		// Behaviour without the scaffold is the UNSAFE case.
		const bare = await fixture();
		try {
			await mkdir(join(bare, "src", "auth"), { recursive: true });
			await writeFile(join(bare, "src", "auth", "login.ts"), "export const login = () => {};\n");
			await assert.rejects(
				assertScaffoldedBeforeBehavior(bare, auth),
				/behaviour \(src\/auth\/login\.ts\) before its scaffold/u,
			);
			// Interface present but no test twin is still incomplete.
			await writeFile(join(bare, "src", "auth", "api.ts"), "export {};\n");
			await assert.rejects(assertScaffoldedBeforeBehavior(bare, auth), /missing test\/auth\/index\.test\.ts/u);
			await mkdir(join(bare, "test", "auth"), { recursive: true });
			await writeFile(join(bare, "test", "auth", "index.test.ts"), "export {};\n");
			await assertScaffoldedBeforeBehavior(bare, auth);
		} finally {
			await rm(bare, { recursive: true, force: true });
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("scaffolding is idempotent and never rewrites existing content", async () => {
	const directory = await fixture();
	try {
		const auth = module_();
		await scaffoldModule(directory, auth);
		await writeFile(join(directory, "src", "auth", "api.ts"), "export const real = 1;\n");
		const again = await scaffoldModule(directory, auth);
		assert.equal(
			await readFile(again.interface, "utf8"),
			"export const real = 1;\n",
			"an existing interface survives",
		);
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
		true,
		"the declared folder itself still covers its descendants",
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

test("allowed-path coverage is asked about a real path, not pattern against pattern", () => {
	// A pattern that does not admit anything inside the folder fails, even though
	// it shares a prefix with it.
	assert.throws(
		() => assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["src/auth", "test/other/**"] })] })),
		/lacks its test twin/u,
	);
	assert.throws(
		() => assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["src/other/**", "test/auth/**"] })] })),
		/does not allow its own folder/u,
	);
	// A one-level glob covers a file directly inside the folder.
	assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["src/auth/*", "test/auth/*"] })] }));
	// A literal folder covers it too.
	assertDuneStack(stack_({ modules: [module_({ allowed_paths: ["src/auth", "test/auth"] })] }));
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

test("an unreadable generic folder is never treated as empty", async () => {
	const directory = await fixture();
	try {
		const stack = stack_({
			current_module_id: "utils",
			modules: [
				module_({
					id: "utils",
					purpose: "currency formatting helpers only",
					folder: "src/utils",
					interface: "src/utils/api.ts",
					allowed_paths: ["src/utils/**", "test/utils/**"],
				}),
			],
		});
		const task = task_({ current_module_id: "utils" });
		await writeTask(directory, task);
		await writeStack(directory, stack);

		// A file where the folder should be: reading it is an I/O error, not an
		// absence, and a budget check that swallowed it would report zero files.
		await mkdir(join(directory, "src"), { recursive: true });
		await writeFile(join(directory, "src", "utils"), "not a directory\n");
		await assert.rejects(
			freezeCurrentSlice(directory, join(directory, "run"), task),
			(error: unknown) => error instanceof Error && !/holds 0 files/u.test(error.message),
			"an I/O failure surfaces instead of passing the budget",
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
