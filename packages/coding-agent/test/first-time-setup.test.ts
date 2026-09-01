import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "../src/config.ts";
import { APP_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Identity of the upstream Pi distribution that first-time setup is gated on.
 * K-π rebrands (APP_NAME/CONFIG_DIR_NAME), so that gate is closed for the fork
 * and the remaining gates are only reachable under the official identity.
 */
const OFFICIAL_IDENTITY = {
	PACKAGE_NAME: "@earendil-works/pi-coding-agent",
	APP_NAME: "pi",
	CONFIG_DIR_NAME: ".pi",
};

/**
 * Load shouldRunFirstTimeSetup; `identity` omitted keeps K-π's real constants.
 *
 * The dynamic import is required: the distribution identity lives in module-level
 * constants, so each identity needs a freshly evaluated module graph.
 */
async function loadShouldRunFirstTimeSetup(
	identity?: Partial<Record<keyof typeof OFFICIAL_IDENTITY, string>>,
): Promise<(settingsPath?: string) => boolean> {
	vi.resetModules();
	if (identity) {
		vi.doMock("../src/config.ts", async (importOriginal) => ({
			...(await importOriginal<typeof ConfigModule>()),
			...identity,
		}));
	} else {
		vi.doUnmock("../src/config.ts");
	}
	return (await import("../src/cli/startup-ui.ts")).shouldRunFirstTimeSetup;
}

describe("shouldRunFirstTimeSetup", () => {
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), `${APP_NAME}-first-time-setup-`));
		settingsPath = join(tempDir, "settings.json");
		process.env.PI_EXPERIMENTAL = "1";
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.doUnmock("../src/config.ts");
		vi.resetModules();
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true when experimental, default agent dir, and no settings.json", async () => {
		const shouldRunFirstTimeSetup = await loadShouldRunFirstTimeSetup(OFFICIAL_IDENTITY);

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when experimental features are disabled", async () => {
		const shouldRunFirstTimeSetup = await loadShouldRunFirstTimeSetup(OFFICIAL_IDENTITY);
		delete process.env.PI_EXPERIMENTAL;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when a custom agent dir is set", async () => {
		const shouldRunFirstTimeSetup = await loadShouldRunFirstTimeSetup(OFFICIAL_IDENTITY);
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", async () => {
		const shouldRunFirstTimeSetup = await loadShouldRunFirstTimeSetup(OFFICIAL_IDENTITY);
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false for the rebranded distribution even when every other gate passes", async () => {
		const shouldRunFirstTimeSetup = await loadShouldRunFirstTimeSetup();

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});

describe("analytics settings", () => {
	it("defaults to disabled with no tracking identifier", () => {
		const manager = SettingsManager.inMemory();

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("generates a tracking identifier on opt-in", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);

		expect(manager.getEnableAnalytics()).toBe(true);
		expect(manager.getTrackingId()).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("does not generate a tracking identifier on opt-out", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(false);

		expect(manager.getEnableAnalytics()).toBe(false);
		expect(manager.getTrackingId()).toBeUndefined();
	});

	it("keeps the tracking identifier when toggling analytics", () => {
		const manager = SettingsManager.inMemory();

		manager.setEnableAnalytics(true);
		const trackingId = manager.getTrackingId();
		manager.setEnableAnalytics(false);
		manager.setEnableAnalytics(true);

		expect(manager.getTrackingId()).toBe(trackingId);
	});
});
