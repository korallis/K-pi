import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a refused response so a caller can route on provider health", async () => {
		const error = providerError(429, { "retry-after": "60", "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		const seen: Array<{ status: number; headers: Record<string, string> }> = [];

		await expect(retryProviderRequest(request, { onResponse: (r) => void seen.push(r) })).rejects.toBe(error);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.status).toBe(429);
		// The classifier needs the provider's own retry window, not a guess.
		expect(seen[0]?.headers["retry-after"]).toBe("60");
	});

	it("reports every attempt, including the one it gives up on", async () => {
		vi.useFakeTimers();
		let attempt = 0;
		const request = vi.fn<() => Promise<string>>().mockImplementation(() => {
			attempt += 1;
			return Promise.reject(attempt === 1 ? providerError(429, { "retry-after-ms": "1" }) : providerError(503));
		});
		const statuses: number[] = [];

		const result = retryProviderRequest(request, { maxRetries: 1, onResponse: (r) => void statuses.push(r.status) });
		const settled = expect(result).rejects.toMatchObject({ status: 503 });
		await vi.advanceTimersByTimeAsync(1);
		await settled;

		expect(statuses).toEqual([429, 503]);
	});

	it("reports nothing for a transport failure that produced no response", async () => {
		const error = new Error("socket hang up");
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		const seen: number[] = [];

		await expect(retryProviderRequest(request, { onResponse: (r) => void seen.push(r.status) })).rejects.toBe(error);

		expect(seen).toEqual([]);
	});

	it("leaves the success path to report its own response", async () => {
		const request = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
		const seen: number[] = [];

		await expect(retryProviderRequest(request, { onResponse: (r) => void seen.push(r.status) })).resolves.toBe("ok");

		expect(seen).toEqual([]);
	});
});
