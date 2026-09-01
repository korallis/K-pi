import type { Model } from "@earendil-works/pi-ai";

import type { AccountSlot, AccountsDocument, PoolId } from "./store.ts";

export const DEFAULT_FALLBACK_CHAIN: readonly PoolId[] = [
	"anthropic",
	"openai-codex",
	"xai",
	"zai",
	"kimi-coding",
	"cursor",
];

export interface SelectedSlot {
	poolId: PoolId;
	slot: AccountSlot;
}

export type UsageReader = (poolId: PoolId, slotId: string) => number | undefined;

export class AccountBalancer {
	private readonly cooling = new Map<string, number>();
	private readonly sticky = new Map<string, string>();
	private readonly cursors = new Map<PoolId, number>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	markCooling(poolId: PoolId, slotId: string, until: number): void {
		this.cooling.set(`${poolId}/${slotId}`, until);
		if (this.sticky.get(poolId) === slotId) this.sticky.delete(poolId);
	}

	isHealthy(poolId: PoolId, slotId: string): boolean {
		return (this.cooling.get(`${poolId}/${slotId}`) ?? 0) <= this.now();
	}

	select(requestedPool: PoolId, accounts: AccountsDocument, usage?: UsageReader): SelectedSlot | undefined {
		for (const poolId of this.poolOrder(requestedPool, accounts.fallback)) {
			const pool = accounts.pools[poolId];
			if (pool === undefined) continue;
			const healthy = pool.slots.filter((slot) => this.isHealthy(poolId, slot.id));
			if (healthy.length === 0) continue;

			const pinned = this.sticky.get(poolId);
			const sticky = healthy.find((slot) => slot.id === pinned);
			if (sticky !== undefined) return { poolId, slot: sticky };

			let selected: AccountSlot;
			if (pool.strategy === "quota-first" && usage !== undefined) {
				selected = healthy.reduce((best, candidate) =>
					(usage(poolId, candidate.id) ?? -1) > (usage(poolId, best.id) ?? -1) ? candidate : best,
				);
			} else {
				const cursor = this.cursors.get(poolId) ?? 0;
				selected = healthy[cursor % healthy.length];
				this.cursors.set(poolId, cursor + 1);
			}
			this.sticky.set(poolId, selected.id);
			return { poolId, slot: selected };
		}
		return undefined;
	}

	release(poolId: PoolId): void {
		this.sticky.delete(poolId);
	}

	findFallbackModel(source: Model<any>, poolId: PoolId, available: readonly Model<any>[]): Model<any> | undefined {
		const candidates = available.filter((model) => model.provider === poolId);
		if (candidates.length === 0) return undefined;
		const tier = /opus|pro|max/iu.test(source.id)
			? /opus|pro|max/iu
			: /sonnet|medium|flash/iu.test(source.id)
				? /sonnet|medium|flash/iu
				: undefined;
		return (tier === undefined ? undefined : candidates.find((model) => tier.test(model.id))) ?? candidates[0];
	}

	private poolOrder(requested: PoolId, configured: readonly PoolId[]): PoolId[] {
		return [requested, ...configured.filter((poolId) => poolId !== requested)];
	}
}
