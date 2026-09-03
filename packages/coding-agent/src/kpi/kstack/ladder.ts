import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getKpiResourceDir } from "../../config.ts";

/**
 * The K-stack model ladder, as committed prose.
 *
 * The ladder is a *suggestion* table. It names substring patterns, never
 * required slugs, and nothing here is a catalogue of models K-π can offer: a
 * pattern only matters when it matches something the live registry already
 * returned. That is the whole point of keeping it in a document instead of in
 * source - a refresh is a dated commit, not a code change.
 */
export interface LadderRole {
	readonly role: string;
	/** Substring patterns over `provider/id`, in preference order. */
	readonly prefer: readonly string[];
	readonly confidence: string;
	readonly why: string;
}

export interface ModelLadder {
	readonly roles: readonly LadderRole[];
	/** Tie-break order between two candidates that match the same pattern. */
	readonly workingOrder: readonly string[];
}

export const LADDER_FILE = "model-ladder.md";

/** Roles the ladder is required to cover, in the order setup presents them. */
export const REQUIRED_ROLES = ["implementer", "frontend", "judgment", "precise", "fast", "review_panel"] as const;

export type KStackRole = (typeof REQUIRED_ROLES)[number];

export class LadderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LadderError";
	}
}

function splitRow(line: string): string[] {
	return line
		.replace(/^\s*\|/u, "")
		.replace(/\|\s*$/u, "")
		.split("|")
		.map((cell) => cell.trim());
}

function patternsFrom(cell: string): string[] {
	const found: string[] = [];
	const regex = /`([^`]+)`/gu;
	let match = regex.exec(cell);
	while (match !== null) {
		const value = match[1].trim();
		// "(not flash)" style asides are prose, not a pattern.
		if (value.length > 0 && !value.startsWith("(")) {
			found.push(value);
		}
		match = regex.exec(cell);
	}
	return found;
}

/**
 * Parses the role suggest table and the working order.
 *
 * Deliberately tolerant of the prose around them and strict about the two things
 * it needs: every required role must have a row, and a row must offer at least
 * one pattern or say `inherit-parent`. A ladder that has drifted out of shape is
 * an error rather than a silently empty suggestion.
 */
export function parseModelLadder(source: string): ModelLadder {
	const roles: LadderRole[] = [];
	const workingOrder: string[] = [];
	let inRoleTable = false;

	for (const line of source.split("\n")) {
		if (/^\|\s*Role\s*\|/u.test(line)) {
			inRoleTable = true;
			continue;
		}
		if (inRoleTable) {
			if (!line.trimStart().startsWith("|")) {
				inRoleTable = false;
			} else if (!/^\|\s*-+/u.test(line.trimStart())) {
				const cells = splitRow(line);
				if (cells.length >= 4) {
					const role = cells[0].replace(/`/gu, "").trim();
					roles.push({
						role,
						prefer: patternsFrom(cells[1]),
						why: cells[2],
						confidence: cells[3],
					});
				}
				continue;
			}
		}
		const ordered = /^\s*(\d+)\.\s+(.+?)\s+—/u.exec(line);
		if (ordered !== null) {
			workingOrder.push(ordered[2].trim());
		}
	}

	const missing = REQUIRED_ROLES.filter((role) => !roles.some((entry) => entry.role === role));
	if (missing.length > 0) {
		throw new LadderError(`model ladder has no row for: ${missing.join(", ")}`);
	}
	for (const entry of roles) {
		if (entry.prefer.length === 0 && !/inherit-parent/u.test(entry.why)) {
			throw new LadderError(`model ladder role ${entry.role} offers no pattern`);
		}
	}
	return { roles, workingOrder };
}

/**
 * Where the committed ladder is looked for, nearest first.
 *
 * One committed file, two places it can be reached from: a built install carries
 * it beside the K-stack tree, and a source checkout still has the repository
 * document. This is a resolution order, not a second copy of the truth - copying
 * the ladder into the package would create exactly the hand-maintained duplicate
 * this package exists to remove.
 */
export function ladderCandidates(resourceDirectory: string): string[] {
	return [
		join(resourceDirectory, "kstack", LADDER_FILE),
		join(resourceDirectory, "..", "..", "..", "docs", LADDER_FILE),
		join(resourceDirectory, "..", "..", "..", "..", "docs", LADDER_FILE),
	];
}

