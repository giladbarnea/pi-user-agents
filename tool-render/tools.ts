import { highlightCode } from "@earendil-works/pi-coding-agent";

import { padVisible, truncateAnsi, visibleWidth, wrapTextWithAnsi } from "./ansi.js";
import { CAPS, GLYPHS } from "./constants.js";
import {
	buildStructuredDiff,
	diffSummary,
	editOperationsFromArgs,
	parseUnifiedDiffOutput,
	renderStructuredDiff,
	type StructuredDiff,
} from "./diff.js";
import {
	borderMuted,
	type RenderTheme,
	stackPrefix,
	toolLabel,
	treeConnector,
} from "./theme.js";
import {
	clipLine,
	formatArguments,
	lineCount,
	plural,
	preview,
	readCallText,
	readOnlyCallText,
	readResultSummary,
	renderPathListPreview,
	renderToolPathText,
	resultTruncated,
	splitTerminalLines,
	textContent,
	type ToolResultLike,
	truncateText,
} from "./text.js";

export const FIRST_CLASS_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "bash"] as const;
export type FirstClassTool = (typeof FIRST_CLASS_TOOLS)[number];

export function isFirstClassTool(name: string): name is FirstClassTool {
	return (FIRST_CLASS_TOOLS as readonly string[]).includes(name);
}

type ToolArgs = Record<string, unknown>;

/** Every renderer receives the same inputs. `result` is absent for a call that never finished. */
type ToolRenderer = (
	args: ToolArgs,
	result: ToolResultLike | undefined,
	theme: RenderTheme,
	width: number,
) => string[];

// --- shared building blocks --------------------------------------------------------------

function separator(theme: RenderTheme): string {
	return theme.fg("dim", " · ");
}

function headline(call: string, summary: string, theme: RenderTheme): string {
	return `${stackPrefix(theme)}${call}${separator(theme)}${summary}`;
}

function errorText(result: ToolResultLike, theme: RenderTheme, fallback: string): string {
	return theme.fg("error", splitTerminalLines(textContent(result))[0] || fallback);
}

function wrapBlock(text: string, width: number): string[] {
	return splitTerminalLines(text).flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
		return wrapped.length > 0 ? wrapped : [""];
	});
}

/** Indented preview rows under a headline, matching the source extension's tree stem. */
function previewRows(
	content: string,
	limit: number,
	noun: string,
	theme: RenderTheme,
	width: number,
): string[] {
	const total = lineCount(content);
	if (total === 0) return [];
	const stem = treeConnector(theme, "│");
	const stemWidth = visibleWidth(stem);
	const rows = splitTerminalLines(preview(content, limit)).map((line) =>
		`${stem}${theme.fg("dim", truncateAnsi(line, Math.max(1, width - stemWidth)))}`,
	);
	if (total > limit)
		rows.push(`${stem}${theme.fg("muted", `${GLYPHS.ellipsis} ${total - limit} more ${noun}`)}`);
	return rows;
}

/** A call whose result never arrived: the agent was aborted or is still in flight. */
function unfinished(call: string, theme: RenderTheme): string {
	return headline(call, theme.fg("muted", "no result"), theme);
}

// --- read --------------------------------------------------------------------------------

const renderRead: ToolRenderer = (args, result, theme, width) => {
	const call = readCallText(args, theme);
	if (!result) return wrapBlock(unfinished(call, theme), width);
	if (result.isError) return wrapBlock(headline(call, errorText(result, theme, "read failed"), theme), width);
	const content = textContent(result);
	return [
		...wrapBlock(headline(call, readResultSummary(result, args, theme), theme), width),
		...previewRows(content, CAPS.readPreviewLines, "line(s)", theme, width),
	];
};

// --- edit and write ----------------------------------------------------------------------

function argumentPath(args: ToolArgs): string {
	const value = args.path ?? args.file_path ?? "";
	return typeof value === "string" ? value : String(value);
}

/**
 * Prefer the patch Pi actually applied over the arguments the model requested.
 *
 * Arguments only describe the intended edit. A partially applied edit makes them diverge from
 * what is on disk, and they carry no real line numbers.
 */
