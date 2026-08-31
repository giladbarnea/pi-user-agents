import type { AgentCommandName, ParsedAgentCommand } from "./shared.js";

export type ValueCompletionDomain = "model" | "path" | "provider" | "thinking" | "tool";
export type AgentOptionRole = "extension" | "forwarded" | "blocked";

export type AgentOptionDefinition = {
	semanticId: string;
	names: readonly string[];
	role: AgentOptionRole;
	arity: "boolean" | "value";
	forwardName?: string;
	placeholder?: string;
	completionDomain?: ValueCompletionDomain;
	autocomplete: boolean;
	description: string;
};

export type OptionCursorExpectation = {
	kind: "option";
	command: AgentCommandName;
	fragment: string;
	replacementStart: number;
	replacementEnd: number;
	usedSemanticIds: ReadonlySet<string>;
};

export type ValueCursorExpectation = {
	kind: "value";
	command: AgentCommandName;
	fragment: string;
	option: AgentOptionDefinition;
	parsedProvider?: string;
	replacementStart: number;
	replacementEnd: number;
	quoted: boolean;
	usedSemanticIds: ReadonlySet<string>;
};

export type AgentCursorExpectation = OptionCursorExpectation | ValueCursorExpectation;

export type AgentTokenSemantic =
	| "option"
	| "value"
	| "invalid-value"
	| "blocked"
	| "misplaced-option"
	| "misplaced-value";

export type AgentSemanticToken = {
	semantic: AgentTokenSemantic;
	start: number;
	end: number;
	option: AgentOptionDefinition;
	/** Dequoted value for leading value tokens; absent for options and prose advisories. */
	value?: string;
};

export type AgentArgumentScan = {
	isolate: boolean;
	squash: boolean;
	forwardedArgs: string[];
	/** Ordered, non-overlapping semantic tokens over the argument text. Prose stays untokenized. */
	tokens: AgentSemanticToken[];
	/** Index in the argument text where prose begins; equals its length when nothing is left. */
	proseStart: number;
	prose: string;
	task: string;
	warnings: string[];
	/** First blocked option in args mode — parseAgentCommand turns it into a hard error. */
	blocked?: AgentSemanticToken;
};

export type AgentCommandLineScan = {
	command: AgentCommandName;
	/** End of the leading /command token, in line coordinates. */
	commandEnd: number;
	/** Semantic tokens shifted into line coordinates. */
	tokens: AgentSemanticToken[];
};

export type AgentValueValidator = (
	option: AgentOptionDefinition,
	value: string,
	scan: AgentArgumentScan,
) => boolean;

