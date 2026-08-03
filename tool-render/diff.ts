import {
	getLanguageFromPath,
	highlightCode,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";

import {
	ANSI_BG_RESET,
	type AnsiParts,
	ansiHasBackground,
	ansiPartsFromStyled,
	hasAnsi,
	padVisible,
	sgrClearsBackground,
	stripAnsi,
	STYLE_MARKER,
	truncateAnsi,
	updateActiveAnsiStyle,
	visibleLength,
	visibleWidth,
} from "./ansi.js";
import { CAPS, DIFF_SPLIT_MIN_WIDTH, GLYPHS } from "./constants.js";
import { borderMuted, type RenderTheme } from "./theme.js";
import { normalizeTerminalText } from "./text.js";

const DIFF_SPLIT_MIN_CODE_WIDTH = 24;
const DIFF_SPLIT_MAX_WRAP_LINES = 8;
const DIFF_SPLIT_MAX_WRAP_RATIO = 0.55;
const DIFF_LCS_CELL_LIMIT = 250_000;
const DIFF_CONTEXT_LINES = 3;
const DIFF_HIGHLIGHT_MAX_CHARS = 5000;
const WORD_DIFF_CELL_LIMIT = 32_000;
const WORD_DIFF_MIN_SIMILARITY = 0.2;
const HIGHLIGHT_CACHE_LIMIT = 4000;

const DIFF_ADD_BG_TOKEN = "toolSuccessBg";
const DIFF_DEL_BG_TOKEN = "toolErrorBg";
const DIFF_WORD_BG_TOKEN = "selectedBg";
const DIFF_ADD_BG_FALLBACK = "\x1b[48;2;24;58;38m";
const DIFF_DEL_BG_FALLBACK = "\x1b[48;2;66;31;43m";

export type DiffKind = "ctx" | "add" | "del" | "sep";

export interface StructuredDiffLine {
	content: string;
	hunk?: number;
	newNum: number | null;
	oldNum: number | null;
	type: DiffKind;
}

export interface StructuredDiff {
	additions: number;
	hunks?: number;
	lines: StructuredDiffLine[];
	path?: string;
	removals: number;
}

/** Background escape codes resolved once per render instead of once per line. */
interface DiffPalette {
	add: AnsiParts;
	del: AnsiParts;
	word: AnsiParts;
}

const NO_BG: AnsiParts = { open: "", close: "" };

function bgPartsFor(theme: RenderTheme, token: string, fallbackOpen: string): AnsiParts {
	if (theme.bg) {
		const parts = ansiPartsFromStyled(theme.bg(token, STYLE_MARKER));
		if (ansiHasBackground(parts.open)) return parts;
	}
	return fallbackOpen ? { open: fallbackOpen, close: ANSI_BG_RESET } : NO_BG;
}

function diffPalette(theme: RenderTheme): DiffPalette {
	return {
		add: bgPartsFor(theme, DIFF_ADD_BG_TOKEN, DIFF_ADD_BG_FALLBACK),
		del: bgPartsFor(theme, DIFF_DEL_BG_TOKEN, DIFF_DEL_BG_FALLBACK),
		word: bgPartsFor(theme, DIFF_WORD_BG_TOKEN, ""),
	};
}

function wrapBg(parts: AnsiParts, text: string): string {
	return parts.open ? `${parts.open}${text}${parts.close}` : text;
}

/** Re-open the background after any escape that resets it, so the whole row stays tinted. */
function applyFullLineBg(parts: AnsiParts, text: string): string {
	if (!parts.open) return text;
	const reapplied = text.replace(/\x1b\[[0-9;]*m/g, (code) =>
		sgrClearsBackground(code) ? `${code}${parts.open}` : code,
	);
	return `${parts.open}${reapplied}${parts.close}`;
}

function lineBg(palette: DiffPalette, line: StructuredDiffLine | null): AnsiParts {
	if (line?.type === "add") return palette.add;
	if (line?.type === "del") return palette.del;
	return NO_BG;
}

// --- syntax highlighting -----------------------------------------------------------------

const highlightCache = new Map<string, string>();

function languageForPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	return getLanguageFromPath(path) as string | undefined;
}

function highlightDiffContent(content: string, path: string | undefined): string {
	const display = normalizeTerminalText(content);
	if (!display || display.length > DIFF_HIGHLIGHT_MAX_CHARS) return display;
	const language = languageForPath(path);
	if (!language) return display;
	const key = `${language}:${display}`;
	const cached = highlightCache.get(key);
	if (cached !== undefined) return cached;
	const highlighted = highlightCode(display, language)[0] ?? display;
	if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) highlightCache.clear();
	highlightCache.set(key, highlighted);
	return highlighted;
}