function editDiff(args: ToolArgs, result: ToolResultLike): StructuredDiff | undefined {
	const patch = (result.details as { patch?: unknown } | undefined)?.patch;
	if (typeof patch === "string" && patch.trim()) {
		const files = parseUnifiedDiffOutput(patch);
		if (files?.[0]) return files[0].diff;
	}
	const operations = editOperationsFromArgs(args);
	if (operations.length === 0) return undefined;
	const merged = operations.reduce<StructuredDiff | undefined>((accumulated, operation) => {
		const next = buildStructuredDiff(operation.oldText, operation.newText);
		if (!accumulated) return next;
		return {
			additions: accumulated.additions + next.additions,
			hunks: (accumulated.hunks ?? 0) + (next.hunks ?? 0),
			lines: [...accumulated.lines, ...next.lines],
			removals: accumulated.removals + next.removals,
		};
	}, undefined);
	return merged;
}

function renderMutation(
	call: string,
	diff: StructuredDiff | undefined,
	fallbackSummary: string,
	theme: RenderTheme,
	width: number,
	path: string,
): string[] {
	const summary = diff ? diffSummary(diff, theme) : theme.fg("success", fallbackSummary);
	const lines = wrapBlock(headline(call, summary, theme), width);
	if (diff) lines.push(...renderStructuredDiff(diff, theme, width, path));
	return lines;
}

const renderEdit: ToolRenderer = (args, result, theme, width) => {
	const path = argumentPath(args);
	const call = `${toolLabel(theme, "Edit ")}${renderToolPathText(path, theme)}`;
	if (!result) return wrapBlock(unfinished(call, theme), width);
	if (result.isError)
		return wrapBlock(headline(call, errorText(result, theme, "edit failed"), theme), width);
	return renderMutation(call, editDiff(args, result), "applied", theme, width, path);
};

const renderWrite: ToolRenderer = (args, result, theme, width) => {
	const path = argumentPath(args);
	const content = typeof args.content === "string" ? args.content : "";
	const call = `${toolLabel(theme, "Write ")}${renderToolPathText(path, theme)} ${theme.fg(
		"dim",
		`· ${plural(lineCount(content), "line")}`,
	)}`;
	if (!result) return wrapBlock(unfinished(call, theme), width);
	if (result.isError)
		return wrapBlock(headline(call, errorText(result, theme, "write failed"), theme), width);
	const diff = content ? buildStructuredDiff("", content) : undefined;
	return renderMutation(call, diff, "written", theme, width, path);
};

// --- grep, find, and ls ------------------------------------------------------------------

function readOnlyRenderer(toolName: "grep" | "find" | "ls"): ToolRenderer {
	return (args, result, theme, width) => {
		const call = readOnlyCallText(toolName, args, theme);
		if (!result) return wrapBlock(unfinished(call, theme), width);
		if (result.isError)
			return wrapBlock(headline(call, errorText(result, theme, `${toolName} failed`), theme), width);
		const output = textContent(result);
		const count = output.trim() ? lineCount(output) : 0;
		const emptyLabel =
			toolName === "grep" ? "no matches" : toolName === "ls" ? "empty" : "no files";
		const countLabel =
			toolName === "grep"
				? `${count} match${count === 1 ? "" : "es"}`
				: toolName === "ls"
					? `${count} entr${count === 1 ? "y" : "ies"}`
					: plural(count, "file");
		let summary =
			count === 0 ? theme.fg("muted", emptyLabel) : theme.fg("success", countLabel);
		if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
		const lines = wrapBlock(headline(call, summary, theme), width);
		if (!output.trim()) return lines;
		if (toolName === "grep")
			lines.push(...previewRows(output, CAPS.searchPreviewLines, "result line(s)", theme, width));
		else
			lines.push(
				...splitTerminalLines(renderPathListPreview(output, toolName, theme)).map((line) =>
					truncateAnsi(line, width),
				),
			);
		return lines;
	};
}

// --- bash --------------------------------------------------------------------------------

