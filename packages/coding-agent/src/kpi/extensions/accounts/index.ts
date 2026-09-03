import type {
	AssistantMessage,
	AuthEvent,
	AuthPrompt,
	Credential,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../../core/extensions/types.ts";
import { resolveFallbackModels } from "../../kstack/models.ts";
import { appendEvent } from "../append-log.ts";
import { DEFAULT_LOCAL_BASE_URLS, type LocalProviderId } from "../local/providers.ts";
import type { ResearchService } from "../research/session.ts";
import { removeResearchKey, saveResearchKeys } from "../research/setup.ts";
import { readActiveJob } from "../run-store.ts";
import { writeResearchMode } from "../settings.ts";
import { setFooterRouteSnapshot } from "../status-line/route-snapshot.ts";
import { AccountBalancer, LOW_QUOTA_REMAINING_PERCENT, type SelectedSlot } from "./balancer.ts";
import { classifyProviderBodyFailure, classifyProviderFailure, DEFAULT_COOLDOWN_MS } from "./errors.ts";
import {
	type AccountsDocument,
	AccountsStore,
	isLocalPool,
	isPoolId,
	type PoolId,
	poolIdForProvider,
} from "./store.ts";
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
/**
 * Where a credential travels for each API family.
 *
 * A key is only a credential if the provider reads it where it looks. Anthropic
 * reads `x-api-key`, Google reads `x-goog-api-key`, Azure reads `api-key`; for
 * those, an `Authorization: Bearer` header is an unauthenticated request with a
 * valid key attached. Subscription tokens are bearer tokens everywhere,
 * including Anthropic OAuth and Codex.
 */
export function authHeaderName(api: string | undefined, credentialType: "oauth" | "api_key" | undefined): string {
	if (credentialType !== "api_key") {
		return "authorization";
	}
	switch (api) {
		case "anthropic-messages":
			return "x-api-key";
		case "google-generative-ai":
		case "google-vertex":
			return "x-goog-api-key";
		case "azure-openai-responses":
			return "api-key";
		default:
			return "authorization";
	}
}

/**
 * Attaches the credential using the family's own header and clears the ones it
 * would otherwise be mistaken for: Anthropic and Google both skip their key
 * header when an `Authorization` is already present, so a stale bearer would
 * silently win over the key we mean to send.
 */
function setAuthHeader(
	headers: Record<string, string | null>,
	api: string | undefined,
	credentialType: "oauth" | "api_key" | undefined,
	token: string,
): void {
	const name = authHeaderName(api, credentialType);
	for (const competing of ["authorization", "x-api-key", "x-goog-api-key", "api-key"]) {
		if (competing !== name && headers[competing] !== undefined) {
			headers[competing] = null;
		}
	}
	headers[name] = name === "authorization" ? `Bearer ${token}` : token;
}

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
	/** Injected in tests; production reads the exact order written by setup-kstack. */
	fallbackModels?: () => Promise<readonly string[] | undefined>;
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

/**
 * Acquires the credential the pool's provider actually offers, rather than
 * assuming every official pool is a subscription. Subscription OAuth wins
 * wherever it exists — a provider declaring both, such as `kimi-coding`, is a
 * subscription seat first — and a key-only provider such as `zai` is asked for
 * its key instead of being refused. The key prompt is titled with the
 * provider's own `apiKey.name`, so the operator reads the label the provider
 * definition ships. An empty answer cancels exactly like a dismissed OAuth
 * prompt: no slot, no secret.
 */
async function loginWithOfficialProvider(
	providerId: PoolId,
	_slotId: string,
	context: ExtensionCommandContext,
	showAuthUrl: (url: string) => void,
): Promise<Credential> {
	const auth = context.modelRegistry.getProvider(providerId)?.auth;
	if (auth?.oauth !== undefined) {
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
		return context.modelRegistry.login(providerId, "oauth", interaction);
	}
	if (auth?.apiKey !== undefined) {
		const answer = await context.ui.input(auth.apiKey.name, "Paste the key, or Enter to cancel", {
			signal: context.signal,
		});
		const key = (answer ?? "").trim();
		if (key.length === 0) {
			throw new LoginCancelledError();
		}
		return { type: "api_key", key };
	}
	throw new Error(`Provider ${providerId} offers neither subscription OAuth nor an API key`);
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
): Promise<{ poolId: PoolId; slotId: string } | undefined> {
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
			return undefined;
		}
		if (notice.kind === "note") {
			context.ui.notify(notice.message, "info");
		}
		warningAcceptedAt = now().toISOString();
	}

	if (isLocalPool(providerName)) {
		// REQ-SL-01: a local slot is credential-free and persists its own origin.
		const fallbackUrl = DEFAULT_LOCAL_BASE_URLS[providerName as LocalProviderId];
		const answer = await context.ui.input(`Base URL for ${providerName}`, fallbackUrl ?? "http://127.0.0.1:8000/v1");
		const baseUrl = (answer ?? "").trim().length > 0 ? (answer as string).trim() : fallbackUrl;
		if (baseUrl === undefined || baseUrl.length === 0) {
			throw new Error(`${providerName} needs a base URL`);
		}
		await store.putLocalSlot(providerName, {
			id: slotId,
			kind: "local",
			label: existing?.label ?? slotId,
			warningAcceptedAt,
			baseUrl,
		});
		context.ui.notify(`Added local account ${providerName}/${slotId} on ${baseUrl}`, "info");
		return { poolId: providerName, slotId };
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
	return { poolId: providerName, slotId };
}

