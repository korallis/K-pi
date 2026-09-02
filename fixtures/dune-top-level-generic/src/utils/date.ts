export function formatDate(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}