const FRAME = { bl: "└", br: "┘", h: "─", tl: "┌", tr: "┐", v: "│" } as const;
const ANSI_RESET = "\x1b[0m";

function frameTop(theme: RenderTheme, width: number, caption?: string): string {
	const border = (text: string) => borderMuted(theme, text);
	if (!caption)
		return `${border(FRAME.tl)}${border(FRAME.h.repeat(Math.max(1, width - 2)))}${border(FRAME.tr)}`;
	const maxCaption = Math.max(1, width - 6);
	const safeCaption =
		visibleWidth(caption) > maxCaption ? truncateAnsi(caption, maxCaption) : caption;
	const fill = Math.max(1, width - 5 - visibleWidth(safeCaption));
	return `${border(FRAME.tl)}${border(FRAME.h)} ${safeCaption} ${border(FRAME.h.repeat(fill))}${border(FRAME.tr)}`;
}

function frameBottom(theme: RenderTheme, width: number): string {
	const border = (text: string) => borderMuted(theme, text);
	return `${border(FRAME.bl)}${border(FRAME.h.repeat(Math.max(1, width - 2)))}${border(FRAME.br)}`;
}

function frameRow(theme: RenderTheme, inner: string, innerWidth: number): string {
	const border = (text: string) => borderMuted(theme, text);
	return `${border(FRAME.v)} ${padVisible(truncateAnsi(inner, innerWidth), innerWidth)}${ANSI_RESET} ${border(FRAME.v)}`;
}

function countPipelines(command: string): number {
	let count = 0;
	for (let index = 0; index < command.length; index += 1) {
		if (command[index] !== "|") continue;
		if (command[index + 1] === "|") {
			index += 1;
			continue;
		}
		count += 1;
	}
	return count;
}

function commandFacts(command: string, timeout: number | undefined): string[] {
	const facts: string[] = [];
	const logicalLines = splitTerminalLines(command);
	if (logicalLines.length > 1) facts.push(plural(logicalLines.length, "line"));
	const pipelines = countPipelines(command);
	if (pipelines > 0) facts.push(plural(pipelines, "pipe"));
	if (/(^|[^<])<<-?/.test(command)) facts.push("heredoc");
	if (timeout !== undefined) facts.push(`timeout ${timeout}s`);
	return facts;
}

type BashStatus =
	| { kind: "ok" }
	| { kind: "exit"; code: number }
	| { kind: "aborted" }
	| { kind: "timeout"; seconds: number }
	| { kind: "failed" };

type ParsedBashResult = {
	body: string;
	shown: number;
	status: BashStatus;
	total: number;
	truncated: boolean;
};

const EXIT_PATTERN = /\n*Command exited with code (\d+)\s*$/;
const ABORT_PATTERN = /\n*Command aborted\s*$/;
const TIMEOUT_PATTERN = /\n*Command timed out after (\d+) seconds\s*$/;
const TRUNCATION_FOOTER_PATTERN = /\n*\[Showing [^\]]*\]\s*$/;

