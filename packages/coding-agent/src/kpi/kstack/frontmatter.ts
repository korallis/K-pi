/**
 * The skill frontmatter contract, as runtime code.
 *
 * Both the overlay validator and the K-mode playbook loader need to read a skill
 * header, and only one of them is maintainer tooling. Keeping the parser here
 * means the runtime never imports the build pipeline - which is also what stops
 * the overlay from being emitted into the shipped tree.
 */

export interface Frontmatter {
	readonly fields: Readonly<Record<string, string>>;
	readonly body: string;
}

/**
 * Parses the leading YAML frontmatter block.
 *
 * A deliberately small parser: scalar `key: value` pairs, quoted or bare, plus
 * folded values continued on an indented line. Skill frontmatter is a flat map by
 * contract, so a nested document is a diagnostic rather than something to guess
 * at.
 */
export function parseFrontmatter(source: string): Frontmatter | undefined {
	if (!source.startsWith("---\n")) {
		return undefined;
	}
	const end = source.indexOf("\n---", 3);
	if (end === -1) {
		return undefined;
	}
	const block = source.slice(4, end + 1);
	const body = source.slice(source.indexOf("\n", end + 1) + 1);
	const fields: Record<string, string> = {};
	let current: string | undefined;
	for (const raw of block.split("\n")) {
		if (raw.trim().length === 0) {
			continue;
		}
		const match = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/u.exec(raw);
		if (match === null) {
			if (current !== undefined && /^\s+\S/u.test(raw)) {
				fields[current] = `${fields[current]} ${raw.trim()}`.trim();
				continue;
			}
			return undefined;
		}
		current = match[1];
		fields[current] = unquote(match[2].trim());
	}
	return { fields, body };
}

function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		const inner = value.slice(1, -1);
		return value.startsWith('"') ? inner.replace(/\\"/gu, '"').replace(/\\n/gu, "\n") : inner;
	}
	return value;
}
