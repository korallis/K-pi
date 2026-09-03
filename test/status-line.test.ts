import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { renderIdleBrand, renderWorkingBrand } from "../packages/coding-agent/src/kpi/extensions/status-line/brand.ts";
import { registerStatusLine } from "../packages/coding-agent/src/kpi/extensions/status-line/index.ts";
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
	formatStatusRow,
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
			stage: "implement",
			gate: "human",
			route: "anthropic/home",
		},
		preset: "default",
	});
	assert.match(oauth.line, /^K-π/);
	assert.match(oauth.line, /\(sub\)/);
	assert.doesNotMatch(oauth.line, /\$1\.50/);
	assert.match(oauth.jobLine ?? "", /LOOP gated r2 STAGE implement GATE human/);
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
		kpiJob: { mode: "gated", round: 0, stage: "plan", gate: "machine" },
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
			stage: "implement",
			gate: "human",
			ac: "4/5",
			route: "anthropic/home",
		}),
		"K-π LOOP gated r2 STAGE implement GATE human AC 4/5 ROUTE anthropic/home",
	);
});

test("registered footer full preset embeds kpi job fields and refreshes after state change", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-footer-reg-"));
	const run = join(root, ".kpi", "runs", "footer-job");
	await mkdir(run, { recursive: true });
	await writeFile(
		join(run, "state.json"),
		JSON.stringify({
			job_id: "footer-job",
			mode: "gated",
			round: 1,
			stage: "implement",
			status: "RUNNING",
			graph_status: "running",
		}),
	);

	let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	let agentSettled: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	let statusbar: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let footerFactory:
		| ((
				tui: unknown,
				theme: unknown,
				footerData: unknown,
		  ) => { render: (w: number) => string[]; dispose?: () => void })
		| undefined;
	const statuses = new Map<string, string | undefined>();
	let renderCalls = 0;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			if (event === "session_start") sessionStart = handler;
			if (event === "agent_settled") agentSettled = handler;
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			if (name === "statusbar") statusbar = def.handler;
		},
	} as unknown as ExtensionAPI;

	const theme = {
		fg(_name: string, text: string) {
			return text;
		},
	};
	const footerData = {
		getGitBranch: () => "main",
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map<string, string>(),
		getExtensionStatusLine: () => undefined,
	};
	const ctx = {
		cwd: root,
		mode: "tui",
		model: { name: "test-model" },
		thinkingLevel: "off",
		getContextUsage: () => ({ percent: 10, contextWindow: 100_000 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory as typeof footerFactory;
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			notify() {},
		},
	} as unknown as ExtensionContext;

	const tui = {
		requestRender() {
			renderCalls += 1;
		},
	};

	let component: { render: (w: number) => string[]; dispose?: () => void } | undefined;
	try {
		registerStatusLine(pi);
		setFooterRouteSnapshot({ slotKind: "oauth", route: "anthropic/home", remainingPercent: 40 });
		sessionStart?.({}, ctx);
		assert.ok(footerFactory, "footer must register on session_start");

		// Allow async job refresh from session_start.
		await new Promise((r) => setTimeout(r, 30));
		await statusbar?.("preset full", ctx);
		await new Promise((r) => setTimeout(r, 30));

		component = footerFactory!(tui, theme, footerData);
		const line = component.render(200).join("\n");
		assert.match(line, /LOOP gated/);
		assert.match(line, /r1(?![\d/])/);
		assert.match(line, /STAGE implement/);
		assert.match(line, /GATE machine/);
		assert.match(line, /ROUTE anthropic\/home/);
		assert.equal(statuses.get("kpi"), undefined, "full clears second status line");

		// State change → agent_settled refresh
		await writeFile(
			join(run, "state.json"),
			JSON.stringify({
				job_id: "footer-job",
				mode: "gated",
				round: 2,
				stage: "test",
				status: "RUNNING",
				graph_status: "interrupted",
				pending_question: "Continue?",
			}),
		);
		agentSettled?.({}, ctx);
		await new Promise((r) => setTimeout(r, 40));
		assert.ok(renderCalls >= 1, "job field change should request render");
		const updated = component.render(200).join("\n");
		assert.match(updated, /r2(?![\d/])/);
		assert.match(updated, /STAGE test/);
		assert.match(updated, /GATE human/);
		assert.match(updated, /ROUTE anthropic\/home/);

		// Failover updates account/usage and ROUTE from the live snapshot without a job refresh.
		const rendersBeforeRoute = renderCalls;
		setFooterRouteSnapshot({ slotKind: "api_key", route: "openai/work", remainingPercent: 12 });
		await new Promise((r) => setTimeout(r, 20));
		assert.ok(renderCalls > rendersBeforeRoute, "route snapshot change should request render");
		const afterRoute = component.render(200).join("\n");
		assert.match(afterRoute, /ROUTE openai\/work/);
		assert.doesNotMatch(afterRoute, /ROUTE anthropic\/home/);
		assert.match(afterRoute, /\$|12%|openai/);
		assert.match(afterRoute, /r2(?![\d/])/);
		assert.match(afterRoute, /GATE human/);
	} finally {
		component?.dispose?.();
		resetFooterRouteSnapshot();
		await rm(root, { recursive: true, force: true });
	}
});

