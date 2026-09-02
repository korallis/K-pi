import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isJsonObject } from "../../extensions/graph/schema.ts";
import { readTree, type Tree } from "./tree.ts";

export const HEX40 = /^[0-9a-f]{40}$/u;
export const SHA256 = /^[0-9a-f]{64}$/u;

export class ProvenanceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProvenanceError";
	}
}

export interface PatchRecord {
	readonly name: string;
	readonly sha256: string;
}

/**
 * Everything a generated tree can be traced back to.
 *
 * The point is that no field is derivable from the shipped bytes alone. A tree
 * that looks right proves nothing: it has to be the tree this commit's pstack
 * subtree produces, under these transforms, with these patches in this order,
 * carrying this licence. Each field is one of those claims, and every one of them
 * is re-checked on every run.
 */
export interface Provenance {
	readonly origin: {
		readonly repository: string;
		readonly path: string;
		readonly commit: string;
		readonly treeOid: string;
	};
	/** Digest over the overlay: transforms, data files, and first-party source. */
	readonly transformVersion: string;
	/** Patches in the order they are applied. */
	readonly patches: readonly PatchRecord[];
	readonly license: {
		readonly path: string;
		readonly spdx: string;
		readonly holder: string;
		readonly sha256: string;
	};
	readonly overlayVersion: number;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProvenanceError(`provenance ${field} must be a non-empty string`);
	}
	return value;
}

function requireHex40(value: unknown, field: string): string {
	const text = requireString(value, field);
	if (!HEX40.test(text)) {
		throw new ProvenanceError(`provenance ${field} must be a 40-character hex object id, got ${text}`);
	}
	return text;
}

function requireSha256(value: unknown, field: string): string {
	const text = requireString(value, field);
	if (!SHA256.test(text)) {
		throw new ProvenanceError(`provenance ${field} must be a sha256 digest, got ${text}`);
	}
	return text;
}

/**
 * Parses and validates the machine-readable record.
 *
 * Strict on purpose: a short commit, a missing tree id, an unnamed patch or a
 * non-digest licence hash means the record cannot support the checks that follow,
 * and continuing would produce a green run that proved nothing.
 */
export function parseProvenance(source: string): Provenance {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new ProvenanceError("provenance.json is not valid JSON");
	}
	if (!isJsonObject(parsed)) {
		throw new ProvenanceError("provenance.json is not an object");
	}
	const origin = parsed.origin;
	if (!isJsonObject(origin)) {
		throw new ProvenanceError("provenance origin is missing");
	}
	const license = parsed.license;
	if (!isJsonObject(license)) {
		throw new ProvenanceError("provenance license is missing");
	}
	if (!Array.isArray(parsed.patches)) {
		throw new ProvenanceError("provenance patches must be an array, even when empty");
	}
	const patches = parsed.patches.map((entry, index) => {
		if (!isJsonObject(entry)) {
			throw new ProvenanceError(`provenance patch ${index} is not an object`);
		}
		const name = requireString(entry.name, `patch ${index} name`);
		if (!name.endsWith(".patch") || name.includes("/")) {
			throw new ProvenanceError(`provenance patch ${index} name must be a bare *.patch file, got ${name}`);
		}
		return { name, sha256: requireSha256(entry.sha256, `patch ${index} sha256`) };
	});
	const names = patches.map((entry) => entry.name);
	if (new Set(names).size !== names.length) {
		throw new ProvenanceError("provenance lists the same patch twice");
	}
	const path = requireString(origin.path, "origin.path");
	if (!path.endsWith("/")) {
		throw new ProvenanceError(`origin.path must name a subtree ending in "/", got ${path}`);
	}
	if (typeof parsed.overlayVersion !== "number" || !Number.isInteger(parsed.overlayVersion)) {
		throw new ProvenanceError("provenance overlayVersion must be an integer");
	}

	return {
		origin: {
			repository: requireString(origin.repository, "origin.repository"),
			path,
			commit: requireHex40(origin.commit, "origin.commit"),
			treeOid: requireHex40(origin.treeOid, "origin.treeOid"),
		},
		transformVersion: requireSha256(parsed.transformVersion, "transformVersion"),
		patches,
		license: {
			path: requireString(license.path, "license.path"),
			spdx: requireString(license.spdx, "license.spdx"),
			holder: requireString(license.holder, "license.holder"),
			sha256: requireSha256(license.sha256, "license.sha256"),
		},
		overlayVersion: parsed.overlayVersion,
	};
}

