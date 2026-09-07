import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { getOsc8LinkAtColumn, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	TerminalInputHandler,
} from "../packages/coding-agent/src/core/extensions/types.ts";
import { registerAccounts } from "../packages/coding-agent/src/kpi/extensions/accounts/index.ts";
import { AccountsStore } from "../packages/coding-agent/src/kpi/extensions/accounts/store.ts";

for (const provider of ["anthropic", "openai-codex"] as const) {
	test(`${provider} SSH login preserves the full clickable URL and clipboard parameters through the manual prompt`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "kpi-auth-link-"));
		const oldSsh = process.env.SSH_CONNECTION;
		process.env.SSH_CONNECTION = "fixture";
		const url = `https://auth.example.invalid/authorize?client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid+profile+offline_access&code_challenge=${"x".repeat(43)}&code_challenge_method=S256&state=${"s".repeat(64)}`;
		const notes: string[] = [];
		let inputHandler: TerminalInputHandler | undefined;
		let accounts: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
		let launched = false;
		const store = new AccountsStore(directory);
		try {
			registerAccounts(
				{
					on() {},
					registerCommand(name: string, options: { handler: NonNullable<typeof accounts> }) {
						if (name === "accounts") accounts = options.handler;
					},
					async exec() {
						launched = true;
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
					async setModel() {
						return true;
					},
				} as unknown as ExtensionAPI,
				{ store },
			);
			const context = {
				cwd: directory,
				hasUI: true,
				mode: "tui",
				modelRegistry: {
					getProvider: () => ({ auth: { oauth: {} } }),
					getAvailable: () => [],
					login: async (_provider: string, _method: string, interaction: ProviderAuthInteraction) => {
						interaction.notify({ type: "auth_url", url, instructions: "Complete sign-in in your browser." });
						const answer = await interaction.prompt({
							type: "manual_code",
							message: "Paste the final redirect URL",
							signal: interaction.signal,
						});
						assert.equal(answer, "http://localhost:1455/auth/callback?code=fixture&state=fixture");
						return {
							type: "oauth",
							access: "fixture-access",
							refresh: "fixture-refresh",
							expires: Date.now() + 3600000,
						};
					},
				},
				ui: {
					confirm: async () => true,
					notify: (message: string) => notes.push(message),
					setStatus() {},
					onTerminalInput: (handler: TerminalInputHandler) => {
						inputHandler = handler;
						return () => {
							inputHandler = undefined;
						};
					},
					input: async () => {
						const rows = new Text(notes.join("\n"), 1, 0).render(80);
						const targets = rows
							.flatMap((row) => Array.from({ length: 80 }, (_, column) => getOsc8LinkAtColumn(row, column)))
							.filter(Boolean);
						assert.ok(
							targets.includes(url),
							"the sign-in link must carry every query parameter despite terminal wrapping",
						);
						let wire = "";
						const originalWrite = process.stdout.write;
						process.stdout.write = ((chunk: string | Uint8Array) => {
							wire += chunk.toString();
							return true;
						}) as typeof process.stdout.write;
						try {
							assert.deepEqual(inputHandler?.("\x19"), { consume: true });
						} finally {
							process.stdout.write = originalWrite;
						}
						const encoded = /\x1b\]52;c;([^\x07]+)\x07/u.exec(wire)?.[1];
						assert.ok(encoded, "Ctrl+Y must send the URL to the SSH client's clipboard");
						assert.equal(Buffer.from(encoded, "base64").toString(), url);
						return "http://localhost:1455/auth/callback?code=fixture&state=fixture";
					},
				},
			} as unknown as ExtensionCommandContext;
			await accounts!(`login ${provider} ssh`, context);
			assert.ok(await store.getSlot(provider, "ssh"), notes.join("\n"));
			assert.equal(launched, false, "SSH must not open a browser on the remote host");
			assert.equal(inputHandler, undefined, "login must release its temporary keyboard capture");
		} finally {
			if (oldSsh === undefined) delete process.env.SSH_CONNECTION;
			else process.env.SSH_CONNECTION = oldSsh;
			await rm(directory, { recursive: true, force: true });
		}
	});
}