// --- word-level highlighting -------------------------------------------------------------

interface WordToken {
	end: number;
	start: number;
	text: string;
}

interface WordDiffRanges {
	newRanges: Array<[number, number]>;
	oldRanges: Array<[number, number]>;
	similarity: number;
}

function wordTokens(text: string): WordToken[] {
	const tokens: WordToken[] = [];
	const pattern = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)))
		tokens.push({ end: pattern.lastIndex, start: match.index, text: match[0] });
	return tokens;
}

function changedRanges(tokens: WordToken[], common: boolean[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let start: number | null = null;
	let end = 0;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (!common[index] && token.text.trim().length > 0) {
			if (start === null) start = token.start;
			end = token.end;
		} else if (start !== null) {
			ranges.push([start, end]);
			start = null;
		}
	}
	if (start !== null) ranges.push([start, end]);
	return ranges;
}

function wordDiffRanges(oldText: string, newText: string): WordDiffRanges {
	const oldTokens = wordTokens(oldText);
	const newTokens = wordTokens(newText);
	if (oldTokens.length === 0 && newTokens.length === 0)
		return { newRanges: [], oldRanges: [], similarity: 1 };
	if (oldTokens.length * newTokens.length > WORD_DIFF_CELL_LIMIT)
		return { newRanges: [], oldRanges: [], similarity: 0 };
	const width = newTokens.length + 1;
	const table = new Uint16Array((oldTokens.length + 1) * (newTokens.length + 1));
	for (let i = oldTokens.length - 1; i >= 0; i--) {
		for (let j = newTokens.length - 1; j >= 0; j--) {
			table[i * width + j] =
				oldTokens[i]!.text === newTokens[j]!.text
					? table[(i + 1) * width + j + 1]! + 1
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
		}
	}
	const oldCommon = new Array(oldTokens.length).fill(false);
	const newCommon = new Array(newTokens.length).fill(false);
	let i = 0;
	let j = 0;
	let commonChars = 0;
	while (i < oldTokens.length && j < newTokens.length) {
		if (oldTokens[i]!.text === newTokens[j]!.text) {
			oldCommon[i] = true;
			newCommon[j] = true;
			commonChars += oldTokens[i]!.text.length;
			i++;
			j++;
		} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
			i++;
		} else {
			j++;
		}
	}
	return {
		newRanges: changedRanges(newTokens, newCommon),
		oldRanges: changedRanges(oldTokens, oldCommon),
		similarity: commonChars / Math.max(oldText.length, newText.length, 1),
	};
}

function styleRanges(
	text: string,
	ranges: Array<[number, number]>,
	baseStyle: (value: string) => string,
	highlightStyle: (value: string) => string,
): string {
	if (ranges.length === 0 || hasAnsi(text)) return baseStyle(text);
	const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
	let out = "";
	let offset = 0;
	for (const [start, end] of sorted) {
		if (end <= offset || start >= text.length) continue;
		const safeStart = Math.max(offset, start);
		const safeEnd = Math.min(text.length, end);
		if (safeStart > offset) out += baseStyle(text.slice(offset, safeStart));
		out += highlightStyle(text.slice(safeStart, safeEnd));
		offset = safeEnd;
	}
	if (offset < text.length) out += baseStyle(text.slice(offset));
	return out;
}

