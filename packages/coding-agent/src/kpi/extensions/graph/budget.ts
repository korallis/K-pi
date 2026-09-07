import { type GraphBudgetState, isJsonObject } from "./schema.ts";

/**
 * Recognizes budget counters restored from a checkpoint. Only `maxConcurrency`
 * is required of the limits: a checkpoint written under the retired caps
 * (maxSteps, maxNodeRuns, maxCostUsd, timeoutMs, maxRounds, maxTransientRetries)
 * still passes, and the engine reports those keys as ignored.
 */
export function isBudgetState(value: unknown): value is GraphBudgetState {
	if (!isJsonObject(value) || !isJsonObject(value.limits)) {
		return false;
	}
	const counters = ["startedAtMs", "elapsedMs", "costUsd", "round", "batches"] as const;
	if (counters.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
		return false;
	}
	const concurrency = value.limits.maxConcurrency;
	return typeof concurrency === "number" && Number.isFinite(concurrency);
}

/**
 * Ready nodes split into superstep-internal batches of at most
 * `maxConcurrency`. A wide ready set is bounded here, never rejected.
 */
export function batchReadyNodes<T>(
	nodes: readonly T[],
	maxConcurrency: number,
	conflicts?: (left: T, right: T) => boolean,
): T[][] {
	const size = Math.max(1, Math.floor(maxConcurrency));
	const batches: T[][] = [];
	let current: T[] = [];
	for (const node of nodes) {
		if (current.length >= size || current.some((other) => conflicts?.(other, node))) {
			batches.push(current);
			current = [];
		}
		current.push(node);
	}
	if (current.length) batches.push(current);
	return batches;
}
