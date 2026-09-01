import type { AccountsDocument, PoolId } from "./store.ts";

export interface SlotUsage {
	remainingPercent?: number;
	cooldownUntil?: number;
	window?: string;
}

export type UsageBySlot = Readonly<Record<string, SlotUsage | undefined>>;

export function renderAccountsWidget(
	document: AccountsDocument,
	usage: UsageBySlot = {},
	route?: { provider: PoolId; model: string; slot: string },
	now = Date.now(),
): string {
	const lines = ["ACCOUNTS"];
	for (const [poolId, pool] of Object.entries(document.pools)) {
		if (pool === undefined || pool.slots.length === 0) continue;
		const slots = pool.slots.map((slot) => {
			const current = usage[`${poolId}/${slot.id}`];
			const percent = current?.remainingPercent === undefined ? "?%" : `${current.remainingPercent}%`;
			const cooldown =
				current?.cooldownUntil !== undefined && current.cooldownUntil > now
					? ` cd ${Math.ceil((current.cooldownUntil - now) / 60_000)}m`
					: "";
			return `${slot.label ?? slot.id} ${percent}${current?.window === undefined ? "" : ` ${current.window}`}${cooldown}`;
		});
		lines.push(`  ${poolId.toUpperCase()}  ${slots.join("   ")}`);
	}
	if (route !== undefined) lines.push(`ROUTE   ${route.provider}/${route.model}  via ${route.slot}`);
	return lines.join("\n");
}
