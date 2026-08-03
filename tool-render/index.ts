import { truncateToWidth } from "./ansi.js";
import { CAPS } from "./constants.js";
import type { RenderTheme } from "./theme.js";
import {
	formatArguments,
	shortenPath,
	splitTerminalLines,
	type ToolResultLike,
	truncateText,
} from "./text.js";
import { isFirstClassTool, renderFirstClassTool, renderGenericTool } from "./tools.js";

export type { RenderTheme } from "./theme.js";
export type { ToolResultLike } from "./text.js";

export type ToolCallPart = {
	arguments: Record<string, unknown>;
	id: string;
	name: string;
	type: "toolCall";
};

/** The persisted transcript shape, narrowed structurally so this module stays standalone. */
type TranscriptMessage = {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
	role: string;
	toolCallId?: string;
	toolName?: string;
};

export type ToolIndex = {
	/** Every tool-call id present in the same slice, so already-rendered results can be dropped. */
	callIds: Set<string>;
	resultByCallId: Map<string, ToolResultLike>;
};

function isToolCallPart(part: unknown): part is ToolCallPart {
	const candidate = part as ToolCallPart | undefined;
	return candidate?.type === "toolCall" && typeof candidate.id === "string";
}

/**
 * Pair calls with results by their stable identity in one pass.
 *
 * Order is never used as a fallback: parallel tool calls make it ambiguous. A call with no
 * entry in `resultByCallId` genuinely has no stored result.
 */
export function indexToolMessages(messages: readonly TranscriptMessage[]): ToolIndex {
	const index: ToolIndex = { callIds: new Set(), resultByCallId: new Map() };
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (isToolCallPart(part)) index.callIds.add(part.id);
			continue;
		}
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			index.resultByCallId.set(message.toolCallId, {
				content: message.content as ToolResultLike["content"],
				details: message.details,
				isError: message.isError === true,
			});
		}
	}
	return index;
}

/**
 * Render one historical tool call, with its stored result when there is one.
 *
 * Every returned line fits `width` and contains no newline, because the overlay hard-cuts
 * lines instead of wrapping them.
 */
export function renderToolCall(
	call: ToolCallPart,
	result: ToolResultLike | undefined,
	width: number,
	theme: RenderTheme,
): string[] {
	if (width <= 0) return [];
	const args = call.arguments ?? {};
	const lines = isFirstClassTool(call.name)
		? renderFirstClassTool(call.name, args, result, theme, width)
		: renderGenericTool(call.name, args, result, theme, width);
	return lines.map((line) => truncateToWidth(line, width));
}

/**
 * Render a stored result whose call is not in the visible slice.
 *
 * This happens at the inherited-message boundary, where the assistant message holding the
 * call was cloned from the parent session and skipped by the transcript view.
 */
export function renderOrphanToolResult(
	toolName: string,
	result: ToolResultLike,
	width: number,
	theme: RenderTheme,
): string[] {
	if (width <= 0) return [];
	return renderGenericTool(toolName, {}, result, theme, width).map((line) =>
		truncateToWidth(line, width),
	);
}

function argumentString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === "string" ? value : "";
}

/**
 * A single plain-text line for the activity preview under the editor.
 *
 * The preview runs this through Pi's Markdown renderer, so it carries no escape codes. The
 * tool name keeps the backtick convention already used for tool results.
 *
 * @example describeToolCall({ type: "toolCall", id: "1", name: "ls", arguments: {} })
 */
export function describeToolCall(call: ToolCallPart): string {
	const args = call.arguments ?? {};
	const name = `\`${call.name}\``;
	if (call.name === "bash") {
		const firstLine = splitTerminalLines(argumentString(args, "command"))[0]?.trim() ?? "";
		return firstLine ? `${name} $ ${truncateText(firstLine, CAPS.commandPreviewChars)}` : name;
	}
	if (call.name === "read" || call.name === "edit" || call.name === "write" || call.name === "ls") {
		const path = argumentString(args, "path") || argumentString(args, "file_path");
		return path ? `${name} ${shortenPath(path)}` : name;
	}
	if (call.name === "grep" || call.name === "find") {
		const query =
			argumentString(args, "pattern") || argumentString(args, "glob") || argumentString(args, "path");
		return query ? `${name} ${truncateText(query, CAPS.genericArgumentChars)}` : name;
	}
	const readableArguments = formatArguments(args, CAPS.genericArgumentChars);
	return readableArguments ? `${name} ${readableArguments}` : name;
}