/** Apply word highlighting to text that already carries syntax-highlighting escapes. */
function styleAnsiVisibleRanges(
	text: string,
	ranges: Array<[number, number]>,
	theme: RenderTheme,
	fgToken: ThemeColor,
	baseBg: AnsiParts,
	highlightBg: AnsiParts,
): string {
	if (!hasAnsi(text)) {
		const base = (value: string) => wrapBg(baseBg, theme.fg(fgToken, value));
		const highlight = (value: string) => wrapBg(highlightBg, theme.fg(fgToken, value));
		return styleRanges(text, ranges, base, highlight);
	}

	const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
	let rangeIndex = 0;
	let visibleIndex = 0;
	let activeStyle = "";
	let out = "";
	const ansiPattern = /\x1b\[[0-9;]*m/g;

	function inHighlightRange(index: number): boolean {
		while (rangeIndex < sorted.length && index >= sorted[rangeIndex]![1]) rangeIndex++;
		const range = sorted[rangeIndex];
		return Boolean(range && index >= range[0] && index < range[1]);
	}

	function emitChunk(chunk: string, highlighted: boolean): void {
		if (!chunk) return;
		const content = activeStyle ? chunk : theme.fg(fgToken, chunk);
		out += wrapBg(highlighted ? highlightBg : baseBg, content);
		if (activeStyle) out += activeStyle;
	}

	function emitPlain(plain: string): void {
		let chunk = "";
		let highlighted: boolean | undefined;
		for (const character of plain) {
			const nextHighlighted = inHighlightRange(visibleIndex);
			if (highlighted !== undefined && nextHighlighted !== highlighted) {
				emitChunk(chunk, highlighted);
				chunk = "";
			}
			highlighted = nextHighlighted;
			chunk += character;
			visibleIndex++;
		}
		if (highlighted !== undefined) emitChunk(chunk, highlighted);
	}

	let offset = 0;
	let match: RegExpExecArray | null;
	while ((match = ansiPattern.exec(text))) {
		emitPlain(text.slice(offset, match.index));
		out += match[0];
		activeStyle = updateActiveAnsiStyle(match[0]);
		offset = match.index + match[0].length;
	}
	emitPlain(text.slice(offset));
	return out;
}

// --- building a structured diff ----------------------------------------------------------

function splitContentLines(text: string): string[] {
	if (!text) return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function diffOps(
	oldLines: string[],
	newLines: string[],
): Array<{ text: string; type: "ctx" | "add" | "del" }> {
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
		start++;
	let oldEnd = oldLines.length - 1;
	let newEnd = newLines.length - 1;
	while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
		oldEnd--;
		newEnd--;
	}
	const ops: Array<{ text: string; type: "ctx" | "add" | "del" }> = [];
	for (let index = 0; index < start; index++) ops.push({ text: oldLines[index] ?? "", type: "ctx" });
	const oldMid = oldLines.slice(start, oldEnd + 1);
	const newMid = newLines.slice(start, newEnd + 1);
	if (oldMid.length * newMid.length > DIFF_LCS_CELL_LIMIT) {
		for (const text of oldMid) ops.push({ text, type: "del" });
		for (const text of newMid) ops.push({ text, type: "add" });
	} else {
		const rows = oldMid.length;
		const columns = newMid.length;
		const width = columns + 1;
		const table = new Uint32Array((rows + 1) * (columns + 1));
		for (let i = rows - 1; i >= 0; i--) {
			for (let j = columns - 1; j >= 0; j--) {
				table[i * width + j] =
					oldMid[i] === newMid[j]
						? table[(i + 1) * width + j + 1]! + 1
						: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
			}
		}
		let i = 0;
		let j = 0;
		while (i < rows && j < columns) {
			if (oldMid[i] === newMid[j]) {
				ops.push({ text: oldMid[i] ?? "", type: "ctx" });
				i++;
				j++;
			} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
				ops.push({ text: oldMid[i] ?? "", type: "del" });
				i++;
			} else {
				ops.push({ text: newMid[j] ?? "", type: "add" });
				j++;
			}
		}
		while (i < rows) ops.push({ text: oldMid[i++] ?? "", type: "del" });
		while (j < columns) ops.push({ text: newMid[j++] ?? "", type: "add" });
	}
	for (let index = oldEnd + 1; index < oldLines.length; index++)
		ops.push({ text: oldLines[index] ?? "", type: "ctx" });
	return ops;
}

export function hiddenDiffLine(count: number): StructuredDiffLine {
	return {
		content: count > 0 ? `… ${count} unchanged line${count === 1 ? "" : "s"} …` : "…",
		newNum: null,
		oldNum: null,
		type: "sep",
	};
}

export function assignHunkNumbers(lines: StructuredDiffLine[]): {
	hunks: number;
	lines: StructuredDiffLine[];
} {
	let hunk = 0;
	let inHunk = false;
	const numbered = lines.map((line) => {
		if (line.type === "sep") {
			inHunk = false;
			return { ...line, hunk: undefined };
		}
		if (line.type === "add" || line.type === "del") {
			if (!inHunk) {
				hunk++;
				inHunk = true;
			}
			return { ...line, hunk };
		}
		return inHunk ? { ...line, hunk } : line;
	});
	return { hunks: hunk, lines: numbered };
}

export function countStructuredHunks(lines: StructuredDiffLine[]): number {
	return assignHunkNumbers(lines).hunks;
}

