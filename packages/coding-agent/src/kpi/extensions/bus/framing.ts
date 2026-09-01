import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** A single record longer than this is a protocol fault, not a message. */
export const MAX_RECORD_CHARACTERS = 1_000_000;
/** How long an outbound write waits for a full stream to drain. */
export const MAX_DRAIN_WAIT_MS = 10_000;

export type FramingRejection =
	| { kind: "oversized"; characters: number }
	| { kind: "carriage-return" }
	| { kind: "unterminated"; characters: number };

export interface BoundedReaderOptions {
	onLine: (line: string) => void;
	onReject: (rejection: FramingRejection) => void;
	maxRecordCharacters?: number;
}

/**
 * A strict, bounded LF-only JSONL reader.
 *
 * Strict in three ways the shared helper is not:
 *
 * - **Bounded while streaming.** The buffer is capped as chunks arrive. A peer
 *   that never sends a newline cannot make this accumulate its output into one
 *   unbounded string; the record is abandoned at the cap and the rest of it is
 *   discarded up to the next LF, as exactly one rejection rather than a rejection
 *   per chunk.
 * - **CR is a fault, not whitespace.** Stripping a trailing `\r` silently accepts
 *   CRLF, which is not this protocol. A line ending in CR is rejected.
 * - **LF only.** U+2028 and U+2029 are legal inside a JSON string and are passed
 *   through untouched, which is why `readline` cannot be used here.
 */
export function attachBoundedJsonlReader(stream: Readable, options: BoundedReaderOptions): () => void {
	const limit = options.maxRecordCharacters ?? MAX_RECORD_CHARACTERS;
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	/** True while the remainder of an over-long record is being thrown away. */
	let discarding = false;

	const consume = (text: string): void => {
		let rest = text;
		while (rest.length > 0) {
			if (discarding) {
				const newlineIndex = rest.indexOf("\n");
				if (newlineIndex === -1) {
					// Still inside the abandoned record: keep nothing.
					return;
				}
				discarding = false;
				rest = rest.slice(newlineIndex + 1);
				continue;
			}

			const newlineIndex = rest.indexOf("\n");
			if (newlineIndex === -1) {
				// No record boundary yet. Grow only up to the cap.
				if (buffer.length + rest.length > limit) {
					options.onReject({ kind: "oversized", characters: buffer.length + rest.length });
					buffer = "";
					discarding = true;
					return;
				}
				buffer += rest;
				return;
			}

			const line = buffer + rest.slice(0, newlineIndex);
			buffer = "";
			rest = rest.slice(newlineIndex + 1);
			if (line.length > limit) {
				options.onReject({ kind: "oversized", characters: line.length });
				continue;
			}
			if (line.endsWith("\r")) {
				// CRLF is a different framing. Accepting it by stripping the CR would
				// make the strictness claim false.
				options.onReject({ kind: "carriage-return" });
				continue;
			}
			options.onLine(line);
		}
	};

	const onData = (chunk: string | Buffer): void => {
		consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
	};

	const onEnd = (): void => {
		consume(decoder.end());
		if (discarding) {
			discarding = false;
			buffer = "";
			return;
		}
		if (buffer.length > 0) {
			// A trailing fragment with no newline is not a record.
			options.onReject({ kind: "unterminated", characters: buffer.length });
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

/**
 * Writes one record and waits until the stream has taken it.
 *
 * `Writable.write` returning false means the payload is sitting in an in-memory
 * queue, so returning at that point would report delivery of bytes the peer has
 * not been offered. The wait for `drain` is bounded, because a worker that stops
 * reading must become an error rather than unbounded parent memory.
 */
export async function writeRecordBounded(
	stream: Writable,
	record: string,
	options: { maxRecordCharacters?: number; drainTimeoutMs?: number } = {},
): Promise<void> {
	const limit = options.maxRecordCharacters ?? MAX_RECORD_CHARACTERS;
	if (record.length > limit) {
		throw new Error(`outbound record is ${record.length} characters, over the ${limit} limit`);
	}
	if (stream.writableEnded || stream.destroyed) {
		throw new Error("worker stdin is closed");
	}
	if (stream.write(record)) {
		return;
	}
	const drainTimeoutMs = options.drainTimeoutMs ?? MAX_DRAIN_WAIT_MS;
	await new Promise<void>((resolvePromise, reject) => {
		const settle = (error?: Error): void => {
			clearTimeout(timer);
			stream.off("drain", onDrain);
			stream.off("error", onError);
			stream.off("close", onClose);
			if (error === undefined) {
				resolvePromise();
			} else {
				reject(error);
			}
		};
		const onDrain = (): void => settle();
		const onError = (error: Error): void => settle(error);
		const onClose = (): void => settle(new Error("worker stdin closed before the record was accepted"));
		const timer = setTimeout(
			() => settle(new Error(`worker did not accept a record within ${drainTimeoutMs}ms`)),
			drainTimeoutMs,
		);
		stream.once("drain", onDrain);
		stream.once("error", onError);
		stream.once("close", onClose);
	});
}
