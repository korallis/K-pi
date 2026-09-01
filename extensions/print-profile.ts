import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRINT_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function registerPrintProfile(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, context) => {
    if (context.mode !== "print") return;
    pi.setActiveTools(pi.getActiveTools().filter((tool) => PRINT_TOOLS.has(tool)));
  });
}