/** Pull the trailing status and truncation footers out of Pi's stored bash output. */
export function parseBashResult(result: ToolResultLike): ParsedBashResult {
	let text = textContent(result).replace(/\s+$/, "");
	let status: BashStatus = { kind: "ok" };

	const exitMatch = EXIT_PATTERN.exec(text);
	const abortMatch = exitMatch ? null : ABORT_PATTERN.exec(text);
	const timeoutMatch = exitMatch || abortMatch ? null : TIMEOUT_PATTERN.exec(text);
	if (exitMatch) {
		const code = Number.parseInt(exitMatch[1]!, 10);
		status = code === 0 ? { kind: "ok" } : { kind: "exit", code };
		text = text.slice(0, exitMatch.index).replace(/\s+$/, "");
	} else if (abortMatch) {
		status = { kind: "aborted" };
		text = text.slice(0, abortMatch.index).replace(/\s+$/, "");
	} else if (timeoutMatch) {
		status = { kind: "timeout", seconds: Number.parseInt(timeoutMatch[1]!, 10) };
		text = text.slice(0, timeoutMatch.index).replace(/\s+$/, "");
	} else if (result.isError) {
		status = { kind: "failed" };
	}

	let truncated = false;
	let shown = 0;
	let total = 0;
	const footerMatch = TRUNCATION_FOOTER_PATTERN.exec(text);
	if (footerMatch) {
		text = text.slice(0, footerMatch.index).replace(/\s+$/, "");
		truncated = true;
		const range = /Showing lines (\d+)-(\d+) of (\d+)/.exec(footerMatch[0]);
		if (range) {
			shown = Number.parseInt(range[2]!, 10) - Number.parseInt(range[1]!, 10) + 1;
			total = Number.parseInt(range[3]!, 10);
		} else {
			const totalMatch = /of (\d+)/.exec(footerMatch[0]);
			if (totalMatch) total = Number.parseInt(totalMatch[1]!, 10);
		}
	}
	const truncation = (result.details as { truncation?: { outputLines?: number; totalLines?: number; truncated?: boolean } } | undefined)?.truncation;
	if (truncation?.truncated) {
		truncated = true;
		shown = truncation.outputLines ?? shown;
		total = truncation.totalLines ?? total;
	}

	const bodyLines = text ? text.split("\n").length : 0;
	if (!truncated) {
		shown = bodyLines;
		total = bodyLines;
	} else if (!shown) {
		shown = bodyLines;
	}
	return { body: text, shown, status, total, truncated };
}

function bashStatusCaption(parsed: ParsedBashResult, theme: RenderTheme): string {
	const parts: string[] = [];
	if (parsed.status.kind === "ok") parts.push(theme.fg("success", GLYPHS.ok));
	else if (parsed.status.kind === "exit")
		parts.push(theme.fg("error", `${GLYPHS.fail} exit ${parsed.status.code}`));
	else if (parsed.status.kind === "aborted")
		parts.push(theme.fg("error", `${GLYPHS.fail} aborted`));
	else if (parsed.status.kind === "timeout")
		parts.push(theme.fg("error", `${GLYPHS.fail} timeout ${parsed.status.seconds}s`));
	else parts.push(theme.fg("error", `${GLYPHS.fail} failed`));

	if (parsed.truncated && parsed.total > 0) {
		parts.push(theme.fg("muted", `${parsed.shown}/${parsed.total} lines`));
		parts.push(theme.fg("warning", "truncated"));
	} else if (parsed.shown > 0) {
		parts.push(theme.fg("muted", plural(parsed.shown, "line")));
	}
	return parts.join(theme.fg("dim", GLYPHS.dot));
}

/**
 * Draw rows until the budget runs out, and report how many source lines went undrawn.
 *
 * A cap on source lines is not a cap at all: one line of minified output or one long command
 * wraps into many rows at overlay width.
 */
function fillRows(
	sourceLines: string[],
	budget: number,
	segmentsFor: (line: string, index: number) => string[],
): { hidden: number; rows: string[] } {
	const rows: string[] = [];
	let consumed = 0;
	for (; consumed < sourceLines.length && rows.length < budget; consumed += 1) {
		for (const segment of segmentsFor(sourceLines[consumed]!, consumed)) {
			if (rows.length >= budget) break;
			rows.push(segment);
		}
	}
	return { hidden: sourceLines.length - consumed, rows };
}

function commandFrame(command: string, theme: RenderTheme, width: number): string[] {
	const highlighted = highlightCode(command, "bash");
	const lines = highlighted.length > 0 ? [...highlighted] : [command];
	while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const innerWidth = Math.max(1, width - 4);
	const numWidth = Math.max(2, String(lines.length).length);
	const codeWidth = Math.max(1, innerWidth - numWidth - 1);
	const { hidden, rows } = fillRows(lines, CAPS.bashCommandRows, (line, index) => {
		const wrapped = wrapTextWithAnsi(line || " ", codeWidth);
		return (wrapped.length > 0 ? wrapped : [""]).map((segment, segmentIndex) => {
			const gutter =
				segmentIndex === 0
					? theme.fg("muted", String(index + 1).padStart(numWidth))
					: " ".repeat(numWidth);
			return frameRow(theme, `${gutter} ${segment}`, innerWidth);
		});
	});
	if (hidden > 0)
		rows.push(
			frameRow(theme, theme.fg("muted", `${GLYPHS.ellipsis} ${hidden} more command lines`), innerWidth),
		);
	return [frameTop(theme, width), ...rows, frameBottom(theme, width)];
}

