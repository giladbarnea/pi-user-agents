import type { ThemeColor } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import type { EditorComponent } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import {
	type AgentTokenSemantic,
	type AgentValueValidator,
	scanAgentCommandLine,
} from "./command-line.js";

/** The minimal theme surface the coloring layer consumes. */
export type StyleTheme = { fg(color: ThemeColor, text: string): string };

export const AGENT_SEMANTIC_COLORS: Record<AgentTokenSemantic | "command", ThemeColor> = {
	command: "accent",
	option: "syntaxKeyword",
	value: "syntaxString",
	"invalid-value": "error",
	blocked: "error",
	"misplaced-option": "error",
	"misplaced-value": "error",
};

export type AgentColorSpan = { start: number; end: number; color: ThemeColor };

type LayoutLine = { text: string; hasCursor?: boolean; cursorPos?: number };
type ColoringRuntimeEditor = EditorComponent & {
	getLines?: () => string[];
	layoutText?: (contentWidth: number) => LayoutLine[];
};

const COLORED_EDITOR = Symbol.for("pi-user-agents:coloring-editor");
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type ColoredEditor = ColoringRuntimeEditor & { [COLORED_EDITOR]?: true };

/**
 * Map an editor line to theme-colored spans via the shared semantic scan.
 * Returns undefined for lines that are not agent commands.
 *
 * @example computeAgentColorSpans("/agent -m gpt56s go")?.[1] // { start: 7, end: 9, color: "syntaxKeyword" }
 */
export function computeAgentColorSpans(
	line: string,
	isValueValid?: AgentValueValidator,
): AgentColorSpan[] | undefined {
	const scan = scanAgentCommandLine(line, isValueValid);
	if (!scan) return undefined;
	const spans: AgentColorSpan[] = [
		{ start: 0, end: scan.commandEnd, color: AGENT_SEMANTIC_COLORS.command },
	];
	for (const token of scan.tokens) {
		if (token.end > token.start)
			spans.push({
				start: token.start,
				end: token.end,
				color: AGENT_SEMANTIC_COLORS[token.semantic],
			});
	}
	return spans;
}

/**
 * Patch the editor's layout pass to paint agent-command tokens with theme colors.
 * Layout and wrapping run on the raw text first; styling only rewrites the laid-out
 * chunk text (and remaps the cursor index) so editing behavior is untouched.
 */
export function decorateColoringEditor<T extends EditorComponent>(
	editor: T,
	getTheme: () => StyleTheme,
	isValueValid?: AgentValueValidator,
): T {
	const runtimeEditor = editor as T & ColoredEditor;
	if (runtimeEditor[COLORED_EDITOR]) return editor;
	const layoutText = runtimeEditor.layoutText;
	const getLines = runtimeEditor.getLines;
	if (typeof layoutText !== "function" || typeof getLines !== "function")
		throw new Error("pi-user-agents coloring requires editor.layoutText() and editor.getLines()");
	runtimeEditor.layoutText = (contentWidth: number): LayoutLine[] => {
		const layoutLines = layoutText.call(editor, contentWidth);
		const line = getLines.call(editor)[0] ?? "";
		const spans = computeAgentColorSpans(line, isValueValid);
		if (spans === undefined) return layoutLines;
		const theme = getTheme();
		let offset = 0;
		for (const layoutLine of layoutLines) {
			const rawLength = layoutLine.text.length;
			const styled = styleLayoutSlice(
				layoutLine.text,
				offset,
				spans,
				theme,
				layoutLine.hasCursor ? layoutLine.cursorPos : undefined,
			);
			layoutLine.text = styled.text;
			if (styled.cursorPos !== undefined) layoutLine.cursorPos = styled.cursorPos;
			offset += rawLength;
			if (offset >= line.length) break;
		}
		return layoutLines;
	};
	runtimeEditor[COLORED_EDITOR] = true;
	return editor;
}

/**
 * Paint one laid-out chunk of the first logical line. The cursor index is remapped to
 * the styled string and its grapheme is left unpainted, because the editor renders the
 * cursor by inverse-videoing the first grapheme found at that index.
 */
function styleLayoutSlice(
	text: string,
	sliceStart: number,
	spans: readonly AgentColorSpan[],
	theme: StyleTheme,
	cursorPos: number | undefined,
): { text: string; cursorPos?: number } {
	let styled = "";
	let styledCursorPos: number | undefined;
	let index = 0;

	const paint = (segment: string, color: ThemeColor | undefined): void => {
		if (segment === "") return;
		styled += color === undefined ? segment : theme.fg(color, segment);
	};
	const emitRun = (runEnd: number, color: ThemeColor | undefined): void => {
		while (index < runEnd) {
			if (
				cursorPos !== undefined &&
				styledCursorPos === undefined &&
				cursorPos >= index &&
				cursorPos < runEnd
			) {
				paint(text.slice(index, cursorPos), color);
				styledCursorPos = styled.length;
				const grapheme = firstGrapheme(text.slice(cursorPos, runEnd));
				styled += grapheme;
				index = cursorPos + grapheme.length;
				continue;
			}
			paint(text.slice(index, runEnd), color);
			index = runEnd;
		}
	};

	const sliceEnd = sliceStart + text.length;
	for (const span of spans) {
		if (span.end <= sliceStart || span.start >= sliceEnd) continue;
		const localStart = Math.max(span.start - sliceStart, 0);
		const localEnd = Math.min(span.end - sliceStart, text.length);
		emitRun(localStart, undefined);
		emitRun(localEnd, span.color);
	}
	emitRun(text.length, undefined);
	if (cursorPos !== undefined && styledCursorPos === undefined) styledCursorPos = styled.length;
	return { text: styled, cursorPos: styledCursorPos };
}

function firstGrapheme(text: string): string {
	for (const segment of graphemeSegmenter.segment(text)) return segment.segment;
	return "";
}
