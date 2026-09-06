import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { getKpiResourceDir } from "../../../config.ts";

import { assertProtectedIntent, atomicWrite, type Task } from "../run-store.ts";
import { compileAcceptanceCheck } from "./ac-compiler.ts";
import {
	createGoalGraph,
	type GoalGraph,
	type GoalStatus,
	projectGoalGraph,
	unfulfilledRequiredGoals,
} from "./goals.ts";
import { type JsonSchema, validateJsonSchema } from "./json-schema.ts";
import { canonicalFingerprint } from "./stop.ts";

/** Reserved for this host executor, never an agent-selected identity or a builder capability. */
export const HOST_VERIFIER_ID = "host:verification";
export const VERIFICATION_EXCERPT_BYTES = 4096;

const execFileAsync = promisify(execFile);

export interface OutputArtifact {
	path: string;
	sha256: string;
	bytes: number;
	excerpt: string;
}

interface CommandSpec {
	command_id: string;
	source: "quality_gate" | "acceptance";
	criterion_id?: string;
	cmd: string;
	expected_exit: number;
	stdout_includes: string[];
}

export interface CommandReceipt extends CommandSpec {
	receipt_id: string;
	run_id: string;
	job_id: string;
	intent_hash: string;
	tree_hash: string;
	verifier_id: string;
	cwd: string;
	started_at: string;
	completed_at: string;
	status: "exited" | "signaled" | "cancelled" | "launch_failed";
	exit: number | null;
	signal: string | null;
	error: string | null;
	stdout: OutputArtifact;
	stderr: OutputArtifact;
	expectation: { exit_matches: boolean; stdout_matches: boolean[] };
	passed: boolean;
}

export interface AcceptanceResult {
	id: string;
	passed: boolean;
	status: GoalStatus;
	receipt_ids: string[];
	reasons: string[];
}

export interface HostEvidence {
	version: 1;
	job_id: string;
	run_id: string;
	intent_hash: string;
	tree_hash: string;
	/** Observed Git revision metadata; tree_hash, not HEAD, is the candidate freshness authority. */
	head: string | null;
	verifier_id: string;
	cwd: string;
	started_at: string;
	completed_at: string;
	record_path: string;
	commands: CommandReceipt[];
	ac_results: AcceptanceResult[];
	passed: boolean;
	unverified_reasons: string[];
}

export interface VerificationOptions {
	projectRoot: string;
	runDirectory: string;
	task: Task;
	/** Digest of the complete candidate, not just HEAD; driver must recheck after execution and at release. */
	treeHash: string;
	verifierId: string;
	signal?: AbortSignal;
}

export interface VerificationReadOptions {
	runDirectory: string;
	task: Task;
	treeHash: string;
	projectRoot?: string;
}

export interface VerificationResult {
	evidence: HostEvidence;
	passed: boolean;
	unverifiedReasons: string[];
	goals: GoalGraph;
}

const verifiedEvidence = new WeakSet<HostEvidence>();

/** Not a serializable brand: testimony, JSON copies and caller-constructed records never acquire authority. */
export function isHostVerifiedEvidence(evidence: HostEvidence): boolean {
	return verifiedEvidence.has(evidence);
}

