import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { AccountsStore, POOL_IDS } from "../extensions/accounts/store.ts";
import { promptResearchSetup } from "../extensions/research/setup.ts";
import {
	type KStackRole,
	type ModelLadder,
	orderCandidates,
	PANEL_CAP,
	REQUIRED_ROLES,
	type RoleSuggestion,
	readModelLadder,
	suggestForRole,
	suggestPanel,
} from "./ladder.ts";

/** A role that inherits the parent session's model instead of naming one. */
export const INHERIT_PARENT = "inherit-parent";

export interface KStackModels {
	version: 1;
	roles: Record<string, string | string[]>;
	/** Exact cross-provider fallback order selected from the live registry. */
	fallback_models?: string[];
	inherit_parent: false;
}

/**
 * Pools K-π itself knows how to route. This is the pool list, not a model
 * catalogue: it says which providers are ours, and never which models exist.
 */
export const HEALTHY_POOLS: ReadonlySet<string> = new Set(POOL_IDS);

/**
 * Live candidates: what the registry returned, narrowed to K-π's own pools.
 *
 * Both halves matter. The registry half means a slug is reachable in this
 * session; the pool half means K-π can route and fail it over. A model that
 * passes only one of the two is not offered.
 */
export function liveCandidates(models: readonly Model<any>[], configuredPools: ReadonlySet<string>): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const model of models) {
		if (!HEALTHY_POOLS.has(model.provider) || !configuredPools.has(model.provider)) {
			continue;
		}
		const slug = `${model.provider}/${model.id}`;
		if (!seen.has(slug)) {
			seen.add(slug);
			candidates.push(slug);
		}
	}
	return candidates;
}

export interface RolePlan extends RoleSuggestion {
	/** What will be written: a slug, a panel, or `inherit-parent`. */
	readonly value: string | string[];
}

/**
 * Builds the whole proposed map from the ladder and the live candidates.
 *
 * A role with no live match is planned as `inherit-parent` rather than dropped,
 * because a missing line and an inherited line read the same in the file and mean
 * different things to an operator deciding whether setup worked.
 */
export function planModels(ladder: ModelLadder, candidates: readonly string[]): RolePlan[] {
	return REQUIRED_ROLES.map((role) => {
		const entry = ladder.roles.find((candidate) => candidate.role === role);
		if (entry === undefined) {
			return { role, confidence: "unknown", value: INHERIT_PARENT };
		}
		if (role === "review_panel") {
			const panel = suggestPanel(entry, candidates, ladder.workingOrder, PANEL_CAP);
			return {
				role,
				confidence: entry.confidence,
				chosen: panel[0],
				nextBest: panel[1],
				value: panel.length > 0 ? panel : INHERIT_PARENT,
			};
		}
		const suggestion = suggestForRole(entry, candidates, ladder.workingOrder);
		return { ...suggestion, value: suggestion.chosen ?? INHERIT_PARENT };
	});
}

export function suggestFallbackModels(ladder: ModelLadder, candidates: readonly string[]): string[] {
	return orderCandidates(candidates, ladder.workingOrder);
}

export function planToDocument(plan: readonly RolePlan[], fallbackModels: readonly string[] = []): KStackModels {
	const roles: Record<string, string | string[]> = {};
	for (const entry of plan) {
		roles[entry.role] = entry.value;
	}
	return { version: 1, roles, fallback_models: [...fallbackModels], inherit_parent: false };
}

/** One readable line per role: chosen, next best, and how sure the ladder is. */
export function renderPlan(plan: readonly RolePlan[]): string[] {
	return plan.map((entry) => {
		const value = Array.isArray(entry.value) ? entry.value.join(" + ") : entry.value;
		const next = entry.nextBest === undefined ? "none" : entry.nextBest;
		return `${entry.role} → ${value}  (next best: ${next}; confidence: ${entry.confidence})`;
	});
}

/**
 * Every value in the document must be a live candidate or `inherit-parent`.
 *
 * Checked again here, after any edit, because the operator may type: the ladder
 * naming a model is not evidence that this session can reach it, and neither is
 * an operator being confident.
 */
