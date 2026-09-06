import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

// Execute the shipped shell steps; record external operations instead of contacting registries.
function step(name) {
	const section = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
	const body = section?.split("        run: |\n")[1];
	if (!body) throw new Error(`Missing executable release step: ${name}`);
	return body.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

function releaseFixture(t, version) {
	const root = mkdtempSync(join(tmpdir(), "kpi-release-channel-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "release"));
	writeFileSync(join(root, "packages/coding-agent/package.json"), JSON.stringify({ version }));
	const tarball = join(root, "release/payload.tgz");
	writeFileSync(tarball, "fixture payload");
	writeFileSync(join(root, "release/pack-meta.json"), JSON.stringify({ tarball }));
	const capture = join(root, "operations.jsonl");
	const stub = `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { basename } from 'node:path';\nconst command = basename(process.argv[1]);\nconst args = process.argv.slice(2);\nif (args.includes('view')) process.exit(1);\nappendFileSync(process.env.CAPTURE, JSON.stringify({command,args})+'\\n');\n`;
	writeFileSync(join(root, "bin/package.json"), '{"type":"module"}');
	for (const command of ["npm", "gh"]) writeFileSync(join(root, "bin", command), stub, { mode: 0o755 });
	const outputs = join(root, "outputs");
	const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CAPTURE: capture,
		GITHUB_OUTPUT: outputs, GITHUB_REF_NAME: `v${version}`, DRY_RUN: "false", RUNNER_TEMP: root, VERSION: version };
	delete env.NODE_TEST_CONTEXT;
	const run = (name, overrides = {}) => spawnSync("bash", ["-e", "-c", step(name)], {
		cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
	});
	return { run, outputs, capture };
}

for (const [version, channel, prerelease] of [["0.4.0-rc.1", "next", true], ["0.4.0", "latest", false]]) {
	test(`release ${version} publishes to ${channel} without misclassifying GitHub availability`, (t) => {
		const fixture = releaseFixture(t, version);
		const resolved = fixture.run("Resolve the release version from the tag");
		assert.equal(resolved.status, 0, resolved.stderr);
		const outputs = Object.fromEntries(readFileSync(fixture.outputs, "utf8").trim().split("\n").map((line) => line.split("=")));
		assert.equal(outputs.npm_tag, channel);
		assert.equal(outputs.prerelease, String(prerelease));
		const published = fixture.run("Publish to npm", { NPM_TAG: outputs.npm_tag });
		assert.equal(published.status, 0, published.stderr);
		const released = fixture.run("Publish the GitHub release", { PRERELEASE: outputs.prerelease });
		assert.equal(released.status, 0, released.stderr);
		const operations = readFileSync(fixture.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const npm = operations.find((operation) => operation.command === "npm");
		assert.equal(npm.args[npm.args.indexOf("--tag") + 1], channel);
		assert.ok(npm.args.includes("--provenance"));
		const gh = operations.find((operation) => operation.command === "gh");
		assert.equal(gh.args.includes("--prerelease"), prerelease);
		assert.equal(gh.args.includes("--latest=false"), prerelease);
		assert.ok(gh.args.includes("--verify-tag"));
	});
}

test("a mismatched release tag stops before publication", (t) => {
	const fixture = releaseFixture(t, "0.4.0-rc.1");
	const result = fixture.run("Resolve the release version from the tag", { GITHUB_REF_NAME: "v0.4.0" });
	assert.equal(result.status, 1);
});
