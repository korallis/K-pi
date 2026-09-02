/**
 * Knowledge graph record contract. Pure shape and reference validation, so the
 * control plane can prove a patch before it touches an authoritative file.
 */

import { isJsonObject } from "../graph/schema.ts";

export const CLAIM_STATUSES = ["proposed", "verified", "rejected", "superseded"] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export type KnowledgeGraphKind = "source" | "node" | "edge";

/** Authoritative file per record kind. */
export const RECORD_FILES: Record<KnowledgeGraphKind, string> = {
	source: "sources.jsonl",
	node: "nodes.jsonl",
	edge: "edges.jsonl",
};

/** Applied in this order, so one patch may cite a source and a node it adds. */
export const PATCH_KINDS: readonly KnowledgeGraphKind[] = ["source", "node", "edge"];

/**
 * A claim as proposed. `rev` is optional because the control plane stamps it;
 * when a proposal states one it must be the next revision.
 */
export interface ClaimInputEnvelope {
	id: string;
	kind: string;
	source_ids: string[];
	status: ClaimStatus;
	observed_at: string;
	rev?: number;
	valid_from?: string;
	valid_to?: string;
	[key: string]: unknown;
}

/** A claim as stored. The revision is no longer optional. */
export interface ClaimEnvelope extends ClaimInputEnvelope {
	rev: number;
}

export type NodeInput = ClaimInputEnvelope;

export interface EdgeInput extends ClaimInputEnvelope {
	from: string;
	to: string;
	/** Only meaningful on an inferred edge. */
	confidence?: number;
}

export interface SourceInput extends ClaimInputEnvelope {
	uri: string;
}

export type KnowledgeGraphNode = ClaimEnvelope;

export interface KnowledgeGraphEdge extends ClaimEnvelope {
	from: string;
	to: string;
	confidence?: number;
}

export interface KnowledgeGraphSource extends ClaimEnvelope {
	uri: string;
}

/** One inbox patch. At least one kind, applied source then node then edge. */
export interface KnowledgeGraphPatch {
	source?: SourceInput;
	node?: NodeInput;
	edge?: EdgeInput;
}

/** The authoritative store as read from disk. */
export interface KnowledgeGraphState {
	sources: KnowledgeGraphSource[];
	nodes: KnowledgeGraphNode[];
	edges: KnowledgeGraphEdge[];
}

export interface AcceptedRecords {
	source?: KnowledgeGraphSource;
	node?: KnowledgeGraphNode;
	edge?: KnowledgeGraphEdge;
}

/** RFC 3339 date-time, then a real-instant check. */
const OBSERVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;

function assertEnvelope(value: unknown, label: string): void {
	if (!isJsonObject(value)) {
		throw new Error(`${label} must be an object`);
	}
	for (const field of ["id", "kind"] as const) {
		const text = value[field];
		if (typeof text !== "string" || text.length === 0) {
			throw new Error(`${label}.${field} is required`);
		}
	}
	if (!Array.isArray(value.source_ids) || value.source_ids.some((id) => typeof id !== "string" || id.length === 0)) {
		throw new Error(`${label}.source_ids must be an array of source ids`);
	}
	if (typeof value.status !== "string" || !CLAIM_STATUSES.includes(value.status as ClaimStatus)) {
		throw new Error(`${label}.status must be one of ${CLAIM_STATUSES.join(", ")}`);
	}
	if (
		typeof value.observed_at !== "string" ||
		!OBSERVED_AT_PATTERN.test(value.observed_at) ||
		Number.isNaN(Date.parse(value.observed_at))
	) {
		throw new Error(`${label}.observed_at must be an RFC 3339 date-time`);
	}
	for (const field of ["valid_from", "valid_to"] as const) {
		const instant = value[field];
		if (instant !== undefined && (typeof instant !== "string" || Number.isNaN(Date.parse(instant)))) {
			throw new Error(`${label}.${field} must be an RFC 3339 date-time`);
		}
	}
	const rev = value.rev;
	if (rev !== undefined && (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1)) {
		throw new Error(`${label}.rev must be a positive integer`);
	}
}

