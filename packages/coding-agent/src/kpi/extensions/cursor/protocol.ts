// Wire field numbers and Connect protocol adapted from Oh My Pi 18.1.11,
// b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b, cursor/proto/agent.proto and
// catalog/src/discovery/cursor-proto.ts (MIT). No OMP runtime is used.
import { Buffer } from "node:buffer";

export type Field = readonly [number, string | number | boolean | Uint8Array | undefined];
export type WireMessage = Map<number, (Uint8Array | number)[]>;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const MAX_FRAME = 16 * 1024 * 1024;

function varint(value: number): Buffer {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid protobuf integer");
	const bytes: number[] = [];
	let remaining = BigInt(value);
	do {
		const byte = Number(remaining & 127n);
		remaining >>= 7n;
		bytes.push(byte | (remaining ? 128 : 0));
	} while (remaining);
	return Buffer.from(bytes);
}

export function message(...fields: Field[]): Buffer {
	const chunks: Uint8Array[] = [];
	for (const [field, value] of fields) {
		if (value === undefined) continue;
		if (typeof value === "number" || typeof value === "boolean") {
			chunks.push(varint(field * 8), varint(Number(value)));
		} else {
			const bytes = typeof value === "string" ? Buffer.from(value) : value;
			chunks.push(varint(field * 8 + 2), varint(bytes.length), bytes);
		}
	}
	return Buffer.concat(chunks);
}

export function decode(bytes: Uint8Array): WireMessage {
	const fields: WireMessage = new Map();
	let offset = 0;
	const integer = () => {
		let value = 0n;
		for (let shift = 0n; shift < 70n; shift += 7n) {
			if (offset >= bytes.length) throw new Error("Truncated protobuf integer");
			const byte = bytes[offset++];
			value |= BigInt(byte & 127) << shift;
			if (!(byte & 128)) {
				if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Protobuf integer exceeds safe range");
				return Number(value);
			}
		}
		throw new Error("Invalid protobuf integer");
	};
	while (offset < bytes.length) {
		const tag = integer();
		const field = Math.floor(tag / 8);
		const wire = tag & 7;
		if (!field) throw new Error("Invalid protobuf field zero");
		let value: Uint8Array | number;
		if (wire === 0) value = integer();
		else {
			const size = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
			if (size < 0 || size > bytes.length - offset) throw new Error("Invalid or truncated protobuf field");
			value = bytes.subarray(offset, offset + size);
			offset += size;
		}
		const existing = fields.get(field);
		if (existing) existing.push(value);
		else fields.set(field, [value]);
	}
	return fields;
}

export function bytes(fields: WireMessage, field: number): Uint8Array {
	const value = fields.get(field)?.at(-1);
	if (value === undefined) return new Uint8Array();
	if (typeof value === "number") throw new Error(`Expected protobuf bytes at ${field}`);
	return value;
}
export function text(fields: WireMessage, field: number): string {
	return utf8.decode(bytes(fields, field));
}
export function number(fields: WireMessage, field: number): number {
	const value = fields.get(field)?.at(-1);
	if (value === undefined) return 0;
	if (typeof value !== "number") throw new Error(`Expected protobuf integer at ${field}`);
	return value;
}
export function repeated(fields: WireMessage, field: number): Uint8Array[] {
	return (fields.get(field) ?? []).map((value) => {
		if (typeof value === "number") throw new Error(`Expected protobuf bytes at ${field}`);
		return value;
	});
}

/** google.protobuf.Value, not UTF-8 JSON: Cursor uses this for MCP argument/schema bytes. */
export function jsonValue(value: unknown): Buffer {
	if (value === null) return message([1, 0]);
	if (typeof value === "string") return message([3, value]);
	if (typeof value === "boolean") return message([4, value]);
	if (typeof value === "number" && Number.isFinite(value)) {
		const result = Buffer.alloc(9);
		result[0] = 17;
		result.writeDoubleLE(value, 1);
		return result;
	}
	if (Array.isArray(value)) return message([6, message(...value.map((item): Field => [1, jsonValue(item)]))]);
	if (value && typeof value === "object") {
		return message([
			5,
			message(...Object.entries(value).map(([key, item]): Field => [1, message([1, key], [2, jsonValue(item)])])),
		]);
	}
	throw new Error("Cursor requires JSON-serializable tool arguments and schemas");
}
export function parseJsonValue(value: Uint8Array): unknown {
	const fields = decode(value);
	if (fields.has(1)) return null;
	if (fields.has(2)) {
		const raw = bytes(fields, 2);
		if (raw.length !== 8) throw new Error("Invalid protobuf double");
		return new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat64(0, true);
	}
	if (fields.has(3)) return text(fields, 3);
	if (fields.has(4)) return number(fields, 4) !== 0;
	if (fields.has(6)) return repeated(decode(bytes(fields, 6)), 1).map(parseJsonValue);
	if (fields.has(5))
		return Object.fromEntries(
			repeated(decode(bytes(fields, 5)), 1).map((entry) => {
				const pair = decode(entry);
				return [text(pair, 1), parseJsonValue(bytes(pair, 2))];
			}),
		);
	throw new Error("Missing protobuf JSON value");
}

export function frame(payload: Uint8Array, flags = 0): Buffer {
	if (payload.length > MAX_FRAME) throw new Error("Cursor frame exceeds 16 MiB");
	const header = Buffer.alloc(5);
	header[0] = flags;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

/** Bounded framing handles headers, payloads and UTF-8 split across any HTTP/2 chunks. */
export class ConnectFrames {
	private readonly header = Buffer.alloc(5);
	private headerUsed = 0;
	private payload: Buffer | undefined;
	private payloadUsed = 0;
	private ended = false;
	push(chunk: Uint8Array): { payload: Uint8Array; end: boolean }[] {
		const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const frames: { payload: Uint8Array; end: boolean }[] = [];
		let offset = 0;
		while (offset < input.length) {
			if (this.ended) throw new Error("Data after Cursor Connect end-stream");
			if (this.headerUsed < 5) {
				const count = Math.min(5 - this.headerUsed, input.length - offset);
				input.copy(this.header, this.headerUsed, offset, offset + count);
				this.headerUsed += count;
				offset += count;
				if (this.headerUsed < 5) break;
				const flags = this.header[0];
				if (flags !== 0 && flags !== 2) throw new Error("Unsupported Cursor Connect compression or flags");
				const length = this.header.readUInt32BE(1);
				if (length > MAX_FRAME) throw new Error("Cursor frame exceeds 16 MiB");
				this.payload = Buffer.allocUnsafe(length);
				this.payloadUsed = 0;
			}
			const payload = this.payload!;
			const count = Math.min(payload.length - this.payloadUsed, input.length - offset);
			input.copy(payload, this.payloadUsed, offset, offset + count);
			this.payloadUsed += count;
			offset += count;
			if (this.payloadUsed < payload.length) break;
			const end = this.header[0] === 2;
			this.headerUsed = 0;
			this.payload = undefined;
			if (end) {
				this.ended = true;
				const trailer: unknown = JSON.parse(utf8.decode(payload));
				if (!trailer || typeof trailer !== "object" || Array.isArray(trailer))
					throw new Error("Invalid Cursor Connect trailer");
				if ("error" in trailer && trailer.error) {
					const error = trailer.error as { code?: string; message?: string };
					throw new Error(`Cursor Connect ${error.code ?? "error"}: ${error.message ?? JSON.stringify(error)}`);
				}
			}
			frames.push({ payload, end });
		}
		return frames;
	}
	finish(): void {
		if (this.headerUsed || this.payload) throw new Error("Truncated Cursor Connect frame");
	}
}
