import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { assertGeneratedInvariants, transformKStackText, type RenameMap } from "../overlay/transforms.ts";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const generatedPath = join(root, "generated");
const upstreamPath = join(root, "upstream");
const overlayPath = join(root, "overlay");
const upstreamDocument = join(root, "UPSTREAM.md");

interface Options { check: boolean; pin?: string; source?: string; patches?: string }

function parseOptions(args: string[]): Options {
  const options: Options = { check: args.includes("--check") };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--pin") options.pin = args[++index];
    if (args[index] === "--source") options.source = args[++index];
    if (args[index] === "--patches") options.patches = args[++index];
  }
  if (options.check && options.pin !== undefined) throw new Error("--check and --pin are mutually exclusive");
  return options;
}

async function pinnedSha(): Promise<string> {
  const source = await readFile(upstreamDocument, "utf8");
  const match = source.match(/\| Commit \| ([0-9a-f]{40}) \|/u);
  if (match === null) throw new Error("UPSTREAM.md has no pinned commit");
  return match[1];
}

async function files(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.set(relative(directory, path), await readFile(path, "utf8"));
    }
  }
  try { await visit(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

function digest(entries: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, source] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update("\0").update(source).update("\0");
  }
  return hash.digest("hex");
}

async function materializeSource(options: Options, work: string, sha: string): Promise<string> {
  if (options.source !== undefined) return options.source;
  const clone = join(work, "clone");
  await exec("git", ["clone", "--filter=blob:none", "--no-checkout", "https://github.com/cursor/plugins.git", clone]);
  await exec("git", ["sparse-checkout", "set", "pstack"], { cwd: clone });
  await exec("git", ["checkout", sha], { cwd: clone });
  return join(clone, "pstack");
}

async function writeTree(directory: string, entries: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, source] of entries) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
}

async function applyPatches(
  directory: string,
  patchDirectory: string,
): Promise<void> {
  let patches: string[] = [];
  try { patches = (await readdir(patchDirectory)).filter((name) => name.endsWith(".patch")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const patch of patches) {
    const path = join(patchDirectory, patch);
    await exec("git", ["apply", "--check", path], { cwd: directory });
    await exec("git", ["apply", path], { cwd: directory });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const oldPin = await pinnedSha();
  const sha = options.pin ?? oldPin;
  const work = await mkdtemp(join(tmpdir(), "kstack-sync-"));
  try {
    const source = await materializeSource(options, work, sha);
    const raw = await files(source);
    const renames = JSON.parse(await readFile(join(overlayPath, "rename-map.json"), "utf8")) as RenameMap;
    const transformed = new Map([...raw].map(([path, content]) => [
      Object.entries(renames).reduce((value, [from, to]) => value.replaceAll(from, to), path),
      transformKStackText(content, renames),
    ]));
    const candidate = join(work, "generated");
    await writeTree(candidate, transformed);
    await applyPatches(
      candidate,
      options.patches === undefined
        ? join(overlayPath, "patches")
        : resolve(options.patches),
    );
    const finalFiles = await files(candidate);
    assertGeneratedInvariants(finalFiles);
    const current = await files(generatedPath);
    if (options.check) {
      if (sha !== oldPin || digest(current) !== digest(finalFiles)) throw new Error("K-stack generated tree drifted");
      return;
    }
    if (digest(current) === digest(finalFiles) && options.pin === undefined) return;
    const next = `${generatedPath}.next`;
    const previous = `${generatedPath}.previous`;
    await rm(next, { recursive: true, force: true });
    await cp(candidate, next, { recursive: true });
    await rm(previous, { recursive: true, force: true });
    if ((await stat(generatedPath).catch(() => undefined)) !== undefined) await rename(generatedPath, previous);
    await rename(next, generatedPath);
    await rm(previous, { recursive: true, force: true });
    await rm(upstreamPath, { recursive: true, force: true });
    await cp(source, upstreamPath, { recursive: true });
    if (options.pin !== undefined && sha !== oldPin) {
      const document = (await readFile(upstreamDocument, "utf8")).replace(oldPin, sha);
      await writeFile(upstreamDocument, document);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
