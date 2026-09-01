import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("../", import.meta.url);
const cliEntry = fileURLToPath(new URL("packages/coding-agent/src/cli.ts", repoRoot));

/**
 * Provider credentials the harness would otherwise pick up from the developer's
 * shell. The smoke contract is that `--version` and `--help` answer from the
 * source tree alone, so every one of these is removed before the CLI starts.
 * Mirrors the `--no-env` list in kpi-test.sh.
 */
const credentialEnvNames = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HF_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
] as const;

/** Runs the source CLI entry point with no credentials and no network startup work. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
	const agentDir = await mkdtemp(join(tmpdir(), "kpi-smoke-"));
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of credentialEnvNames) delete env[name];
	// Keep the smoke run off the developer's real ~/.kpi and off the network.
	env.KPI_CODING_AGENT_DIR = agentDir;
	env.PI_OFFLINE = "1";
	env.PI_SKIP_VERSION_CHECK = "1";

	try {
		return await execFileAsync(
			process.execPath,
			["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cliEntry, ...args],
			{ cwd: fileURLToPath(repoRoot), env, maxBuffer: 16 * 1024 * 1024 },
		);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Runs the source CLI expecting a non-zero exit, returning the captured output. */
async function runCliExpectingFailure(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await runCli(args);
		assert.fail(`${args.join(" ")} unexpectedly succeeded\nstdout: ${stdout}\nstderr: ${stderr}`);
	} catch (error: unknown) {
		const failure = error as { code?: unknown; stdout?: string; stderr?: string };
		if (typeof failure.code !== "number") throw error;
		return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code };
	}
}

test("the source CLI reports K-π's own version, not the pinned upstream Pi version", async () => {
	const { version } = JSON.parse(await readFile(new URL("packages/coding-agent/package.json", repoRoot), "utf8")) as {
		version: string;
	};
	const upstream = JSON.parse(await readFile(new URL("upstream.json", repoRoot), "utf8")) as { version: string };

	assert.equal(version, "0.1.0", "the K-π CLI package carries the fork's own version");
	assert.notEqual(version, upstream.version, "K-π's version must not track the pinned Pi release");

	const { stdout } = await runCli(["--version"]);
	assert.equal(stdout.trim(), "0.1.0");
});

test("the source CLI documents itself as kpi, not pi", async () => {
	const { stdout } = await runCli(["--help"]);

	assert.match(stdout, /^kpi\b/mu, "help must lead with the kpi command name");
	assert.match(stdout, /^\s+kpi \[options\]/mu, "usage line must invoke kpi");
	assert.doesNotMatch(stdout, /^\s+pi \[options\]/mu, "no pi usage line may survive the fork");
	assert.match(stdout, /\.kpi\b/u, "help must document the .kpi config directory");
	assert.match(stdout, /KPI_CODING_AGENT_DIR/u, "help must document the KPI env prefix");
});

/**
 * Every inherited self-update form resolves the upstream Pi release from pi.dev
 * and installs it over the running harness. K-π is built from this checkout, so
 * each form must be refused locally: no credentials, no network, no package
 * manager, and no message pointing a K-π user at an upstream Pi distribution.
 */
test("the source CLI refuses to self-update as Pi, locally and without network", async () => {
	for (const args of [
		["update"],
		["update", "--self"],
		["update", "self"],
		["update", "pi"],
		["update", "--all"],
		["update", "--self", "--force"],
	]) {
		const label = args.join(" ");
		const { stdout, stderr, code } = await runCliExpectingFailure(args);

		assert.equal(code, 1, `${label} must fail`);
		assert.match(stderr, /error: kpi does not self-update\./u, label);
		assert.match(stderr, /kpi update --extensions/u, label);
		assert.doesNotMatch(stderr, /pi\.dev/u, `${label} must not name the upstream distribution host`);
		assert.doesNotMatch(stderr, /@earendil-works/u, `${label} must not name the upstream registry package`);
		assert.doesNotMatch(
			stderr,
			/Could not determine latest|cannot self-update this installation/u,
			`${label} must be refused before the inherited version check`,
		);
		assert.doesNotMatch(stdout, /Updated/u, `${label} must not report an update`);
	}
});

test("the source CLI keeps extension and model updates after the self-update lockout", async () => {
	const { stdout } = await runCli(["update", "--help"]);

	assert.match(stdout, /--extensions/u, "extension updates stay available");
	assert.match(stdout, /--models/u, "model catalog refresh stays available");
	assert.doesNotMatch(stdout, /--self/u, "no self-update flag may be advertised");
	assert.doesNotMatch(stdout, /--all/u, "no combined self+extension target may be advertised");
	assert.doesNotMatch(stdout, /pi\.dev/u);

	// `--models` still parses as its own update target: the models/self conflict is
	// reported instead of the fork's self-update refusal.
	const { stderr } = await runCliExpectingFailure(["update", "--models", "--self"]);
	assert.match(stderr, /--models cannot be combined with --self/u);
	assert.doesNotMatch(stderr, /does not self-update/u);
});
