import { isDeepStrictEqual } from "node:util";

export interface ContextModel {
	provider: string;
	id: string;
}
/** Counts the supplied text with the actual model tokenizer, never a character/byte heuristic. */
export interface ContextTokenizer {
	id: string;
	supports(model: ContextModel): boolean;
	countTokens(text: string, model: ContextModel): Promise<number | null>;
}
export type ContextEncoding = "json" | "compact-json" | "json-toon-tables";
type Scalar = string | number | boolean | null;
type Json = Scalar | Json[] | { [key: string]: Json };
type JsonPath = Array<string | number>;
export interface SerializationMeasurement {
	encoding: ContextEncoding;
	bytes: number;
	measuredTokens: number | null;
	recovery: { exact: boolean; fields: number; recoveredFields: number; tables: number };
}
export interface ContextSerialization {
	text: string;
	encoding: ContextEncoding;
	budgetCost: number;
	measuredTokens: number | null;
	tokenizer: {
		id: string | null;
		model: ContextModel | null;
		status: "measured" | "unsupported";
		reason: string | null;
		scope: "serialized-context-text";
	};
	candidates: SerializationMeasurement[];
}

function fieldCount(value: Json): number {
	if (value === null || typeof value !== "object") return 1;
	return Object.values(value).reduce<number>((sum, entry) => sum + fieldCount(entry), Object.keys(value).length);
}
function scalar(value: Json): value is Scalar {
	return value === null || typeof value !== "object";
}
function toonStringSupported(value: string): boolean {
	// TOON does not permit JSON's \u, \b or \f escapes or unpaired surrogates.
	return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) && !/[\uD800-\uDFFF]/u.test(value);
}
function table(value: Json): string | undefined {
	if (!Array.isArray(value) || value.length < 2) return undefined;
	const first = value[0];
	if (!first || Array.isArray(first) || typeof first !== "object") return undefined;
	const keys = Object.keys(first);
	if (!keys.length || !keys.every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))) return undefined;
	for (const row of value) {
		if (!row || Array.isArray(row) || typeof row !== "object" || !isDeepStrictEqual(Object.keys(row), keys))
			return undefined;
		if (!Object.values(row).every((cell) => scalar(cell) && (typeof cell !== "string" || toonStringSupported(cell))))
			return undefined;
	}
	return `[${value.length}]{${keys.join(",")}}:\n${value.map((row) => `  ${keys.map((key) => JSON.stringify((row as Record<string, Scalar>)[key])).join(",")}`).join("\n")}`;
}

/** Strict decoder for the emitted flat, comma-delimited TOON subset; not a general TOON parser. */
export function decodeToonTable(text: string): Array<Record<string, Scalar>> {
	const lines = text.split("\n");
	const header = /^\[(\d+)\]\{([A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)*)\}:$/u.exec(lines[0]);
	if (!header || Number(header[1]) !== lines.length - 1) throw new Error("Invalid TOON table length/header");
	const keys = header[2].split(",");
	if (new Set(keys).size !== keys.length) throw new Error("Duplicate TOON table columns");
	return lines.slice(1).map((line) => {
		if (!line.startsWith("  ") || line.startsWith("   ")) throw new Error("Invalid TOON table indentation");
		const cells: Json[] = JSON.parse(`[${line.slice(2)}]`);
		if (
			cells.length !== keys.length ||
			!cells.every(
				(cell) =>
					scalar(cell) &&
					(typeof cell !== "number" || Number.isFinite(cell)) &&
					(typeof cell !== "string" || toonStringSupported(cell)),
			)
		)
			throw new Error("Invalid TOON table cells");
		if (cells.map((cell) => JSON.stringify(cell)).join(",") !== line.slice(2))
			throw new Error("Unsupported noncanonical TOON cell encoding");
		return Object.fromEntries(keys.map((key, index) => [key, cells[index] as Scalar]));
	});
}

interface TableHeader {
	path: JsonPath;
	lines: number;
}
/** A JSON header preserves irregular structure; only homogeneous scalar records become raw TOON tables. */
function encodeTables(canonical: Json): { text: string; tables: number } | undefined {
	const headers: TableHeader[] = [];
	const tables: string[] = [];
	const visit = (value: Json, path: JsonPath): Json => {
		const encoded = table(value);
		if (encoded !== undefined) {
			headers.push({ path, lines: (value as Json[]).length + 1 });
			tables.push(encoded);
			return null;
		}
		if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index]));
		if (value !== null && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry, [...path, key])]));
		return value;
	};
	const data = visit(canonical, []);
	if (!tables.length) return undefined;
	return {
		text: `${JSON.stringify({ encoding: "json-toon-tables-v1", tables: headers, data })}\n${tables.join("\n")}`,
		tables: tables.length,
	};
}

