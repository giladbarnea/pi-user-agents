import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";

export const ANSI_BG_RESET = "\x1b[49m";

/** Private-use character used to locate where a theme's escape codes open and close. */
export const STYLE_MARKER = "\uE000";

const ANSI_RE = /\x1b(?:\[[0-9;:]*m|\]133;[ABC]\x07|\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/g;
const ANSI_PRESENT_RE = /\x1b\[[0-9;]*m/;

export interface AnsiParts {
	close: string;
	open: string;
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function hasAnsi(text: string): boolean {
	return ANSI_PRESENT_RE.test(text);
}

export function visibleLength(text: string): number {
	return visibleWidth(text);
}

/** @example padVisible("ab", 4) // "ab  " */
export function padVisible(text: string, width: number): string {
	const missing = width - visibleLength(text);
	return missing > 0 ? `${text}${" ".repeat(missing)}` : text;
}

export function truncateAnsi(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "");
}

/** Split a styled marker string into the escape codes that open and close it. */
export function ansiPartsFromStyled(styled: string): AnsiParts {
	const markerIndex = styled.indexOf(STYLE_MARKER);
	if (markerIndex < 0) return { open: "", close: "" };
	return {
		open: styled.slice(0, markerIndex),
		close: styled.slice(markerIndex + STYLE_MARKER.length),
	};
}

export function ansiHasBackground(open: string): boolean {
	for (const match of open.matchAll(/\x1b\[([0-9;:]*)m/g)) {
		const params = match[1] || "0";
		if (/(^|[;:])48([;:]|$)/.test(params)) return true;
		if (/(^|[;:])(?:4[0-7]|10[0-7])([;:]|$)/.test(params)) return true;
	}
	return false;
}

export function sgrClearsBackground(code: string): boolean {
	const match = code.match(/^\x1b\[([0-9;]*)m$/);
	if (!match) return false;
	const params = match[1] ? match[1].split(";").map((value) => Number.parseInt(value || "0", 10)) : [0];
	return params.some((value) => value === 0 || value === 49);
}

/** Track which foreground style is active so word-diff highlighting can restore it. */
export function updateActiveAnsiStyle(code: string): string {
	const match = code.match(/^\x1b\[([0-9;]*)m$/);
	if (!match) return "";
	const params = match[1] ? match[1].split(";").map((value) => Number.parseInt(value || "0", 10)) : [0];
	if (params.some((value) => value === 0 || value === 39)) return "";
	return code;
}

export { truncateToWidth, visibleWidth, wrapTextWithAnsi };
