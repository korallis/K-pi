import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getKpiResourceDir } from "../packages/coding-agent/src/config.ts";
import { parseFrontmatter } from "../packages/coding-agent/src/kpi/kstack/frontmatter.ts";
import {
	LADDER_FILE,
	LadderError,
	ladderCandidates,
	PANEL_CAP,
	parseModelLadder,
	REQUIRED_ROLES,
	readModelLadder,
	suggestForRole,
	suggestPanel,
} from "../packages/coding-agent/src/kpi/kstack/ladder.ts";
import {
	createKModePlan,
	FALLBACK_PLAYBOOK,
	generatedSkillsDirectory,
	loadPlaybooks,
	matchPlaybook,
	PLAYBOOK_NODES,
	PlaybookError,
	parsePlaybook,
	renderTodos,
} from "../packages/coding-agent/src/kpi/kstack/mode.ts";
import {
	assertKnownModels,
	editPlan,
	HEALTHY_POOLS,
	INHERIT_PARENT,
	liveCandidates,
	planModels,
	planToDocument,
	readKStackModels,
	renderPlan,
	resolvePanel,
	resolveRoleModel,
	writeKStackModels,
} from "../packages/coding-agent/src/kpi/kstack/models.ts";
import {
	KStackTransformError,
	matchesGlob,
	type OverlayConfig,
	renamePath,
	renameToken,
	supportLinks,
	validateGeneratedTree,
} from "../packages/coding-agent/src/kpi/kstack/overlay/transforms.ts";
import {
	buildGeneratedTree,
	readOverlayConfig,
	textOf,
} from "../packages/coding-agent/src/kpi/kstack/scripts/sync-kstack.ts";
import { readTree } from "../packages/coding-agent/src/kpi/kstack/scripts/tree.ts";

const KSTACK_ROOT = new URL("../packages/coding-agent/src/kpi/kstack/", import.meta.url).pathname;
const GENERATED = join(KSTACK_ROOT, "generated");
const OVERLAY = join(KSTACK_ROOT, "overlay");
const UPSTREAM = join(KSTACK_ROOT, "upstream");

/**
 * A text view of the generated tree.
 *
 * RP-17 made the pipeline byte- and mode-faithful, so the tree is bytes now.
 * These assertions are all about text, and a binary asset has nothing to say
 * about frontmatter or residue, so they read the text view.
 */
async function generatedFiles(): Promise<Map<string, string>> {
	return textOf(await readTree(GENERATED));
}

/** Every path, including the binary ones the text view leaves out. */
async function generatedPaths(): Promise<string[]> {
	return [...(await readTree(GENERATED)).keys()].sort();
}

// ---------------------------------------------------------------------------
// One loadable runtime
// ---------------------------------------------------------------------------

test("the generated tree is skills plus required attribution, and nothing else", async () => {
	const tree = await generatedFiles();
	assert.ok(tree.size > 0, "the generated runtime is not empty");
	for (const path of await generatedPaths()) {
		assert.ok(
			path.startsWith("skills/") || path === "LICENSE" || path === "NOTICE",
			`generated carries only the loadable runtime and its attribution: ${path}`,
		);
	}
	// The MIT licence text and its copyright holder must survive intact.
	const license = tree.get("LICENSE");
	assert.ok(license !== undefined, "the upstream MIT licence ships");
	assert.match(license, /MIT License/u);
	assert.match(license, /Copyright \(c\) \d{4}/u);
	assert.match(license, /WITHOUT WARRANTY OF ANY KIND/u);

	// Attribution also lives beside the tree, as the licence obligation requires.
	const notice = await readFile(join(KSTACK_ROOT, "NOTICE"), "utf8");
	assert.match(notice, /MIT/u);
	const upstreamDocument = await readFile(join(KSTACK_ROOT, "UPSTREAM.md"), "utf8");
	assert.match(upstreamDocument, /\| Commit \| [0-9a-f]{40} \|/u);
});

test("the runtime is the only K-stack skill root Pi is told to load", async () => {
	const resource = getKpiResourceDir();
	const declared = generatedSkillsDirectory(resource);
	assert.equal(declared, join(resource, "kstack", "generated", "skills"));
	// Neither build input is a skill root.
	for (const input of [OVERLAY, UPSTREAM]) {
		assert.notEqual(input, declared);
	}
});

test("no first-party K-stack truth is left standing beside the generated tree", async () => {
	for (const orphan of ["playbooks", "principles.md", "k-agent.md"]) {
		assert.equal(
			await stat(join(KSTACK_ROOT, orphan)).catch(() => undefined),
			undefined,
			`${orphan} must live in overlay/source, not beside generated/`,
		);
	}
	// And the overlay owns them instead.
	const overlaySource = textOf(await readTree(join(OVERLAY, "source")));
	for (const required of ["skills/k-stack-principles/SKILL.md", "skills/k-agent/SKILL.md"]) {
		assert.ok(overlaySource.has(required), `overlay owns ${required}`);
	}
});

// ---------------------------------------------------------------------------
// Frontmatter, identity, support files
// ---------------------------------------------------------------------------

test("every shipped skill has valid, unique, parent-aligned frontmatter", async () => {
	const tree = await generatedFiles();
	const names = new Map<string, string>();
	let skills = 0;
	for (const [path, source] of tree) {
		if (!path.endsWith("SKILL.md")) {
			continue;
		}
		skills += 1;
		const parsed = parseFrontmatter(source);
		assert.ok(parsed !== undefined, `${path} has parseable frontmatter`);
		const name = parsed.fields.name;
		const description = parsed.fields.description;
		assert.ok(name !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name), `${path} name is kebab-case: ${name}`);
		assert.ok(name.length <= 64, `${path} name is within Pi's ceiling`);
		assert.equal(path.split("/").at(-2), name, `${path} name matches its parent directory`);
		assert.ok(
			description !== undefined && description.trim().length > 0 && description.length <= 1024,
			`${path} has a usable description`,
		);
		assert.equal(names.get(name), undefined, `${name} is declared once`);
		names.set(name, path);
	}
	assert.ok(skills >= 40, `the runtime still carries the upstream pack (${skills} skills)`);
});

test("every support file a shipped skill references is reachable", async () => {
	const tree = await generatedFiles();
	const config = await readOverlayConfig(OVERLAY);
	const diagnostics = validateGeneratedTree(tree, config);
	assert.deepEqual(
		diagnostics.filter((entry) => entry.rule === "support-link"),
		[],
	);
});