export const AGENT_OPTIONS: readonly AgentOptionDefinition[] = [
	{
		semanticId: "model",
		names: ["-m", "--model"],
		role: "forwarded",
		arity: "value",
		forwardName: "--model",
		placeholder: "model",
		completionDomain: "model",
		autocomplete: true,
		description: "Select the child model",
	},
	{
		semanticId: "thinking",
		names: ["--thinking"],
		role: "forwarded",
		arity: "value",
		placeholder: "level",
		completionDomain: "thinking",
		autocomplete: true,
		description: "Set the child thinking level",
	},
	{
		semanticId: "isolate",
		names: ["-i", "--isolate"],
		role: "extension",
		arity: "boolean",
		autocomplete: true,
		description: "Start without parent-session context",
	},
	{
		semanticId: "squash",
		names: ["-s", "--squash"],
		role: "extension",
		arity: "boolean",
		autocomplete: true,
		description: "Squash the completed result into the main agent context",
	},
	{
		semanticId: "provider",
		names: ["--provider"],
		role: "forwarded",
		arity: "value",
		placeholder: "provider",
		completionDomain: "provider",
		autocomplete: true,
		description: "Scope model resolution to a provider",
	},
	{
		semanticId: "tools",
		names: ["--tools", "-t"],
		role: "forwarded",
		arity: "value",
		placeholder: "tools",
		completionDomain: "tool",
		autocomplete: true,
		description: "Enable a comma-separated tool set",
	},
	{
		semanticId: "exclude-tools",
		names: ["--exclude-tools", "-xt"],
		role: "forwarded",
		arity: "value",
		placeholder: "tools",
		completionDomain: "tool",
		autocomplete: true,
		description: "Exclude a comma-separated tool set",
	},
	{
		semanticId: "no-tools",
		names: ["--no-tools", "-nt"],
		role: "forwarded",
		arity: "boolean",
		autocomplete: true,
		description: "Disable all tools",
	},
	{
		semanticId: "no-builtin-tools",
		names: ["--no-builtin-tools", "-nbt"],
		role: "forwarded",
		arity: "boolean",
		autocomplete: true,
		description: "Disable built-in tools",
	},
	{
		semanticId: "system-prompt",
		names: ["--system-prompt"],
		role: "forwarded",
		arity: "value",
		placeholder: "text",
		autocomplete: true,
		description: "Replace the child system prompt",
	},
	{
		semanticId: "append-system-prompt",
		names: ["--append-system-prompt"],
		role: "forwarded",
		arity: "value",
		placeholder: "text",
		autocomplete: true,
		description: "Append to the child system prompt",
	},
	{
		semanticId: "extension",
		names: ["--extension", "-e"],
		role: "forwarded",
		arity: "value",
		placeholder: "path",
		completionDomain: "path",
		autocomplete: true,
		description: "Load an additional extension",
	},
	{
		semanticId: "skill",
		names: ["--skill"],
		role: "forwarded",
		arity: "value",
		placeholder: "path",
		completionDomain: "path",
		autocomplete: true,
		description: "Load an additional skill",
	},
	{
		semanticId: "prompt-template",
		names: ["--prompt-template"],
		role: "forwarded",
		arity: "value",
		placeholder: "path",
		completionDomain: "path",
		autocomplete: true,
		description: "Load an additional prompt template",
	},
	{
		semanticId: "no-extensions",
		names: ["--no-extensions", "-ne"],
		role: "forwarded",
		arity: "boolean",
		autocomplete: true,
		description: "Disable extension loading",
	},
	{
		semanticId: "no-skills",
		names: ["--no-skills", "-ns"],
		role: "forwarded",
		arity: "boolean",
		autocomplete: true,
		description: "Disable skill loading",
	},
	{
		semanticId: "no-prompt-templates",
		names: ["--no-prompt-templates", "-np"],
		role: "forwarded",
		arity: "boolean",
		autocomplete: true,
		description: "Disable prompt-template loading",
	},
	{
		semanticId: "no-themes",
		names: ["--no-themes"],
		role: "forwarded",
		arity: "boolean",
		autocomplete: true,
		description: "Disable theme loading",
	},
	{
		semanticId: "no-context-files",
		names: ["--no-context-files", "-nc"],
		role: "forwarded",
		arity: "boolean",
		autocomplete: true,
		description: "Disable context-file loading",
	},
	...valueOptionsWithoutChildEffect(),
	...booleanOptionsWithoutChildEffect(),
	...blockedOptions(),
];

const OPTION_BY_NAME = new Map(
	AGENT_OPTIONS.flatMap((option) => option.names.map((name) => [name, option] as const)),
);
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
	'"': '"',
	"'": "'",
	"`": "`",
	"‘": "’",
	"“": "”",
};

function valueOptionsWithoutChildEffect(): AgentOptionDefinition[] {
	return [
		legacyValueOption("api-key", ["--api-key"]),
		legacyValueOption("mode", ["--mode"]),
		legacyValueOption("name", ["--name", "-n"]),
		legacyValueOption("session", ["--session"]),
		legacyValueOption("session-id", ["--session-id"]),
		legacyValueOption("fork", ["--fork"]),
		legacyValueOption("session-dir", ["--session-dir"]),
	];
}

function booleanOptionsWithoutChildEffect(): AgentOptionDefinition[] {
	return [
		legacyBooleanOption("resume", ["--resume", "-r"]),
		legacyBooleanOption("no-session", ["--no-session"]),
		legacyBooleanOption("verbose", ["--verbose"]),
		legacyBooleanOption("approve", ["--approve", "-a"]),
		legacyBooleanOption("no-approve", ["--no-approve", "-na"]),
		legacyBooleanOption("offline", ["--offline"]),
	];
}

function blockedOptions(): AgentOptionDefinition[] {
	return [
		blockedOption("continue", ["-c", "--continue"]),
		blockedOption("print", ["-p", "--print"]),
		blockedOption("theme", ["--theme"], "value"),
		blockedOption("models", ["--models"]),
		blockedOption("export", ["--export"]),
		blockedOption("list-models", ["--list-models"]),
		blockedOption("help", ["-h", "--help"]),
		blockedOption("version", ["-v", "--version"]),
	];
}

function legacyValueOption(semanticId: string, names: readonly string[]): AgentOptionDefinition {
	return {
		semanticId,
		names,
		role: "forwarded",
		arity: "value",
		autocomplete: false,
		description: "Recognized legacy Pi option",
	};
}

