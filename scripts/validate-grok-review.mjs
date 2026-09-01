#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALLOWED_SEVERITIES = new Set(["P0", "P1", "P2"]);
const FINDING_KEYS = ["body", "id", "line", "path", "severity", "title"];
const ID_PATTERN = /^grok-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
/** Hard per-document ceiling for a single chunk/model response. */
export const MAX_FINDINGS_PER_DOCUMENT = 20;
/** Floor for the adaptive multi-chunk union bound. */
export const MIN_UNION_FINDINGS = 20;
/** Absolute hard ceiling for the adaptive multi-chunk union bound. */
export const MAX_UNION_FINDINGS = 200;
/** Per-chunk contribution to the adaptive union bound. */
export const UNION_FINDINGS_PER_CHUNK = 10;
const SEVERITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2 });

/** @deprecated Prefer MAX_FINDINGS_PER_DOCUMENT; kept for older callers. */
const MAX_FINDINGS = MAX_FINDINGS_PER_DOCUMENT;

function stripFence(raw) {
	const trimmed = raw.trim();
	const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
	return match ? match[1].trim() : trimmed;
}

function assertText(value, field, maximum) {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${field} must be non-empty`);
	if (trimmed.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
	return trimmed;
}

/**
 * Repair common model id drift without weakening the final pattern:
 * lowercase, underscores/dots/spaces→hyphens, strip illegal chars, ensure
 * grok- prefix. Still fail closed if the result is not a stable grok-* slug.
 */
export function normalizeFindingId(raw, label = "id") {
	if (typeof raw !== "string") throw new Error(`${label} must be a string`);
	let value = raw.trim().toLowerCase();
	value = value.replace(/[_\s.]+/gu, "-");
	value = value.replace(/[^a-z0-9-]/gu, "");
	value = value.replace(/-+/gu, "-").replace(/^-|-$/gu, "");
	if (!value.startsWith("grok-")) {
		value = value.startsWith("grok") ? `grok-${value.slice(4).replace(/^-/, "")}` : `grok-${value}`;
	}
	value = value.replace(/-+/gu, "-").replace(/^-|-$/gu, "");
	if (!value || value === "grok") throw new Error(`${label} produced empty grok slug`);
	if (!ID_PATTERN.test(value)) throw new Error(`${label} must match ${ID_PATTERN}`);
	return value;
}

/**
 * Adaptive but hard union ceiling for multi-chunk reviews.
 * `min(200, max(20, chunkCount * 10))`
 *
 * @param {number} chunkCount
 */
export function adaptiveUnionCap(chunkCount) {
	if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) {
		throw new Error("chunkCount must be a non-negative integer");
	}
	return Math.min(MAX_UNION_FINDINGS, Math.max(MIN_UNION_FINDINGS, chunkCount * UNION_FINDINGS_PER_CHUNK));
}

/**
 * Canonicalize a repo-relative path for location identity (no silent remap of
 * meaning — only slash normalization and trim).
 * @param {string} path
 */
export function canonicalizeFindingPath(path) {
	if (typeof path !== "string") throw new Error("path must be a string");
	let value = path.trim().replace(/\\/gu, "/");
	while (value.startsWith("./")) value = value.slice(2);
	if (!value || value.includes("\0")) throw new Error(`invalid finding path: ${path}`);
	if (value.startsWith("/") || /^[a-z]:/iu.test(value)) {
		throw new Error(`finding path must be repository-relative: ${path}`);
	}
	return value;
}

/**
 * Normalize substantive message text for cross-chunk duplicate collapse.
 * @param {string} title
 * @param {string} body
 */
export function normalizeSubstantiveMessage(title, body) {
	return `${title}\n${body}`.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Content identity used to collapse the same defect reported under different ids.
 * @param {{ path: string, line: number | null, title: string, body: string }} finding
 */
export function findingContentKey(finding) {
	return JSON.stringify([
		canonicalizeFindingPath(finding.path),
		finding.line,
		normalizeSubstantiveMessage(finding.title, finding.body),
	]);
}

function findingFingerprint(finding) {
	return JSON.stringify([
		finding.id,
		finding.severity,
		canonicalizeFindingPath(finding.path),
		finding.line,
		finding.title,
		finding.body,
	]);
}

export function normalizeGrokReview(raw, changedPaths) {
	let parsed;
	try {
		parsed = JSON.parse(stripFence(raw));
	} catch (error) {
		throw new Error(`Grok output is not one JSON document: ${error.message}`);
	}
	if (!Array.isArray(parsed)) throw new Error("Grok output must be a JSON array");
	if (parsed.length > MAX_FINDINGS_PER_DOCUMENT) {
		throw new Error(`Grok output exceeds ${MAX_FINDINGS_PER_DOCUMENT} findings`);
	}

	const allowedPaths = new Set(changedPaths.map((path) => canonicalizeFindingPath(path)));
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

		const id = normalizeFindingId(finding.id, `${label}.id`);
		if (ids.has(id)) throw new Error(`${label}.id duplicates ${id}`);
		ids.add(id);

		if (!ALLOWED_SEVERITIES.has(finding.severity)) {
			throw new Error(`${label}.severity must be P0, P1, or P2`);
		}
		const path = canonicalizeFindingPath(assertText(finding.path, `${label}.path`, 512));
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

/**
 * Prefer the higher-severity finding; ties break on stable id then title.
 * @param {ReturnType<typeof normalizeGrokReview>[number]} left
 * @param {ReturnType<typeof normalizeGrokReview>[number]} right
 */
function preferFinding(left, right) {
	const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
	if (severity !== 0) return severity < 0 ? left : right;
	const id = left.id.localeCompare(right.id);
	if (id !== 0) return id < 0 ? left : right;
	return left.title.localeCompare(right.title) <= 0 ? left : right;
}

/**
 * Sort findings: severity → path → line → id.
 * @param {ReturnType<typeof normalizeGrokReview>} findings
 */
export function sortFindings(findings) {
	return [...findings].sort((left, right) => {
		const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
		if (severity !== 0) return severity;
		const path = left.path.localeCompare(right.path);
		if (path !== 0) return path;
		const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
		const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
		if (leftLine !== rightLine) return leftLine - rightLine;
		return left.id.localeCompare(right.id);
	});
}

/**
 * Union validated per-chunk findings.
 *
 * 1. Same id + identical payload → collapse
 * 2. Same id + conflicting payload → fail closed
 * 3. Different ids + same path/line/substantive message → collapse (keep preferred)
 * 4. Apply adaptive hard cap after dedupe (never silently drop)
 *
 * On overflow the error carries the full validated list so callers can write
 * artifacts before failing closed.
 *
 * @param {Array<ReturnType<typeof normalizeGrokReview>>} chunkFindingsList
 * @param {{ chunkCount?: number }} [options]
 * @returns {ReturnType<typeof normalizeGrokReview>}
 */
export function unionGrokFindings(chunkFindingsList, options = {}) {
	if (!Array.isArray(chunkFindingsList)) {
		throw new Error("chunk findings list must be an array");
	}
	const chunkCount =
		options.chunkCount !== undefined ? options.chunkCount : chunkFindingsList.length;
	const adaptiveCap = adaptiveUnionCap(chunkCount);

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
			byId.set(finding.id, {
				...finding,
				path: canonicalizeFindingPath(finding.path),
			});
		}
	}

	// Collapse content-identical defects reported under different ids.
	const byContent = new Map();
	for (const finding of byId.values()) {
		const key = findingContentKey(finding);
		const prior = byContent.get(key);
		if (!prior) {
			byContent.set(key, finding);
			continue;
		}
		byContent.set(key, preferFinding(prior, finding));
	}

	const merged = sortFindings([...byContent.values()]);

	if (merged.length > adaptiveCap) {
		const error = new Error(
			`union exceeds adaptive cap ${adaptiveCap} findings (got ${merged.length}; chunkCount=${chunkCount})`,
		);
		error.code = "union-overflow";
		error.overflow = true;
		error.adaptiveCap = adaptiveCap;
		error.chunkCount = chunkCount;
		/** Full validated list — never truncated. */
		error.findings = merged;
		throw error;
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