function hiddenHunksAfter(allRows: StructuredDiffLine[], shownRows: StructuredDiffLine[]): number {
	const hunkNumbers = (lines: StructuredDiffLine[]) =>
		new Set(lines.map((line) => line.hunk).filter((hunk): hunk is number => typeof hunk === "number"));
	const shown = hunkNumbers(shownRows);
	let count = 0;
	for (const hunk of hunkNumbers(allRows.slice(shownRows.length))) if (!shown.has(hunk)) count++;
	return count;
}

function compactStructuredDiffLines(lines: StructuredDiffLine[]): StructuredDiffLine[] {
	const changed = lines
		.map((line, index) => (line.type === "add" || line.type === "del" ? index : -1))
		.filter((index) => index >= 0);
	if (changed.length === 0) return lines;

	const ranges: Array<{ end: number; start: number }> = [];
	for (const index of changed) {
		const start = Math.max(0, index - DIFF_CONTEXT_LINES);
		const end = Math.min(lines.length - 1, index + DIFF_CONTEXT_LINES);
		const previous = ranges[ranges.length - 1];
		if (!previous || start > previous.end + 1) ranges.push({ start, end });
		else previous.end = Math.max(previous.end, end);
	}

	const compacted: StructuredDiffLine[] = [];
	let previousEnd = -1;
	for (const range of ranges) {
		const hidden = range.start - previousEnd - 1;
		if (hidden > 0) compacted.push(hiddenDiffLine(hidden));
		compacted.push(...lines.slice(range.start, range.end + 1));
		previousEnd = range.end;
	}
	const trailingHidden = lines.length - previousEnd - 1;
	if (trailingHidden > 0) compacted.push(hiddenDiffLine(trailingHidden));
	return compacted;
}

/** @example buildStructuredDiff("a", "b").additions // 1 */
export function buildStructuredDiff(oldText: string, newText: string): StructuredDiff {
	const ops = diffOps(splitContentLines(oldText), splitContentLines(newText));
	let oldNum = 1;
	let newNum = 1;
	let additions = 0;
	let removals = 0;
	const lines: StructuredDiffLine[] = [];
	for (const op of ops) {
		if (op.type === "ctx") {
			lines.push({ content: op.text, newNum, oldNum, type: "ctx" });
			oldNum++;
			newNum++;
		} else if (op.type === "del") {
			lines.push({ content: op.text, newNum: null, oldNum, type: "del" });
			oldNum++;
			removals++;
		} else {
			lines.push({ content: op.text, newNum, oldNum: null, type: "add" });
			newNum++;
			additions++;
		}
	}
	const numbered = assignHunkNumbers(compactStructuredDiffLines(lines));
	return { additions, hunks: numbered.hunks, lines: numbered.lines, removals };
}

/** Read the edit operations an `edit` call requested, tolerating both argument spellings. */
export function editOperationsFromArgs(
	args: Record<string, unknown>,
): Array<{ newText: string; oldText: string }> {
	const asText = (value: unknown): string => (typeof value === "string" ? value : "");
	if (Array.isArray(args.edits)) {
		return (args.edits as Array<Record<string, unknown>>)
			.map((edit) => ({
				oldText: asText(edit?.oldText ?? edit?.old_text),
				newText: asText(edit?.newText ?? edit?.new_text),
			}))
			.filter((edit) => edit.oldText.length > 0 && edit.oldText !== edit.newText);
	}
	const oldText = asText(args.oldText ?? args.old_text);
	const newText = asText(args.newText ?? args.new_text);
	return oldText.length > 0 && oldText !== newText ? [{ oldText, newText }] : [];
}

// --- summaries ---------------------------------------------------------------------------

function diffStatBar(additions: number, removals: number, theme: RenderTheme): string {
	const total = additions + removals;
	if (total <= 0) return "";
	const slots = Math.max(6, Math.min(18, Math.ceil(total / 3)));
	let addSlots = Math.round((additions / total) * slots);
	if (additions > 0 && addSlots === 0) addSlots = 1;
	if (removals > 0 && addSlots === slots) addSlots = slots - 1;
	return `${theme.fg("dim", "[")}${theme.fg("toolDiffAdded", GLYPHS.line.repeat(addSlots))}${theme.fg(
		"toolDiffRemoved",
		GLYPHS.line.repeat(slots - addSlots),
	)}${theme.fg("dim", "]")}`;
}

