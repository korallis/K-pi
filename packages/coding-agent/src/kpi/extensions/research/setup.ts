import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "../../../config.ts";

import type { ExtensionContext } from "../../../core/extensions/types.ts";
import { writeResearchMode } from "../settings.ts";
import { RESEARCH_SERVICES, type ResearchKeys, type ResearchService, researchSecretName } from "./session.ts";

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
	values: ResearchKeys,
	path = join(getAgentDir(), "accounts.secrets.json"),
): Promise<void> {
	const secrets = await readSecrets(path);
	for (const service of RESEARCH_SERVICES) {
		const value = values[service];
		if (value !== undefined) {
			secrets[researchSecretName(service)] = { type: "api_key", key: value };
		}
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

/** The label each research key prompt shows, in `RESEARCH_SERVICES` order. */
const RESEARCH_SERVICE_LABELS: Readonly<Record<ResearchService, string>> = {
	exa: "Exa",
	perplexity: "Perplexity",
	firecrawl: "Firecrawl",
};

function normalizedAnswer(answer: string | undefined): string | undefined {
	const trimmed = answer?.trim() ?? "";
	return trimmed.length === 0 || trimmed.toLowerCase() === "s" ? undefined : trimmed;
}

/**
 * Asks one API key per research service and saves whichever were given. Never
 * writes the project research mode: onboarding calls this so a first launch
 * saving a key does not make the launch directory trust-requiring.
 */
export async function promptResearchKeys(ui: Pick<ExtensionContext["ui"], "input">): Promise<ResearchService[]> {
	const values: ResearchKeys = {};
	for (const service of RESEARCH_SERVICES) {
		const answer = await ui.input(
			`${RESEARCH_SERVICE_LABELS[service]} API key for research`,
			"Enter to save, s to skip",
		);
		const value = normalizedAnswer(answer);
		if (value !== undefined) {
			values[service] = value;
		}
	}
	const saved = RESEARCH_SERVICES.filter((service) => values[service] !== undefined);
	if (saved.length > 0) {
		await saveResearchKeys(values);
	}
	return [...saved];
}

export async function promptResearchSetup(context: Pick<ExtensionContext, "ui" | "cwd">): Promise<void> {
	const saved = await promptResearchKeys(context.ui);
	const configured = saved.length > 0;
	// Saving either key means research goes online by default; skipping both is a
	// narrower mode, not a broken setup.
	await writeResearchMode(context.cwd, configured ? "auto" : "local");
	context.ui.notify(configured ? "External research configured" : "Research mode: local", "info");
}
