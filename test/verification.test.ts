import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { type JsonSchema, validateJsonSchema } from "../packages/coding-agent/src/kpi/extensions/graph/json-schema.ts";
import {
	assertVerificationFresh,
	executeVerification,
	HOST_VERIFIER_ID,
	type HostEvidence,
	readVerification,
	VERIFICATION_EXCERPT_BYTES,
	type VerificationOptions,
} from "../packages/coding-agent/src/kpi/extensions/graph/verification.ts";
import { createJob, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";

const execFileAsync = promisify(execFile);
const nodeCommand = `"${process.execPath}" check.cjs`;

interface Fixture {
	root: string;
	runDirectory: string;
	task: Task;
	options: VerificationOptions;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>, configure?: (task: Task) => void): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "kpi-host-verification-"));
	const task: Task = {
		job_id: "host-verification",
		mode: "gated",
		goal: "Verify protected acceptance independently",
		nongoals: [],
		acceptance: [
			{
				id: "AC-1",
				statement: "The protected command succeeds",
				required: true,
				check: { kind: "command", cmd: nodeCommand, expect: { exit: 0 } },
			},
		],
		constraints: [],
		quality_gates: [],
		ac: { quality: "executable" },
	};
	configure?.(task);
	const job = await createJob(root, task, "protected verification fixture");
	await writeFile(join(root, "check.cjs"), "process.stdout.write('observed output');\n");
	const options: VerificationOptions = {
		projectRoot: root,
		runDirectory: job.directory,
		task,
		treeHash: "candidate-tree-a",
		verifierId: HOST_VERIFIER_ID,
	};
	try {
		await body({ root, runDirectory: job.directory, task, options });
	} finally {
		// Immutable receipt directories are only unlocked for removal of this isolated fixture.
		const directory = join(job.directory, "verification");
		for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
			if (entry.isDirectory()) await chmod(join(directory, entry.name), 0o700);
		}
		await rm(root, { recursive: true, force: true });
	}
}

/** Simulates corrupted host metadata, not a model publication channel; raw receipts remain independent. */
async function replaceBundle(fixture: Fixture, evidence: HostEvidence): Promise<void> {
	const immutable = join(fixture.runDirectory, evidence.record_path);
	await chmod(immutable, 0o600);
	await writeFile(immutable, JSON.stringify(evidence));
	await chmod(immutable, 0o400);
	await writeFile(join(fixture.runDirectory, "evidence.json"), JSON.stringify(evidence));
}

test("real host receipts honor nonzero expected exits and preserve complete large stdout/stderr", async () => {
	await withFixture(
		async (fixture) => {
			const output = `begin:${"x".repeat(250_000)}:late-needle:終わり`;
			const stderr = `diagnostic:${"e".repeat(120_000)}`;
			await writeFile(
				join(fixture.root, "check.cjs"),
				`process.stdout.write(${JSON.stringify(output)}, () => process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(7)));`,
			);
			await writeFile(
				join(fixture.root, "quality.cjs"),
				"require('node:fs').writeFileSync('quality-ran', 'real gate');",
			);
			await execFileAsync("git", ["init", "-q"], { cwd: fixture.root });
			await execFileAsync(
				"git",
				[
					"-c",
					"user.name=Verifier",
					"-c",
					"user.email=verifier@example.invalid",
					"commit",
					"--allow-empty",
					"-qm",
					"fixture",
				],
				{ cwd: fixture.root },
			);
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, true);
			assert.equal(await readFile(join(fixture.root, "quality-ran"), "utf8"), "real gate");
			assert.equal(
				result.evidence.head,
				(await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim(),
			);
			const receipt = result.evidence.commands[1];
			assert.equal(receipt.exit, 7);
			assert.deepEqual(receipt.expectation, { exit_matches: true, stdout_matches: [true, true, true] });
			assert.equal(receipt.stdout.excerpt.includes("late-needle"), false);
			assert.ok(Buffer.byteLength(receipt.stdout.excerpt) <= VERIFICATION_EXCERPT_BYTES + 3);
			for (const [artifact, expected] of [
				[receipt.stdout, output],
				[receipt.stderr, stderr],
			] as const) {
				const raw = await readFile(join(fixture.runDirectory, artifact.path));
				assert.deepEqual(raw, Buffer.from(expected));
				assert.equal(artifact.bytes, raw.length);
				assert.equal(artifact.sha256, createHash("sha256").update(raw).digest("hex"));
			}
			assert.equal((await assertVerificationFresh(fixture.options)).passed, true);
			for (const [name, payload] of [
				["evidence", result.evidence],
				["goal", result.goals],
				["intent", JSON.parse(await readFile(join(fixture.runDirectory, "intent.json"), "utf8"))],
			] as const) {
				const schema = JSON.parse(
					await readFile(
						new URL(`../packages/coding-agent/src/kpi/schemas/${name}.schema.json`, import.meta.url),
						"utf8",
					),
				) as JsonSchema;
				assert.deepEqual(validateJsonSchema(payload, schema), []);
			}
		},
		(task) => {
			task.quality_gates = [`"${process.execPath}" quality.cjs`];
			task.acceptance[0].check!.expect = { exit: 7, stdout_includes: ["begin:", "late-needle", "終わり"] };
		},
	);
});

