#!/usr/bin/env node

/**
 * Final Grok review aggregator.
 *
 * Downloads every expected group result, rejects missing/duplicate/failed/invalid
 * groups, validates chunk-scoped findings, unions with adaptive hard bound, and
 * always writes full raw+validated artifacts before fail-closed exits.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	adaptiveUnionCap,
	normalizeGrokReview,
	sortFindings,
	unionGrokFindings,
} from "./validate-grok-review.mjs";
import { parseChunkLocationIndex } from "./partition-pr-diff.mjs";

/**
 * @param {object} input
 * @param {string} input.resultsDir directory with group-NN result folders
 * @param {object} input.plan group-plan.json contents
 * @param {string} input.outJson
 * @param {string} input.outMeta
 * @param {string|null} [input.workDir]
 */
export function finalizeGrokReview({ resultsDir, plan, outJson, outMeta, workDir = null }) {
	if (!plan || typeof plan !== "object") throw new Error("group plan is required");
	const expectedGroups = Array.isArray(plan.groups) ? plan.groups : [];
	/** @type {Set<number>} */
	const planGroupIds = new Set();
	for (const g of expectedGroups) {
		if (!g || !Number.isSafeInteger(g.group) || g.group < 0) {
			throw new Error("plan group entries require non-negative integer group id");
		}
		if (planGroupIds.has(g.group)) {
			throw new Error(`plan lists group ${g.group} more than once`);
		}
		planGroupIds.add(g.group);
		if (!Array.isArray(g.chunkIndexes)) {
			throw new Error(`plan group ${g.group} missing chunkIndexes array`);
		}
		if (Number.isSafeInteger(g.chunkCount) && g.chunkCount !== g.chunkIndexes.length) {
			throw new Error(
				`plan group ${g.group} chunkCount ${g.chunkCount} != chunkIndexes ${g.chunkIndexes.length}`,
			);
		}
	}
	const expectedChunkIndexes = expectedGroups.flatMap((g) => g.chunkIndexes);
	const expectedChunkSet = new Set(expectedChunkIndexes);
	if (expectedChunkSet.size !== expectedChunkIndexes.length) {
		throw new Error("plan assigns a chunk index to more than one group");
	}
	const expectedChunkCount = Number.isSafeInteger(plan.chunkCount)
		? plan.chunkCount
		: expectedChunkSet.size;
	if (expectedChunkCount !== expectedChunkSet.size) {
		throw new Error(
			`plan.chunkCount ${expectedChunkCount} != unique assigned chunks ${expectedChunkSet.size}`,
		);
	}
	if (workDir) mkdirSync(workDir, { recursive: true });

	/** @type {Map<number, object>} */
	const groupResults = new Map();
	/** @type {string[]} */
	const errors = [];

	if (expectedGroups.length === 0 && expectedChunkCount === 0) {
		const meta = {
			chunkCount: 0,
			groupCount: 0,
			findingCount: 0,
			failedChunkCount: 0,
			failedGroupCount: 0,
			adaptiveUnionCap: adaptiveUnionCap(0),
			groups: [],
			chunks: [],
		};
		writeFileSync(outJson, "[]\n");
		writeFileSync(outMeta, `${JSON.stringify(meta, null, 2)}\n`);
		return { findings: [], meta };
	}

	// Index result files: prefer group-NN/result.json layout.
	const entries = existsSync(resultsDir) ? readdirSync(resultsDir, { withFileTypes: true }) : [];
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		const m = /^group-(\d+)$/u.exec(ent.name);
		if (!m) continue;
		const groupId = Number.parseInt(m[1], 10);
		const resultPath = join(resultsDir, ent.name, "result.json");
		if (!existsSync(resultPath)) {
			errors.push(`group ${groupId}: missing result.json`);
			continue;
		}
		if (groupResults.has(groupId)) {
			errors.push(`group ${groupId}: duplicate result directory`);
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(resultPath, "utf8"));
		} catch (error) {
			errors.push(`group ${groupId}: invalid result.json (${error.message})`);
			continue;
		}
		if (!parsed || typeof parsed !== "object") {
			errors.push(`group ${groupId}: result is not an object`);
			continue;
		}
		groupResults.set(groupId, parsed);
	}

	// Also accept flat group-N-result.json files.
	for (const ent of entries) {
		if (!ent.isFile()) continue;
		const m = /^group-(\d+)-result\.json$/u.exec(ent.name);
		if (!m) continue;
		const groupId = Number.parseInt(m[1], 10);
		if (groupResults.has(groupId)) {
			errors.push(`group ${groupId}: duplicate flat result file`);
			continue;
		}
		try {
			groupResults.set(groupId, JSON.parse(readFileSync(join(resultsDir, ent.name), "utf8")));
		} catch (error) {
			errors.push(`group ${groupId}: invalid flat result (${error.message})`);
		}
	}

	/** @type {Map<number, object>} */
	const chunkByIndex = new Map();
	/** @type {object[]} */
	const groupMetas = [];

	for (const expected of expectedGroups) {
		const groupId = expected.group;
		const result = groupResults.get(groupId);
		if (!result) {
			errors.push(`group ${groupId}: missing result`);
			continue;
		}
		groupResults.delete(groupId);
		if (Number.isSafeInteger(result.group) && result.group !== groupId) {
			errors.push(`group ${groupId}: result.group ${result.group} does not match directory/plan id`);
		}
		if (result.ok === false) {
			errors.push(`group ${groupId}: failed (${result.reason ?? "unknown"})`);
		}
		const chunkRows = Array.isArray(result.chunks) ? result.chunks : null;
		if (!chunkRows) {
			errors.push(`group ${groupId}: missing chunks array`);
			continue;
		}
		if (Number.isSafeInteger(result.chunkCount) && result.chunkCount !== chunkRows.length) {
			errors.push(
				`group ${groupId}: result.chunkCount ${result.chunkCount} != chunks ${chunkRows.length}`,
			);
		}
		const expectedIndexes = [...(expected.chunkIndexes ?? [])].sort((a, b) => a - b);
		const gotIndexes = chunkRows.map((c) => c.index).sort((a, b) => a - b);
		if (expectedIndexes.length !== gotIndexes.length) {
			errors.push(
				`group ${groupId}: chunk count mismatch expected ${expectedIndexes.length} got ${gotIndexes.length}`,
			);
		}
		for (let i = 0; i < Math.max(expectedIndexes.length, gotIndexes.length); i++) {
			if (expectedIndexes[i] !== gotIndexes[i]) {
				errors.push(
					`group ${groupId}: chunk index set mismatch at position ${i} (expected ${expectedIndexes[i]} got ${gotIndexes[i]})`,
				);
				break;
			}
		}
		for (const row of chunkRows) {
			if (!Number.isSafeInteger(row.index)) {
				errors.push(`group ${groupId}: chunk without index`);
				continue;
			}
			if (chunkByIndex.has(row.index)) {
				errors.push(`chunk ${row.index}: assigned/reported more than once`);
				continue;
			}
			// Path confinement: findings may only cite paths declared on this chunk.
			const allowed = new Set(Array.isArray(row.paths) ? row.paths : []);
			if (Array.isArray(row.findings)) {
				for (const f of row.findings) {
					if (f && typeof f.path === "string" && allowed.size > 0 && !allowed.has(f.path)) {
						errors.push(
							`group ${groupId} chunk ${row.index}: finding path ${f.path} outside chunk paths`,
						);
					}
				}
			}
			chunkByIndex.set(row.index, { ...row, group: groupId });
		}
		groupMetas.push({
			group: groupId,
			ok: result.ok !== false && !errors.some((e) => e.startsWith(`group ${groupId}:`) || e.startsWith(`group ${groupId} `)),
			reason: result.reason ?? null,
			chunkCount: chunkRows.length,
			findingCount: result.findingCount ?? null,
		});
	}

	// Extra unexpected groups
	for (const extra of groupResults.keys()) {
		errors.push(`group ${extra}: unexpected result (not in plan)`);
	}
	// Missing chunks
	for (const index of expectedChunkIndexes) {
		if (!chunkByIndex.has(index)) {
			errors.push(`chunk ${index}: missing from all group results`);
		}
	}
	if (chunkByIndex.size !== expectedChunkSet.size && errors.length === 0) {
		errors.push(
			`chunk coverage mismatch: got ${chunkByIndex.size} unique chunks, expected ${expectedChunkSet.size}`,
		);
	}

	const chunkResults = [...chunkByIndex.values()].sort((a, b) => a.index - b.index);
	const failures = chunkResults.filter((row) => !row.ok);
	const partialFindings = sortFindings(
		chunkResults.flatMap((row) => (Array.isArray(row.findings) ? row.findings : [])),
	);

	const baseMeta = {
		chunkCount: expectedChunkCount,
		groupCount: expectedGroups.length,
		adaptiveUnionCap: adaptiveUnionCap(expectedChunkCount),
		groups: groupMetas,
		chunks: chunkResults.map((row) => ({
			index: row.index,
			group: row.group,
			paths: row.paths,
			bytes: row.bytes,
			ok: row.ok,
			reason: row.reason,
			durationMs: row.durationMs ?? null,
			findingCount: row.findingCount ?? (Array.isArray(row.findings) ? row.findings.length : null),
			stderr: typeof row.stderr === "string" ? row.stderr.slice(0, 500) : null,
		})),
		failedChunkCount: failures.length,
		failedGroupCount: groupMetas.filter((g) => !g.ok).length,
		infraErrors: errors,
	};

	const writeArtifacts = (findings, meta) => {
		writeFileSync(outJson, `${JSON.stringify(findings ?? [], null, 2)}\n`);
		writeFileSync(outMeta, `${JSON.stringify(meta, null, 2)}\n`);
		if (workDir) {
			writeFileSync(join(workDir, "finalize-errors.json"), `${JSON.stringify(errors, null, 2)}\n`);
		}
	};

	if (errors.length > 0 || failures.length > 0) {
		const meta = {
			...baseMeta,
			findingCount: null,
			partialFindingCount: partialFindings.length,
			overflow: false,
		};
		writeArtifacts(partialFindings, meta);
		const detail = [...errors, ...failures.map((f) => `chunk ${f.index}: ${f.reason}`)].join("; ");
		const error = new Error(`Grok finalize failed closed (${detail})`);
		error.meta = meta;
		error.findings = partialFindings;
		throw error;
	}

	try {
		const findings = unionGrokFindings(
			chunkResults.map((row) => row.findings),
			{ chunkCount: expectedChunkCount },
		);
		const meta = {
			...baseMeta,
			findingCount: findings.length,
			partialFindingCount: findings.length,
			overflow: false,
		};
		writeArtifacts(findings, meta);
		return { findings, meta };
	} catch (error) {
		if (error?.code === "union-overflow" && Array.isArray(error.findings)) {
			const findings = error.findings;
			const meta = {
				...baseMeta,
				findingCount: findings.length,
				partialFindingCount: findings.length,
				overflow: true,
				adaptiveUnionCap: error.adaptiveCap ?? adaptiveUnionCap(expectedChunkCount),
			};
			writeArtifacts(findings, meta);
			const wrapped = new Error(error.message);
			wrapped.code = "union-overflow";
			wrapped.meta = meta;
			wrapped.findings = findings;
			wrapped.overflow = true;
			throw wrapped;
		}
		throw error;
	}
}

