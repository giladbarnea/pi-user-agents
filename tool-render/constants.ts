/**
 * Flat constants for the overlay's historical tool renderer.
 *
 * The source extensions read these from `.pi/settings.json` on every call, walking parent
 * directories and parsing JSON. The overlay re-renders about ten times per second, so it
 * uses fixed values instead. It also renders only Unicode glyphs, because the overlay frame
 * already draws Unicode box characters unconditionally.
 */

export const GLYPHS = {
	bullet: "● ",
	dot: " · ",
	ellipsis: "…",
	fail: "✗",
	line: "─",
	ok: "✓",
	tree: { mid: "├─ ", last: "└─ ", stem: "│  " },
} as const;

/** The overlay is a scrollable inspection surface, so caps are small on purpose. */
export const CAPS = {
	/** Diff rows per edit or write result. The source extension allows 4000. */
	diffRows: 120,
	/** Preview lines under a `read` result. The source extension allows 80. */
	readPreviewLines: 20,
	/** Preview lines under a `grep`, `find`, or `ls` result. The source extension allows 80. */
	searchPreviewLines: 20,
	/**
	 * Rows drawn inside a `bash` result frame. The source extension allows every line.
	 *
	 * This counts drawn rows, not stored lines. One stored line of minified output wraps into
	 * many rows at overlay width, so capping stored lines caps nothing.
	 */
	bashOutputRows: 40,
	/** Rows drawn inside a `bash` command frame, counted the same way. */
	bashCommandRows: 20,
	/** Output lines for a tool with no first-class renderer. */
	genericResultLines: 12,
	/** Characters of a single output line before it is clipped. */
	maxLineWidth: 1000,
	/** Characters of a `bash` command shown in the headline. */
	commandPreviewChars: 96,
	/** Characters of serialized arguments shown by the generic fallback. */
	genericArgumentChars: 160,
} as const;

/** Diff tables narrower than this render unified instead of side by side. */
export const DIFF_SPLIT_MIN_WIDTH = 132;
