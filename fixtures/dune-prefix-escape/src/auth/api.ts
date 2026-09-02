export interface Session {
	token: string;
	user: string;
}

export function login(user: string): Session {
	return { token: `session-${user}`, user };
}
