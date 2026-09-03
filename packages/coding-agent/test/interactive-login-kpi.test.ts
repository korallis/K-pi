import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ProviderOption = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	method?: { login?: () => Promise<unknown> };
};

const startProviderLogin = Reflect.get(InteractiveMode.prototype, "startProviderLogin") as (
	this: object,
	provider: ProviderOption,
) => Promise<void>;

function subject(hasAccountsCommand = true) {
	const prompt = vi.fn(async () => {});
	const showLoginDialog = vi.fn(async () => {});
	const showApiKeyLoginDialog = vi.fn(async () => {});
	return {
		context: {
			session: {
				prompt,
				extensionRunner: {
					getCommand(name: string) {
						return hasAccountsCommand && name === "accounts" ? { name } : undefined;
					},
				},
			},
			showLoginDialog,
			showApiKeyLoginDialog,
			showAmbientAuthDialog: vi.fn(),
		},
		prompt,
		showLoginDialog,
		showApiKeyLoginDialog,
	};
}

describe("K-π pooled /login", () => {
	it("routes subscription login for a K-π pool through the stacked accounts command", async () => {
		const harness = subject();

		await startProviderLogin.call(harness.context, {
			id: "anthropic",
			name: "Claude Pro/Max",
			authType: "oauth",
		});

		expect(harness.prompt).toHaveBeenCalledWith("/accounts login-active anthropic");
		expect(harness.showLoginDialog).not.toHaveBeenCalled();
	});

	it("leaves API-key and non-pool OAuth login on the core path", async () => {
		const harness = subject();

		await startProviderLogin.call(harness.context, {
			id: "anthropic",
			name: "Anthropic",
			authType: "api_key",
			method: { login: async () => ({}) },
		});
		await startProviderLogin.call(harness.context, {
			id: "openrouter",
			name: "OpenRouter",
			authType: "oauth",
		});

		expect(harness.prompt).not.toHaveBeenCalled();
		expect(harness.showApiKeyLoginDialog).toHaveBeenCalledOnce();
		expect(harness.showLoginDialog).toHaveBeenCalledOnce();
	});

	it("falls back to core OAuth when the K-π accounts command is unavailable", async () => {
		const harness = subject(false);

		await startProviderLogin.call(harness.context, {
			id: "anthropic",
			name: "Anthropic",
			authType: "oauth",
		});

		expect(harness.prompt).not.toHaveBeenCalled();
		expect(harness.showLoginDialog).toHaveBeenCalledOnce();
	});
});
