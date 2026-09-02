import type { InlineExtension } from "../core/extensions/types.ts";
import kpiExtension from "../kpi/extensions/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "k-pi", factory: kpiExtension },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
