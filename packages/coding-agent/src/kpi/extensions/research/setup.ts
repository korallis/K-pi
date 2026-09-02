import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "../../../config.ts";

import type { ExtensionCommandContext } from "../../../core/extensions/types.ts";
import { writeResearchMode } from "../settings.ts";
import { type ResearchService, researchSecretName } from "./session.ts";

async function readSecrets(path: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("Account secrets must be an object");
		return { ...value };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

/** One writer for the secrets file: atomic, 0600, never a partial document. */
async function writeSecrets(path: string, secrets: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(secrets, null, 2)}\n`);
		await file.sync();
		await file.close();
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await file.close().catch(() => undefined);
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function saveResearchKeys(
	values: { exa?: string; perplexity?: string },
	path = join(getAgentDir(), "accounts.secrets.json"),
): Promise<void> {
	const secrets = await readSecrets(path);
	if (values.exa !== undefined) secrets[researchSecretName("exa")] = { type: "api_key", key: values.exa };
	if (values.perplexity !== undefined) {
		secrets[researchSecretName("perplexity")] = { type: "api_key", key: values.perplexity };
	}
	await writeSecrets(path, secrets);
}

/** Removes a research credential. Local research is still research. */
export async function removeResearchKey(
	service: ResearchService,
	path = join(getAgentDir(), "accounts.secrets.json"),
): Promise<boolean> {
	const secrets = await readSecrets(path);
	const name = researchSecretName(service);
	if (secrets[name] === undefined) {
		return false;
	}
	delete secrets[name];
	await writeSecrets(path, secrets);
	return true;
}

export async function promptResearchSetup(context: ExtensionCommandContext): Promise<void> {
	const exa = await context.ui.input("Exa API key for research", "Enter to save, s to skip");
	const perplexity = await context.ui.input("Perplexity API key for research", "Enter to save, s to skip");
	const values = {
		exa: exa === undefined || exa.trim() === "" || exa.trim().toLowerCase() === "s" ? undefined : exa.trim(),
		perplexity:
			perplexity === undefined || perplexity.trim() === "" || perplexity.trim().toLowerCase() === "s"
				? undefined
				: perplexity.trim(),
	};
	const configured = values.exa !== undefined || values.perplexity !== undefined;
	if (configured) await saveResearchKeys(values);
	// Saving either key means research goes online by default; skipping both is a
	// narrower mode, not a broken setup.
	await writeResearchMode(context.cwd, configured ? "auto" : "local");
	context.ui.notify(configured ? "External research configured" : "Research mode: local", "info");
}
