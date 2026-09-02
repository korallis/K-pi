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
