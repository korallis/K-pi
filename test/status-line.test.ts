import assert from "node:assert/strict";
import test from "node:test";

import { renderIdleBrand, renderWorkingBrand } from "../packages/coding-agent/src/kpi/extensions/status-line/brand.ts";
import {
	contextColor,
	DEFAULT_LEFT_SEGMENT_ORDER,
	DEFAULT_RIGHT_SEGMENT_ORDER,
	formatCost,
	SEGMENT_SEPARATOR,
} from "../packages/coding-agent/src/kpi/extensions/status-line/segments.ts";

test("unicode brand is K-π and never bare pi", () => {
	assert.equal(renderIdleBrand(), "K-π");
	assert.notEqual(renderIdleBrand(), "π");
	assert.match(renderWorkingBrand(3_000, 0), /^K-π .+ 3s$/);
	assert.notEqual(renderWorkingBrand(3_000, 0), "π");
});

test("default segment order matches the visual contract", () => {
	assert.deepEqual(DEFAULT_LEFT_SEGMENT_ORDER, ["brand", "model", "thinking", "path", "git", "context_pct", "cost"]);
	assert.deepEqual(DEFAULT_RIGHT_SEGMENT_ORDER, ["request"]);
	assert.match(SEGMENT_SEPARATOR, />/);
});

test("subscription cost is labeled instead of estimated", () => {
	assert.equal(formatCost(12.34, "oauth"), "(sub)");
	assert.equal(formatCost(12.34, "api_key"), "$12.34");
});

test("context colors follow the required thresholds", () => {
	assert.equal(contextColor(49), "success");
	assert.equal(contextColor(50), "warning");
	assert.equal(contextColor(70), "warning");
	assert.equal(contextColor(71), "accent");
	assert.equal(contextColor(90), "accent");
	assert.equal(contextColor(91), "error");
});
