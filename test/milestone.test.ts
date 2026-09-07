import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "../packages/coding-agent/src/core/extensions/types.ts";
import { AccountBalancer } from "../packages/coding-agent/src/kpi/extensions/accounts/balancer.ts";
import {
	classifyProviderBodyFailure,
	classifyProviderFailure,
	DEFAULT_COOLDOWN_MS,
} from "../packages/coding-agent/src/kpi/extensions/accounts/errors.ts";
import {
	type AccountsDocument,
	DEFAULT_FALLBACK_CHAIN,
} from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";
import { UsageCache } from "../packages/coding-agent/src/kpi/extensions/accounts/usage/cache.ts";
import { renderAccountsWidget } from "../packages/coding-agent/src/kpi/extensions/accounts/widget.ts";
import { appendEvent } from "../packages/coding-agent/src/kpi/extensions/append-log.ts";
import { WorkerProtocol } from "../packages/coding-agent/src/kpi/extensions/bus/protocol.ts";
import {
	BackgroundBus,
	createWorkerAdmission,
	type WorkerLauncher,
} from "../packages/coding-agent/src/kpi/extensions/bus/spawn.ts";
import { assertMinimalistBounds } from "../packages/coding-agent/src/kpi/extensions/minimalist.ts";
import { registerPrintProfile } from "../packages/coding-agent/src/kpi/extensions/print-profile.ts";
import { formatEventEntry } from "../packages/coding-agent/src/kpi/extensions/renderers.ts";
import { exaSearch } from "../packages/coding-agent/src/kpi/extensions/research/exa.ts";
import { conductResearch } from "../packages/coding-agent/src/kpi/extensions/research/gate.ts";
import { createJob, type Task } from "../packages/coding-agent/src/kpi/extensions/run-store.ts";
import {
	assertClaimInModule,
	assertDuneStack,
	type DuneStack,
	moduleOwnsPath,
	scaffoldModule,
} from "../packages/coding-agent/src/kpi/extensions/stack.ts";
import { parseModelLadder } from "../packages/coding-agent/src/kpi/kstack/ladder.ts";
import { assertShipApproved, createKModePlan } from "../packages/coding-agent/src/kpi/kstack/mode.ts";
import {
	assertKnownModels,
	INHERIT_PARENT,
	planModels,
	planToDocument,
} from "../packages/coding-agent/src/kpi/kstack/models.ts";

const accounts: AccountsDocument = {
	version: 1,
	pools: {
		anthropic: {
			strategy: "round-robin",
			slots: [
				{ id: "A", label: "personal", kind: "oauth" },
				{ id: "B", label: "work", kind: "oauth" },
			],
		},
	},
	fallback: [...DEFAULT_FALLBACK_CHAIN],
	stickiness: "session-until-exhausted",
};

test("429 usage limit classifies to the default cooldown", () => {
	const now = 1_000;
	assert.deepEqual(classifyProviderFailure({ status: 429 }, now), {
		kind: "cooldown",
		until: now + DEFAULT_COOLDOWN_MS,
		reason: "provider response 429",
	});
	assert.equal(
		classifyProviderFailure({ status: 403, headers: { "x-error": "quota exhausted" } }, now)?.kind,
		"cooldown",
	);

	// Body tokens are only available to a fetch client that owns the body.
	assert.equal(classifyProviderBodyFailure({ status: 403, body: "permission denied" }, now), undefined);
	assert.equal(classifyProviderBodyFailure({ status: 403, body: "quota exhausted" }, now)?.kind, "cooldown");
	assert.equal(classifyProviderBodyFailure({ status: 400, body: "out of extra usage" }, now)?.kind, "cooldown");
	assert.equal(classifyProviderBodyFailure({ status: 400, body: "invalid request" }, now), undefined);
	assert.equal(classifyProviderBodyFailure({ status: 429, body: "usage limit" }, now)?.kind, "cooldown");
});

test("a cooling sibling is never selected while B is healthy", () => {
	const balancer = new AccountBalancer(() => 10);
	balancer.markCooling("anthropic", "A", 100);
	for (let index = 0; index < 100; index += 1) {
		assert.equal(balancer.select("anthropic", accounts)?.slot.id, "B");
	}
});

