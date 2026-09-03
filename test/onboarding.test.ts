import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "../packages/coding-agent/src/core/extensions/types.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import kPi from "../packages/coding-agent/src/kpi/extensions/index.ts";
import {
	ONBOARDING_COMMAND,
	type OnboardingDependencies,
	type OnboardingOutcome,
	registerOnboarding,
	runOnboarding,
	shouldAutoOnboard,
	WELCOME_LINES,
} from "../packages/coding-agent/src/kpi/extensions/onboarding.ts";
import { resolveResearchKeys } from "../packages/coding-agent/src/kpi/extensions/research/session.ts";
import { promptResearchKeys } from "../packages/coding-agent/src/kpi/extensions/research/setup.ts";

const EXA_CANARY = "onboard-exa-canary-4b91cc";
const FIRECRAWL_CANARY = "onboard-firecrawl-canary-7e02aa";

/** A queue-driven UI double: each select/input answer is consumed in order. */
interface ScriptedUi {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
	confirm: (title: string, message: string) => Promise<boolean>;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	notes: string[];
	warnings: string[];
	errors: string[];
	selectTitles: string[];
	inputTitles: string[];
}

function scriptedUi(selectAnswers: (string | undefined)[], inputAnswers: (string | undefined)[] = []): ScriptedUi {
	const selectQueue = [...selectAnswers];
	const inputQueue = [...inputAnswers];
	const notes: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const selectTitles: string[] = [];
	const inputTitles: string[] = [];
	return {
		async select(title) {
			selectTitles.push(title);
			return selectQueue.shift();
		},
		async input(title) {
			inputTitles.push(title);
			return inputQueue.shift();
		},
		async confirm() {
			return true;
		},
		notify(message, level) {
			(level === "error" ? errors : level === "warning" ? warnings : notes).push(message);
		},
		notes,
		warnings,
		errors,
		selectTitles,
		inputTitles,
	};
}

interface Home {
	home: string;
	agentDirectory: string;
	project: string;
	cleanup: () => Promise<void>;
}

async function withHome(): Promise<Home> {
	const home = await mkdtemp(join(tmpdir(), "kpi-onboarding-home-"));
	const project = await mkdtemp(join(tmpdir(), "kpi-onboarding-project-"));
	const agentDirectory = join(home, ".kpi", "agent");
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.KPI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.KPI_CODING_AGENT_DIR = agentDirectory;
	return {
		home,
		agentDirectory,
		project,
		cleanup: async () => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousAgentDir === undefined) delete process.env.KPI_CODING_AGENT_DIR;
			else process.env.KPI_CODING_AGENT_DIR = previousAgentDir;
			await rm(home, { recursive: true, force: true });
			await rm(project, { recursive: true, force: true });
		},
	};
}

function fakeContext(ui: ScriptedUi, overrides: Partial<ExtensionContext> = {}, cwd = "/tmp"): ExtensionContext {
	return {
		ui: ui as unknown as ExtensionContext["ui"],
		mode: "tui",
		hasUI: true,
		cwd,
		modelRegistry: { getAvailable: () => [] } as unknown as ExtensionContext["modelRegistry"],
		signal: undefined,
		...overrides,
	} as ExtensionContext;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

test("the onboarding factory registers /onboarding last and one session_start hook", () => {
	const commandNames: string[] = [];
	const sessionStartHandlers: unknown[] = [];
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStartHandlers.push(handler);
		},
		registerCommand(name: string, options: { handler: unknown }) {
			commandNames.push(name);
			assert.equal(typeof options.handler, "function");
		},
	};
	registerOnboarding(pi as unknown as ExtensionAPI);
	assert.deepEqual(commandNames, [ONBOARDING_COMMAND]);
	assert.equal(sessionStartHandlers.length, 1);

	// The full factory ends its command list with "onboarding" (test/extension.test.ts).
	const fullCommandNames: string[] = [];
	const fullPi = {
		on() {},
		registerCommand(name: string) {
			fullCommandNames.push(name);
		},
		registerEntryRenderer() {},
	};
	assert.doesNotThrow(() => kPi(fullPi as unknown as Parameters<typeof kPi>[0]));
	assert.equal(fullCommandNames.at(-1), "onboarding");
});