function legacyBooleanOption(semanticId: string, names: readonly string[]): AgentOptionDefinition {
	return {
		semanticId,
		names,
		role: "forwarded",
		arity: "boolean",
		autocomplete: false,
		description: "Recognized legacy Pi option",
	};
}

function blockedOption(
	semanticId: string,
	names: readonly string[],
	arity: AgentOptionDefinition["arity"] = "boolean",
): AgentOptionDefinition {
	return {
		semanticId,
		names,
		role: "blocked",
		arity,
		autocomplete: false,
		description: "Unsupported for background runs",
	};
}

/**
 * Scan agent-command arguments into the shared semantic representation: consumed
 * options and their values with source spans, the prose boundary, warnings, and the
 * first blocked option. Runtime parsing and editor coloring both consume this scan.
 *
 * @example scanAgentArguments("-m gpt56s explain it", "agent").tokens[0]?.semantic // "option"
 */
export function scanAgentArguments(
	args: string,
	command: AgentCommandName,
	isValueValid?: AgentValueValidator,
): AgentArgumentScan {
	const tokens: AgentSemanticToken[] = [];
	const forwardedArgs: string[] = [];
	let isolate = false;
	let squash = false;
	let blocked: AgentSemanticToken | undefined;
	let consumedOption = false;
	let position = 0;
	let proseStart = 0;

	for (;;) {
		let tokenStart = position;
		while (tokenStart < args.length && /\s/.test(args[tokenStart] ?? "")) tokenStart += 1;
		let tokenEnd = tokenStart;
		while (tokenEnd < args.length && !/\s/.test(args[tokenEnd] ?? "")) tokenEnd += 1;
		const token = args.slice(tokenStart, tokenEnd);
		const option = token === "" ? undefined : OPTION_BY_NAME.get(token);
		if (token === "" || option === undefined) {
			proseStart = consumedOption ? tokenStart : 0;
			break;
		}

		const semantic = option.role === "blocked" ? "blocked" : "option";
		const optionToken: AgentSemanticToken = { semantic, start: tokenStart, end: tokenEnd, option };
		tokens.push(optionToken);
		position = tokenEnd;
		if (option.role === "blocked") {
			blocked ??= optionToken;
			if (option.arity === "value") {
				const read = readValueSpan(args, position);
				if (read !== undefined) {
					tokens.push({ semantic: "blocked", start: read.start, end: read.end, option });
					position = read.end;
				}
			}
		} else if (option.semanticId === "isolate") {
			isolate = true;
		} else if (option.semanticId === "squash") {
			squash = true;
		} else if (option.arity === "value") {
			forwardedArgs.push(option.forwardName ?? token);
			const read = readValueSpan(args, position);
			if (read !== undefined) {
				forwardedArgs.push(read.value);
				tokens.push({
					semantic: "value",
					start: read.start,
					end: read.end,
					option,
					value: read.value,
				});
				position = read.end;
			}
		} else {
			forwardedArgs.push(option.forwardName ?? token);
		}
		consumedOption = true;
	}

	const prose = args.slice(proseStart);
	const quoteMask = buildQuoteMask(prose);
	const proseSemantics = collectProseSemantics(prose, quoteMask, command);
	for (const misplaced of proseSemantics.tokens) {
		tokens.push({
			...misplaced,
			start: misplaced.start + proseStart,
			end: misplaced.end + proseStart,
		});
	}
	const scan: AgentArgumentScan = {
		isolate,
		squash,
		forwardedArgs,
		tokens,
		proseStart,
		prose,
		task: unescapeProse(prose, quoteMask),
		warnings: proseSemantics.warnings,
		blocked,
	};
	if (isValueValid === undefined) return scan;
	return {
		...scan,
		tokens: tokens.map((token) =>
			token.semantic === "value" &&
			token.value !== undefined &&
			!isValueValid(token.option, token.value, scan)
				? { ...token, semantic: "invalid-value" }
				: token,
		),
	};
}

/**
 * Scan a complete editor line, shifting semantic tokens into line coordinates.
 *
 * @example scanAgentCommandLine("/agent -m gpt56s explain it")?.commandEnd // 6
 */
export function scanAgentCommandLine(
	line: string,
	isValueValid?: AgentValueValidator,
): AgentCommandLineScan | undefined {
	const prefix = matchAgentCommandPrefix(line);
	if (!prefix) return undefined;
	const scan = scanAgentArguments(line.slice(prefix.argumentOffset), prefix.command, isValueValid);
	return {
		command: prefix.command,
		commandEnd: prefix.argumentOffset,
		tokens: scan.tokens.map((token) => ({
			...token,
			start: token.start + prefix.argumentOffset,
			end: token.end + prefix.argumentOffset,
		})),
	};
}

