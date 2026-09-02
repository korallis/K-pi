import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectQualityGates } from "../packages/coding-agent/src/kpi/extensions/gated-loop.ts";
import { commandForGoal, refuseGoal } from "../packages/coding-agent/src/kpi/extensions/routing.ts";
import {
	readKpiSettings,
	resolveRoutingMode,
	routingState,
} from "../packages/coding-agent/src/kpi/extensions/settings.ts";

async function withDirectories(run: (project: string, agent: string) => Promise<void>): Promise<void> {
	const project = await mkdtemp(join(tmpdir(), "kpi-routing-project-"));
	const agent = await mkdtemp(join(tmpdir(), "kpi-routing-agent-"));
	try {
		delete routingState.override;
		await run(project, agent);
	} finally {
		delete routingState.override;
		await rm(project, { recursive: true, force: true });
		await rm(agent, { recursive: true, force: true });
	}
}

test("kpi.routing is read from the project and the agent directory, and the project wins", async () => {
	await withDirectories(async (project, agent) => {
		assert.equal((await readKpiSettings(project, agent)).routing, "auto", "the default is auto");
		assert.equal((await readKpiSettings(project, agent)).research, "auto", "research keeps its default");

		await writeFile(join(agent, "settings.json"), JSON.stringify({ theme: "loop-amber", kpi: { routing: "off" } }));
		assert.equal((await readKpiSettings(project, agent)).routing, "off", "the user file is honoured");

		await mkdir(join(project, ".kpi"), { recursive: true });
		await writeFile(join(project, ".kpi", "settings.json"), JSON.stringify({ routing: "always", research: "local" }));
		const settings = await readKpiSettings(project, agent);
		assert.equal(settings.routing, "always", "the project file wins");
		assert.equal(settings.research, "local");

		await writeFile(join(project, ".kpi", "settings.json"), JSON.stringify({ routing: "sometimes" }));
		assert.equal((await readKpiSettings(project, agent)).routing, "off", "an unknown project value falls through");

		routingState.override = "auto";
		assert.equal(await resolveRoutingMode(project, agent), "auto", "the session override beats every file");
		delete routingState.override;
		assert.equal(await resolveRoutingMode(project, agent), "off");
	});
});

test("quality gates come from AGENTS.md, then the package manager's own scripts, then nothing", async () => {
	await withDirectories(async (project) => {
		const none = await detectQualityGates(project);
		assert.deepEqual(none.commands, []);
		assert.equal(none.source, "none");
		assert.match(none.reason, /no AGENTS\.md Quality gates block/u);

		await writeFile(
			join(project, "package.json"),
			JSON.stringify({ name: "fixture", scripts: { test: "node --test", check: "biome check .", build: "tsc" } }),
		);
		await writeFile(join(project, "package-lock.json"), "{}\n");
		const npm = await detectQualityGates(project);
		assert.deepEqual(npm.commands, ["npm test", "npm run check"], "only scripts that exist, under npm");
		assert.equal(npm.source, "package-scripts");

		await writeFile(
			join(project, "package.json"),
			JSON.stringify({
				name: "fixture",
				packageManager: "pnpm@9.1.0",
				scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit", check: "unused" },
			}),
		);
		const pnpm = await detectQualityGates(project);
		assert.deepEqual(pnpm.commands, ["pnpm test", "pnpm run lint", "pnpm run typecheck"], "packageManager wins");

		await writeFile(
			join(project, "package.json"),
			JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }),
		);
		await writeFile(join(project, "bun.lock"), "");
		assert.deepEqual((await detectQualityGates(project)).commands, ["bun run test"], "a lockfile names the manager");

		await writeFile(
			join(project, "AGENTS.md"),
			"# Rules\n\n## Quality gates\n\n```bash\n$ npm run verify\n# comment\nnpm run e2e\n```\n",
		);
		const agents = await detectQualityGates(project);
		assert.deepEqual(agents.commands, ["npm run verify", "npm run e2e"], "the operator's block wins");
		assert.equal(agents.source, "agents-md");
	});
});

test("goals are refused when they are greetings, questions, or too short, and are always one line", () => {
	for (const goal of ["hi", "apply", "ok thanks", "Hello there, how are you today?", "why does the build fail?"]) {
		assert.ok(refuseGoal(goal) !== undefined, `${JSON.stringify(goal)} is refused`);
	}
	for (const goal of ["add a healthcheck endpoint with a test", "fix the flaky retry test in packages/ai"]) {
		assert.equal(refuseGoal(goal), undefined, `${JSON.stringify(goal)} may be a job`);
	}
	assert.equal(commandForGoal("  add a\n\tfeature   now ", "autopilot"), "/kpi --mode autopilot add a feature now");
});
