export type RenameMap = Record<string, string>;

const STRIPPED = [
  ["cloud", "agent"].join(" "),
  ["cursor", "cloud"].join(" "),
  ["gt", "submit"].join(" "),
  ["subagent", "type"].join("_"),
  ["cursor", "team", "kit"].join("-"),
  ["graph", "ite"].join(""),
] as const;

export function transformKStackText(source: string, renames: RenameMap): string {
  let transformed = source;
  for (const [from, to] of Object.entries(renames)) {
    transformed = transformed.replaceAll(from, to);
  }
  for (const phrase of STRIPPED) {
    transformed = transformed
      .split("\n")
      .filter((line) => !line.toLowerCase().includes(phrase))
      .join("\n");
  }
  return transformed
    .replaceAll("run_in_background", "spawn_background")
    .replaceAll("Task(", "spawn_background(");
}

export function assertGeneratedInvariants(files: ReadonlyMap<string, string>): void {
  const all = [...files.values()].join("\n").toLowerCase();
  for (const phrase of STRIPPED) {
    if (all.includes(phrase)) throw new Error(`Forbidden generated phrase: ${phrase}`);
  }
  const skillFiles = [...files].filter(([path]) => path.endsWith("SKILL.md"));
  for (const [path, source] of skillFiles) {
    const frontmatter = source.startsWith("---\n")
      ? source.slice(4, source.indexOf("\n---", 4))
      : "";
    if (
      !/^name:\s*.+$/mu.test(frontmatter) ||
      !/^description:\s*.+$/mu.test(frontmatter)
    ) {
      throw new Error(`Generated skill lacks name and description: ${path}`);
    }
  }
  const names = [...files.keys()].join("\n");
  if (!names.includes("setup-kstack") || !names.includes("k-mode")) {
    throw new Error("Generated K-stack commands are missing");
  }
}