/**
 * Parse submitted agent-command arguments through the shared option declaration.
 *
 * @example parseAgentCommand("-m gpt56s explain it", "agent").forwardedArgs // ["--model", "gpt56s"]
 */
export function parseAgentCommand(args: string, command: AgentCommandName): ParsedAgentCommand {
	const scan = scanAgentArguments(args, command);
	if (scan.blocked) {
		const token = args.slice(scan.blocked.start, scan.blocked.end);
		throw new Error(
			`/${command} does not support ${token}; it would disrupt the background agent run.`,
		);
	}
	if (!scan.prose.trim())
		throw new Error(
			`Usage: /${command} [pi options] [-m MODELNAME] [-i|--isolate] [-s|--squash] "<task>"`,
		);
	return {
		isolate: scan.isolate,
		squash: scan.squash,
		forwardedArgs: scan.forwardedArgs,
		task: scan.task,
		warnings: scan.warnings,
	};
}

/**
 * Analyze the cursor in a complete editor line without committing a partial token as prose.
 *
 * @example analyzeAgentEditorInput("/agent --thi", 12)?.kind // "option"
 */
export function analyzeAgentEditorInput(
	line: string,
	cursor: number,
): AgentCursorExpectation | undefined {
	const prefix = matchAgentCommandPrefix(line);
	if (!prefix || cursor <= prefix.argumentOffset || cursor > line.length) return undefined;
	const { command, argumentOffset } = prefix;
	const expectation = analyzeArgumentCursor(
		line.slice(argumentOffset),
		cursor - argumentOffset,
		command,
	);
	if (!expectation) return undefined;
	return {
		...expectation,
		replacementStart: expectation.replacementStart + argumentOffset,
		replacementEnd: expectation.replacementEnd + argumentOffset,
	};
}

function analyzeArgumentCursor(
	args: string,
	cursor: number,
	command: AgentCommandName,
): AgentCursorExpectation | undefined {
	const usedSemanticIds = new Set<string>();
	let position = 0;
	let expectedValueOption: AgentOptionDefinition | undefined;
	let provider: string | undefined;

	for (;;) {
		while (position < args.length && /\s/.test(args[position] ?? "")) position += 1;
		if (position >= cursor) {
			if (expectedValueOption) {
				return valueExpectation(
					command,
					"",
					cursor,
					cursor,
					expectedValueOption,
					provider,
					false,
					usedSemanticIds,
				);
			}
			return optionExpectation(command, "", cursor, cursor, usedSemanticIds);
		}

		if (expectedValueOption) {
			const value = readCursorValue(args, position);
			if (cursor <= value.end) {
				const fragmentStart = value.quoted ? value.start + 1 : value.start;
				const fragmentEnd = value.quoted ? Math.max(fragmentStart, value.end - 1) : value.end;
				return valueExpectation(
					command,
					args.slice(fragmentStart, cursor),
					fragmentStart,
					fragmentEnd,
					expectedValueOption,
					provider,
					value.quoted,
					usedSemanticIds,
				);
			}
			if (expectedValueOption.semanticId === "provider") {
				provider = args.slice(
					value.quoted ? value.start + 1 : value.start,
					value.quoted ? value.end - 1 : value.end,
				);
			}
			position = value.end;
			expectedValueOption = undefined;
			continue;
		}

		const tokenStart = position;
		while (position < args.length && !/\s/.test(args[position] ?? "")) position += 1;
		const tokenEnd = position;
		if (cursor <= tokenEnd) {
			const fragment = args.slice(tokenStart, cursor);
			if (!fragment.startsWith("-")) return undefined;
			return optionExpectation(command, fragment, tokenStart, tokenEnd, usedSemanticIds);
		}

		const token = args.slice(tokenStart, tokenEnd);
		const option = OPTION_BY_NAME.get(token);
		if (!option || option.role === "blocked") return undefined;
		usedSemanticIds.add(option.semanticId);
		if (option.arity === "value") expectedValueOption = option;
	}
}

function optionExpectation(
	command: AgentCommandName,
	fragment: string,
	replacementStart: number,
	replacementEnd: number,
	usedSemanticIds: ReadonlySet<string>,
): OptionCursorExpectation {
	return { kind: "option", command, fragment, replacementStart, replacementEnd, usedSemanticIds };
}

