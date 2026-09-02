import assert from "node:assert/strict";
import test from "node:test";

import type { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { isInstallReportAllowed, isInstallTelemetryEnabled } from "../packages/coding-agent/src/core/telemetry.ts";

/** Only `getEnableInstallTelemetry` is read, so the rest of the manager is irrelevant here. */
function settings(enabled: boolean): SettingsManager {
	return { getEnableInstallTelemetry: () => enabled } as unknown as SettingsManager;
}

test("this fork never reports an install, whatever the operator or the env says", () => {
	// K-π is built from its own checkout and is not distributed through pi.dev, so
	// an install report from it names a build that endpoint never shipped. That is
	// not a preference, so no setting and no env flag can turn it back on.
	for (const enabled of [true, false]) {
		for (const env of [undefined, "1", "true", "yes", "0"]) {
			assert.equal(
				isInstallReportAllowed(settings(enabled), env, "kpi"),
				false,
				`fork reported with setting=${enabled} env=${String(env)}`,
			);
		}
	}
});

test("upstream still honours the setting and the env flag", () => {
	// The gate must not silently disable the report for the product that does ship
	// through pi.dev; both switches keep working there.
	assert.equal(isInstallReportAllowed(settings(true), undefined, "pi"), true);
	assert.equal(isInstallReportAllowed(settings(false), undefined, "pi"), false);
	assert.equal(isInstallReportAllowed(settings(false), "1", "pi"), true);
	assert.equal(isInstallReportAllowed(settings(true), "0", "pi"), false);
});

test("the shared telemetry preference is left alone", () => {
	// `isInstallTelemetryEnabled` also governs provider attribution headers, which
	// are a separate question from reporting an install. Narrowing the fix to the
	// report keeps that preference exactly as it was, so the OpenRouter matching
	// those headers exercise stays under test.
	assert.equal(isInstallTelemetryEnabled(settings(true), undefined), true);
	assert.equal(isInstallTelemetryEnabled(settings(false), undefined), false);
	assert.equal(isInstallTelemetryEnabled(settings(false), "1"), true);
	assert.equal(isInstallTelemetryEnabled(settings(true), "0"), false);
});
