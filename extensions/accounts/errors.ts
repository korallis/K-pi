const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const QUOTA_TOKENS = /usage[ _-]?limit|rate[ _-]?limit|quota/iu;

export interface ProviderFailure {
  status: number;
  headers?: Record<string, string | undefined>;
  body?: string;
}

export interface CooldownClassification {
  kind: "cooldown";
  until: number;
  reason: string;
}

function header(headers: ProviderFailure["headers"], name: string): string | undefined {
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function parsedReset(failure: ProviderFailure, now: number): number | undefined {
  const retryAfter = header(failure.headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset", "anthropic-ratelimit-unified-reset"]) {
    const value = header(failure.headers, name);
    if (value === undefined) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

export function classifyProviderFailure(
  failure: ProviderFailure,
  now = Date.now(),
): CooldownClassification | undefined {
  const quotaText = [failure.body, ...Object.values(failure.headers ?? {})].filter(Boolean).join(" ");
  const quotaShaped = failure.status === 403 && QUOTA_TOKENS.test(quotaText);
  if (failure.status !== 429 && failure.status !== 402 && !quotaShaped) return undefined;
  return {
    kind: "cooldown",
    until: parsedReset(failure, now) ?? now + DEFAULT_COOLDOWN_MS,
    reason: `provider response ${failure.status}`,
  };
}

export { DEFAULT_COOLDOWN_MS };
