import { describe, expect, it } from "vitest";
import { makeJobId } from "../src/kpi/extensions/gated-loop.ts";

const JOB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

describe("makeJobId", () => {
	it("accepts multi-line executable AC goals without double dashes", () => {
		const goal = [
			"AC-01: GET /health returns status 200; cmd npm test exits 0; writes only src/health/** and test/health/**",
			'AC-02: GET /health returns JSON {"status":"ok"}; cmd npm test exits 0; writes only src/health/** and test/health/**',
		].join("\n");
		const id = makeJobId(goal);
		expect(id).toMatch(JOB_ID);
		expect(id.includes("--")).toBe(false);
	});

	it("handles short goals", () => {
		expect(makeJobId("hi")).toMatch(JOB_ID);
	});
});