test("each stdout expectation is checked independently beyond the context excerpt", async () => {
	await withFixture(
		async (fixture) => {
			await writeFile(
				join(fixture.root, "check.cjs"),
				"process.stdout.write('x'.repeat(200000) + 'present-at-end');",
			);
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, false);
			assert.deepEqual(result.evidence.commands[0].expectation, {
				exit_matches: true,
				stdout_matches: [true, false],
			});
			assert.equal(result.goals.goals[0].status, "failed");
			await assert.rejects(assertVerificationFresh(fixture.options), /not complete/);
		},
		(task) => {
			task.acceptance[0].check!.expect = { exit: 0, stdout_includes: ["present-at-end", "missing-at-end"] };
		},
	);
});

test("quality gates cannot borrow an acceptance criterion's nonzero expected exit", async () => {
	await withFixture(
		async (fixture) => {
			await writeFile(join(fixture.root, "check.cjs"), "process.exit(7);");
			const result = await executeVerification(fixture.options);
			assert.equal(result.evidence.ac_results[0].passed, true);
			assert.equal(result.evidence.commands[0].passed, false);
			assert.equal(result.passed, false);
			await assert.rejects(assertVerificationFresh(fixture.options), /not complete/);
		},
		(task) => {
			task.quality_gates = [nodeCommand];
			task.acceptance[0].check!.expect = { exit: 7 };
		},
	);
});

test("missing, fabricated and wrong-command evidence cannot authorize acceptance", async () => {
	await withFixture(async (fixture) => {
		await writeFile(
			join(fixture.runDirectory, "evidence.json"),
			JSON.stringify({
				head: "fake",
				commands: [{ cmd: "true", exit: 0 }],
				ac_results: [{ id: "AC-1", passed: true }],
			}),
		);
		await assert.rejects(readVerification(fixture.options), /Invalid host evidence/);
		const result = await executeVerification(fixture.options);
		const mutations: Array<(evidence: HostEvidence) => void> = [
			(evidence) => {
				evidence.commands = [];
			},
			(evidence) => {
				evidence.commands[0].cmd = "true";
			},
			(evidence) => {
				evidence.ac_results = [];
			},
			(evidence) => {
				evidence.ac_results.push({ ...evidence.ac_results[0] });
			},
			(evidence) => {
				evidence.commands[0].expectation.stdout_matches = [true];
			},
		];
		for (const mutate of mutations) {
			const evidence = structuredClone(result.evidence);
			mutate(evidence);
			await replaceBundle(fixture, evidence);
			await assert.rejects(readVerification(fixture.options));
		}
		await replaceBundle(fixture, structuredClone(result.evidence));
		const rawPath = join(fixture.runDirectory, result.evidence.commands[0].stdout.path);
		await chmod(rawPath, 0o600);
		await writeFile(rawPath, "forged successful output");
		await assert.rejects(readVerification(fixture.options), /Raw evidence/);
		await chmod(join(fixture.runDirectory, "verification", result.evidence.run_id), 0o700);
		await rm(rawPath);
		await assert.rejects(readVerification(fixture.options), /ENOENT/);
	});
});

