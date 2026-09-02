/**
 * Read-only classification of a shell command line.
 *
 * The policy's old safe list was nineteen exact strings, and any composition
 * at all — a pipe, a `;`, a `$(…)` — was categorically "unknown". That made
 * every ordinary inspection command a confirm dialog. This module reads the
 * command the way a shell would: it splits it into simple commands, classifies
 * every segment, and says the whole line is read-only only when every segment
 * is. It never executes anything and never throws; anything it cannot parse is
 * not read-only.
 *
 * The classifier judges *mutation*, not *secrecy*: `cat .env` is read-only here
 * and is denied by the policy's secret-path rule before this module is asked.
 */

export type ShellClassification =
	| { readOnly: true }
	| {
			readOnly: false;
			/** Why this segment is not read-only, in operator words. */
			reason: string;
			/** The simple command that decided it, when there is one. */
			segment?: string;
	  };

interface SimpleCommand {
	words: string[];
	redirects: string[];
	/** Bodies of `$(…)`, backticks, and `( … )` subshells; classified recursively. */
	substitutions: string[];
}

class ParseError extends Error {}

const READ_ONLY: ShellClassification = { readOnly: true };

function notReadOnly(reason: string, segment?: string): ShellClassification {
	return segment === undefined ? { readOnly: false, reason } : { readOnly: false, reason, segment };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * One pass over the source. Quotes are honoured, substitutions are captured
 * whole, operators end simple commands. `case … in pattern)` is tracked so a
 * pattern's closing paren is not read as a stray subshell end.
 */
class Scanner {
	private index = 0;
	private word = "";
	private wordStarted = false;
	private current: SimpleCommand = { words: [], redirects: [], substitutions: [] };
	private readonly commands: SimpleCommand[] = [];
	private caseDepth = 0;
	private readonly source: string;

	constructor(source: string) {
		this.source = source;
	}

	scan(): SimpleCommand[] {
		while (this.index < this.source.length) {
			this.step();
		}
		this.endWord();
		this.endCommand();
		return this.commands;
	}

	private peek(offset = 0): string {
		return this.source[this.index + offset] ?? "";
	}

	private take(): string {
		const character = this.source[this.index] ?? "";
		this.index += 1;
		return character;
	}

	private append(text: string): void {
		this.word += text;
		this.wordStarted = true;
	}

	private endWord(): void {
		if (this.wordStarted) {
			this.current.words.push(this.word);
		}
		this.word = "";
		this.wordStarted = false;
	}

	private endCommand(): void {
		this.endWord();
		const { words, redirects, substitutions } = this.current;
		if (words.length > 0 || redirects.length > 0 || substitutions.length > 0) {
			this.commands.push(this.current);
			this.trackCase(words);
		}
		this.current = { words: [], redirects: [], substitutions: [] };
	}

	private trackCase(words: string[]): void {
		if (words[0] === "case") this.caseDepth += 1;
		if (words.includes("esac") && this.caseDepth > 0) this.caseDepth -= 1;
	}

	private step(): void {
		const character = this.peek();
		if (character === " " || character === "\t") {
			this.take();
			this.endWord();
			return;
		}
		if (character === "#" && !this.wordStarted) {
			this.skipComment();
			return;
		}
		if (this.stepOperator(character)) return;
		if (this.stepQuote(character)) return;
		if (this.stepExpansion(character)) return;
		if (this.stepRedirect(character)) return;
		if (this.stepGroup(character)) return;
		this.append(this.take());
	}

	private skipComment(): void {
		while (this.index < this.source.length && this.peek() !== "\n") this.take();
	}

	/** Separators between simple commands; `&` on its own is a background job. */
	private stepOperator(character: string): boolean {
		if (character === "\n" || character === ";") {
			this.take();
			// `;;`, `;&` and `;;&` close a case arm; `;` closes a command.
			while (this.peek() === ";" || this.peek() === "&") this.take();
			this.endCommand();
			return true;
		}
		if (character === "|") {
			this.take();
			if (this.peek() === "|" || this.peek() === "&") this.take();
			this.endCommand();
			return true;
		}
		if (character === "&") {
			if (this.peek(1) === "&") {
				this.take();
				this.take();
				this.endCommand();
				return true;
			}
			if (this.peek(1) === ">") return false; // `&>` is a redirect
			throw new ParseError("a background job (&) cannot be classified");
		}
		return false;
	}

	private stepQuote(character: string): boolean {
		if (character === "\\") {
			this.take();
			this.append(this.take());
			return true;
		}
		if (character === "'" || (character === "$" && this.peek(1) === "'")) {
			if (character === "$") this.take();
			this.take();
			this.append(this.readUntil("'", "an unterminated single quote"));
			this.take();
			return true;
		}
		if (character === '"') {
			this.take();
			this.readDoubleQuoted();
			return true;
		}
		return false;
	}

	private readUntil(terminator: string, failure: string): string {
		const end = this.source.indexOf(terminator, this.index);
		if (end < 0) throw new ParseError(failure);
		const text = this.source.slice(this.index, end);
		this.index = end;
		return text;
	}

	private readDoubleQuoted(): void {
		this.wordStarted = true;
		for (;;) {
			if (this.index >= this.source.length) throw new ParseError("an unterminated double quote");
			const character = this.peek();
			if (character === '"') {
				this.take();
				return;
			}
			if (character === "\\") {
				this.take();
				this.append(this.take());
				continue;
			}
			if (character === "`" || (character === "$" && this.peek(1) === "(")) {
				this.captureSubstitution();
				continue;
			}
			if (character === "$" && this.peek(1) === "{") {
				this.take();
				this.append(this.readParameterExpansion());
				continue;
			}
			this.append(this.take());
		}
	}

	/** `$(…)`, `` `…` ``, `${…}`, `$((…))`; the first two are commands of their own. */
	private stepExpansion(character: string): boolean {
		if (character === "`") {
			this.captureSubstitution();
			return true;
		}
		if (character !== "$") return false;
		if (this.peek(1) === "(" && this.peek(2) === "(") {
			this.take();
			this.append(this.readBalanced("(", ")"));
			return true;
		}
		if (this.peek(1) === "(") {
			this.captureSubstitution();
			return true;
		}
		if (this.peek(1) === "{") {
			this.take();
			this.append(this.readParameterExpansion());
			return true;
		}
		this.append(this.take());
		return true;
	}

	private captureSubstitution(): void {
		this.wordStarted = true;
		if (this.peek() === "`") {
			this.take();
			const body = this.readUntil("`", "an unterminated backtick");
			this.take();
			this.current.substitutions.push(body);
			this.append("`…`");
			return;
		}
		this.take(); // `$`
		const body = this.readBalanced("(", ")");
		this.current.substitutions.push(body.slice(1, -1));
		this.append("$(…)");
	}

	/** Returns the balanced text including both delimiters; the index lands after it. */
	private readBalanced(open: string, close: string): string {
		let depth = 0;
		const start = this.index;
		while (this.index < this.source.length) {
			const character = this.take();
			if (character === "\\") {
				this.take();
				continue;
			}
			if (character === "'") {
				this.readUntil("'", "an unterminated single quote");
				this.take();
				continue;
			}
			if (character === open) depth += 1;
			if (character === close) {
				depth -= 1;
				if (depth === 0) return this.source.slice(start, this.index);
			}
		}
		throw new ParseError(`an unbalanced ${open}`);
	}

	private readParameterExpansion(): string {
		const body = this.readBalanced("{", "}");
		if (body.includes("$(") || body.includes("`")) {
			throw new ParseError("a command substitution inside a parameter expansion");
		}
		return `$${body}`;
	}

	private stepRedirect(character: string): boolean {
		if (character !== "<" && character !== ">" && !(character === "&" && this.peek(1) === ">")) return false;
		// A lone digit before the operator is its file descriptor, not a word.
		let descriptor = "";
		if (this.wordStarted && /^\d$/u.test(this.word)) {
			descriptor = this.word;
			this.word = "";
			this.wordStarted = false;
		} else {
			this.endWord();
		}
		const operator = this.readRedirectOperator();
		const target = this.readRedirectTarget();
		this.current.redirects.push(`${descriptor}${operator}${target}`);
		return true;
	}

	private readRedirectOperator(): string {
		let operator = this.take();
		if (operator === "&") operator += this.take(); // `&>`
		while (this.peek() === ">" || this.peek() === "<" || this.peek() === "&" || this.peek() === "|") {
			operator += this.take();
		}
		if (operator.includes("<<")) throw new ParseError("a heredoc or here-string");
		if (this.peek() === "(") throw new ParseError("a process substitution");
		return operator;
	}

	private readRedirectTarget(): string {
		while (this.peek() === " " || this.peek() === "\t") this.take();
		let target = "";
		while (this.index < this.source.length && !/[\s;&|<>()]/u.test(this.peek())) {
			const character = this.take();
			if (character === "'" || character === '"') {
				target += this.readUntil(character, "an unterminated quote in a redirect");
				this.take();
				continue;
			}
			target += character;
		}
		return target;
	}

	/** `( … )` subshells and `case` pattern parens. */
	private stepGroup(character: string): boolean {
		if (character === "(") {
			if (this.wordStarted) throw new ParseError("a function definition or a stray paren");
			const body = this.readBalanced("(", ")");
			this.current.substitutions.push(body.slice(1, -1));
			this.append("(…)");
			return true;
		}
		if (character === ")") {
			if (this.current.words[0] === "case") this.caseDepth += 1;
			if (this.caseDepth === 0) throw new ParseError("an unbalanced )");
			// A case pattern: everything since the last separator is the pattern,
			// which matches text and runs nothing.
			this.take();
			this.word = "";
			this.wordStarted = false;
			this.current.words = [];
			return true;
		}
		return false;
	}
}

export function tokenizeShellCommand(command: string): SimpleCommand[] {
	return new Scanner(command).scan();
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Words that structure a script and run nothing themselves. */
const PREFIX_CONTROL_WORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "time"]);
const STANDALONE_CONTROL_WORDS = new Set(["fi", "done", "esac", "}", "]]", ";;", ":", "true", "false", "exit"]);
/** Builtins that touch shell state and nothing else. */
const SHELL_STATE_BUILTINS = new Set([
	"read",
	"local",
	"export",
	"unset",
	"shift",
	"break",
	"continue",
	"return",
	"wait",
]);

