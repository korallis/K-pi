import type { AuthEvent, AuthPrompt, Credential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../core/extensions/types.ts";
import { appendEvent } from "../append-log.ts";
import { readActiveJob } from "../control-plane.ts";
import { AccountBalancer, type SelectedSlot } from "./balancer.ts";
import { classifyProviderFailure } from "./errors.ts";

import { type AccountsDocument, AccountsStore, isPoolId, type PoolId } from "./store.ts";
import { renderAccountsWidget } from "./widget.ts";

export const ANTHROPIC_EXTRA_USAGE_WARNING = `Claude Pro/Max in this harness uses Anthropic’s subscription OAuth, same as Pi and Atomic.

Anthropic’s own docs: third-party harness usage draws from extra usage and is billed per token, not against the in-app Claude plan bar.

API keys (ANTHROPIC_API_KEY) are a separate pay-as-you-go path.

You are responsible for the seats you attach.

Continue?`;

export interface AccountsDependencies {
	store?: AccountsStore;
	now?: () => Date;
	login?: (providerId: PoolId, slotId: string, context: ExtensionCommandContext) => Promise<Credential>;
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
	if (providerName === "anthropic" && warningAcceptedAt === undefined) {
		const accepted = await context.ui.confirm("Anthropic extra-usage warning", ANTHROPIC_EXTRA_USAGE_WARNING);
		if (!accepted) {
			context.ui.notify("Anthropic login cancelled", "info");
			return;
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
): Promise<void> {
	const slot = resolveSlotReference(reference, await store.read());
	if (!(await store.removeSlot(slot.poolId, slot.slotId))) {
		throw new Error(`Unknown account slot: ${slot.poolId}/${slot.slotId}`);
	}
	context.ui.notify(`Removed account ${slot.poolId}/${slot.slotId}`, "info");
}

async function handleAccountsCommand(
	args: string,
	context: ExtensionCommandContext,
	dependencies: Required<AccountsDependencies>,
): Promise<void> {
	const words = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
	const [action, first, second, ...extra] = words;
	if (action === undefined || action === "list") {
		await showAccounts(dependencies.store, context);
		return;
	}
	if (extra.length > 0) {
		throw new Error("Too many /accounts arguments");
	}
	if (action === "login") {
		await loginAccount(first, second, dependencies.store, dependencies.login, dependencies.now, context);
		return;
	}
	if (action === "logout") {
		if (second !== undefined) {
			throw new Error("Usage: /accounts logout <pool/slot>");
		}
		await logoutAccount(first, dependencies.store, context);
		return;
	}
	throw new Error(`Unknown /accounts command: ${action}`);
}

export function registerAccounts(pi: ExtensionAPI, dependencies: AccountsDependencies = {}): void {
	const resolved: Required<AccountsDependencies> = {
		store: dependencies.store ?? new AccountsStore(),
		now: dependencies.now ?? (() => new Date()),
		login:
			dependencies.login ??
			((providerId, slotId, context) =>
				loginWithOfficialProvider(providerId, slotId, context, (url) => openAuthUrl(pi, url))),
	};
	const balancer = new AccountBalancer(() => resolved.now().getTime());
	let active: SelectedSlot | undefined;
	if (typeof pi.on === "function") {
		pi.on("before_provider_headers", async (event, context) => {
			const provider = context.model?.provider;
			if (provider === undefined || !isPoolId(provider)) return;
			const accounts = await resolved.store.read();
			active = balancer.select(provider, accounts);
			if (active === undefined) return;
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
			const classification = classifyProviderFailure({
				status: event.status,
				headers: event.headers,
			});
			if (classification === undefined) return;
			balancer.markCooling(active.poolId, active.slot.id, classification.until);
			const source = context.model;
			if (source === undefined) return;
			const accounts = await resolved.store.read();
			const next = balancer.select(active.poolId, accounts);
			if (next !== undefined && next.slot.id !== active.slot.id) {
				const job = await readActiveJob(context.cwd);
				if (job !== undefined) {
					await appendEvent(job.eventsPath, {
						ts: resolved.now().toISOString(),
						type: "accounts.failover",
						job_id: job.jobId,
						round: typeof job.state.round === "number" ? job.state.round : 0,
						node: typeof job.state.node === "string" ? job.state.node : "accounts",
						from: `${active.poolId}/${active.slot.id}`,
						to: `${next.poolId}/${next.slot.id}`,
					});
				}
			}
			if (next !== undefined && next.poolId !== source.provider) {
				const model = balancer.findFallbackModel(source, next.poolId, context.modelRegistry.getAvailable());
				if (model !== undefined) await pi.setModel(model);
			}
		});
		pi.on("session_start", async (_event, context) => {
			const widget = renderAccountsWidget(await resolved.store.read());
			context.ui.setStatus("accounts", widget === "ACCOUNTS" ? undefined : widget);
		});
	}
	pi.registerCommand("accounts", {
		description: "Manage K-π subscription accounts",
		handler: async (args, context) => {
			try {
				await handleAccountsCommand(args, context, resolved);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				context.ui.notify(`K-π accounts: ${message}`, "error");
			}
		},
	});
}