test("changed intent, candidate tree and cwd invalidate receipts, and earlier records remain immutable", async () => {
	await withFixture(async (fixture) => {
		const first = await executeVerification(fixture.options);
		const firstBytes = await readFile(join(fixture.runDirectory, first.evidence.record_path));
		await assert.rejects(
			readVerification({ ...fixture.options, treeHash: "candidate-tree-b" }),
			/Stale verification/,
		);
		await assert.rejects(
			readVerification({ ...fixture.options, task: { ...fixture.task, goal: "weakened goal" } }),
			/Protected intent changed/,
		);
		await assert.rejects(
			readVerification({ ...fixture.options, projectRoot: join(fixture.root, "elsewhere") }),
			/cwd changed/,
		);
		const second = await executeVerification({ ...fixture.options, treeHash: "candidate-tree-b" });
		assert.notEqual(second.evidence.run_id, first.evidence.run_id);
		assert.deepEqual(await readFile(join(fixture.runDirectory, first.evidence.record_path)), firstBytes);
		await assert.rejects(assertVerificationFresh(fixture.options), /Stale verification/);
	});
});

test("cancellation kills the command and preserves interrupted stdout plus receipts for unlaunched checks", {
	timeout: 10_000,
}, async () => {
	await withFixture(
		async (fixture) => {
			const abort = new AbortController();
			const watcher = watch(fixture.root, (_event, name) => {
				if (name?.toString() === "started") abort.abort();
			});
			try {
				await writeFile(
					join(fixture.root, "check.cjs"),
					"const fs = require('node:fs'); fs.writeSync(1, 'before cancellation'); fs.writeSync(2, 'interrupted diagnostic'); fs.writeFileSync('started', 'yes'); fs.watch('.', () => {});",
				);
				const result = await executeVerification({ ...fixture.options, signal: abort.signal });
				assert.equal(result.passed, false);
				assert.deepEqual(
					result.evidence.commands.map((receipt) => receipt.status),
					["cancelled", "cancelled"],
				);
				assert.equal(
					await readFile(join(fixture.runDirectory, result.evidence.commands[0].stdout.path), "utf8"),
					"before cancellation",
				);
				assert.equal(
					await readFile(join(fixture.runDirectory, result.evidence.commands[0].stderr.path), "utf8"),
					"interrupted diagnostic",
				);
				assert.equal(result.evidence.commands[1].stdout.bytes, 0);
				assert.equal((await readVerification(fixture.options)).goals.goals[0].status, "blocked");
			} finally {
				watcher.close();
			}
		},
		(task) => {
			task.quality_gates = [nodeCommand];
		},
	);
});

test("pre-aborted verification never launches the protected command", async () => {
	await withFixture(async (fixture) => {
		await writeFile(join(fixture.root, "check.cjs"), "require('node:fs').writeFileSync('must-not-exist', 'ran');");
		const result = await executeVerification({ ...fixture.options, signal: AbortSignal.abort() });
		assert.equal(result.evidence.commands[0].status, "cancelled");
		assert.equal(result.evidence.commands[0].stdout.bytes, 0);
		await assert.rejects(readFile(join(fixture.root, "must-not-exist")), /ENOENT/);
		await assert.rejects(assertVerificationFresh(fixture.options), /not complete/);
	});
});