function commandPlan(task: Task): { commands: CommandSpec[]; unsupported: Record<string, string> } {
	createGoalGraph(task); // Reject ambiguous acceptance inventories before any shell side effect.
	if (task.acceptance.length === 0 && task.quality_gates.length === 0) {
		throw new Error("Verification requires a protected acceptance or quality-gate inventory");
	}
	const commands: CommandSpec[] = task.quality_gates.map((cmd, index) => ({
		command_id: `quality:${index}`,
		source: "quality_gate",
		cmd,
		expected_exit: 0,
		stdout_includes: [],
	}));
	const unsupported: Record<string, string> = Object.create(null);
	for (const criterion of task.acceptance) {
		if (!criterion.check) {
			unsupported[criterion.id] = "No executable acceptance check is protected by the intent";
			continue;
		}
		try {
			commands.push({
				command_id: `ac:${criterion.id}`,
				source: "acceptance",
				criterion_id: criterion.id,
				...compileAcceptanceCheck(criterion.check),
			});
		} catch (error) {
			unsupported[criterion.id] = error instanceof Error ? error.message : String(error);
		}
	}
	for (const command of commands) {
		if (typeof command.cmd !== "string" || !command.cmd.trim() || !Number.isSafeInteger(command.expected_exit)) {
			throw new Error(`Invalid protected command: ${command.command_id}`);
		}
		if (
			!Array.isArray(command.stdout_includes) ||
			command.stdout_includes.some((value) => typeof value !== "string")
		) {
			throw new Error(`Invalid protected stdout expectation: ${command.command_id}`);
		}
	}
	return { commands, unsupported };
}

/** Full-byte hashing and matching; only the display excerpt is bounded. */
async function inspectOutput(
	path: string,
	relativePath: string,
	includes: readonly string[] = [],
): Promise<{
	artifact: OutputArtifact;
	matches: boolean[];
}> {
	const digest = createHash("sha256");
	const needles = includes.map((value) => Buffer.from(value, "utf8"));
	const matches = needles.map((needle) => needle.length === 0);
	const overlap = Math.max(0, ...needles.map((needle) => needle.length - 1));
	let suffix = Buffer.alloc(0);
	let bytes = 0;
	const excerpt: Buffer[] = [];
	let excerptBytes = 0;
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		for await (const value of file.createReadStream({ autoClose: false })) {
			const chunk = value as Buffer;
			digest.update(chunk);
			bytes += chunk.length;
			if (excerptBytes < VERIFICATION_EXCERPT_BYTES) {
				const slice = chunk.subarray(0, VERIFICATION_EXCERPT_BYTES - excerptBytes);
				excerpt.push(Buffer.from(slice));
				excerptBytes += slice.length;
			}
			if (matches.some((matched) => !matched)) {
				const searchable = suffix.length ? Buffer.concat([suffix, chunk]) : chunk;
				for (let index = 0; index < needles.length; index++) {
					if (!matches[index]) matches[index] = searchable.includes(needles[index]);
				}
				suffix = overlap
					? Buffer.from(searchable.subarray(Math.max(0, searchable.length - overlap)))
					: Buffer.alloc(0);
			}
		}
	} finally {
		await file.close();
	}
	return {
		artifact: {
			path: relativePath,
			sha256: digest.digest("hex"),
			bytes,
			excerpt: Buffer.concat(excerpt).toString("utf8"),
		},
		matches,
	};
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
	const file = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await file.sync();
		await file.chmod(0o400);
	} finally {
		await file.close();
	}
}

async function assertOwnedDirectory(path: string): Promise<void> {
	const entry = await lstat(path);
	if (!entry.isDirectory() || entry.isSymbolicLink())
		throw new Error(`Verification directory is not host-owned: ${path}`);
}

