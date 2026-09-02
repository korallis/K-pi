import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { CONFIG_DIR_NAME, getKpiResourceDir } from "../../config.ts";

import {
	type ExtensionAPI,
	type ExtensionUIContext,
	isToolCallEventType,
	type ToolCallEvent,
} from "../../core/extensions/types.ts";

import { appendEvent } from "./append-log.ts";
import { isJsonObject } from "./graph/schema.ts";
import { isAuthoritativeKnowledgeGraphPath } from "./kg/store.ts";
import { atomicWrite, type RunState, readLiveJob, type Task, writeAllowForTask } from "./run-store.ts";
import { classifyShellCommand } from "./shell-classifier.ts";

const execFile = promisify(execFileCallback);

/** What chat scope does with a commit or an unknown command: run it, or ask. */
export type ChatRule = "allow" | "confirm";

export interface PolicyConfig {
	deny: string[];
	/** Exact whitespace-collapsed commands an operator chose to always allow in this project. */
	allow: string[];
	commit: {
		chat: ChatRule;
		gated: "confirm";
		autopilot: "after-release";
	};
	unknown: {
		chat: ChatRule;
		gated: "confirm";
		autopilot: "deny";
	};
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
	deny: ["git push", "git push --force", "git reset --hard", "rm -rf", "chmod 777"],
	allow: [],
	commit: { chat: "allow", gated: "confirm", autopilot: "after-release" },
	unknown: { chat: "allow", gated: "confirm", autopilot: "deny" },
};

/**
 * The scope a tool call is judged in. `chat` is a session with no live K-π
 * job: the hard denies apply and nothing else does. `gated` and `autopilot`
 * are the live job's loop mode.
 */
export type PolicyMode = "chat" | "gated" | "autopilot";

/**
 * Everything policy needs from the active run. One resolver reads one job, so a
 * single decision never mixes one job's mode with another job's write bounds.
 */
export interface ActivePolicyState {
	mode: PolicyMode;
	/** `release.approved === true` for this job: the autopilot commit gate. */
	releaseApproved: boolean;
	writeAllow: readonly string[];
	/** Commands the task declares as its gates; safe to run without a prompt. */
	qualityGates: readonly string[];
}

/** No live job: chat scope. Hard denies only; no bounds, no prompts. */
export const DEFAULT_ACTIVE_POLICY_STATE: ActivePolicyState = {
	mode: "chat",
	releaseApproved: false,
	writeAllow: [],
	qualityGates: [],
};

/** A live job whose task contract will not parse: the safe job scope, unbounded. Never chat. */
export const UNREADABLE_JOB_POLICY_STATE: ActivePolicyState = {
	mode: "gated",
	releaseApproved: false,
	writeAllow: [],
	qualityGates: [],
};

export type PolicyDecision =
	| { kind: "allow" }
	| { kind: "deny"; reason: string }
	| {
			kind: "confirm";
			title: string;
			question: string;
			/** Recorded when the operator declines, or when no operator can answer. */
			declineReason: string;
			/** The collapsed command an approval is remembered under; absent when it must always ask. */
			command?: string;
	  };

export interface DiffStat {
	filesChanged: number;
	insertions: number;
	deletions: number;
}

export type DiffStatReader = (cwd: string) => DiffStat | Promise<DiffStat>;

export interface PolicyEvaluationOptions {
	cwd: string;
	policy: PolicyConfig;
	active: ActivePolicyState;
	/** Defaults to the real `git diff --shortstat HEAD` of `cwd`. */
	readDiffStat?: DiffStatReader;
}

export interface PolicyRegistrationOptions {
	/** Write bounds for the active job. Defaults to the resolved active state. */
	resolveWriteAllow?: (cwd: string) => readonly string[] | Promise<readonly string[]>;
	/** Mode, release gate, bounds, and declared gates. Defaults to the active job. */
	resolveActiveState?: (cwd: string) => ActivePolicyState | Promise<ActivePolicyState>;
	readDiffStat?: DiffStatReader;
	/** Commands approved for this process. Defaults to a fresh set per registration; a test seam. */
	sessionAllow?: Set<string>;
}

