import {
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	AgentViewer,
	type AgentViewerAction,
	describeActivity,
	isLiveAgent,
	isRunningAgent,
	renderActivity,
	transcriptMessages,
	type ViewableAgent,
} from "./agent-viewer.js";
import { renderAgentContextMeter } from "./context-meter.js";
import type {
	AgentResultMessage,
	CompletedAgent,
	RunningAgent,
	Theme,
	UIContext,
} from "./shared.js";
import {
	contextLabel,
	formatMs,
	formatToolUses,
	formatTurns,
	logSteering,
	mainContextLabel,
	MAX_WIDGET_LINES,
	SPINNER,
	truncatePlain,
	WIDGET_KEY,
} from "./shared.js";

type UserAgentWidgetEntry =
	| { kind: "running"; startedAt: number; agent: RunningAgent }
	| { kind: "completed"; startedAt: number; agent: CompletedAgent };

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
	private disposeConfirmationTarget: ViewableAgent | undefined;
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
		this.disposeConfirmationTarget = undefined;
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
			mainContextState: agent.mainContextState,
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
		this.disposeConfirmationTarget = undefined;
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
		this.disposeConfirmationTarget = undefined;
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
			this.disposeConfirmationTarget = undefined;
			this.selectedIndex = Math.min(entries.length - 1, this.selectedIndex + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			this.disposeConfirmationTarget = undefined;
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
		if (
			matchesKey(data, "ctrl+x") &&
			selected?.kind === "running" &&
			isLiveAgent(selected.agent)
		) {
			this.disposeConfirmationTarget = undefined;
			this.interruptRunning(selected.agent);
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			this.disposeConfirmationTarget = undefined;
			if (selected) this.openSelected(selected.agent);
			return { consume: true };
		}
		if (matchesKey(data, "x") && selected) {
			if (!this.confirmDispose(selected.agent)) return { consume: true };
			if (selected.kind === "running") this.closeRunning(selected.agent);
			else this.dismissCompleted(selected.agent);
			return { consume: true };
		}

		this.deactivate();
		return undefined;
	}

	private confirmDispose(target: ViewableAgent): boolean {
		if (this.disposeConfirmationTarget === target) {
			this.disposeConfirmationTarget = undefined;
			return true;
		}
		this.disposeConfirmationTarget = target;
		this.update();
		return false;
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.disposeConfirmationTarget = undefined;
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
						() => {
							if (isRunningAgent(agent)) this.interruptRunning(agent);
						},
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

	private interruptRunning(agent: RunningAgent): void {
		agent.interruptRequested = true;
		void agent.session?.abort();
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

	confirmMainContextJoin(agentId: string): boolean {
		const agents = [
			...[...this.runningAgents].filter((candidate) => candidate.id === agentId),
			...this.completedAgents.filter((candidate) => candidate.id === agentId),
		].filter((candidate) => candidate.mainContextState === "will-join");
		if (agents.length === 0) return false;
		for (const agent of agents) agent.mainContextState = "joined";
		this.update();
		return true;
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
		completedAgent.mainContextState = "will-join";
		message.details.mainContextState = "will-join";
		this.sendJoinedResult(message);
		logSteering(agentId, "joined-main-context", { display: message.display });
		this.update();
	}

	/** Joining is one of the two terminal actions on a live idle agent: deliver the result, snapshot it, retire the session. */
	private joinIdleAgent(agent: RunningAgent): void {
		const message = agent.pendingJoinMessage;
		if (!message) return;
		agent.pendingJoinMessage = undefined;
		agent.mainContextState = "will-join";
		message.details.mainContextState = "will-join";
		agent.status = "posted";
		this.addCompleted(agent, message, { joinable: false });
		this.sendJoinedResult(message);
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
		if (!this.active) {
			lines.push(truncateToWidth(`  ${theme.fg("dim", "←/↓ select agent")}`, width));
		} else {
			const selected = entries[this.selectedIndex];
			const confirmingDispose = this.disposeConfirmationTarget === selected?.agent;
			const segments = [theme.fg("accent", "↑↓ select"), theme.fg("accent", "Enter view")];
			if (
				!confirmingDispose &&
				selected?.kind === "running" &&
				isLiveAgent(selected.agent)
			)
				segments.push(theme.fg("accent", "Ctrl+x interrupt"));
			segments.push(
				theme.fg(
					confirmingDispose ? "error" : "accent",
					confirmingDispose ? "x again to confirm" : "x dispose",
				),
				theme.fg("accent", "Esc back"),
			);
			lines.push(
				truncateToWidth(`  ${segments.join(theme.fg("accent", " · "))}`, width),
			);
		}

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
		const mainContext = mainContextLabel(agent.mainContextState);
		if (mainContext) parts.push(mainContext);
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
			renderAgentContextMeter(agent, theme),
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

function clampWindowStart(selected: number, visibleCount: number, total: number): number {
	if (total <= visibleCount) return 0;
	const half = Math.floor(visibleCount / 2);
	return Math.min(Math.max(0, selected - half), total - visibleCount);
}
