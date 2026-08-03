import type { ThemeColor } from "@earendil-works/pi-coding-agent";

import { GLYPHS } from "./constants.js";

/**
 * The overlay only guarantees `fg` and `bold`. Everything else is probed defensively.
 *
 * These are written as methods, not function properties, so Pi's `Theme` — whose tokens are
 * narrow string unions — stays assignable to this wider structural type.
 */
export type RenderTheme = {
	bg?(token: string, text: string): string;
	bold(text: string): string;
	fg(token: ThemeColor, text: string): string;
};

export type TreeBranch = "├" | "└" | "│";

/**
 * Return the styled text only when the theme actually knows the token.
 *
 * A theme that does not recognize a token returns the text unchanged, and some themes alias
 * unknown tokens to plain body text. Both cases must fall through to the next candidate.
 */
export function fgToken(
	theme: RenderTheme,
	token: ThemeColor,
	text: string,
	rejectTextFallback = false,
): string | undefined {
	const styled = theme.fg(token, text);
	if (typeof styled !== "string" || styled === text) return undefined;
	if (!rejectTextFallback || token === "text") return styled;
	const textStyled = theme.fg("text", text);
	if (typeof textStyled === "string" && textStyled !== text && styled === textStyled) return undefined;
	return styled;
}

export function subtleRule(theme: RenderTheme, text: string): string {
	return (
		fgToken(theme, "borderMuted", text, true) ??
		fgToken(theme, "muted", text, true) ??
		fgToken(theme, "dim", text, true) ??
		text
	);
}

export function toolRule(theme: RenderTheme, text: string): string {
	return fgToken(theme, "muted", text, true) ?? fgToken(theme, "dim", text, true) ?? text;
}

export function borderMuted(theme: RenderTheme, text: string): string {
	return subtleRule(theme, text);
}

export function treeGlyph(branch: TreeBranch): string {
	if (branch === "│") return `  ${GLYPHS.tree.stem}`;
	return branch === "└" ? `  ${GLYPHS.tree.last}` : `  ${GLYPHS.tree.mid}`;
}

export function treeConnector(theme: RenderTheme, branch: TreeBranch = "├"): string {
	return toolRule(theme, treeGlyph(branch));
}

export function toolLabel(theme: RenderTheme, label: string): string {
	return theme.fg("text", theme.bold(label));
}

export function stackPrefix(theme: RenderTheme): string {
	return fgToken(theme, "accent", GLYPHS.bullet, true) ?? GLYPHS.bullet;
}
