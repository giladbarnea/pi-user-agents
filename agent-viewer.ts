import * as childProcess from "node:child_process";
import {
	type Component,
	Input,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderAgentContextMeter } from "./context-meter.js";
import type { AgentMessage, CompletedAgent, RunningAgent, Theme } from "./shared.js";
import {
	errorMessage,
	formatMs,
	formatToolUses,
	formatTurns,
	logSteering,
	mainContextLabel,
	truncatePlain,
} from "./shared.js";
import {
	describeToolCall,
	indexToolMessages,
	renderOrphanToolResult,
	renderToolCall,
	type ToolCallPart,
	type ToolIndex,
} from "./tool-render/index.js";

export type ViewableAgent = RunningAgent | CompletedAgent;
export type AgentViewerAction = "hide" | "detach";

export type ActivityDescription = {
	text: string;
	truncation: "middle" | "tail";
};

type AssistantContentPart = Extract<AgentMessage, { role: "assistant" }>["content"][number];

const ANSI_SEQUENCE_PATTERN = "\\x1b\\[[0-?]*[ -/]*[@-~]";
const LEADING_RENDERED_WHITESPACE = new RegExp(`^((?:${ANSI_SEQUENCE_PATTERN})*)\\s+`);
const TRAILING_RENDERED_WHITESPACE = new RegExp(`\\s+((?:${ANSI_SEQUENCE_PATTERN})*)$`);
const MIDDLE_TRUNCATION_PLACEHOLDER = "…";

export function describeActivity(agent: RunningAgent): ActivityDescription {
	if (agent.status === "done-waiting-to-post")
		return { text: "done; posting result…", truncation: "tail" };
	if (agent.status === "idle") return { text: agent.responseText, truncation: "tail" };
	if (agent.status === "error")
		return { text: `Error: ${agent.error ?? "unknown"}`, truncation: "tail" };
	if (agent.status === "starting") return { text: "starting child session…", truncation: "tail" };
	if (!agent.latestFinalizedMessage) return { text: "", truncation: "tail" };
	return describeMessage(agent.latestFinalizedMessage);
}

function describeMessage(message: AgentMessage): ActivityDescription {
	switch (message.role) {
		case "assistant":
			return (
				message.content
					.map(describeAssistantPart)
					.filter((activity) => activity.text.trim())
					.at(-1) ?? { text: "", truncation: "tail" }
			);
		case "user":
		case "custom":
			return {
				text:
					typeof message.content === "string"
						? message.content
						: message.content
								.flatMap((part) => (part.type === "text" ? [part.text] : []))
								.join("\n"),
				truncation: "tail",
			};
		case "toolResult": {
			const toolName = `\`${message.toolName}\``;
			const output = message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");
			return { text: output ? `${toolName}: ${output}` : toolName, truncation: "middle" };
		}
		case "bashExecution":
			return { text: message.output || message.command, truncation: "middle" };
		case "branchSummary":
		case "compactionSummary":
			return { text: message.summary, truncation: "tail" };
	}
}

function describeAssistantPart(part: AssistantContentPart): ActivityDescription {
	if (part.type === "text") return { text: part.text, truncation: "tail" };
	if (part.type === "thinking") return { text: part.thinking, truncation: "middle" };
	return { text: describeToolCall(part as ToolCallPart), truncation: "middle" };
}

export function renderActivity(description: ActivityDescription, width: number, theme: Theme): string {
	if (width <= 0) return "";
	const normalized = description.text.replace(/\s+/g, " ").trim();
	const dim = (text: string) => theme.fg("dim", text);
	const markdown = new Markdown(normalized, 0, 0, dimMarkdownThemeFromTheme(theme), { color: dim });
	const rendered = markdown
		.render(Math.max(width, visibleWidth(normalized)))
		.map(trimRenderedLine)
		.filter((line) => visibleWidth(line) > 0)
		.join(" ");
	return description.truncation === "tail"
		? truncateToWidth(rendered, width, dim("..."))
		: truncateMiddle(rendered, width, dim(MIDDLE_TRUNCATION_PLACEHOLDER));
}

function trimRenderedLine(line: string): string {
	return line
		.replace(LEADING_RENDERED_WHITESPACE, "$1")
		.replace(TRAILING_RENDERED_WHITESPACE, "$1");
}

/**
 * @example
 * truncateMiddle("abcdefghij", 9) // "abcd…ghij"
 */
