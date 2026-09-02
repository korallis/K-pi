export interface LineItem {
	cents: number;
	quantity: number;
}

export function total(items: LineItem[]): number {
	return items.reduce((sum, item) => sum + item.cents * item.quantity, 0);
}
