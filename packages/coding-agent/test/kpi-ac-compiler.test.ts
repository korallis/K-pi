import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileAcceptanceCriteria } from "../src/kpi/extensions/graph/ac-compiler.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

describe("compileAcceptanceCriteria", () => {
	it("classifies the healthcheck-auto fixture as executable", () => {
		const goal = readFileSync(join(repoRoot, "fixtures/healthcheck-auto/task.txt"), "utf8");
		const result = compileAcceptanceCriteria(goal);
		expect(result.quality).toBe("executable");
		expect(result.acceptance.length).toBe(5);
		expect(result.acceptance.every((a) => a.check?.kind === "command")).toBe(true);
		expect(result.acceptance.every((a) => a.bounds?.write_allow?.length)).toBe(true);
		expect(result.missingChecks).toEqual([]);
	});

	it("classifies a bare narrative goal as narrative", () => {
		const result = compileAcceptanceCriteria("add a healthcheck endpoint and verify it");
		expect(result.quality).toBe("narrative");
		expect(result.missingChecks.length).toBeGreaterThan(0);
	});

	it("classifies the healthcheck-gated fixture goal as executable", () => {
		const goal = readFileSync(join(repoRoot, "fixtures/healthcheck-gated/task.txt"), "utf8").trim();
		const result = compileAcceptanceCriteria(goal);
		expect(result.quality).toBe("executable");
		expect(result.acceptance[0]?.check?.kind).toBe("command");
		expect(result.acceptance[0]?.bounds?.write_allow).toEqual(
			expect.arrayContaining(["src/health/**", "test/health/**"]),
		);
	});
});