export function diffSummary(diff: StructuredDiff, theme: RenderTheme): string {
	const parts: string[] = [];
	if (diff.additions > 0) parts.push(theme.fg("success", `+${diff.additions}`));
	if (diff.removals > 0) parts.push(theme.fg("error", `-${diff.removals}`));
	if (parts.length === 0) return theme.fg("muted", "no changes");
	const bar = diffStatBar(diff.additions, diff.removals, theme);
	const hunks = diff.hunks ?? countStructuredHunks(diff.lines);
	let summary = `${parts.join(" ")}${bar ? ` ${bar}` : ""}`;
	if (hunks > 0)
		summary += theme.fg("dim", `${GLYPHS.dot}${hunks} hunk${hunks === 1 ? "" : "s"}`);
	return summary;
}

// --- rendering ---------------------------------------------------------------------------

function colorDiffText(
	line: StructuredDiffLine,
	text: string,
	theme: RenderTheme,
	palette: DiffPalette,
	ranges: Array<[number, number]>,
): string {
	if (line.type === "sep") return theme.fg("dim", text);
	if (line.type === "ctx") return hasAnsi(text) ? text : theme.fg("toolDiffContext", text);
	const fgToken = line.type === "add" ? "toolDiffAdded" : "toolDiffRemoved";
	return styleAnsiVisibleRanges(text, ranges, theme, fgToken, lineBg(palette, line), palette.word);
}

function formatNum(value: number | null, width: number): string {
	return value === null ? " ".repeat(width) : String(value).padStart(width);
}

function lineWordRanges(
	line: StructuredDiffLine,
	mate: StructuredDiffLine | null,
): Array<[number, number]> {
	if (!mate) return [];
	const opposed =
		(line.type === "del" && mate.type === "add") || (line.type === "add" && mate.type === "del");
	if (!opposed) return [];
	const oldText = normalizeTerminalText(line.type === "del" ? line.content : mate.content);
	const newText = normalizeTerminalText(line.type === "add" ? line.content : mate.content);
	const ranges = wordDiffRanges(oldText, newText);
	if (ranges.similarity < WORD_DIFF_MIN_SIMILARITY) return [];
	return line.type === "del" ? ranges.oldRanges : ranges.newRanges;
}

function highlightedLineBody(line: StructuredDiffLine, path: string | undefined): string {
	if (line.type === "sep") return line.content || " ";
	return highlightDiffContent(line.content, path) || " ";
}

const FRAME = { bl: "└", br: "┘", h: "─", joint: "┴", tl: "┌", tm: "┬", tr: "┐", v: "│" } as const;

/** Resolve the border escape codes once instead of styling every glyph separately. */
function diffBorderStyler(theme: RenderTheme): (text: string) => string {
	const sample = FRAME.h.repeat(2);
	const styledSample = borderMuted(theme, sample);
	const sampleIndex = styledSample.indexOf(sample);
	if (sampleIndex < 0 || styledSample === sample) return (text: string) => borderMuted(theme, text);
	const open = styledSample.slice(0, sampleIndex);
	const close = styledSample.slice(sampleIndex + sample.length);
	return (text: string) => `${open}${text}${close}`;
}

function renderUnifiedLine(
	line: StructuredDiffLine,
	width: number,
	numWidth: number,
	theme: RenderTheme,
	palette: DiffPalette,
	path: string | undefined,
	ranges: Array<[number, number]> = [],
): string {
	const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
	const signToken =
		line.type === "add"
			? "toolDiffAdded"
			: line.type === "del"
				? "toolDiffRemoved"
				: "toolDiffContext";
	const gutter = `${theme.fg("muted", `${formatNum(line.oldNum, numWidth)} ${formatNum(line.newNum, numWidth)}`)} ${theme.fg(signToken, sign)} `;
	const contentWidth = Math.max(10, width - visibleLength(gutter));
	const body = colorDiffText(line, highlightedLineBody(line, path), theme, palette, ranges);
	return padVisible(`${gutter}${truncateAnsi(body, contentWidth)}`, width);
}

/** Group consecutive deletions with the additions that replaced them, so they can be paired. */
function walkDiffRows(
	rows: StructuredDiffLine[],
	onContext: (line: StructuredDiffLine) => void,
	onPair: (del: StructuredDiffLine | null, add: StructuredDiffLine | null) => void,
): void {
	let index = 0;
	while (index < rows.length) {
		const line = rows[index]!;
		if (line.type === "ctx" || line.type === "sep") {
			onContext(line);
			index++;
			continue;
		}
		const dels: StructuredDiffLine[] = [];
		const adds: StructuredDiffLine[] = [];
		while (index < rows.length && rows[index]!.type === "del") dels.push(rows[index++]!);
		while (index < rows.length && rows[index]!.type === "add") adds.push(rows[index++]!);
		for (let offset = 0; offset < Math.max(dels.length, adds.length); offset++)
			onPair(dels[offset] ?? null, adds[offset] ?? null);
	}
}

