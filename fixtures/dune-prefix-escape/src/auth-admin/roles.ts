export type Role = "admin" | "operator";

export function isAdmin(role: Role): boolean {
	return role === "admin";
}
