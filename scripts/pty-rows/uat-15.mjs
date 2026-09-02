/**
 * UAT-15 — US-15 Status bar with K-π brand.
 *
 * Action: capture the footer idle, during a turn, with an `oauth` slot active
 * and a `local` slot active, and at context 40, 60, 80 and 95 percent.
 *
 * The four context colours are calibrated, not assumed: each band is reached by
 * making the stub report usage that lands the percentage there, and the colour
 * is then read off the SGR byte the footer emitted immediately before the cell.
 * A formula is never trusted - the rendered percentage is measured, and the
 * measured percentage is what the band assertion is checked against.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesOf, check, drive, egressClean, freePort, LOCAL_CONTEXT_WINDOW, sandbox, seedRun, startStub, teardown, writeRow, repoRoot } from "./lib.mjs";

const EVIDENCE = join(repoRoot, ".kpi", "uat", "UAT-15");

/** The footer row: the painted line carrying the brand and the chevron rail. */
function footerRows(text) {
	return text
		.split("\n")
		.map((line) => line.replace(/\r/gu, ""))
		.filter((line) => line.includes("K-π") && line.includes(">") && line.includes("⬡"));
}

/**
 * The truecolor SGR the footer emitted for the context cell, with the
 * percentage it was painted next to.
 */
function contextPaints(raw) {
	const cell = bytesOf("▦");
	const pattern = new RegExp(`\\u001b\\[38;2;(\\d+);(\\d+);(\\d+)m${cell} (\\d+)%`, "gu");
	return [...raw.matchAll(pattern)].map((match) => ({
		rgb: `${match[1]},${match[2]},${match[3]}`,
		percent: Number(match[4]),
	}));
}

/** Which band a measured percentage belongs to, per AC-15.x. */
function bandOf(percent) {
	if (percent < 50) return "green";
	if (percent <= 70) return "yellow";
	if (percent <= 90) return "orange";
	return "red";
}

/**
 * Hue angle in degrees, so "green, yellow, orange, red" is graded as colour
 * rather than as a palette name.
 *
 * Amber (#ffb020, 38°) and orange (#ff6a1a, 21°) are close enough that naming
 * them apart by eye is arguable, so the row is graded on what is not arguable:
 * four distinct colours, warming monotonically as the context fills, each in
 * the right neighbourhood.
 */
function hueAngle(rgb) {
	const [r, g, b] = rgb.split(",").map((value) => Number(value) / 255);
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max === min) return 0;
	const d = max - min;
	const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return Math.round(h * 60);
}

/** Neighbourhoods wide enough to name, narrow enough to be wrong. */
function hueOf(rgb) {
	const angle = hueAngle(rgb);
	if (angle >= 80 && angle <= 170) return "green";
	if (angle >= 30 && angle < 80) return "yellow";
	if (angle >= 12 && angle < 30) return "orange";
	if (angle < 12 || angle > 340) return "red";
	return `unclassified(${rgb}@${angle}deg)`;
}

