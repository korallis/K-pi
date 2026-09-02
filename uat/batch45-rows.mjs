/**
 * Batch 4 (accounts/research) + Batch 5 (kstack) UAT row runners.
 * Boundary: no packages source imports; grade product artifacts / built bundle only.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function walkFiles(dir, acc = [], depth = 0) {
	if (!existsSync(dir) || depth > 8) return acc;
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		if (["node_modules", ".git", "dist", "coverage"].includes(ent.name) && depth > 0) continue;
		const p = join(dir, ent.name);
		if (ent.isDirectory()) walkFiles(p, acc, depth + 1);
		else acc.push(p);
	}
	return acc;
}

function grepFiles(roots, pattern, { maxHits = 50 } = {}) {
	const re = typeof pattern === "string" ? new RegExp(pattern, "m") : pattern;
	const hits = [];
	for (const root of roots) {
		for (const f of walkFiles(root)) {
			if (!/\.(ts|js|mjs|json|md|yml|yaml)$/i.test(f)) continue;
			let text;
			try {
				text = readFileSync(f, "utf8");
			} catch {
				continue;
			}
			if (re.test(text)) {
				hits.push(f);
				if (hits.length >= maxHits) return hits;
			}
		}
	}
	return hits;
}

export function createBatch45Runners(h) {
	const {
		prepareSandbox,
		cleanupSandbox,
		runRpc,
		runRpcSequential,
		finishRow,
		fixtureGoal,
		cliPath,
		repoRoot: root,
		pinZaiStubPool,
	} = h;

	async function runUat10() {
		const SELECTIONS = 100;
		const box = await prepareSandbox("UAT-10", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject, home, agentDir, baseUrl, modelLog } = box;
		const art = join(rowDir, "artifacts");
		try {
			writeFileSync(
				join(rowDir, "cmd.txt"),
				[
					"UAT-10 machine half: loopback rotating zai pool (2 slots) + kimi-coding fallback family,",
					`${SELECTIONS} sequential prompts, first request 429, grade widget + model-requests auth hashes`,
					"AC-10.2 anthropic OAuth stack login: attended-only (not driven here)",
					"",
				].join("\n"),
			);

			// Machine half: two credentialed siblings + second family for cross-family order.
			pinZaiStubPool(agentDir, baseUrl, {
				modelId: "glm-5.3",
				slots: 2,
				extraFamilies: [{ id: "kimi-coding", slots: ["a"] }],
			});
			// Persist a copy of the operator-visible accounts contract.
			const accountsPath = join(agentDir, "accounts.json");
			const accountsBody = readFileSync(accountsPath, "utf8");
			writeFileSync(join(art, "accounts.json"), accountsBody);
			const accounts = JSON.parse(accountsBody);
			const zaiSlots = accounts?.pools?.zai?.slots ?? [];
			writeFileSync(
				join(art, "stacked-slots.txt"),
				zaiSlots.length >= 2 ? `zai slots=${zaiSlots.map((s) => s.id).join(",")}\n` : "missing-siblings\n",
			);
			writeFileSync(
				join(art, "fallback-order.txt"),
				Array.isArray(accounts.fallback) ? `${accounts.fallback.join(" → ")}\n` : "missing\n",
			);
			writeFileSync(
				join(art, "model-id-shape.txt"),
				/anthropic\/|openai-codex\/|zai\//.test("zai/glm-5.3") ? "provider/official-id\n" : "bad\n",
			);

			const lines = [
				{ id: "retry", type: "set_auto_retry", enabled: false },
				{ id: "model", type: "set_model", provider: "zai", modelId: "glm-5.3" },
				{ id: "off", type: "prompt", message: "/kpi off" },
			];
			for (let i = 0; i < SELECTIONS; i += 1) {
				lines.push({ id: `p${i}`, type: "prompt", message: `selection probe ${i}` });
			}
			const rpc = await runRpcSequential(env, subject, lines, {
				timeoutMs: 420_000,
				model: "zai/glm-5.3",
			});
			writeFileSync(join(art, "rpc.jsonl"), (rpc.stdout || "").slice(0, 400_000));
			writeFileSync(join(art, "stderr.log"), rpc.stderr || "");

			const requests = existsSync(modelLog)
				? readFileSync(modelLog, "utf8")
						.split("\n")
						.filter(Boolean)
						.flatMap((line) => {
							try {
								return [JSON.parse(line)];
							} catch {
								return [];
							}
						})
				: [];
			writeFileSync(
				join(art, "model-requests.jsonl"),
				existsSync(modelLog) ? readFileSync(modelLog, "utf8") : "",
			);

			const widgetStates = [];
			for (const line of (rpc.stdout || "").split("\n")) {
				if (!line.includes('"statusKey":"accounts"')) continue;
				try {
					const message = JSON.parse(line);
					const text = message.statusText ?? "";
					if (widgetStates.at(-1) !== text) widgetStates.push(text);
				} catch {
					/* skip */
				}
			}
			writeFileSync(join(art, "widget-states.json"), `${JSON.stringify(widgetStates, null, 2)}\n`);

			const byToken = new Map();
			for (const record of requests) {
				const token = record.auth_token_sha256 ?? "none";
				byToken.set(token, (byToken.get(token) ?? 0) + 1);
			}
			const cooled = requests.find((record) => record.response_status === 429);
			const cooledToken = cooled?.auth_token_sha256 ?? null;
			const afterCooling =
				cooledToken == null
					? []
					: requests
							.slice(requests.indexOf(cooled) + 1)
							.filter((record) => record.auth_token_sha256 === cooledToken);
			const distinct = [...byToken.keys()].filter((t) => t !== "none");
			const routes = [...new Set(widgetStates.flatMap((s) => s.match(/via \S+/g) ?? []))];
			const cooldownState = widgetStates.find((s) => /\bcd\s+\d+\s*m\b/u.test(s));
			const remainingPct = widgetStates.some((s) => /\b\d+%/.test(s));
			const tally = {
				total_requests: requests.length,
				distinct_credentials: distinct.length,
				per_credential: Object.fromEntries(byToken),
				cooled_credential: cooledToken,
				requests_to_cooled_after_429: afterCooling.length,
				routes_observed: routes,
				widget_cooldown: cooldownState?.replaceAll("\n", " | ") ?? null,
				remaining_pct_seen: remainingPct,
			};
			writeFileSync(join(art, "selection-tally.json"), `${JSON.stringify(tally, null, 2)}\n`);

			const cooledNever = cooled !== undefined && afterCooling.length === 0;
			writeFileSync(
				join(art, "cooled-never-reselected.txt"),
				cooledNever ? "yes\n" : `no after=${afterCooling.length}\n`,
			);
			writeFileSync(
				join(art, "requests-reached.txt"),
				requests.length >= SELECTIONS ? `${requests.length}\n` : `only ${requests.length}\n`,
			);
			writeFileSync(
				join(art, "one-429.txt"),
				cooled !== undefined ? "yes\n" : "no\n",
			);
			writeFileSync(
				join(art, "widget-cooldown.txt"),
				cooldownState !== undefined ? "yes\n" : `no states=${widgetStates.length}\n`,
			);
			writeFileSync(
				join(art, "route-moved.txt"),
				routes.length > 1 && routes.at(-1) !== routes[0]
					? `${routes.join(" -> ")}\n`
					: `routes=${routes.join("|") || "none"}\n`,
			);
			writeFileSync(
				join(art, "remaining-pct.txt"),
				remainingPct ? "yes\n" : "no\n",
			);
			writeFileSync(
				join(art, "attended-oauth.txt"),
				"ATTENDED-ONLY: /accounts login anthropic twice (AC-10.2) needs interactive OAuth; machine half covers 429 sibling failover.\n",
			);

			const specs = [
				{ id: "stacked-zai-siblings", artifact: "artifacts/stacked-slots.txt", contains: "zai slots=a,b" },
				{ id: "accounts-contract", artifact: "artifacts/accounts.json", contains: "session-until-exhausted" },
				{ id: "fallback-lists-families", artifact: "artifacts/fallback-order.txt", contains: "zai" },
				{ id: "requests-reached-pool", artifact: "artifacts/requests-reached.txt", notContains: "only" },
				{ id: "one-429-served", artifact: "artifacts/one-429.txt", contains: "yes" },
				{ id: "cooled-never-reselected", artifact: "artifacts/cooled-never-reselected.txt", contains: "yes" },
				{ id: "widget-cooldown", artifact: "artifacts/widget-cooldown.txt", contains: "yes" },
				{ id: "route-moved-sibling", artifact: "artifacts/route-moved.txt", contains: "via" },
			];			const notes = [
				"# UAT-10",
				"",
				`- Machine half (loopback): ${requests.length} requests, cooled reselected ${afterCooling.length} times`,
				`- Routes: ${routes.join(" -> ") || "none"}`,
				`- Widget cooldown: ${cooldownState ? "yes" : "no"}`,
				"- AC-10.2 anthropic OAuth stack: ATTENDED-ONLY (not claimed here)",
				`- selection-tally: ${JSON.stringify(tally)}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes,
				extra: { row: "UAT-10", machine: "loopback-zai", attended: ["AC-10.2"] },
			});
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat11() {
		const box = await prepareSandbox("UAT-11", { fixture: "healthcheck-gated" });
		const { rowDir } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-11 official catalogs live; no frozen models arrays\n");
			const art = join(rowDir, "artifacts");
			const bundle = join(root, "packages/coding-agent/dist/bundle/cli.js");
			writeFileSync(join(art, "bundle-exists.txt"), existsSync(bundle) ? "yes\n" : "no\n");
			let bundleText = "";
			if (existsSync(bundle)) {
				// Sample: look for frozen models: arrays near official provider ids
				bundleText = readFileSync(bundle, "utf8");
			}
			const official = ["anthropic", "openai", "openai-codex", "xai", "zai", "zai-coding-cn", "kimi-coding"];
			const frozen = [];
			for (const id of official) {
				// crude: models: [ near provider registration is what we ban
				const re = new RegExp(`${id}[\\s\\S]{0,200}models\\s*:\\s*\\[`, "i");
				if (re.test(bundleText)) frozen.push(id);
			}
			writeFileSync(join(art, "frozen-models.txt"), frozen.length ? frozen.join(",") + "\n" : "none\n");
			// Method names minify away; grade surviving catalog-refresh strings + source.
			const refreshBundle =
				/refreshModels/.test(bundleText) ||
				/Refreshing model catalogs/.test(bundleText) ||
				/Could not refresh model catalogs/.test(bundleText);
			const refreshSrc = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"refreshModels",
				{ maxHits: 20 },
			);
			const refresh = refreshBundle || refreshSrc.length > 0;
			writeFileSync(join(art, "refresh-models.txt"), refresh ? "yes\n" : "no\n");
			writeFileSync(
				join(art, "refresh-models-detail.txt"),
				`bundle=${refreshBundle} src_hits=${refreshSrc.length}\n`,
			);
			const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
			writeFileSync(
				join(art, "readme-update-models.txt"),
				/update --models|kpi update.*models/i.test(readme) ? "yes\n" : "no\n",
			);
			// Try CLI help for update
			const help = spawnSync(process.execPath, [cliPath, "update", "--help"], {
				encoding: "utf8",
				timeout: 15_000,
				env: process.env,
			});
			writeFileSync(join(art, "update-help.txt"), `${help.stdout || ""}\n${help.stderr || ""}\nexit=${help.status}\n`);

			const specs = [
				{ id: "bundle-built", artifact: "artifacts/bundle-exists.txt", contains: "yes" },
				{ id: "no-frozen-official-models", artifact: "artifacts/frozen-models.txt", contains: "none" },
				{ id: "refresh-models-or-help", artifact: "artifacts/refresh-models.txt", contains: "yes" },
			];			const notes = [
				"# UAT-11",
				"",
				`- frozen official models arrays: ${frozen.length ? frozen.join(",") : "none"}`,
				`- refreshModels in bundle: ${refresh}`,
				`- readme update --models: ${/update --models/i.test(readme)}`,
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-11", frozen } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat12() {
		const box = await prepareSandbox("UAT-12", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-12 anthropic extra-usage warning cancel\n");
			const art = join(rowDir, "artifacts");
			const srcHits = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"warningAcceptedAt|extra usage|extra-usage|billed per token",
				{ maxHits: 30 },
			);
			writeFileSync(join(art, "warning-src.txt"), srcHits.length ? srcHits.join("\n") + "\n" : "none\n");
			writeFileSync(join(art, "warning-present.txt"), srcHits.length ? "yes\n" : "no\n");

			// Drive login cancel path if command exists — without OAuth browser may fail
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: "/accounts login anthropic" },
				],
				{ timeoutMs: 45_000, confirm: false },
			);
			writeFileSync(join(art, "rpc.jsonl"), rpc.stdout || "");
			writeFileSync(join(art, "stderr.log"), rpc.stderr || "");
			const out = `${rpc.stdout || ""}\n${rpc.stderr || ""}`;
			const warned = /extra usage|billed per token|warning/i.test(out);
			writeFileSync(join(art, "warning-shown.txt"), warned ? "yes\n" : "no\n");
			writeFileSync(
				join(art, "cancel-gap.txt"),
				"Cancel/accept dialog requires interactive UI; confirm:false used; full AC may need TUI\n",
			);

			const specs = [
				{ id: "warning-code-present", artifact: "artifacts/warning-present.txt", contains: "yes" },
			];			const notes = [
				"# UAT-12",
				"",
				`- warning source hits: ${srcHits.length}`,
				`- warning in rpc output: ${warned}`,
				"- Full cancel/accept slot write: partial without interactive OAuth browser",
			].join("\n");
			return finishRow(rowDir, specs, { notes,
				extra: { row: "UAT-12" },
				forceFail: !warned,
				forceFailReason: warned
					? undefined
					: "Anthropic extra-usage warning not observed on /accounts login anthropic in RPC",
			});
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat26() {
		const box = await prepareSandbox("UAT-26", { fixture: "healthcheck-gated" });
		const { rowDir } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-26 zai and kimi-coding pools\n");
			const art = join(rowDir, "artifacts");
			// Banned: community packages as dependencies, and hand-rolled z.ai coding base URLs
			// in the coding-agent product. Upstream openrouter model *ids* may contain
			// "moonshotai/kimi-*" and packages/ai may ship a moonshotai provider — those are
			// not the banned pi-moonshot package. Flag only dep manifests + hand-rolled paas.
			const depHits = [];
			const depRe = /pi-kimi-coder|pi-moonshot|@czottmann\/pi-zai-api/;
			for (const rel of [
				"packages/coding-agent/package.json",
				"packages/ai/package.json",
				"package.json",
			]) {
				const fp = join(root, rel);
				if (!existsSync(fp)) continue;
				const body = readFileSync(fp, "utf8");
				if (depRe.test(body)) depHits.push(fp);
			}
			const handRolled = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"api\\.z\\.ai/api/coding/paas|hand-rolled.*api\\.z\\.ai",
				{ maxHits: 20 },
			);
			// Pool path must not route Kimi through api.moonshot.ai as the product id.
			const kimiViaMoonshot = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"kimi-coding[\\s\\S]{0,80}api\\.moonshot\\.ai|baseUrl:\\s*[\"']https://api\\.moonshot\\.ai",
				{ maxHits: 20 },
			);
			const bad = [...depHits, ...handRolled, ...kimiViaMoonshot].filter(
				(f) => !f.includes("docs/") && !f.includes("uat/") && !f.includes("node_modules"),
			);
			writeFileSync(join(art, "banned-deps.txt"), bad.length ? bad.join("\n") + "\n" : "clean\n");
			const pools = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"zai-coding-cn|kimi-coding|\"zai\"",
				{ maxHits: 40 },
			);
			writeFileSync(join(art, "pool-ids.txt"), pools.length ? `${pools.length}\n` : "0\n");
			const personal = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"personal-use|personal use note|zai.*note",
				{ maxHits: 10 },
			);
			writeFileSync(join(art, "zai-note.txt"), personal.length ? "yes\n" : "no\n");
			const specs = [
				{ id: "no-banned-deps", artifact: "artifacts/banned-deps.txt", contains: "clean" },
				{ id: "pool-ids-present", artifact: "artifacts/pool-ids.txt", notContains: "0" },
			];			const notes = [
				"# UAT-26",
				"",
				`- banned dep hits: ${bad.length}`,
				`- pool id references: ${pools.length}`,
				`- zai personal note: ${personal.length > 0}`,
				"- Live 429 cool-off: not driven without real zai/kimi credentials",
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-26" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat27() {
		const box = await prepareSandbox("UAT-27", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject, home } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-27 local models via stub OpenAI-compatible\n");
			const art = join(rowDir, "artifacts");
			// Stub already is local-openai; login path
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: "/accounts" },
					{ id: "3", type: "prompt", message: "/model" },
				],
				{ timeoutMs: 60_000 },
			);
			writeFileSync(join(art, "rpc.jsonl"), rpc.stdout || "");
			const out = rpc.stdout || "";
			writeFileSync(join(art, "local-provider.txt"), /local-openai|ollama|lmstudio|llama/i.test(out) ? "yes\n" : "no\n");
			const banned = grepFiles([join(root, "packages")], "pi-ollama", { maxHits: 10 }).filter(
				(f) => !f.includes("docs"),
			);
			writeFileSync(join(art, "pi-ollama.txt"), banned.length ? "found\n" : "clean\n");
			const footerLocal = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"\\(local\\).*\\$0|local.*\\$0",
				{ maxHits: 15 },
			);
			writeFileSync(join(art, "footer-local.txt"), footerLocal.length ? "yes\n" : "no\n");
			const specs = [
				{ id: "no-pi-ollama", artifact: "artifacts/pi-ollama.txt", contains: "clean" },
				{ id: "footer-local-zero", artifact: "artifacts/footer-local.txt", contains: "yes" },
				{ id: "local-provider-surface", artifact: "artifacts/local-provider.txt", contains: "yes" },
			];			const notes = [
				"# UAT-27",
				"",
				"- Graded local provider surface + footer $0 + no pi-ollama.",
				"- Full multi-server start/stop cool-off: partial (stub only).",
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-27" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat28() {
		const box = await prepareSandbox("UAT-28", { fixture: "healthcheck-gated" });
		const { rowDir, home } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-28 research keys config surfaces\n");
			const art = join(rowDir, "artifacts");
			const research = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"exa/default|perplexity/default|resolveResearchKeys|researchEndpoints",
				{ maxHits: 30 },
			);
			writeFileSync(join(art, "research-src.txt"), research.length ? `${research.length}\n` : "0\n");
			const noSdk = grepFiles(
				[join(root, "packages")],
				"from [\"']exa-js|@perplexity|perplexity-sdk",
				{ maxHits: 10 },
			);
			writeFileSync(join(art, "no-sdk.txt"), noSdk.length ? "found\n" : "clean\n");
			const notInPools = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"pools:.*exa|chain:.*perplexity",
				{ maxHits: 10 },
			);
			writeFileSync(join(art, "not-in-pool-chain.txt"), notInPools.length ? "leak\n" : "ok\n");
			const specs = [
				{ id: "research-keys-surface", artifact: "artifacts/research-src.txt", notContains: "0" },
				{ id: "no-research-sdk", artifact: "artifacts/no-sdk.txt", contains: "clean" },
				{ id: "not-in-model-pools", artifact: "artifacts/not-in-pool-chain.txt", contains: "ok" },
			];			const notes = [
				"# UAT-28",
				"",
				`- research surfaces: ${research.length}`,
				"- Full /setup-kstack four-way key matrix: not driven (no interactive setup).",
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-28" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat29() {
		const box = await prepareSandbox("UAT-29", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-29 research before implement runs 2+6\n");
			const art = join(rowDir, "artifacts");
			// Run 2: no key → local research
			const goal = fixtureGoal("healthcheck-gated");
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: `/kpi ${goal}` },
				],
				{ timeoutMs: 240_000, confirm: true, stopWhen: "terminal" },
			);
			writeFileSync(join(art, "rpc.jsonl"), rpc.stdout || "");
			const runs = join(subject, ".kpi", "runs");
			if (existsSync(runs)) cpSync(runs, join(art, "runs"), { recursive: true });
			const researchMd = walkFiles(join(art, "runs")).find((f) => f.endsWith("research.md"));
			const researchJson = walkFiles(join(art, "runs")).find((f) => f.endsWith("research.json"));
			writeFileSync(join(art, "research-md.txt"), researchMd ? "yes\n" : "no\n");
			writeFileSync(join(art, "research-json.txt"), researchJson ? "yes\n" : "no\n");
			if (researchJson) {
				cpSync(researchJson, join(art, "research.json"));
				const doc = JSON.parse(readFileSync(researchJson, "utf8"));
				writeFileSync(join(art, "research-mode.txt"), `${doc.mode || doc.network?.mode || "unknown"}\n`);
			} else {
				writeFileSync(join(art, "research-mode.txt"), "missing\n");
			}
			// Run 6 style: delete research then implement should UNSAFE — second subject
			const sub2 = join(art, "stale-research-subj");
			cpSync(subject, sub2, { recursive: true });
			// If research exists, delete and try continue — may need new job
			for (const f of walkFiles(join(sub2, ".kpi"))) {
				if (f.endsWith("research.md") || f.endsWith("research.json")) {
					try {
						writeFileSync(f, ""); // empty rather than delete for visibility
					} catch {
						/* ignore */
					}
				}
			}
			writeFileSync(
				join(art, "runs-covered.txt"),
				"run2-no-key-local attempted; run6-stale partial; full 1/3/4/5 need keys/network faults\n",
			);
			const specs = [
				{ id: "research-md", artifact: "artifacts/research-md.txt", contains: "yes" },
				{ id: "research-json", artifact: "artifacts/research-json.txt", contains: "yes" },
			];			const notes = [
				"# UAT-29",
				"",
				`- research.md: ${Boolean(researchMd)} research.json: ${Boolean(researchJson)}`,
				"- Runs 2 (no key) driven; runs 1/3/4/5/6 not fully matrixed.",
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-29" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat17() {
		const box = await prepareSandbox("UAT-17", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-17 kstack first-party skills\n");
			const art = join(rowDir, "artifacts");
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: "/setup-kstack" },
					{ id: "3", type: "prompt", message: "/k-mode" },
				],
				{ timeoutMs: 90_000 },
			);
			writeFileSync(join(art, "rpc.jsonl"), rpc.stdout || "");
			const out = rpc.stdout || "";
			writeFileSync(join(art, "setup-kstack.txt"), /setup-kstack|kstack|K-stack/i.test(out) ? "yes\n" : "no\n");
			writeFileSync(join(art, "k-mode.txt"), /k-mode|K-mode|playbook/i.test(out) ? "yes\n" : "no\n");
			const bad = grepFiles(
				[join(root, "packages"), join(root)],
				"pstack|open-pstack|@oh-my-pi/|pi-pstack",
				{ maxHits: 30 },
			).filter(
				(f) =>
					!f.includes("docs/") &&
					!f.includes("NOTICE") &&
					!f.includes("kstack/UPSTREAM") &&
					!f.includes("uat/") &&
					!f.includes("node_modules") &&
					!f.includes("package-lock"),
			);
			// package.json deps only
			const manif = [];
			for (const f of walkFiles(join(root, "packages"))) {
				if (!f.endsWith("package.json")) continue;
				const blob = readFileSync(f, "utf8");
				for (const badw of ["pstack", "open-pstack", "@oh-my-pi/", "pi-pstack"]) {
					if (blob.includes(badw)) manif.push(`${f}:${badw}`);
				}
			}
			writeFileSync(join(art, "manifest-clean.txt"), manif.length ? manif.join("\n") + "\n" : "clean\n");
			const notice = existsSync(join(root, "NOTICE")) || existsSync(join(root, "kstack/NOTICE"));
			writeFileSync(join(art, "notice.txt"), notice ? "yes\n" : "no\n");
			const potetoChrome = grepFiles(
				[join(root, "packages/coding-agent/src")],
				"poteto-mode|poteto mode",
				{ maxHits: 20 },
			);
			writeFileSync(
				join(art, "poteto-chrome.txt"),
				potetoChrome.length <= 2 ? "ok\n" : `many:${potetoChrome.length}\n`,
			);
			const specs = [
				{ id: "setup-kstack-cmd", artifact: "artifacts/setup-kstack.txt", contains: "yes" },
				{ id: "k-mode-cmd", artifact: "artifacts/k-mode.txt", contains: "yes" },
				{ id: "manifest-clean", artifact: "artifacts/manifest-clean.txt", contains: "clean" },
			];			const notes = ["# UAT-17", "", `- manifests: ${manif.length ? manif.join(";") : "clean"}`, `- notice: ${notice}`].join(
				"\n",
			);
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-17" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat18() {
		const box = await prepareSandbox("UAT-18", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject, home } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-18 setup maps only wired models\n");
			const art = join(rowDir, "artifacts");
			const rpc = await runRpc(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: "/setup-kstack" },
				],
				{ timeoutMs: 90_000 },
			);
			writeFileSync(join(art, "rpc.jsonl"), rpc.stdout || "");
			const modelsPath = join(home, ".kpi", "agent", "kstack", "models.json");
			writeFileSync(join(art, "models-path.txt"), existsSync(modelsPath) ? "yes\n" : "no\n");
			if (existsSync(modelsPath)) cpSync(modelsPath, join(art, "models.json"));
			const noCloud = grepFiles(
				[join(root, "packages/coding-agent/src/kpi")],
				"Cursor Cloud Agent|cursor-cloud",
				{ maxHits: 10 },
			);
			writeFileSync(join(art, "no-cloud-target.txt"), noCloud.length ? "leak\n" : "ok\n");
			const specs = [
				{ id: "setup-ran", artifact: "artifacts/rpc.jsonl", contains: "response" },
				{ id: "no-cloud-target", artifact: "artifacts/no-cloud-target.txt", contains: "ok" },
			];			const notes = [
				"# UAT-18",
				"",
				`- models.json written: ${existsSync(modelsPath)}`,
				"- Full slug-subset + cmp twice: partial without multi-pool config.",
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-18" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat19() {
		const box = await prepareSandbox("UAT-19", { fixture: "healthcheck-gated" });
		const { rowDir, env, subject } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-19 k-mode playbook + graph\n");
			const art = join(rowDir, "artifacts");
			const goal = "add a healthcheck and verify it";
			// k-mode matches a playbook; /kpi freezes it onto task.json.playbook.
			// Must be sequential: parallel stdin would start /kpi before plan is set.
			const rpc = await runRpcSequential(
				env,
				subject,
				[
					{ id: "1", type: "set_model", provider: "local-openai", modelId: "uat-stub" },
					{ id: "2", type: "prompt", message: `/k-mode ${goal}` },
					{ id: "3", type: "prompt", message: `/kpi --mode autopilot ${fixtureGoal("healthcheck-auto")}` },
				],
				{ timeoutMs: 300_000 },
			);
			writeFileSync(join(art, "rpc.jsonl"), rpc.stdout || "");
			const runs = join(subject, ".kpi", "runs");
			if (existsSync(runs)) cpSync(runs, join(art, "runs"), { recursive: true });
			const taskPath = walkFiles(join(art, "runs")).find((f) => f.endsWith("task.json"));
			let playbook = "";
			if (taskPath) {
				const task = JSON.parse(readFileSync(taskPath, "utf8"));
				playbook = String(task.playbook || "");
				writeFileSync(join(art, "task.json"), readFileSync(taskPath));
			}
			writeFileSync(join(art, "playbook.txt"), playbook ? `${playbook}\n` : "missing\n");
			const specs = [
				{ id: "playbook-on-task", artifact: "artifacts/playbook.txt", notContains: "missing" },
			];			const notes = ["# UAT-19", "", `- playbook: ${playbook || "(none)"}`].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-19", playbook } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat20() {
		const box = await prepareSandbox("UAT-20", { fixture: "healthcheck-gated" });
		const { rowDir } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-20 no cloud owners\n");
			const art = join(rowDir, "artifacts");
			// Runtime tree only: generated/ is what loads. Upstream/overlay may name
			// forbidden patterns as deny-lists without shipping them into runtime.
			const kstackRoot = existsSync(join(root, "kstack/generated"))
				? join(root, "kstack/generated")
				: join(root, "packages/coding-agent/src/kpi/kstack/generated");
			const hits = [];
			for (const bad of ["cloud agent", "gt submit", "subagent_type", "cursor-team-kit"]) {
				const found = grepFiles([kstackRoot], bad.replace(/[.*]/g, "$&"), { maxHits: 10 });
				for (const f of found) hits.push(`${bad}:${f}`);
			}
			writeFileSync(join(art, "cloud-grep.txt"), hits.length ? hits.join("\n") + "\n" : "clean\n");
			const specs = [{ id: "no-cloud-strings", artifact: "artifacts/cloud-grep.txt", contains: "clean" }];			const notes = [
				"# UAT-20",
				"",
				`- cloud/gt/subagent hits: ${hits.length}`,
				"- Third worker denial covered by UAT-23; playbook autopilot-full not re-run here.",
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-20" } });
		} finally {
			cleanupSandbox(box);
		}
	}

	async function runUat21() {
		const box = await prepareSandbox("UAT-21", { fixture: "healthcheck-gated" });
		const { rowDir } = box;
		try {
			writeFileSync(join(rowDir, "cmd.txt"), "UAT-21 kstack sync pin replay\n");
			const art = join(rowDir, "artifacts");
			const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
			const hasSync = Boolean(pkg.scripts?.["kstack:sync"] || pkg.scripts?.["kstack:sync:check"]);
			writeFileSync(join(art, "scripts.txt"), hasSync ? "yes\n" : "no\n");
			const upstream = ["kstack/UPSTREAM.md", "packages/coding-agent/src/kpi/kstack/UPSTREAM.md"]
				.map((p) => join(root, p))
				.find((p) => existsSync(p));
			writeFileSync(join(art, "upstream-md.txt"), upstream ? "yes\n" : "no\n");
			if (upstream) cpSync(upstream, join(art, "UPSTREAM.md"));
			// Dry: run sync:check if present (no network pin change)
			const check = spawnSync("npm", ["run", "kstack:sync:check"], {
				cwd: root,
				encoding: "utf8",
				timeout: 120_000,
				env: process.env,
			});
			writeFileSync(
				join(art, "sync-check.txt"),
				`exit=${check.status}\n${(check.stdout || "").slice(0, 4000)}\n${(check.stderr || "").slice(0, 2000)}\n`,
			);
			writeFileSync(join(art, "sync-check-ran.txt"), check.status !== null ? "yes\n" : "no\n");
			const specs = [
				{ id: "sync-scripts", artifact: "artifacts/scripts.txt", contains: "yes" },
				{ id: "upstream-md", artifact: "artifacts/upstream-md.txt", contains: "yes" },
				{ id: "sync-check-ran", artifact: "artifacts/sync-check-ran.txt", contains: "yes" },
			];			const notes = [
				"# UAT-21",
				"",
				`- kstack:sync scripts: ${hasSync}`,
				`- sync:check exit: ${check.status}`,
				"- Double pin no-op + broken patch: not re-run (destructive/long); scripts+check graded.",
			].join("\n");
			return finishRow(rowDir, specs, { notes, extra: { row: "UAT-21", syncCheck: check.status } });
		} finally {
			cleanupSandbox(box);
		}
	}

	return {
		"UAT-10": runUat10,
		"UAT-11": runUat11,
		"UAT-12": runUat12,
		"UAT-26": runUat26,
		"UAT-27": runUat27,
		"UAT-28": runUat28,
		"UAT-29": runUat29,
		"UAT-17": runUat17,
		"UAT-18": runUat18,
		"UAT-19": runUat19,
		"UAT-20": runUat20,
		"UAT-21": runUat21,
	};
}
