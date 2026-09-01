import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerPing(pi: ExtensionAPI): void {
  pi.registerCommand("kpi-ping", {
    description: "Verify that k-pi loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("ok", "info");
    },
  });
}