function isResearchService(value: string | undefined): value is ResearchService {
	return value === "exa" || value === "perplexity";
}

/**
 * Stores a research credential. Nothing about routing changes: no slot is
 * created, no pool gains a member, and no provider is registered.
 */
async function loginResearchService(service: ResearchService, context: ExtensionCommandContext): Promise<void> {
	const key = await context.ui.input(`${service} API key for research`, "Paste the key, or Enter to cancel");
	const trimmed = (key ?? "").trim();
	if (trimmed.length === 0) {
		context.ui.notify(`Cancelled ${service} research login`, "info");
		return;
	}
	await saveResearchKeys(service === "exa" ? { exa: trimmed } : { perplexity: trimmed });
	// Online research is now possible, so the default mode reflects that.
	await writeResearchMode(context.cwd, "auto");
	context.ui.notify(`Saved ${service} research credential`, "info");
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

/** The session routing a command may steer: the pin, the rotation, the route. */
interface RoutingControls {
	/** The pool the session is currently routed through, if any. */
	activePool: () => PoolId | undefined;
	advance: (poolId: PoolId) => Promise<void>;
	pin: (poolId: PoolId, slotId: string) => Promise<void>;
}

/** Resolves true when the command changed something the widget shows. */
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
	if (action === "login" || action === "login-active") {
		// `exa` and `perplexity` are research credential targets, never pools: they
		// create no slot, join no fallback chain, and change no routing.
		if (isResearchService(first)) {
			if (action === "login-active" || second !== undefined) {
				throw new Error(`Usage: /accounts login ${first}`);
			}
			await loginResearchService(first, context);
			return false;
		}
		const loggedIn = await loginAccount(
			first,
			second,
			dependencies.store,
			dependencies.login,
			dependencies.now,
			context,
		);
		if (loggedIn === undefined) {
			return false;
		}
		if (action === "login-active") {
			await routing.pin(loggedIn.poolId, loggedIn.slotId);
		}
		return true;
	}
	if (action === "logout") {
		if (isResearchService(first)) {
			if (second !== undefined) {
				throw new Error(`Usage: /accounts logout ${first}`);
			}
			const removed = await removeResearchKey(first);
			context.ui.notify(
				removed ? `Removed ${first} research credential` : `No ${first} research credential to remove`,
				"info",
			);
			return false;
		}
		if (second !== undefined) {
			throw new Error("Usage: /accounts logout <pool/slot>");
		}
		await logoutAccount(first, dependencies.store, context, onSlotRemoved);
		return true;
	}
	if (action === "next") {
		// Normative grammar is no-arg: it advances the pool the session is on.
		if (first !== undefined) {
			throw new Error("Usage: /accounts next");
		}
		const current = routing.activePool();
		if (current === undefined) {
			throw new Error("No active route to advance; run a turn first");
		}
		await routing.advance(current);
		context.ui.notify(`Advanced past the pinned ${current} slot`, "info");
		return true;
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
		await routing.pin(reference.poolId, reference.slotId);
		context.ui.notify(`Pinned ${reference.poolId}/${reference.slotId} for this session`, "info");
		return true;
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
		fallbackModels: dependencies.fallbackModels ?? resolveFallbackModels,
	};
	const nowMs = () => resolved.now().getTime();
	const balancer = new AccountBalancer(nowMs);
	const usage = new UsageCache({ now: nowMs, readers: resolved.usageReaders });
	// The route the widget shows: always the newest selection.
	let active: SelectedSlot | undefined;
	let activeModel: string | undefined;
	/**
	 * Accounting is per request, not per session. Each `before_provider_headers`
	 * carries the id of the request it is building, and that request's
	 * `after_provider_response` carries the same id, so a response is always
	 * matched to the credential this extension actually attached - even when two
	 * requests to one provider hold different slots and finish out of order.
	 *
	 * A request that never produces a response (transport failure, an adapter
	 * that does not report responses, an abandoned turn) simply leaves its entry
	 * unclaimed: nothing waits on it, and the oldest entries are evicted so an
	 * unpaired request cannot grow the map without bound.
	 */
	const requestSlots = new Map<string, SelectedSlot>();
	const REQUEST_SLOT_LIMIT = 64;

	const recordRequestSlot = (requestId: string, selection: SelectedSlot): void => {
		// Re-inserted so eviction order stays newest-last.
		requestSlots.delete(requestId);
		requestSlots.set(requestId, selection);
		while (requestSlots.size > REQUEST_SLOT_LIMIT) {
			const oldest = requestSlots.keys().next();
			if (oldest.done === true) break;
			requestSlots.delete(oldest.value);
		}
	};

	const configuredSlots = (accounts: AccountsDocument): { poolId: PoolId; slotId: string }[] =>
		Object.entries(accounts.pools).flatMap(([poolId, pool]) =>
			(pool?.slots ?? []).map((slot) => ({ poolId: poolId as PoolId, slotId: slot.id })),
		);

	const refreshExpiringCredentials = async (context: ExtensionContext): Promise<void> => {
		if (context.modelRegistry === undefined) return;
		const [accounts, secrets] = await Promise.all([resolved.store.read(), resolved.store.readSecrets()]);
		for (const [poolName, pool] of Object.entries(accounts.pools)) {
			if (pool === undefined || !isPoolId(poolName)) continue;
			const oauth = context.modelRegistry.getProvider(poolName)?.auth?.oauth;
			if (oauth === undefined) continue;
			for (const slot of pool.slots) {
				const credential = secrets[`${poolName}/${slot.id}`];
				if (
					credential?.type !== "oauth" ||
					credential.expires === undefined ||
					credential.expires > nowMs() + 5 * 60 * 1_000
				) {
					continue;
				}
				try {
					const refreshed = await oauth.refresh(credential, context.signal ?? new AbortController().signal);
					await resolved.store.putSlot(poolName, slot, refreshed);
				} catch (error) {
					balancer.markCooling(poolName, slot.id, nowMs() + DEFAULT_COOLDOWN_MS);
					const reason = error instanceof Error ? error.message : String(error);
					context.ui.notify(`Could not refresh ${poolName}/${slot.id}: ${reason}`, "warning");
				}
			}
		}
	};

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
		const doc = accounts ?? (await resolved.store.read());
		const route =
			active === undefined || activeModel === undefined
				? undefined
				: { provider: active.poolId, model: activeModel, slot: active.slot.id };
		const widget = renderAccountsWidget(doc, {
			usage,
			health: balancer,
			route,
			now: nowMs(),
		});
		context.ui.setStatus("accounts", widget === "ACCOUNTS" ? undefined : widget);
		// Footer/board consume slot kind without starting a model.
		if (active !== undefined) {
			const snapshot = usage.get(active.poolId, active.slot.id);
			setFooterRouteSnapshot({
				slotKind: active.slot.kind,
				...(route === undefined ? {} : { route: `${route.provider}/${route.model}` }),
				...(active.slot.kind === "local" || snapshot?.remainingPercent === undefined
					? {}
					: { remainingPercent: snapshot.remainingPercent }),
			});
		}
	};

	/**
	 * Recomputes the route inside one family after an operator steer, so the
	 * widget states where the next request will actually go rather than the slot
	 * the session has just been moved off. The next header hook selects again and
	 * lands on the same slot, because the pin and the skip are what it reads.
	 */
	const reroute = async (poolId: PoolId): Promise<void> => {
		if (active?.poolId !== poolId) {
			return;
		}
		const next = balancer.selectInFamily(poolId, await resolved.store.read(), usage);
		active = next === undefined ? undefined : { poolId: next.poolId, slot: next.slot };
		if (next === undefined) {
			activeModel = undefined;
		}
	};

	const applyFailure = async (served: SelectedSlot, until: number, context: ExtensionContext): Promise<boolean> => {
		balancer.markCooling(served.poolId, served.slot.id, until);
		const accounts = await resolved.store.read();
		const preferredModels = await resolved.fallbackModels().catch(() => undefined);
		const plan = balancer.planFailover(
			served,
			accounts,
			context.modelRegistry.getAvailable(),
			context.model,
			usage,
			preferredModels,
		);
		if (plan === undefined) {
			await publishWidget(context, accounts);
			return false;
		}

		// Only the request that is still the current route may move it. An older
		// response must not re-point a route a newer request already chose.
		const stillCurrent = active?.poolId === served.poolId && active.slot.id === served.slot.id;
		let moved = false;
		if (plan.sameFamily && stillCurrent) {
			active = { poolId: plan.to.poolId, slot: plan.to.slot };
			moved = true;
		} else if (!plan.sameFamily && stillCurrent && plan.model !== undefined && (await pi.setModel(plan.model))) {
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
		return moved;
	};

	/**
	 * Responses whose assistant message has not ended yet, by request id. The
	 * `message_end` event carries no request id, so pairing is by elimination
	 * rather than by claim: an assistant error pairs with the one failed
	 * response still pending, and when that is ambiguous nothing is paired.
	 * Requests may interleave (see the reverse-order routing test), so a single
	 * slot would pair the wrong two; a map bounded at MAX_PENDING_RESPONSES
	 * cannot grow on a request whose message never ends.
	 */
	interface PendingResponse {
		served: SelectedSlot;
		status: number;
		classificationHandled: boolean;
		retryOnMovedRoute: boolean;
	}
	const MAX_PENDING_RESPONSES = 8;
	const pendingResponses = new Map<string, PendingResponse>();
	const slotName = (response: PendingResponse): string => `${response.served.poolId}/${response.served.slot.id}`;
	/**
	 * Keeps a response until its message ends. Past the cap the oldest is let
	 * go, and the operator is told which slot's response can no longer be
	 * attributed: a lost attribution is a visible fact, not a silent one.
	 */
	let evictionReported = false;
	const rememberResponse = (requestId: string, response: PendingResponse, context: ExtensionContext): void => {
		pendingResponses.delete(requestId);
		pendingResponses.set(requestId, response);
		while (pendingResponses.size > MAX_PENDING_RESPONSES) {
			const [oldestId, oldest] = pendingResponses.entries().next().value ?? [];
			if (oldestId === undefined || oldest === undefined) break;
			pendingResponses.delete(oldestId);
			// Said once per agent run, not once per eviction: under sustained load
			// the fact is the same and a notice per response would be noise.
			if (!evictionReported) {
				evictionReported = true;
				context.ui.notify(
					`K-π accounts: more than ${MAX_PENDING_RESPONSES} responses in flight; the one on ${slotName(oldest)} and any later evictions this run are no longer attributable`,
					"warning",
				);
			}
		}
	};
	/**
	 * A message that ended well releases exactly one pending successful
	 * response - the oldest, since responses have no other order - and never
	 * the whole set: another request's success must not erase a response that
	 * is still streaming and could yet end in an error.
	 */
	const releaseSucceededResponse = (): void => {
		for (const [requestId, response] of pendingResponses) {
			if (response.status < 400) {
				pendingResponses.delete(requestId);
				return;
			}
		}
	};
	/**
	 * The one pending response an assistant error can belong to. A failed
	 * transport status is the strongest evidence; with none, a lone pending
	 * response is the only candidate. Two candidates are no candidate: an
	 * ambiguous pair of failures is dropped so neither slot is charged for the
	 * other's error, and the caller is handed their names to say so. Ambiguous
	 * successes are kept: one of them may still end in an error of its own.
	 */
	const takeErroredResponse = (): { response: PendingResponse } | { ambiguous: string[] } => {
		const failed = [...pendingResponses].filter(([, response]) => response.status >= 400);
		const candidates = failed.length > 0 ? failed : [...pendingResponses];
		if (candidates.length === 1) {
			pendingResponses.delete(candidates[0][0]);
			return { response: candidates[0][1] };
		}
		for (const [requestId] of failed) {
			pendingResponses.delete(requestId);
		}
		return { ambiguous: candidates.map(([, response]) => slotName(response)) };
	};

	if (typeof pi.on === "function") {
		pi.on("before_provider_headers", async (event, context) => {
			const modelProvider = context.model?.provider;
			// `llama` is served by Pi's built-in `llama.cpp`, so the pool a request
			// belongs to is not always the provider id it carries.
			const provider = modelProvider === undefined ? undefined : poolIdForProvider(modelProvider);
			if (provider === undefined) return;
			const accounts = await resolved.store.read();
			// Hot path: the cache is read synchronously and never refreshed here,
			// so no provider call stands between a turn and its headers.
			//
			// Family-scoped on purpose. A request built for one provider may only
			// carry a slot from that provider, so a fallback family's credential can
			// never be attached to it. Crossing families is the failover path's job,
			// and only after the model has actually been re-pointed.
			active = balancer.selectInFamily(provider, accounts, usage);
			// A local pool may hold several servers. The model carries the origin it
			// was discovered on, so the slot that serves this request is the one
			// pinned to that origin, not whichever the rotation happened to pick.
			if (isLocalPool(provider)) {
				const origin = context.model?.baseUrl;
				const pinned = (accounts.pools[provider]?.slots ?? []).find(
					(slot) => slot.kind === "local" && slot.baseUrl === origin,
				);
				if (pinned !== undefined) {
					active = { poolId: provider, slot: pinned };
				} else if (origin !== undefined) {
					// The request names an origin no configured slot owns. Attaching a
					// credential, or claiming a route, would be a silent redirect.
					active = undefined;
				}
			}
			activeModel = context.model?.id;
			// The route is only real once a slot is chosen, so publish here.
			await publishWidget(context, accounts);
			if (active === undefined || active.poolId !== provider) {
				// Once a provider has a pool, pool health is authoritative. Leaving the
				// runtime's primary auth header intact here would silently reuse a cooled
				// subscription from auth.json after every slot was exhausted.
				if (accounts.pools[provider] !== undefined) {
					for (const name of ["authorization", "x-api-key", "x-goog-api-key", "api-key"]) {
						if (event.headers[name] !== undefined) event.headers[name] = null;
					}
				}
				return;
			}
			// A local slot carries no credential unless the operator referenced one:
			// a placeholder token would be a secret K-π invented, so the header is
			// nulled rather than left for the client's construction key to fill.
			const secretName = active.slot.kind === "local" ? active.slot.secretRef : `${active.poolId}/${active.slot.id}`;
			const credential = secretName === undefined ? undefined : (await resolved.store.readSecrets())[secretName];
			const token =
				credential?.type === "oauth"
					? credential.access
					: credential?.type === "api_key"
						? credential.key
						: undefined;
			if (token !== undefined) {
				// Provider-native semantics: Anthropic reads `x-api-key`, Google
				// `x-goog-api-key`, Azure `api-key`. Forcing every key into a bearer
				// header would send a valid credential where the provider never looks.
				setAuthHeader(event.headers, context.model?.api, credential?.type, token);
				// This request now carries this slot's credential, so its response is
				// attributable to it by id.
				recordRequestSlot(event.requestId, active);
			} else if (active.slot.kind === "local") {
				// A local server the operator gave no credential is sent none. The
				// provider's `apiKey` exists only so the client can be constructed;
				// nulling the header keeps it off the wire instead of inventing a
				// bearer this server never asked for.
				event.headers.authorization = null;
				recordRequestSlot(event.requestId, active);
			}
		});
		pi.on("after_provider_response", async (event, context) => {
			// Exactly the request this response answers. A response for a request
			// this extension did not credential records nothing, rather than charging
			// a slot that never served it.
			const served = requestSlots.get(event.requestId);
			if (served === undefined) return;
			// Off the hot path: record what the response's own headers stated. Every
			// response carries limits, not just the failures, so publish either way.
			const snapshot = usage.recordHeaders(served.poolId, served.slot.id, event.headers ?? {});
			// The same clock the balancer checks health against: a cooldown parsed
			// on a different time base would expire at the wrong moment.
			const classification = classifyProviderFailure(
				{
					status: event.status,
					headers: event.headers,
				},
				nowMs(),
			);
			const lowQuota =
				event.status >= 200 &&
				event.status < 400 &&
				snapshot?.remainingPercent !== undefined &&
				snapshot.remainingPercent <= LOW_QUOTA_REMAINING_PERCENT;
			const pending: PendingResponse = {
				served,
				status: event.status,
				classificationHandled: classification !== undefined || lowQuota,
				retryOnMovedRoute: false,
			};
			rememberResponse(event.requestId, pending, context);
			if (classification !== undefined) {
				pending.retryOnMovedRoute = await applyFailure(served, classification.until, context);
				return;
			}
			if (lowQuota && snapshot !== undefined) {
				await applyFailure(served, snapshot.resetAt ?? nowMs() + DEFAULT_COOLDOWN_MS, context);
				return;
			}
			await publishWidget(context);
		});
		pi.on("message_end", async (event, context) => {
			if (event.message.role !== "assistant") return;
			const message = event.message as AssistantMessage;
			if (message.stopReason !== "error" || message.errorMessage === undefined) {
				releaseSucceededResponse();
				return;
			}
			const taken = takeErroredResponse();
			if ("ambiguous" in taken) {
				if (taken.ambiguous.length === 0) return;
				// Two failed responses and one error: attributing it would be a
				// guess. Nothing cools, and both the operator and the transcript
				// are told which slots went unjudged rather than nothing at all.
				context.ui.notify(
					`K-π accounts: an assistant error could not be attributed between ${taken.ambiguous.join(" and ")}; neither slot was cooled`,
					"warning",
				);
				return {
					message: {
						...message,
						diagnostics: [
							...(message.diagnostics ?? []),
							{
								type: "kpi_account_unattributed",
								timestamp: nowMs(),
								details: { candidates: taken.ambiguous.join(",") },
							},
						],
					},
				};
			}
			const { response } = taken;
			let moved = response.retryOnMovedRoute;
			if (!response.classificationHandled) {
				// The provider stream has already been consumed into this assistant error,
				// so quota-shaped 400 bodies can be classified without stealing bytes.
				const classification = classifyProviderBodyFailure(
					{ status: response.status, body: message.errorMessage },
					nowMs(),
				);
				if (classification === undefined) return;
				moved = await applyFailure(response.served, classification.until, context);
			}
			if (!moved) return;
			return {
				message: {
					...message,
					diagnostics: [
						...(message.diagnostics ?? []),
						{
							type: "kpi_account_failover",
							timestamp: nowMs(),
							details: { from: `${response.served.poolId}/${response.served.slot.id}` },
						},
					],
				},
			};
		});
		pi.on("agent_end", async () => {
			// Every request of this run has ended or been abandoned; nothing left
			// here can still be paired, and the next run starts with a clean slate.
			pendingResponses.clear();
			evictionReported = false;
		});
		pi.on("turn_start", async (_event, context) => {
			await refreshExpiringCredentials(context);
		});
		pi.on("session_start", async (_event, context) => {
			// The official primary credential becomes slot `default` before any
			// turn needs a slot. The secret moves between private agent files.
			const imported = await resolved.store.importOfficialCredentials();
			if (imported.length > 0) {
				context.ui.notify(`Imported official credentials as ${imported.join(", ")}`, "info");
			}
			// OAuth refresh and usage readers stay off the request-header hot path.
			// Each subscription refreshes independently, so a stale slot never wins
			// merely because another login updated the provider's primary auth.json.
			await refreshExpiringCredentials(context);
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
						activePool: () => active?.poolId,
						advance: async (poolId) => {
							balancer.advance(poolId);
							await reroute(poolId);
						},
						pin: async (poolId, slotId) => {
							balancer.pinSlot(poolId, slotId);
							await reroute(poolId);
						},
					},
				);
				if (changed) {
					// A steer moves the route now, so the widget must not keep showing
					// the slot the session has just been moved off.
					await publishWidget(context);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				context.ui.notify(`K-π accounts: ${message}`, "error");
			}
		},
	});
}