/** Redirects that reach no file an operator could care about. */
const HARMLESS_REDIRECT = /^(?:\d?>&[12-]|\d?>>?\/dev\/null|&>>?\/dev\/null|\d?>&-|<[^<]*)$/u;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const HELP_OR_VERSION = new Set(["--help", "--version", "-h", "-v", "-V", "-version"]);

type Refinement = (args: readonly string[]) => boolean;

const always: Refinement = () => true;
const withoutFlags =
	(...forbidden: string[]): Refinement =>
	(args) =>
		!args.some((arg) => forbidden.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));

const GIT_READ_VERBS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"blame",
	"describe",
	"shortlog",
	"name-rev",
	"cat-file",
	"help",
	"--version",
	"var",
	"check-ignore",
	"merge-base",
]);
const GIT_BRANCH_LIST_FLAGS =
	/^(?:--show-current|--list|-a|-r|-v|-vv|--all|--remotes|--verbose|--contains=?.*|--merged=?.*|--no-merged=?.*|--format=.*|--sort=.*|--points-at=?.*|--column|--no-column)$/u;

function gitRefinement(rawArgs: readonly string[]): boolean {
	const args = [...rawArgs];
	while (args[0] === "--no-pager" || args[0] === "-P" || args[0] === "-C") {
		if (args.shift() === "-C") args.shift();
	}
	if (args.some((arg) => arg.startsWith("--output"))) return false;
	const [verb, ...rest] = args;
	if (verb === undefined) return false;
	if (GIT_READ_VERBS.has(verb)) return true;
	switch (verb) {
		case "branch":
			return rest.every((arg) => GIT_BRANCH_LIST_FLAGS.test(arg));
		case "remote":
			return rest.length === 0 || rest[0] === "-v" || rest[0] === "show" || rest[0] === "get-url";
		case "config":
			return ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(rest[0] ?? "");
		case "stash":
			return rest[0] === "list" || rest[0] === "show";
		case "reflog":
			return rest.length === 0 || rest[0] === "show";
		case "tag":
			return (
				rest.length === 0 ||
				rest.every((arg) => arg === "-l" || arg === "--list" || arg === "-n" || !arg.startsWith("-"))
			);
		case "worktree":
			return rest[0] === "list";
		default:
			return false;
	}
}

