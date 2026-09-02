export async function retry<T>(attempt: () => Promise<T>, times: number): Promise<T> {
	let last: unknown;
	for (let index = 0; index < times; index += 1) {
		try {
			return await attempt();
		} catch (error) {
			last = error;
		}
	}
	throw last;
}