export const APPROVAL_OPTIONS = ["Allow for this session", "Always allow in this project", "Deny"] as const;

export type ApprovalChoice = "once" | "always" | "deny";

const ALLOW: PolicyDecision = { kind: "allow" };

const SENSITIVE_FILE_PATTERN = /^(?:\.env(?:\..*)?|id_rsa|auth\.json|accounts\.secrets\.json)$/i;
const PRODUCTION_COMMAND_PATTERNS = [
	/\b(?:npm|pnpm|yarn)\s+publish\b/i,
	/\b(?:kubectl|helm|terraform)\b[^;&|\n]*\b(?:apply|deploy|upgrade)\b/i,
	/\b(?:vercel|netlify)\b[^;&|\n]*--(?:prod|production)\b/i,
	/\bdeploy\b[^;&|\n]*\bprod(?:uction)?\b/i,
	/\bnpm\s+(?:install|i)\b/i,
	/\b(?:pnpm|yarn|bun)\s+add\b/i,
] as const;

/**
 * Shell syntax that can attach a second command to the first. A command holding
 * any of it is never safe and is never read as a standalone `git commit`, so an
 * allowlisted head or a declared quality gate cannot smuggle a payload behind
 * `;`, `&&`, a pipe, a redirect, a backtick, or a substitution.
 */
