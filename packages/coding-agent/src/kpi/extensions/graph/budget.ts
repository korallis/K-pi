import {
	BUDGET_LIMIT_NAMES,
	type BudgetLimitName,
	type GraphBudgetLimits,
	type GraphBudgetOverrides,
	type GraphBudgetState,
	type GraphLimits,
	isJsonObject,
} from "./schema.ts";
import { DEFAULT_MAX_ROUNDS, MAX_TRANSIENT_RETRIES } from "./stop.ts";

/** Caps a task/job contract may override, and whether each counts whole units. */
const OVERRIDABLE_LIMITS: Record<string, { integer: boolean }> = {
	maxSteps: { integer: true },
	maxNodeRuns: { integer: true },
	maxConcurrency: { integer: true },
	maxRounds: { integer: true },
	maxTransientRetries: { integer: true },
	maxCostUsd: { integer: false },
	timeoutMs: { integer: false },
};

/**
 * Caps a checkpoint must already carry. `maxRounds` and `maxTransientRetries`
 * are resolved defaults rather than graph-file fields, so a checkpoint written
 * before they existed is completed rather than rejected.
 */
const PERSISTED_LIMIT_NAMES = ["maxSteps", "maxNodeRuns", "maxConcurrency", "maxCostUsd", "timeoutMs"] as const;

export interface BudgetExhaustion {
	limit: BudgetLimitName;
	reason: string;
}

/** What a superstep knows about the run before it commits to work. */
export interface RunBudgetReading {
	superstep: number;
	elapsedMs: number;
	costUsd: number;
}

/**
 * Validates the cap overrides carried by a task/job contract. The values
 * arrive from `task.json` on disk, so the shape is checked, never assumed.
 */
export function validateBudgetOverrides(
	value: unknown,
	label = "task limits",
): asserts value is GraphBudgetOverrides | undefined {
	if (value === undefined) {
		return;
	}
	if (!isJsonObject(value)) {
		throw new Error(`${label} must be an object`);
	}
	for (const [key, limit] of Object.entries(value)) {
		const cap = OVERRIDABLE_LIMITS[key];
		if (cap === undefined) {
			throw new Error(`${label}.${key} is not a budget cap`);
		}
		if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
			throw new Error(`${label}.${key} must be a positive number`);
		}
		if (cap.integer && !Number.isInteger(limit)) {
			throw new Error(`${label}.${key} must be a positive integer`);
		}
	}
}

/**
 * Effective caps for a run: the graph file supplies the topology-shaped
 * limits, the validated job contract overrides any of them, and `maxRounds`
 * falls back to the spec default because no graph file declares it.
 */
export function resolveGraphBudgetLimits(graphLimits: GraphLimits, overrides?: unknown): GraphBudgetLimits {
	validateBudgetOverrides(overrides);
	return {
		...graphLimits,
		maxRounds: DEFAULT_MAX_ROUNDS,
		maxTransientRetries: MAX_TRANSIENT_RETRIES,
		...overrides,
	};
}

/** Recognizes budget counters restored from a checkpoint. */
export function isBudgetState(value: unknown): value is GraphBudgetState {
	if (!isJsonObject(value) || !isJsonObject(value.limits)) {
		return false;
	}
	const counters = ["startedAtMs", "elapsedMs", "costUsd", "round", "batches"] as const;
	if (counters.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
		return false;
	}
	const limits = value.limits;
	return PERSISTED_LIMIT_NAMES.every((key) => typeof limits[key] === "number" && Number.isFinite(limits[key]));
}

/**
 * Caps that end a whole run. Checked before a superstep starts and again
 * before each bounded batch, so an injected clock or cost source crosses a cap
 * without any node having to sleep.
 */
export function findExhaustedRunLimit(
	limits: GraphBudgetLimits,
	reading: RunBudgetReading,
): BudgetExhaustion | undefined {
	if (reading.superstep >= limits.maxSteps) {
		return {
			limit: "maxSteps",
			reason: `graph exhausted maxSteps ${limits.maxSteps} at superstep ${reading.superstep}`,
		};
	}
	if (reading.elapsedMs >= limits.timeoutMs) {
		return {
			limit: "timeoutMs",
			reason: `graph exhausted timeoutMs ${limits.timeoutMs} after ${reading.elapsedMs}ms`,
		};
	}
	if (reading.costUsd >= limits.maxCostUsd) {
		return {
			limit: "maxCostUsd",
			reason: `graph exhausted maxCostUsd ${limits.maxCostUsd} at ${reading.costUsd}`,
		};
	}
	return undefined;
}

/**
 * Caps a single node crosses. `runs` is the count before this run, so a node
 * whose next run would pass either cap never starts.
 *
 * A round is one re-run of the loop, which in every shipped graph means one
 * more run of the busiest node; `maxRounds` and `maxNodeRuns` therefore read
 * the same counter, and the tighter cap is the one reported.
 */
export function findExhaustedNodeLimit(
	limits: GraphBudgetLimits,
	nodeId: string,
	runs: number,
): BudgetExhaustion | undefined {
	const limit: BudgetLimitName = limits.maxRounds <= limits.maxNodeRuns ? "maxRounds" : "maxNodeRuns";
	const cap = Math.min(limits.maxRounds, limits.maxNodeRuns);
	if (runs >= cap) {
		return {
			limit,
			reason: `node ${nodeId} exhausted ${limit} ${cap} after ${runs} runs`,
		};
	}
	return undefined;
}

/**
 * Ready nodes split into superstep-internal batches of at most
 * `maxConcurrency`. A wide ready set is bounded here, never rejected.
 */
export function batchReadyNodes<T>(nodes: readonly T[], maxConcurrency: number): T[][] {
	const size = Math.max(1, Math.floor(maxConcurrency));
	const batches: T[][] = [];
	for (let index = 0; index < nodes.length; index += size) {
		batches.push(nodes.slice(index, index + size));
	}
	return batches;
}
