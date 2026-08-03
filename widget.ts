import * as childProcess from "node:child_process";
import {
	type Component,
	Input,
	isKeyRelease,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import type {
	AgentMessage,
	AgentResultMessage,
	CompletedAgent,
	RunningAgent,
	Theme,
	UIContext,
} from "./shared.js";
import {
	describeToolCall,
	indexToolMessages,
	renderOrphanToolResult,
	renderToolCall,
	type ToolCallPart,
	type ToolIndex,
} from "./tool-render/index.js";
import {
	contextLabel,
	errorMessage,
	formatMs,
	formatToolUses,
	formatTurns,
	logSteering,
	MAX_WIDGET_LINES,
	SPINNER,
	truncatePlain,
	WIDGET_KEY,
} from "./shared.js";

type ViewableAgent = RunningAgent | CompletedAgent;
type AgentViewerAction = "hide" | "dispose";

type UserAgentWidgetEntry =
	| { kind: "running"; startedAt: number; agent: RunningAgent }
	| { kind: "completed"; startedAt: number; agent: CompletedAgent };

type ActivityDescription = {
	text: string;
	truncation: "middle" | "tail";
};

type AssistantContentPart = Extract<AgentMessage, { role: "assistant" }>["content"][number];

const ANSI_SEQUENCE_PATTERN = "\\x1b\\[[0-?]*[ -/]*[@-~]";
const LEADING_RENDERED_WHITESPACE = new RegExp(`^((?:${ANSI_SEQUENCE_PATTERN})*)\\s+`);
const TRAILING_RENDERED_WHITESPACE = new RegExp(`\\s+((?:${ANSI_SEQUENCE_PATTERN})*)$`);
const MIDDLE_TRUNCATION_PLACEHOLDER = "…";
const CONTEXT_METER_SYMBOLS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** @example renderContextMeter(100).includes("█") // true */
export function renderContextMeter(percent: number | null | undefined): string {
	if (percent === null || percent === undefined) return "";
	const boundedPercent = Math.max(0, Math.min(100, percent));
	const level = Math.min(
		CONTEXT_METER_SYMBOLS.length - 1,
		Math.floor(boundedPercent / (100 / CONTEXT_METER_SYMBOLS.length)),
	);
	const fadingChannel = Math.round(255 * (1 - level / (CONTEXT_METER_SYMBOLS.length - 1)));
	return `\x1b[38;2;255;${fadingChannel};${fadingChannel}m${CONTEXT_METER_SYMBOLS[level]}\x1b[39m`;
}

export class UserAgentWidget {
	private ui: UIContext | undefined;
	private frame = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private tui: { requestRender(): void } | undefined;
	private inputUnsub: (() => void) | undefined;
	private active = false;
	private selectedIndex = 0;
	private viewerOpen = false;
	private readonly completedAgents: CompletedAgent[] = [];

	constructor(
		private readonly runningAgents: Set<RunningAgent>,
		private readonly sendJoinedResult: (message: AgentResultMessage) => void,
	) {}

	setUI(ui: UIContext): void {
		if (ui === this.ui) return;
		this.inputUnsub?.();
		this.ui = ui;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
	}

	addCompleted(
		agent: RunningAgent,
		resultMessage: AgentResultMessage,
		options: { joinable: boolean },
	): void {
		this.completedAgents.push({
			id: agent.id,
			command: agent.command,
			modelLabel: agent.modelLabel,
			task: agent.task,
			pendingJoinMessage: options.joinable ? resultMessage : undefined,
			ok: resultMessage.details.ok,
			responseText: agent.responseText,
			messages: structuredClone(transcriptMessages(agent)),
			error: agent.error,
			startedAt: agent.startedAt,
			durationMs: (agent.completedAt ?? Date.now()) - agent.turnStartedAt,
			toolUses: agent.toolUses,
			turnCount: agent.turnCount,
			contextPercent: agent.session?.getContextUsage()?.percent ?? undefined,
		});
		this.update();
	}

	ensureTimer(): void {
		if (!this.ui || this.interval) return;
		this.interval = setInterval(() => this.update(), 100);
	}

	update(): void {
		if (!this.ui) return;
		const entries = this.entries();
		if (entries.length === 0) {
			this.clear();
			return;
		}

		this.frame += 1;
		this.clampSelection();
		if (!this.widgetRegistered) {
			this.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(width, theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
			return;
		}
		this.tui?.requestRender();
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		if (this.ui) this.ui.setWidget(WIDGET_KEY, undefined);
		this.ui = undefined;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.active = false;
	}

	private clear(): void {
		if (this.widgetRegistered) {
			this.ui?.setWidget(WIDGET_KEY, undefined);
			this.widgetRegistered = false;
			this.tui = undefined;
		}
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		this.active = false;
		this.selectedIndex = 0;
	}

	private runningAgentsForWidget(): RunningAgent[] {
		return [...this.runningAgents]
			.filter(
				(agent) =>
					agent.status === "starting" || agent.status === "running" || agent.status === "idle",
			)
			.sort((left, right) => left.startedAt - right.startedAt);
	}

	private completedAgentsForWidget(): CompletedAgent[] {
		return [...this.completedAgents].sort((left, right) => left.startedAt - right.startedAt);
	}

	private entries(): UserAgentWidgetEntry[] {
		return [
			...this.runningAgentsForWidget().map(
				(agent): UserAgentWidgetEntry => ({ kind: "running", startedAt: agent.startedAt, agent }),
			),
			...this.completedAgentsForWidget().map(
				(agent): UserAgentWidgetEntry => ({ kind: "completed", startedAt: agent.startedAt, agent }),
			),
		].sort((left, right) => left.startedAt - right.startedAt);
	}

	private handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.ui || isKeyRelease(data) || this.viewerOpen) return undefined;
		const entries = this.entries();
		if (entries.length === 0) return undefined;

		if (!this.active) {
			const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
			if (isActivator && this.ui.getEditorText() === "") {
				this.active = true;
				this.selectedIndex = 0;
				this.update();
				return { consume: true };
			}
			return undefined;
		}

		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(entries.length - 1, this.selectedIndex + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedIndex -= 1;
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}

		const selected = entries[this.selectedIndex];
		if (matchesKey(data, "enter")) {
			if (selected) this.openSelected(selected.agent);
			return { consume: true };
		}
		if (matchesKey(data, "x")) {
			if (selected?.kind === "running") this.closeRunning(selected.agent);
			else if (selected?.kind === "completed") this.dismissCompleted(selected.agent);
			return { consume: true };
		}

		this.deactivate();
		return undefined;
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.update();
	}

	private clampSelection(): void {
		const total = this.entries().length;
		if (total === 0) {
			this.active = false;
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.min(Math.max(0, this.selectedIndex), total - 1);
	}

	private openSelected(agent: ViewableAgent): void {
		if (!this.ui) return;
		const ui = this.ui;
		this.viewerOpen = true;
		void ui
			.custom<AgentViewerAction>(
				(tui, theme, _keybindings, done) =>
					new AgentViewer(
						tui,
						agent,
						theme,
						done,
						() => this.canJoinMainContext(agent.id),
						() => this.joinMainContext(agent.id),
					),
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" } },
			)
			.then(
				(action) => this.onViewerClosed(agent, action),
				() => this.onViewerClosed(agent, "hide"),
			);
	}

	private closeRunning(agent: RunningAgent): void {
		agent.aborted = true;
		void agent.session?.abort();
		agent.retire?.();
		this.update();
	}

	private idleAgent(agentId: string): RunningAgent | undefined {
		return [...this.runningAgents].find((agent) => agent.id === agentId && agent.status === "idle");
	}

	private canJoinMainContext(agentId: string): boolean {
		if (this.idleAgent(agentId)?.pendingJoinMessage) return true;
		return this.completedAgents.some(
			(agent) => agent.id === agentId && agent.pendingJoinMessage !== undefined,
		);
	}

	private joinMainContext(agentId: string): void {
		const idleAgent = this.idleAgent(agentId);
		if (idleAgent) {
			this.joinIdleAgent(idleAgent);
			return;
		}
		const completedAgent = this.completedAgents.find((agent) => agent.id === agentId);
		const message = completedAgent?.pendingJoinMessage;
		if (!completedAgent || !message) return;

		completedAgent.pendingJoinMessage = undefined;
		this.sendJoinedResult(message);
		logSteering(agentId, "joined-main-context", { display: message.display });
		this.update();
	}

	/** Joining is one of the two terminal actions on a live idle agent: deliver the result, snapshot it, retire the session. */
	private joinIdleAgent(agent: RunningAgent): void {
		const message = agent.pendingJoinMessage;
		if (!message) return;
		agent.pendingJoinMessage = undefined;
		agent.status = "posted";
		this.sendJoinedResult(message);
		this.addCompleted(agent, message, { joinable: false });
		agent.retire?.();
		logSteering(agent.id, "joined-main-context", { display: message.display, live: true });
		this.update();
	}

	private onViewerClosed(agent: ViewableAgent, action: AgentViewerAction): void {
		this.viewerOpen = false;
		if (action === "dispose" && isRunningAgent(agent) && this.runningAgents.has(agent)) {
			this.closeRunning(agent);
			return;
		}
		const completedAgent = this.completedAgents.find((candidate) => candidate.id === agent.id);
		if (action === "dispose" && completedAgent) this.removeCompleted(completedAgent);
		else this.update();
	}

	private dismissCompleted(agent: CompletedAgent): void {
		this.removeCompleted(agent);
	}

	private removeCompleted(agent: CompletedAgent): void {
		const index = this.completedAgents.indexOf(agent);
		if (index >= 0) this.completedAgents.splice(index, 1);
		const total = this.entries().length;
		if (total === 0) {
			this.deactivate();
			return;
		}
		this.selectedIndex = Math.min(this.selectedIndex, total - 1);
		this.update();
	}

	private renderWidget(width: number, theme: Theme): string[] {
		const entries = this.entries();
		if (entries.length === 0) return [];

		const anyRunning = entries.some(
			(entry) => entry.kind === "running" && isLiveAgent(entry.agent),
		);
		const anyError = this.completedAgents.some((agent) => !agent.ok);
		const headingColor = anyRunning ? "accent" : anyError ? "error" : "success";
		const headingGlyph = anyRunning ? "●" : anyError ? "✗" : "✓";
		const lines = [
			truncateToWidth(
				`${theme.fg(headingColor, headingGlyph)} ${theme.fg(headingColor, "User agents")}`,
				width,
			),
		];
		let hint: string;
		if (!this.active) hint = "←/↓ select agent";
		else hint = "↑↓ select · Enter view · x dispose · Esc back";
		lines.push(truncateToWidth(`  ${theme.fg(this.active ? "accent" : "dim", hint)}`, width));

		const maxEntries = Math.max(1, Math.floor((MAX_WIDGET_LINES - lines.length) / 2));
		const start = this.active
			? clampWindowStart(this.selectedIndex, maxEntries, entries.length)
			: 0;
		const renderedEntries = entries.slice(start, start + maxEntries);
		for (const [visibleIndex, entry] of renderedEntries.entries()) {
			const entryIndex = start + visibleIndex;
			const isLastVisible = entryIndex === entries.length - 1;
			const connector = isLastVisible ? "└─" : "├─";
			const indent = isLastVisible ? "  " : "│ ";
			const selected = this.active && entryIndex === this.selectedIndex;
			lines.push(...this.renderAgentEntry(entry.agent, connector, indent, selected, width, theme));
		}

		const hiddenCount = entries.length - (start + renderedEntries.length);
		if (hiddenCount > 0) {
			lines.push(
				truncateToWidth(
					`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenCount} more`)}`,
					width,
				),
			);
		}
		return lines.slice(0, MAX_WIDGET_LINES);
	}

	private renderAgentEntry(
		agent: ViewableAgent,
		connector: string,
		indent: string,
		selected: boolean,
		width: number,
		theme: Theme,
	): string[] {
		const running = isRunningAgent(agent);
		const inFlight = isLiveAgent(agent);
		const ok = running ? agent.error === undefined : agent.ok;
		const marker = selected ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
		const icon = inFlight
			? theme.fg("accent", SPINNER[this.frame % SPINNER.length])
			: ok
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
		const parts = inFlight
			? [agent.modelLabel, contextLabel(agent.inheritedContext)]
			: [agent.modelLabel];
		if (agent.turnCount > 0) parts.push(formatTurns(agent.turnCount));
		if (agent.toolUses > 0) parts.push(formatToolUses(agent.toolUses));
		parts.push(
			formatMs(
				running ? (agent.completedAt ?? Date.now()) - agent.turnStartedAt : agent.durationMs,
			),
		);

		const header = [
			theme.fg("dim", connector),
			marker,
			icon,
			theme.bold(`/${agent.command}`),
			renderContextMeter(
				running ? agent.session?.getContextUsage()?.percent : agent.contextPercent,
			),
			theme.fg("muted", truncatePlain(agent.task, 52)),
			theme.fg("dim", "·"),
			theme.fg("dim", parts.join(" · ")),
		]
			.filter(Boolean)
			.join(" ");
		const activityPrefix = `${indent}   ⎿  `;
		const activityWidth = Math.max(0, width - visibleWidth(activityPrefix));
		const description = running
			? describeActivity(agent)
			: {
					text: agent.ok ? agent.responseText : `Error: ${agent.error ?? "unknown"}`,
					truncation: "tail" as const,
				};
		const preview = renderActivity(description, activityWidth, theme);
		const activityText = ok ? preview : theme.fg("error", preview);
		const activity = `${theme.fg("dim", indent)}   ${theme.fg("dim", "⎿  ")}${activityText}`;
		return [truncateToWidth(header, width), truncateToWidth(activity, width)];
	}
}

function describeActivity(agent: RunningAgent): ActivityDescription {
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

function renderActivity(description: ActivityDescription, width: number, theme: Theme): string {
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
const VIEWER_HEIGHT_PCT = 70;

/** Focus-capturing overlay that shows an agent's live or finished response. */
class AgentViewer implements Component {
	private scrollOffset = 0;
	private autoScroll = true;
	private lastWidth = 0;
	private justCopied = false;
	private composer: Input | undefined;
	/** Rich tool rendering is far too costly to repeat on every 100 ms widget tick. */
	private renderedContent: { key: string; lines: string[] } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly agent: ViewableAgent,
		private readonly theme: Theme,
		private readonly done: (result: AgentViewerAction) => void,
		private readonly canJoinMainContext: () => boolean,
		private readonly joinMainContext: () => void,
	) {}

	handleInput(data: string): void {
		if (this.composer) {
			this.composer.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done("hide");
			return;
		}
		if (matchesKey(data, "x") && !isLiveAgent(this.agent)) {
			this.done("dispose");
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
		if (matchesKey(data, "j") && this.canJoinMainContext()) {
			this.joinMainContext();
			this.tui.requestRender();
			return;
		}
		const viewport = this.viewportHeight();
		const maxScroll = Math.max(
			0,
			this.contentLines(this.innerWidth(this.lastWidth)).length - viewport,
		);
		if (matchesKey(data, "up") || matchesKey(data, "k"))
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (matchesKey(data, "down"))
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
		const meta = `${this.agent.modelLabel} · ${status} · ${stats.join(" · ")}`;
		lines.push(
			row(
				`${icon} ${th.bold(`/${this.agent.command}`)}  ${th.fg("muted", truncatePlain(this.agent.task, 60))} ${th.fg("dim", "·")} ${th.fg("dim", meta)}`,
			),
		);
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
		} else {
			const scrollPct =
				content.length <= viewport
					? "100%"
					: `${Math.round(((this.scrollOffset + viewport) / content.length) * 100)}%`;
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
					this.canJoinMainContext() ? th.fg("dim", "j join") : "",
					th.fg("dim", isLiveAgent(this.agent) ? "Esc hide" : "x dispose"),
				].filter(Boolean),
			);
			lines.push(row(footer));
		}
		lines.push(hrBot);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {}

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
			const activity = describeActivity(this.agent).text.replace(/\s+/g, " ").trim();
			if (activity)
				lines.push(
					"",
					truncateToWidth(
						`${this.theme.fg("accent", "▍ ")}${this.theme.fg("dim", activity)}`,
						width,
					),
				);
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

function transcriptMessages(agent: ViewableAgent): AgentMessage[] {
	if (isRunningAgent(agent))
		return agent.session?.agent.state.messages.slice(agent.inheritedMessageCount) ?? [];
	return agent.messages;
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

function isRunningAgent(agent: ViewableAgent): agent is RunningAgent {
	return "status" in agent;
}

function isLiveAgent(agent: ViewableAgent): agent is RunningAgent {
	return isRunningAgent(agent) && (agent.status === "starting" || agent.status === "running");
}

function isSteerableAgent(agent: ViewableAgent): agent is RunningAgent {
	return isLiveAgent(agent) || (isRunningAgent(agent) && agent.status === "idle");
}

function agentFailed(agent: ViewableAgent): boolean {
	return agent.error !== undefined || (!isRunningAgent(agent) && !agent.ok);
}

function clampWindowStart(selected: number, visibleCount: number, total: number): number {
	if (total <= visibleCount) return 0;
	const half = Math.floor(visibleCount / 2);
	return Math.min(Math.max(0, selected - half), total - visibleCount);
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