test("real subprocess launch failure persists an unverified receipt rather than success or lost output", async () => {
	await withFixture(async (fixture) => {
		const options = { ...fixture.options, projectRoot: join(fixture.root, "missing-working-directory") };
		const result = await executeVerification(options);
		assert.equal(result.passed, false);
		assert.equal(result.evidence.commands[0].status, "launch_failed");
		assert.match(result.evidence.commands[0].error!, /ENOENT/);
		assert.equal(result.evidence.commands[0].stdout.bytes, 0);
		assert.equal(result.evidence.ac_results[0].status, "blocked");
		assert.equal((await readVerification(options)).passed, false);
	});
});

test("malformed structured and narrative checks remain explicitly unverified", async () => {
	await withFixture(
		async (fixture) => {
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, false);
			assert.deepEqual(
				result.evidence.ac_results.map((entry) => entry.status),
				["unverified", "unverified"],
			);
			assert.equal(result.evidence.commands.length, 0);
			await assert.rejects(assertVerificationFresh(fixture.options), /not complete/);
		},
		(task) => {
			task.acceptance = [
				{ id: "AC-file", statement: "A file exists", required: true, check: { kind: "file_exists" } },
				{ id: "AC-story", statement: "Narrative acceptance", required: true },
			];
		},
	);
});

test("builder identity cannot execute or publish final verification", async () => {
	await withFixture(async (fixture) => {
		await assert.rejects(executeVerification({ ...fixture.options, verifierId: "builder-1" }), /builder/);
		await assert.rejects(readFile(join(fixture.runDirectory, "evidence.json")), /ENOENT/);
		const result = await executeVerification(fixture.options);
		const forged = structuredClone(result.evidence);
		forged.verifier_id = "builder-1";
		await replaceBundle(fixture, forged);
		await assert.rejects(assertVerificationFresh(fixture.options), /Invalid host evidence/);
	});
});

test("synchronous subprocess launch errors retain authoritative failure records", async () => {
	await withFixture(
		async (fixture) => {
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, false);
			assert.equal(result.evidence.commands[0].status, "launch_failed");
			assert.match(result.evidence.commands[0].error!, /null bytes/);
			assert.equal((await readVerification(fixture.options)).passed, false);
		},
		(task) => {
			task.acceptance[0].check!.cmd = "printf '\u0000'";
		},
	);
});

test("optional unverified goals remain unknown without blocking independently proven required goals", async () => {
	await withFixture(
		async (fixture) => {
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, true);
			assert.deepEqual(
				result.goals.goals.map((goal) => goal.status),
				["passed", "unverified"],
			);
			assert.equal((await assertVerificationFresh(fixture.options)).passed, true);
		},
		(task) => {
			task.acceptance.push({ id: "AC-optional", statement: "Optional observation", required: false });
		},
	);
});

test("goal projection edits cannot turn a failed host receipt into completion", async () => {
	await withFixture(async (fixture) => {
		await writeFile(join(fixture.root, "check.cjs"), "process.exit(1);");
		const result = await executeVerification(fixture.options);
		for (const goal of result.goals.goals) goal.status = "passed";
		await writeFile(join(fixture.runDirectory, "goals.json"), JSON.stringify(result.goals));
		await assert.rejects(assertVerificationFresh(fixture.options), /not complete/);
	});
});

test("signal termination is distinct from an expected numeric exit and retains raw output", async () => {
	await withFixture(
		async (fixture) => {
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, false);
			assert.equal(result.evidence.commands[0].status, "signaled");
			assert.equal(result.evidence.commands[0].signal, "SIGTERM");
			assert.equal(result.evidence.commands[0].exit, null);
			assert.equal(
				await readFile(join(fixture.runDirectory, result.evidence.commands[0].stdout.path), "utf8"),
				"before-signal",
			);
		},
		(task) => {
			task.acceptance[0].check!.cmd = "printf before-signal; kill -TERM $$";
		},
	);
});