test("the registered footer draws the extension statuses it took over", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-footer-status-"));
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	let statusbar: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let footerFactory:
		| ((
				tui: unknown,
				theme: unknown,
				footerData: unknown,
		  ) => { render: (w: number) => string[]; dispose?: () => void })
		| undefined;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			if (name === "statusbar") statusbar = def.handler;
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: root,
		mode: "tui",
		model: { name: "test-model" },
		thinkingLevel: "off",
		getContextUsage: () => ({ percent: 10, contextWindow: 100_000 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory as typeof footerFactory;
			},
			setStatus() {},
			notify() {},
		},
	} as unknown as ExtensionContext;

	let component: { render: (w: number) => string[]; dispose?: () => void } | undefined;
	try {
		registerStatusLine(pi);
		sessionStart?.({}, ctx);
		assert.ok(footerFactory, "footer must register on session_start");
		await new Promise((resolve) => setTimeout(resolve, 30));

		// Replacing Pi's footer removed the row these are drawn on. Every status
		// used to be concatenated onto it, so the accounts summary and the job
		// line ran together and ROUTE printed twice.
		const footerData = {
			getGitBranch: () => "main",
			onBranchChange: () => () => {},
			getExtensionStatuses: () =>
				new Map([
					["accounts", "ACCOUNTS\n  ANTHROPIC default 40%\nROUTE   anthropic/home via default"],
					["kpi", "K-π LOOP gated r2 STAGE implement GATE human ROUTE anthropic/home"],
				]),
			getExtensionStatusLine: () => "unused",
		};
		component = footerFactory!({ requestRender() {} }, { fg: (_name: string, text: string) => text }, footerData);
		const lines = component.render(200);
		assert.equal(lines.length, 2, `expected the rail and one status row, got ${lines.length} line(s)`);
		assert.ok(lines[0]?.includes("K-π"), "the first row is still the K-π rail");
		assert.match(lines[1] ?? "", /LOOP gated r2 STAGE implement GATE human/u);
		assert.equal((lines[1]?.match(/ROUTE/gu) ?? []).length, 1, "ROUTE prints once");
		assert.doesNotMatch(lines[1] ?? "", /ACCOUNTS/u, "the accounts summary stays off the default row");

		await statusbar?.("preset full", ctx);
		component.dispose?.();
		component = footerFactory!({ requestRender() {} }, { fg: (_name: string, text: string) => text }, footerData);
		const full = component.render(200);
		assert.match(
			full[1] ?? "",
			/ACCOUNTS ANTHROPIC default 40% ROUTE anthropic\/home via default/u,
			"full shows the accounts summary",
		);
	} finally {
		component?.dispose?.();
		resetFooterRouteSnapshot();
		await rm(root, { recursive: true, force: true });
	}
});

test("formatStatusRow keeps one job line by default and the accounts summary under full", () => {
	const statuses = new Map([
		["kpi", "K-π LOOP gated r0 STAGE plan GATE machine"],
		["accounts", "ACCOUNTS\n  ANTHROPIC default ?%"],
		["zeta", " trailing \n"],
	]);
	assert.equal(formatStatusRow(statuses, "default"), "K-π LOOP gated r0 STAGE plan GATE machine trailing");
	assert.equal(formatStatusRow(statuses, "compact"), "K-π LOOP gated r0 STAGE plan GATE machine trailing");
	assert.equal(
		formatStatusRow(statuses, "full"),
		"ACCOUNTS ANTHROPIC default ?% K-π LOOP gated r0 STAGE plan GATE machine trailing",
	);
	assert.equal(formatStatusRow(new Map(), "default"), undefined);
	assert.equal(formatStatusRow(new Map([["accounts", "ACCOUNTS"]]), "default"), undefined);
});

test("the job line is hidden when the newest job is finished", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-footer-finished-"));
	const run = join(root, ".kpi", "runs", "done-job");
	await mkdir(run, { recursive: true });
	await writeFile(
		join(run, "state.json"),
		JSON.stringify({ job_id: "done-job", mode: "gated", round: 3, stage: "ship", status: "DONE" }),
	);
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	const statuses = new Map<string, string | undefined>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		mode: "tui",
		model: { name: "test-model" },
		thinkingLevel: "off",
		getContextUsage: () => ({ percent: 10, contextWindow: 100_000 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			setFooter() {},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			notify() {},
		},
	} as unknown as ExtensionContext;
	try {
		registerStatusLine(pi);
		sessionStart?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(statuses.get("kpi"), undefined, "a finished run publishes no job line");
	} finally {
		resetFooterRouteSnapshot();
		await rm(root, { recursive: true, force: true });
	}
});

test("a footer with no extension statuses stays a single row", async () => {
	const root = await mkdtemp(join(tmpdir(), "kpi-footer-nostatus-"));
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	let footerFactory:
		| ((
				tui: unknown,
				theme: unknown,
				footerData: unknown,
		  ) => { render: (w: number) => string[]; dispose?: () => void })
		| undefined;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		mode: "tui",
		model: { name: "test-model" },
		thinkingLevel: "off",
		getContextUsage: () => ({ percent: 10, contextWindow: 100_000 }),
		sessionManager: { getBranch: () => [] },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory as typeof footerFactory;
			},
			setStatus() {},
			notify() {},
		},
	} as unknown as ExtensionContext;
	let component: { render: (w: number) => string[]; dispose?: () => void } | undefined;
	try {
		registerStatusLine(pi);
		sessionStart?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 30));
		component = footerFactory!(
			{ requestRender() {} },
			{ fg: (_name: string, text: string) => text },
			{
				getGitBranch: () => "main",
				onBranchChange: () => () => {},
				getExtensionStatuses: () => new Map<string, string>(),
				getExtensionStatusLine: () => undefined,
			},
		);
		assert.equal(component.render(200).length, 1);
	} finally {
		component?.dispose?.();
		resetFooterRouteSnapshot();
		await rm(root, { recursive: true, force: true });
	}
});
