import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadSkillsFromDir } from "../packages/coding-agent/src/core/skills.ts";
import type { ToolCallEvent } from "../packages/coding-agent/src/core/extensions/types.ts";
import { evaluateToolCall, type PolicyConfig } from "../packages/coding-agent/src/kpi/extensions/policy.ts";
import type { KnowledgeGraphPatch } from "../packages/coding-agent/src/kpi/extensions/kg/schema.ts";
import {
	isAuthoritativeKnowledgeGraphPath,
	KnowledgeGraphControlPlane,
	KnowledgeGraphProposals,
	knowledgeGraphPaths,
	SNAPSHOT_COMPLETE_MARKER,
} from "../packages/coding-agent/src/kpi/extensions/kg/store.ts";

const observedAt = new Date(0).toISOString();

const source: NonNullable<KnowledgeGraphPatch["source"]> = {
	id: "src-spec",
	kind: "document",
	source_ids: [],
	status: "verified",
	observed_at: observedAt,
	uri: "docs/spec.md#14",
};

const claim: NonNullable<KnowledgeGraphPatch["node"]> = {
	id: "claim-one-writer",
	kind: "decision",
	source_ids: ["src-spec"],
	status: "proposed",
	observed_at: observedAt,
};

async function fixture(): Promise<string> {
	return mkdtemp(join(tmpdir(), "kpi-kg-"));
}

async function readRecords(path: string): Promise<Record<string, unknown>[]> {
	return (await readFile(path, "utf8"))
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeEvent(path: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "call-write",
		toolName: "write",
		input: { path, content: "{}" },
	};
}