/**
 * Re-validate a raw group chunk output against its diff text (optional hardening).
 */
export function validateGroupChunkFinding(stdout, chunkText, paths) {
	const locationIndex = parseChunkLocationIndex(chunkText);
	return normalizeGrokReview(stdout, paths, {
		locationIndex,
		requireLocationIndex: true,
	});
}

function parseArgs(argv) {
	const opts = { workDir: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--results-dir":
				opts.resultsDir = next();
				break;
			case "--group-plan":
				opts.groupPlanPath = next();
				break;
			case "--out-json":
				opts.outJson = next();
				break;
			case "--out-meta":
				opts.outMeta = next();
				break;
			case "--work-dir":
				opts.workDir = next();
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	for (const key of ["resultsDir", "groupPlanPath", "outJson", "outMeta"]) {
		if (!opts[key]) throw new Error(`missing required --${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`);
	}
	return opts;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const plan = JSON.parse(readFileSync(opts.groupPlanPath, "utf8"));
	try {
		const { findings, meta } = finalizeGrokReview({
			resultsDir: opts.resultsDir,
			plan,
			outJson: opts.outJson,
			outMeta: opts.outMeta,
			workDir: opts.workDir,
		});
		console.log(
			`finalize grok review ok: chunks=${meta.chunkCount} groups=${meta.groupCount} findings=${findings.length}`,
		);
	} catch (error) {
		console.error(error.message);
		if (error.meta) console.error(JSON.stringify(error.meta));
		process.exit(1);
	}
}

function invokedDirectly() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (invokedDirectly()) main();
