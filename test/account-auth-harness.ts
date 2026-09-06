import type { AuthResult, Credential } from "@earendil-works/pi-ai";

/** Synthetic auth methods for scheduler scenarios only; native wire behavior has separate coverage. */
export function schedulerProvider() {
	return {
		name: "Scheduler fixture",
		auth: {
			oauth: {
				refresh: async (credential: Credential) => ({ ...credential, expires: Date.UTC(2099, 0, 1) }),
				toAuth: async (credential: Extract<Credential, { type: "oauth" }>) => ({ apiKey: credential.access }),
			},
			apiKey: {
				resolve: async ({ credential }: { credential: Extract<Credential, { type: "api_key" }> }) => ({
					auth: { apiKey: credential.key },
				}),
			},
		},
	};
}

export async function invokeAccountAuth(
	handler: (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>,
	event: Record<string, unknown>,
	context: Record<string, unknown>,
): Promise<unknown> {
	event.model ??= context.model;
	event.checkOnly ??= false;
	const registry = context.modelRegistry as Record<string, unknown> | undefined;
	const result = await handler(event, {
		...context,
		modelRegistry: {
			...registry,
			getProvider: registry?.getProvider ?? schedulerProvider,
			getProviderAuth: registry?.getProviderAuth ?? (async () => ({ auth: {} })),
		},
	});
	// Existing scheduler scenarios describe their account through a bearer label;
	// this is a test presentation, not provider request shaping.
	const display = event.headers as Record<string, string | null> | undefined;
	const auth = event.auth as AuthResult | false | undefined;
	if (display && auth === false) {
		if (display.authorization !== undefined) display.authorization = null;
	} else if (display && auth && auth.auth.apiKey) display.authorization = `Bearer ${auth.auth.apiKey}`;
	return result;
}
