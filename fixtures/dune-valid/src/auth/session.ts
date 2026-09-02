const SESSION_LIFETIME_MS = 900_000;

export function isFresh(issuedAt: number, now: number): boolean {
	return now - issuedAt < SESSION_LIFETIME_MS;
}
