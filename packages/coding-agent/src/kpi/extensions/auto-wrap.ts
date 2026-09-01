import type { ExtensionAPI } from "../../core/extensions/types.ts";

import { kModeState } from "../kstack/mode.ts";
import { isLiveJob, readActiveJob } from "./run-store.ts";
import { autoWrapState } from "./settings.ts";

export function registerAutoWrap(pi: ExtensionAPI): void {
	pi.on("input", async (event, context) => {
		const text = event.text.trim();
		if (!autoWrapState.enabled || text.length === 0 || text.startsWith("/")) {
			return { action: "continue" };
		}
		// A live job owns the follow-up: the text steers the session already running
		// rather than starting a second job. A job that has reached a product
		// terminal is finished, so the next bare goal starts a new one - otherwise
		// one completed run would silently switch the operator back to plain Pi.
		if (isLiveJob(await readActiveJob(context.cwd))) {
			return { action: "continue" };
		}
		kModeState.enabled = true;
		return {
			action: "transform",
			text: `/kpi --mode gated ${event.text}`,
			images: event.images,
		};
	});
}