test("the whole generated tree passes its own validator", async () => {
	const tree = await generatedFiles();
	const config = await readOverlayConfig(OVERLAY);
	assert.deepEqual(validateGeneratedTree(tree, config), []);
});

// ---------------------------------------------------------------------------
// Residue
// ---------------------------------------------------------------------------

test("no forbidden residue survives in the loaded roots", async () => {
	const tree = await generatedFiles();
	const body = [...tree]
		.filter(([path]) => path !== "LICENSE" && path !== "NOTICE")
		.map(([, source]) => source)
		.join("\n")
		.toLowerCase();

	for (const phrase of [
		"make-bot-ui",
		"benny",
		"bugbot",
		"cursor cloud",
		"cloud agent",
		"background agent",
		"cloud worker",
		"graphite",
		"gt submit",
		"cursor-team-kit",
		"control-cli",
		"control-ui",
		"subagent",
		"subagent_type",
		"run_in_background",
		".cursor/rules",
		"worktree",
		"/loop",
		"create-skill",
	]) {
		assert.ok(!body.includes(phrase), `forbidden residue survived: ${phrase}`);
	}
	// Hard model slugs are never required defaults.
	for (const slug of [
		"claude-fable-5",
		"claude-opus-5",
		"gpt-5.6-sol",
		"grok-4.6",
		"glm-5.3",
		"kimi-k3",
		"composer-",
	]) {
		assert.ok(!body.includes(slug), `hard model slug survived: ${slug}`);
	}
	// A bare Task operator is an unmapped Cursor contract.
	assert.equal(/(?<![\w-])Task(?![\w-])/u.test([...tree.values()].join("\n")), false, "Task operator survived");
});

test("no personal name or workstation path survives outside required attribution", async () => {
	const tree = await generatedFiles();
	for (const [path, source] of tree) {
		if (path === "LICENSE" || path === "NOTICE") {
			continue;
		}
		assert.equal(
			/lee ?barry|ray ?fernando|lauren tan|(?<![\w-])poteto(?![\w-])/iu.test(source),
			false,
			`personal name survived in ${path}`,
		);
		assert.equal(
			/(?<![\w.-])(?:\/Users\/|\/home\/[a-z]|~\/Projects|[A-Z]:\\Users\\)/u.test(source),
			false,
			`workstation path survived in ${path}`,
		);
	}
	// The licence keeps its author: attribution is the obligation, not residue.
	assert.match(tree.get("LICENSE") ?? "", /Copyright \(c\) \d{4} \S/u);
});