test("a scripted onboarding adds accounts, saves research keys, maps K-stack, and writes no project file", async () => {
	const env = await withHome();
	try {
		const store = new AccountsStore();
		const ui = scriptedUi(
			["Start setup", "anthropic — 0 slot(s)", "Continue", "Enter API keys", "Map roles now"],
			[EXA_CANARY, "s", FIRECRAWL_CANARY],
		);
		const kstackCalls: ExtensionContext[] = [];
		const loginPool: NonNullable<OnboardingDependencies["loginPool"]> = async (poolId, _context) => {
			assert.equal(poolId, "anthropic");
			await store.putSlot("anthropic", { id: "a", kind: "api_key" }, { type: "api_key", key: "acct-key" });
			return { poolId, slotId: "a" };
		};
		const dependencies: Required<OnboardingDependencies> = {
			store,
			loginPool,
			// The real promptResearchKeys: exercises the shared writer end to end.
			researchKeys: promptResearchKeys,
			kstackSetup: async (context) => {
				kstackCalls.push(context);
			},
		};
		const context = fakeContext(ui, {}, env.project);

		const outcome = await runOnboarding(context, dependencies);

		assert.deepEqual(outcome, {
			status: "completed",
			accounts: ["anthropic/a"],
			researchServices: ["exa", "firecrawl"],
			kstack: true,
		} satisfies OnboardingOutcome);

		const document = await store.read();
		assert.deepEqual(
			document.pools.anthropic?.slots.map((slot) => slot.id),
			["a"],
		);

		const keys = await resolveResearchKeys(env.agentDirectory);
		assert.equal(keys.exa, EXA_CANARY);
		assert.equal(keys.firecrawl, FIRECRAWL_CANARY);
		assert.equal(keys.perplexity, undefined);

		assert.equal(
			await exists(join(env.project, ".kpi", "settings.json")),
			false,
			"onboarding writes no project file",
		);
		assert.equal(
			await exists(join(env.agentDirectory, "settings.json")),
			false,
			"onboarding never touches the harness's own settings.json",
		);

		assert.equal(kstackCalls.length, 1);
		assert.equal(kstackCalls[0], context);

		const summary = ui.notes.at(-1) ?? "";
		assert.match(summary, /anthropic\/a/u);
		assert.match(summary, /exa, firecrawl/u);
		for (const message of [...ui.notes, ...ui.warnings, ...ui.errors]) {
			assert.doesNotMatch(message, new RegExp(`${EXA_CANARY}|${FIRECRAWL_CANARY}`, "u"));
		}
	} finally {
		await env.cleanup();
	}
});

test("skipped onboarding steps write nothing and Not now closes the wizard for this launch", async () => {
	const env = await withHome();
	try {
		const store = new AccountsStore();
		let loginPoolCalls = 0;
		let kstackCalls = 0;
		const dependencies: Required<OnboardingDependencies> = {
			store,
			loginPool: async () => {
				loginPoolCalls += 1;
				return undefined;
			},
			researchKeys: async () => [],
			kstackSetup: async () => {
				kstackCalls += 1;
			},
		};

		const ui = scriptedUi(["Start setup", "Continue", "Skip", "Skip"]);
		const outcome = await runOnboarding(fakeContext(ui, {}, env.project), dependencies);
		assert.deepEqual(outcome, {
			status: "completed",
			accounts: [],
			researchServices: undefined,
			kstack: false,
		} satisfies OnboardingOutcome);
		assert.equal(loginPoolCalls, 0);
		assert.equal(kstackCalls, 0);
		assert.equal((await store.read()).pools.anthropic, undefined, "no slot was added");
		assert.equal(await exists(join(env.agentDirectory, "accounts.secrets.json")), false);
		assert.equal(await exists(join(env.project, ".kpi", "settings.json")), false);
		assert.match(ui.notes.at(-1) ?? "", /research keys: skipped/u);

		const before = (await exists(env.agentDirectory)) ? await readdir(env.agentDirectory) : [];

		for (const notNowAnswer of ["Not now", undefined]) {
			const deferredUi = scriptedUi([notNowAnswer]);
			const deferred = await runOnboarding(fakeContext(deferredUi, {}, env.project), dependencies);
			assert.deepEqual(deferred, { status: "deferred", accounts: [], kstack: false });
			assert.equal(loginPoolCalls, 0);
			assert.equal(kstackCalls, 0);
		}

		const after = (await exists(env.agentDirectory)) ? await readdir(env.agentDirectory) : [];
		assert.deepEqual(before, after, "the agent dir listing is unchanged by a deferred run");
	} finally {
		await env.cleanup();
	}
});

