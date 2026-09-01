import type { AuthEvent, AuthPrompt, Credential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../core/extensions/types.ts";
import { appendEvent } from "../append-log.ts";
import { readActiveJob } from "../run-store.ts";
import { AccountBalancer, type SelectedSlot } from "./balancer.ts";
import { classifyProviderFailure } from "./errors.ts";

import { type AccountsDocument, AccountsStore, isPoolId, type PoolId } from "./store.ts";
import { UsageCache } from "./usage/cache.ts";
import type { UsageReader } from "./usage/types.ts";
import { renderAccountsWidget } from "./widget.ts";

export const ANTHROPIC_EXTRA_USAGE_WARNING = `Claude Pro/Max in this harness uses Anthropic’s subscription OAuth, same as Pi and Atomic.

Anthropic’s own docs: third-party harness usage draws from extra usage and is billed per token, not against the in-app Claude plan bar.

API keys (ANTHROPIC_API_KEY) are a separate pay-as-you-go path.

You are responsible for the seats you attach.

Continue?`;

export const CODEX_BILLING_CONFIRM =
	"OpenAI Codex in this harness bills your Codex plan for every token this seat sends. Continue?";

export const CURSOR_BILLING_CONFIRM =
	"Cursor in this harness bills your Cursor plan for every token this seat sends. Continue?";

export const ZAI_PERSONAL_USE_NOTE =
	"z.ai Coding Plan is personal-use and official-tool-only; K-\u03c0 routes it through Pi's supported zai provider.";

/** A provider's one-time notice for a new slot. */
interface ProviderNotice {
	kind: "confirm" | "note";
	title: string;
	message: string;
}

/**
 * The notice a pool owes an operator once per new slot. A `confirm` may be
 * declined and then no slot is created; a `note` is stated and the login
 * proceeds. Either way the acceptance is stamped on the slot, so a later
 * session never repeats it.
 */
function providerNotice(poolId: PoolId): ProviderNotice | undefined {
	if (poolId === "anthropic") {
		return { kind: "confirm", title: "Anthropic extra-usage warning", message: ANTHROPIC_EXTRA_USAGE_WARNING };
	}
	if (poolId === "openai-codex") {
		return { kind: "confirm", title: "Codex billing", message: CODEX_BILLING_CONFIRM };
	}
	if (poolId === "cursor") {
		return { kind: "confirm", title: "Cursor billing", message: CURSOR_BILLING_CONFIRM };
	}
	if (poolId === "zai" || poolId === "zai-coding-cn") {
		return { kind: "note", title: "z.ai Coding Plan", message: ZAI_PERSONAL_USE_NOTE };
	}
	return undefined;
}

export interface AccountsDependencies {
	store?: AccountsStore;
	now?: () => Date;
	login?: (providerId: PoolId, slotId: string, context: ExtensionCommandContext) => Promise<Credential>;
	/**
	 * Readers for providers that document a usage endpoint. None by default: a
	 * provider without a documented signal stays unknown rather than polled.
	 */
	usageReaders?: Partial<Record<PoolId, UsageReader>>;
}

class LoginCancelledError extends Error {
	constructor() {
		super("Login cancelled");
	}
}

function authEventMessage(event: AuthEvent): string {
	if (event.type === "auth_url") {
		return [event.instructions, event.url].filter(Boolean).join("\n");
	}
	if (event.type === "device_code") {
		return `${event.verificationUri}\nCode: ${event.userCode}`;
	}
	const links = event.type === "info" ? (event.links ?? []) : [];
	return [event.message, ...links.map((link) => link.url)].join("\n");
}

async function answerAuthPrompt(prompt: AuthPrompt, context: ExtensionCommandContext): Promise<string> {
	if (prompt.type === "select") {
		const labels = prompt.options.map((option) => option.label);
		const selected = await context.ui.select(prompt.message, labels, {
			signal: prompt.signal,
		});
		const option = prompt.options.find((candidate) => candidate.label === selected);
		if (option === undefined) {
			throw new LoginCancelledError();
		}
		return option.id;
	}

	const answer = await context.ui.input(prompt.message, prompt.placeholder, {
		signal: prompt.signal,
	});
	if (answer === undefined) {
		throw new LoginCancelledError();
	}
	return answer;
}

function openAuthUrl(pi: ExtensionAPI, url: string): void {
	const command =
		process.platform === "darwin"
			? { name: "open", args: [url] }
			: process.platform === "win32"
				? { name: "cmd", args: ["/c", "start", "", url] }
				: { name: "xdg-open", args: [url] };
	void pi.exec(command.name, command.args).catch(() => undefined);
}

async function loginWithOfficialProvider(
	providerId: PoolId,
	_slotId: string,
	context: ExtensionCommandContext,
	showAuthUrl: (url: string) => void,
): Promise<Credential> {
	const oauth = context.modelRegistry.getProvider(providerId)?.auth.oauth;
	if (oauth === undefined) {
		throw new Error(`Provider ${providerId} does not offer subscription OAuth`);
	}
	const signal = context.signal ?? new AbortController().signal;
	const interaction: ProviderAuthInteraction = {
		signal,
		prompt: (prompt) => answerAuthPrompt(prompt, context),
		notify: (event) => {
			if (event.type === "auth_url") {
				showAuthUrl(event.url);
			}
			context.ui.notify(authEventMessage(event), "info");
		},
	};
	return oauth.login(interaction);
}

function accountLines(document: AccountsDocument): string[] {
	return Object.entries(document.pools).flatMap(([poolId, pool]) =>
		pool === undefined
			? []
			: pool.slots.map((slot) => `${poolId}/${slot.id}  ${slot.kind}  ${slot.label ?? slot.id}`),
	);
}

async function showAccounts(store: AccountsStore, context: ExtensionCommandContext): Promise<void> {
	const lines = accountLines(await store.read());
	context.ui.notify(lines.length === 0 ? "No accounts configured" : lines.join("\n"), "info");
}

async function loginAccount(
	providerName: string | undefined,
	requestedSlotId: string | undefined,
	store: AccountsStore,
	login: NonNullable<AccountsDependencies["login"]>,
	now: () => Date,
	context: ExtensionCommandContext,
): Promise<void> {
	if (providerName === undefined || !isPoolId(providerName)) {
		throw new Error("Usage: /accounts login <provider> [slot]");
	}

	const slotId = requestedSlotId ?? (await store.nextSlotId(providerName));
	const existing = await store.getSlot(providerName, slotId);
	let warningAcceptedAt = existing?.warningAcceptedAt;
	const notice = warningAcceptedAt === undefined ? providerNotice(providerName) : undefined;
	if (notice !== undefined) {
		if (notice.kind === "confirm" && !(await context.ui.confirm(notice.title, notice.message))) {
			context.ui.notify(`${providerName} login cancelled`, "info");
			return;
		}
		if (notice.kind === "note") {
			context.ui.notify(notice.message, "info");
		}
		warningAcceptedAt = now().toISOString();
	}

	const credential = await login(providerName, slotId, context);
	await store.putSlot(
		providerName,
		{
			id: slotId,
			kind: credential.type,
			label: existing?.label ?? slotId,
			warningAcceptedAt,
		},
		credential,
	);
	context.ui.notify(`Added account ${providerName}/${slotId}`, "info");
}

function resolveSlotReference(
	reference: string | undefined,
	document: AccountsDocument,
): { poolId: PoolId; slotId: string } {
	if (reference === undefined) {
		throw new Error("Usage: /accounts logout <pool/slot>");
	}
	const slash = reference.indexOf("/");
	if (slash >= 0) {
		const poolName = reference.slice(0, slash);
		const slotId = reference.slice(slash + 1);
		if (!isPoolId(poolName) || slotId.length === 0) {
			throw new Error(`Unknown account slot: ${reference}`);
		}
		return { poolId: poolName, slotId };
	}

	const matches = Object.entries(document.pools).flatMap(([poolId, pool]) =>
		pool?.slots.some((slot) => slot.id === reference) ? [{ poolId: poolId as PoolId, slotId: reference }] : [],
	);
	if (matches.length !== 1) {
		throw new Error(
			matches.length === 0
				? `Unknown account slot: ${reference}`
				: `Ambiguous account slot ${reference}; use pool/slot`,
		);
	}
	return matches[0];
}

async function logoutAccount(
	reference: string | undefined,
	store: AccountsStore,
	context: ExtensionCommandContext,
	onRemoved: (poolId: PoolId, slotId: string) => void,
): Promise<void> {
	const slot = resolveSlotReference(reference, await store.read());
	if (!(await store.removeSlot(slot.poolId, slot.slotId))) {
		throw new Error(`Unknown account slot: ${slot.poolId}/${slot.slotId}`);
	}
	// Logout is one of the three transitions that release a session pin.
	onRemoved(slot.poolId, slot.slotId);
	context.ui.notify(`Removed account ${slot.poolId}/${slot.slotId}`, "info");
}

/** The session routing a command may steer: the pin and the rotation. */
interface RoutingControls {
	advance: (poolId: PoolId) => void;
	pin: (poolId: PoolId, slotId: string) => void;
}

/** Resolves true when the command changed the stored accounts. */
async function handleAccountsCommand(
	args: string,
	context: ExtensionCommandContext,
	dependencies: Required<AccountsDependencies>,
	onSlotRemoved: (poolId: PoolId, slotId: string) => void,
	routing: RoutingControls,
): Promise<boolean> {
	const words = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
	const [action, first, second, ...extra] = words;
	if (action === undefined || action === "list") {
		await showAccounts(dependencies.store, context);
		return false;
	}
	if (extra.length > 0) {
		throw new Error("Too many /accounts arguments");
	}
	if (action === "login") {
		await loginAccount(first, second, dependencies.store, dependencies.login, dependencies.now, context);
		return true;
	}
	if (action === "logout") {
		if (second !== undefined) {
			throw new Error("Usage: /accounts logout <pool/slot>");
		}
		await logoutAccount(first, dependencies.store, context, onSlotRemoved);
		return true;
	}
	if (action === "next") {
		if (first === undefined) {
			throw new Error("Usage: /accounts next <pool>");
		}
		if (!isPoolId(first) || second !== undefined) {
			throw new Error(`Unknown pool id: ${first}`);
		}
		const document = await dependencies.store.read();
		if (document.pools[first] === undefined) {
			throw new Error(`No accounts configured for ${first}`);
		}
		routing.advance(first);
		context.ui.notify(`Advanced past the pinned ${first} slot`, "info");
		return false;
	}
	if (action === "pin") {
		if (second !== undefined) {
			throw new Error("Usage: /accounts pin <pool/slot>");
		}
		const reference = resolveSlotReference(first, await dependencies.store.read());
		const slot = await dependencies.store.getSlot(reference.poolId, reference.slotId);
		if (slot === undefined) {
			throw new Error(`Unknown account slot: ${reference.poolId}/${reference.slotId}`);
		}
		routing.pin(reference.poolId, reference.slotId);
		context.ui.notify(`Pinned ${reference.poolId}/${reference.slotId} for this session`, "info");
		return false;
	}
	throw new Error(`Unknown /accounts command: ${action}`);
}

/**
 * `/pool strategy <provider> <name>` and `/pool chain a,b,c`. Both persist
 * through the store's validated writers, so an unknown pool, strategy or
 * duplicate entry fails before anything reaches disk.
 */
async function handlePoolCommand(
	args: string,
	context: ExtensionCommandContext,
	store: AccountsStore,
): Promise<boolean> {
	const words = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
	const [action, first, second, ...extra] = words;
	if (extra.length > 0) {
		throw new Error("Too many /pool arguments");
	}
	if (action === "strategy") {
		if (first === undefined || second === undefined) {
			throw new Error("Usage: /pool strategy <provider> <quota-first|round-robin|sticky>");
		}
		if (!isPoolId(first)) {
			throw new Error(`Unknown pool id: ${first}`);
		}
		await store.setStrategy(first, second);
		context.ui.notify(`${first} strategy is ${second}`, "info");
		return true;
	}
	if (action === "chain") {
		if (first === undefined || second !== undefined) {
			throw new Error("Usage: /pool chain a,b,c");
		}
		const chain = first
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		await store.setChain(chain);
		context.ui.notify(`Fallback chain is ${chain.join(", ")}`, "info");
		return true;
	}
	throw new Error("Usage: /pool strategy <provider> <name> | /pool chain a,b,c");
}

export function registerAccounts(pi: ExtensionAPI, dependencies: AccountsDependencies = {}): void {
	const resolved: Required<AccountsDependencies> = {
		store: dependencies.store ?? new AccountsStore(),
		now: dependencies.now ?? (() => new Date()),
		login:
			dependencies.login ??
			((providerId, slotId, context) =>
				loginWithOfficialProvider(providerId, slotId, context, (url) => openAuthUrl(pi, url))),
		usageReaders: dependencies.usageReaders ?? {},
	};
	const nowMs = () => resolved.now().getTime();
	const balancer = new AccountBalancer(nowMs);
	const usage = new UsageCache({ now: nowMs, readers: resolved.usageReaders });
	let active: SelectedSlot | undefined;
	let activeModel: string | undefined;

	const configuredSlots = (accounts: AccountsDocument): { poolId: PoolId; slotId: string }[] =>
		Object.entries(accounts.pools).flatMap(([poolId, pool]) =>
			(pool?.slots ?? []).map((slot) => ({ poolId: poolId as PoolId, slotId: slot.id })),
		);

	/**
	 * Renders the current account picture. `accounts` is passed in wherever the
	 * caller already read it, so republishing on the request path costs a render
	 * rather than another store read; the usage cache and the balancer are both
	 * read from memory.
	 */
	const publishWidget = async (
		context: { ui: { setStatus: (key: string, value?: string) => void } },
		accounts?: AccountsDocument,
	): Promise<void> => {
		const widget = renderAccountsWidget(accounts ?? (await resolved.store.read()), {
			usage,
			health: balancer,
			route:
				active === undefined || activeModel === undefined
					? undefined
					: { provider: active.poolId, model: activeModel, slot: active.slot.id },
			now: nowMs(),
		});
		context.ui.setStatus("accounts", widget === "ACCOUNTS" ? undefined : widget);
	};

	if (typeof pi.on === "function") {
		pi.on("before_provider_headers", async (event, context) => {
			const provider = context.model?.provider;
			if (provider === undefined || !isPoolId(provider)) return;
			const accounts = await resolved.store.read();
			// Hot path: the cache is read synchronously and never refreshed here,
			// so no provider call stands between a turn and its headers.
			//
			// Family-scoped on purpose. A request built for one provider may only
			// carry a slot from that provider, so a fallback family's credential can
			// never be attached to it. Crossing families is the failover path's job,
			// and only after the model has actually been re-pointed.
			active = balancer.selectInFamily(provider, accounts, usage);
			activeModel = context.model?.id;
			// The route is only real once a slot is chosen, so publish here.
			await publishWidget(context, accounts);
			if (active === undefined || active.poolId !== provider) {
				return;
			}
			const credential = (await resolved.store.readSecrets())[`${active.poolId}/${active.slot.id}`];
			const token =
				credential?.type === "oauth"
					? credential.access
					: credential?.type === "api_key"
						? credential.key
						: undefined;
			if (token !== undefined) event.headers.authorization = `Bearer ${token}`;
		});
		pi.on("after_provider_response", async (event, context) => {
			if (active === undefined) return;
			// Off the hot path: record what the response's own headers stated. Every
			// response carries limits, not just the failures, so publish either way.
			usage.recordHeaders(active.poolId, active.slot.id, event.headers ?? {});
			// The same clock the balancer checks health against: a cooldown parsed
			// on a different time base would expire at the wrong moment.
			const classification = classifyProviderFailure(
				{
					status: event.status,
					headers: event.headers,
				},
				nowMs(),
			);
			if (classification === undefined) {
				await publishWidget(context);
				return;
			}
			balancer.markCooling(active.poolId, active.slot.id, classification.until);

			const accounts = await resolved.store.read();
			const plan = balancer.planFailover(
				active,
				accounts,
				context.modelRegistry.getAvailable(),
				context.model,
				usage,
			);
			if (plan === undefined) {
				// Still a state change: this slot is now cooling.
				await publishWidget(context, accounts);
				return;
			}
			// A same-family sibling speaks the same catalog, so the request keeps its
			// exact model and thinking level and the route may move immediately.
			//
			// Crossing families may only be recorded once the model has actually been
			// re-pointed: without a mapped equivalent, or if the harness refuses the
			// change, the route must stay where it is rather than name a slot whose
			// credential this provider would never accept.
			let moved = false;
			if (plan.sameFamily) {
				active = { poolId: plan.to.poolId, slot: plan.to.slot };
				moved = true;
			} else if (plan.model !== undefined && (await pi.setModel(plan.model))) {
				active = { poolId: plan.to.poolId, slot: plan.to.slot };
				activeModel = plan.model.id;
				moved = true;
			}

			if (moved) {
				const job = await readActiveJob(context.cwd);
				if (job !== undefined) {
					await appendEvent(job.eventsPath, {
						ts: resolved.now().toISOString(),
						type: "accounts.failover",
						job_id: job.jobId,
						round: typeof job.state.round === "number" ? job.state.round : 0,
						node: typeof job.state.node === "string" ? job.state.node : "accounts",
						from: `${plan.from.poolId}/${plan.from.slot.id}`,
						to: `${plan.to.poolId}/${plan.to.slot.id}`,
					});
				}
			}
			await publishWidget(context, accounts);
		});
		pi.on("session_start", async (_event, context) => {
			// The official primary credential becomes slot `default` before any
			// turn needs a slot. The secret moves between private agent files.
			const imported = await resolved.store.importOfficialCredentials();
			if (imported.length > 0) {
				context.ui.notify(`Imported official credentials as ${imported.join(", ")}`, "info");
			}
			// Refresh off the request path, before any turn needs a decision.
			await usage.refreshAll(configuredSlots(await resolved.store.read()), context.signal);
			await publishWidget(context);
		});
	}
	pi.registerCommand("pool", {
		description: "Set a K-\u03c0 pool strategy or the fallback chain",
		handler: async (args, context) => {
			try {
				if (await handlePoolCommand(args, context, resolved.store)) {
					await publishWidget(context);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				context.ui.notify(`K-\u03c0 pool: ${message}`, "error");
			}
		},
	});
	pi.registerCommand("accounts", {
		description: "Manage K-π subscription accounts",
		handler: async (args, context) => {
			try {
				const changed = await handleAccountsCommand(
					args,
					context,
					resolved,
					(poolId, slotId) => {
						balancer.releaseSlot(poolId, slotId);
						usage.forget(poolId, slotId);
						if (active?.poolId === poolId && active.slot.id === slotId) {
							active = undefined;
							activeModel = undefined;
						}
					},
					{
						advance: (poolId) => balancer.advance(poolId),
						pin: (poolId, slotId) => balancer.pinSlot(poolId, slotId),
					},
				);
				if (changed) {
					await publishWidget(context);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				context.ui.notify(`K-π accounts: ${message}`, "error");
			}
		},
	});
}
