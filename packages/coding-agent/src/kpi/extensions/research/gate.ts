import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite, type Task } from "../run-store.ts";
import { exaSearch, ResearchHttpError, type ResearchResult } from "./exa.ts";
import { perplexitySearch } from "./perplexity.ts";

export interface ResearchDocument {
	mode: "exa" | "perplexity" | "local";
	task_hash: string;
	sources: Array<{ title: string; url: string; excerpt?: string }>;
}

export interface ResearchDependencies {
	exaKey?: string;
	perplexityKey?: string;
	fetch?: typeof fetch;
}

function taskHash(task: Task): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(task)).digest("hex")}`;
}

function sources(results: readonly ResearchResult[]): ResearchDocument["sources"] {
	return results.slice(0, 10).map((result) => ({ title: result.title, url: result.url, excerpt: result.text }));
}

async function localSources(projectRoot: string): Promise<ResearchDocument["sources"]> {
	const candidates = ["AGENTS.md", "README.md", "package.json"];
	const found: ResearchDocument["sources"] = [];
	for (const path of candidates) {
		try {
			const content = await readFile(join(projectRoot, path), "utf8");
			found.push({ title: path, url: path, excerpt: content.slice(0, 1_000) });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return found;
}

function recoverable(error: unknown): boolean {
	return error instanceof ResearchHttpError && (error.status === 402 || error.status === 429 || error.status >= 500);
}

export async function conductResearch(
	projectRoot: string,
	runDirectory: string,
	task: Task,
	dependencies: ResearchDependencies = {},
): Promise<ResearchDocument> {
	let document: ResearchDocument | undefined;
	if (dependencies.exaKey !== undefined) {
		try {
			const results = await exaSearch(task.goal, dependencies.exaKey, { numResults: 5, fetch: dependencies.fetch });
			const resultSources = sources(results);
			if (resultSources.length >= 2) {
				document = { mode: "exa", task_hash: taskHash(task), sources: resultSources };
			}
		} catch (error) {
			if (!recoverable(error)) throw error;
		}
	}
	if (document === undefined && dependencies.perplexityKey !== undefined) {
		try {
			const results = await perplexitySearch(task.goal, dependencies.perplexityKey, {
				maxResults: 5,
				fetch: dependencies.fetch,
			});
			const resultSources = sources(results);
			if (resultSources.length >= 2) {
				document = { mode: "perplexity", task_hash: taskHash(task), sources: resultSources };
			}
		} catch (error) {
			if (!recoverable(error)) throw error;
		}
	}
	document ??= { mode: "local", task_hash: taskHash(task), sources: await localSources(projectRoot) };
	await atomicWrite(join(runDirectory, "research.json"), `${JSON.stringify(document, null, 2)}\n`);
	const markdown = [
		`# Research (${document.mode})`,
		"",
		...document.sources.flatMap((source) => [
			`- [${source.title}](${source.url})`,
			source.excerpt === undefined ? "" : `  ${source.excerpt.replaceAll("\n", " ")}`,
		]),
	]
		.filter(Boolean)
		.join("\n");
	await atomicWrite(join(runDirectory, "research.md"), `${markdown}\n`);
	return document;
}

export async function assertResearchFresh(runDirectory: string, task: Task): Promise<void> {
	const document: unknown = JSON.parse(await readFile(join(runDirectory, "research.json"), "utf8"));
	if (
		typeof document !== "object" ||
		document === null ||
		!("task_hash" in document) ||
		document.task_hash !== taskHash(task)
	) {
		throw new Error("research artifacts are missing or stale for task.json");
	}
	await readFile(join(runDirectory, "research.md"), "utf8");
}
