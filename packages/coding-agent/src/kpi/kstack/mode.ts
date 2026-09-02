import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { getKpiResourceDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { parseFrontmatter } from "./frontmatter.ts";

/**
 * Graph nodes a playbook step may be tagged with.
 *
 * A step names the node allowed to complete it, so a todo cannot be ticked by
 * whichever worker happens to be running. An unknown node is a diagnostic: a
 * playbook that points at a node the graph does not have would produce a todo
 * nobody can ever complete.
 */
export const PLAYBOOK_NODES = [
	"specify",
	"plan",
	"plan-check",
	"implement",
	"test",
	"review",
	"bounds",
	"ship",
] as const;

export type PlaybookNode = (typeof PLAYBOOK_NODES)[number];

export interface PlaybookStep {
	readonly node: PlaybookNode;
	readonly text: string;
	/** Present when the playbook itself declares the step skipped, with why. */
	readonly skip?: string;
}

export interface Playbook {
	readonly name: string;
	readonly skill: string;
	readonly description: string;
	/** Keywords that match a task to this playbook, in declared order. */
	readonly match: readonly string[];
	readonly steps: readonly PlaybookStep[];
}

export class PlaybookError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlaybookError";
	}
}

export interface KModePlan {
	readonly playbook: string;
	/** Rendered todo lines, including skipped steps and their reasons. */
	readonly todos: readonly string[];
	readonly steps: readonly PlaybookStep[];
}

export interface KModeState {
	enabled: boolean;
	plan?: KModePlan;
}

export const kModeState: KModeState = { enabled: false };

/** Where the loadable runtime lives. Nothing else is a playbook source. */
export function generatedSkillsDirectory(resourceDirectory = getKpiResourceDir()): string {
	return join(resourceDirectory, "kstack", "generated", "skills");
}

const STEP_LINE = /^-\s+\*\*([a-z-]+)\*\*\s+(.+?)\s*(?:`skip:\s*(.+?)`)?\s*$/u;

export function parsePlaybook(skill: string, source: string): Playbook {
	const parsed = parseFrontmatter(source);
	if (parsed === undefined) {
		throw new PlaybookError(`${skill} has no parseable frontmatter`);
	}
	const name = parsed.fields.playbook;
	if (name === undefined || name.trim().length === 0) {
		throw new PlaybookError(`${skill} declares no playbook name`);
	}
	const steps: PlaybookStep[] = [];
	for (const line of parsed.body.split("\n")) {
		const match = STEP_LINE.exec(line.trim());
		if (match === null) {
			continue;
		}
		const node = match[1];
		if (!(PLAYBOOK_NODES as readonly string[]).includes(node)) {
			throw new PlaybookError(`${skill} step names an unknown graph node: ${node}`);
		}
		steps.push({
			node: node as PlaybookNode,
			text: match[2].trim(),
			...(match[3] === undefined ? {} : { skip: match[3].trim() }),
		});
	}
	if (steps.length === 0) {
		throw new PlaybookError(`${skill} declares no steps`);
	}
	return {
		name: name.trim(),
		skill,
		description: parsed.fields.description ?? "",
		match: (parsed.fields.match ?? "")
			.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry.length > 0),
		steps,
	};
}

/**
 * Loads every playbook from the generated runtime.
 *
 * The registry is whatever the sync emitted, which is why there is no table in
 * this file: a playbook K-π hard-coded here would be a K-stack behaviour that
 * never went through the overlay, and the next sync could not see it.
 */
export async function loadPlaybooks(directory = generatedSkillsDirectory()): Promise<Playbook[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			throw new PlaybookError(`no generated K-stack runtime at ${directory}`);
		}
		throw error;
	});
	const playbooks: Playbook[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("playbook-")) {
			continue;
		}
		const source = await readFile(join(directory, entry.name, "SKILL.md"), "utf8").catch(() => undefined);
		if (source === undefined) {
			continue;
		}
		playbooks.push(parsePlaybook(entry.name, source));
	}
	const seen = new Map<string, string>();
	for (const playbook of playbooks) {
		const previous = seen.get(playbook.name);
		if (previous !== undefined) {
			throw new PlaybookError(`playbook ${playbook.name} is declared by both ${previous} and ${playbook.skill}`);
		}
		seen.set(playbook.name, playbook.skill);
	}
	if (playbooks.length === 0) {
		throw new PlaybookError(`no playbook skills under ${directory}`);
	}
	return playbooks.sort((left, right) => left.name.localeCompare(right.name));
}

/** The default when no keyword matches. Named once, here. */
export const FALLBACK_PLAYBOOK = "feature";

/**
 * Matches a task to a playbook by the keywords each playbook declares.
 *
 * Longest keyword first, so a specific phrase beats a generic word that happens
 * to be a substring of it.
 */
export function matchPlaybook(task: string, playbooks: readonly Playbook[]): Playbook {
	const haystack = task.toLowerCase();
	const ranked = playbooks
		.flatMap((playbook) => playbook.match.map((keyword) => ({ playbook, keyword })))
		.sort((left, right) => right.keyword.length - left.keyword.length);
	for (const { playbook, keyword } of ranked) {
		if (haystack.includes(keyword)) {
			return playbook;
		}
	}
	const fallback = playbooks.find((playbook) => playbook.name === FALLBACK_PLAYBOOK);
	if (fallback === undefined) {
		throw new PlaybookError(`no playbook matched and no ${FALLBACK_PLAYBOOK} playbook exists`);
	}
	return fallback;
}

/**
 * Renders one todo per step. A skipped step stays in the list carrying its
 * reason, because a step silently missing from a todo list reads as work that was
 * never required.
 */
export function renderTodos(steps: ReadonlyArray<{ node: string; text: string; skip?: string }>): string[] {
	return steps.map((step) =>
		step.skip === undefined ? `${step.node}: ${step.text}` : `${step.node}: ${step.text} — skip: ${step.skip}`,
	);
}

export async function createKModePlan(task: string, directory = generatedSkillsDirectory()): Promise<KModePlan> {
	const playbook = matchPlaybook(task, await loadPlaybooks(directory));
	return { playbook: playbook.name, steps: playbook.steps, todos: renderTodos(playbook.steps) };
}

export async function assertShipApproved(runDirectory: string): Promise<void> {
	const verdict = JSON.parse(await readFile(join(runDirectory, "verdict.json"), "utf8")) as { approved?: unknown };
	if (verdict.approved !== true) {
		throw new Error("Ship is blocked until verdict.approved is true");
	}
}

export function registerKMode(pi: ExtensionAPI): void {
	pi.registerCommand("k-mode", {
		description: "Enable sticky K-mode rigor and select a generated K-stack playbook",
		handler: async (args, context) => {
			const task = args.trim();
			if (task === "off") {
				kModeState.enabled = false;
				delete kModeState.plan;
				context.ui.notify("K-mode off", "info");
				return;
			}
			kModeState.enabled = true;
			if (task.length > 0) {
				kModeState.plan = await createKModePlan(task);
			}
			context.ui.notify(
				kModeState.plan === undefined
					? "K-mode on"
					: `K-mode on · K-stack ${kModeState.plan.playbook} · ${kModeState.plan.todos.length} steps\n${kModeState.plan.todos.join("\n")}`,
				"info",
			);
		},
	});
}
