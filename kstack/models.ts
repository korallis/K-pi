import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promptResearchSetup } from "../extensions/research/setup.ts";

export interface KStackModels {
  version: 1;
  roles: Record<string, string | string[]>;
  inherit_parent: false;
}

const ROLE_ORDER = ["implementer", "frontend", "judgment", "precise", "fast"] as const;

export function availableSlugs(models: readonly Model<any>[]): string[] {
  return models.map((model) => `${model.provider}/${model.id}`);
}

export function createSuggestedModels(slugs: readonly string[]): KStackModels {
  const roles: Record<string, string | string[]> = {};
  ROLE_ORDER.forEach((role, index) => {
    const slug = slugs[index % Math.max(slugs.length, 1)];
    if (slug !== undefined) roles[role] = slug;
  });
  const families = slugs.filter((slug, index) =>
    slugs.findIndex((candidate) => candidate.split("/")[0] === slug.split("/")[0]) === index,
  );
  roles.review_panel = families.slice(0, 2);
  return { version: 1, roles, inherit_parent: false };
}

export function assertKnownModels(document: KStackModels, slugs: readonly string[]): void {
  const allowed = new Set(slugs);
  for (const value of Object.values(document.roles).flatMap((entry) =>
    Array.isArray(entry) ? entry : [entry],
  )) {
    if (!allowed.has(value)) throw new Error(`Unknown model slug: ${value}`);
  }
}

export async function writeKStackModels(
  document: KStackModels,
  slugs: readonly string[],
  path = join(homedir(), ".pi", "agent", "kstack", "models.json"),
): Promise<void> {
  assertKnownModels(document, slugs);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(document, null, 2)}\n`);
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

export function registerKStackSetup(pi: ExtensionAPI): void {
  pi.registerCommand("setup-kstack", {
    description: "Map K-stack roles onto available K-π models",
    handler: async (_args, context) => {
      const slugs = availableSlugs(context.modelRegistry.getAvailable());
      if (slugs.length === 0) {
        context.ui.notify("No configured K-π models are available; skipping model map.", "warning");
      } else {
        const suggested = createSuggestedModels(slugs);
        context.ui.notify(
          Object.entries(suggested.roles).map(([role, slug]) => `${role} → ${Array.isArray(slug) ? slug.join(", ") : slug}`).join("\n"),
          "info",
        );
        if (await context.ui.confirm("K-stack models", "Apply this live-registry model map?")) {
          await writeKStackModels(suggested, slugs);
          context.ui.notify("K-stack model map saved", "info");
        }
      }
      await promptResearchSetup(context);
    },
  });
}
