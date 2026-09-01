import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { descriptorEnv, type WorkerDescriptor } from "./identity.ts";
import { WORKER_SHUTDOWN_TIMEOUT_MS, WORKER_STARTUP_TIMEOUT_MS, WorkerProtocol } from "./protocol.ts";

export interface WorkerLaunchRequest {
	cwd: string;
	sessionPath: string;
	sessionDirectory: string;
	tools: readonly string[];
	model?: string;
	/** The immutable identity this worker starts with. */
	descriptor: WorkerDescriptor;
	/** Absolute path to the K-π CLI entry. Injected by tests. */
	cliPath?: string;
	/** The interpreter that runs it. Defaults to this process's own node. */
	execPath?: string;
	startupTimeoutMs?: number;
}

export interface WorkerLaunch {
	pid: number;
	argv: string[];
	protocol: WorkerProtocol;
	process?: ChildProcess;
	/** True while the recorded process is still running. */
	isAlive(): boolean;
	/** Graceful stop, then SIGTERM, then SIGKILL, each bounded. */
	stop(): Promise<void>;
}

export type WorkerLauncher = (request: WorkerLaunchRequest) => Promise<WorkerLaunch>;

/** File names that are a K-π CLI entry. Anything else is not one. */
const CLI_ENTRY_NAMES = new Set(["cli.js", "cli.mjs", "cli.cjs", "cli.ts", "kpi", "k-pi"]);

async function isFile(path: string): Promise<boolean> {
	const info = await stat(path).catch(() => undefined);
	return info?.isFile() === true;
}

/** Every ancestor of `from`, nearest first, so both layouts are reachable. */
function ancestors(from: string): string[] {
	const root = parse(from).root;
	const found: string[] = [];
	let current = from;
	while (true) {
		found.push(current);
		if (current === root) {
			return found;
		}
		const next = dirname(current);
		if (next === current) {
			return found;
		}
		current = next;
	}
}

/**
 * The K-π CLI entry, as an absolute path.
 *
 * The order matters, because this module runs from two different places. In a
 * built install it *is* part of `dist/bundle/cli.js`, so the first candidate is
 * itself; deriving a sibling `dist/bundle` from that location would look for the
 * bundle outside the package and find nothing. In a source checkout it is
 * `src/kpi/extensions/bus/launch.ts`, and the entry is found by walking up to the
 * package root - which is also how a built layout is found from `dist/`.
 *
 * `process.argv[1]` is consulted, but only when it is recognisably a CLI entry:
 * under `node --test` it is the test runner, and launching that as a worker would
 * start something that is not K-π.
 */
export async function resolveCliPath(options: { argv?: readonly string[]; moduleUrl?: string } = {}): Promise<string> {
	const self = fileURLToPath(options.moduleUrl ?? import.meta.url);
	const candidates: string[] = [];

	// 1. This module, when the bundle it lives in is the entry.
	if (CLI_ENTRY_NAMES.has(basename(self))) {
		candidates.push(self);
	}
	// 2. The entry this process was started from, validated by name.
	const entry = (options.argv ?? process.argv)[1];
	if (typeof entry === "string" && entry.length > 0) {
		const resolved = resolve(entry);
		if (CLI_ENTRY_NAMES.has(basename(resolved))) {
			candidates.push(resolved);
		}
	}
	// 3. Built then source layout, from every ancestor of this module.
	for (const ancestor of ancestors(dirname(self))) {
		candidates.push(join(ancestor, "dist", "bundle", "cli.js"), join(ancestor, "src", "bun", "cli.ts"));
	}

	for (const candidate of candidates) {
		if (await isFile(candidate)) {
			return candidate;
		}
	}
	throw new Error("Cannot find the K-π CLI entry to launch a worker");
}

/**
 * Starts one worker process.
 *
 * `spawn` is called with an argument vector and no shell: a role, a model id, or
 * a session path must never be able to become shell syntax. stdout and stderr
 * are both piped, because the protocol lives on one and the operator's
 * diagnostics on the other. The identity is passed as a fixed environment
 * variable, set once here and never again.
 */
export const launchWorkerProcess: WorkerLauncher = async (request) => {
	const cliPath = request.cliPath ?? (await resolveCliPath());
	if (!isAbsolute(cliPath)) {
		throw new Error(`worker CLI path must be absolute: ${cliPath}`);
	}
	const execPath = request.execPath ?? process.execPath;
	const argv = [
		cliPath,
		"--mode",
		"rpc",
		"--session",
		request.sessionPath,
		"--session-dir",
		request.sessionDirectory,
		"--tools",
		[...request.tools].join(","),
	];
	if (request.model !== undefined) {
		argv.push("--model", request.model);
	}

	const child = spawn(execPath, argv, {
		cwd: request.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		shell: false,
		env: { ...process.env, ...descriptorEnv(request.descriptor) },
	});

	const startupTimeoutMs = request.startupTimeoutMs ?? WORKER_STARTUP_TIMEOUT_MS;
	await new Promise<void>((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`worker did not start within ${startupTimeoutMs}ms`));
		}, startupTimeoutMs);
		child.once("spawn", () => {
			clearTimeout(timer);
			resolvePromise();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`worker failed to start: ${error.message}`));
		});
	});

	if (child.stdin === null || child.stdout === null) {
		child.kill("SIGKILL");
		throw new Error("worker was started without piped stdio");
	}
	const protocol = new WorkerProtocol({
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr ?? undefined,
	});

	let exited = child.exitCode !== null || child.signalCode !== null;
	child.once("exit", () => {
		exited = true;
		protocol.close();
	});

	return {
		pid: child.pid ?? -1,
		argv,
		protocol,
		process: child,
		isAlive: () => !exited,
		stop: async () => {
			if (exited) {
				protocol.close();
				return;
			}
			// Queues first, then abort, then the signals: a worker asked to stop
			// should not start its next queued turn on the way out.
			await protocol.cancel().catch(() => undefined);
			protocol.close();
			child.stdin?.end();
			const exitedCleanly = await new Promise<boolean>((resolvePromise) => {
				const timer = setTimeout(() => resolvePromise(false), WORKER_SHUTDOWN_TIMEOUT_MS);
				child.once("exit", () => {
					clearTimeout(timer);
					resolvePromise(true);
				});
				child.kill("SIGTERM");
			});
			if (!exitedCleanly) {
				child.kill("SIGKILL");
			}
		},
	};
};