export async function readProvenance(path: string): Promise<Provenance> {
	const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			throw new ProvenanceError(`provenance.json is missing at ${path}`);
		}
		throw error;
	});
	return parseProvenance(source);
}

export interface UpstreamTable {
	readonly source?: string;
	readonly path?: string;
	readonly commit?: string;
	readonly treeOid?: string;
	readonly version?: string;
	readonly overlay?: string;
}

/** Reads the human-facing table `docs/kstack.md` specifies. */
export function parseUpstreamDocument(source: string): UpstreamTable {
	const rows = new Map<string, string>();
	for (const line of source.split("\n")) {
		const match = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/u.exec(line.trim());
		if (match !== null) {
			rows.set(match[1].toLowerCase(), match[2]);
		}
	}
	return {
		source: rows.get("source"),
		path: rows.get("path"),
		commit: rows.get("commit"),
		treeOid: rows.get("pstack tree"),
		version: rows.get("upstream version"),
		overlay: rows.get("k-stack overlay"),
	};
}

/**
 * The two records must agree.
 *
 * One is read by a maintainer and one by the pipeline. A disagreement means the
 * pin a human believes is in force is not the pin being verified, so it is a
 * refusal rather than a preference for whichever file the code happens to read.
 */
export function assertRecordsAgree(provenance: Provenance, table: UpstreamTable): void {
	const mismatches: string[] = [];
	if (table.commit !== provenance.origin.commit) {
		mismatches.push(`commit: UPSTREAM.md ${String(table.commit)} vs provenance ${provenance.origin.commit}`);
	}
	if (table.treeOid !== provenance.origin.treeOid) {
		mismatches.push(`pstack tree: UPSTREAM.md ${String(table.treeOid)} vs provenance ${provenance.origin.treeOid}`);
	}
	if (table.path !== provenance.origin.path) {
		mismatches.push(`path: UPSTREAM.md ${String(table.path)} vs provenance ${provenance.origin.path}`);
	}
	if (table.source !== provenance.origin.repository) {
		mismatches.push(`source: UPSTREAM.md ${String(table.source)} vs provenance ${provenance.origin.repository}`);
	}
	if (table.overlay !== String(provenance.overlayVersion)) {
		mismatches.push(`overlay: UPSTREAM.md ${String(table.overlay)} vs provenance ${provenance.overlayVersion}`);
	}
	if (mismatches.length > 0) {
		throw new ProvenanceError(`UPSTREAM.md and provenance.json disagree:\n  ${mismatches.join("\n  ")}`);
	}
}

/** Files whose bytes define what the transforms do. */
export const TRANSFORM_INPUTS = ["transforms.ts", "config.json", "rename-map.json", "forbidden.txt"] as const;

/**
 * A digest over everything that decides the output shape.
 *
 * Derived, never authored: editing a rule without re-syncing changes this value,
 * so `--check` catches a generated tree that no longer matches the rules that
 * produced it. First-party overlay source is included because it ships verbatim.
 */
export async function computeTransformVersion(overlayDirectory: string): Promise<string> {
	const hash = createHash("sha256");
	for (const name of TRANSFORM_INPUTS) {
		hash
			.update(name)
			.update("\0")
			.update(await readFile(join(overlayDirectory, name)))
			.update("\0");
	}
	const source: Tree = await readTree(join(overlayDirectory, "source"));
	for (const [path, entry] of [...source].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(`source/${path}`).update("\0").update(entry.bytes).update("\0");
	}
	return hash.digest("hex");
}

export function digestBytes(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verifies the patch set on disk is exactly the recorded one, in order.
 *
 * An unrecorded patch, a missing one, a reordering, or an edited one all change
 * what the generated tree means, so all four are the same refusal.
 */
export async function resolvePatchSet(patchDirectory: string, recorded: readonly PatchRecord[]): Promise<string[]> {
	const present = (
		await readdir(patchDirectory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				return [] as string[];
			}
			throw error;
		})
	)
		.filter((name) => name.endsWith(".patch"))
		.sort();
	const expected = recorded.map((entry) => entry.name);
	if (present.length !== expected.length || present.some((name, index) => name !== expected[index])) {
		throw new ProvenanceError(
			`patch set does not match provenance: on disk [${present.join(", ")}], recorded [${expected.join(", ")}]`,
		);
	}
	for (const entry of recorded) {
		const digest = digestBytes(await readFile(join(patchDirectory, entry.name)));
		if (digest !== entry.sha256) {
			throw new ProvenanceError(`patch ${entry.name} has digest ${digest}, provenance records ${entry.sha256}`);
		}
	}
	return expected;
}

