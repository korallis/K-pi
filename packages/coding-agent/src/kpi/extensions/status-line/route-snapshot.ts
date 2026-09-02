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
let changeListener: (() => void) | undefined;

export function setFooterRouteChangeListener(listener: (() => void) | undefined): void {
	changeListener = listener;
}

export function setFooterRouteSnapshot(next: FooterRouteSnapshot): void {
	const previous = snapshot;
	snapshot = {
		slotKind: next.slotKind,
		...(next.route === undefined ? {} : { route: next.route }),
		...(next.remainingPercent === undefined ? {} : { remainingPercent: next.remainingPercent }),
	};
	if (
		previous.slotKind !== snapshot.slotKind ||
		previous.route !== snapshot.route ||
		previous.remainingPercent !== snapshot.remainingPercent
	) {
		changeListener?.();
	}
}

export function getFooterRouteSnapshot(): FooterRouteSnapshot {
	return { ...snapshot };
}

/** Test/reset helper. */
export function resetFooterRouteSnapshot(): void {
	snapshot = { ...DEFAULT_SNAPSHOT };
	changeListener = undefined;
}
