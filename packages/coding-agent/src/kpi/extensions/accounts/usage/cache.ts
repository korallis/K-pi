import type { PoolId } from "../store.ts";
import { readUsageHeaders, type ResponseHeaders } from "./headers.ts";
import type { UsageReader, UsageSnapshot, UsageSource, UsageView } from "./types.ts";

export interface UsageCacheOptions {
	now?: () => number;
	/**
	 * Readers for providers that document a usage endpoint, keyed by pool. None
	 * ship by default: a provider without a documented signal stays unknown
	 * rather than being polled speculatively.
	 */
	readers?: Partial<Record<PoolId, UsageReader>>;
}

/**
 * The one cached usage snapshot store. Reads are synchronous so the request
 * path never awaits a provider, and writes only happen on the refresh path:
 * response headers after a call, or an injected reader.
 */
export class UsageCache implements UsageView {
	private readonly snapshots = new Map<string, UsageSnapshot>();
	private readonly now: () => number;
	private readonly readers: Partial<Record<PoolId, UsageReader>>;

	constructor(options: UsageCacheOptions = {}) {
		this.now = options.now ?? Date.now;
		this.readers = options.readers ?? {};
	}

	get(poolId: PoolId, slotId: string): UsageSnapshot | undefined {
		return this.snapshots.get(`${poolId}/${slotId}`);
	}

	remainingPercent(poolId: PoolId, slotId: string): number | undefined {
		return this.snapshots.get(`${poolId}/${slotId}`)?.remainingPercent;
	}

	entries(): readonly UsageSnapshot[] {
		return [...this.snapshots.values()];
	}

	/** True when a documented reader exists for this pool. */
	hasReader(poolId: PoolId): boolean {
		return this.readers[poolId] !== undefined;
	}

	private write(poolId: PoolId, slotId: string, source: UsageSource, reading: {
		remainingPercent?: number;
		resetAt?: number;
		window?: string;
	}): UsageSnapshot {
		const snapshot: UsageSnapshot = {
			poolId,
			slotId,
			remainingPercent: reading.remainingPercent,
			resetAt: reading.resetAt,
			window: reading.window,
			source,
			observedAtMs: this.now(),
		};
		this.snapshots.set(`${poolId}/${slotId}`, snapshot);
		return snapshot;
	}

	/**
	 * Records what a provider's own response headers stated. Called from the
	 * response hook, which is off the request-building path.
	 */
	recordHeaders(poolId: PoolId, slotId: string, headers: ResponseHeaders): UsageSnapshot | undefined {
		const reading = readUsageHeaders(headers, this.now());
		return reading === undefined ? undefined : this.write(poolId, slotId, "headers", reading);
	}

	/**
	 * Refreshes one slot through its injected reader. A pool without a reader,
	 * or a reader that fails or reports nothing, leaves the slot as it was: an
	 * unknown slot stays unknown and a request is never blocked on this.
	 */
	async refresh(poolId: PoolId, slotId: string, signal?: AbortSignal): Promise<UsageSnapshot | undefined> {
		const reader = this.readers[poolId];
		if (reader === undefined) {
			return undefined;
		}
		try {
			const reading = await reader({ poolId, slotId, signal });
			return reading === undefined ? undefined : this.write(poolId, slotId, "reader", reading);
		} catch {
			return undefined;
		}
	}

	/** Refreshes every slot that has a reader, in parallel and never throwing. */
	async refreshAll(
		slots: readonly { poolId: PoolId; slotId: string }[],
		signal?: AbortSignal,
	): Promise<readonly UsageSnapshot[]> {
		const refreshed = await Promise.all(
			slots
				.filter((slot) => this.hasReader(slot.poolId))
				.map((slot) => this.refresh(slot.poolId, slot.slotId, signal)),
		);
		return refreshed.filter((snapshot) => snapshot !== undefined);
	}

	/** Drops a slot's cached usage, for logout. */
	forget(poolId: PoolId, slotId: string): void {
		this.snapshots.delete(`${poolId}/${slotId}`);
	}
}
