import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// TypeScript 7 ships no programmatic API, so the specifiers are found by
// scanning source text. Every form that can carry a module specifier keeps the
// specifier as a quoted literal directly after `from`, `import`, `import(` or
// `export … from`, which is all the scanner needs.
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const SPECIFIER_PATTERN =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+(?:type\s+)?)(["'])((?:\\.|(?!\1)[^\\\n])*)\1/gu;
const files = [];

function collectTypescriptFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectTypescriptFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(join(directory, entry.name));
		}
	}
}

function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

/** 1-based line and column of an offset, matching the compiler's positions. */
function positionOf(sourceText, offset) {
	const before = sourceText.slice(0, offset);
	const line = before.split("\n").length;
	const character = offset - before.lastIndexOf("\n");
	return { line, character };
}

const failures = [];

collectTypescriptFiles(".");

for (const file of files.sort()) {
	const sourceText = readFileSync(file, "utf8");
	for (const match of sourceText.matchAll(SPECIFIER_PATTERN)) {
		const specifier = match[2];
		if (!isRelativeJavaScriptSpecifier(specifier)) continue;
		const quoteOffset = match.index + match[0].length - specifier.length - 2;
		const { line, character } = positionOf(sourceText, quoteOffset);
		// A specifier after `//` on its own line is commented out, not imported.
		if (sourceText.slice(quoteOffset - character + 1, quoteOffset).includes("//")) continue;
		failures.push(`${file}:${line}:${character}: ${specifier}`);
	}
}

if (failures.length > 0) {
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
