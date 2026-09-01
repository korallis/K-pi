import { constants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { CONFIG_DIR_NAME, getKpiResourceDir } from "../../config.ts";

import { type ExtensionAPI, isToolCallEventType, type ToolCallEvent } from "../../core/extensions/types.ts";

import { isAuthoritativeKnowledgeGraphPath } from "./kg/store.ts";

export interface PolicyConfig {
	deny: string[];
	commit: {
		gated: "confirm";
		autopilot: "after-release";
	};
	unknown: {
		gated: "confirm";
		autopilot: "deny";
	};
}

export interface PolicyDecision {
	allowed: boolean;
	reason?: string;
}

export interface PolicyEvaluationOptions {
	cwd: string;
	policy: PolicyConfig;
	writeAllow: readonly string[];
}

export interface PolicyRegistrationOptions {
	resolveWriteAllow?: (cwd: string) => readonly string[] | Promise<readonly string[]>;
}

const SENSITIVE_FILE_PATTERN = /^(?:\.env(?:\..*)?|id_rsa|auth\.json|accounts\.secrets\.json)$/i;
const PRODUCTION_COMMAND_PATTERNS = [
	/\b(?:npm|pnpm|yarn)\s+publish\b/i,
	/\b(?:kubectl|helm|terraform)\b[^;&|\n]*\b(?:apply|deploy|upgrade)\b/i,
	/\b(?:vercel|netlify)\b[^;&|\n]*--(?:prod|production)\b/i,
	/\bdeploy\b[^;&|\n]*\bprod(?:uction)?\b/i,
	/\bnpm\s+(?:install|i)\b/i,
	/\b(?:pnpm|yarn|bun)\s+add\b/i,
] as const;

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ").toLowerCase();
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

export function evaluateToolCall(event: ToolCallEvent, options: PolicyEvaluationOptions): PolicyDecision {
	if (isToolCallEventType("bash", event)) {
		if (commandDenied(event.input.command, options.policy.deny)) {
			return {
				allowed: false,
				reason: `Policy denied command: ${event.input.command}`,
			};
		}
		return { allowed: true };
	}

	if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
		const artifact = protectedRunArtifact(options.cwd, event.input.path);
		if (artifact !== undefined) {
			return {
				allowed: false,
				reason: `Policy reserved ${artifact} for ${PROTECTED_RUN_ARTIFACT_OWNERS[artifact]}: ${event.input.path}`,
			};
		}
		if (isAuthoritativeKnowledgeGraphPath(options.cwd, event.input.path)) {
			return {
				allowed: false,
				reason: `Policy reserved the authoritative knowledge graph for the control plane: ${event.input.path}`,
			};
		}
		if (!isWriteAllowed(options.cwd, event.input.path, options.writeAllow)) {
			return {
				allowed: false,
				reason: `Policy denied write outside write_allow: ${event.input.path}`,
			};
		}
	}

	return { allowed: true };
}

export async function ensurePolicyFile(cwd: string): Promise<string> {
	const configDirectory = resolve(cwd, CONFIG_DIR_NAME);
	const policyPath = resolve(configDirectory, "policy.json");
	await mkdir(configDirectory, { recursive: true });
	try {
		await copyFile(join(getKpiResourceDir(), "templates", "policy.json"), policyPath, constants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
	return policyPath;
}

export async function readPolicy(cwd: string): Promise<PolicyConfig> {
	const policyPath = await ensurePolicyFile(cwd);
	const policy = JSON.parse(await readFile(policyPath, "utf8")) as PolicyConfig;
	if (!Array.isArray(policy.deny)) {
		throw new Error(`${policyPath} must define a deny array`);
	}
	return policy;
}

export function registerPolicy(pi: ExtensionAPI, options: PolicyRegistrationOptions = {}): void {
	pi.on("session_start", async (_event, ctx) => {
		await ensurePolicyFile(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		const [policy, writeAllow] = await Promise.all([readPolicy(ctx.cwd), options.resolveWriteAllow?.(ctx.cwd) ?? []]);
		const decision = evaluateToolCall(event, {
			cwd: ctx.cwd,
			policy,
			writeAllow,
		});
		if (!decision.allowed) {
			return { block: true, reason: decision.reason };
		}
	});
}