function npmRefinement(args: readonly string[]): boolean {
	const [verb, ...rest] = args;
	if (verb === undefined) return false;
	if (
		["ls", "list", "ll", "la", "view", "info", "show", "outdated", "why", "explain", "--version", "-v"].includes(verb)
	) {
		return true;
	}
	if (verb === "audit") return !rest.includes("fix");
	if (verb === "config") return ["get", "list", "ls"].includes(rest[0] ?? "");
	if (verb === "pkg") return rest[0] === "get";
	return false;
}

function sedRefinement(args: readonly string[]): boolean {
	const quiet = args.some(
		(arg) => arg === "-n" || arg === "--quiet" || arg === "--silent" || /^-[a-zA-Z]*n[a-zA-Z]*$/u.test(arg),
	);
	if (!quiet) return false;
	if (args.some((arg) => arg === "-i" || arg.startsWith("--in-place") || /^-[a-zA-Z]*i/u.test(arg))) return false;
	return !args.some((arg) => /(?:^|[;{\s])[wW]\s/u.test(arg));
}

function awkRefinement(args: readonly string[]): boolean {
	if (args.some((arg) => arg === "-i" || arg.startsWith("--in-place"))) return false;
	return !args.some((arg) => /system\s*\(|>|\|/u.test(arg));
}

const findRefinement = withoutFlags(
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-fls",
);

/** Each head names the flags that would turn a reader into a writer or a runner. */
const READ_ONLY_HEADS: Record<string, Refinement> = {
	cat: always,
	head: always,
	tail: always,
	less: always,
	more: always,
	grep: always,
	egrep: always,
	fgrep: always,
	rg: withoutFlags("--pre"),
	ls: always,
	pwd: always,
	echo: always,
	printf: always,
	wc: always,
	sort: withoutFlags("-o", "--output"),
	uniq: always,
	cut: always,
	tr: always,
	diff: always,
	cmp: always,
	comm: always,
	file: always,
	stat: always,
	du: always,
	df: always,
	tree: withoutFlags("-o"),
	which: always,
	whereis: always,
	type: always,
	env: always,
	printenv: always,
	uname: always,
	whoami: always,
	id: always,
	hostname: always,
	arch: always,
	nproc: always,
	uptime: always,
	ps: always,
	lsof: always,
	date: withoutFlags("-s", "--set"),
	basename: always,
	dirname: always,
	realpath: always,
	readlink: always,
	jq: always,
	column: always,
	nl: always,
	tac: always,
	fold: always,
	paste: always,
	seq: always,
	expr: always,
	sleep: always,
	md5sum: always,
	sha1sum: always,
	sha256sum: always,
	shasum: always,
	strings: always,
	od: always,
	hexdump: always,
	test: always,
	"[": always,
	"[[": always,
	sed: sedRefinement,
	awk: awkRefinement,
	gawk: awkRefinement,
	mawk: awkRefinement,
	find: findRefinement,
	fd: withoutFlags("-x", "--exec", "-X", "--exec-batch"),
	git: gitRefinement,
	npm: npmRefinement,
	pnpm: (args) => ["ls", "list", "why", "outdated", "--version", "-v"].includes(args[0] ?? ""),
	yarn: (args) => ["--version", "-v", "list", "why", "info"].includes(args[0] ?? ""),
	bun: (args) => args[0] === "--version" || args[0] === "-v",
	node: (args) => args.length === 1 && (args[0] === "--version" || args[0] === "-v"),
	java: (args) => args.length === 1 && (args[0] === "-version" || args[0] === "--version"),
	go: (args) => args[0] === "version",
};

interface Wrapper {
	/** Returns the wrapped command's words, or `undefined` when the wrapper alone is the command. */
	unwrap(args: readonly string[]): readonly string[] | undefined;
}

function dropFlags(args: readonly string[], valued: RegExp, bare: RegExp): readonly string[] {
	const rest = [...args];
	while (rest.length > 0) {
		const head = rest[0] ?? "";
		if (valued.test(head)) {
			rest.splice(0, head.includes("=") || /^-[a-zA-Z]\S+$/u.test(head) ? 1 : 2);
		} else if (bare.test(head) || ASSIGNMENT.test(head)) {
			rest.shift();
		} else {
			break;
		}
	}
	return rest;
}

const WRAPPERS: Record<string, Wrapper> = {
	env: { unwrap: (args) => dropFlags(args, /^(?:-u|--unset)/u, /^(?:-i|-0|--ignore-environment|--null)$/u) },
	command: {
		unwrap: (args) => {
			if (args[0] === "-v" || args[0] === "-V") return undefined;
			return args[0] === "-p" ? args.slice(1) : args;
		},
	},
	xargs: {
		unwrap: (args) => {
			const rest = dropFlags(
				args,
				/^(?:-n|-I|-d|-P|-L|-s|-E|--max-args|--replace|--delimiter|--max-procs|--max-lines)/u,
				/^(?:-0|-r|-t|-p|--null|--no-run-if-empty|--verbose)$/u,
			);
			return rest.length === 0 ? undefined : rest;
		},
	},
	timeout: {
		unwrap: (args) => {
			const rest = dropFlags(
				args,
				/^(?:-s|-k|--signal|--kill-after)/u,
				/^(?:--foreground|--preserve-status|-v|--verbose)$/u,
			);
			return rest.slice(1); // the duration operand
		},
	},
	nice: { unwrap: (args) => dropFlags(args, /^(?:-n|--adjustment)/u, /^-\d+$/u) },
	time: { unwrap: (args) => dropFlags(args, /^(?:-f|-o|--format|--output)/u, /^(?:-p|-v|--verbose|--portability)$/u) },
};

function headName(word: string): string {
	return word.startsWith("/") ? (word.split("/").pop() ?? word) : word;
}

function classifyWords(rawWords: readonly string[], depth: number): ShellClassification {
	const words = [...rawWords];
	while (words.length > 0 && PREFIX_CONTROL_WORDS.has(words[0] ?? "")) words.shift();
	while (words.length > 0 && ASSIGNMENT.test(words[0] ?? "")) words.shift();
	if (words.length === 0) return READ_ONLY;

	const head = headName(words[0] ?? "");
	const args = words.slice(1);
	const segment = words.join(" ");

	if (STANDALONE_CONTROL_WORDS.has(head) || SHELL_STATE_BUILTINS.has(head)) return READ_ONLY;
	// A subshell's body was classified with the substitutions; running the
	// *output* of a substitution as the command is another matter entirely.
	if (head === "(…)") return args.length === 0 ? READ_ONLY : notReadOnly("a subshell with trailing words", segment);
	if (head === "$(…)" || head === "`…`") return notReadOnly("a command taken from substitution output", segment);
	if (head === "for" || head === "case" || head === "select" || head === "in") return READ_ONLY;
	if (head === "set") {
		return args.every((arg) => /^[-+][a-zA-Z]+$/u.test(arg) || arg === "-o" || arg === "+o" || /^[a-z]+$/u.test(arg))
			? READ_ONLY
			: notReadOnly("set with positional parameters", segment);
	}
	if (head === "cd") return args.length <= 1 ? READ_ONLY : notReadOnly("cd with extra arguments", segment);

	const wrapper = WRAPPERS[head];
	if (wrapper !== undefined) {
		const inner = wrapper.unwrap(args);
		if (inner === undefined) return READ_ONLY;
		if (depth > 8) return notReadOnly("wrappers nested too deeply", segment);
		return classifyWords(inner, depth + 1);
	}

	const refinement = READ_ONLY_HEADS[head];
	if (refinement !== undefined) {
		return refinement(args) ? READ_ONLY : notReadOnly(`${head} with an argument that writes or executes`, segment);
	}
	if (args.length === 1 && HELP_OR_VERSION.has(args[0] ?? "")) return READ_ONLY;
	return notReadOnly(`unknown head "${head}"`, segment);
}

function classifySimple(command: SimpleCommand, depth: number): ShellClassification {
	for (const body of command.substitutions) {
		const nested = classifyCommand(body, depth + 1);
		if (!nested.readOnly) return nested;
	}
	const redirect = command.redirects.find((entry) => !HARMLESS_REDIRECT.test(entry));
	if (redirect !== undefined) {
		return notReadOnly(`a redirect that writes a file (${redirect})`, command.words.join(" "));
	}
	return classifyWords(command.words, depth);
}

function classifyCommand(command: string, depth: number): ShellClassification {
	if (depth > 8) return notReadOnly("substitutions nested too deeply");
	let commands: SimpleCommand[];
	try {
		commands = tokenizeShellCommand(command);
	} catch (error) {
		if (error instanceof ParseError) return notReadOnly(error.message);
		throw error;
	}
	for (const simple of commands) {
		const verdict = classifySimple(simple, depth);
		if (!verdict.readOnly) return verdict;
	}
	return READ_ONLY;
}

/** Whole-command verdict. Never throws; unparseable input is not read-only. */
export function classifyShellCommand(command: string): ShellClassification {
	if (command.trim().length === 0) return READ_ONLY;
	return classifyCommand(command, 0);
}

export function isReadOnlyShellCommand(command: string): boolean {
	return classifyShellCommand(command).readOnly;
}