function valueExpectation(
	command: AgentCommandName,
	fragment: string,
	replacementStart: number,
	replacementEnd: number,
	option: AgentOptionDefinition,
	parsedProvider: string | undefined,
	quoted: boolean,
	usedSemanticIds: ReadonlySet<string>,
): ValueCursorExpectation {
	return {
		kind: "value",
		command,
		fragment,
		option,
		parsedProvider,
		replacementStart,
		replacementEnd,
		quoted,
		usedSemanticIds,
	};
}

function readCursorValue(
	args: string,
	start: number,
): { start: number; end: number; quoted: boolean } {
	const closer = QUOTE_PAIRS[args[start] ?? ""];
	if (closer !== undefined) {
		const close = args.indexOf(closer, start + 1);
		if (close !== -1) return { start, end: close + 1, quoted: true };
	}
	let end = start;
	while (end < args.length && !/\s/.test(args[end] ?? "")) end += 1;
	return { start, end, quoted: false };
}

function matchAgentCommandPrefix(
	line: string,
): { command: AgentCommandName; argumentOffset: number } | undefined {
	const match = /^\/agent(?=$|\s)/.exec(line);
	if (!match) return undefined;
	return { command: "agent", argumentOffset: match[0].length };
}

function readValueSpan(
	args: string,
	position: number,
): { start: number; end: number; value: string } | undefined {
	let start = position;
	while (start < args.length && /\s/.test(args[start] ?? "")) start += 1;
	const closer = QUOTE_PAIRS[args[start] ?? ""];
	if (closer !== undefined) {
		const close = args.indexOf(closer, start + 1);
		if (close !== -1) return { start, end: close + 1, value: args.slice(start + 1, close) };
	}
	let end = start;
	while (end < args.length && !/\s/.test(args[end] ?? "")) end += 1;
	if (end === start) return undefined;
	return { start, end, value: args.slice(start, end) };
}

function buildQuoteMask(text: string): boolean[] {
	const mask = new Array<boolean>(text.length).fill(false);
	let index = 0;
	while (index < text.length) {
		const closer = QUOTE_PAIRS[text[index] ?? ""];
		const close = closer === undefined ? -1 : text.indexOf(closer, index + 1);
		if (close === -1) {
			index += 1;
			continue;
		}
		for (let position = index; position <= close; position += 1) mask[position] = true;
		index = close + 1;
	}
	return mask;
}

function collectProseSemantics(
	prose: string,
	quoteMask: boolean[],
	command: AgentCommandName,
): { warnings: string[]; tokens: AgentSemanticToken[] } {
	const tokens: { text: string; index: number }[] = [];
	const pattern = /\S+/g;
	for (let match = pattern.exec(prose); match !== null; match = pattern.exec(prose)) {
		tokens.push({ text: match[0], index: match.index });
	}
	const firstToken = tokens[0];
	if (firstToken === undefined) return { warnings: [], tokens: [] };
	const firstProseWord = quoteMask[firstToken.index]
		? firstToken.text
		: unescapeWord(firstToken.text);
	const warnings: string[] = [];
	const semanticTokens: AgentSemanticToken[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (quoteMask[token.index]) continue;
		const option = OPTION_BY_NAME.get(token.text);
		if (!option) continue;
		const valueToken = option.arity === "value" ? tokens[index + 1] : undefined;
		const optionWithValue =
			valueToken === undefined ? token.text : `${token.text} ${valueToken.text}`;
		warnings.push(
			`${optionWithValue} was included in the prompt body. To specify an argument or an option, place it at the beginning of the command input: /${command} ${optionWithValue} ${firstProseWord} …`,
		);
		semanticTokens.push({
			semantic: "misplaced-option",
			start: token.index,
			end: token.index + token.text.length,
			option,
		});
		const valueIsItsOwnOption =
			valueToken !== undefined &&
			!quoteMask[valueToken.index] &&
			OPTION_BY_NAME.has(valueToken.text);
		if (valueToken !== undefined && !valueIsItsOwnOption) {
			semanticTokens.push({
				semantic: "misplaced-value",
				start: valueToken.index,
				end: valueToken.index + valueToken.text.length,
				option,
			});
		}
	}
	return { warnings, tokens: semanticTokens };
}

function unescapeWord(word: string): string {
	if (!word.startsWith("\\-")) return word;
	const unescaped = word.slice(1);
	return unescaped.startsWith("-\\-") ? `-${unescaped.slice(2)}` : unescaped;
}

function unescapeProse(prose: string, quoteMask: boolean[]): string {
	return prose.replace(/\S+/g, (word, offset: number) =>
		quoteMask[offset] ? word : unescapeWord(word),
	);
}