function killCommand(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		process.kill(process.platform === "win32" ? pid : -pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function runCommand(
	options: VerificationOptions,
	identity: Pick<CommandReceipt, "run_id" | "intent_hash" | "tree_hash" | "verifier_id" | "job_id" | "cwd">,
	command: CommandSpec,
	index: number,
): Promise<CommandReceipt> {
	const prefix = `verification/${identity.run_id}/${index}`;
	const stdoutPath = `${prefix}.stdout`;
	const stderrPath = `${prefix}.stderr`;
	const stdout = await open(join(options.runDirectory, stdoutPath), "wx", 0o600);
	const stderr = await open(join(options.runDirectory, stderrPath), "wx", 0o600).catch(async (cause: unknown) => {
		await stdout.close();
		throw cause;
	});
	const started_at = new Date().toISOString();
	const outcome: Pick<CommandReceipt, "status" | "exit" | "signal" | "error"> = {
		status: "cancelled",
		exit: null,
		signal: null,
		error: options.signal?.aborted ? "Verification cancelled before command launch" : null,
	};
	try {
		if (!options.signal?.aborted) {
			await new Promise<void>((done) => {
				let cancelled = false;
				let escalation: NodeJS.Timeout | undefined;
				const child = spawn(
					process.platform === "win32" ? "cmd.exe" : "/bin/sh",
					process.platform === "win32" ? ["/d", "/s", "/c", command.cmd] : ["-c", command.cmd],
					{
						cwd: identity.cwd,
						// A host-launched test is independent of any enclosing Node test worker.
						env: { ...process.env, NODE_TEST_CONTEXT: undefined },
						stdio: ["ignore", "pipe", "pipe"],
						detached: process.platform !== "win32",
						windowsHide: true,
					},
				);
				const captures = [
					{ stream: child.stdout!, file: stdout },
					{ stream: child.stderr!, file: stderr },
				].map(async ({ stream, file }) => {
					try {
						for await (const chunk of stream) await file.writeFile(chunk as Buffer);
					} catch (cause) {
						outcome.status = "launch_failed";
						outcome.error = `Output capture failed: ${cause instanceof Error ? cause.message : String(cause)}`;
						killCommand(child.pid, "SIGKILL");
					}
				});
				// Kill background descendants at shell exit, then drain both pipes to EOF before sealing raw files.
				child.once("exit", () => {
					if (process.platform !== "win32") killCommand(child.pid, "SIGKILL");
				});
				const abort = () => {
					cancelled = true;
					outcome.error = "Verification cancelled";
					killCommand(child.pid, "SIGTERM");
					escalation = setTimeout(() => killCommand(child.pid, "SIGKILL"), 500);
					escalation.unref();
				};
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.signal?.aborted) abort();
				child.once("error", (cause) => {
					outcome.status = "launch_failed";
					outcome.error = cause.message;
				});
				child.once("close", (code, terminationSignal) => {
					clearTimeout(escalation);
					options.signal?.removeEventListener("abort", abort);
					if (outcome.status !== "launch_failed") {
						outcome.exit = code;
						outcome.signal = terminationSignal;
						outcome.status = cancelled ? "cancelled" : terminationSignal ? "signaled" : "exited";
					}
					void Promise.all(captures).then(() => done());
				});
			}).catch((cause: unknown) => {
				outcome.status = "launch_failed";
				outcome.error = cause instanceof Error ? cause.message : String(cause);
			});
		}
		await Promise.all([stdout.sync(), stderr.sync()]);
		await Promise.all([stdout.chmod(0o400), stderr.chmod(0o400)]);
	} finally {
		await Promise.all([stdout.close(), stderr.close()]);
	}
	const [out, err] = await Promise.all([
		inspectOutput(join(options.runDirectory, stdoutPath), stdoutPath, command.stdout_includes),
		inspectOutput(join(options.runDirectory, stderrPath), stderrPath),
	]);
	const expectation = {
		exit_matches: outcome.status === "exited" && outcome.exit === command.expected_exit,
		stdout_matches: out.matches,
	};
	const receipt: CommandReceipt = {
		...command,
		...identity,
		receipt_id: `${identity.run_id}:${index}`,
		started_at,
		completed_at: new Date().toISOString(),
		...outcome,
		stdout: out.artifact,
		stderr: err.artifact,
		expectation,
		passed: expectation.exit_matches && expectation.stdout_matches.every(Boolean),
	};
	await writeImmutable(join(options.runDirectory, `${prefix}.json`), receipt);
	return receipt;
}

function deriveResults(
	task: Task,
	commands: CommandReceipt[],
): Pick<HostEvidence, "ac_results" | "passed" | "unverified_reasons"> {
	const { unsupported } = commandPlan(task);
	const ac_results = task.acceptance.map((criterion): AcceptanceResult => {
		if (unsupported[criterion.id] !== undefined) {
			return {
				id: criterion.id,
				passed: false,
				status: "unverified",
				receipt_ids: [],
				reasons: [unsupported[criterion.id]],
			};
		}
		const receipt = commands.find((entry) => entry.command_id === `ac:${criterion.id}`);
		if (!receipt) throw new Error(`Missing command receipt for ${criterion.id}`);
		const reasons: string[] = [];
		if (receipt.status !== "exited") reasons.push(receipt.error ?? `Command ${receipt.status}: ${receipt.signal}`);
		if (!receipt.expectation.exit_matches)
			reasons.push(`Expected exit ${receipt.expected_exit}; observed ${receipt.exit}`);
		receipt.expectation.stdout_matches.forEach((matched, index) => {
			if (!matched) reasons.push(`Required stdout text not found (expectation ${index + 1})`);
		});
		return {
			id: criterion.id,
			passed: receipt.passed,
			status: receipt.passed ? "passed" : receipt.status === "exited" ? "failed" : "blocked",
			receipt_ids: [receipt.receipt_id],
			reasons,
		};
	});
	const unverified_reasons = ac_results
		.filter((result) => result.status === "unverified" || result.status === "blocked")
		.flatMap((result) => result.reasons.map((reason) => `${result.id}: ${reason}`));
	for (const receipt of commands) {
		if (receipt.source === "quality_gate" && receipt.status !== "exited") {
			unverified_reasons.push(`${receipt.command_id}: ${receipt.error ?? receipt.status}`);
		}
	}
	return {
		ac_results,
		passed:
			task.acceptance.every((criterion, index) => !criterion.required || ac_results[index].passed) &&
			(task.intent_details?.journeys.every((journey) =>
				journey.acceptance_ids.every((id) => ac_results.find((result) => result.id === id)?.passed === true),
			) ??
				true) &&
			commands.filter((command) => command.source === "quality_gate").every((command) => command.passed),
		unverified_reasons,
	};
}

/**
 * Security boundary: the operator authorises these exact shell strings in protected intent.
 * This is NOT a shell sandbox or a grant to run model-supplied commands. Commands inherit the
 * host environment and project cwd; operators must trust their scripts and dependencies.
 * Policy must deny agents writes to intent, evidence, goals and verification/**, and the
 * caller must exclusively lease the candidate, rehash it afterward and recheck at release.
 * Private run files preserve complete output (which may be sensitive); they are not prompts.
 * chmod/exclusive creation prevent accidental replacement, not a hostile process of the same
 * OS identity or a privileged operator. That threat requires OS isolation outside this API.
 */
export async function executeVerification(options: VerificationOptions): Promise<VerificationResult> {
	if (options.verifierId !== HOST_VERIFIER_ID) throw new Error("A builder or model cannot be the final host verifier");
	if (!options.treeHash.trim()) throw new Error("Verification requires an exact candidate tree hash");
	const intent = await assertProtectedIntent(options.runDirectory, options.task);
	const plan = commandPlan(options.task);
	const root = join(options.runDirectory, "verification");
	await mkdir(root, { recursive: true, mode: 0o700 });
	await assertOwnedDirectory(root);
	const run_id = randomUUID();
	const directory = join(root, run_id);
	await mkdir(directory, { mode: 0o700 });
	const identity = {
		run_id,
		job_id: options.task.job_id,
		intent_hash: intent.hash,
		tree_hash: options.treeHash,
		verifier_id: HOST_VERIFIER_ID,
		cwd: resolve(options.projectRoot),
	};
	const started_at = new Date().toISOString();
	const head = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd: identity.cwd,
		encoding: "utf8",
	}).then(
		(result) => result.stdout.trim(),
		() => null,
	);
	const commands: CommandReceipt[] = [];
	for (const [index, command] of plan.commands.entries())
		commands.push(await runCommand(options, identity, command, index));
	const evidence: HostEvidence = {
		version: 1,
		...identity,
		head,
		started_at,
		completed_at: new Date().toISOString(),
		record_path: `verification/${run_id}/evidence.json`,
		commands,
		...deriveResults(options.task, commands),
	};
	// Keep receipts even if protected intent was externally altered while a command was running.
	await writeImmutable(join(directory, "evidence.json"), evidence);
	await chmod(directory, 0o500);
	await assertProtectedIntent(options.runDirectory, options.task);
	await atomicWrite(join(options.runDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
	const result = await readVerification(options);
	await atomicWrite(join(options.runDirectory, "goals.json"), `${JSON.stringify(result.goals, null, 2)}\n`);
	return result;
}

async function readOwnedJson(path: string): Promise<unknown> {
	const entry = await lstat(path);
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Invalid host receipt file: ${path}`);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return JSON.parse(await file.readFile("utf8"));
	} finally {
		await file.close();
	}
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
	if (canonicalFingerprint(actual) !== canonicalFingerprint(expected)) throw new Error(message);
}

function assertInterval(start: string, end: string): void {
	if (
		!Number.isFinite(Date.parse(start)) ||
		!Number.isFinite(Date.parse(end)) ||
		Date.parse(end) < Date.parse(start)
	) {
		throw new Error("Invalid host verification timestamps");
	}
}

/** Reads only host-owned artifacts; never consumes tester-returned JSON or cached goal statuses. */
export async function readVerification(options: VerificationReadOptions): Promise<VerificationResult> {
	const intent = await assertProtectedIntent(options.runDirectory, options.task);
	const plan = commandPlan(options.task);
	const raw = await readOwnedJson(join(options.runDirectory, "evidence.json"));
	const schema = JSON.parse(
		await readFile(join(getKpiResourceDir(), "schemas", "evidence.schema.json"), "utf8"),
	) as JsonSchema;
	const errors = validateJsonSchema(raw, schema);
	if (errors.length) throw new Error(`Invalid host evidence: ${errors.join("; ")}`);
	const evidence = raw as HostEvidence;
	if (evidence.verifier_id !== HOST_VERIFIER_ID) throw new Error("Builder testimony is not independent host evidence");
	if (
		evidence.job_id !== options.task.job_id ||
		evidence.intent_hash !== intent.hash ||
		evidence.tree_hash !== options.treeHash
	) {
		throw new Error("Stale verification: intent or candidate tree binding changed");
	}
	if (options.projectRoot !== undefined && evidence.cwd !== resolve(options.projectRoot))
		throw new Error("Verification cwd changed");
	if (evidence.cwd !== resolve(evidence.cwd)) throw new Error("Verification cwd is not absolute");
	if (!/^[a-f0-9-]{36}$/.test(evidence.run_id)) throw new Error("Invalid host verification run identity");
	const directory = join(options.runDirectory, "verification", evidence.run_id);
	await assertOwnedDirectory(join(options.runDirectory, "verification"));
	await assertOwnedDirectory(directory);
	if ((await realpath(directory)) !== join(await realpath(options.runDirectory), "verification", evidence.run_id)) {
		throw new Error("Verification records escaped their run directory");
	}
	if (evidence.record_path !== `verification/${evidence.run_id}/evidence.json`)
		throw new Error("Wrong immutable verification record");
	assertEqual(
		await readOwnedJson(join(options.runDirectory, evidence.record_path)),
		evidence,
		"Evidence does not match its immutable host record",
	);
	assertInterval(evidence.started_at, evidence.completed_at);
	if (evidence.commands.length !== plan.commands.length)
		throw new Error("Missing or unexpected protected command evidence");
	for (const [index, expected] of plan.commands.entries()) {
		const receipt = evidence.commands[index];
		const spec: CommandSpec = {
			command_id: receipt.command_id,
			source: receipt.source,
			...(receipt.criterion_id === undefined ? {} : { criterion_id: receipt.criterion_id }),
			cmd: receipt.cmd,
			expected_exit: receipt.expected_exit,
			stdout_includes: receipt.stdout_includes,
		};
		assertEqual(spec, expected, "Wrong protected command or expectation in host evidence");
		for (const field of ["run_id", "job_id", "intent_hash", "tree_hash", "verifier_id", "cwd"] as const) {
			if (receipt[field] !== evidence[field]) throw new Error(`Command receipt ${field} binding changed`);
		}
		if (receipt.receipt_id !== `${evidence.run_id}:${index}`)
			throw new Error("Duplicate or misplaced command receipt");
		assertInterval(receipt.started_at, receipt.completed_at);
		if (
			Date.parse(receipt.started_at) < Date.parse(evidence.started_at) ||
			Date.parse(receipt.completed_at) > Date.parse(evidence.completed_at)
		) {
			throw new Error("Command receipt lies outside verification interval");
		}
		if (
			receipt.status === "exited" &&
			(!Number.isInteger(receipt.exit) || receipt.signal !== null || receipt.error !== null)
		) {
			throw new Error("Incoherent command exit receipt");
		}
		if (receipt.status === "signaled" && (receipt.exit !== null || !receipt.signal))
			throw new Error("Incoherent command signal receipt");
		if (receipt.status === "launch_failed" && (!receipt.error || receipt.signal !== null))
			throw new Error("Incoherent command launch receipt");
		const prefix = `verification/${evidence.run_id}/${index}`;
		assertEqual(
			await readOwnedJson(join(options.runDirectory, `${prefix}.json`)),
			receipt,
			"Command differs from immutable host receipt",
		);
		for (const output of ["stdout", "stderr"] as const) {
			const artifact = receipt[output];
			if (artifact.path !== `${prefix}.${output}`) throw new Error("Wrong raw output artifact path");
			const metadata = await lstat(join(options.runDirectory, artifact.path));
			if (!metadata.isFile() || metadata.isSymbolicLink())
				throw new Error("Raw evidence is not a regular host file");
			const observed = await inspectOutput(
				join(options.runDirectory, artifact.path),
				artifact.path,
				output === "stdout" ? expected.stdout_includes : [],
			);
			assertEqual(artifact, observed.artifact, "Raw evidence hash, size or excerpt changed");
			if (output === "stdout")
				assertEqual(receipt.expectation.stdout_matches, observed.matches, "Fabricated stdout expectation results");
		}
		const exitMatches = receipt.status === "exited" && receipt.exit === expected.expected_exit;
		if (
			receipt.expectation.exit_matches !== exitMatches ||
			receipt.passed !== (exitMatches && receipt.expectation.stdout_matches.every(Boolean))
		) {
			throw new Error("Fabricated command pass status");
		}
	}
	const derived = deriveResults(options.task, evidence.commands);
	assertEqual(evidence.ac_results, derived.ac_results, "Missing, duplicate or fabricated acceptance results");
	assertEqual(evidence.unverified_reasons, derived.unverified_reasons, "Fabricated unverified reasons");
	if (evidence.passed !== derived.passed) throw new Error("Fabricated verification pass status");
	// Deep freezing prevents a trusted in-process receipt from being mutated after validation.
	deepFreeze(evidence);
	verifiedEvidence.add(evidence);
	const goals = projectGoalGraph(options.task, evidence);
	return { evidence, passed: evidence.passed, unverifiedReasons: [...evidence.unverified_reasons], goals };
}

function deepFreeze(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) deepFreeze(child);
	Object.freeze(value);
}

/** Final release/DONE guard: fails closed on stale, fabricated, blocked or unverified required goals. */
export async function assertVerificationFresh(options: VerificationReadOptions): Promise<VerificationResult> {
	const result = await readVerification(options);
	const missing = unfulfilledRequiredGoals(result.goals);
	if (!result.passed || missing.length) {
		throw new Error(
			`Independent verification is not complete: ${missing.map((goal) => `${goal.id} (${goal.status})`).join(", ")}`,
		);
	}
	return result;
}
