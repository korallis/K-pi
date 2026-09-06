import type { Model } from "@earendil-works/pi-ai";

import {
	type AccountSlot,
	type AccountsDocument,
	isLocalPool,
	type PoolId,
	poolIdForProvider,
	providerIdForPool,
} from "./store.ts";
import type { UsageView } from "./usage/types.ts";

/** A plan at 95% used yields before another healthy sibling is exhausted. */
export const LOW_QUOTA_REMAINING_PERCENT = 5;

export interface SelectedSlot {
	poolId: PoolId;
	slot: AccountSlot;
}

/** Why a slot was chosen. Observable so routing can be proven, not inferred. */
export type SelectionReason = "sticky" | "quota-first" | "round-robin";

export interface Selection extends SelectedSlot {
	reason: SelectionReason;
	/** The cached percentage that won a quota-first choice, when known. */
	remainingPercent?: number;
}

/**
 * A failover from a cooling slot to its replacement.
 *
 * `sameFamily` is the contract the request depends on: a sibling in the same
 * pool speaks the same catalog, so the request keeps its exact model and
 * thinking level and no model change is proposed at all. Only a cross-family
 * move carries a `model`, because only then must the request be re-pointed.
 */
export interface FailoverPlan {
	from: SelectedSlot;
	to: Selection;
	sameFamily: boolean;
	model?: Model<any>;
}

export class AccountBalancer {
	private readonly cooling = new Map<string, number>();
	private readonly sticky = new Map<PoolId, string>();
	private readonly cursors = new Map<PoolId, number>();
	/** One-shot: the slot an operator advanced past, skipped at the next choice. */
	private readonly advanced = new Map<PoolId, string>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	markCooling(poolId: PoolId, slotId: string, until: number): void {
		this.cooling.set(`${poolId}/${slotId}`, until);
		if (this.sticky.get(poolId) === slotId) {
			this.sticky.delete(poolId);
		}
	}

	isHealthy(poolId: PoolId, slotId: string): boolean {
		return (this.cooling.get(`${poolId}/${slotId}`) ?? 0) <= this.now();
	}

	/** When this slot stops cooling, or undefined when it is healthy. */
	cooldownUntil(poolId: PoolId, slotId: string): number | undefined {
		const until = this.cooling.get(`${poolId}/${slotId}`);
		return until !== undefined && until > this.now() ? until : undefined;
	}

	/** The slot currently pinned for the session, if any. */
	pinned(poolId: PoolId): string | undefined {
		return this.sticky.get(poolId);
	}

	/**
	 * Session stickiness: a pinned slot is held until it cools, its account is
	 * removed, or the operator advances past it. Nothing else unpins it, which is
	 * what `stickiness: session-until-exhausted` promises.
	 */
	private pin(poolId: PoolId, slotId: string): void {
		this.sticky.set(poolId, slotId);
	}

	/** Operator pin: hold this slot for the session, clearing any pending skip. */
	pinSlot(poolId: PoolId, slotId: string): void {
		this.advanced.delete(poolId);
		this.pin(poolId, slotId);
	}

	/**
	 * Operator advance: drop the pin and skip the slot it was on at the next
	 * choice, so advancing moves the route whatever the pool's strategy is. A
	 * pool with nothing else healthy is never stranded by it.
	 */
	advance(poolId: PoolId): void {
		const pinned = this.sticky.get(poolId);
		this.sticky.delete(poolId);
		if (pinned !== undefined) {
			this.advanced.set(poolId, pinned);
		}
	}

	/** Logout: the slot is gone, so it can neither be pinned nor cooling. */
	releaseSlot(poolId: PoolId, slotId: string): void {
		this.cooling.delete(`${poolId}/${slotId}`);
		if (this.sticky.get(poolId) === slotId) {
			this.sticky.delete(poolId);
		}
	}

	release(poolId: PoolId): void {
		this.sticky.delete(poolId);
	}

	/**
	 * Chooses a slot inside one pool and never leaves it. The credential path
	 * uses this: a request built for one provider may only ever carry a slot from
	 * that provider's own family, whatever the fallback chain says.
	 */
	selectInFamily(poolId: PoolId, accounts: AccountsDocument, usage?: UsageView): Selection | undefined {
		const pool = accounts.pools[poolId];
		if (pool === undefined) {
			return undefined;
		}
		// A slot that needs a login has no grant to send: it is never selected,
		// whatever its cooldown says, until `/accounts login` rewrites it.
		const healthy = pool.slots.filter(
			(slot) =>
				slot.needsLogin === undefined && (slot.cooldownUntil ?? 0) <= this.now() && this.isHealthy(poolId, slot.id),
		);
		if (healthy.length === 0) {
			return undefined;
		}

		const pinned = this.sticky.get(poolId);
		const sticky = healthy.find((slot) => slot.id === pinned);
		if (sticky !== undefined) {
			// AC-10.8: a pin yields at 5% remaining whatever the pool's strategy, so
			// a round-robin or sticky pool does not ride its slot into a refusal.
			const remainingPercent = usage?.remainingPercent(poolId, sticky.id);
			if (remainingPercent !== undefined) {
				const alternatives = healthy.filter((slot) => slot.id !== sticky.id);
				const quotaReplacement = this.chooseByQuota(poolId, alternatives, usage);
				const replacement =
					quotaReplacement ??
					(alternatives.length === 0
						? undefined
						: { poolId, slot: this.rotate(poolId, alternatives), reason: "round-robin" as const });
				if (
					remainingPercent <= LOW_QUOTA_REMAINING_PERCENT &&
					replacement !== undefined &&
					(replacement.remainingPercent === undefined || replacement.remainingPercent > remainingPercent)
				) {
					this.pin(poolId, replacement.slot.id);
					return replacement;
				}
			}
			return {
				poolId,
				slot: sticky,
				reason: "sticky",
				remainingPercent,
			};
		}

		const skipped = this.advanced.get(poolId);
		const preferred = skipped === undefined ? healthy : healthy.filter((slot) => slot.id !== skipped);
		const candidates = preferred.length > 0 ? preferred : healthy;
		this.advanced.delete(poolId);

		const chosen = pool.strategy === "quota-first" ? this.chooseByQuota(poolId, candidates, usage) : undefined;
		const selection = chosen ?? {
			poolId,
			slot: pool.strategy === "sticky" ? candidates[0] : this.rotate(poolId, candidates),
			reason: "round-robin" as const,
			remainingPercent: undefined,
		};
		this.pin(poolId, selection.slot.id);
		return selection;
	}