function truncateMiddle(
	text: string,
	width: number,
	placeholder: string = MIDDLE_TRUNCATION_PLACEHOLDER,
): string {
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text;
	if (width <= 0) return "";
	const placeholderWidth = visibleWidth(placeholder);
	if (width <= placeholderWidth) return sliceByColumn(placeholder, 0, width);
	const contentWidth = width - placeholderWidth;
	const headWidth = Math.ceil(contentWidth / 2);
	const tailWidth = Math.floor(contentWidth / 2);
	return `${sliceByColumn(text, 0, headWidth)}${placeholder}${sliceByColumn(text, textWidth - tailWidth, tailWidth)}`;
}

const VIEWER_CHROME_LINES = 6;
const VIEWER_MIN_VIEWPORT = 3;
const VIEWER_HEIGHT_PCT = 85;

/** Focus-capturing overlay that shows an agent's live or finished response. */
export class AgentViewer implements Component {
	private scrollOffset = 0;
	private autoScroll = true;
	private lastWidth = 0;
	private justCopied = false;
	private confirmingDetach = false;
	private rebaseWarning: string | undefined;
	private rebaseWarningTimer: ReturnType<typeof setTimeout> | undefined;
	/** True while the sibling-detach confirmation shows; the next r confirms the rebase. */
	private confirmingRebase = false;
	private composer: Input | undefined;
	/** Rich tool rendering is far too costly to repeat on every 100 ms widget tick. */
	private renderedContent: { key: string; lines: string[] } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly agent: ViewableAgent,
		private readonly theme: Theme,
		private readonly done: (result: AgentViewerAction) => void,
		private readonly canSquashMainContext: () => boolean,
		private readonly squashMainContext: () => void,
		private readonly canRebaseMainContext: () => boolean,
		private readonly rebaseMainContext: () => void,
		private readonly rebaseBlockReason: () => string | undefined,
		private readonly rebaseDetachCount: () => number,
		private readonly interrupt: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+x") && isLiveAgent(this.agent)) {
			this.confirmingDetach = false;
			this.interrupt();
			this.tui.requestRender();
			return;
		}
		if (this.composer) {
			this.confirmingDetach = false;
			this.composer.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "d")) {
			this.requestDetach();
			return;
		}
		this.confirmingDetach = false;
		const rebaseConfirmPending = this.confirmingRebase;
		this.confirmingRebase = false;
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done("hide");
			return;
		}
		if (matchesKey(data, "enter") && this.canSteer()) {
			this.openComposer();
			return;
		}
		if (matchesKey(data, "c")) {
			this.copyResponse();
			return;
		}
		if (matchesKey(data, "s") && this.canSquashMainContext()) {
			this.squashMainContext();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "r")) {
			if (this.canRebaseMainContext()) {
				const detachCount = this.rebaseDetachCount();
				if (detachCount > 0 && !rebaseConfirmPending) {
					this.confirmingRebase = true;
					this.showRebaseWarning(
						`Rebase will detach ${detachCount} other agent session${detachCount === 1 ? "" : "s"}. r again to confirm`,
					);
					return;
				}
				// Close the overlay: the payoff is the rebased conversation now sitting in the main transcript.
				this.rebaseMainContext();
				this.done("hide");
				return;
			}
			const reason = this.rebaseBlockReason();
			if (reason) {
				this.showRebaseWarning(`Can't rebase: ${reason}`);
				return;
			}
		}
		const viewport = this.viewportHeight();
		const maxScroll = Math.max(
			0,
			this.contentLines(this.innerWidth(this.lastWidth)).length - viewport,
		);
		if (matchesKey(data, "up") || matchesKey(data, "k"))
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (matchesKey(data, "down") || matchesKey(data, "j"))
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up"))
			this.scrollOffset = Math.max(0, this.scrollOffset - viewport);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down"))
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewport);
		else if (matchesKey(data, "home")) this.scrollOffset = 0;
		else if (matchesKey(data, "end")) this.scrollOffset = maxScroll;
		else return;
		this.autoScroll = this.scrollOffset >= maxScroll;
	}

	render(width: number): string[] {
		if (width < 6) return [];
		this.lastWidth = width;
		const th = this.theme;
		const innerW = this.innerWidth(width);
		const pad = (text: string, length: number) =>
			text + " ".repeat(Math.max(0, length - visibleWidth(text)));
		const row = (content: string) =>
			`${th.fg("border", "│")} ${truncateToWidth(pad(content, innerW), innerW)} ${th.fg("border", "│")}`;
		const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
		const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
		const hrMid = row(th.fg("dim", "─".repeat(innerW)));

		const lines: string[] = [hrTop];
		const running = isRunningAgent(this.agent);
		const live = isLiveAgent(this.agent);
		const failed = agentFailed(this.agent);
		const icon = live ? th.fg("accent", "●") : failed ? th.fg("error", "✗") : th.fg("success", "✓");
		const idle = running && this.agent.status === "idle";
		const stats: string[] = [];
		if (this.agent.turnCount > 0) stats.push(formatTurns(this.agent.turnCount));
		if (this.agent.toolUses > 0) stats.push(formatToolUses(this.agent.toolUses));
		stats.push(
			formatMs(
				running
					? (this.agent.completedAt ?? Date.now()) - this.agent.turnStartedAt
					: this.agent.durationMs,
			),
		);
		const status = live ? "running" : idle ? "idle" : failed ? "failed" : "completed";
		const metadata = [
			th.fg("dim", this.agent.modelLabel),
			renderAgentContextMeter(this.agent, th),
			th.fg("dim", status),
			...stats.map((stat) => th.fg("dim", stat)),
			th.fg("dim", this.agent.sessionId),
		]
			.filter(Boolean)
			.join(` ${th.fg("dim", "·")} `);
		const header = [
			icon,
			th.bold(`/${this.agent.command}`),
			th.fg("muted", truncatePlain(this.agent.task, 60)),
			th.fg("dim", "·"),
			metadata,
		]
			.filter(Boolean)
			.join(" ");
		lines.push(row(header));
		lines.push(hrMid);

		const content = this.contentLines(innerW);
		const viewport = this.viewportHeight();
		const maxScroll = Math.max(0, content.length - viewport);
		if (this.autoScroll || this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		const visible = content.slice(this.scrollOffset, this.scrollOffset + viewport);
		for (let index = 0; index < viewport; index += 1) lines.push(row(visible[index] ?? ""));

		lines.push(hrMid);
		if (this.composer) {
			lines.push(row(this.composer.render(innerW)[0] ?? ""));
			const composeLeft = th.fg("accent", "✎ steer");
			const composeHint = th.fg("dim", "Enter send · Esc cancel");
			lines.push(
				row(
					composeLeft +
						" ".repeat(
							Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint)),
						) +
						composeHint,
				),
			);
		} else if (this.rebaseWarning) {
			lines.push(row(th.fg("warning", `⚠ ${this.rebaseWarning}`)));
		} else {
			const scrollPct =
				content.length <= viewport
					? "100%"
					: `${Math.round(((this.scrollOffset + viewport) / content.length) * 100)}%`;
			const mainContext = mainContextLabel(this.agent.mainContextState);
			const footer = fitFooterSegments(
				th,
				innerW,
				[
					th.fg("dim", `${content.length} lines`),
					th.fg("dim", scrollPct),
					this.canSteer() ? th.fg("dim", "Enter steer") : "",
					this.justCopied ? th.fg("success", "✓ copied") : th.fg("dim", "c copy"),
					th.fg("dim", "↑↓ scroll"),
					th.fg("dim", "PgUp/PgDn"),
					this.canSquashMainContext() ? th.fg("dim", "s squash") : "",
					this.canRebaseMainContext() ? th.fg("dim", "r rebase") : "",
					isLiveAgent(this.agent) ? th.fg("dim", "Ctrl+x interrupt") : "",
					mainContext ? th.fg("dim", mainContext) : "",
					isLiveAgent(this.agent) ? th.fg("dim", "Esc hide") : "",
					th.fg(
						this.confirmingDetach ? "error" : "dim",
						this.confirmingDetach ? "d again to confirm" : "d detach",
					),
				].filter(Boolean),
			);
			lines.push(row(footer));
		}
		lines.push(hrBot);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {}

	/** Surface why r did nothing, in the footer, for a few seconds. Memory-only, like `✓ copied`. */
	private showRebaseWarning(warning: string): void {
		this.rebaseWarning = warning;
		if (this.rebaseWarningTimer) clearTimeout(this.rebaseWarningTimer);
		this.rebaseWarningTimer = setTimeout(() => {
			this.rebaseWarning = undefined;
			this.confirmingRebase = false;
			this.tui.requestRender();
		}, 4000);
		this.tui.requestRender();
	}

	private requestDetach(): void {
		this.confirmingRebase = false;
		if (this.confirmingDetach) {
			this.done("detach");
			return;
		}
		this.confirmingDetach = true;
		this.tui.requestRender();
	}

	private copyResponse(): void {
		const text =
			isRunningAgent(this.agent) || this.agent.ok
				? this.agent.responseText
				: (this.agent.error ?? "");
		const child = childProcess.execFile("pbcopy", (error) => {
			if (error) return;
			this.justCopied = true;
			this.tui.requestRender();
			setTimeout(() => {
				this.justCopied = false;
				this.tui.requestRender();
			}, 1500);
		});
		child.stdin?.end(text);
	}

	private innerWidth(width: number): number {
		return Math.max(1, width - 4);
	}

	private viewportHeight(): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWER_HEIGHT_PCT) / 100);
		return Math.max(VIEWER_MIN_VIEWPORT, maxRows - VIEWER_CHROME_LINES - (this.composer ? 1 : 0));
	}

	private canSteer(): boolean {
		return isSteerableAgent(this.agent) && this.agent.session !== undefined;
	}

	private openComposer(): void {
		if (!isRunningAgent(this.agent) || !this.agent.session) {
			logSteering(this.agent.id, "composer-refused", { running: isRunningAgent(this.agent) });
			return;
		}
		const agent = this.agent;
		const session = agent.session;
		logSteering(agent.id, "composer-opened", {
			status: agent.status,
			streaming: session.isStreaming,
		});
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value: string) => {
			const message = value.trim();
			this.composer = undefined;
			if (!message) {
				logSteering(agent.id, "steer-empty", {
					status: agent.status,
					streaming: session.isStreaming,
				});
				this.tui.requestRender();
				return;
			}
			this.autoScroll = true;
			logSteering(agent.id, "steer-submitted", {
				status: agent.status,
				streaming: session.isStreaming,
				messageLength: message.length,
			});
			if (agent.status === "idle") {
				agent.resume?.(message);
			} else {
				void session.steer(message).then(
					() => logSteering(agent.id, "steer-queued", { streaming: session.isStreaming }),
					(error) =>
						logSteering(agent.id, "steer-rejected", {
							error: errorMessage(error),
							streaming: session.isStreaming,
						}),
				);
			}
			this.tui.requestRender();
		};
		input.onEscape = () => {
			this.composer = undefined;
			logSteering(agent.id, "composer-cancelled", {
				status: agent.status,
				streaming: session.isStreaming,
			});
			this.tui.requestRender();
		};
		this.composer = input;
		this.tui.requestRender();
	}

	private contentLines(width: number): string[] {
		const key = this.contentCacheKey(width);
		if (this.renderedContent?.key === key) return this.renderedContent.lines;
		const lines = this.buildContentLines(width);
		this.renderedContent = { key, lines };
		return lines;
	}

	/**
	 * Invalidate on anything that changes the rendered transcript.
	 *
	 * Streamed content only ever grows, so the summed length of the last message's parts is
	 * enough to notice it changing without walking the whole transcript.
	 */
	private contentCacheKey(width: number): string {
		const messages = transcriptMessages(this.agent);
		const running = isRunningAgent(this.agent);
		return [
			width,
			messages.length,
			messageContentLength(messages[messages.length - 1]),
			running ? this.agent.status : "done",
			running ? this.agent.responseText.length : 0,
			// A live agent appends an activity line drawn from this message, not from the transcript.
			running ? messageContentLength(this.agent.latestFinalizedMessage) : 0,
			this.agent.error?.length ?? 0,
		].join("|");
	}

	private buildContentLines(width: number): string[] {
		if (width <= 0) return [];
		const lines = this.transcriptLines(width);
		if (isLiveAgent(this.agent)) {
			if (lines.length === 0) return [this.theme.fg("dim", "(waiting for first message…)")];
			const activity = describeActivity(this.agent);
			if (activity.text.trim()) {
				const prefix = this.theme.fg("accent", "▍ ");
				lines.push(
					"",
					`${prefix}${renderActivity(activity, width - visibleWidth(prefix), this.theme)}`,
				);
			}
			return lines;
		}
		if (agentFailed(this.agent)) {
			const errorLines = wrapTextWithAnsi(this.agent.error?.trim() || "Unknown error", width).map(
				(line) => this.theme.fg("error", line),
			);
			if (lines.length === 0) return errorLines;
			return [...lines, this.theme.fg("dim", "───"), ...errorLines];
		}
		if (lines.length === 0) return [this.theme.fg("dim", "(empty response)")];
		return lines;
	}

	private transcriptLines(width: number): string[] {
		const messages = transcriptMessages(this.agent);
		const toolIndex = indexToolMessages(messages);
		const lines: string[] = [];
		for (const message of messages) {
			const block = this.messageLines(message, width, toolIndex);
			if (block.length === 0) continue;
			if (lines.length > 0) lines.push(this.theme.fg("dim", "───"));
			lines.push(...block);
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	private messageLines(message: AgentMessage, width: number, toolIndex: ToolIndex): string[] {
		const th = this.theme;
		switch (message.role) {
			case "user":
			case "custom": {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.flatMap((part) => (part.type === "text" ? [part.text] : []))
								.join("\n");
				if (!text.trim()) return [];
				return [th.fg("accent", "[User]"), ...wrapTextWithAnsi(text.trim(), width)];
			}
			case "assistant": {
				const textLines: string[] = [];
				const toolLines: string[] = [];
				for (const part of message.content) {
					if (part.type === "text" && part.text.trim())
						textLines.push(
							...new Markdown(part.text.trim(), 0, 0, markdownThemeFromTheme(th)).render(width),
						);
					else if (part.type === "toolCall") {
						const call = part as ToolCallPart;
						toolLines.push(
							...renderToolCall(call, toolIndex.resultByCallId.get(call.id), width, th),
						);
					}
				}
				if (textLines.length === 0) return toolLines;
				return [th.bold("[Assistant]"), ...textLines, ...toolLines];
			}
			case "toolResult": {
				// The call renders its own result, so only an orphaned result needs a block here.
				if (toolIndex.callIds.has(message.toolCallId)) return [];
				return renderOrphanToolResult(
					message.toolName,
					{ content: message.content, details: message.details, isError: message.isError },
					width,
					th,
				);
			}
			case "bashExecution": {
				const lines = [th.fg("muted", `$ ${message.command}`)];
				const output = capTranscript(message.output);
				if (output)
					lines.push(...wrapTextWithAnsi(output, width).map((line) => th.fg("dim", line)));
				return lines;
			}
			default:
				return [];
		}
	}
}

const TRANSCRIPT_OUTPUT_CAP = 500;

export function transcriptMessages(agent: ViewableAgent): AgentMessage[] {
	return isRunningAgent(agent) ? agent.conversationMessages : agent.messages;
}

/** Cheap change detector for the streaming tail of a transcript. String lengths only. */
function messageContentLength(message: AgentMessage | undefined): number {
	if (!message) return 0;
	switch (message.role) {
		case "assistant":
			return message.content.reduce(
				(total, part) =>
					total +
					(part.type === "text"
						? part.text.length
						: part.type === "thinking"
							? part.thinking.length
							: JSON.stringify(part.arguments).length),
				0,
			);
		case "toolResult":
			return message.content.reduce(
				(total, part) => total + (part.type === "text" ? part.text.length : 1),
				0,
			);
		case "bashExecution":
			return message.command.length + message.output.length;
		case "user":
		case "custom":
			// A string's characters or an array's parts. Either count moves when the content moves.
			return message.content.length;
		default:
			return message.summary.length;
	}
}

function capTranscript(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= TRANSCRIPT_OUTPUT_CAP) return trimmed;
	return `${trimmed.slice(0, TRANSCRIPT_OUTPUT_CAP)}…`;
}

