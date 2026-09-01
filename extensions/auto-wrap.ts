import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { kModeState } from "../kstack/mode.ts";
import { readActiveJob } from "./control-plane.ts";
import { autoWrapState } from "./settings.ts";

export function registerAutoWrap(pi: ExtensionAPI): void {
  pi.on("input", async (event, context) => {
    const text = event.text.trim();
    if (!autoWrapState.enabled || text.length === 0 || text.startsWith("/")) {
      return { action: "continue" };
    }
    if ((await readActiveJob(context.cwd)) !== undefined) {
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
