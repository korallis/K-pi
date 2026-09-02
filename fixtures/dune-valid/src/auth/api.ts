export interface Session {
	token: string;
	user: string;
	issuedAt: number;
}

export function login(user: string, now: number): Session {
	return { token: `session-${user}`, user, issuedAt: now };
}
