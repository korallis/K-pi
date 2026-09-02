import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStackFromTask, readDuneStack } from "../src/kpi/extensions/stack.ts";
import type { Task } from "../src/kpi/extensions/run-store.ts";

describe("ensureStackFromTask", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("writes a valid stack from task write bounds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kpi-stack-"));
		dirs.push(dir);
		const task = {
			job_id: "job-1",
			mode: "autopilot",
			goal: "health",
			nongoals: [],
			acceptance: [
				{
					id: "AC-01",
					statement: "cmd npm test exits 0; writes only src/health/** and test/health/**",
					required: true,
					check: { kind: "command", cmd: "npm test", expect: { exit: 0 } },
					bounds: { write_allow: ["src/health/**", "test/health/**"] },
				},
			],
			constraints: [],
			quality_gates: ["npm test"],
			ac: { quality: "executable" },
			dependency_baseline: [],
		} as Task;
		await ensureStackFromTask(dir, task);
		const stack = await readDuneStack(dir);
		expect(stack.current_module_id).toBe("health");
		expect(stack.modules[0]?.folder).toBe("src/health");
		expect(JSON.parse(readFileSync(join(dir, "stack.json"), "utf8")).task_hash).toBeTruthy();
	});
});
