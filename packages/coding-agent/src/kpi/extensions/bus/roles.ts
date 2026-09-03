export const WORKER_ROLES = ["implementer", "reviewer", "tester", "arena", "explorer"] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export function isWorkerRole(value: unknown): value is WorkerRole {
	return typeof value === "string" && (WORKER_ROLES as readonly string[]).includes(value);
}

/** Tools that make a worker the one writer under the same-tree rule. */
export const MUTATION_TOOLS = new Set(["write", "edit", "apply_patch", "multi_edit"]);

/**
 * What each role may hold.
 *
 * Reviewer and tester never get `write` or `edit`. They publish through
 * `write_contract`, which reaches exactly one declared path and does not make
 * them the writer. `claim_path`/`release_path` belong to roles that can write:
 * a lease is meaningless without the tool it protects.
 */
export const ROLE_TOOLS: Record<WorkerRole, readonly string[]> = {
	implementer: ["read", "grep", "find", "ls", "bash", "write", "edit", "claim_path", "release_path"],
	reviewer: ["read", "grep", "find", "ls", "bash", "write_contract"],
	tester: ["read", "grep", "find", "ls", "bash", "write_contract"],
	arena: ["read", "grep", "find", "ls", "bash", "write", "edit", "claim_path", "release_path"],
	explorer: ["read", "grep", "find", "ls", "bash"],
};

/**
 * Roles whose `bash` is a test shell and nothing else.
 *
 * A reviewer and a tester both need to run the job's declared quality gates -
 * that is the whole point of holding a shell - and neither may do anything else
 * with it. Withholding `bash` entirely would leave a tester unable to test;
 * granting a general shell would hand back the mutation path that keeping
 * `write` and `edit` away from them exists to close, since `bash` can write any
 * file in the tree.
 *
 * So the shell is narrowed to exactly the frozen `quality_gates` of the job's
 * task contract: an exact string match against a command the operator already
 * declared, not a pattern, an allowlist of binaries, or a denylist of dangerous
 * ones. A denylist would be endless; an exact match is decidable.
 */
export const TEST_SHELL_ROLES: ReadonlySet<WorkerRole> = new Set<WorkerRole>(["reviewer", "tester"]);

/** Roles whose shell accepts only commands mechanically classified read-only. */
export const READ_ONLY_SHELL_ROLES: ReadonlySet<WorkerRole> = new Set<WorkerRole>(["explorer"]);

/** Whether this role's shell is restricted to the declared quality gates. */
export function hasTestShellOnly(role: WorkerRole): boolean {
	return TEST_SHELL_ROLES.has(role);
}

/** Whether this role's shell is restricted to read-only inspection commands. */
export function hasReadOnlyShell(role: WorkerRole): boolean {
	return READ_ONLY_SHELL_ROLES.has(role);
}

/**
 * The one run-contract file a role may publish through `write_contract`,
 * relative to the run directory, with the schema its payload must satisfy.
 *
 * Only the roles that hold no mutation tool have one. An implementer or arena
 * worker is the writer and writes `candidate.json` with `write`; minting a
 * pinned capability for it would be a second path to the same file.
 */
export const ROLE_CONTRACT_FILE: Partial<Record<WorkerRole, { file: string; schema: string }>> = {
	reviewer: { file: "verdict.json", schema: "verdict.schema.json" },
	tester: { file: "evidence.json", schema: "evidence.schema.json" },
};

/**
 * The file `expect: "result"` waits for, for a role that produces one.
 *
 * A reviewer and a tester publish through `write_contract`, so their result is
 * proven by a publication receipt. An implementer and an arena worker are the
 * writer: they write `candidate.json` with the `write` tool they legitimately
 * hold, and what makes that attributable is the enforced single-writer slot -
 * one writer worker at a time, and the parent's own mutation tools denied while
 * it lives - rather than a receipt. An explorer produces no result file and
 * refuses `expect: "result"`.
 */
export const ROLE_RESULT_FILE: Partial<Record<WorkerRole, string>> = {
	reviewer: "verdict.json",
	tester: "evidence.json",
	implementer: "candidate.json",
	arena: "candidate.json",
};

/**
 * The allowlist a role actually launches with.
 *
 * A caller may narrow the list; it may never widen it. A requested tool outside
 * the role's allowance is refused rather than dropped, because silently handing
 * back fewer tools than asked for looks like success to the caller.
 */
export function resolveRoleTools(role: WorkerRole, requested?: readonly string[]): string[] {
	const allowed = ROLE_TOOLS[role];
	if (requested === undefined) {
		return [...allowed];
	}
	const forbidden = requested.filter((tool) => !allowed.includes(tool));
	if (forbidden.length > 0) {
		throw new Error(`role ${role} may not hold ${forbidden.join(", ")}`);
	}
	return [...new Set(requested)];
}

/** Whether this tool set makes its holder the single writer. */
export function isWriterToolSet(tools: readonly string[]): boolean {
	return tools.some((tool) => MUTATION_TOOLS.has(tool));
}