function numberWidth(diff: StructuredDiff): number {
	const maxNum = Math.max(1, ...diff.lines.map((line) => Math.max(line.oldNum ?? 0, line.newNum ?? 0)));
	return Math.max(2, String(maxNum).length);
}

function renderUnifiedDiff(
	diff: StructuredDiff,
	rows: StructuredDiffLine[],
	width: number,
	theme: RenderTheme,
	palette: DiffPalette,
	path: string | undefined,
): string[] {
	const numWidth = numberWidth(diff);
	const border = diffBorderStyler(theme);
	const cellWidth = Math.max(1, width - 2);
	const contentWidth = Math.max(1, cellWidth - 2);
	const rule = border(FRAME.h.repeat(cellWidth));
	const out: string[] = [`${border(FRAME.tl)}${rule}${border(FRAME.tr)}`];
	const push = (line: StructuredDiffLine, ranges: Array<[number, number]> = []) => {
		const cell = ` ${renderUnifiedLine(line, contentWidth, numWidth, theme, palette, path, ranges)} `;
		out.push(`${border(FRAME.v)}${applyFullLineBg(lineBg(palette, line), cell)}${border(FRAME.v)}`);
	};
	walkDiffRows(
		rows,
		(line) => push(line),
		(del, add) => {
			if (del) push(del, lineWordRanges(del, add));
			if (add) push(add, lineWordRanges(add, del));
		},
	);
	out.push(`${border(FRAME.bl)}${rule}${border(FRAME.br)}`);
	return out;
}

function renderDiffHalf(
	line: StructuredDiffLine | null,
	side: "old" | "new",
	width: number,
	numWidth: number,
	theme: RenderTheme,
	palette: DiffPalette,
	path: string | undefined,
	ranges: Array<[number, number]>,
): string {
	if (!line) return " ".repeat(width);
	const num = side === "old" ? line.oldNum : line.newNum;
	const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
	const prefix = `${formatNum(num, numWidth)} ${sign} `;
	const raw = `${prefix}${highlightedLineBody(line, path)}`;
	const shifted = ranges.map(([start, end]): [number, number] => [
		start + prefix.length,
		end + prefix.length,
	]);
	return padVisible(truncateAnsi(colorDiffText(line, raw, theme, palette, shifted), width), width);
}

function renderDiffCell(
	line: StructuredDiffLine | null,
	side: "old" | "new",
	cellWidth: number,
	numWidth: number,
	theme: RenderTheme,
	palette: DiffPalette,
	path: string | undefined,
	ranges: Array<[number, number]>,
): string {
	const contentWidth = Math.max(1, cellWidth - 2);
	const cell = ` ${renderDiffHalf(line, side, contentWidth, numWidth, theme, palette, path, ranges)} `;
	return applyFullLineBg(lineBg(palette, line), padVisible(cell, cellWidth));
}

function shouldUseSplitDiff(
	diff: StructuredDiff,
	rows: StructuredDiffLine[],
	width: number,
): boolean {
	if (width < DIFF_SPLIT_MIN_WIDTH) return false;
	const innerWidth = Math.max(2, width - 3);
	const codeWidth = Math.max(24, Math.floor(innerWidth / 2)) - 2 - numberWidth(diff) - 3;
	if (codeWidth < DIFF_SPLIT_MIN_CODE_WIDTH) return false;
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const line of rows) {
		if (line.type === "sep") continue;
		contentLines++;
		if (visibleLength(normalizeTerminalText(line.content)) > codeWidth) wrapCandidates++;
	}
	if (contentLines === 0) return true;
	if (wrapCandidates >= DIFF_SPLIT_MAX_WRAP_LINES) return false;
	return wrapCandidates / contentLines < DIFF_SPLIT_MAX_WRAP_RATIO;
}

