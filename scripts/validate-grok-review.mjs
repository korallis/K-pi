#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALLOWED_SEVERITIES = new Set(["P0", "P1", "P2"]);
const FINDING_KEYS = ["body", "id", "line", "path", "severity", "title"];
const ID_PATTERN = /^grok-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const MAX_FINDINGS = 20;
const SEVERITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2 });


function stripFence(raw) {
	const trimmed = raw.trim();
	const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
	return match ? match[1].trim() : trimmed;
}

function assertText(value, field, maximum) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
	if (value.includes("\0")) throw new Error(`${field} contains a NUL byte`);
	return value.trim();
}

export function normalizeGrokReview(raw, changedPaths) {
	let parsed;
	try {
		parsed = JSON.parse(stripFence(raw));
	} catch (error) {
		throw new Error(`Grok output is not one JSON document: ${error.message}`);
	}
	if (!Array.isArray(parsed)) throw new Error("Grok output must be a JSON array");
	if (parsed.length > MAX_FINDINGS) throw new Error(`Grok output exceeds ${MAX_FINDINGS} findings`);

	const allowedPaths = new Set(changedPaths);
	const ids = new Set();
	return parsed.map((finding, index) => {
		const label = `finding ${index + 1}`;
		if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
			throw new Error(`${label} must be an object`);
		}
		const keys = Object.keys(finding).sort();
		if (keys.length !== FINDING_KEYS.length || keys.some((key, keyIndex) => key !== FINDING_KEYS[keyIndex])) {
			throw new Error(`${label} must contain exactly ${FINDING_KEYS.join(", ")}`);
		}

		const id = assertText(finding.id, `${label}.id`, 64);
		if (!ID_PATTERN.test(id)) throw new Error(`${label}.id must match ${ID_PATTERN}`);
		if (ids.has(id)) throw new Error(`${label}.id duplicates ${id}`);
		ids.add(id);

		if (!ALLOWED_SEVERITIES.has(finding.severity)) {
			throw new Error(`${label}.severity must be P0, P1, or P2`);
		}
		const path = assertText(finding.path, `${label}.path`, 512);
		if (!allowedPaths.has(path)) throw new Error(`${label}.path is not a changed path: ${path}`);
		if (finding.line !== null && (!Number.isSafeInteger(finding.line) || finding.line <= 0)) {
			throw new Error(`${label}.line must be null or a positive integer`);
		}

		return {
			id,
			severity: finding.severity,
			path,
			line: finding.line,
			title: assertText(finding.title, `${label}.title`, 160),
			body: assertText(finding.body, `${label}.body`, 2000),
		};
	});
}

function findingFingerprint(finding) {
	return JSON.stringify([
		finding.id,
		finding.severity,
		finding.path,
		finding.line,
		finding.title,
		finding.body,
	]);
}

/**
 * Union validated per-chunk findings. Identical ids collapse; conflicting
 * payloads for the same id fail closed. Order is severity → path → line → id.
 *
 * @param {Array<ReturnType<typeof normalizeGrokReview>>} chunkFindingsList
 */
export function unionGrokFindings(chunkFindingsList) {
	if (!Array.isArray(chunkFindingsList)) {
		throw new Error("chunk findings list must be an array");
	}
	const byId = new Map();
	for (let chunkIndex = 0; chunkIndex < chunkFindingsList.length; chunkIndex++) {
		const findings = chunkFindingsList[chunkIndex];
		if (!Array.isArray(findings)) {
			throw new Error(`chunk ${chunkIndex} findings must be an array`);
		}
		for (const finding of findings) {
			const prior = byId.get(finding.id);
			if (prior) {
				if (findingFingerprint(prior) !== findingFingerprint(finding)) {
					throw new Error(`conflicting findings for id ${finding.id} across chunks`);
				}
				continue;
			}
			byId.set(finding.id, finding);
		}
	}

	const merged = [...byId.values()].sort((left, right) => {
		const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
		if (severity !== 0) return severity;
		const path = left.path.localeCompare(right.path);
		if (path !== 0) return path;
		const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
		const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
		if (leftLine !== rightLine) return leftLine - rightLine;
		return left.id.localeCompare(right.id);
	});

	if (merged.length > MAX_FINDINGS) {
		throw new Error(`union exceeds ${MAX_FINDINGS} findings`);
	}
	return merged;
}


function main() {
	const [rawPath, changedPathsPath, outputPath] = process.argv.slice(2);
	if (!rawPath || !changedPathsPath || !outputPath) {
		console.error("usage: validate-grok-review.mjs <raw-output> <nul-changed-paths> <normalized-output>");
		process.exit(2);
	}
	const raw = readFileSync(rawPath, "utf8");
	const changedPaths = readFileSync(changedPathsPath, "utf8").split("\0").filter(Boolean);
	const findings = normalizeGrokReview(raw, changedPaths);
	writeFileSync(outputPath, `${JSON.stringify(findings, null, 2)}\n`);
	console.log(`validated ${findings.length} Grok finding(s)`);
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