const SHELL_COMPOSITION_PATTERN = /[;&|`\n\r<>]|\$[({]/u;

/** Shell punctuation that separates one word of a command from the next. */
const SHELL_WORD_SEPARATOR = /[\s;&|`()<>="',]+/u;

const DIFF_STAT_FILES_PATTERN = /(\d+)\s+files?\s+changed/u;
const DIFF_STAT_INSERTIONS_PATTERN = /(\d+)\s+insertions?\(\+\)/u;
const DIFF_STAT_DELETIONS_PATTERN = /(\d+)\s+deletions?\(-\)/u;

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Exact-match form: whitespace collapsed, case preserved. */
function collapseWhitespace(command: string): string {
	return command.trim().replace(/\s+/gu, " ");
}

function includesGitPush(command: string): boolean {
	return command.split(/[;&|\n]+/).some((segment) => /(?:^|\s)(?:sudo\s+)?git\b.*\bpush(?:\s|$)/i.test(segment));
}

function includesRecursiveForceRemove(command: string): boolean {
	for (const segment of command.split(/[;&|\n]+/)) {
		const tokens = segment.trim().split(/\s+/);
		const rmIndex = tokens.findIndex((token) => /(?:^|\/)rm$/.test(token));
		if (rmIndex < 0) {
			continue;
		}

		let recursive = false;
		let force = false;
		for (const token of tokens.slice(rmIndex + 1)) {
			if (token === "--recursive") {
				recursive = true;
			} else if (token === "--force") {
				force = true;
			} else if (/^-[^-]/.test(token)) {
				recursive ||= token.includes("r") || token.includes("R");
				force ||= token.includes("f");
			}
		}
		if (recursive && force) {
			return true;
		}
	}
	return false;
}

function commandDenied(command: string, deny: readonly string[]): boolean {
	if (
		includesGitPush(command) ||
		includesRecursiveForceRemove(command) ||
		PRODUCTION_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
	) {
		return true;
	}

	const normalized = normalizeCommand(command);
	return deny.some((entry) => normalized.includes(normalizeCommand(entry)));
}

/** True only for one unchained command whose program is `git` and verb is `commit`. */
function isStandaloneGitCommit(command: string): boolean {
	if (SHELL_COMPOSITION_PATTERN.test(command)) {
		return false;
	}
	const tokens = collapseWhitespace(command).split(" ");
	return tokens[0] === "git" && tokens[1] === "commit";
}

/** A declared gate is allowed verbatim and never as part of a composition. */
function isDeclaredQualityGate(command: string, qualityGates: readonly string[]): boolean {
	if (SHELL_COMPOSITION_PATTERN.test(command)) {
		return false;
	}
	const exact = collapseWhitespace(command);
	return qualityGates.some((gate) => collapseWhitespace(gate) === exact);
}

/** An operator's own "always allow" is exact too: a remembered command, not a remembered prefix. */
function isAllowlisted(command: string, allow: readonly string[]): boolean {
	const exact = collapseWhitespace(command);
	return allow.some((entry) => collapseWhitespace(entry) === exact);
}

function normalizePath(path: string): string {
	return path.split(sep).join("/").replace(/^\.\//, "");
}

function globPattern(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "*" && pattern[index + 1] === "*") {
			if (pattern[index + 2] === "/") {
				source += "(?:.*/)?";
				index += 2;
			} else {
				source += ".*";
				index += 1;
			}
		} else if (character === "*") {
			source += "[^/]*";
		} else if (character === "?") {
			source += "[^/]";
		} else {
			source += character.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

function relativeWritePath(cwd: string, path: string): string | undefined {
	const absolutePath = resolve(cwd, path);
	const relativePath = relative(resolve(cwd), absolutePath);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}
	return normalizePath(relativePath);
}

const PROTECTED_RUN_ARTIFACT_OWNERS = {
	"verdict.json": "the reviewer",
	"release.approved": "the release.set node",
	// The record of this job's one commit decision. A node that could write it
	// could make the loop skip shipping and still be accepted as done.
	"ship.json": "the control plane",
} as const;

type ProtectedRunArtifact = keyof typeof PROTECTED_RUN_ARTIFACT_OWNERS;

function protectedRunArtifact(cwd: string, path: string): ProtectedRunArtifact | undefined {
	const relativePath = relativeWritePath(cwd, path);
	if (relativePath === undefined) {
		return undefined;
	}
	const segments = relativePath.split("/");
	if (segments.length < 4 || segments[0] !== CONFIG_DIR_NAME || segments[1] !== "runs") {
		return undefined;
	}
	const artifact = segments[segments.length - 1];
	return Object.hasOwn(PROTECTED_RUN_ARTIFACT_OWNERS, artifact) ? (artifact as ProtectedRunArtifact) : undefined;
}

/**
 * A reserved path named anywhere in a shell command, chained or not. The shell
 * is a mutation path like any other, so a reviewer verdict, a release approval,
 * and the authoritative knowledge graph are denied to `bash` on the same terms
 * as to `write` and `edit` — and a deny is never offered to an operator as a
 * confirm, because approving it would break a one-writer rule rather than
 * authorize a risky-but-legal action.
 */
function protectedCommandTarget(cwd: string, command: string): { path: string; owner: string } | undefined {
	for (const word of command.split(SHELL_WORD_SEPARATOR)) {
		if (word.length === 0) {
			continue;
		}
		const artifact = protectedRunArtifact(cwd, word);
		if (artifact !== undefined) {
			return { path: word, owner: PROTECTED_RUN_ARTIFACT_OWNERS[artifact] };
		}
		if (isAuthoritativeKnowledgeGraphPath(cwd, word)) {
			return { path: word, owner: "the knowledge graph control plane" };
		}
	}
	return undefined;
}

/** Sinks that are not files: writing to them cannot leave the bounds. */
const DISCARD_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function unquote(word: string): string {
	return word.replace(/^['"]|['"]$/gu, "");
}

/**
 * A secret-shaped path named anywhere in a shell command, read or written.
 * `cat .env` exfiltrates exactly what a denied `write` to `.env` protects, so
 * the shell is held to the same rule rather than trusted with the same file.
 */
function sensitiveCommandTarget(command: string): string | undefined {
	for (const word of command.split(SHELL_WORD_SEPARATOR)) {
		const candidate = unquote(word);
		if (candidate.length === 0) {
			continue;
		}
		if (candidate.split(/[\\/]/u).some((segment) => SENSITIVE_FILE_PATTERN.test(segment))) {
			return candidate;
		}
	}
	return undefined;
}

const REDIRECT_TARGET_PATTERN = /(?:^|[\s;&|(])\d?>{1,2}\|?\s*(?!&)(['"]?)([^\s;&|)'"]+)\1/gu;
const TEE_TARGET_PATTERN = /\btee\b((?:\s+-[^\s]+)*)\s+([^\s;&|)]+(?:\s+[^-\s;&|)][^\s;&|)]*)*)/gu;
const DD_TARGET_PATTERN = /\bdd\b[^;&|\n]*?\bof=(['"]?)([^\s;&|)'"]+)\1/gu;
const COPY_COMMAND_PATTERN = /\b(?:cp|mv|install|rsync)\b([^;&|\n]*)/gu;
const NESTED_SHELL_PATTERN = /\b(?:ba|z|da)?sh\b[^;&|\n]*?-c\s+(['"])([\s\S]*?)\1/gu;

/**
 * Every path a shell command would create or overwrite: redirections, `tee`,
 * `dd of=`, copy destinations, and the bodies of nested `sh -c` shells.
 *
 * The shell is the widest mutation path the agent has. Analysing only reserved
 * artifact names would leave `echo x > ../outside.txt` a legal way to do exactly
 * what a denied `write` cannot, so the targets are extracted and held to the
 * same `write_allow` bounds.
 */
export function shellWriteTargets(command: string): string[] {
	const targets: string[] = [];
	const add = (value: string | undefined): void => {
		const candidate = unquote(value ?? "").trim();
		if (candidate.length === 0 || DISCARD_TARGETS.has(candidate) || /^\d$/u.test(candidate)) {
			return;
		}
		targets.push(candidate);
	};

	for (const match of command.matchAll(REDIRECT_TARGET_PATTERN)) {
		add(match[2]);
	}
	for (const match of command.matchAll(TEE_TARGET_PATTERN)) {
		for (const word of match[2].split(/\s+/u)) {
			add(word);
		}
	}
	for (const match of command.matchAll(DD_TARGET_PATTERN)) {
		add(match[2]);
	}
	for (const match of command.matchAll(COPY_COMMAND_PATTERN)) {
		// The destination is the last operand; flags and sources are not written.
		const operands = match[1]
			.split(/\s+/u)
			.map(unquote)
			.filter((word) => word.length > 0 && !word.startsWith("-"));
		if (operands.length >= 2) {
			add(operands.at(-1));
		}
	}
	for (const match of command.matchAll(NESTED_SHELL_PATTERN)) {
		targets.push(...shellWriteTargets(match[2]));
	}
	return targets;
}

export function isWriteAllowed(cwd: string, path: string, writeAllow: readonly string[]): boolean {
	const relativePath = relativeWritePath(cwd, path);
	if (relativePath === undefined || relativePath.split("/").some((part) => SENSITIVE_FILE_PATTERN.test(part))) {
		return false;
	}

	return writeAllow.some((allowedPath) => {
		const normalizedAllowedPath = normalizePath(
			isAbsolute(allowedPath) ? relative(resolve(cwd), resolve(allowedPath)) : allowedPath,
		);
		return globPattern(normalizedAllowedPath).test(relativePath);
	});
}

function matchCount(summary: string, pattern: RegExp): number {
	const match = pattern.exec(summary);
	return match === null ? 0 : Number(match[1]);
}

/**
 * `git diff --shortstat` prints only its non-zero clauses, so a field git leaves
 * out is an explicit zero rather than a missing number.
 */
export function parseDiffStat(summary: string): DiffStat {
	return {
		filesChanged: matchCount(summary, DIFF_STAT_FILES_PATTERN),
		insertions: matchCount(summary, DIFF_STAT_INSERTIONS_PATTERN),
		deletions: matchCount(summary, DIFF_STAT_DELETIONS_PATTERN),
	};
}

/**
 * The staged and unstaged diff against the current HEAD, taken from git itself
 * with no shell between: the argument vector is fixed, so nothing in a tool call
 * can extend it. An unreadable diff — no repository, no HEAD — reports zeros;
 * the prompt still names the command being approved.
 */
export async function readGitDiffStat(cwd: string): Promise<DiffStat> {
	try {
		const { stdout } = await execFile("git", ["diff", "--shortstat", "HEAD"], { cwd });
		return parseDiffStat(stdout);
	} catch {
		return { filesChanged: 0, insertions: 0, deletions: 0 };
	}
}

/**
 * `release.set` assigns the graph state path `release.approved`. A run publishes
 * those graph values into its state document, flattened when the loop writes the
 * progress document and nested under `values` in the raw run state, so the one
 * lookup resolves the container before reading the path.
 */
function isReleaseApproved(state: RunState): boolean {
	const values = isJsonObject(state.values) ? state.values : state;
	return isJsonObject(values.release) && values.release.approved === true;
}

/**
 * The policy view of the active run, read once from the one job policy is about
 * to judge: its mode, its release gate, its write bounds, and its declared
 * quality gates always describe the same job. No readable active job — none at
 * all, or a task contract that will not parse — resolves to the safe default
 * instead of throwing past the hook and leaving the call unjudged.
 *
 * The release gate is only as fresh as the loop's own release rule: the engine
 * assigns `release.approved` after `releaseReady` proves green receipts bound to
 * the current HEAD, so reading the flag reads a checked one.
 */
export async function resolveActivePolicyState(cwd: string): Promise<ActivePolicyState> {
	const job = await readLiveJob(cwd);
	if (job === undefined) {
		return DEFAULT_ACTIVE_POLICY_STATE;
	}
	let task: Task;
	try {
		task = JSON.parse(await readFile(join(job.directory, "task.json"), "utf8")) as Task;
	} catch {
		return UNREADABLE_JOB_POLICY_STATE;
	}
	const writeAllow = Array.isArray(task.acceptance) ? [...writeAllowForTask(task)] : [];
	// Implementer owns candidate.json in this job's run directory (not product tree).
	const runRelative = relative(resolve(cwd), resolve(job.directory)).replaceAll("\\", "/");
	if (runRelative.length > 0 && !runRelative.startsWith("..")) {
		writeAllow.push(`${runRelative}/candidate.json`);
	}
	return {
		mode: task.mode === "autopilot" ? "autopilot" : "gated",
		releaseApproved: isReleaseApproved(job.state),
		writeAllow,
		qualityGates: Array.isArray(task.quality_gates) ? task.quality_gates : [],
	};
}

function confirmCommit(command: string, summary: string): PolicyDecision {
	return {
		kind: "confirm",
		title: "Approve git commit",
		question: `${command}\n\n${summary} against HEAD.\n\nCommit on the job branch?`,
		declineReason: `Policy requires confirmation for git commit; not approved: ${command}`,
	};
}

async function evaluateGitCommit(command: string, options: PolicyEvaluationOptions): Promise<PolicyDecision> {
	const { active, policy } = options;
	const rule = active.mode === "chat" ? policy.commit.chat : policy.commit[active.mode];
	if (rule === "allow") {
		return ALLOW;
	}
	if (rule === "confirm") {
		const stat = await (options.readDiffStat ?? readGitDiffStat)(options.cwd);
		const summary = `${stat.filesChanged} files changed, ${stat.insertions} insertions(+), ${stat.deletions} deletions(-)`;
		return confirmCommit(command, summary);
	}
	return active.releaseApproved
		? ALLOW
		: { kind: "deny", reason: `Policy denied git commit before release.approved: ${command}` };
}

function unknownCommand(command: string, options: PolicyEvaluationOptions, why: string): PolicyDecision {
	const { active, policy } = options;
	const rule = active.mode === "chat" ? policy.unknown.chat : policy.unknown[active.mode];
	if (rule === "allow") {
		return ALLOW;
	}
	if (rule === "confirm") {
		return {
			kind: "confirm",
			title: "Approve unrecognized command",
			question: `${command}\n\n${why}\n\nRun it?`,
			declineReason: `Policy requires confirmation for an unrecognized command; not approved: ${command}`,
			command: collapseWhitespace(command),
		};
	}
	return { kind: "deny", reason: `Policy denied unrecognized command: ${command}` };
}

/**
 * Order matters and is the contract: every hard deny comes first, so nothing
 * an operator allows can launder a push, a secret read, a write outside the
 * bounds, or a commit gate. Reads are allowed on their own merits; `allow[]`
 * is consulted only after them, and only for what would otherwise be unknown.
 */
async function evaluateCommand(command: string, options: PolicyEvaluationOptions): Promise<PolicyDecision> {
	const { active, policy } = options;
	if (commandDenied(command, policy.deny)) {
		return { kind: "deny", reason: `Policy denied command: ${command}` };
	}

	const reserved = protectedCommandTarget(options.cwd, command);
	if (reserved !== undefined) {
		return {
			kind: "deny",
			reason: `Policy reserved ${reserved.path} for ${reserved.owner}: ${command}`,
		};
	}

	// A secret-shaped path is denied before anything else looks at the command:
	// no confirm can make reading a private key a legal step.
	const sensitive = sensitiveCommandTarget(command);
	if (sensitive !== undefined) {
		return { kind: "deny", reason: `Policy denied a secret-shaped path: ${sensitive}` };
	}

	// Chat has no job and so no bounds; a job's bounds are the job's.
	if (active.mode !== "chat") {
		const outsideBounds = shellWriteTargets(command).find(
			(target) => !isWriteAllowed(options.cwd, target, active.writeAllow),
		);
		if (outsideBounds !== undefined) {
			return {
				kind: "deny",
				reason: `Policy denied write outside write_allow: ${outsideBounds}`,
			};
		}
	}

	if (isStandaloneGitCommit(command)) {
		return await evaluateGitCommit(command, options);
	}

	if (isDeclaredQualityGate(command, active.qualityGates)) {
		return ALLOW;
	}

	const classification = classifyShellCommand(command);
	if (classification.readOnly) {
		return ALLOW;
	}

	if (isAllowlisted(command, policy.allow)) {
		return ALLOW;
	}

	const why =
		classification.segment === undefined
			? `Not read-only: ${classification.reason}.`
			: `Not read-only: ${classification.reason} in \`${classification.segment}\`.`;
	return unknownCommand(command, options, why);
}

function evaluateWrite(path: string, options: PolicyEvaluationOptions): PolicyDecision {
	const artifact = protectedRunArtifact(options.cwd, path);
	if (artifact !== undefined) {
		return {
			kind: "deny",
			reason: `Policy reserved ${artifact} for ${PROTECTED_RUN_ARTIFACT_OWNERS[artifact]}: ${path}`,
		};
	}
	if (isAuthoritativeKnowledgeGraphPath(options.cwd, path)) {
		return {
			kind: "deny",
			reason: `Policy reserved the authoritative knowledge graph for the control plane: ${path}`,
		};
	}
	if (options.active.mode === "chat") {
		// No job, no bounds: only a secret-shaped name is off limits.
		const relativePath = relativeWritePath(options.cwd, path) ?? normalizePath(path);
		return relativePath.split("/").some((part) => SENSITIVE_FILE_PATTERN.test(part))
			? { kind: "deny", reason: `Policy denied a secret-shaped path: ${path}` }
			: ALLOW;
	}
	if (!isWriteAllowed(options.cwd, path, options.active.writeAllow)) {
		return { kind: "deny", reason: `Policy denied write outside write_allow: ${path}` };
	}
	return ALLOW;
}

export async function evaluateToolCall(
	event: ToolCallEvent,
	options: PolicyEvaluationOptions,
): Promise<PolicyDecision> {
	if (isToolCallEventType("bash", event)) {
		return await evaluateCommand(event.input.command, options);
	}

	if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
		return evaluateWrite(event.input.path, options);
	}

	return ALLOW;
}

export function policyPath(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME, "policy.json");
}

export async function ensurePolicyFile(cwd: string): Promise<string> {
	const target = policyPath(cwd);
	await mkdir(resolve(cwd, CONFIG_DIR_NAME), { recursive: true });
	try {
		await copyFile(join(getKpiResourceDir(), "templates", "policy.json"), target, constants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
	return target;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Whether a session start should seed `.kpi/policy.json` here: only in a
 * project — one that already has a `.kpi/` or is a git root. A shell opened in
 * an arbitrary directory is not a reason to leave a config file behind.
 */
export async function shouldSeedPolicyFile(cwd: string): Promise<boolean> {
	return (await exists(resolve(cwd, CONFIG_DIR_NAME))) || (await exists(resolve(cwd, ".git")));
}

function chatRule(value: unknown, source: string, field: string): ChatRule {
	if (value === undefined) return "allow";
	if (value === "allow" || value === "confirm") return value;
	throw new Error(`${source} ${field} must be "allow" or "confirm"`);
}

/**
 * A policy file written before `allow[]` and the `chat` keys existed still
 * loads: the missing keys take the defaults. A malformed file is an error the
 * operator must see, not a silent fall back to something they did not write.
 */
export function normalizePolicy(raw: unknown, source: string): PolicyConfig {
	if (!isJsonObject(raw) || !Array.isArray(raw.deny)) {
		throw new Error(`${source} must define a deny array`);
	}
	const allow = raw.allow ?? [];
	if (!Array.isArray(allow) || !allow.every((entry) => typeof entry === "string")) {
		throw new Error(`${source} allow must be an array of strings`);
	}
	const commit = isJsonObject(raw.commit) ? raw.commit : {};
	const unknown = isJsonObject(raw.unknown) ? raw.unknown : {};
	return {
		deny: raw.deny.filter((entry): entry is string => typeof entry === "string"),
		allow,
		commit: {
			chat: chatRule(commit.chat, source, "commit.chat"),
			gated: "confirm",
			autopilot: "after-release",
		},
		unknown: {
			chat: chatRule(unknown.chat, source, "unknown.chat"),
			gated: "confirm",
			autopilot: "deny",
		},
	};
}

/** Reads the project policy; a missing file is the default and is never created here. */
export async function readPolicy(cwd: string): Promise<PolicyConfig> {
	const target = policyPath(cwd);
	let source: string;
	try {
		source = await readFile(target, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY_CONFIG;
		throw error;
	}
	return normalizePolicy(JSON.parse(source), target);
}

/** Appends an exact command to `allow[]`, creating the file from the template on first use. */
export async function rememberAllowedCommand(cwd: string, command: string): Promise<string> {
	const target = await ensurePolicyFile(cwd);
	const policy = normalizePolicy(JSON.parse(await readFile(target, "utf8")), target);
	const exact = collapseWhitespace(command);
	if (!policy.allow.includes(exact)) {
		policy.allow.push(exact);
	}
	await atomicWrite(target, `${JSON.stringify(policy, null, 2)}\n`);
	return target;
}

/**
 * The approval dialog. A selector when the UI has one, a plain confirm where it
 * does not; no UI at all (print mode) answers "deny", so an unattended session
 * blocks the call instead of running it unapproved.
 */
export async function askApproval(
	ui: Pick<ExtensionUIContext, "confirm"> & Partial<Pick<ExtensionUIContext, "select">>,
	decision: Extract<PolicyDecision, { kind: "confirm" }>,
): Promise<ApprovalChoice> {
	if (decision.command === undefined || typeof ui.select !== "function") {
		return (await ui.confirm(decision.title, decision.question)) ? "once" : "deny";
	}
	const choice = await ui.select(`${decision.title}\n${decision.question}`, [...APPROVAL_OPTIONS]);
	if (choice === APPROVAL_OPTIONS[0]) return "once";
	if (choice === APPROVAL_OPTIONS[1]) return "always";
	return "deny";
}

/** The path a tool call names, for the tools that name one. */
function requestedPath(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
		return event.input.path;
	}
	return undefined;
}

/**
 * Records that a tool asked to act, and what the policy layer decided, before
 * the tool could act.
 *
 * This is the ordering record: `loop.terminal` says when a run stopped, but
 * without a request record there is nothing to compare it against, so "stopped
 * before the first write" was previously only provable by the absence of a file.
 * Emitted for allowed calls too - an ordering log with only the refusals in it
 * cannot show that a write came after a decision.
 *
 * Best-effort by construction: a session with no active job has nowhere to write
 * this, and a failed append must never turn into a denied tool call.
 */
async function recordToolRequest(
	cwd: string,
	event: ToolCallEvent,
	decision: "allow" | "confirm" | "deny",
	reason?: string,
): Promise<void> {
	try {
		const job = await readLiveJob(cwd);
		if (job === undefined) {
			return;
		}
		const path = requestedPath(event);
		await appendEvent(job.eventsPath, {
			ts: new Date().toISOString(),
			type: "tool.request",
			job_id: job.jobId,
			round: typeof job.state.round === "number" ? job.state.round : 0,
			node: typeof job.state.node === "string" ? job.state.node : "tool",
			tool: event.toolName,
			decision,
			...(path === undefined ? {} : { path }),
			...(reason === undefined ? {} : { reason }),
		});
	} catch {
		// An unrecordable attempt is a lost line, not a policy failure.
	}
}

export function registerPolicy(pi: ExtensionAPI, options: PolicyRegistrationOptions = {}): void {
	const sessionAllow = options.sessionAllow ?? new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		if (await shouldSeedPolicyFile(ctx.cwd)) {
			await ensurePolicyFile(ctx.cwd);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const [policy, resolved] = await Promise.all([
			readPolicy(ctx.cwd),
			(options.resolveActiveState ?? resolveActivePolicyState)(ctx.cwd),
		]);
		// Chat has no bounds, so a finished job's write list (or a stale one) is
		// never laid over it.
		const active =
			options.resolveWriteAllow === undefined || resolved.mode === "chat"
				? resolved
				: { ...resolved, writeAllow: await options.resolveWriteAllow(ctx.cwd) };
		const decision = await evaluateToolCall(event, {
			active,
			cwd: ctx.cwd,
			policy,
			readDiffStat: options.readDiffStat,
		});
		if (decision.kind === "allow") {
			await recordToolRequest(ctx.cwd, event, "allow");
			return;
		}
		if (decision.kind === "deny") {
			await recordToolRequest(ctx.cwd, event, "deny", decision.reason);
			return { block: true, reason: decision.reason };
		}
		const key = decision.command === undefined ? undefined : `${ctx.cwd}\0${decision.command}`;
		if (key !== undefined && sessionAllow.has(key)) {
			await recordToolRequest(ctx.cwd, event, "allow", "approved earlier this session");
			return;
		}
		// Recorded before the dialog: the attempt happened whether or not the
		// operator ever answers.
		await recordToolRequest(ctx.cwd, event, "confirm", decision.title);
		const choice = await askApproval(ctx.ui, decision);
		if (choice === "deny") {
			return { block: true, reason: decision.declineReason };
		}
		if (key !== undefined) {
			sessionAllow.add(key);
		}
		if (choice === "always" && decision.command !== undefined) {
			try {
				const target = await rememberAllowedCommand(ctx.cwd, decision.command);
				ctx.ui.notify(`Always allowed in ${relative(ctx.cwd, target)}: ${decision.command}`, "info");
			} catch (error) {
				// The operator approved the call; a policy file that would not take
				// the note is reported, not turned into a refusal.
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not record the approval in ${CONFIG_DIR_NAME}/policy.json: ${message}`, "warning");
			}
		}
	});
}