test("first-run onboarding fires only for a tui startup with nothing to route", async () => {
	const env = await withHome();
	try {
		const store = new AccountsStore();
		const emptyDocument = await store.read();

		const availableModel = { provider: "anthropic", id: "claude" } as unknown;
		const registryWithModel = {
			getAvailable: () => [availableModel],
		} as unknown as ExtensionContext["modelRegistry"];
		const emptyRegistry = { getAvailable: () => [] } as unknown as ExtensionContext["modelRegistry"];

		for (const mode of ["print", "rpc", "json"] as const) {
			assert.equal(
				shouldAutoOnboard(
					"startup",
					fakeContext(scriptedUi([]), { mode, modelRegistry: emptyRegistry }),
					emptyDocument,
				),
				false,
				`mode ${mode}`,
			);
		}
		for (const reason of ["reload", "new", "resume", "fork"] as SessionStartEvent["reason"][]) {
			assert.equal(
				shouldAutoOnboard(reason, fakeContext(scriptedUi([]), { modelRegistry: emptyRegistry }), emptyDocument),
				false,
				`reason ${reason}`,
			);
		}
		assert.equal(
			shouldAutoOnboard(
				"startup",
				fakeContext(scriptedUi([]), { hasUI: false, modelRegistry: emptyRegistry }),
				emptyDocument,
			),
			false,
			"hasUI false",
		);

		// A slot in any pool means K-π has somewhere to route.
		await store.putLocalSlot("local-openai", {
			id: "a",
			kind: "local",
			label: "a",
			baseUrl: "http://127.0.0.1:1234/v1",
		});
		const documentWithSlot = await store.read();
		assert.equal(
			shouldAutoOnboard("startup", fakeContext(scriptedUi([]), { modelRegistry: emptyRegistry }), documentWithSlot),
			false,
			"a pool with a slot",
		);

		// An env-key-only harness: the harness has a model, K-π has zero slots.
		assert.equal(
			shouldAutoOnboard("startup", fakeContext(scriptedUi([]), { modelRegistry: registryWithModel }), emptyDocument),
			false,
			"the harness already has an available model",
		);

		assert.equal(
			shouldAutoOnboard("startup", fakeContext(scriptedUi([]), { modelRegistry: emptyRegistry }), emptyDocument),
			true,
			"tui + startup + hasUI + empty pools + empty getAvailable",
		);

		// Invoking the captured session_start handler. A fresh store: `store`
		// above was given a local-openai slot to prove the "a pool with a slot"
		// case and must not leak into the "true" case below.
		const freshStore = new AccountsStore(await mkdtemp(join(tmpdir(), "kpi-onboarding-fresh-")));
		let sessionStartHandler: ((event: SessionStartEvent, context: ExtensionContext) => Promise<void>) | undefined;
		const pi = {
			on(event: string, handler: unknown) {
				if (event === "session_start") {
					sessionStartHandler = handler as (event: SessionStartEvent, context: ExtensionContext) => Promise<void>;
				}
			},
			registerCommand() {},
		};
		registerOnboarding(pi as unknown as ExtensionAPI, { store: freshStore });

		const trueUi = scriptedUi(["Not now"]);
		await sessionStartHandler!(
			{ type: "session_start", reason: "startup" },
			fakeContext(trueUi, { modelRegistry: emptyRegistry }),
		);
		assert.equal(trueUi.selectTitles.length, 1);
		assert.equal(trueUi.selectTitles[0], "Welcome to K-π");

		const printUi = scriptedUi([]);
		await sessionStartHandler!(
			{ type: "session_start", reason: "startup" },
			fakeContext(printUi, { mode: "print", modelRegistry: emptyRegistry }),
		);
		assert.equal(printUi.selectTitles.length, 0, "ui.select is never called in print mode");

		// A store.read() that throws is reported and never crashes the handler.
		const throwingStore = {
			read: async () => {
				throw new Error("disk gone");
			},
		} as unknown as AccountsStore;
		const throwPi = {
			on(event: string, handler: unknown) {
				if (event === "session_start") {
					sessionStartHandler = handler as (event: SessionStartEvent, context: ExtensionContext) => Promise<void>;
				}
			},
			registerCommand() {},
		};
		registerOnboarding(throwPi as unknown as ExtensionAPI, { store: throwingStore });
		const throwUi = scriptedUi([]);
		await assert.doesNotReject(
			sessionStartHandler!(
				{ type: "session_start", reason: "startup" },
				fakeContext(throwUi, { modelRegistry: emptyRegistry }),
			),
		);
		assert.equal(throwUi.errors.length, 1);
		assert.match(throwUi.errors[0], /K-π onboarding failed/u);
	} finally {
		await env.cleanup();
	}
});