async function footerCapture(label, { promptTokens, slotKind = "local", outDir, extraScript = [], underKpiTheme = false, spinnerBody = false, spinnerWait = false }) {
	const port = await freePort();
	const box = sandbox(label, { baseUrl: `http://127.0.0.1:${port}/v1`, port });
	if (slotKind === "oauth") {
		// An oauth slot in a credentialed pool, still served by the loopback stub:
		// `(sub)` is a claim about the slot kind, not about reaching a real vendor.
		writeFileSync(
			join(box.agentDir, "settings.json"),
			`${JSON.stringify({ defaultProvider: "zai", defaultModel: "glm-5.3" }, null, 2)}\n`,
		);
		writeFileSync(
			join(box.agentDir, "models.json"),
			`${JSON.stringify({ providers: { zai: { baseUrl: `http://127.0.0.1:${port}/v1` } } }, null, 2)}\n`,
		);
		writeFileSync(
			join(box.agentDir, "accounts.json"),
			`${JSON.stringify(
				{
					version: 1,
					pools: { zai: { strategy: "round-robin", slots: [{ id: "a", kind: "oauth", label: "a" }] } },
					fallback: ["zai"],
					stickiness: "session-until-exhausted",
				},
				null,
				2,
			)}\n`,
		);
		// The model runtime's own preflight refuses a provider with no configured
		// credential before the accounts hook is ever consulted, so the provider
		// carries an api_key while the *slot* is the oauth one. The cost cell
		// reports the slot kind, which is what the row is about.
		writeFileSync(
			join(box.agentDir, "auth.json"),
			`${JSON.stringify({ zai: { type: "api_key", key: "pty-zai-preflight" } }, null, 2)}\n`,
		);
		writeFileSync(
			join(box.agentDir, "accounts.secrets.json"),
			`${JSON.stringify({ "zai/a": { type: "oauth", access: "pty-slot-oauth", refresh: "r", expires: Date.now() + 3_600_000 } }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	}
	const modelId = slotKind === "oauth" ? "glm-5.3" : "uat-stub";
	// The footer prints the model's display name, which the catalog capitalises.
	// Waiting for the id would wait forever and the turn would never be typed.
	const modelCell = slotKind === "oauth" ? "GLM-5.3" : "uat-stub";
	writeFileSync(
		join(box.home, "screenplay.json"),
		JSON.stringify({
			models: [modelId],
			scenes: [
				// A turn with a tool round trip: request, tool call, the agent runs
				// `read`, second request, answer. An instant single-request turn can
				// finish between two render ticks, so the working brand would never be
				// painted and catching the spinner would be luck rather than proof.
				...(spinnerBody
					? [
							{
								node: "tool-hop",
								match: {},
								once: true,
								turns: [
									{
										tool_calls: [{ name: "read", arguments: { path: "README.md" } }],
										finish_reason: "tool_calls",
										usage: { prompt_tokens: promptTokens, completion_tokens: 4 },
									},
								],
							},
						]
					: []),
				{
					node: "any",
					match: {},
					turns: [{ content: "TURNDONE", usage: { prompt_tokens: promptTokens, completion_tokens: 4 } }],
				},
			],
		}),
	);
	const stub = await startStub(port, join(box.home, "model.jsonl"), join(box.home, "screenplay.json"));
	if (underKpiTheme) {
		// `/kpi status` only draws - and only applies K-π's theme - when there is
		// a job to draw.
		const jobId = "20260902-uat15";
		seedRun(box.project, jobId, {
			task: {
				job_id: jobId,
				mode: "gated",
				goal: "status bar",
				nongoals: [],
				acceptance: [],
				constraints: [],
				quality_gates: [],
				ac: { quality: "executable" },
			},
			state: {
				job_id: jobId,
				mode: "gated",
				round: 1,
				maxRounds: 3,
				stage: "implement",
				node: "implement",
				status: "RUNNING",
				graph_status: "running",
			},
			files: { "candidate.json": "{}\n" },
		});
	}
	const result = await drive({
		env: box.env,
		cwd: box.project,
		cols: 160,
		// A credentialed cloud pool resolves official model ids from the provider
		// catalog on pi.dev. That is a real startup network operation the product
		// lets an operator decline, unlike an install report, so the row declines
		// it with the product's own flag rather than pretending it did not happen.
		args: slotKind === "oauth" ? ["--offline"] : [],
		script: [
			{ expect: `⬡ ${modelCell}`, send: "/kpi off\r", timeout: 40 },
			{ expect: "goal wrapping off", send: "say ok\r", timeout: 30 },
			// The footer's four context colours resolve through the *active theme*,
			// and K-π's own theme is only applied once the board is drawn. Grading
			// the palette outside it would grade Pi's default dark theme instead.
			...(spinnerWait
				? [{ expect: "K-\u03c0 [\u2800-\u28ff] \\d+s", timeout: 45 }]
				: []),
			...(underKpiTheme
				? [
						{ expect: "TURNDONE", send: "/kpi status\r", timeout: 60 },
						{ expect: "STOP RUNNING", send: "q", timeout: 30 },
						{ expect: "TURNDONE", timeout: 30, drain: 3, after: 2.5 },
					]
				: [{ expect: "TURNDONE", timeout: 60, drain: 2.5, after: 2 }]),
			...extraScript,
		],
		outDir,
	});
	const egress = egressClean(box);
	teardown(box, stub);
	return { ...result, egress };
}

// --- context colour calibration -------------------------------------------
// Four targets, each expressed as the token count that should land in a band.
// The rendered percentage decides the band; the target is only a starting point.
const BANDS = [
	{ target: 40, promptTokens: Math.round(0.4 * LOCAL_CONTEXT_WINDOW) - 4 },
	{ target: 60, promptTokens: Math.round(0.6 * LOCAL_CONTEXT_WINDOW) - 4 },
	{ target: 80, promptTokens: Math.round(0.8 * LOCAL_CONTEXT_WINDOW) - 4 },
	{ target: 95, promptTokens: Math.round(0.95 * LOCAL_CONTEXT_WINDOW) - 4 },
];

const calibration = [];
for (const band of BANDS) {
	const outDir = join(EVIDENCE, `context-${band.target}`);
	const capture = await footerCapture(`u15-ctx${band.target}`, {
		promptTokens: band.promptTokens,
		outDir,
		underKpiTheme: true,
	});
	// The last paint is the one after the turn settled.
	const paints = contextPaints(capture.raw);
	const painted = paints.at(-1);
	calibration.push({
		target: band.target,
		promptTokens: band.promptTokens,
		measuredPercent: painted?.percent ?? null,
		rgb: painted?.rgb ?? null,
		hue: painted === undefined ? null : hueOf(painted.rgb),
		expectedBand: painted === undefined ? null : bandOf(painted.percent),
		egressClean: capture.egress.clean,
	});
}
writeFileSync(join(EVIDENCE, "context-calibration.json"), `${JSON.stringify(calibration, null, 2)}\n`);

// --- cost cell: (sub) vs exactly (local) $0 --------------------------------
const localCapture = await footerCapture("u15-local", {
	promptTokens: 120,
	slotKind: "local",
	outDir: join(EVIDENCE, "cost-local"),
});
const oauthCapture = await footerCapture("u15-oauth", {
	promptTokens: 120,
	slotKind: "oauth",
	outDir: join(EVIDENCE, "cost-oauth"),
});

// --- spinner during a turn, and /statusbar restoring Pi's footer -----------
const spinnerCapture = await footerCapture("u15-spin", {
	promptTokens: 120,
	outDir: join(EVIDENCE, "spinner"),
	spinnerBody: true,
	// Waiting for the spinner IS the proof: the step only completes when a
	// working brand frame with elapsed seconds is on screen, so a race cannot
	// silently pass the assertion below.
	spinnerWait: true,
	extraScript: [
		{ expect: "TURNDONE", send: "/statusbar\r", timeout: 40 },
		{ expect: "default footer restored", timeout: 25, drain: 2, after: 1.5 },
	],
});

const idleRow = footerRows(localCapture.text)[0] ?? "";
const localRows = footerRows(localCapture.text);
const oauthRows = footerRows(oauthCapture.text);
const lastLocal = localRows.at(-1) ?? "";
const lastOauth = oauthRows.at(-1) ?? "";

// AC-15.2: brand, model, thinking, path, git, context_pct, cost — in order.
const ORDER = ["K-π", "⬡", "●", "📁", "⎇", "▦"];
const orderOk = (() => {
	let cursor = -1;
	for (const glyph of ORDER) {
		const at = lastLocal.indexOf(glyph);
		if (at <= cursor) return false;
		cursor = at;
	}
	// Cost is the last cell on the rail.
	return lastLocal.indexOf("▦") < Math.max(lastLocal.indexOf("(local) $0"), lastLocal.indexOf("(sub)"), lastLocal.lastIndexOf("$"));
})();

const bandsCorrect = calibration.filter((entry) => entry.hue === entry.expectedBand);
const distinctHues = new Set(calibration.map((entry) => entry.hue));
// The brand animates with elapsed seconds while a turn is in flight.
const spinnerMatches = [...spinnerCapture.text.matchAll(/K-\u03c0 ([\u2800-\u28ff]) (\d+)s/gu)];
const spinnerFrames = spinnerMatches.map((match) => match[2]);
const brandSpins = spinnerMatches.length > 0;

const checks = [
	check(
		"brand-cell-is-exactly-K-pi",
		"cost-local/frame.raw",
		localCapture.raw.includes(bytesOf("K-π")) && !/(?:^|[^-])\bomp\b/u.test(idleRow),
		idleRow.slice(0, 28) || "no footer row",
	),
	check(
		"brand-is-leftmost",
		"cost-local/frame.txt",
		lastLocal.trimStart().startsWith("K-π"),
		lastLocal.trimStart().slice(0, 24) || "empty",
	),
	check(
		"segment-order",
		"cost-local/frame.txt",
		orderOk,
		lastLocal.replace(/\s+/gu, " ").slice(0, 130) || "empty",
	),
	check(
		"four-context-bands-calibrated",
		"context-calibration.json",
		bandsCorrect.length === 4 && distinctHues.size === 4,
		calibration.map((entry) => `${entry.measuredPercent}%→${entry.hue}(${entry.rgb})`).join("  "),
	),
	check(
		"context-bands-match-measured-percent",
		"context-calibration.json",
		calibration.every((entry) => entry.hue === entry.expectedBand),
		calibration.map((entry) => `${entry.measuredPercent}% expected ${entry.expectedBand} got ${entry.hue}`).join(" | "),
	),
	check(
		"oauth-slot-renders-sub",
		"cost-oauth/frame.txt",
		lastOauth.includes("(sub)"),
		lastOauth.replace(/\s+/gu, " ").slice(0, 130) || "empty",
	),
	check(
		"local-slot-renders-exactly-local-zero",
		"cost-local/frame.txt",
		lastLocal.includes("(local) $0") && !/\(local\) \$0\s*\d+%/u.test(lastLocal),
		(lastLocal.match(/\(local\) \$0[^\n]{0,12}/u) ?? ["absent"])[0],
	),
	check(
		"local-cost-cell-carries-no-quota-percentage",
		"cost-local/frame.txt",
		!/\(local\) \$0[^\n]*?\d+%/u.test(lastLocal),
		/\(local\) \$0[^\n]*?\d+%/u.test(lastLocal) ? "a percentage followed the local cost cell" : "no quota percentage after the cost cell",
	),
	check(
		"brand-spins-with-elapsed-seconds",
		"spinner/frame.raw",
		brandSpins,
		brandSpins ? `elapsed frames observed: ${[...new Set(spinnerFrames)].slice(0, 6).join(", ")}s` : "no elapsed-second frame on the brand",
	),
	check(
		"statusbar-restores-the-default-footer",
		"spinner/frame.txt",
		spinnerCapture.text.includes("default footer restored") && footerRows(spinnerCapture.text).length > 0,
		spinnerCapture.text.includes("default footer restored") ? "Pi default footer restored" : "no restore notice",
	),
	check(
		"loopback-only",
		"egress",
		[localCapture, oauthCapture, spinnerCapture].every((capture) => capture.egress.clean) &&
			calibration.every((entry) => entry.egressClean),
		[
			...["local", "oauth", "spinner"].flatMap((name, index) => {
				const capture = [localCapture, oauthCapture, spinnerCapture][index];
				return capture.egress.clean ? [] : [`${name}: ${capture.egress.text.replace(/\s+/gu, " ").slice(0, 160)}`];
			}),
			...calibration.flatMap((entry) => (entry.egressClean ? [] : [`context-${entry.target}: outbound recorded`])),
		].join(" | ") || "no outbound attempt",
	),
];

/**
 * Control: re-grade each calibrated band against a neighbouring band's expected
 * hue. Every one must fail, otherwise the four colours are not being told apart
 * and "green/yellow/orange/red" would pass on any palette.
 */
const rotated = ["yellow", "orange", "red", "green"];
const controlFailures = calibration
	.map((entry, index) => (entry.hue === rotated[index] ? undefined : `band-${entry.target}-is-not-${rotated[index]}`))
	.filter((entry) => entry !== undefined);

const verdict = writeRow(EVIDENCE, "UAT-15", {
	checks,
	control: {
		describe:
			"Each calibrated band is re-graded against the next band's colour (40%→yellow, 60%→orange, 80%→red, 95%→green). All four must fail, or the colour assertions are not distinguishing the four palette entries.",
		failedChecks: controlFailures,
	},
	notes: `Driven against \`dist/bundle/cli.js\` over a real PTY at 160 columns, clean HOME, scratch git repo, loopback stub, egress guard.

**Calibration.** The context window is ${LOCAL_CONTEXT_WINDOW} tokens for a local model, so each band is reached by having the stub report \`prompt_tokens\` for that share and then *reading back the percentage the footer actually painted*. The band assertion is checked against that measured percentage, not against the token count that was requested — see \`context-calibration.json\` for the requested tokens, the measured percentage, the SGR triple and the hue it classifies as.

**Colour is graded on bytes.** The context cell's colour is the truecolor SGR immediately preceding \`▦ NN%\`, matched against the UTF-8 bytes of the glyph rather than a decoded character.

**Cost cell.** \`(local) $0\` is captured from a local pool and \`(sub)\` from an \`oauth\` slot in a credentialed pool that is still served by loopback — the slot kind is what the cell reports, and no vendor is contacted. Both are read from the footer row itself, not from the accounts widget, which also prints \`(local) $0\`.`,
});

console.log(JSON.stringify(verdict.checks.map((entry) => `${entry.ok ? "ok" : "FAIL"} ${entry.id}`), null, 1));
console.log("calibration:", JSON.stringify(calibration));
console.log("control discriminates:", verdict.control?.discriminates);
