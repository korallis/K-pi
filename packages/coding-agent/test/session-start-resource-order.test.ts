import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("extension resources are available to session_start", () => {
	let tempDir: string;
	let agentDir: string;
	let themeDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-resource-order-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		themeDir = join(tempDir, "themes");
		mkdirSync(tempDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(themeDir, { recursive: true });
		// A real shipped theme, so the test exercises a theme the loader will accept
		// rather than a fixture that could pass validation by accident.
		copyFileSync(
			join(repoRoot, "packages/coding-agent/src/kpi/themes/loop-amber.json"),
			join(themeDir, "loop-amber.json"),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * `resources_discover` reports paths and cannot depend on `session_start`, so
	 * running it second made every resource an extension ships invisible to that
	 * extension's own startup handler. An extension that ships a theme could
	 * never select it, and the operator's `theme` setting naming one failed with
	 * "Theme not found" while the startup banner listed it.
	 */
	it("discovers resources, lets the host register them, then emits session_start", async () => {
		const order: string[] = [];
		let themesAtSessionStart: string[] = [];

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("resources_discover", () => {
						order.push("resources_discover");
						return { themePaths: [themeDir] };
					});
					pi.on("session_start", () => {
						order.push("session_start");
						themesAtSessionStart = resourceLoader
							.getThemes()
							.themes.flatMap((theme) => (theme.name === undefined ? [] : [theme.name]));
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({
			onResourcesExtended: () => {
				order.push("onResourcesExtended");
			},
		});

		expect(order).toEqual(["resources_discover", "onResourcesExtended", "session_start"]);
		// The point of the ordering: the handler can see what it shipped.
		expect(themesAtSessionStart).toContain("loop-amber");
	});

	it("still emits session_start when no extension discovers resources", async () => {
		const order: string[] = [];
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						order.push("session_start");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({
			onResourcesExtended: () => {
				order.push("onResourcesExtended");
			},
		});

		// No `resources_discover` handler means nothing to mirror, but the host is
		// still told, so it can re-apply a selection unconditionally.
		expect(order).toEqual(["onResourcesExtended", "session_start"]);
	});
});
