import type { ExtensionAPI } from "../../core/extensions/types.ts";

import { EVENT_TYPES, type EventRecord, type EventType } from "./append-log.ts";

export function formatEventEntry(type: EventType, event: EventRecord | undefined): string {
	const job = event?.job_id === undefined ? "" : ` job=${event.job_id}`;
	const round = event?.round === undefined ? "" : ` round=${event.round}`;
	const status = typeof event?.status === "string" ? ` status=${event.status}` : "";
	return `K-π ${type}${job}${round}${status}`;
}

export function registerEventRenderers(pi: ExtensionAPI): void {
	for (const type of EVENT_TYPES) {
		pi.registerEntryRenderer<EventRecord>(type, (entry) => {
			const line = formatEventEntry(type, entry.data);
			return {
				invalidate() {},
				render() {
					return [line];
				},
			};
		});
	}
}
