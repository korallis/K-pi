import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelFamily, suggestForRole } from "../packages/coding-agent/src/kpi/kstack/ladder.ts";
import { readKStackModels } from "../packages/coding-agent/src/kpi/kstack/models.ts";
import {
	configureEngineeringPriors,
	readEngineeringCapabilities,
	recordEngineeringOutcome,
} from "../packages/coding-agent/src/kpi/kstack/observations.ts";
import { resolveEngineeringModel } from "../packages/coding-agent/src/kpi/kstack/routing.ts";

const model = (provider: string, id: string): Model<Api> => ({
	provider,
	id,
	name: id,
	api: "openai-completions",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4096,
});

test("explicit role preferences are filtered at dispatch and reviewers prefer independent model families", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-role-routing-"));
	try {
		const policyPath = join(directory, "models.json");
		const builder = model("anthropic", "claude-opus-fixture");
		const proxy = model("cursor", "claude-sonnet-fixture");
		const independent = model("openai-codex", "gpt-fixture");
		await writeFile(
			policyPath,
			JSON.stringify({
				version: 1,
				inherit_parent: false,
				roles: {
					implementer: ["openai/missing", "openai-codex/gpt-fixture"],
					judgment: ["cursor/claude-sonnet-fixture", "openai-codex/gpt-fixture"],
				},
			}),
		);
		const modelRuntime = { getAvailable: async () => [builder, proxy, independent] };
		const implementation = await resolveEngineeringModel({
			role: "builder",
			modelRuntime,
			parentModel: builder,
			policyPath,
		});
		assert.equal(implementation.model, independent);
		assert.ok(
			implementation.reason.some((reason) => reason.includes("openai/missing") && reason.includes("skipped")),
		);
		const review = await resolveEngineeringModel({
			role: "reviewer",
			modelRuntime,
			parentModel: builder,
			builderModel: builder,
			policyPath,
		});
		assert.equal(review.model, independent);
		assert.equal(modelFamily("cursor/claude-sonnet-fixture"), modelFamily("anthropic/claude-opus-fixture"));
		const single = await resolveEngineeringModel({
			role: "reviewer",
			modelRuntime: { getAvailable: async () => [builder, proxy] },
			parentModel: builder,
			policyPath,
		});
		assert.equal(single.model, proxy);
		assert.ok(single.reason.some((reason) => reason.includes("single-family")));
		await assert.rejects(
			resolveEngineeringModel({
				role: "builder",
				modelRuntime: { getAvailable: async () => [] },
				parentModel: builder,
				policyPath,
			}),
			/No available authenticated model/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("unknown quality retains affinity and local resources do not silently escape to cloud", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-role-affinity-"));
	try {
		const policyPath = join(directory, "missing.json");
		const local = model("ollama", "unknown-model");
		const cloud = model("openai", "gpt-fixture");
		const result = await resolveEngineeringModel({
			role: "builder",
			modelRuntime: { getAvailable: async () => [cloud, local] },
			parentModel: local,
			policyPath,
		});
		assert.equal(result.model, local);
		assert.equal(result.family, undefined);
		await assert.rejects(
			resolveEngineeringModel({
				role: "builder",
				modelRuntime: { getAvailable: async () => [cloud] },
				parentModel: local,
				policyPath,
			}),
			/No available authenticated model/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("malformed role documents are not dispatch policy and ladder exclusions execute", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-role-validation-"));
	try {
		const path = join(directory, "models.json");
		await writeFile(path, JSON.stringify({ version: 1, roles: null, inherit_parent: false }));
		assert.equal(await readKStackModels(path), undefined);
		const suggestion = suggestForRole(
			{ role: "implementer", prefer: ["glm-5.3!flash"], confidence: "unknown", why: "fixture" },
			["zai/glm-5.3-flash", "zai/glm-5.3"],
			[],
		);
		assert.equal(suggestion.chosen, "zai/glm-5.3");
		assert.equal(suggestion.nextBest, undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("fresh host evidence changes routing after reload, without outranking operator mappings or authorizing cloud", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-empirical-routing-"));
	try {
		const preferred = model("openai", "gpt-affinity-fixture");
		const measured = model("openai", "gpt-measured-fixture");
		const local = model("ollama", "unknown-local-fixture");
		const policyPath = join(directory, "models.json");
		const evidenceRef = join(directory, "host-check.txt");
		await writeFile(evidenceRef, "deterministic checker exit=0\n");
		const request = {
			role: "builder",
			projectRoot: directory,
			parentModel: preferred,
			policyPath,
			modelRuntime: { getAvailable: async () => [preferred, measured] },
		};
		assert.equal((await resolveEngineeringModel(request)).model, preferred);
		await recordEngineeringOutcome({
			projectRoot: directory,
			role: "builder",
			model: measured,
			taskId: "verified-build",
			evidenceRef,
			source: "host-verification",
			verification: "passed",
			latencyMs: 90_000,
		});
		await recordEngineeringOutcome({
			projectRoot: directory,
			role: "builder",
			model: preferred,
			taskId: "failed-build",
			evidenceRef,
			source: "host-verification",
			verification: "failed",
			latencyMs: 1,
		});
		assert.equal((await resolveEngineeringModel(request)).model, measured, "latency cannot outrank verified quality");
		const restored = await readEngineeringCapabilities({
			projectRoot: directory,
			role: "builder",
			models: [`${measured.provider}/${measured.id}`],
		});
		assert.equal(
			restored[0].outcomes[0].verification,
			"passed",
			"outcomes are read from durable storage, not routing memory",
		);
		await writeFile(
			policyPath,
			JSON.stringify({
				version: 1,
				inherit_parent: false,
				roles: { implementer: [`${preferred.provider}/${preferred.id}`] },
			}),
		);
		assert.equal(
			(await resolveEngineeringModel(request)).model,
			preferred,
			"explicit operator mapping is highest priority",
		);
		await rm(policyPath);
		assert.equal(
			(
				await resolveEngineeringModel({
					...request,
					parentModel: local,
					modelRuntime: { getAvailable: async () => [measured, local] },
				})
			).model,
			local,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("stale, inapplicable and mutated evidence stays unknown; explicit priors are not measurements", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-evidence-applicability-"));
	try {
		const parent = model("openai", "gpt-parent-fixture");
		const candidate = model("openai", "gpt-candidate-fixture");
		const evidenceRef = join(directory, "check.txt");
		await writeFile(evidenceRef, "raw check output");
		const request = {
			role: "builder",
			projectRoot: directory,
			parentModel: parent,
			policyPath: join(directory, "missing.json"),
			modelRuntime: { getAvailable: async () => [parent, candidate] },
		};
		await recordEngineeringOutcome({
			projectRoot: directory,
			role: "builder",
			model: candidate,
			taskId: "old",
			evidenceRef,
			source: "host-verification",
			verification: "passed",
			observedAt: "2000-01-01T00:00:00.000Z",
		});
		await recordEngineeringOutcome({
			projectRoot: directory,
			role: "reviewer",
			model: candidate,
			taskId: "wrong-role",
			evidenceRef,
			source: "review-verification",
			verification: "passed",
		});
		await recordEngineeringOutcome({
			projectRoot: directory,
			role: "builder",
			model: candidate,
			taskId: "other-domain",
			taskKind: "database-migration",
			evidenceRef,
			source: "host-verification",
			verification: "passed",
		});
		assert.equal((await resolveEngineeringModel(request)).model, parent);
		assert.equal((await resolveEngineeringModel({ ...request, taskKind: "database-migration" })).model, candidate);
		await writeFile(evidenceRef, "replaced output is not the recorded evidence");
		assert.equal((await resolveEngineeringModel({ ...request, taskKind: "database-migration" })).model, parent);
		await configureEngineeringPriors(directory, [
			{
				role: "builder",
				model: `${candidate.provider}/${candidate.id}`,
				quality: "preferred",
				rationale: "Operator-selected unmeasured prior",
			},
		]);
		const selected = await resolveEngineeringModel(request);
		assert.equal(selected.model, candidate);
		assert.ok(selected.reason.some((reason) => reason.includes("not a measurement")));
		const capabilities = await readEngineeringCapabilities({
			projectRoot: directory,
			role: "builder",
			models: [`${candidate.provider}/${candidate.id}`],
		});
		assert.deepEqual(capabilities[0].outcomes, []);
		await assert.rejects(
			recordEngineeringOutcome({
				projectRoot: directory,
				role: "builder",
				model: candidate,
				taskId: "invalid",
				evidenceRef,
				source: "host-verification",
				toolFailures: 2,
				toolCalls: 1,
			}),
			/Invalid engineering outcome/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("context requirements filter resources before quality and explicit reviewers cannot escape their mapping", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-routing-constraints-"));
	try {
		const parent = model("anthropic", "claude-fixture");
		const independent = model("openai", "gpt-fixture");
		independent.contextWindow = 64_000;
		const policyPath = join(directory, "models.json");
		await writeFile(
			policyPath,
			JSON.stringify({
				version: 1,
				inherit_parent: false,
				roles: { judgment: [`${parent.provider}/${parent.id}`] },
			}),
		);
		const request = {
			role: "reviewer",
			parentModel: parent,
			builderModel: parent,
			policyPath,
			modelRuntime: { getAvailable: async () => [parent, independent] },
		};
		assert.equal((await resolveEngineeringModel(request)).model, parent);
		const capacity = await resolveEngineeringModel({ ...request, role: "builder", requiredContextTokens: 40_000 });
		assert.equal(capacity.model, independent);
		assert.ok(capacity.reason.some((reason) => reason.includes("context capacity")));
		await assert.rejects(
			resolveEngineeringModel({ ...request, requiredContextTokens: 70_000 }),
			/No available authenticated model/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
