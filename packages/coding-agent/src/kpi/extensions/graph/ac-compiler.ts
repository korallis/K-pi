export type AcceptanceQuality = "executable" | "partial" | "narrative";

export type AcceptanceCheckKind =
	| "command"
	| "file_exists"
	| "file_absent"
	| "grep_empty"
	| "grep_matches"
	| "json_path"
	| "http_probe";

export interface AcceptanceCheck {
	kind: AcceptanceCheckKind;
	cmd?: string;
	expect?: {
		exit?: number;
		stdout_includes?: string[];
	};
	[key: string]: unknown;
}

export interface AcceptanceBounds {
	write_allow?: string[];
	write_deny?: string[];
}

export interface CompiledAcceptanceCriterion {
	id: string;
	statement: string;
	required: boolean;
	check?: AcceptanceCheck;
	bounds?: AcceptanceBounds;
}

export type MissingAcceptancePart = "check" | "bounds";

export interface MissingAcceptanceCheck {
	id: string;
	statement: string;
	missing: MissingAcceptancePart[];
}

export interface AcceptanceScore {
	quality: AcceptanceQuality;
	missingChecks: MissingAcceptanceCheck[];
}

export interface AcceptanceCompilation extends AcceptanceScore {
	acceptance: CompiledAcceptanceCriterion[];
}

