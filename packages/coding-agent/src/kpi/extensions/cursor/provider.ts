import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { refreshCursorModels } from "./discovery.ts";
import { cursorOAuth } from "./oauth.ts";
import { streamCursor } from "./stream.ts";

export function registerCursorProvider(pi: ExtensionAPI): void {
	pi.registerProvider("cursor", {
		name: "Cursor",
		api: "kpi-cursor",
		baseUrl: "https://api2.cursor.sh",
		models: [],
		oauth: cursorOAuth,
		refreshModels: refreshCursorModels,
		streamSimple: streamCursor,
	});
}