test("/onboarding re-runs after setup and a failed login is reported by name", async () => {
	const env = await withHome();
	try {
		const store = new AccountsStore();
		// A configured slot is already present; the command still runs the wizard.
		await store.putLocalSlot("local-openai", {
			id: "a",
			kind: "local",
			label: "a",
			baseUrl: "http://127.0.0.1:1234/v1",
		});

		let commandHandler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
		const pi = {
			on() {},
			registerCommand(
				_name: string,
				options: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> },
			) {
				commandHandler = options.handler;
			},
		};

		class LoginCancelledError extends Error {
			constructor() {
				super("Login cancelled");
			}
		}
		let attempt = 0;
		const loginPool: NonNullable<OnboardingDependencies["loginPool"]> = async (poolId) => {
			attempt += 1;
			if (poolId === "anthropic") {
				throw new LoginCancelledError();
			}
			if (poolId === "openai") {
				return { poolId, slotId: "a" };
			}
			throw new Error("unexpected pool");
		};
		registerOnboarding(pi as unknown as ExtensionAPI, { store, loginPool });

		const ui = scriptedUi(["Start setup", "anthropic — 0 slot(s)", "openai — 0 slot(s)", "Continue", "Skip", "Skip"]);
		await commandHandler!("", fakeContext(ui, {}, env.project) as unknown as ExtensionCommandContext);

		assert.equal(ui.selectTitles[0], "Welcome to K-π", "the command still runs the wizard with a configured slot");
		assert.equal(attempt, 2, "both picks were attempted");
		assert.equal(ui.warnings.length, 1);
		assert.match(ui.warnings[0], /anthropic/u);
		assert.match(ui.warnings[0], /not completed/u);
		assert.match(ui.notes.at(-1) ?? "", /openai\/a/u, "the second pick succeeded and is listed");

		// A generic Error never rejects runOnboarding either.
		const genericUi = scriptedUi(["Start setup", "anthropic — 0 slot(s)", "Continue", "Skip", "Skip"]);
		const genericLoginPool: NonNullable<OnboardingDependencies["loginPool"]> = async () => {
			throw new Error("transport reset");
		};
		await assert.doesNotReject(
			runOnboarding(fakeContext(genericUi, {}, env.project), {
				store,
				loginPool: genericLoginPool,
				researchKeys: async () => [],
				kstackSetup: async () => undefined,
			}),
		);
		assert.equal(genericUi.warnings.length, 1);
		assert.match(genericUi.warnings[0], /not completed/u);

		// A decline (undefined) adds nothing and warns nothing.
		const declineUi = scriptedUi(["Start setup", "anthropic — 0 slot(s)", "Continue", "Skip", "Skip"]);
		const decliningLoginPool: NonNullable<OnboardingDependencies["loginPool"]> = async () => undefined;
		const declined = await runOnboarding(fakeContext(declineUi, {}, env.project), {
			store,
			loginPool: decliningLoginPool,
			researchKeys: async () => [],
			kstackSetup: async () => undefined,
		});
		assert.deepEqual(declined.accounts, []);
		assert.equal(declineUi.warnings.length, 0);
	} finally {
		await env.cleanup();
	}
});

test("welcome copy names the plan gate, the release gate, and the worker bus", () => {
	const joined = WELCOME_LINES.join("\n");
	assert.match(joined, /plan gate/iu);
	assert.match(joined, /release gate/iu);
	assert.match(joined, /\/agents/u);
});
