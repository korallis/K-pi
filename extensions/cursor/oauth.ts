import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

export async function login(
  interaction: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const access = await interaction.onPrompt({
    message: "Paste a Cursor access token",
    placeholder: "Cursor token",
  });
  if (access.trim().length === 0) throw new Error("Cursor token is required");
  return {
    access: access.trim(),
    refresh: access.trim(),
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

export async function refreshToken(
  credentials: OAuthCredentials,
  signal: AbortSignal,
): Promise<OAuthCredentials> {
  if (signal.aborted) throw signal.reason;
  return credentials;
}

export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}