export async function readModelLadder(resourceDirectory = getKpiResourceDir()): Promise<ModelLadder> {
	const attempted: string[] = [];
	for (const candidate of ladderCandidates(resourceDirectory)) {
		attempted.push(candidate);
		const source = await readFile(candidate, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				return undefined;
			}
			throw error;
		});
		if (source !== undefined) {
			return parseModelLadder(source);
		}
	}
	throw new LadderError(`no ${LADDER_FILE} found; looked in ${attempted.join(", ")}`);
}

/** A role's suggestion against one live candidate set. */
export interface RoleSuggestion {
	readonly role: string;
	/** `undefined` means no live model matched: the role inherits the parent. */
	readonly chosen?: string;
	readonly nextBest?: string;
	readonly confidence: string;
	/** The pattern that produced `chosen`, so an operator can see why. */
	readonly matched?: string;
}

function family(slug: string): string {
	return slug.split("/")[0];
}

/**
 * Walks a role's prefer list against the live candidates and returns the first
 * hit plus the runner-up.
 *
 * Ordering inside one pattern falls back to the ladder's working order, which is
 * what that list is for: it breaks a tie between two live slugs that match the
 * same pattern, and decides nothing else.
 */
export function suggestForRole(
	entry: LadderRole,
	candidates: readonly string[],
	workingOrder: readonly string[],
): RoleSuggestion {
	const ranked: { slug: string; pattern: string }[] = [];
	for (const pattern of entry.prefer) {
		const hits = candidates
			.filter((slug) => slug.toLowerCase().includes(pattern.toLowerCase()))
			.filter((slug) => !ranked.some((found) => found.slug === slug))
			.sort((left, right) => tieBreak(left, right, workingOrder));
		for (const slug of hits) {
			ranked.push({ slug, pattern });
		}
	}
	if (ranked.length === 0) {
		return { role: entry.role, confidence: entry.confidence };
	}
	return {
		role: entry.role,
		chosen: ranked[0].slug,
		matched: ranked[0].pattern,
		nextBest: ranked[1]?.slug,
		confidence: entry.confidence,
	};
}

function tieBreak(left: string, right: string, workingOrder: readonly string[]): number {
	const rank = (slug: string): number => {
		const index = workingOrder.findIndex((name) => slug.toLowerCase().includes(normalizeName(name)));
		return index === -1 ? Number.MAX_SAFE_INTEGER : index;
	};
	const difference = rank(left) - rank(right);
	return difference !== 0 ? difference : left.localeCompare(right);
}

/** Orders only live candidates by the committed overall ladder. */
export function orderCandidates(candidates: readonly string[], workingOrder: readonly string[]): string[] {
	return [...candidates].sort((left, right) => tieBreak(left, right, workingOrder));
}

function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/\s+/gu, "-")
		.replace(/[^a-z0-9.-]/gu, "");
}

/** Cross-family panel cap. A panel of one family reviews its own habits. */
export const PANEL_CAP = 3;

/**
 * The ordered cross-family review panel.
 *
 * Order follows the ladder's own preference order for the role, and each family
 * appears once. If only one family is live, the panel is that one entry rather
 * than a repeated slug pretending to be two reviewers.
 */
export function suggestPanel(
	entry: LadderRole,
	candidates: readonly string[],
	workingOrder: readonly string[],
	cap = PANEL_CAP,
): string[] {
	const panel: string[] = [];
	const seen = new Set<string>();
	for (const pattern of entry.prefer) {
		for (const slug of candidates
			.filter((candidate) => candidate.toLowerCase().includes(pattern.toLowerCase()))
			.sort((left, right) => tieBreak(left, right, workingOrder))) {
			if (!seen.has(family(slug)) && panel.length < cap) {
				seen.add(family(slug));
				panel.push(slug);
			}
		}
	}
	if (panel.length === 0) {
		for (const slug of [...candidates].sort((left, right) => tieBreak(left, right, workingOrder))) {
			if (!seen.has(family(slug)) && panel.length < cap) {
				seen.add(family(slug));
				panel.push(slug);
			}
		}
	}
	return panel;
}
