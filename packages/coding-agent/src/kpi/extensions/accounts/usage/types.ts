export interface UsageSnapshot {
	remainingPercent?: number;
	resetAt?: string;
}

export type UsageReader = (credential: string, signal?: AbortSignal) => Promise<UsageSnapshot | undefined>;

export function failOpenUsageReader(): UsageReader {
	return async () => undefined;
}
