import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME } from "../src/config.ts";

interface CodingAgentPackageJson {
	piConfig: { name: string; title: string; configDir: string };
	bin: Record<string, string>;
	main: string;
	exports: {
		".": { import: string; types: string };
		"./client": { import: string; types: string };
		"./rpc-entry": { import: string };
	};
}

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CodingAgentPackageJson;

describe("package distribution entrypoints", () => {
	test("uses the bundle for executables and modular output for libraries", () => {
		expect(packageJson.piConfig).toEqual({
			name: APP_NAME,
			title: APP_TITLE,
			configDir: CONFIG_DIR_NAME,
		});
		expect(packageJson.bin).toEqual({
			[APP_NAME]: "dist/bundle/cli.js",
			"k-pi": "dist/bundle/cli.js",
		});
		expect(packageJson.main).toBe("./dist/index.js");
		expect(packageJson.exports["."].import).toBe("./dist/index.js");
		expect(packageJson.exports["./client"].import).toBe("./dist/client/index.js");
		expect(packageJson.exports["./rpc-entry"].import).toBe("./dist/bundle/rpc-entry.js");
	});
});