test("failover appends the accounts.failover event type", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-failover-event-"));
	const path = join(directory, "events.jsonl");
	try {
		await appendEvent(path, {
			ts: new Date(0).toISOString(),
			type: "accounts.failover",
			job_id: "job",
			round: 1,
			node: "accounts",
			from: "anthropic/A",
			to: "anthropic/B",
		});
		const event = JSON.parse(await readFile(path, "utf8")) as { type: string };
		assert.equal(event.type, "accounts.failover");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("event verdict rendering remains concise", () => {
	const rendered = formatEventEntry("loop.terminal", {
		ts: new Date(0).toISOString(),
		type: "loop.terminal",
		job_id: "job",
		round: 1,
		node: "review",
		status: "STOPPED",
		prev_hash: "0".repeat(64),
		record_hash: "1".repeat(64),
	});
	assert.ok(rendered.length < 800);
});

test("accounts widget labels each slot percentage", () => {
	const usage = new UsageCache({ now: () => 0 });
	usage.recordHeaders("anthropic", "A", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "40" });
	usage.recordHeaders("anthropic", "B", { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "80" });

	const widget = renderAccountsWidget(accounts, { usage, now: 0 });

	assert.match(widget, /personal 40%/u);
	assert.match(widget, /work 80%/u);
	assert.doesNotMatch(widget, /^\s*\d+%\s*$/mu);
});

test("K-mode feature comes from the generated runtime and ship needs approval", async () => {
	// The registry is the generated tree, so this reads what the sync emitted
	// rather than a table in k-pi source.
	const plan = await createKModePlan("add a healthcheck");
	assert.equal(plan.playbook, "feature");
	assert.equal(plan.steps[0].node, "specify");
	assert.ok(plan.todos[0].startsWith("specify:"));
	const directory = await mkdtemp(join(tmpdir(), "kpi-verdict-"));
	try {
		await writeFile(join(directory, "verdict.json"), JSON.stringify({ approved: false }));
		await assert.rejects(assertShipApproved(directory), /blocked/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("K-stack setup never writes a slug outside the live candidates", () => {
	const ladder = parseModelLadder(`
| Role | Prefer, in order | Why | Confidence |
|---|---|---|---|
| implementer | \`sol\` | workhorse | Medium |
| frontend | \`k3\` | design | Medium-high |
| judgment | \`opus\` | taste | Medium |
| precise | \`sol\` | contracts | Medium |
| fast | \`luna\` | cheap | Medium |
| review_panel | \`opus\`, \`sol\` | cross-family | Medium |

1. GPT-5.6 Sol — workhorse
2. Claude Opus 5 — judgment
`);
	const candidates = ["anthropic/opus", "xai/sol"];
	const document = planToDocument(planModels(ladder, candidates));
	assert.doesNotThrow(() => assertKnownModels(document, candidates));
	// A role the ladder cannot fill inherits the parent rather than inventing one.
	assert.equal(document.roles.frontend, INHERIT_PARENT);
	document.roles.fast = "unknown/model";
	assert.throws(() => assertKnownModels(document, candidates), /Unknown model slug/u);
});

test("worker admission preserves one writer and exclusive paths within configured capacity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-bus-"));
	const job = await createJob(directory, {
		job_id: "job",
		mode: "gated",
		goal: "Update src/a.ts",
		nongoals: [],
		acceptance: [
			{ id: "AC-scope", statement: "Scoped source edit", required: true, bounds: { write_allow: ["src/**"] } },
		],
		constraints: [],
		quality_gates: [],
		ac: { quality: "partial" },
		current_module_id: "slice",
	});
	const runDirectory = job.directory;
	await writeFile(
		join(runDirectory, "stack.json"),
		JSON.stringify({
			version: 1,
			shape: "dune",
			root: "src",
			delivery: "vertical",
			current_module_id: "slice",
			modules: [
				{
					id: "slice",
					purpose: "Scoped source edit",
					folder: "src",
					interface: "src/a.ts",
					allowed_paths: ["src/**"],
					depends_on: [],
				},
			],
		}),
	);
	const alive = new Set<number>();
	let pid = 1;
	// A peer that accepts everything, so this scenario stays about caps and
	// leases. The protocol itself is exercised in test/bus.test.ts.
	const launcher: WorkerLauncher = async (request) => {
		const workerPid = pid++;
		alive.add(workerPid);
		const toWorker = new PassThrough();
		const toParent = new PassThrough();
		toWorker.on("data", (chunk: Buffer) => {
			for (const line of chunk
				.toString("utf8")
				.split("\n")
				.filter((entry) => entry.length > 0)) {
				const record = JSON.parse(line) as { id: string; type: string };
				toParent.write(
					`${JSON.stringify({ id: record.id, type: "response", command: record.type, success: true })}\n`,
				);
			}
		});
		const protocol = new WorkerProtocol({ stdin: toWorker, stdout: toParent });
		return {
			pid: workerPid,
			argv: [request.sessionPath],
			protocol,
			isAlive: () => alive.has(workerPid),
			stop: async () => {
				alive.delete(workerPid);
				protocol.close();
				toWorker.destroy();
				toParent.destroy();
			},
		};
	};
	const bus = new BackgroundBus(directory, runDirectory, "job", {
		launcher,
		isProcessAlive: (candidate) => alive.has(candidate),
		admission: createWorkerAdmission({ maxWorkers: 3 }),
		contractWaitTimeoutMs: 2_000,
	});
	try {
		const writer = await bus.spawn({ role: "implementer", prompt: "one", tools: ["read", "write"] });
		await assert.rejects(bus.spawn({ role: "implementer", prompt: "two", tools: ["edit"] }), /writer/u);
		const reviewer = await bus.spawn({ role: "reviewer", prompt: "review" });
		await bus.spawn({ role: "tester", prompt: "third" });
		await assert.rejects(bus.spawn({ role: "reviewer", prompt: "overflow" }));
		await bus.claim(writer.agentId, writer.pid, "src/a.ts");
		await assert.rejects(bus.claim(reviewer.agentId, reviewer.pid, "src/a.ts"));
		assert.equal((await bus.readLeases())["src/a.ts"].agent_id, writer.agentId);
		await bus.stop(writer.agentId);
		await assert.rejects(bus.claim(reviewer.agentId, reviewer.pid, "src/a.ts"));
		const successor = await bus.spawn({ role: "implementer", prompt: "continue", tools: ["read", "write"] });
		await bus.claim(successor.agentId, successor.pid, "src/a.ts");
		assert.equal((await bus.readLeases())["src/a.ts"].agent_id, successor.agentId);
	} finally {
		await bus.stopAll();
		await rm(directory, { recursive: true, force: true });
	}
});

test("minimalist bounds rejects a missing ladder and undeclared dependency", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-min-"));
	const run = join(directory, "run");
	try {
		await mkdir(run, { recursive: true });
		await writeFile(join(run, "candidate.json"), JSON.stringify({ summary: "x" }));
		await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { surprise: "1" } }));
		const task = { dependency_baseline: [], runtime_dependencies: [], acceptance: [] } as unknown as Task;
		await assert.rejects(assertMinimalistBounds(directory, run, task, []), /ladder/u);
		await writeFile(
			join(run, "candidate.json"),
			JSON.stringify({
				ladder: "one-liner",
				used: "inline expression",
				skipped: "helper module",
			}),
		);
		await assert.rejects(assertMinimalistBounds(directory, run, task, []), /surprise/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("research caps results and falls back after a preferred 429", async () => {
	let calls = 0;
	const fetchMock: typeof fetch = async (input) => {
		calls += 1;
		if (String(input).includes("exa.ai")) return new Response("{}", { status: 429 });
		return new Response(
			JSON.stringify({
				results: [
					{ title: "A", url: "https://a", snippet: "one" },
					{ title: "B", url: "https://b", snippet: "two" },
				],
			}),
			{ status: 200 },
		);
	};
	const capped = await exaSearch("q", "key", {
		numResults: 99,
		fetch: async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { numResults: number };
			assert.equal(body.numResults, 10);
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		},
	});
	assert.deepEqual(capped, []);
	const directory = await mkdtemp(join(tmpdir(), "kpi-research-"));
	try {
		const task = { job_id: "research-job", goal: "current docs" } as Task;
		const document = await conductResearch(directory, directory, task, {
			keys: { exa: "x", perplexity: "p" },
			mode: "auto",
			fetch: fetchMock,
		});
		assert.equal(document.mode, "perplexity", "the cooled preferred service handed over to the alternate");
		assert.equal(document.sources.length, 2);
		assert.deepEqual(
			document.network.failures.map((failure) => `${failure.service}:${failure.class}`),
			["exa:http_429"],
			"the 429 is recorded once, against the service that returned it",
		);
		assert.equal(document.network.state, "online", "one service answering is not exhaustion");
		assert.equal(calls, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Dune stack preserves explicit outside-module claim boundaries", async () => {
	const stack: DuneStack = {
		version: 1,
		shape: "dune",
		delivery: "vertical",
		root: "src",
		scaffold_first: true,
		modules: [
			{
				id: "auth",
				purpose: "login and sessions",
				folder: "src/auth",
				interface: "src/auth/api.ts",
				allowed_paths: ["src/auth/**", "test/auth/**"],
				depends_on: [],
			},
		],
	};
	assert.doesNotThrow(() => assertDuneStack(stack));
	// The claim boundary is asynchronous now: it resolves links before deciding.
	await assert.rejects(assertClaimInModule("/repo", "src/billing/a.ts", stack.modules[0]), /UNSAFE/u);
	stack.modules[0] = {
		...stack.modules[0],
		id: "helpers",
		folder: "src/helpers",
		interface: "src/helpers/index.ts",
		allowed_paths: ["src/helpers/**", "test/helpers/**"],
		purpose: "misc",
	};
	assert.equal(moduleOwnsPath("/repo", stack.modules[0], "src/auth/a.ts"), false);
});
test("Dune scaffold does not invent source or empty tests", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-dune-"));
	try {
		const result = await scaffoldModule(directory, {
			id: "auth",
			purpose: "login and sessions",
			folder: "src/auth",
			interface: "src/auth/api.ts",
			allowed_paths: ["src/auth/**", "test/auth/**"],
			depends_on: [],
		});
		await assert.rejects(readFile(result.interface, "utf8"), { code: "ENOENT" });
		await assert.rejects(readFile(join(directory, "test/auth/index.test.ts"), "utf8"), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("print mode removes mutation tools", () => {
	let start: ((event: unknown, context: ExtensionCommandContext) => void) | undefined;
	let active = ["read", "write", "edit", "grep"];
	registerPrintProfile({
		on(_event: string, handler: typeof start) {
			start = handler;
		},
		getActiveTools() {
			return active;
		},
		setActiveTools(tools: string[]) {
			active = tools;
		},
	} as unknown as ExtensionAPI);
	start?.({}, { mode: "print" } as ExtensionCommandContext);
	assert.deepEqual(active, ["read", "grep"]);
});

test("repository manifests exclude prohibited harness, footer, agent-bus, and research dependencies", async () => {
	// Inventory repository-owned manifests, including new files, not installed packages or proof artifacts.
	const { stdout } = await promisify(execFile)("git", [
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		"package.json",
		"**/package.json",
	]);
	const manifests = [...new Set(stdout.split("\0").filter(Boolean))].sort();
	assert.ok(manifests.includes("package.json"));
	assert.ok(manifests.includes("packages/coding-agent/package.json"));
	const forbiddenEverywhere: Record<string, true> = {
		"oh-my-pi": true,
		atomic: true,
		"pi-graph": true,
		"pi-multi-account": true,
		"pi-multi-pass": true,
		"pi-intercom": true,
		"pi-mesh": true,
		"pi-agents-talk-to-each-other": true,
		"pi-bus": true,
		"pi-side-agents": true,
	};
	const forbiddenAtRuntime: Record<string, true> = {
		...forbiddenEverywhere,
		"@shying/pi-graph": true,
		"@pi-stef/cursor": true,
		pstack: true,
		"open-pstack": true,
		"pi-pstack": true,
		"pi-status-bar": true,
		"pi-vitals": true,
		"pi-powerline-footer": true,
		"pi-kimi-coder": true,
		"pi-moonshot": true,
		"@czottmann/pi-zai-api": true,
		"pi-ollama": true,
		"@jamesjfoong/pi-ollama": true,
		"pi-ollama-keyring": true,
		"pi-ollama-cloud-provider": true,
		"exa-js": true,
		"@perplexity-ai/perplexity_ai": true,
		"@mendable/firecrawl-js": true,
	};
	const violations: string[] = [];
	for (const manifest of manifests) {
		const document = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
		for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
			const dependencies = (document[section] ?? {}) as Record<string, string>;
			for (const [name, specifier] of Object.entries(dependencies)) {
				// npm aliases cannot hide a prohibited package behind an innocent dependency key.
				const alias = specifier.startsWith("npm:") ? specifier.slice(4).replace(/@[^@/]*$/u, "") : undefined;
				for (const target of alias === undefined ? [name] : [name, alias]) {
					const runtime = section !== "devDependencies";
					if (
						forbiddenEverywhere[target] === true ||
						target.startsWith("pi-cursor-") ||
						(runtime && (forbiddenAtRuntime[target] === true || target.startsWith("@oh-my-pi/")))
					) {
						violations.push(`${manifest}: ${section}.${name} (${target})`);
					}
				}
			}
		}
		for (const section of ["bundledDependencies", "bundleDependencies"]) {
			const bundled = document[section];
			if (!Array.isArray(bundled)) continue;
			for (const name of bundled as string[]) {
				if (forbiddenAtRuntime[name] === true || name.startsWith("pi-cursor-") || name.startsWith("@oh-my-pi/")) {
					violations.push(`${manifest}: ${section}.${name}`);
				}
			}
		}
	}
	assert.deepEqual(violations, [], "repository manifest dependency contracts");
});