export function decodeContextSerialization(text: string, encoding: ContextEncoding): unknown {
	if (encoding !== "json-toon-tables") return JSON.parse(text);
	const lines = text.split("\n");
	const envelope = JSON.parse(lines[0]);
	if (
		envelope.encoding !== "json-toon-tables-v1" ||
		!Array.isArray(envelope.tables) ||
		!Object.hasOwn(envelope, "data")
	)
		throw new Error("Invalid context table envelope");
	let offset = 1;
	const seen = new Set<string>();
	for (const entry of envelope.tables) {
		if (
			!Array.isArray(entry.path) ||
			!entry.path.every(
				(part: unknown) =>
					typeof part === "string" || (typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
			) ||
			!Number.isSafeInteger(entry.lines) ||
			entry.lines < 3 ||
			offset + entry.lines > lines.length
		)
			throw new Error("Invalid context table reference");
		const key = JSON.stringify(entry.path);
		if (seen.has(key)) throw new Error("Duplicate context table reference");
		seen.add(key);
		const recovered = decodeToonTable(lines.slice(offset, offset + entry.lines).join("\n"));
		offset += entry.lines;
		if (entry.path.length === 0) {
			if (envelope.data !== null) throw new Error("Context table must replace a null placeholder");
			envelope.data = recovered;
			continue;
		}
		let parent = envelope.data;
		for (const part of entry.path.slice(0, -1)) {
			if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, part))
				throw new Error("Missing context table parent");
			parent = parent[part];
		}
		const last = entry.path.at(-1);
		if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, last) || parent[last] !== null)
			throw new Error("Context table must replace a null placeholder");
		Object.defineProperty(parent, last, { value: recovered, enumerable: true, writable: true, configurable: true });
	}
	if (offset !== lines.length) throw new Error("Trailing context table content");
	return envelope.data;
}

/** Reuse within one assembly; failures disable measurement for the remainder, never mixing units. */
export class ContextSerializer {
	private readonly counts = new Map<string, number>();
	private unsupportedReason: string | null;
	private readonly model: ContextModel | undefined;
	private readonly tokenizer: ContextTokenizer | undefined;
	constructor(model?: ContextModel, tokenizer?: ContextTokenizer, unavailableReason?: string | null) {
		this.model = model;
		this.tokenizer = tokenizer;
		this.unsupportedReason =
			unavailableReason ??
			(!model ? "No model identity supplied" : !tokenizer ? "No actual tokenizer supplied" : null);
		if (this.unsupportedReason === null) {
			try {
				if (!tokenizer!.supports(model!)) this.unsupportedReason = "Tokenizer does not support this model";
			} catch {
				this.unsupportedReason = "Tokenizer support check failed";
			}
		}
	}
	async serialize(value: unknown, includePrettyJson = false): Promise<ContextSerialization> {
		const compact = JSON.stringify(value);
		if (compact === undefined) throw new Error("Context must be a JSON value");
		const canonical: Json = JSON.parse(compact);
		if (!isDeepStrictEqual(value, canonical))
			throw new Error("Context contains values that JSON cannot recover exactly");
		const variants: Array<{ encoding: ContextEncoding; text: string; tables: number }> = [
			{ encoding: "compact-json", text: compact, tables: 0 },
		];
		if (includePrettyJson) variants.push({ encoding: "json", text: JSON.stringify(canonical, null, 2), tables: 0 });
		const tables = encodeTables(canonical);
		if (tables) variants.push({ encoding: "json-toon-tables", ...tables });
		const fields = fieldCount(canonical);
		const candidates: SerializationMeasurement[] = [];
		for (const variant of variants) {
			const recovered = decodeContextSerialization(variant.text, variant.encoding) as Json;
			const exact = isDeepStrictEqual(canonical, recovered);
			if (!exact) throw new Error(`Lossy context serialization: ${variant.encoding}`);
			let measuredTokens: number | null = null;
			if (this.unsupportedReason === null) {
				try {
					measuredTokens =
						this.counts.get(variant.text) ?? (await this.tokenizer!.countTokens(variant.text, this.model!));
					if (
						measuredTokens === null ||
						!Number.isSafeInteger(measuredTokens) ||
						measuredTokens < 0 ||
						(variant.text.length > 0 && measuredTokens === 0)
					)
						throw new Error("Unsupported tokenizer result");
					this.counts.set(variant.text, measuredTokens);
					// Keep only the latest comparison, not every growing prompt prefix.
					if (this.counts.size > 3) this.counts.delete(this.counts.keys().next().value!);
				} catch {
					this.unsupportedReason = "Tokenizer unavailable or returned an invalid count";
				}
			}
			candidates.push({
				encoding: variant.encoding,
				bytes: Buffer.byteLength(variant.text, "utf8"),
				measuredTokens,
				recovery: { exact, fields, recoveredFields: fieldCount(recovered), tables: variant.tables },
			});
		}
		// A partial comparison is not evidence for selecting a different serialization.
		if (this.unsupportedReason !== null) for (const candidate of candidates) candidate.measuredTokens = null;
		let selected = 0;
		if (this.unsupportedReason === null)
			for (let index = 1; index < candidates.length; index++)
				if (candidates[index].measuredTokens! < candidates[selected].measuredTokens!) selected = index;
		const result = candidates[selected];
		return {
			text: variants[selected].text,
			encoding: result.encoding,
			budgetCost: result.measuredTokens ?? result.bytes,
			measuredTokens: result.measuredTokens,
			tokenizer: {
				id: this.tokenizer?.id ?? null,
				model: this.model ?? null,
				status: this.unsupportedReason === null ? "measured" : "unsupported",
				reason: this.unsupportedReason,
				scope: "serialized-context-text",
			},
			candidates,
		};
	}
}
