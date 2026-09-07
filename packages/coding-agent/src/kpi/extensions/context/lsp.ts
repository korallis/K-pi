import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnProcess } from "../../../utils/child-process.ts";
import { isJsonObject } from "../graph/schema.ts";
import { canonicalProjectPath } from "../stack.ts";

export interface LanguageServerConfig {
	command: string;
	args: string[];
	extensions: string[];
	languageId: string;
}
export interface SemanticResult {
	status: "available" | "unsupported";
	method: string;
	server?: string;
	reason?: string;
	result?: unknown;
}

/** Explicit local configuration only: never downloads or guesses a server. */
export async function readLanguageServers(projectRoot: string): Promise<LanguageServerConfig[]> {
	let data: unknown;
	try {
		data = JSON.parse(await readFile(join(projectRoot, ".kpi", "lsp.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!Array.isArray(data))
		throw new Error(".kpi/lsp.json must be an array of explicitly authorized language servers");
	for (const entry of data) {
		if (
			!entry ||
			typeof entry.command !== "string" ||
			!entry.command.trim() ||
			!Array.isArray(entry.args) ||
			!entry.args.every((arg: unknown) => typeof arg === "string") ||
			!Array.isArray(entry.extensions) ||
			!entry.extensions.every((ext: unknown) => typeof ext === "string" && ext.startsWith(".")) ||
			typeof entry.languageId !== "string"
		)
			throw new Error("Invalid .kpi/lsp.json server configuration");
	}
	return data as LanguageServerConfig[];
}

/** One native stdio client, using the harness's cross-platform process launcher. */
class LanguageServer {
	private readonly child: ChildProcess;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 0;
	private failure?: Error;
	private readonly pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
	>();
	readonly ready: Promise<Record<string, unknown>>;
	constructor(root: string, config: LanguageServerConfig) {
		this.child = spawnProcess(config.command, config.args, {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		this.child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
		// Drain diagnostics without ever mixing server output with JSON-RPC or agent context.
		this.child.stderr!.resume();
		this.child.on("error", (error) => this.fail(error));
		this.child.stdin!.on("error", (error) => this.fail(error));
		this.child.on("exit", (code) => this.fail(new Error(`Language server exited (${code})`)));
		this.ready = this.request("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(root).href,
			capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
			workspaceFolders: [{ uri: pathToFileURL(root).href, name: root }],
		}).then((value) => {
			this.notify("initialized", {});
			if (!isJsonObject(value) || !isJsonObject(value.capabilities))
				throw new Error("Invalid LSP initialize capabilities");
			return value.capabilities;
		});
	}
	private fail(error: Error): void {
		this.failure = error;
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
	private send(value: unknown): void {
		if (this.failure) throw this.failure;
		const body = JSON.stringify(value);
		this.child.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}
	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		try {
			while (true) {
				const headerEnd = this.buffer.indexOf("\r\n\r\n");
				if (headerEnd < 0) {
					if (this.buffer.length > 8192) throw new Error("Invalid LSP header");
					return;
				}
				const length = Number(/Content-Length:\s*(\d+)/iu.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]);
				if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024)
					throw new Error("Invalid LSP frame length");
				if (this.buffer.length < headerEnd + 4 + length) return;
				const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
				if (!isJsonObject(message)) throw new Error("Invalid LSP response object");
				this.buffer = this.buffer.subarray(headerEnd + 4 + length);
				if (message.method && message.id !== undefined) {
					// Retrieval client: never accepts workspace/applyEdit or server-initiated writes.
					this.send({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Client request unsupported" },
					});
					continue;
				}
				const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
				if (!entry) continue;
				clearTimeout(entry.timer);
				this.pending.delete(Number(message.id));
				if (isJsonObject(message.error)) entry.reject(new Error(String(message.error.message)));
				else entry.resolve(message.result);
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			this.child.kill();
		}
	}
	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}
	request(method: string, params: unknown): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		const id = ++this.nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`LSP ${method} timed out`));
		}, 15_000);
		this.pending.set(id, { resolve, reject, timer });
		try {
			this.send({ jsonrpc: "2.0", id, method, params });
		} catch (error) {
			clearTimeout(timer);
			this.pending.delete(id);
			reject(error);
		}
		return promise;
	}
	async close(): Promise<void> {
		try {
			await this.request("shutdown", null);
			this.notify("exit", null);
		} catch {
			/* A failed server is still terminated below. */
		} finally {
			this.child.kill();
			this.fail(new Error("Language server closed"));
		}
	}
}

export type NavigationOperation = "symbols" | "definition" | "references";
const METHODS: Record<NavigationOperation, [string, string]> = {
	symbols: ["textDocument/documentSymbol", "documentSymbolProvider"],
	definition: ["textDocument/definition", "definitionProvider"],
	references: ["textDocument/references", "referencesProvider"],
};

export class SemanticNavigation {
	private readonly servers = new Map<string, LanguageServer>();
	private readonly versions = new Map<string, number>();
	readonly root: string;
	readonly configs: LanguageServerConfig[];
	constructor(root: string, configs: LanguageServerConfig[]) {
		this.root = root;
		this.configs = configs;
	}
	async retrieve(
		path: string,
		operation: NavigationOperation,
		line = 0,
		character = 0,
		sourceSnapshot?: Buffer,
	): Promise<SemanticResult> {
		const canonical = await canonicalProjectPath(this.root, path);
		if (
			canonical.split("/").some((part) => part === ".kpi" || part === ".git") ||
			/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|accounts\.secrets\.json|.*\.(?:pem|key))$/iu.test(canonical)
		) {
			throw new Error("Semantic retrieval refuses credential and runtime-state paths");
		}
		const config = this.configs.find((entry) => entry.extensions.includes(extname(canonical)));
		const [method, capability] = METHODS[operation];
		if (!config)
			return {
				status: "unsupported",
				method,
				reason: `No configured language server for ${extname(canonical) || "this file"}`,
			};
		const key = JSON.stringify(config);
		let server = this.servers.get(key);
		try {
			if (!server) {
				server = new LanguageServer(this.root, config);
				this.servers.set(key, server);
			}
			const capabilities = await server.ready;
			if (!capabilities[capability])
				return {
					status: "unsupported",
					method,
					server: config.command,
					reason: `Server does not advertise ${capability}`,
				};
			// Map callers supply the same bytes they hashed; concurrent disk edits cannot relabel symbols.
			const text = sourceSnapshot?.toString("utf8") ?? (await readFile(join(this.root, canonical), "utf8"));
			if (Buffer.byteLength(text) > 1024 * 1024)
				return {
					status: "unsupported",
					method,
					server: config.command,
					reason: "File exceeds semantic retrieval byte limit (1 MiB); narrow the source file",
				};
			const uri = pathToFileURL(join(this.root, canonical)).href;
			const version = (this.versions.get(uri) ?? 0) + 1;
			// Close/open avoids assuming incremental versus full text synchronization.
			if (version > 1) server.notify("textDocument/didClose", { textDocument: { uri } });
			server.notify("textDocument/didOpen", { textDocument: { uri, languageId: config.languageId, version, text } });
			this.versions.set(uri, version);
			const result = await server.request(method, {
				textDocument: { uri },
				...(operation === "symbols" ? {} : { position: { line, character } }),
				...(operation === "references" ? { context: { includeDeclaration: true } } : {}),
			});
			return { status: "available", method, server: config.command, result };
		} catch (error) {
			return {
				status: "unsupported",
				method,
				server: config.command,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}
	async close(): Promise<void> {
		await Promise.all([...this.servers.values()].map((server) => server.close()));
		this.servers.clear();
	}
}
