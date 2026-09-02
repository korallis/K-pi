/**
 * Parent sessions publish a live worker count the board may read.
 * UI never spawns or waits on workers through this path.
 */
let provider: () => number = () => 0;

export function setLiveWorkerCountProvider(next: () => number): void {
	provider = next;
}

export function liveWorkerCount(): number {
	return provider();
}

export function resetLiveWorkerCountProvider(): void {
	provider = () => 0;
}
