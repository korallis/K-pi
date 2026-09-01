import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Task } from "./run-store.ts";

interface PackageDocument {
	dependencies?: Record<string, string>;
}

export async function assertMinimalistBounds(projectRoot: string, runDirectory: string, task: Task): Promise<void> {
	let candidate: { ladder?: unknown } | undefined;
	try {
		candidate = JSON.parse(await readFile(join(runDirectory, "candidate.json"), "utf8")) as { ladder?: unknown };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (
		candidate !== undefined &&
		(candidate.ladder === undefined ||
			(typeof candidate.ladder !== "string" && (typeof candidate.ladder !== "object" || candidate.ladder === null)))
	) {
		throw new Error("candidate.json.ladder is required before implementation");
	}

	const packageDocument = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as PackageDocument;
	const baseline = new Set(task.dependency_baseline ?? []);
	const allowed = new Set(task.runtime_dependencies ?? []);
	const added = Object.keys(packageDocument.dependencies ?? {}).filter(
		(name) => !baseline.has(name) && !allowed.has(name),
	);
	if (added.length > 0) {
		throw new Error(`undeclared runtime dependencies: ${added.join(", ")}`);
	}
}