function trimWrappingQuotes(value: string): string {
	const trimmed = value.trim();
	const first = trimmed[0];
	const last = trimmed.at(-1);
	if (
		trimmed.length >= 2 &&
		((first === "`" && last === "`") || (first === '"' && last === '"') || (first === "'" && last === "'"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function parseCommandCheck(input: string): AcceptanceCheck | undefined {
	const match = /\bcmd\s+(.+?)\s+exits?\s+(-?\d+)\b/i.exec(input);
	if (match === null) {
		return undefined;
	}

	const cmd = trimWrappingQuotes(match[1]);
	if (cmd.length === 0) {
		return undefined;
	}

	return {
		kind: "command",
		cmd,
		expect: { exit: Number.parseInt(match[2], 10) },
	};
}

function parseWriteBounds(input: string): AcceptanceBounds | undefined {
	const match = /\bwrites?\s+only\s+(.+?)(?=\s*;|\n|$)/i.exec(input);
	if (match === null) {
		return undefined;
	}

	const pathList = match[1].trim().replace(/[.!?]+$/, "");
	const writeAllow = pathList
		.split(/\s*(?:,|\band\b)\s*/i)
		.map(trimWrappingQuotes)
		.filter((path) => path.length > 0);

	return writeAllow.length > 0 ? { write_allow: writeAllow } : undefined;
}

function scoreCompiledCriteria(criteria: readonly CompiledAcceptanceCriterion[]): AcceptanceScore {
	const requiredCriteria = criteria.filter((criterion) => criterion.required);
	const missingChecks = requiredCriteria.flatMap((criterion) => {
		const missing: MissingAcceptancePart[] = [];
		if (criterion.check === undefined) {
			missing.push("check");
		}
		if (criterion.bounds === undefined) {
			missing.push("bounds");
		}
		return missing.length === 0 ? [] : [{ id: criterion.id, statement: criterion.statement, missing }];
	});

	if (requiredCriteria.length === 0) {
		return { quality: "narrative", missingChecks };
	}
	if (missingChecks.length === 0) {
		return { quality: "executable", missingChecks };
	}

	const hasExecutableDetail = requiredCriteria.some(
		(criterion) => criterion.check !== undefined || criterion.bounds !== undefined,
	);
	return {
		quality: hasExecutableDetail ? "partial" : "narrative",
		missingChecks,
	};
}

function acceptanceStatements(input: string): Array<{ id: string; statement: string }> {
	const lines = input
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const labeled = lines.map((line) => /^(AC-\d+(?:\.\d+)?):\s*(.+)$/iu.exec(line));
	if (labeled.length > 0 && labeled.every((match) => match !== null)) {
		return labeled.map((match) => ({
			id: match![1].toUpperCase(),
			statement: match![2].trim().replace(/\s+/g, " "),
		}));
	}
	return [{ id: "AC-01", statement: input.trim().replace(/\s+/g, " ") }];
}

export function compileAcceptanceCriteria(input: string): AcceptanceCompilation {
	const acceptance: CompiledAcceptanceCriterion[] = acceptanceStatements(input).map(({ id, statement }) => ({
		id,
		statement,
		required: true,
		check: parseCommandCheck(statement),
		bounds: parseWriteBounds(statement),
	}));

	return { acceptance, ...scoreCompiledCriteria(acceptance) };
}

export function scoreAcceptanceCriteria(input: string | readonly CompiledAcceptanceCriterion[]): AcceptanceScore {
	if (typeof input === "string") {
		const { quality, missingChecks } = compileAcceptanceCriteria(input);
		return { quality, missingChecks };
	}
	return scoreCompiledCriteria(input);
}

/** The sole lowering from a protected structured check to a host-executed command. */
export function compileAcceptanceCheck(check: AcceptanceCheck): {
	cmd: string;
	expected_exit: number;
	stdout_includes: string[];
} {
	const expected_exit = check.expect?.exit ?? 0;
	const stdout_includes = check.expect?.stdout_includes ?? [];
	if (
		!Number.isSafeInteger(expected_exit) ||
		expected_exit < 0 ||
		expected_exit > 255 ||
		!Array.isArray(stdout_includes) ||
		stdout_includes.some((value) => typeof value !== "string")
	) {
		throw new Error("Invalid protected check expectation");
	}
	if (check.kind === "command") {
		if (typeof check.cmd !== "string" || !check.cmd.trim()) throw new Error("Command check has no concrete command");
		return { cmd: check.cmd, expected_exit, stdout_includes };
	}
	// Predicate mismatch is 1; observation/transport errors are 2 and can never prove a predicate.
	if (expected_exit !== 0 && expected_exit !== 1)
		throw new Error("Structured checks expect only predicate success (0) or mismatch (1)");
	const allowed = new Set(["kind", "expect"]);
	const text = (field: string): string => {
		const value = check[field];
		if (typeof value !== "string" || !value.length || value.includes("\0"))
			throw new Error(`Check requires a concrete ${field}`);
		return value;
	};
	let body: string;
	switch (check.kind) {
		case "file_exists":
		case "file_absent":
			allowed.add("path");
			text("path");
			body = `
let entry;
try { entry = await fs.lstat(check.path); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const exists = entry !== undefined;
process.stdout.write(JSON.stringify({path:check.path,exists,type:entry ? (entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other') : null}) + '\\n');
process.exitCode = (check.kind === 'file_exists' ? exists : !exists) ? 0 : 1;`;
			break;
		case "grep_empty":
		case "grep_matches":
			allowed.add("path");
			allowed.add("pattern");
			text("path");
			// Empty regular expressions are meaningful and match every input.
			if (typeof check.pattern !== "string") throw new Error("Check requires a pattern");
			new RegExp(check.pattern);
			body = `
const bytes = await fs.readFile(check.path);
process.stdout.write(bytes);
const matches = new RegExp(check.pattern).test(bytes.toString('utf8'));
process.exitCode = (check.kind === 'grep_matches' ? matches : !matches) ? 0 : 1;`;
			break;
		case "json_path":
			allowed.add("path");
			allowed.add("pointer");
			allowed.add("equals");
			text("path");
			if (
				typeof check.pointer !== "string" ||
				(check.pointer !== "" && !check.pointer.startsWith("/")) ||
				/~(?:[^01]|$)/.test(check.pointer) ||
				!Object.hasOwn(check, "equals") ||
				check.equals === undefined
			) {
				throw new Error("JSON check requires an RFC 6901 pointer and an equals value");
			}
			body = `
const bytes = await fs.readFile(check.path);
process.stdout.write(bytes);
let value = JSON.parse(bytes.toString('utf8'));
let found = true;
for (const part of check.pointer === '' ? [] : check.pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)
      || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(part))) { found = false; break; }
  value = value[part];
}
process.exitCode = found && require('node:util').isDeepStrictEqual(value, check.equals) ? 0 : 1;`;
			break;
		case "http_probe": {
			for (const field of ["url", "status", "timeout_ms", "max_bytes"]) allowed.add(field);
			const url = new URL(text("url"));
			if (
				url.protocol !== "http:" ||
				!["localhost", "127.0.0.1"].includes(url.hostname) ||
				url.username ||
				url.password ||
				url.hash
			) {
				throw new Error(
					"HTTP probes require a local http://localhost or http://127.0.0.1 URL without credentials or fragment",
				);
			}
			for (const [field, fallback, min, max] of [
				["status", 200, 100, 599],
				["timeout_ms", 5000, 1, 30000],
				["max_bytes", 1048576, 1, 16777216],
			] as const) {
				const value = check[field] ?? fallback;
				if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
					throw new Error(`Invalid bounded HTTP ${field}`);
				}
			}
			body = `
const {promise, resolve, reject} = Promise.withResolvers();
const url = new URL(check.url);
let bytes = 0;
const request = require('node:http').get(url, {hostname:'127.0.0.1',headers:{host:url.host}}, response => {
  process.stderr.write(JSON.stringify({url:check.url,status:response.statusCode,headers:response.rawHeaders}) + '\\n');
  response.on('data', chunk => {
    const remaining = (check.max_bytes ?? 1048576) - bytes;
    bytes += chunk.length;
    process.stdout.write(chunk.subarray(0, Math.max(0, remaining)));
    if (bytes > (check.max_bytes ?? 1048576)) {
      const error = new Error('HTTP response exceeded max_bytes');
      reject(error);
      request.destroy();
    }
  });
  response.on('error', reject);
  response.on('end', () => resolve(response.statusCode === (check.status ?? 200) ? 0 : 1));
});
const timer = setTimeout(() => {
  reject(new Error('HTTP probe exceeded timeout_ms'));
  request.destroy();
}, check.timeout_ms ?? 5000);
request.on('error', reject);
try { process.exitCode = await promise; } finally { clearTimeout(timer); }`;
			break;
		}
		default:
			throw new Error(`Unsupported check kind: ${check.kind}`);
	}
	if (Object.keys(check).some((key) => !allowed.has(key))) throw new Error("Unsupported structured check field");
	const script = `const fs = require('node:fs/promises'); const check = JSON.parse(${JSON.stringify(JSON.stringify(check))});
(async () => {${body}
})().catch(error => { process.stderr.write(String(error.stack ?? error) + '\\n'); process.exitCode = 2; });`;
	const program = `eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString('utf8'))`;
	const quote = (value: string) => (process.platform === "win32" ? `"${value}"` : `'${value.replace(/'/g, "'\\''")}'`);
	return { cmd: `${quote(process.execPath)} -e ${quote(program)}`, expected_exit, stdout_includes };
}