	/**
	 * The requested family first, then the configured chain. A family is only
	 * left once every sibling in it is cooling. Crossing families changes which
	 * catalog answers, so only the failover path may act on that.
	 */
	select(requestedPool: PoolId, accounts: AccountsDocument, usage?: UsageView): Selection | undefined {
		for (const poolId of this.poolOrder(requestedPool, accounts)) {
			const selection = this.selectInFamily(poolId, accounts, usage);
			if (selection !== undefined) {
				return selection;
			}
		}
		return undefined;
	}

	/**
	 * The highest cached percentage among healthy siblings. Only slots with a
	 * known percentage compete; when every healthy sibling is unknown this
	 * returns undefined so selection fails open to the rotation instead of
	 * blocking or guessing.
	 */
	private chooseByQuota(
		poolId: PoolId,
		healthy: readonly AccountSlot[],
		usage: UsageView | undefined,
	): Selection | undefined {
		if (usage === undefined) {
			return undefined;
		}
		let best: Selection | undefined;
		for (const slot of healthy) {
			const remainingPercent = usage.remainingPercent(poolId, slot.id);
			if (remainingPercent === undefined) {
				continue;
			}
			if (best === undefined || remainingPercent > (best.remainingPercent ?? -1)) {
				best = { poolId, slot, reason: "quota-first", remainingPercent };
			}
		}
		return best;
	}

	private rotate(poolId: PoolId, healthy: readonly AccountSlot[]): AccountSlot {
		const cursor = this.cursors.get(poolId) ?? 0;
		this.cursors.set(poolId, cursor + 1);
		return healthy[cursor % healthy.length];
	}

	/**
	 * Where a cooling slot's traffic goes next. Same-family siblings come first
	 * because they preserve the request exactly; the configured chain is only
	 * consulted once the whole family is cooling.
	 */
	planFailover(
		from: SelectedSlot,
		accounts: AccountsDocument,
		available: readonly Model<any>[],
		source?: Model<any>,
		usage?: UsageView,
		preferredModelSlugs?: readonly string[],
	): FailoverPlan | undefined {
		const sibling = this.selectInFamily(from.poolId, accounts, usage);
		if (
			sibling !== undefined &&
			sibling.slot.id !== from.slot.id &&
			(!isLocalPool(from.poolId) || sibling.slot.baseUrl === source?.baseUrl)
		) {
			return { from, to: sibling, sameFamily: true };
		}

		if (preferredModelSlugs !== undefined) {
			for (const slug of preferredModelSlugs) {
				const slash = slug.indexOf("/");
				const provider = slug.slice(0, slash);
				const poolName = slash < 1 ? undefined : poolIdForProvider(provider);
				if (
					poolName === undefined ||
					poolName === from.poolId ||
					!this.poolOrder(from.poolId, accounts).includes(poolName)
				)
					continue;
				const model = available.find(
					(candidate) => candidate.provider === provider && candidate.id === slug.slice(slash + 1),
				);
				if (model === undefined) continue;
				const to = this.selectInFamily(poolName, accounts, usage);
				if (to !== undefined) return { from, to, sameFamily: false, model };
			}
			return undefined;
		}

		for (const poolId of this.poolOrder(from.poolId, accounts)) {
			if (poolId === from.poolId) continue;
			const model = available.find((candidate) => candidate.provider === providerIdForPool(poolId));
			if (!model) continue;
			const to = this.selectInFamily(poolId, accounts, usage);
			if (to) return { from, to, sameFamily: false, model };
		}
		return undefined;
	}

	/**
	 * The requested pool first, then the chain.
	 *
	 * A local pool is different: AC-27.5 keeps local slots out of the default
	 * cloud chain, and the converse matters just as much — a run on a local
	 * server must not escape to a paid cloud seat on its own. So a local request
	 * falls back only to other local pools, unless the operator's own chain names
	 * that local pool, in which case whatever they put after it applies.
	 */
	private poolOrder(requested: PoolId, accounts: AccountsDocument): PoolId[] {
		const configured = accounts.fallback;
		if (!isLocalPool(requested)) {
			return [requested, ...configured.filter((poolId) => poolId !== requested)];
		}
		const placed = configured.indexOf(requested);
		if (placed >= 0) {
			// The operator put this local pool in the chain themselves, so whatever
			// they ordered after it — cloud included — is their decision.
			return [requested, ...configured.slice(placed + 1)];
		}
		// Otherwise stay local: the other configured local families, chain order
		// first so an operator's partial ordering still counts.
		const locals = Object.keys(accounts.pools).filter(
			(poolId): poolId is PoolId => isLocalPool(poolId) && poolId !== requested,
		);
		return [
			requested,
			...configured.filter((poolId) => locals.includes(poolId)),
			...locals.filter((poolId) => !configured.includes(poolId)),
		];
	}
}