function renderSplitDiff(
	diff: StructuredDiff,
	rows: StructuredDiffLine[],
	width: number,
	theme: RenderTheme,
	palette: DiffPalette,
	path: string | undefined,
): string[] {
	const numWidth = numberWidth(diff);
	const border = diffBorderStyler(theme);
	const innerWidth = Math.max(2, width - 3);
	const leftWidth = Math.max(1, Math.floor(innerWidth / 2));
	const rightWidth = Math.max(1, innerWidth - leftWidth);
	const rule = (cells: number) => border(FRAME.h.repeat(Math.max(1, cells)));
	const out = [
		`${border(FRAME.tl)}${rule(leftWidth)}${border(FRAME.tm)}${rule(rightWidth)}${border(FRAME.tr)}`,
	];
	const push = (left: StructuredDiffLine | null, right: StructuredDiffLine | null) => {
		const leftRanges = left && right ? lineWordRanges(left, right) : [];
		const rightRanges = left && right ? lineWordRanges(right, left) : [];
		out.push(
			`${border(FRAME.v)}${renderDiffCell(left, "old", leftWidth, numWidth, theme, palette, path, leftRanges)}${border(FRAME.v)}${renderDiffCell(right, "new", rightWidth, numWidth, theme, palette, path, rightRanges)}${border(FRAME.v)}`,
		);
	};
	walkDiffRows(
		rows,
		(line) => push(line, line),
		(del, add) => push(del, add),
	);
	out.push(
		`${border(FRAME.bl)}${rule(leftWidth)}${border(FRAME.joint)}${rule(rightWidth)}${border(FRAME.br)}`,
	);
	return out;
}

function overflowHint(remainingLines: number, hiddenHunks: number, width: number): string {
	const candidates = [
		`${GLYPHS.ellipsis} ${remainingLines} more diff lines${hiddenHunks > 0 ? `${GLYPHS.dot}${hiddenHunks} more hunks` : ""}`,
		`${GLYPHS.ellipsis} +${remainingLines}${hiddenHunks > 0 ? `${GLYPHS.dot}+${hiddenHunks}h` : ""}`,
		GLYPHS.ellipsis,
	];
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? GLYPHS.ellipsis;
}

/**
 * Render a diff table at exactly `width` columns.
 *
 * The source extension reads `process.stdout.columns` here, which overflows the overlay and
 * gets silently cut on the right. The overlay always supplies its own inner width instead.
 */
export function renderStructuredDiff(
	diff: StructuredDiff,
	theme: RenderTheme,
	width: number,
	path?: string,
	rowLimit: number = CAPS.diffRows,
): string[] {
	if (diff.additions === 0 && diff.removals === 0) return [theme.fg("muted", "no changes")];
	const tableWidth = Math.max(1, width);
	const rows = diff.lines.slice(0, Math.max(1, rowLimit));
	const palette = diffPalette(theme);
	const effectivePath = path ?? diff.path;
	const rendered = shouldUseSplitDiff(diff, rows, tableWidth)
		? renderSplitDiff(diff, rows, tableWidth, theme, palette, effectivePath)
		: renderUnifiedDiff(diff, rows, tableWidth, theme, palette, effectivePath);
	const remaining = diff.lines.length - rows.length;
	if (remaining > 0)
		rendered.push(
			theme.fg("dim", overflowHint(remaining, hiddenHunksAfter(diff.lines, rows), tableWidth)),
		);
	return rendered;
}

// --- parsing a stored unified diff --------------------------------------------------------

interface UnifiedDiffFile {
	diff: StructuredDiff;
	path: string;
}

interface UnifiedDiffBuilder {
	additions: number;
	hunkCount: number;
	lines: StructuredDiffLine[];
	newHunkEnd: number | null;
	newPath?: string;
	oldHunkEnd: number | null;
	oldPath?: string;
	path: string;
	removals: number;
	sawHunk: boolean;
}

function splitGitHeaderPaths(rest: string): string[] {
	const paths: string[] = [];
	const tokenPattern = /"((?:\\.|[^"])*)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(rest))) {
		const raw = match[1] ?? match[2] ?? "";
		if (!raw) continue;
		if (match[1] === undefined) {
			paths.push(raw);
			continue;
		}
		try {
			paths.push(JSON.parse(`"${raw}"`));
		} catch {
			paths.push(raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
		}
	}
	return paths;
}

function cleanDiffPath(raw: string): string {
	const path = raw.trim();
	if (!path || path === "/dev/null") return path;
	if ((path.startsWith("a/") || path.startsWith("b/")) && path.length > 2) return path.slice(2);
	return path;
}

function diffPathFromHeader(line: string): string {
	const value = line.replace(/^(?:---|\+\+\+)\s+/, "").trim().split(/\t/)[0] ?? "";
	return cleanDiffPath(value);
}