const renderBash: ToolRenderer = (args, result, theme, width) => {
	const command = typeof args.command === "string" ? args.command : "";
	const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
	const firstLine = splitTerminalLines(command)[0]?.trim() || GLYPHS.ellipsis;
	const facts = commandFacts(command, timeout);
	const factsText = facts.length > 0 ? theme.fg("dim", `${GLYPHS.dot}${facts.join(GLYPHS.dot)}`) : "";
	const call = `${stackPrefix(theme)}${toolLabel(theme, "Bash ")}${theme.fg(
		"accent",
		truncateText(firstLine, CAPS.commandPreviewChars),
	)}${factsText}`;

	if (!result) return [truncateAnsi(`${call}${separator(theme)}${theme.fg("muted", "no result")}`, width)];

	const lines = [truncateAnsi(call, width)];
	const isMultiLine = splitTerminalLines(command).length > 1;
	if (isMultiLine || visibleWidth(call) > width) lines.push(...commandFrame(command, theme, width));

	const parsed = parseBashResult(result);
	const caption = bashStatusCaption(parsed, theme);
	if (!parsed.body.trim()) {
		lines.push(`${caption}${theme.fg("dim", GLYPHS.dot)}${theme.fg("muted", "no output")}`);
		return lines;
	}
	const innerWidth = Math.max(1, width - 4);
	const { hidden, rows } = fillRows(
		splitTerminalLines(parsed.body),
		CAPS.bashOutputRows,
		(bodyLine) =>
			wrapTextWithAnsi(theme.fg("toolOutput", clipLine(bodyLine)), innerWidth).map((segment) =>
				frameRow(theme, segment, innerWidth),
			),
	);
	lines.push(frameTop(theme, width, caption), ...rows);
	if (hidden > 0)
		lines.push(
			frameRow(theme, theme.fg("muted", `${GLYPHS.ellipsis} ${hidden} more output lines`), innerWidth),
		);
	lines.push(frameBottom(theme, width));
	return lines;
};

// --- everything else ---------------------------------------------------------------------

/**
 * The shape used for MCP tools, custom tools, and any tool added later.
 *
 * It deliberately has no per-tool branches: without a known visual contract, guessing at a
 * tool's semantics produces worse output than showing its arguments plainly.
 */
export function renderGenericTool(
	toolName: string,
	args: ToolArgs,
	result: ToolResultLike | undefined,
	theme: RenderTheme,
	width: number,
): string[] {
	const readableArguments = formatArguments(args, CAPS.genericArgumentChars);
	const call = `${toolLabel(theme, `${toolName} `)}${
		readableArguments ? theme.fg("accent", readableArguments) : ""
	}`;
	if (!result) return wrapBlock(unfinished(call, theme), width);
	const output = textContent(result);
	if (result.isError)
		return wrapBlock(headline(call, errorText(result, theme, `${toolName} failed`), theme), width);
	const count = output.trim() ? lineCount(output) : 0;
	const summary =
		count === 0 ? theme.fg("muted", "no output") : theme.fg("success", plural(count, "line"));
	return [
		...wrapBlock(headline(call, summary, theme), width),
		...previewRows(output, CAPS.genericResultLines, "line(s)", theme, width),
	];
}

const RENDERERS: Record<FirstClassTool, ToolRenderer> = {
	bash: renderBash,
	edit: renderEdit,
	find: readOnlyRenderer("find"),
	grep: readOnlyRenderer("grep"),
	ls: readOnlyRenderer("ls"),
	read: renderRead,
	write: renderWrite,
};

export function renderFirstClassTool(
	toolName: FirstClassTool,
	args: ToolArgs,
	result: ToolResultLike | undefined,
	theme: RenderTheme,
	width: number,
): string[] {
	return RENDERERS[toolName](args, result, theme, width);
}
