import type { PoolId } from "../store.ts";

/**
 * Where a cached percentage came from. Both are documented signals: response
 * rate-limit headers the provider publishes, or a reader the operator injected
 * for a provider that documents a usage endpoint. Nothing else populates the
 * cache — K-π never polls an undocumented subscription endpoint.
 */
export type UsageSource = "headers" | "reader";

/**
 * One slot's cached usage. The single contract shared by the readers, the
 * cache, the balancer, and the widget.
 *
 * An absent `remainingPercent` means unknown, never zero: a provider with no
 * reliable signal stays unknown and quota-first must fail open rather than
 * treat it as empty.
 */
export interface UsageSnapshot {
	poolId: PoolId;
	slotId: string;
	/** Integer 0–100 of the binding limit, or absent when unknown. */
	remainingPercent?: number;
	/** Epoch milliseconds the limit resets, when the provider states it. */
	resetAt?: number;
	/** Provider's own window label, such as `5h`, when it states one. */
	window?: string;
	source: UsageSource;
	observedAtMs: number;
}

/** The read side every consumer shares. Synchronous: no consumer may await it. */
export interface UsageView {
	get(poolId: PoolId, slotId: string): UsageSnapshot | undefined;
	/** Cached percentage, or undefined when unknown. */
	remainingPercent(poolId: PoolId, slotId: string): number | undefined;
	entries(): readonly UsageSnapshot[];
}

/**
 * An injected reader for a provider that documents a usage endpoint. Runs only
 * on the refresh path, never while a request is being built. Returning
 * `undefined` leaves the slot unknown.
 */
export type UsageReader = (request: UsageReaderRequest) => Promise<UsageReading | undefined> | UsageReading | undefined;

export interface UsageReaderRequest {
	poolId: PoolId;
	slotId: string;
	signal?: AbortSignal;
}

/** What a reader or a header parse contributes, before the cache stamps it. */
export interface UsageReading {
	remainingPercent?: number;
	resetAt?: number;
	window?: string;
}
