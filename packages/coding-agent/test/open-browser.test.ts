import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

beforeEach(() => {
	for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION"]) vi.stubEnv(name, "");
	vi.mocked(spawn).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

test("SSH authentication never launches a browser on the server", () => {
	vi.stubEnv("SSH_CONNECTION", "fixture");
	openBrowser("https://auth.example.invalid/authorize?state=fixture&client_id=fixture");
	expect(spawn).not.toHaveBeenCalled();
});

test("local browser launch preserves URL query bytes without shell interpretation", () => {
	const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() };
	vi.mocked(spawn).mockReturnValue(child as never);
	const url = "https://auth.example.invalid/authorize?state=a%2Bb&scope=openid+profile&client_id=fixture";
	openBrowser(url);
	const [command, args, options] = vi.mocked(spawn).mock.calls[0];
	expect(args?.at(-1)).toBe(url);
	expect(options).not.toHaveProperty("shell", true);
	expect(command).not.toBe("cmd");
	expect(child.unref).toHaveBeenCalled();
});