const MIT_CLAUSES = [
	"MIT License",
	"Permission is hereby granted, free of charge",
	"The above copyright notice and this permission notice shall be included",
	'THE SOFTWARE IS PROVIDED "AS IS"',
	"WITHOUT WARRANTY OF ANY KIND",
];

/**
 * The licence must be present, unmodified, and still a licence.
 *
 * Three separate claims. The digest catches any edit; the clause list catches a
 * file that was replaced with something that hashes fine but grants nothing; the
 * holder catches attribution being quietly dropped, which is the obligation the
 * whole vendoring rests on.
 */

/**
 * Derives licence provenance from a freshly staged subtree.
 *
 * A pin that moves the tree may bring a new licence file - a new year, a new
 * holder, a reformatted body. Validating it against the *old* digest would make
 * every real upstream move impossible, and trusting it blindly would let the
 * obligation quietly disappear. So the digest and holder are re-derived, and the
 * clause set is checked in full before either is recorded.
 */
export function deriveLicense(
	tree: ReadonlyMap<string, { bytes: Buffer }>,
	licensePath: string,
	spdx: string,
): Provenance["license"] {
	const entry = tree.get(licensePath);
	if (entry === undefined) {
		throw new ProvenanceError(`the pinned subtree has no licence at ${licensePath}`);
	}
	const text = entry.bytes.toString("utf8");
	for (const clause of MIT_CLAUSES) {
		if (!text.includes(clause)) {
			throw new ProvenanceError(`${licensePath} in the pinned subtree is missing the clause: ${clause}`);
		}
	}
	const holder = /Copyright \(c\)\s*(?:\d{4}(?:\s*[-\u2013]\s*\d{4})?)?\s*(.+)/u.exec(text)?.[1]?.trim();
	if (holder === undefined || holder.length === 0) {
		throw new ProvenanceError(`${licensePath} in the pinned subtree names no copyright holder`);
	}
	return { path: licensePath, spdx, holder, sha256: digestBytes(entry.bytes) };
}

export function assertLicense(tree: ReadonlyMap<string, { bytes: Buffer }>, provenance: Provenance): void {
	const entry = tree.get(provenance.license.path);
	if (entry === undefined) {
		throw new ProvenanceError(`the licence is missing from the generated tree: ${provenance.license.path}`);
	}
	const text = entry.bytes.toString("utf8");
	const digest = digestBytes(entry.bytes);
	if (digest !== provenance.license.sha256) {
		throw new ProvenanceError(
			`${provenance.license.path} has digest ${digest}, provenance records ${provenance.license.sha256}`,
		);
	}
	for (const clause of MIT_CLAUSES) {
		if (!text.includes(clause)) {
			throw new ProvenanceError(`${provenance.license.path} is missing the clause: ${clause}`);
		}
	}
	if (!text.includes(provenance.license.holder)) {
		throw new ProvenanceError(`${provenance.license.path} no longer names ${provenance.license.holder}`);
	}
}

/**
 * Any generated JSON that claims to be a K-stack models map must be one.
 *
 * Cheap and worth it: a malformed map is only discovered at spawn time otherwise,
 * when a worker starts on a model nobody chose.
 */
export function assertModelsJson(tree: ReadonlyMap<string, { bytes: Buffer }>): void {
	for (const [path, entry] of tree) {
		if (!/(^|\/)models\.json$/u.test(path)) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(entry.bytes.toString("utf8"));
		} catch {
			throw new ProvenanceError(`${path} is not parseable JSON`);
		}
		if (!isJsonObject(parsed) || parsed.version !== 1 || !isJsonObject(parsed.roles)) {
			throw new ProvenanceError(`${path} is not a version 1 K-stack models map`);
		}
		for (const [role, value] of Object.entries(parsed.roles)) {
			const values = Array.isArray(value) ? value : [value];
			for (const slug of values) {
				if (typeof slug !== "string" || slug.trim().length === 0) {
					throw new ProvenanceError(`${path} role ${role} has a non-string model`);
				}
			}
		}
	}
}
