import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "../../../config.ts";

import type { ExtensionCommandContext } from "../../../core/extensions/types.ts";

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

export async function saveResearchKeys(
	values: { exa?: string; perplexity?: string },
	path = join(getAgentDir(), "accounts.secrets.json"),
): Promise<void> {
	const secrets = await readSecrets(path);
	if (values.exa !== undefined) secrets["exa/default"] = { type: "api_key", key: values.exa };
	if (values.perplexity !== undefined) secrets["perplexity/default"] = { type: "api_key", key: values.perplexity };
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
	if (values.exa !== undefined || values.perplexity !== undefined) await saveResearchKeys(values);
	context.ui.notify(
		values.exa !== undefined || values.perplexity !== undefined
			? "External research configured"
			: "Research mode: local",
		"info",
	);
}
