import { homedir } from "node:os";

import { stripAnsi } from "./ansi.js";
import { CAPS, GLYPHS } from "./constants.js";
import { type RenderTheme, toolLabel, treeConnector } from "./theme.js";

/** A stored tool result, as persisted in the child session transcript. */
export type ToolResultLike = {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

export function normalizeTerminalText(text: string): string {
	return text.replace(/\r\n|\r/g, "\n").replace(/\t/g, "   ");
}

export function splitTerminalLines(text: string): string[] {
	return normalizeTerminalText(text).split("\n");
}

/** @example lineCount("a\nb\n") // 2 */
export function lineCount(text: string): number {
	if (!text) return 0;
	const normalized = normalizeTerminalText(text).replace(/\n$/, "");
	return normalized ? normalized.split("\n").length : 0;
}

export function textContent(result: ToolResultLike | undefined): string {
	const part = result?.content?.find(
		(candidate) => candidate?.type === "text" && typeof candidate.text === "string",
	);
	return part?.text ?? "";
}

/** @example truncateText("abcdef", 4) // "abc…" */
export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - GLYPHS.ellipsis.length))}${GLYPHS.ellipsis}`;
}

export function clipLine(line: string): string {
	return truncateText(line, CAPS.maxLineWidth);
}

export function preview(text: string, count: number): string {
	return splitTerminalLines(text).slice(0, count).map(clipLine).join("\n");
}

export function plural(count: number, singular: string, pluralText = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralText}`;
}

function truncatedMarker(text: string): boolean {
	return /^\s*\[(?:Output|Full output|Read output|Search output|Bash output)[^\n\]]*truncated|^\s*\[[^\n\]]*Full output saved to:/im.test(
		text,
	);
}

type TruncationDetails = {
	firstLineExceedsLimit?: boolean;
	outputLines?: number;
	totalLines?: number;
	truncated?: boolean;
};

function truncationDetails(result: ToolResultLike | undefined): TruncationDetails | undefined {
	const details = result?.details as { truncation?: TruncationDetails } | undefined;
	return details?.truncation;
}

export function resultTruncated(result: ToolResultLike | undefined): boolean {
	const truncation = truncationDetails(result);
	if (typeof truncation?.truncated === "boolean") return truncation.truncated;
	return truncatedMarker(textContent(result));
}

/** Prefer Pi's persisted line counts; fall back to counting the stored output. */
export function readResultSummary(
	result: ToolResultLike | undefined,
	args: Record<string, unknown>,
	theme: RenderTheme,
): string {
	const truncation = truncationDetails(result);
	if (
		truncation?.truncated &&
		typeof truncation.outputLines === "number" &&
		typeof truncation.totalLines === "number"
	) {
		let summary =
			theme.fg("success", `${truncation.outputLines}/${truncation.totalLines} lines`) +
			theme.fg("warning", " · truncated");
		if (!truncation.firstLineExceedsLimit && truncation.outputLines > 0) {
			const startLine = Math.max(1, Math.floor(Number(args.offset) || 1));
			summary += theme.fg("dim", ` · continue offset=${startLine + truncation.outputLines}`);
		}
		return summary;
	}
	const count = lineCount(textContent(result));
	let summary = theme.fg("success", plural(count, "line"));
	if (resultTruncated(result)) summary += theme.fg("warning", " · truncated");
	return summary;
}

/** @example shortenPath("/nowhere/x.ts") // "/nowhere/x.ts" */
export function shortenPath(pathText: string): string {
	const home = homedir();
	if (pathText === home) return "~";
	if (pathText.startsWith(`${home}/`)) return `~${pathText.slice(home.length)}`;
	return pathText;
}

export function renderToolPathText(
	rawPath: unknown,
	theme: RenderTheme,
	emptyFallback?: string,
): string {
	const value = typeof rawPath === "string" ? rawPath : rawPath == null ? "" : String(rawPath);
	const displayPath = value || emptyFallback;
	if (!displayPath) return "";
	return theme.fg("accent", shortenPath(displayPath));
}

function argumentPath(args: Record<string, unknown>): unknown {
	return args.path ?? args.file_path ?? "";
}

export function readCallText(args: Record<string, unknown>, theme: RenderTheme): string {
	const offset = args.offset;
	const limit = args.limit;
	const range = offset || limit
		? `:${offset ?? 1}${limit ? `-${Number(offset ?? 1) + Number(limit) - 1}` : ""}`
		: "";
	return `${toolLabel(theme, "Read ")}${renderToolPathText(argumentPath(args), theme)}${
		range ? theme.fg("accent", range) : ""
	}`;
}

export function readOnlyCallText(
	toolName: "grep" | "find" | "ls",
	args: Record<string, unknown>,
	theme: RenderTheme,
): string {
	if (toolName === "ls")
		return `${toolLabel(theme, "ls ")}${renderToolPathText(args.path ?? ".", theme)}`;
	const usesPathOnly =
		args.pattern === undefined && args.glob === undefined && typeof args.path === "string";
	const query = args.pattern ?? args.glob ?? args.path ?? args.query ?? "";
	const rendered = usesPathOnly
		? renderToolPathText(args.path, theme)
		: theme.fg("accent", clipLine(String(query)));
	return `${toolLabel(theme, `${toolName} `)}${rendered}`;
}

const ARGUMENT_VALUE_CHARS = 60;

/**
 * One argument value, readable at a glance.
 *
 * Nested containers are summarized rather than serialized: a JSON blob is exactly what this
 * renderer exists to remove, and a nested object tells the reader nothing at overlay width.
 *
 * @example formatArgumentValue(3) // "3"
 * @example formatArgumentValue({ a: 1, b: 2 }) // "{2 keys}"
 */
export function formatArgumentValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${plural(value.length, "item")}]`;
	if (typeof value === "object") return `{${plural(Object.keys(value).length, "key")}}`;
	if (typeof value !== "string") return String(value);
	const clipped = truncateText(value.replace(/\s+/g, " ").trim(), ARGUMENT_VALUE_CHARS);
	return clipped.includes(" ") ? `"${clipped}"` : clipped;
}

/** @example formatArguments({ limit: 5 }) // "limit=5" */
export function formatArguments(args: Record<string, unknown>, maxChars: number): string {
	const pairs = Object.entries(args).map(([key, value]) => `${key}=${formatArgumentValue(value)}`);
	return truncateText(pairs.join(" "), maxChars);
}

export function renderPathListPreview(
	output: string,
	toolName: "find" | "ls",
	theme: RenderTheme,
): string {
	const items = splitTerminalLines(output).filter((line) => line.trim().length > 0);
	if (items.length === 0)
		return theme.fg("muted", toolName === "ls" ? "empty directory" : "no files found");
	const shown = items.slice(0, CAPS.searchPreviewLines);
	const lines = shown.map((item, index) => {
		const clean = stripAnsi(item).trim();
		const isDirectory = clean.endsWith("/");
		const isLast = index === shown.length - 1 && shown.length === items.length;
		const label = isDirectory ? theme.fg("accent", theme.bold(clean)) : theme.fg("dim", clean);
		return `${treeConnector(theme, isLast ? "└" : "├")}${label}`;
	});
	const remaining = items.length - shown.length;
	if (remaining > 0) {
		const noun =
			toolName === "ls"
				? remaining === 1
					? "entry"
					: "entries"
				: remaining === 1
					? "file"
					: "files";
		lines.push(
			`${treeConnector(theme, "└")}${theme.fg("muted", `${GLYPHS.ellipsis} ${remaining} more ${noun}`)}`,
		);
	}
	return lines.join("\n");
}
