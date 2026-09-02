#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const script = join(root, isWin ? "kpi-test.ps1" : "kpi-test.sh");
const command = isWin ? "powershell.exe" : script;
const args = isWin
	? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...process.argv.slice(2)]
	: process.argv.slice(2);
const result = spawnSync(command, args, {
	cwd: root,
	stdio: "inherit",
	shell: false,
	env: process.env,
});
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
