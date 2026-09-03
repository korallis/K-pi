import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../core/extensions/types.ts";
import { runKStackSetup } from "../kstack/models.ts";
import { loginPoolInteractively } from "./accounts/index.ts";
import { type AccountsDocument, AccountsStore, isLocalPool, POOL_IDS, type PoolId } from "./accounts/store.ts";
import type { ResearchService } from "./research/session.ts";
import { promptResearchKeys } from "./research/setup.ts";

export const ONBOARDING_COMMAND = "onboarding";

/**
 * What a first-run operator needs to know before the wizard starts: the gated
 * graph's two operator confirmations, and that reviewer/tester work happens on
 * separate kpi processes, not inside this one.
 */
export const WELCOME_LINES: readonly string[] = [
	"K-π is a standalone coding-agent harness you own.",
	"A job runs a gated graph — specify → plan → implement → test → review → ship — with a plan gate and a release gate you confirm.",
	"Reviewer and tester workers are separate kpi processes on the worker bus (see /agents).",
];

const START_SETUP = "Start setup";
const NOT_NOW = "Not now";
const CONTINUE = "Continue";
const ENTER_API_KEYS = "Enter API keys";
const MAP_ROLES_NOW = "Map roles now";
const SKIP = "Skip";

export interface OnboardingDependencies {
	store?: AccountsStore;
	loginPool?: (poolId: PoolId, context: ExtensionContext) => Promise<{ poolId: PoolId; slotId: string } | undefined>;
	researchKeys?: (ui: ExtensionContext["ui"]) => Promise<ResearchService[]>;
	kstackSetup?: (context: ExtensionContext) => Promise<void>;
}

export interface OnboardingOutcome {
	status: "completed" | "deferred";
	accounts: string[];
	/** Present only when the research step ran (Enter API keys was chosen). */
	researchServices?: ResearchService[];
	kstack: boolean;
}

function poolOptionLabel(poolId: PoolId, slotCount: number): string {
	return `${poolId}${isLocalPool(poolId) ? " (local server)" : ""} — ${slotCount} slot(s)`;
}

/**
 * Runs one onboarding step. A step's own failure is reported by name and never
 * aborts the wizard: the operator can still complete the steps that work.
 */
async function runStep(context: ExtensionContext, name: string, step: () => Promise<void>): Promise<void> {
	try {
		await step();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		context.ui.notify(`Onboarding step "${name}" failed: ${message}`, "error");
	}
}

async function runAccountsStep(
	context: ExtensionContext,
	dependencies: Required<OnboardingDependencies>,
	accounts: string[],
): Promise<void> {
	for (;;) {
		const document: AccountsDocument = await dependencies.store.read();
		const options = POOL_IDS.map((poolId) => poolOptionLabel(poolId, document.pools[poolId]?.slots.length ?? 0));
		const pick = await context.ui.select("Add a model account", [...options, CONTINUE]);
		if (pick === undefined || pick === CONTINUE) {
			return;
		}
		const index = options.indexOf(pick);
		if (index === -1) {
			return;
		}
		const poolId = POOL_IDS[index];
		try {
			// One attempt per pick: a cancelled or declined login just adds nothing.
			const result = await dependencies.loginPool(poolId, context);
			if (result !== undefined) {
				accounts.push(`${result.poolId}/${result.slotId}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			context.ui.notify(`${poolId} login not completed: ${message}`, "warning");
		}
	}
}

/**
 * Walks the guided first-run setup: welcome, model accounts, research keys,
 * K-stack roles. Every step is skippable and every step's failure is reported
 * and swallowed — this never rejects, because a broken step must never break
 * the session it was meant to help start.
 */
export async function runOnboarding(
	context: ExtensionContext,
	dependencies: Required<OnboardingDependencies>,
): Promise<OnboardingOutcome> {
	context.ui.notify(WELCOME_LINES.join("\n"), "info");
	const start = await context.ui.select("Welcome to K-π", [START_SETUP, NOT_NOW]);
	if (start === undefined || start === NOT_NOW) {
		// No marker, no settings key: "Not now" closes the wizard for this launch
		// only, and nothing here writes anything.
		return { status: "deferred", accounts: [], kstack: false };
	}

	const accounts: string[] = [];
	let researchServices: ResearchService[] | undefined;
	let kstack = false;

	await runStep(context, "model accounts", () => runAccountsStep(context, dependencies, accounts));

	await runStep(context, "research keys", async () => {
		const choice = await context.ui.select("Research keys (Exa, Perplexity, Firecrawl)", [ENTER_API_KEYS, SKIP]);
		if (choice === ENTER_API_KEYS) {
			researchServices = await dependencies.researchKeys(context.ui);
		}
	});

	await runStep(context, "K-stack roles", async () => {
		const choice = await context.ui.select("K-stack roles", [MAP_ROLES_NOW, SKIP]);
		if (choice === MAP_ROLES_NOW) {
			await dependencies.kstackSetup(context);
			kstack = true;
		}
	});

	await runStep(context, "summary", async () => {
		context.ui.notify(
			[
				`accounts: ${accounts.join(", ") || "none"}`,
				`research keys: ${researchServices === undefined ? "skipped" : researchServices.join(", ") || "none saved"}`,
				`K-stack roles: ${kstack ? "mapped" : "skipped"}`,
				"Run /onboarding any time; /accounts and /setup-kstack edit the same files.",
			].join("\n"),
			"info",
		);
	});

	return { status: "completed", accounts, researchServices, kstack };
}

/**
 * True only for the exact state behind the harness's "No models available"
 * warning: an interactive TUI startup where K-π has no configured slot in any
 * pool (an official, credential-free slot counts) and the harness itself has
 * no available model either. No marker is consulted — there is none.
 */
export function shouldAutoOnboard(
	reason: SessionStartEvent["reason"],
	context: ExtensionContext,
	document: AccountsDocument,
): boolean {
	if (reason !== "startup" || context.mode !== "tui" || !context.hasUI) {
		return false;
	}
	const everyPoolEmpty = Object.values(document.pools).every((pool) => (pool?.slots.length ?? 0) === 0);
	return everyPoolEmpty && context.modelRegistry.getAvailable().length === 0;
}

export function registerOnboarding(pi: ExtensionAPI, dependencies: OnboardingDependencies = {}): void {
	const store = dependencies.store ?? new AccountsStore();
	const resolved: Required<OnboardingDependencies> = {
		store,
		loginPool:
			dependencies.loginPool ?? ((poolId, context) => loginPoolInteractively(pi, poolId, context, { store })),
		researchKeys: dependencies.researchKeys ?? promptResearchKeys,
		kstackSetup: dependencies.kstackSetup ?? runKStackSetup,
	};
	pi.registerCommand(ONBOARDING_COMMAND, {
		description: "Guided first-run setup: model accounts, research keys, K-stack roles",
		handler: async (_args, context) => {
			await runOnboarding(context, resolved);
		},
	});
	pi.on("session_start", async (event, context) => {
		try {
			if (shouldAutoOnboard(event.reason, context, await resolved.store.read())) {
				await runOnboarding(context, resolved);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			context.ui.notify(`K-π onboarding failed: ${message}`, "error");
		}
	});
}
