import type { SlotKind } from "./segments.ts";

/**
 * Live route the footer and board read without starting a model.
 * Accounts publishes on header selection; UI only consumes.
 */
export interface FooterRouteSnapshot {
	slotKind: SlotKind;
	/** provider/model via slot label when known */
	route?: string;
	/** Remaining percent for the active non-local slot; omit when unknown or local. */
	remainingPercent?: number;
}

const DEFAULT_SNAPSHOT: FooterRouteSnapshot = { slotKind: "api_key" };

let snapshot: FooterRouteSnapshot = { ...DEFAULT_SNAPSHOT };

export function setFooterRouteSnapshot(next: FooterRouteSnapshot): void {
	snapshot = {
		slotKind: next.slotKind,
		...(next.route === undefined ? {} : { route: next.route }),
		...(next.remainingPercent === undefined ? {} : { remainingPercent: next.remainingPercent }),
	};
}

export function getFooterRouteSnapshot(): FooterRouteSnapshot {
	return { ...snapshot };
}

/** Test/reset helper. */
export function resetFooterRouteSnapshot(): void {
	snapshot = { ...DEFAULT_SNAPSHOT };
}