test("no personal engineering playbook or personal agent guidance ships", async () => {
	const tree = await generatedFiles();
	// A per-operator "<name>-mode" authoring skill is personal guidance, not a
	// product-owned instruction.
	assert.equal(tree.has("skills/automate-me/SKILL.md"), false);
	for (const [path, source] of tree) {
		if (path === "LICENSE" || path === "NOTICE") {
			continue;
		}
		assert.equal(
			/turning the user's working conventions into a skill/iu.test(source),
			false,
			`personal-style authoring guidance survived in ${path}`,
		);
	}
	const directories = (await readdir(join(GENERATED, "skills"), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	for (const name of directories) {
		assert.equal(/^(?!k-mode$)[a-z]+-mode$/u.test(name), false, `a personal mode skill must not ship: ${name}`);
	}
});

test("ordinary words containing pstack substrings stay intact", () => {
	const source = [
		"upstack and downstack are ordinary words",
		"the pstack plugin is upstream",
		"setup-pstack is the upstream command",
		"open-pstack and pi-pstack are reference forks",
	].join("\n");
	const renamed = [
		{ from: "setup-pstack", to: "setup-kstack" },
		{ from: "pstack", to: "K-stack", boundary: "left" as const },
	].reduce((value, rename) => renameToken(value, rename), source);

	assert.match(renamed, /upstack and downstack are ordinary words/u);
	assert.match(renamed, /the K-stack plugin is upstream/u);
	assert.match(renamed, /setup-kstack is the upstream command/u);
	assert.match(renamed, /open-pstack and pi-pstack are reference forks/u);
	assert.equal(renamed.includes("upK-stack"), false, "a containing word was corrupted");
});

test("path renames move whole segments and stems, never substrings", () => {
	const renames = [
		{ from: "setup-pstack", to: "setup-kstack" },
		{ from: "poteto-mode", to: "k-mode" },
	];
	assert.equal(renamePath("skills/setup-pstack/SKILL.md", renames), "skills/setup-kstack/SKILL.md");
	assert.equal(renamePath("skills/poteto-mode/playbooks/feature.md", renames), "skills/k-mode/playbooks/feature.md");
	assert.equal(renamePath("docs/setup-pstack.md", renames), "docs/setup-kstack.md");
	assert.equal(renamePath("skills/my-setup-pstack-notes/SKILL.md", renames), "skills/my-setup-pstack-notes/SKILL.md");
});

test("a glob matches path shapes and not neighbouring names", () => {
	assert.equal(matchesGlob("skills/make-bot-ui/SKILL.md", "skills/make-bot-ui/**"), true);
	assert.equal(matchesGlob("skills/make-bot-ui-extra/SKILL.md", "skills/make-bot-ui/**"), false);
	assert.equal(matchesGlob("skills/k-mode/playbooks/a/b.md", "skills/k-mode/playbooks/**"), true);
	assert.equal(matchesGlob("README.md", "README.md"), true);
	assert.equal(matchesGlob("docs/guide/01.md", "docs/**"), true);
});

// ---------------------------------------------------------------------------
// The offline residue fixture
// ---------------------------------------------------------------------------

/** Every documented invalid shape, in one tree, with nothing else in it. */
function residueFixture(): Map<string, { bytes: Buffer; executable: boolean }> {
	const entries = new Map<string, string>([
		["skills/make-bot-ui/SKILL.md", "---\nname: make-bot-ui\ndescription: webhook bot\n---\nbody\n"],
		["automations/benny/README.md", "Benny pack\n"],
		["skills/automate-me/SKILL.md", "---\nname: automate-me\ndescription: personal mode\n---\nbody\n"],
		["skills/k-mode/playbooks/orchestrate.md", "cloud root coordinator\n"],
		["skills/k-mode/references/bugbot-triage.md", "bot triage\n"],
		["skills/k-mode/scripts/orch/store.ts", "// graphite stack store\n"],
		["skills/worktree-cleanup/SKILL.md", "---\nname: worktree-cleanup\ndescription: prune\n---\nbody\n"],
		["docs/guide/01-setup.md", "read ~/.cursor/rules/pstack-models.mdc\n"],
		["README.md", "poteto wrote this\n"],
		[".cursor-plugin/plugin.json", '{ "author": { "name": "Lauren Tan" } }\n'],
		["agents/poteto-agent.md", "# Poteto agent\n"],
		[
			"skills/keeper/SKILL.md",
			[
				"---",
				"name: keeper",
				"description: a skill that survives with its operators translated",
				"---",
				"",
				"Launch reviewers with the Task tool and set subagent_type per reviewer.",
				"Set run_in_background and read the Task response.",
				"Defaults `claude-fable-5-thinking-max`, `gpt-5.6-sol-max`.",
				"Each worker gets its own worktree or branch.",
				"Models live in `~/.cursor/rules/kstack-models.mdc`.",
				"An upstack helper is an ordinary word.",
				"",
			].join("\n"),
		],
	]);
	return new Map([...entries].map(([path, text]) => [path, { bytes: Buffer.from(text, "utf8"), executable: false }]));
}

test("the residue fixture is either transformed correctly or refused with a location", async () => {
	const config = await readOverlayConfig(OVERLAY);
	const built = await buildGeneratedTree(residueFixture(), new Map(), config);

	// Every documented drop path is gone, each with a recorded reason.
	for (const dropped of [
		"skills/make-bot-ui/SKILL.md",
		"automations/benny/README.md",
		"skills/automate-me/SKILL.md",
		"skills/k-mode/playbooks/orchestrate.md",
		"skills/k-mode/references/bugbot-triage.md",
		"skills/k-mode/scripts/orch/store.ts",
		"skills/worktree-cleanup/SKILL.md",
		"docs/guide/01-setup.md",
		"README.md",
		".cursor-plugin/plugin.json",
		"agents/poteto-agent.md",
	]) {
		assert.equal(built.files.has(dropped), false, `${dropped} must not ship`);
		assert.ok(
			built.dropped.some((entry) => entry.source === dropped && entry.reason.length > 0),
			`${dropped} was dropped with a reason naming its upstream path`,
		);
	}

	// The survivor kept its meaning and lost every Cursor contract.
	const keeper = built.files.get("skills/keeper/SKILL.md")?.bytes.toString("utf8");
	assert.ok(keeper !== undefined);
	assert.match(keeper, /spawn_background tool/u);
	assert.match(keeper, /role per reviewer/u);
	assert.match(keeper, /spawn_background and read the worker contract file/u);
	assert.match(keeper, /~\/\.kpi\/agent\/kstack\/models\.json/u);
	assert.match(keeper, /its own branch/u);
	assert.match(keeper, /An upstack helper is an ordinary word/u);
	assert.equal(/claude-fable-5|gpt-5\.6-sol/u.test(keeper), false, "a hard slug survived");
	assert.equal(/subagent|worktree|\.cursor\/rules/u.test(keeper), false, "a forbidden contract survived");
});

test("an unknown Cursor operator fails closed with a located diagnostic", async () => {
	const config = await readOverlayConfig(OVERLAY);
	const fixture = new Map([
		[
			"skills/unknown/SKILL.md",
			{
				bytes: Buffer.from(
					[
						"---",
						"name: unknown",
						"description: uses an unmapped operator",
						"---",
						"",
						"Wake the Cursor Cloud agent.",
						"",
					].join("\n"),
					"utf8",
				),
				executable: false,
			},
		],
	]);
	await assert.rejects(buildGeneratedTree(fixture, new Map(), config), (error: unknown) => {
		assert.ok(error instanceof KStackTransformError);
		const located = error.diagnostics.find((entry) => entry.rule === "cloud-worker");
		assert.ok(located !== undefined, "the unknown operator is reported");
		assert.equal(located.path, "skills/unknown/SKILL.md");
		assert.equal(located.line, 6);
		assert.ok(located.column > 0);
		assert.match(located.message, /no K-π equivalent/u);
		return true;
	});
});

test("a broken skill identity is refused, and a missing support file is located", async () => {
	const config = await readOverlayConfig(OVERLAY);
	const cases: { name: string; files: Map<string, string>; rule: string }[] = [
		{
			name: "name is not kebab-case",
			files: new Map([["skills/Bad_Name/SKILL.md", "---\nname: Bad_Name\ndescription: d\n---\n"]]),
			rule: "skill-name",
		},
		{
			name: "name does not match its parent",
			files: new Map([["skills/one/SKILL.md", "---\nname: two\ndescription: d\n---\n"]]),
			rule: "skill-parent",
		},
		{
			name: "two skills claim one name",
			files: new Map([
				["skills/dup/SKILL.md", "---\nname: dup\ndescription: d\n---\n"],
				["skills/dup-two/SKILL.md", "---\nname: dup\ndescription: d\n---\n"],
			]),
			rule: "skill-uniqueness",
		},
		{
			name: "no description",
			files: new Map([["skills/plain/SKILL.md", "---\nname: plain\n---\n"]]),
			rule: "frontmatter-description",
		},
		{
			name: "no frontmatter at all",
			files: new Map([["skills/bare/SKILL.md", "# bare\n"]]),
			rule: "frontmatter",
		},
		{
			name: "support file is gone",
			files: new Map([
				[
					"skills/linked/SKILL.md",
					"---\nname: linked\ndescription: d\n---\n\nSee [the notes](references/notes.md).\n",
				],
			]),
			rule: "support-link",
		},
	];
	for (const scenario of cases) {
		const diagnostics = validateGeneratedTree(scenario.files, config);
		const found = diagnostics.find((entry) => entry.rule === scenario.rule);
		assert.ok(found !== undefined, `${scenario.name} produces a ${scenario.rule} diagnostic`);
		assert.ok(found.path.length > 0 && found.line >= 1, `${scenario.name} is located`);
	}

	// And a reachable support file is accepted.
	const ok = new Map([
		["skills/linked/SKILL.md", "---\nname: linked\ndescription: d\n---\n\nSee [the notes](references/notes.md).\n"],
		["skills/linked/references/notes.md", "notes\n"],
	]);
	assert.deepEqual(
		validateGeneratedTree(ok, await readOverlayConfig(OVERLAY)).filter((entry) => entry.rule === "support-link"),
		[],
	);
});

test("a required skill missing from the tree is a diagnostic", async () => {
	const config = await readOverlayConfig(OVERLAY);
	const diagnostics = validateGeneratedTree(new Map(), config);
	for (const required of config.requiredSkills) {
		assert.ok(
			diagnostics.some((entry) => entry.rule === "required-skill" && entry.message.includes(required)),
			`${required} is required`,
		);
	}
});

test("support links tell a skill-relative file from a run-directory contract", () => {
	const links = supportLinks(
		[
			"See [notes](references/notes.md) and [up](../shared/x.md).",
			"Handoffs are `candidate.json` and `verdict.json`.",
			"Read `scripts/run.ts`.",
			"External [docs](https://example.com/a.md) and an anchor [x](#y).",
		].join("\n"),
	);
	assert.deepEqual(links.sort(), ["../shared/x.md", "references/notes.md", "scripts/run.ts"]);
});

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

test("every required playbook is discoverable exactly once", async () => {
	const playbooks = await loadPlaybooks();
	for (const required of ["feature", "bug-fix", "investigation", "shipping", "autonomous-run", "arena", "swarm"]) {
		const found = playbooks.filter((playbook) => playbook.name === required);
		assert.equal(found.length, 1, `${required} is discoverable exactly once`);
		assert.ok(found[0].steps.length > 0, `${required} renders steps`);
		assert.ok(found[0].match.length > 0, `${required} declares match keywords`);
	}
	for (const playbook of playbooks) {
		for (const step of playbook.steps) {
			assert.ok(
				(PLAYBOOK_NODES as readonly string[]).includes(step.node),
				`${playbook.name} step names a graph node: ${step.node}`,
			);
		}
	}
});

test("K-mode freezes the matched playbook and keeps every step and skip reason", async () => {
	const plan = await createKModePlan("fix the broken healthcheck");
	assert.equal(plan.playbook, "bug-fix");
	assert.equal(plan.todos.length, plan.steps.length, "every step is rendered");

	const investigation = await createKModePlan("investigate why the loop stalls");
	assert.equal(investigation.playbook, "investigation");
	const skipped = investigation.steps.filter((step) => step.skip !== undefined);
	assert.ok(skipped.length > 0, "the investigation playbook declares skipped steps");
	for (const step of skipped) {
		assert.ok(
			investigation.todos.some((todo) => todo.includes(`skip: ${step.skip}`)),
			`the skipped ${step.node} step keeps its reason`,
		);
	}
	// A skipped step is still a rendered todo, not a hole in the list.
	assert.equal(investigation.todos.length, investigation.steps.length);
});

test("matching prefers the longest declared keyword and falls back to feature", async () => {
	const playbooks = await loadPlaybooks();
	assert.equal(matchPlaybook("please ship it", playbooks).name, "shipping");
	assert.equal(matchPlaybook("run an arena between two designs", playbooks).name, "arena");
	assert.equal(matchPlaybook("swarm across the two modules", playbooks).name, "swarm");
	assert.equal(matchPlaybook("autopilot-stack the queue", playbooks).name, "autopilot-stack");
	assert.equal(matchPlaybook("something with no keywords at all", playbooks).name, FALLBACK_PLAYBOOK);
});

test("a playbook with a bad step, no steps, or no name is refused", () => {
	assert.throws(
		() =>
			parsePlaybook("playbook-x", "---\nname: playbook-x\ndescription: d\nplaybook: x\n---\n\n- **teleport** go\n"),
		PlaybookError,
	);
	assert.throws(
		() => parsePlaybook("playbook-x", "---\nname: playbook-x\ndescription: d\nplaybook: x\n---\n\nprose only\n"),
		/declares no steps/u,
	);
	assert.throws(
		() => parsePlaybook("playbook-x", "---\nname: playbook-x\ndescription: d\n---\n\n- **plan** go\n"),
		/declares no playbook name/u,
	);
	assert.throws(() => parsePlaybook("playbook-x", "no frontmatter\n"), /no parseable frontmatter/u);
});

test("two playbook skills claiming one name is refused", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-playbooks-"));
	try {
		for (const skill of ["playbook-a", "playbook-b"]) {
			await mkdir(join(directory, skill), { recursive: true });
			await writeFile(
				join(directory, skill, "SKILL.md"),
				`---\nname: ${skill}\ndescription: d\nplaybook: same\nmatch: same\n---\n\n- **plan** go\n`,
			);
		}
		await assert.rejects(loadPlaybooks(directory), /declared by both/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a missing generated runtime is an error, not an empty registry", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-noruntime-"));
	try {
		await assert.rejects(loadPlaybooks(join(directory, "absent")), /no generated K-stack runtime/u);
		await assert.rejects(loadPlaybooks(directory), /no playbook skills/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rendered todos carry the node that may complete them", async () => {
	const playbooks = await loadPlaybooks();
	const feature = playbooks.find((playbook) => playbook.name === "feature");
	assert.ok(feature !== undefined);
	const todos = renderTodos(feature.steps);
	assert.equal(todos.length, feature.steps.length);
	for (const [index, step] of feature.steps.entries()) {
		assert.ok(todos[index].startsWith(`${step.node}: `), `todo ${index} names its node`);
	}
});

// ---------------------------------------------------------------------------
// Arena and swarm bounds
// ---------------------------------------------------------------------------

test("arena and swarm state the bus contract: two workers, one writer, local pools", async () => {
	const tree = await generatedFiles();
	for (const skill of ["arena", "swarm"]) {
		const source = tree.get(`skills/${skill}/SKILL.md`);
		assert.ok(source !== undefined, `${skill} ships`);
		assert.match(source, /spawn_background/u, `${skill} uses the bus`);
		assert.match(source, /communicate/u, `${skill} steers through the bus`);
		assert.match(source, /at most two/iu, `${skill} caps fan-out at two`);
		assert.match(source, /one writer|writer slot/iu, `${skill} names the single writer`);
		assert.match(source, /~\/\.kpi\/agent\/kstack\/models\.json/u, `${skill} takes models from the map`);
		assert.equal(/cloud|hosted worker|worktree/iu.test(source), false, `${skill} has no cloud or worktree semantics`);
	}
	// The playbooks agree with the skills.
	const playbooks = await loadPlaybooks();
	for (const name of ["arena", "swarm"]) {
		const playbook = playbooks.find((entry) => entry.name === name);
		assert.ok(playbook !== undefined);
		assert.ok(
			playbook.steps.some((step) => /at most two/iu.test(step.text)),
			`the ${name} playbook caps fan-out`,
		);
	}
});

// ---------------------------------------------------------------------------
// The model ladder and /setup-kstack
// ---------------------------------------------------------------------------

test("the committed ladder parses and covers every required role", async () => {
	const ladder = await readModelLadder();
	for (const role of REQUIRED_ROLES) {
		const entry = ladder.roles.find((candidate) => candidate.role === role);
		assert.ok(entry !== undefined, `${role} has a ladder row`);
		assert.ok(entry.prefer.length > 0, `${role} offers patterns`);
		assert.ok(entry.confidence.length > 0, `${role} states a confidence`);
	}
	assert.ok(ladder.workingOrder.length > 0, "the tie-break order parses");
	// One committed file, reachable from the built and the source layout.
	const reachable = await Promise.all(
		ladderCandidates(getKpiResourceDir()).map((candidate) =>
			stat(candidate)
				.then(() => true)
				.catch(() => false),
		),
	);
	assert.ok(
		reachable.some((found) => found),
		`no ${LADDER_FILE} on any candidate path`,
	);
});

test("a ladder missing a role or a pattern is refused", () => {
	assert.throws(
		() =>
			parseModelLadder(
				"| Role | Prefer, in order | Why | Confidence |\n|---|---|---|---|\n| implementer | `a` | w | Medium |\n",
			),
		LadderError,
	);
	assert.throws(
		() =>
			parseModelLadder(
				[
					"| Role | Prefer, in order | Why | Confidence |",
					"|---|---|---|---|",
					...REQUIRED_ROLES.map((role) => `| ${role} | ${role === "fast" ? "" : "`a`"} | w | Medium |`),
				].join("\n"),
			),
		/offers no pattern/u,
	);
});

test("setup offers only live models in a K-π pool", () => {
	const models = [
		{ provider: "anthropic", id: "opus-x" },
		{ provider: "xai", id: "sol-x" },
		{ provider: "not-a-kpi-pool", id: "whatever" },
		{ provider: "anthropic", id: "opus-x" },
	] as never[];
	const candidates = liveCandidates(models);
	assert.deepEqual(candidates, ["anthropic/opus-x", "xai/sol-x"]);
	assert.ok(HEALTHY_POOLS.has("anthropic") && HEALTHY_POOLS.has("ollama"));
	assert.equal(HEALTHY_POOLS.has("not-a-kpi-pool"), false);
});

function fixtureLadder(): ReturnType<typeof parseModelLadder> {
	return parseModelLadder(
		[
			"| Role | Prefer, in order | Why | Confidence |",
			"|---|---|---|---|",
			"| implementer | `sol`, `glm` | workhorse | Medium |",
			"| frontend | `k3`, `fable` | design | Medium-high |",
			"| judgment | `opus`, `fable` | taste | Medium |",
			"| precise | `sol`, `opus` | contracts | Medium |",
			"| fast | `luna`, `flash` | cheap | Medium |",
			"| review_panel | `opus`, `sol`, `k3` | cross-family | Medium |",
			"",
			"1. GPT-5.6 Sol — workhorse",
			"2. Claude Opus 5 — judgment",
			"3. Kimi K3 — frontend",
			"4. Claude Opus 4.8 — below Opus 5",
			"",
		].join("\n"),
	);
}

test("each role reports chosen, next best, and the ladder's confidence", () => {
	const ladder = fixtureLadder();
	const candidates = [
		"anthropic/claude-opus-5-thinking",
		"openai/gpt-5.6-sol-max",
		"openai/gpt-5.6-sol-min",
		"kimi-coding/kimi-k3",
	];
	const plan = planModels(ladder, candidates);

	const implementer = plan.find((entry) => entry.role === "implementer");
	assert.equal(implementer?.chosen, "openai/gpt-5.6-sol-max");
	assert.equal(implementer?.nextBest, "openai/gpt-5.6-sol-min");
	assert.equal(implementer?.confidence, "Medium");

	const frontend = plan.find((entry) => entry.role === "frontend");
	assert.equal(frontend?.chosen, "kimi-coding/kimi-k3");
	assert.equal(frontend?.confidence, "Medium-high");

	// A role with no live match inherits rather than inventing a slug.
	const fast = plan.find((entry) => entry.role === "fast");
	assert.equal(fast?.chosen, undefined);
	assert.equal(fast?.value, INHERIT_PARENT);

	const rendered = renderPlan(plan);
	assert.ok(rendered.some((line) => line.includes("next best:") && line.includes("confidence:")));
	assert.ok(rendered.some((line) => line.startsWith(`fast → ${INHERIT_PARENT}`)));
});

test("the review panel is ordered, cross-family, and capped", () => {
	const ladder = fixtureLadder();
	const entry = ladder.roles.find((role) => role.role === "review_panel");
	assert.ok(entry !== undefined);
	const panel = suggestPanel(
		entry,
		[
			"anthropic/claude-opus-4-8",
			"anthropic/claude-opus-5-thinking",
			"openai/gpt-5.6-sol-max",
			"kimi-coding/kimi-k3",
			"xai/other",
		],
		ladder.workingOrder,
	);
	// Opus 5 outranks Opus 4.8 by the ladder's own working order, not by name.
	assert.deepEqual(panel, ["anthropic/claude-opus-5-thinking", "openai/gpt-5.6-sol-max", "kimi-coding/kimi-k3"]);
	assert.equal(new Set(panel.map((slug) => slug.split("/")[0])).size, panel.length, "one entry per family");
	assert.ok(panel.length <= PANEL_CAP);

	// One family live means a panel of one, not a slug repeated to look like two.
	assert.deepEqual(
		suggestPanel(entry, ["anthropic/claude-opus-5-thinking", "anthropic/claude-opus-4-8"], ladder.workingOrder),
		["anthropic/claude-opus-5-thinking"],
	);
});

test("the ladder never overrides the live filter", () => {
	const ladder = fixtureLadder();
	const entry = ladder.roles.find((role) => role.role === "implementer");
	assert.ok(entry !== undefined);
	// The ladder names sol first; only glm is live.
	const suggestion = suggestForRole(entry, ["zai/glm-x"], ladder.workingOrder);
	assert.equal(suggestion.chosen, "zai/glm-x");
	assert.equal(suggestion.matched, "glm");
	// Nothing live at all means nothing suggested.
	assert.equal(suggestForRole(entry, [], ladder.workingOrder).chosen, undefined);
});

test("a per-line edit is accepted, and an unavailable slug is refused in place", async () => {
	const ladder = fixtureLadder();
	const candidates = ["anthropic/claude-opus-5-thinking", "openai/gpt-5.6-sol-max"];
	const plan = planModels(ladder, candidates);
	const notices: string[] = [];
	const inputs = ["not/live", "anthropic/claude-opus-5-thinking"];
	let round = 0;
	const edited = await editPlan(plan, candidates, {
		select: async (_title, options) => {
			round += 1;
			// The menu always offers apply, one line per role, and cancel.
			assert.ok(options[0].startsWith("apply"), "apply comes first");
			assert.ok(options.some((option) => option.startsWith("implementer → ")));
			if (round > 2) {
				return options[0];
			}
			return options.find((option) => option.startsWith("implementer → "));
		},
		input: async () => inputs.shift(),
		notify: (message) => notices.push(message),
	});
	assert.ok(edited !== undefined);
	assert.equal(edited.find((entry) => entry.role === "implementer")?.value, "anthropic/claude-opus-5-thinking");
	assert.ok(
		notices.some((message) => message.includes("not/live")),
		"the unavailable slug was refused in place",
	);
});

test("cancelling the edit loop writes nothing", async () => {
	const plan = planModels(fixtureLadder(), ["anthropic/claude-opus-5-thinking"]);
	assert.equal(
		await editPlan(plan, ["anthropic/claude-opus-5-thinking"], {
			select: async () => "cancel",
			input: async () => undefined,
			notify: () => undefined,
		}),
		undefined,
	);
});

test("the model map is written atomically and read back per role", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-models-"));
	const path = join(directory, "kstack", "models.json");
	try {
		const ladder = fixtureLadder();
		const candidates = ["anthropic/claude-opus-5-thinking", "openai/gpt-5.6-sol-max", "kimi-coding/kimi-k3"];
		const document = planToDocument(planModels(ladder, candidates));
		await writeKStackModels(document, candidates, path);

		const info = await stat(path);
		assert.equal(info.mode & 0o777, 0o600, "the map is not world-readable");
		assert.deepEqual(
			(await readdir(join(directory, "kstack"))).filter((name) => name.endsWith(".tmp")),
			[],
		);

		const readBack = await readKStackModels(path);
		assert.equal(readBack?.version, 1);
		assert.equal(readBack?.inherit_parent, false);
		assert.equal(await resolveRoleModel("judgment", path), "anthropic/claude-opus-5-thinking");
		assert.deepEqual(await resolvePanel(path), [
			"anthropic/claude-opus-5-thinking",
			"openai/gpt-5.6-sol-max",
			"kimi-coding/kimi-k3",
		]);
		// An inherited role resolves to undefined, which means "use the parent".
		assert.equal(await resolveRoleModel("fast", path), undefined);
		assert.equal(await resolveRoleModel("judgment", join(directory, "absent.json")), undefined);

		// A slug outside the live set never reaches disk.
		await assert.rejects(
			writeKStackModels({ version: 1, roles: { fast: "ghost/model" }, inherit_parent: false }, candidates, path),
			/Unknown model slug/u,
		);
		// And an oversized panel is refused.
		await assert.rejects(
			writeKStackModels(
				{
					version: 1,
					roles: { review_panel: [...candidates, "anthropic/claude-opus-5-thinking"] },
					inherit_parent: false,
				},
				candidates,
				path,
			),
			/panel exceeds/u,
		);
		assert.deepEqual(await resolvePanel(path), [
			"anthropic/claude-opus-5-thinking",
			"openai/gpt-5.6-sol-max",
			"kimi-coding/kimi-k3",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a value outside the live candidates is refused before any write", async () => {
	const candidates = ["anthropic/claude-opus-5-thinking"];
	assert.doesNotThrow(() =>
		assertKnownModels(
			{ version: 1, roles: { implementer: candidates[0], fast: INHERIT_PARENT }, inherit_parent: false },
			candidates,
		),
	);
	assert.throws(
		() => assertKnownModels({ version: 1, roles: { fast: "ghost/model" }, inherit_parent: false }, candidates),
		/Unknown model slug: ghost\/model/u,
	);
	// A panel is checked entry by entry, not as a whole.
	assert.throws(
		() =>
			assertKnownModels(
				{ version: 1, roles: { review_panel: [candidates[0], "ghost/model"] }, inherit_parent: false },
				candidates,
			),
		/Unknown model slug/u,
	);
});

test("no provider or model catalogue is hard-coded in K-stack source", async () => {
	for (const file of ["models.ts", "ladder.ts", "mode.ts"]) {
		const source = await readFile(join(KSTACK_ROOT, file), "utf8");
		assert.equal(
			/claude-fable-5|claude-opus-[45]|gpt-5\.6-(?:sol|terra|luna)|grok-4\.[56]|glm-5\.[123]|kimi-k3|composer-/u.test(
				source,
			),
			false,
			`${file} names a concrete model`,
		);
	}
	// The pool list is K-π's own routing table, not a model catalogue.
	const models = await readFile(join(KSTACK_ROOT, "models.ts"), "utf8");
	assert.match(models, /POOL_IDS/u, "pools come from the accounts store");
});

test("the overlay config is data the pipeline reads, not code paths", async () => {
	const config: OverlayConfig = await readOverlayConfig(OVERLAY);
	assert.ok(config.dropPaths.length > 0 && config.operators.length > 0);
	for (const rule of config.dropPaths) {
		assert.ok(rule.reason.trim().length > 0, `${rule.pattern} states why it is dropped`);
	}
	for (const rule of config.unknownOperatorSentinels) {
		assert.ok(rule.rule.trim().length > 0 && rule.message.trim().length > 0);
	}
	assert.deepEqual([...config.attributionPaths].sort(), ["LICENSE", "NOTICE", "UPSTREAM.md"]);
	// The three data files docs/kstack.md names, each still doing its own job.
	assert.ok(config.pathRenames.length > 0 && config.tokenRenames.length > 0, "rename-map.json is read");
	assert.ok(config.forbidden.length > 0, "forbidden.txt is read");
	for (const phrase of ["subagent", "graphite", "worktree", "poteto"]) {
		assert.ok(config.forbidden.includes(phrase), `forbidden.txt lists ${phrase}`);
	}
});

test("the plain forbidden list catches a string no pattern would match", async () => {
	const config = await readOverlayConfig(OVERLAY);
	// A string on the list, in a shape none of the located sentinels describe.
	const fixture = new Map([
		["skills/plain/SKILL.md", "---\nname: plain\ndescription: d\n---\n\nRun it through GrApHiTe somehow.\n"],
	]);
	const diagnostics = validateGeneratedTree(fixture, config);
	const found = diagnostics.find((entry) => entry.rule === "forbidden-string");
	assert.ok(found !== undefined, "the plain net fired");
	assert.equal(found.path, "skills/plain/SKILL.md");
	assert.equal(found.line, 6);
	assert.match(found.message, /forbidden string: graphite/u);

	// Attribution is exempt, so the licence author is not residue.
	assert.deepEqual(
		validateGeneratedTree(new Map([["LICENSE", "Copyright (c) 2026 Lauren Tan\n"]]), config).filter(
			(entry) => entry.rule === "forbidden-string" || entry.rule === "personal-name",
		),
		[],
	);
});

// ---------------------------------------------------------------------------
// Harness and bus integration
// ---------------------------------------------------------------------------

test("the shipped resource declaration points at the generated runtime", async () => {
	// The same declaration the harness proof loads: one K-stack skill root, and it
	// is the generated tree.
	const index = await readFile(
		new URL("../packages/coding-agent/src/kpi/extensions/index.ts", import.meta.url).pathname,
		"utf8",
	);
	assert.match(index, /\["kstack", "generated", "skills"\]/u, "the generated tree is declared as a skill root");
	assert.equal(
		/kstack", "overlay|kstack", "upstream|kstack", "playbooks/u.test(index),
		false,
		"no build input is a skill root",
	);
});

test("the build ships the runtime, its attribution, and the ladder, and no build input", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("../packages/coding-agent/package.json", import.meta.url).pathname, "utf8"),
	) as { scripts: Record<string, string> };
	const copy = manifest.scripts["copy-kpi-assets"];
	assert.ok(copy !== undefined);
	assert.match(copy, /kstack\/generated\/skills/u, "the loadable runtime ships");
	assert.match(copy, /kstack\/generated\/LICENSE/u, "the upstream licence ships");
	assert.match(copy, /kstack\/NOTICE/u, "attribution ships");
	assert.match(copy, /kstack\/UPSTREAM\.md/u, "the pin ships");
	assert.match(copy, /docs\/model-ladder\.md/u, "the ladder ships where setup can read it");
	for (const input of [
		"kstack/overlay",
		"kstack/upstream",
		"kstack/playbooks",
		"kstack/principles.md",
		"kstack/k-agent.md",
	]) {
		assert.equal(copy.includes(input), false, `${input} is a build input and must not ship`);
	}
});

test("no K-π source outside the overlay carries a K-stack playbook table", async () => {
	for (const file of ["mode.ts", "models.ts", "ladder.ts"]) {
		const source = await readFile(join(KSTACK_ROOT, file), "utf8");
		// The old hard-coded STEPS table is gone: steps come from the generated tree.
		assert.equal(/const STEPS\b/u.test(source), false, `${file} still declares a steps table`);
		assert.equal(
			/"read Principles"|'read Principles'/u.test(source),
			false,
			`${file} still hard-codes a playbook step`,
		);
	}
	const mode = await readFile(join(KSTACK_ROOT, "mode.ts"), "utf8");
	assert.match(mode, /loadPlaybooks/u, "playbooks are loaded from the runtime");
	assert.match(mode, /generated", "skills"/u, "and the runtime is the generated tree");
});

test("a playbook step names a bus tool the bus actually registers", async () => {
	const playbooks = await loadPlaybooks();
	const busSource = await readFile(
		new URL("../packages/coding-agent/src/kpi/extensions/bus/communicate.ts", import.meta.url).pathname,
		"utf8",
	);
	const mentioned = new Set<string>();
	for (const playbook of playbooks) {
		for (const step of playbook.steps) {
			for (const match of step.text.matchAll(
				/`(spawn_background|communicate|claim_path|release_path|write_contract)`/gu,
			)) {
				mentioned.add(match[1]);
			}
		}
	}
	assert.ok(mentioned.size > 0, "the fan-out playbooks name bus tools");
	for (const tool of mentioned) {
		assert.match(busSource, new RegExp(`name: "${tool}"`, "u"), `the bus registers ${tool}`);
	}
});

test("arena and swarm never exceed the bus's own worker cap", async () => {
	const spawn = await readFile(
		new URL("../packages/coding-agent/src/kpi/extensions/bus/spawn.ts", import.meta.url).pathname,
		"utf8",
	);
	const workers = /export const MAX_LIVE_WORKERS = (\d+);/u.exec(spawn);
	const writers = /export const MAX_LIVE_WRITERS = (\d+);/u.exec(spawn);
	assert.ok(workers !== null && writers !== null);
	assert.equal(Number(workers[1]), 2, "the bus caps workers at two");
	assert.equal(Number(writers[1]), 1, "and writers at one");

	// The skills state the same numbers, so a reader is never told a wider bound.
	const tree = await generatedFiles();
	for (const skill of ["arena", "swarm"]) {
		const source = tree.get(`skills/${skill}/SKILL.md`) ?? "";
		assert.equal(/at most (?:three|four|five|\d\d+)/iu.test(source), false, `${skill} promises a wider fan-out`);
	}
});

test("a role resolved for a worker is a model id or an inherited parent, never a slot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kpi-role-"));
	const path = join(directory, "models.json");
	try {
		await writeKStackModels(
			{
				version: 1,
				roles: { implementer: "anthropic/claude-opus-5-thinking", fast: INHERIT_PARENT },
				inherit_parent: false,
			},
			["anthropic/claude-opus-5-thinking"],
			path,
		);
		// What a spawn would pass as `model`.
		assert.equal(await resolveRoleModel("implementer", path), "anthropic/claude-opus-5-thinking");
		assert.equal(await resolveRoleModel("fast", path), undefined, "an inherited role passes no model");
		// A slot id is never a role value.
		const document = await readKStackModels(path);
		for (const value of Object.values(document?.roles ?? {})) {
			for (const slug of Array.isArray(value) ? value : [value]) {
				assert.ok(slug === INHERIT_PARENT || slug.includes("/"), `${slug} is a provider/id model slug`);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("attribution is complete: the full MIT text, the author, and the source", async () => {
	const license = await readFile(join(GENERATED, "LICENSE"), "utf8");
	for (const clause of [
		"MIT License",
		"Permission is hereby granted, free of charge",
		"without restriction",
		"The above copyright notice and this permission notice shall be included",
		'THE SOFTWARE IS PROVIDED "AS IS"',
		"WITHOUT WARRANTY OF ANY KIND",
		"IN NO EVENT SHALL THE",
		"LIABILITY, WHETHER IN AN ACTION OF CONTRACT",
	]) {
		assert.ok(license.includes(clause), `the MIT licence keeps: ${clause}`);
	}
	assert.match(license, /Copyright \(c\) \d{4} \S+/u, "the copyright holder survives");

	const notice = await readFile(join(KSTACK_ROOT, "NOTICE"), "utf8");
	assert.match(notice, /MIT License/u);
	assert.match(notice, /Copyright \(c\)/u);

	const rootNotice = await readFile(new URL("../NOTICE", import.meta.url).pathname, "utf8");
	assert.match(rootNotice, /MIT/u, "the root notice states the licence");
	assert.match(rootNotice, /github\.com\/cursor\/plugins/u, "and names the source");
	assert.match(rootNotice, /Author:/u, "and names the author");

	const upstreamDocument = await readFile(join(KSTACK_ROOT, "UPSTREAM.md"), "utf8");
	assert.match(upstreamDocument, /\| Commit \| [0-9a-f]{40} \|/u, "the pin is recorded");
});

test("K-mode freezes the playbook into the job contract and renders its steps", async () => {
	const { createJob, readTaskForJob, contractHash } = await import(
		"../packages/coding-agent/src/kpi/extensions/run-store.ts"
	);
	const { writeState } = await import("../packages/coding-agent/src/kpi/extensions/gated-loop.ts");
	const { createStopState } = await import("../packages/coding-agent/src/kpi/extensions/graph/stop.ts");
	const { kModeState } = await import("../packages/coding-agent/src/kpi/kstack/mode.ts");
	const previous = { enabled: kModeState.enabled, plan: kModeState.plan };
	const root = await mkdtemp(join(tmpdir(), "kpi-playbook-freeze-"));
	try {
		kModeState.enabled = true;
		kModeState.plan = await createKModePlan("investigate why the loop stalls");
		assert.equal(kModeState.plan.playbook, "investigation");
		const frozenSteps = kModeState.plan.steps.map((step) =>
			step.skip === undefined
				? { node: step.node, text: step.text }
				: { node: step.node, text: step.text, skip: step.skip },
		);
		const expectedTodos = renderTodos(kModeState.plan.steps);
		assert.ok(
			expectedTodos.some((todo) => todo.includes("skip:")),
			"investigation freezes at least one skip reason",
		);
		assert.equal(expectedTodos.length, frozenSteps.length);

		const task = {
			job_id: "freeze-investigation",
			mode: "gated" as const,
			goal: "investigate why the loop stalls",
			nongoals: [] as string[],
			acceptance: [{ id: "AC-01", statement: "root cause known", required: true }],
			constraints: [] as string[],
			quality_gates: [] as string[],
			ac: { quality: "narrative" as const },
			playbook: kModeState.plan.playbook,
			playbook_steps: frozenSteps,
		};
		await createJob(root, task);

		// Mutate and clear process-global plan: the freeze must not depend on it.
		kModeState.enabled = false;
		delete kModeState.plan;
		assert.equal(kModeState.plan, undefined);

		const reloaded = await readTaskForJob(root, task.job_id);
		assert.equal(reloaded.playbook, "investigation");
		assert.deepEqual(reloaded.playbook_steps, frozenSteps);
		for (const [index, step] of frozenSteps.entries()) {
			assert.equal(reloaded.playbook_steps?.[index]?.node, step.node, `step ${index} node`);
			assert.equal(reloaded.playbook_steps?.[index]?.text, step.text, `step ${index} text`);
			assert.equal(reloaded.playbook_steps?.[index]?.skip, step.skip, `step ${index} skip`);
		}

		const runDirectory = join(root, ".kpi", "runs", task.job_id);
		const graphState = {
			graphId: "freeze",
			jobId: task.job_id,
			status: "running" as const,
			superstep: 0,
			active: ["implement"],
			values: {},
			nodes: {},
			budget: {
				limits: {},
				startedAtMs: 0,
				elapsedMs: 0,
				costUsd: 0,
				round: 0,
				batches: 0,
				steps: 0,
				nodeRuns: {},
			},
		};
		await writeState(runDirectory, reloaded, graphState as never, createStopState(8));
		const state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as {
			playbook?: string;
			todos?: string[];
		};
		assert.equal(state.playbook, "investigation");
		assert.deepEqual(state.todos, expectedTodos, "state todos come from the task snapshot only");

		// Editing the frozen snapshot changes the contract hash; slice id does not.
		const baseHash = contractHash(reloaded);
		assert.equal(contractHash({ ...reloaded, current_module_id: "other-slice" }), baseHash);
		assert.notEqual(
			contractHash({ ...reloaded, playbook: "feature" }),
			baseHash,
			"playbook name is in the contract hash",
		);
		assert.notEqual(
			contractHash({ ...reloaded, playbook_steps: [...frozenSteps].reverse() }),
			baseHash,
			"step order is in the contract hash",
		);
		assert.notEqual(
			contractHash({
				...reloaded,
				playbook_steps: frozenSteps.map((step, index) =>
					index === 0 ? { ...step, text: `${step.text} (edited)` } : step,
				),
			}),
			baseHash,
			"step text is in the contract hash",
		);
		assert.notEqual(
			contractHash({
				...reloaded,
				playbook_steps: frozenSteps.map((step) =>
					step.skip === undefined ? step : { ...step, skip: `${step.skip} (edited)` },
				),
			}),
			baseHash,
			"skip reason is in the contract hash",
		);

		// After rewriting task.json as a fresh process would read it, state still matches.
		const again = await readTaskForJob(root, task.job_id);
		assert.deepEqual(again.playbook_steps, frozenSteps);
		await writeState(runDirectory, again, graphState as never, createStopState(8));
		const resumed = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as {
			todos?: string[];
		};
		assert.deepEqual(resumed.todos, expectedTodos);
	} finally {
		kModeState.enabled = previous.enabled;
		if (previous.plan === undefined) {
			delete kModeState.plan;
		} else {
			kModeState.plan = previous.plan;
		}
		await rm(root, { recursive: true, force: true });
	}
});
