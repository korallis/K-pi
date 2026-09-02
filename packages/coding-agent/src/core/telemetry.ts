import { APP_NAME } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}

/**
 * Whether this build may report its own installation to pi.dev.
 *
 * A fork is built from its own checkout and is not distributed there, so an
 * install report from it names a build that endpoint never shipped. That is not
 * a preference an operator can hold, so no setting and no env flag can turn it
 * back on - unlike `isInstallTelemetryEnabled`, which stays a preference and
 * also governs provider attribution headers.
 */
export function isInstallReportAllowed(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
	appName: string = APP_NAME,
): boolean {
	if (appName !== "pi") {
		return false;
	}
	return isInstallTelemetryEnabled(settingsManager, telemetryEnv);
}
