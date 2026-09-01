import type { AccountsDocument, PoolId } from "./store.ts";
import type { UsageView } from "./usage/types.ts";

/** The cooldown side of a slot's health, owned by the balancer. */
export interface HealthView {
	cooldownUntil(poolId: PoolId, slotId: string): number | undefined;
}

export interface AccountsRoute {
	provider: PoolId;
	model: string;
	slot: string;
}

export interface AccountsWidgetOptions {
	/** Real cached percentages. Absent means every slot renders unknown. */
	usage?: UsageView;
	health?: HealthView;
	/** The slot actually carrying the current turn. */
	route?: AccountsRoute;
	now?: number;
}

/**
 * Renders the live account picture: the cached remaining percentage per slot,
 * its window and cooldown when the provider stated one, and the active route.
 * An unknown percentage prints `?%` rather than a fabricated number.
 */
export function renderAccountsWidget(document: AccountsDocument, options: AccountsWidgetOptions = {}): string {
	const now = options.now ?? Date.now();
	const lines = ["ACCOUNTS"];
	for (const [poolId, pool] of Object.entries(document.pools)) {
		if (pool === undefined || pool.slots.length === 0) {
			continue;
		}
		const slots = pool.slots.map((slot) => {
			const snapshot = options.usage?.get(poolId as PoolId, slot.id);
			// AC-27.6: a local slot has no quota, so it shows no percentage at all
			// rather than an unknown one.
			const percent =
				slot.kind === "local"
					? "(local)"
					: snapshot?.remainingPercent === undefined
						? "?%"
						: `${snapshot.remainingPercent}%`;
			const window = snapshot?.window === undefined ? "" : ` ${snapshot.window}`;
			const cooldownUntil = options.health?.cooldownUntil(poolId as PoolId, slot.id);
			const cooldown =
				cooldownUntil === undefined || cooldownUntil <= now
					? ""
					: ` cd ${Math.ceil((cooldownUntil - now) / 60_000)}m`;
			return `${slot.label ?? slot.id} ${percent}${window}${cooldown}`;
		});
		lines.push(`  ${poolId.toUpperCase()}  ${slots.join("   ")}`);
	}
	if (options.route !== undefined) {
		lines.push(`ROUTE   ${options.route.provider}/${options.route.model}  via ${options.route.slot}`);
	}
	return lines.join("\n");
}