export function assertKnownModels(document: KStackModels, candidates: readonly string[]): void {
	const allowed = new Set([...candidates, INHERIT_PARENT]);
	for (const [role, entry] of Object.entries(document.roles)) {
		const values = Array.isArray(entry) ? entry : [entry];
		if (Array.isArray(entry) && entry.length > PANEL_CAP) {
			throw new Error(`${role} panel exceeds ${PANEL_CAP} entries`);
		}
		for (const value of values) {
			if (!allowed.has(value)) {
				throw new Error(`Unknown model slug: ${value}`);
			}
		}
	}
	for (const value of document.fallback_models ?? []) {
		if (!allowed.has(value) || value === INHERIT_PARENT) {
			throw new Error(`Unknown fallback model slug: ${value}`);
		}
	}
}

export function modelsPath(): string {
	return join(getAgentDir(), "kstack", "models.json");
}

/**
 * Writes the map atomically.
 *
 * A K-stack role is read at spawn time, so a half-written file is a worker
 * started on a model nobody chose. Temp, fsync, rename, then tighten the mode.
 */
export async function writeKStackModels(
	document: KStackModels,
	candidates: readonly string[],
	path = modelsPath(),
): Promise<void> {
	assertKnownModels(document, candidates);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(document, null, 2)}\n`);
		await file.sync();
		await file.close();
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function readKStackModels(path = modelsPath()): Promise<KStackModels | undefined> {
	const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	});
	if (source === undefined) {
		return undefined;
	}
	const parsed = JSON.parse(source) as KStackModels;
	const fallbackValid =
		parsed.fallback_models === undefined ||
		(Array.isArray(parsed.fallback_models) && parsed.fallback_models.every((value) => typeof value === "string"));
	return parsed.version === 1 && typeof parsed.roles === "object" && fallbackValid ? parsed : undefined;
}

/**
 * Resolves one role to a model id, or `undefined` to inherit the parent.
 *
 * The only reader K-stack needs: a role is a model id at spawn time, and a slot
 * is still an accounts-balancer concern.
 */
export async function resolveRoleModel(role: KStackRole | string, path = modelsPath()): Promise<string | undefined> {
	const document = await readKStackModels(path);
	const entry = document?.roles[role];
	const value = Array.isArray(entry) ? entry[0] : entry;
	return value === undefined || value === INHERIT_PARENT ? undefined : value;
}

/** Panel members in order, for the cross-family review panel. */
export async function resolvePanel(path = modelsPath()): Promise<string[]> {
	const document = await readKStackModels(path);
	const entry = document?.roles.review_panel;
	const values = Array.isArray(entry) ? entry : entry === undefined ? [] : [entry];
	return values.filter((value) => value !== INHERIT_PARENT);
}

export async function resolveFallbackModels(path = modelsPath()): Promise<string[] | undefined> {
	const fallbackModels = (await readKStackModels(path))?.fallback_models;
	return fallbackModels === undefined ? undefined : [...fallbackModels];
}

const APPLY = "apply this map";
const APPLY_FALLBACKS = "apply this fallback order";

/**
 * The interactive edit loop.
 *
 * Any line may be retyped before the file is written, and an edit naming
 * something outside the live candidate set is refused in place rather than saved
 * and discovered later by a worker that cannot start.
 */
export async function editPlan(
	plan: RolePlan[],
	candidates: readonly string[],
	ui: Pick<ExtensionCommandContext["ui"], "select" | "input" | "notify">,
): Promise<RolePlan[] | undefined> {
	let current = [...plan];
	while (true) {
		const choice = await ui.select("K-stack models", [APPLY, ...renderPlan(current), "cancel"]);
		if (choice === undefined || choice === "cancel") {
			return undefined;
		}
		if (choice === APPLY) {
			return current;
		}
		const role = choice.split(" → ")[0];
		const index = current.findIndex((entry) => entry.role === role);
		if (index === -1) {
			continue;
		}
		const typed = await ui.input(
			`${role} model`,
			`slug, ${INHERIT_PARENT}, or comma-separated for a panel (${candidates.length} live)`,
		);
		if (typed === undefined || typed.trim().length === 0) {
			continue;
		}
		const values = typed
			.split(",")
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
		const allowed = new Set([...candidates, INHERIT_PARENT]);
		const rejected = values.filter((value) => !allowed.has(value));
		if (rejected.length > 0) {
			ui.notify(`Not a live model in this session: ${rejected.join(", ")}`, "error");
			continue;
		}
		if (role === "review_panel" && values.length > PANEL_CAP) {
			ui.notify(`A review panel takes at most ${PANEL_CAP} entries`, "error");
			continue;
		}
		const value = role === "review_panel" && values.length > 1 ? values : values[0];
		current = current.map((entry, position) => (position === index ? { ...entry, value } : entry));
	}
}

/** Lets the operator edit the exact cross-provider order before setup writes it. */
export async function editFallbackPlan(
	fallbackModels: readonly string[],
	candidates: readonly string[],
	ui: Pick<ExtensionCommandContext["ui"], "select" | "input" | "notify">,
): Promise<string[] | undefined> {
	let current = [...fallbackModels];
	while (true) {
		const line = `fallback_models → ${current.length === 0 ? "none" : current.join(", ")}`;
		const choice = await ui.select("K-stack fallback models", [APPLY_FALLBACKS, line, "cancel"]);
		if (choice === undefined || choice === "cancel") return undefined;
		if (choice === APPLY_FALLBACKS) return current;
		if (choice !== line) continue;
		const typed = await ui.input("fallback_models", `comma-separated model slugs (${candidates.length} live)`);
		if (typed === undefined || typed.trim().length === 0) continue;
		const values = [
			...new Set(
				typed
					.split(",")
					.map((value) => value.trim())
					.filter((value) => value.length > 0),
			),
		];
		const allowed = new Set(candidates);
		const rejected = values.filter((value) => !allowed.has(value));
		if (rejected.length > 0) {
			ui.notify(`Not a live model in this session: ${rejected.join(", ")}`, "error");
			continue;
		}
		current = values;
	}
}

/**
 * Maps K-stack roles onto the live model registry using the committed model
 * ladder. The role map only: `/setup-kstack` runs this then
 * `promptResearchSetup`; onboarding runs this alone so it never writes the
 * project research mode.
 */
export async function runKStackSetup(context: Pick<ExtensionContext, "ui" | "modelRegistry">): Promise<void> {
	const accounts = await new AccountsStore().read();
	const configuredPools = new Set(
		Object.entries(accounts.pools)
			.filter(([, pool]) => (pool?.slots.length ?? 0) > 0)
			.map(([poolId]) => poolId),
	);
	const candidates = liveCandidates(context.modelRegistry.getAvailable(), configuredPools);
	if (candidates.length === 0) {
		context.ui.notify("No live model in a K-π pool; K-stack roles will inherit the parent session model.", "warning");
		return;
	}
	const ladder = await readModelLadder();
	const plan = planModels(ladder, candidates);
	const fallbackPlan = suggestFallbackModels(ladder, candidates);
	context.ui.notify(
		[...renderPlan(plan), `fallback_models → ${fallbackPlan.length === 0 ? "none" : fallbackPlan.join(", ")}`].join(
			"\n",
		),
		"info",
	);
	const edited = await editPlan(plan, candidates, context.ui);
	const editedFallbacks =
		edited === undefined ? undefined : await editFallbackPlan(fallbackPlan, candidates, context.ui);
	if (edited === undefined || editedFallbacks === undefined) {
		context.ui.notify("K-stack model map unchanged", "info");
	} else {
		await writeKStackModels(planToDocument(edited, editedFallbacks), candidates);
		context.ui.notify(`K-stack model map saved to ${modelsPath()}`, "info");
	}
}

export function registerKStackSetup(pi: ExtensionAPI): void {
	pi.registerCommand("setup-kstack", {
		description: "Map K-stack roles onto live K-π models using the committed model ladder",
		handler: async (_args, context) => {
			await runKStackSetup(context);
			await promptResearchSetup(context);
		},
	});
}
