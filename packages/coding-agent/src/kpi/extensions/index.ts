import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { registerKMode } from "../kstack/mode.ts";
import { registerKStackSetup } from "../kstack/models.ts";
import { registerControlPlane } from "./control-plane.ts";
import { registerOnboarding } from "./onboarding.ts";
import { registerPing } from "./ping.ts";
import { registerPrintProfile } from "./print-profile.ts";
import { registerEventRenderers } from "./renderers.ts";
import { registerRouting } from "./routing.ts";
import { registerRuntime } from "./runtime.ts";
import { registerStatusLine } from "./status-line/index.ts";

export default function kPi(pi: ExtensionAPI): void {
	registerRuntime(pi);
	registerRouting(pi);
	registerControlPlane(pi);
	registerPing(pi);
	registerKMode(pi);
	registerKStackSetup(pi);

	registerPrintProfile(pi);
	registerEventRenderers(pi);
	registerStatusLine(pi);
	// Registered last: its session_start hook must run after the accounts
	// credential import and the footer install above.
	registerOnboarding(pi);
}