test("an empty evidence inventory cannot authorize vacuous completion", async () => {
	await withFixture(
		async (fixture) => {
			await assert.rejects(executeVerification(fixture.options), /requires a protected acceptance/);
			await assert.rejects(readFile(join(fixture.runDirectory, "evidence.json")), /ENOENT/);
		},
		(task) => {
			task.acceptance = [];
			task.quality_gates = [];
		},
	);
});

test("an accepted journey requires every linked check even when one criterion is otherwise optional", async () => {
	await withFixture(
		async (fixture) => {
			await writeFile(join(fixture.root, "check.cjs"), "process.exitCode = 1;\n");
			const failed = await executeVerification(fixture.options);
			assert.equal(failed.passed, false);
			assert.equal(failed.goals.goals.find((goal) => goal.journey_id === "login")?.status, "failed");
			await assert.rejects(assertVerificationFresh(fixture.options), /not complete/);
			await writeFile(join(fixture.root, "check.cjs"), "process.stdout.write('complete journey');\n");
			const passed = await executeVerification({ ...fixture.options, treeHash: "candidate-tree-b" });
			const journey = passed.goals.goals.find((goal) => goal.journey_id === "login")!;
			assert.equal(passed.passed, true);
			assert.equal(journey.status, "passed");
			assert.deepEqual(journey.receipt_ids, [passed.evidence.commands[0].receipt_id]);
		},
		(task) => {
			task.acceptance[0].required = false;
			task.intent_details = {
				users: ["existing user"],
				journeys: [
					{
						id: "login",
						actor: "existing user",
						entry: "login page",
						steps: ["authenticate", "reach account"],
						acceptance_ids: ["AC-1"],
					},
				],
			};
		},
	);
});

test("structured filesystem predicates preserve bytes, distinguish missing from null, and honor expected mismatch", async () => {
	await withFixture(
		async (fixture) => {
			await writeFile(join(fixture.root, "data.json"), '{"a/b":{"~key":null},"items":[7]}\n');
			await symlink("missing-target", join(fixture.root, "dangling"));
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, true);
			assert.deepEqual(
				result.evidence.commands.map((receipt) => receipt.exit),
				[0, 0, 0, 0, 0, 1, 1],
			);
			assert.equal(
				await readFile(join(fixture.runDirectory, result.evidence.commands[4].stdout.path), "utf8"),
				'{"a/b":{"~key":null},"items":[7]}\n',
			);
			assert.equal((await assertVerificationFresh(fixture.options)).passed, true);
			const raw = join(fixture.runDirectory, result.evidence.commands[4].stdout.path);
			await chmod(raw, 0o600);
			await writeFile(raw, '{"a/b":{"~key":"forged"}}');
			await assert.rejects(readVerification(fixture.options), /Raw evidence/);
		},
		(task) => {
			task.acceptance = [
				{ kind: "file_exists", path: "dangling" },
				{ kind: "file_absent", path: "missing" },
				{ kind: "grep_matches", path: "data.json", pattern: '"items":\\[7\\]' },
				{ kind: "grep_empty", path: "data.json", pattern: "forbidden" },
				{ kind: "json_path", path: "data.json", pointer: "/a~1b/~0key", equals: null },
				{ kind: "json_path", path: "data.json", pointer: "/missing", equals: null, expect: { exit: 1 } },
				{ kind: "json_path", path: "data.json", pointer: "/items/01", equals: 7, expect: { exit: 1 } },
			].map((check, index) => ({
				id: `AC-${index}`,
				statement: "Observe protected filesystem predicate",
				required: true,
				check: check as NonNullable<Task["acceptance"][number]["check"]>,
			}));
		},
	);
});