function displayUnifiedDiffPath(path: string, oldPath?: string, newPath?: string): string {
	if (newPath && newPath !== "/dev/null") return newPath;
	if (oldPath && oldPath !== "/dev/null") return oldPath;
	return path || "diff";
}

function parseHunkHeader(
	line: string,
): { newCount: number; newStart: number; oldCount: number; oldStart: number } | null {
	const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
	if (!match) return null;
	return {
		oldStart: Number.parseInt(match[1]!, 10),
		oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
		newStart: Number.parseInt(match[3]!, 10),
		newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
	};
}

/** Turn Pi's persisted `edit` patch into renderable rows with their real line numbers. */
export function parseUnifiedDiffOutput(output: string): UnifiedDiffFile[] | null {
	const lines = stripAnsi(output).replace(/\r\n/g, "\n").split("\n");
	const files: UnifiedDiffFile[] = [];
	// A holder object instead of a bare `let`: the nested `start`/`finish` closures reassign it,
	// which control-flow analysis cannot see through.
	const state: { current: UnifiedDiffBuilder | null } = { current: null };

	function finish(): void {
		if (!state.current) return;
		if (state.current.sawHunk && (state.current.additions > 0 || state.current.removals > 0)) {
			const path = displayUnifiedDiffPath(state.current.path, state.current.oldPath, state.current.newPath);
			files.push({
				diff: {
					additions: state.current.additions,
					hunks: state.current.hunkCount || countStructuredHunks(state.current.lines),
					lines: state.current.lines,
					path,
					removals: state.current.removals,
				},
				path,
			});
		}
		state.current = null;
	}

	function start(path = "diff"): void {
		finish();
		state.current = {
			additions: 0,
			hunkCount: 0,
			lines: [],
			newHunkEnd: null,
			oldHunkEnd: null,
			path,
			removals: 0,
			sawHunk: false,
		};
	}

	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line.startsWith("diff --git ")) {
			const paths = splitGitHeaderPaths(line.slice("diff --git ".length)).map(cleanDiffPath);
			start(paths[1] || paths[0] || "diff");
			index++;
			continue;
		}
		if (!state.current && line.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ "))
			start(diffPathFromHeader(lines[index + 1] ?? line));
		if (state.current && line.startsWith("--- ")) {
			state.current.oldPath = diffPathFromHeader(line);
			index++;
			continue;
		}
		if (state.current && line.startsWith("+++ ")) {
			state.current.newPath = diffPathFromHeader(line);
			state.current.path = displayUnifiedDiffPath(state.current.path, state.current.oldPath, state.current.newPath);
			index++;
			continue;
		}
		const hunk = state.current ? parseHunkHeader(line) : null;
		if (!state.current || !hunk) {
			index++;
			continue;
		}

		if (state.current.sawHunk && state.current.oldHunkEnd !== null && state.current.newHunkEnd !== null) {
			const hidden = Math.max(
				hunk.oldStart - state.current.oldHunkEnd - 1,
				hunk.newStart - state.current.newHunkEnd - 1,
			);
			if (hidden > 0) state.current.lines.push(hiddenDiffLine(hidden));
		}
		state.current.sawHunk = true;
		state.current.hunkCount++;
		const hunkNumber = state.current.hunkCount;
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		let oldConsumed = 0;
		let newConsumed = 0;
		index++;
		while (index < lines.length && (oldConsumed < hunk.oldCount || newConsumed < hunk.newCount)) {
			const raw = lines[index] ?? "";
			if (raw.startsWith("\\ No newline at end of file")) {
				index++;
				continue;
			}
			const marker = raw[0];
			const content = raw.slice(1);
			if (marker === " ") {
				state.current.lines.push({ content, hunk: hunkNumber, newNum: newLine, oldNum: oldLine, type: "ctx" });
				oldLine++;
				newLine++;
				oldConsumed++;
				newConsumed++;
			} else if (marker === "-") {
				state.current.lines.push({ content, hunk: hunkNumber, newNum: null, oldNum: oldLine, type: "del" });
				oldLine++;
				oldConsumed++;
				state.current.removals++;
			} else if (marker === "+") {
				state.current.lines.push({ content, hunk: hunkNumber, newNum: newLine, oldNum: null, type: "add" });
				newLine++;
				newConsumed++;
				state.current.additions++;
			} else {
				break;
			}
			index++;
		}
		state.current.oldHunkEnd = oldLine - 1;
		state.current.newHunkEnd = newLine - 1;
	}
	finish();
	return files.length > 0 ? files : null;
}