export function isRunningAgent(agent: ViewableAgent): agent is RunningAgent {
	return "status" in agent;
}

export function isLiveAgent(agent: ViewableAgent): agent is RunningAgent {
	return isRunningAgent(agent) && (agent.status === "starting" || agent.status === "running");
}

function isSteerableAgent(agent: ViewableAgent): agent is RunningAgent {
	return isLiveAgent(agent) || (isRunningAgent(agent) && agent.status === "idle");
}

function agentFailed(agent: ViewableAgent): boolean {
	return agent.error !== undefined || (!isRunningAgent(agent) && !agent.ok);
}

function dimMarkdownThemeFromTheme(theme: Theme): MarkdownTheme {
	const dim = (text: string) => theme.fg("dim", text);
	return {
		heading: (text) => theme.bold(dim(text)),
		link: (text) => theme.underline(dim(text)),
		linkUrl: dim,
		code: (text) => theme.fg("mdCode", text),
		codeBlock: dim,
		codeBlockBorder: dim,
		quote: dim,
		quoteBorder: dim,
		hr: dim,
		listBullet: dim,
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
	};
}

function markdownThemeFromTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
	};
}

function fitFooterSegments(theme: Theme, width: number, segments: string[]): string {
	const separator = ` ${theme.fg("dim", "·")} `;
	let start = 0;
	while (start < segments.length - 1) {
		const candidate = segments.slice(start).join(separator);
		if (visibleWidth(candidate) <= width) return candidate;
		start += 1;
	}
	return truncateToWidth(segments.at(-1) ?? "", width);
}