test("structured observation errors cannot be accepted as an expected predicate mismatch", async () => {
	await withFixture(
		async (fixture) => {
			await writeFile(join(fixture.root, "invalid.json"), "{broken");
			const result = await executeVerification(fixture.options);
			assert.equal(result.passed, false);
			assert.deepEqual(
				result.evidence.commands.map((receipt) => receipt.exit),
				[2, 2, 2],
			);
			assert.deepEqual(
				result.evidence.ac_results.map((entry) => entry.status),
				["failed", "failed", "failed", "unverified", "unverified"],
			);
			assert.match(
				await readFile(join(fixture.runDirectory, result.evidence.commands[0].stderr.path), "utf8"),
				/ENOENT/,
			);
			await assert.rejects(assertVerificationFresh(fixture.options), /not complete/);
		},
		(task) => {
			task.acceptance = [
				{ kind: "grep_empty", path: "missing", pattern: "anything", expect: { exit: 1 } },
				{ kind: "json_path", path: "invalid.json", pointer: "", equals: null, expect: { exit: 1 } },
				{ kind: "file_absent", path: "check.cjs/child", expect: { exit: 1 } },
				{ kind: "file_exists", path: "check.cjs", expect: { exit: 2 } },
				{ kind: "file_exists", path: "check.cjs", cmd: "true" },
			].map((check, index) => ({
				id: `AC-${index}`,
				statement: "Fail closed on unusable observations",
				required: true,
				check: check as NonNullable<Task["acceptance"][number]["check"]>,
			}));
		},
	);
});

test("HTTP probes retain actual response evidence, reject external URLs, never redirect, and bound hanging or oversized bodies", {
	timeout: 15_000,
}, async () => {
	let escaped = false;
	const server = createServer((request, response) => {
		if (request.url === "/hang") return;
		if (request.url === "/escaped") escaped = true;
		if (request.url === "/redirect") {
			response.writeHead(302, { location: "/escaped" });
			response.end("redirect response");
		} else if (request.url === "/large") {
			response.end("x".repeat(20000));
		} else {
			response.writeHead(201, { "content-type": "application/json" });
			response.end('{"status":"observed"}');
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const base = `http://localhost:${address.port}`;
	try {
		await withFixture(
			async (fixture) => {
				const result = await executeVerification(fixture.options);
				assert.equal(result.passed, false);
				assert.equal(escaped, false);
				assert.deepEqual(
					result.evidence.commands.map((receipt) => receipt.exit),
					[0, 1, 2, 2],
				);
				assert.deepEqual(
					result.evidence.ac_results.map((entry) => entry.status),
					["passed", "passed", "failed", "failed", "unverified"],
				);
				assert.equal(
					await readFile(join(fixture.runDirectory, result.evidence.commands[0].stdout.path), "utf8"),
					'{"status":"observed"}',
				);
				assert.equal(
					JSON.parse(await readFile(join(fixture.runDirectory, result.evidence.commands[0].stderr.path), "utf8"))
						.status,
					201,
				);
				assert.equal(
					JSON.parse(await readFile(join(fixture.runDirectory, result.evidence.commands[1].stderr.path), "utf8"))
						.status,
					302,
				);
				assert.equal((await readVerification(fixture.options)).passed, false);
			},
			(task) => {
				task.acceptance = [
					{ kind: "http_probe", url: `${base}/ok`, status: 201, expect: { stdout_includes: ['"observed"'] } },
					{ kind: "http_probe", url: `${base}/redirect`, expect: { exit: 1 } },
					{ kind: "http_probe", url: `${base}/hang`, timeout_ms: 100, expect: { exit: 1 } },
					{ kind: "http_probe", url: `${base}/large`, max_bytes: 100, expect: { exit: 1 } },
					{ kind: "http_probe", url: "http://example.invalid/" },
				].map((check, index) => ({
					id: `AC-${index}`,
					statement: "Observe bounded local HTTP",
					required: true,
					check: check as NonNullable<Task["acceptance"][number]["check"]>,
				}));
			},
		);
	} finally {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
		await promise;
	}
});