/**
 * Shape of an inbox patch: minimum fields, status enum, and the per-kind
 * extras. Cross-file references and revisions are the control plane's
 * business and are checked at acceptance against the stored state.
 */
export function validatePatch(value: unknown): asserts value is KnowledgeGraphPatch {
	if (!isJsonObject(value)) {
		throw new Error("knowledge graph patch must be an object");
	}
	for (const key of Object.keys(value)) {
		if (!PATCH_KINDS.includes(key as KnowledgeGraphKind)) {
			throw new Error(`knowledge graph patch has an unsupported member ${key}`);
		}
	}
	const kinds = PATCH_KINDS.filter((kind) => value[kind] !== undefined);
	if (kinds.length === 0) {
		throw new Error("knowledge graph patch must carry a source, a node, or an edge");
	}
	for (const kind of kinds) {
		assertEnvelope(value[kind], `patch ${kind}`);
	}

	const source = value.source;
	if (isJsonObject(source)) {
		const uri = source.uri;
		if (typeof uri !== "string" || uri.length === 0) {
			throw new Error("patch source.uri is required");
		}
	}
	const node = value.node;
	if (isJsonObject(node) && (node.source_ids as string[]).length === 0) {
		throw new Error("patch node.source_ids must cite at least one source");
	}
	const edge = value.edge;
	if (isJsonObject(edge)) {
		for (const field of ["from", "to"] as const) {
			const endpoint = edge[field];
			if (typeof endpoint !== "string" || endpoint.length === 0) {
				throw new Error(`patch edge.${field} is required`);
			}
		}
		if ((edge.source_ids as string[]).length === 0) {
			throw new Error("patch edge.source_ids must cite at least one source");
		}
		const confidence = edge.confidence;
		if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
			throw new Error("patch edge.confidence must be between 0 and 1");
		}
	}
}

function nextRevision(
	existing: readonly ClaimEnvelope[],
	id: string,
	requested: number | undefined,
	label: string,
): number {
	const current = existing.filter((record) => record.id === id).reduce((rev, record) => Math.max(rev, record.rev), 0);
	const next = current + 1;
	if (requested !== undefined && requested !== next) {
		throw new Error(`${label} revision must be monotonic: expected ${next}, received ${requested}`);
	}
	return next;
}

/**
 * Validates a patch against the stored state and stamps the next revision for
 * every record it carries. Rejects a dangling source reference, a dangling
 * edge endpoint, and any revision that is not the stored maximum plus one.
 */
export function resolveAcceptance(patch: KnowledgeGraphPatch, state: KnowledgeGraphState): AcceptedRecords {
	const accepted: AcceptedRecords = {};

	if (patch.source !== undefined) {
		accepted.source = {
			...patch.source,
			rev: nextRevision(state.sources, patch.source.id, patch.source.rev, `source ${patch.source.id}`),
		};
	}

	const sourceIds = new Set(state.sources.map((source) => source.id));
	if (accepted.source !== undefined) {
		sourceIds.add(accepted.source.id);
	}
	const nodeIds = new Set(state.nodes.map((node) => node.id));

	if (patch.node !== undefined) {
		for (const id of patch.node.source_ids) {
			if (!sourceIds.has(id)) {
				throw new Error(`node ${patch.node.id} cites unknown source ${id}`);
			}
		}
		const node: KnowledgeGraphNode = {
			...patch.node,
			rev: nextRevision(state.nodes, patch.node.id, patch.node.rev, `node ${patch.node.id}`),
		};
		accepted.node = node;
		nodeIds.add(node.id);
	}

	if (patch.edge !== undefined) {
		for (const id of patch.edge.source_ids) {
			if (!sourceIds.has(id)) {
				throw new Error(`edge ${patch.edge.id} cites unknown source ${id}`);
			}
		}
		for (const endpoint of [patch.edge.from, patch.edge.to]) {
			if (!nodeIds.has(endpoint)) {
				throw new Error(`edge ${patch.edge.id} references unknown node ${endpoint}`);
			}
		}
		accepted.edge = {
			...patch.edge,
			rev: nextRevision(state.edges, patch.edge.id, patch.edge.rev, `edge ${patch.edge.id}`),
		};
	}

	return accepted;
}
