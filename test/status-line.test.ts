import assert from "node:assert/strict";
import test from "node:test";

import { renderIdleBrand, renderWorkingBrand } from "../packages/coding-agent/src/kpi/extensions/status-line/brand.ts";
import {
	getFooterRouteSnapshot,
	resetFooterRouteSnapshot,
	setFooterRouteSnapshot,
} from "../packages/coding-agent/src/kpi/extensions/status-line/route-snapshot.ts";
import {
	assembleFooter,
	COMPACT_LEFT_SEGMENT_ORDER,
	contextColor,
	DEFAULT_LEFT_SEGMENT_ORDER,
	DEFAULT_RIGHT_SEGMENT_ORDER,
	FULL_LEFT_SEGMENT_ORDER,
	formatCost,
	formatKpiJob,
	formatUsage,
	leftSegmentsForPreset,
	SEGMENT_SEPARATOR,
} from "../packages/coding-agent/src/kpi/extensions/status-line/segments.ts";

test("unicode brand is K-π and never bare pi", () => {
	assert.equal(renderIdleBrand(), "K-π");
	assert.notEqual(renderIdleBrand(), "π");
	assert.match(renderWorkingBrand(3_000, 0), /^K-π .+ 3s$/);
	assert.notEqual(renderWorkingBrand(3_000, 0), "π");
	assert.equal(renderIdleBrand("ascii"), "K-pi");
	assert.equal(renderIdleBrand("nerd"), "K-󰵗");
});

test("default segment order matches the visual contract", () => {
	assert.deepEqual(DEFAULT_LEFT_SEGMENT_ORDER, ["brand", "model", "thinking", "path", "git", "context_pct", "cost"]);
	assert.deepEqual(DEFAULT_RIGHT_SEGMENT_ORDER, ["request"]);
	assert.match(SEGMENT_SEPARATOR, />/);
	assert.deepEqual(leftSegmentsForPreset("compact"), [...COMPACT_LEFT_SEGMENT_ORDER]);
	assert.deepEqual(leftSegmentsForPreset("full"), [...FULL_LEFT_SEGMENT_ORDER]);
});

test("cost cells cover oauth local and api_key kinds", () => {
	assert.equal(formatCost(12.34, "oauth"), "(sub)");
	assert.equal(formatCost(12.34, "api_key"), "$12.34");
	assert.equal(formatCost(0, "local"), "(local) $0");
	assert.equal(formatCost(99, "local"), "(local) $0");
});

test("usage omits local and unknown", () => {
	assert.equal(formatUsage(40, "api_key"), "40%");
	assert.equal(formatUsage(undefined, "api_key"), undefined);
	assert.equal(formatUsage(100, "local"), undefined);
	assert.equal(formatUsage(40, "oauth"), "40%");
});

test("context colors follow the required thresholds", () => {
	assert.equal(contextColor(49), "success");
	assert.equal(contextColor(50), "warning");
	assert.equal(contextColor(70), "warning");
	assert.equal(contextColor(71), "accent");
	assert.equal(contextColor(90), "accent");
	assert.equal(contextColor(91), "error");
});

test("end-to-end footer assembly covers every account kind presets job route usage", () => {
	resetFooterRouteSnapshot();

	const oauth = assembleFooter({
		brand: "K-π",
		model: "claude-opus",
		thinking: "high",
		path: "/tmp/repo",
		git: "main",
		contextPercent: 12,
		contextWindow: 200_000,
		cost: 1.5,
		slotKind: "oauth",
		remainingPercent: 55,
		request: "add healthcheck",
		kpiJob: {
			mode: "gated",
			round: 2,
			maxRounds: 3,
			stage: "implement",
			gate: "human",
			route: "anthropic/home",
		},
		preset: "default",
	});
	assert.match(oauth.line, /^K-π/);
	assert.match(oauth.line, /\(sub\)/);
	assert.doesNotMatch(oauth.line, /\$1\.50/);
	assert.match(oauth.jobLine ?? "", /LOOP gated r2\/3 STAGE implement GATE human/);
	assert.match(oauth.jobLine ?? "", /ROUTE anthropic\/home/);
	// usage not on default left rail
	assert.equal(oauth.segments.usage, "55%");
	assert.equal(oauth.segments.usage !== undefined && oauth.line.includes("55%"), false);

	const local = assembleFooter({
		brand: "K-π",
		model: "local-model",
		path: "/tmp/repo",
		cost: 9,
		slotKind: "local",
		remainingPercent: 100,
		preset: "default",
	});
	assert.equal(local.segments.cost, "(local) $0");
	assert.match(local.line, /\(local\) \$0/);
	assert.equal(local.segments.usage, undefined);

	const api = assembleFooter({
		brand: "K-π",
		model: "gpt",
		path: "/tmp/repo",
		cost: 3.21,
		slotKind: "api_key",
		remainingPercent: 12,
		preset: "full",
		kpiJob: {
			mode: "autopilot",
			round: 1,
			maxRounds: 5,
			stage: "test",
			gate: "machine",
			ac: "4/5",
			route: "openai/work",
		},
	});
	assert.match(api.line, /\$3\.21/);
	assert.match(api.line, /12%/);
	assert.match(api.line, /LOOP autopilot/);
	assert.equal(api.jobLine, undefined, "full embeds kpi_job on the primary line");

	const compact = assembleFooter({
		brand: "K-π",
		model: "m",
		path: "/tmp/x",
		cost: 0,
		slotKind: "oauth",
		preset: "compact",
		kpiJob: { mode: "gated", round: 0, maxRounds: 3, stage: "plan", gate: "machine" },
	});
	assert.doesNotMatch(compact.line, /thinking|git|context/i);
	assert.match(compact.line, /\(sub\)/);
	assert.ok(compact.jobLine);

	setFooterRouteSnapshot({ slotKind: "local", route: "ollama/home" });
	assert.equal(getFooterRouteSnapshot().slotKind, "local");
	assert.equal(getFooterRouteSnapshot().route, "ollama/home");
	resetFooterRouteSnapshot();
});

test("formatKpiJob is the documented second line shape", () => {
	assert.equal(
		formatKpiJob({
			mode: "gated",
			round: 2,
			maxRounds: 3,
			stage: "implement",
			gate: "human",
			ac: "4/5",
			route: "anthropic/home",
		}),
		"K-π LOOP gated r2/3 STAGE implement GATE human AC 4/5 ROUTE anthropic/home",
	);
});
