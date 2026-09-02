export function slugify(value: string): string {
	return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}