test("node, edge, and source round-trips validate and bump revisions", async () => {
	const cwd = await fixture();
	const paths = knowledgeGraphPaths(cwd);
	try {
		const controlPlane = new KnowledgeGraphControlPlane(cwd);

		const first = await controlPlane.accept(await controlPlane.propose({ source, node: claim }));
		assert.equal(first.source?.rev, 1);
		assert.equal(first.node?.rev, 1);

		const second = await controlPlane.accept(
			await controlPlane.propose({ node: { ...claim, status: "verified" } }),
		);
		assert.equal(second.node?.rev, 2, "a second acceptance of the same id must bump the revision");

		const other = await controlPlane.accept(
			await controlPlane.propose({ node: { ...claim, id: "claim-two", status: "proposed" } }),
		);
		assert.equal(other.node?.rev, 1, "revisions are per id, not per file");

		const edge = await controlPlane.accept(
			await controlPlane.propose({
				edge: {
					id: "edge-supports",
					kind: "supports",
					source_ids: ["src-spec"],
					status: "proposed",
					observed_at: observedAt,
					from: "claim-one-writer",
					to: "claim-two",
					confidence: 0.5,
				},
			}),
		);
		assert.equal(edge.edge?.rev, 1);

		const state = await controlPlane.read();
		assert.deepEqual(
			state.nodes.map((node) => `${node.id}@${node.rev}`),
			["claim-one-writer@1", "claim-one-writer@2", "claim-two@1"],
		);
		assert.deepEqual(
			state.sources.map((record) => `${record.id}@${record.rev}`),
			["src-spec@1"],
		);
		assert.deepEqual(
			state.edges.map((record) => `${record.id}@${record.rev}`),
			["edge-supports@1"],
		);
		assert.deepEqual(await readdir(paths.inbox), [], "acceptance must consume the patch");

		// Minimum fields, status enum, source refs, and monotonic revisions.
		await assert.rejects(controlPlane.propose({ node: { ...claim, status: "maybe" } }), /patch node\.status/u);
		await assert.rejects(controlPlane.propose({ node: { ...claim, observed_at: "yesterday" } }), /observed_at/u);
		await assert.rejects(controlPlane.propose({ node: { ...claim, id: "" } }), /patch node\.id is required/u);
		await assert.rejects(controlPlane.propose({}), /must carry a source, a node, or an edge/u);
		await assert.rejects(controlPlane.propose({ node: { ...claim, source_ids: [] } }), /at least one source/u);

		const danglingSource = await controlPlane.propose({ node: { ...claim, source_ids: ["src-missing"] } });
		await assert.rejects(controlPlane.accept(danglingSource), /cites unknown source src-missing/u);

		const danglingEndpoint = await controlPlane.propose({
			edge: {
				id: "edge-dangling",
				kind: "supports",
				source_ids: ["src-spec"],
				status: "proposed",
				observed_at: observedAt,
				from: "claim-one-writer",
				to: "claim-absent",
			},
		});
		await assert.rejects(controlPlane.accept(danglingEndpoint), /references unknown node claim-absent/u);

		const staleRevision = await controlPlane.propose({ node: { ...claim, rev: 2 } });
		await assert.rejects(controlPlane.accept(staleRevision), /revision must be monotonic: expected 3, received 2/u);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an injected crash after the snapshot leaves the prior state readable", async () => {
	const cwd = await fixture();
	const paths = knowledgeGraphPaths(cwd);
	try {
		const settled = new KnowledgeGraphControlPlane(cwd);
		await settled.accept(await settled.propose({ source, node: claim }));
		const priorNodes = await readFile(paths.nodes, "utf8");
		const priorSources = await readFile(paths.sources, "utf8");

		let snapshotPath = "";
		const crashing = new KnowledgeGraphControlPlane(cwd, {
			afterSnapshot: (path) => {
				snapshotPath = path;
				throw new Error("injected crash");
			},
		});
		const patchPath = await crashing.propose({ node: { ...claim, status: "verified" } });
		await assert.rejects(crashing.accept(patchPath), /injected crash/u);

		assert.equal(await readFile(paths.nodes, "utf8"), priorNodes, "the prior state must survive the crash");
		assert.equal(await readFile(paths.sources, "utf8"), priorSources);
		assert.equal((await readRecords(paths.nodes)).length, 1);

		assert.ok((await stat(join(snapshotPath, SNAPSHOT_COMPLETE_MARKER))).isFile(), "no completion marker");
		assert.equal(await readFile(join(snapshotPath, "nodes.jsonl"), "utf8"), priorNodes);
		const manifest = JSON.parse(await readFile(join(snapshotPath, "manifest.json"), "utf8")) as {
			files: Record<string, { records: number }>;
		};
		assert.equal(manifest.files["nodes.jsonl"].records, 1);
		assert.equal(manifest.files["edges.jsonl"].records, 0, "a snapshot captures every authoritative file");

		// The patch is still pending, so acceptance can be retried after recovery.
		assert.deepEqual(await readdir(paths.inbox), [patchPath.split("/").at(-1)]);
		const recovered = new KnowledgeGraphControlPlane(cwd);
		assert.equal((await recovered.accept(patchPath)).node?.rev, 2);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("twenty concurrent proposals stay twenty parseable, non-interleaved records", async () => {
	const cwd = await fixture();
	const paths = knowledgeGraphPaths(cwd);
	try {
		const controlPlane = new KnowledgeGraphControlPlane(cwd);
		await controlPlane.accept(await controlPlane.propose({ source }));

		const proposals = await Promise.all(
			Array.from({ length: 20 }, (_unused, index) =>
				controlPlane.propose({ node: { ...claim, kind: `decision-${index}` } }),
			),
		);
		assert.equal(new Set(proposals).size, 20, "each proposal must be its own inbox record");
		assert.equal((await readdir(paths.inbox)).length, 20);
		for (const path of proposals) {
			const patch = JSON.parse(await readFile(path, "utf8")) as KnowledgeGraphPatch;
			assert.equal(patch.node?.id, claim.id);
		}

		const accepted = await Promise.all(proposals.map((path) => controlPlane.accept(path)));
		assert.deepEqual(
			accepted.map((record) => record.node?.rev).sort((left, right) => Number(left) - Number(right)),
			Array.from({ length: 20 }, (_unused, index) => index + 1),
			"serialized acceptance must hand out every revision exactly once",
		);

		const records = await readRecords(paths.nodes);
		assert.equal(records.length, 20, "twenty acceptances must leave twenty whole lines");
		assert.deepEqual(
			records.map((record) => record.rev),
			Array.from({ length: 20 }, (_unused, index) => index + 1),
		);
		assert.deepEqual(await readdir(paths.inbox), []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("a direct authoritative write through the public tool fails", async () => {
	const cwd = await fixture();
	const paths = knowledgeGraphPaths(cwd);
	const policy: PolicyConfig = {
		deny: [],
		commit: { gated: "confirm", autopilot: "after-release" },
		unknown: { gated: "confirm", autopilot: "deny" },
	};
	// A write_allow wide enough to cover everything, so the denial can only come
	// from the one-writer reservation.
	const options = {
		cwd,
		policy,
		active: {
			mode: "gated" as const,
			releaseApproved: false,
			writeAllow: ["**"],
			qualityGates: [],
		},
	};
	try {
		for (const path of [".kpi/kg/nodes.jsonl", ".kpi/kg/edges.jsonl", ".kpi/kg/sources.jsonl"]) {
			assert.equal(isAuthoritativeKnowledgeGraphPath(cwd, path), true, path);
			const decision = await evaluateToolCall(writeEvent(path), options);
			assert.equal(decision.kind, "deny", `${path} must be denied to the public write tool`);
			assert.match(
				decision.kind === "deny" ? decision.reason : "",
				/reserved the authoritative knowledge graph for the control plane/u,
			);
		}
		const snapshotEdit = await evaluateToolCall(
			{
				type: "tool_call",
				toolCallId: "call-edit",
				toolName: "edit",
				input: { path: ".kpi/kg/snapshots/2026-01-01/nodes.jsonl", oldString: "a", newString: "b" },
			},
			options,
		);
		assert.equal(snapshotEdit.kind, "deny", "snapshots are authoritative too");

		// A proposal is the one path a worker keeps.
		assert.equal(isAuthoritativeKnowledgeGraphPath(cwd, ".kpi/kg/inbox/patch.json"), false);
		assert.deepEqual(await evaluateToolCall(writeEvent(".kpi/kg/inbox/patch.json"), options), { kind: "allow" });

		// The proposal surface has no authoritative write method at all, and the
		// control plane refuses a target outside the inbox.
		const proposals = new KnowledgeGraphProposals(cwd);
		assert.equal("accept" in proposals, false, "the public surface must not expose acceptance");
		const controlPlane = new KnowledgeGraphControlPlane(cwd);
		await assert.rejects(controlPlane.accept(paths.nodes), /accepts inbox patches only/u);
		await writeFile(join(cwd, "outside.json"), JSON.stringify({ node: claim }));
		await assert.rejects(controlPlane.accept(join(cwd, "outside.json")), /accepts inbox patches only/u);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resource discovery finds the kg-claim skill with no diagnostic", () => {
	const skillsDir = fileURLToPath(new URL("../packages/coding-agent/src/kpi/skills", import.meta.url));
	const loaded = loadSkillsFromDir({ dir: skillsDir, source: "extension:k-pi" });

	assert.deepEqual(
		loaded.diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`),
		[],
		"the shipped skill tree must load clean",
	);
	const skill = loaded.skills.find((candidate) => candidate.name === "kg-claim");
	assert.ok(skill, `kg-claim never loaded; got ${loaded.skills.map((candidate) => candidate.name).join(", ")}`);
	assert.match(skill.description, /^Use when a decision should outlive the run/u);
	assert.ok(skill.description.length <= 1024);
	assert.equal(skill.disableModelInvocation, false);
	assert.equal(skill.filePath.endsWith(join("kg-claim", "SKILL.md")), true);
});
