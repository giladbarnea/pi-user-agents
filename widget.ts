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
import { selectRebaseMessages } from "./rebase.js";
import type {
	AgentResultMessage,
	CompletedAgent,
	RebaseDelivery,
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
	private detachConfirmationTarget: ViewableAgent | undefined;
	private readonly completedAgents: CompletedAgent[] = [];

	constructor(
		private readonly runningAgents: Set<RunningAgent>,
		private readonly sendSquashedResult: (message: AgentResultMessage) => void,
		private readonly announceDetached: (sessionId: string) => void,
		private readonly rebaseDelivery: RebaseDelivery,
	) {}

	setUI(ui: UIContext): void {
		if (ui === this.ui) return;
		this.inputUnsub?.();
		this.ui = ui;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.detachConfirmationTarget = undefined;
		this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
	}

	addCompleted(
		agent: RunningAgent,
		resultMessage: AgentResultMessage,
		options: { squashable: boolean },
	): void {
		this.completedAgents.push({
			id: agent.id,
			sessionId: agent.sessionId,
			command: agent.command,
			modelLabel: agent.modelLabel,
			task: agent.task,
			dispatchBaseFingerprint: agent.dispatchBaseFingerprint,
			mainContextState: agent.mainContextState,
			pendingSquashMessage: options.squashable ? resultMessage : undefined,
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
		this.detachConfirmationTarget = undefined;
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
		this.detachConfirmationTarget = undefined;
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
			this.detachConfirmationTarget = undefined;
			this.selectedIndex = Math.min(entries.length - 1, this.selectedIndex + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			this.detachConfirmationTarget = undefined;
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
			this.detachConfirmationTarget = undefined;
			this.interruptRunning(selected.agent);
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			this.detachConfirmationTarget = undefined;
			if (selected) this.openSelected(selected.agent);
			return { consume: true };
		}
		if (matchesKey(data, "d") && selected) {
			if (!this.confirmDetach(selected.agent)) return { consume: true };
			if (selected.kind === "running") this.closeRunning(selected.agent);
			else this.dismissCompleted(selected.agent);
			return { consume: true };
		}

		this.deactivate();
		return undefined;
	}

	private confirmDetach(target: ViewableAgent): boolean {
		if (this.detachConfirmationTarget === target) {
			this.detachConfirmationTarget = undefined;
			return true;
		}
		this.detachConfirmationTarget = target;
		this.update();
		return false;
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.detachConfirmationTarget = undefined;
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
						() => this.canSquashMainContext(agent.id),
						() => this.squashMainContext(agent.id),
						() => this.canRebaseMainContext(agent.id),
						() => this.rebaseMainContext(agent.id),
						() => this.rebaseBlockReason(agent.id),
						() => this.rebaseDetachCount(agent.id),
						() => {
							if (isRunningAgent(agent)) this.interruptRunning(agent);
						},
					),
				{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } },
			)
			.then(
				(action) => this.onViewerClosed(agent, action),
				() => this.onViewerClosed(agent, "hide"),
			);
	}

	/** Detaching ends the live session and leaves its session file on disk, untouched. */
	private closeRunning(agent: RunningAgent): void {
		agent.aborted = true;
		void agent.session?.abort();
		agent.retire?.();
		this.announceDetached(agent.sessionId);
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

	private canSquashMainContext(agentId: string): boolean {
		return this.deliverableAgent(agentId) !== undefined;
	}

	confirmMainContextSquash(agentId: string): boolean {
		const agents = [
			...[...this.runningAgents].filter((candidate) => candidate.id === agentId),
			...this.completedAgents.filter((candidate) => candidate.id === agentId),
		].filter((candidate) => candidate.mainContextState === "will-squash");
		if (agents.length === 0) return false;
		for (const agent of agents) agent.mainContextState = "squashed";
		this.update();
		return true;
	}

	private squashMainContext(agentId: string): void {
		const idleAgent = this.idleAgent(agentId);
		if (idleAgent) {
			this.squashIdleAgent(idleAgent);
			return;
		}
		const completedAgent = this.completedAgents.find((agent) => agent.id === agentId);
		const message = completedAgent?.pendingSquashMessage;
		if (!completedAgent || !message) return;

		completedAgent.pendingSquashMessage = undefined;
		completedAgent.mainContextState = "will-squash";
		message.details.mainContextState = "will-squash";
		this.sendSquashedResult(message);
		logSteering(agentId, "squashed-main-context", { display: message.display });
		this.update();
	}

	/** An agent whose latest turn result is still deliverable: idle live, or completed and squashable. */
	private deliverableAgent(agentId: string): RunningAgent | CompletedAgent | undefined {
		const idleAgent = this.idleAgent(agentId);
		if (idleAgent?.pendingSquashMessage) return idleAgent;
		return this.completedAgents.find(
			(agent) => agent.id === agentId && agent.pendingSquashMessage !== undefined,
		);
	}

	private canRebaseMainContext(agentId: string): boolean {
		return this.deliverableAgent(agentId) !== undefined && this.rebaseBlockReason(agentId) === undefined;
	}

	/** How many other agent sessions the rebase cascade would detach. */
	private rebaseDetachCount(agentId: string): number {
		return (
			[...this.runningAgents].filter((agent) => agent.id !== agentId).length +
			this.completedAgents.filter((agent) => agent.id !== agentId).length
		);
	}

	/** Why a deliverable result cannot rebase right now; undefined when it can, or when nothing is deliverable. */
	private rebaseBlockReason(agentId: string): string | undefined {
		const agent = this.deliverableAgent(agentId);
		if (!agent) return undefined;
		// The session switch tears the extension runtime down, which would abort a mid-turn sibling.
		if ([...this.runningAgents].some(isLiveAgent)) return "another agent is mid-turn";
		if (!this.rebaseDelivery.canDeliver(agent))
			return "the main session has drifted since dispatch";
		return undefined;
	}

	/** Fast-forward the raw child conversation onto the main session, then retire the agent. */
	private rebaseMainContext(agentId: string): void {
		if (!this.canRebaseMainContext(agentId)) return;
		const agent = this.deliverableAgent(agentId);
		if (!agent) return;
		// The reload will not preserve live rows; give every sibling its resumable-session breadcrumb.
		for (const other of [...this.runningAgents]) if (other !== agent) this.closeRunning(other);
		for (const other of [...this.completedAgents]) if (other !== agent) this.removeCompleted(other);
		const message = agent.pendingSquashMessage;
		this.rebaseDelivery.deliver(
			agent,
			selectRebaseMessages(agent.task, structuredClone(transcriptMessages(agent))),
		);
		agent.pendingSquashMessage = undefined;
		agent.mainContextState = "rebased";
		if (isRunningAgent(agent)) {
			agent.status = "posted";
			if (message) this.addCompleted(agent, message, { squashable: false });
			agent.retire?.();
		}
		logSteering(agentId, "rebased-main-context");
		this.update();
	}

	/** Squashing is one of the two terminal actions on a live idle agent: deliver the result, snapshot it, retire the session. */
	private squashIdleAgent(agent: RunningAgent): void {
		const message = agent.pendingSquashMessage;
		if (!message) return;
		agent.pendingSquashMessage = undefined;
		agent.mainContextState = "will-squash";
		message.details.mainContextState = "will-squash";
		agent.status = "posted";
		this.addCompleted(agent, message, { squashable: false });
		this.sendSquashedResult(message);
		agent.retire?.();
		logSteering(agent.id, "squashed-main-context", { display: message.display, live: true });
		this.update();
	}

	private onViewerClosed(agent: ViewableAgent, action: AgentViewerAction): void {
		this.viewerOpen = false;
		if (action === "detach" && isRunningAgent(agent) && this.runningAgents.has(agent)) {
			this.closeRunning(agent);
			return;
		}
		const completedAgent = this.completedAgents.find((candidate) => candidate.id === agent.id);
		if (action === "detach" && completedAgent) this.removeCompleted(completedAgent);
		else this.update();
	}

	private dismissCompleted(agent: CompletedAgent): void {
		this.removeCompleted(agent);
	}

	private removeCompleted(agent: CompletedAgent): void {
		const index = this.completedAgents.indexOf(agent);
		if (index >= 0) this.completedAgents.splice(index, 1);
		this.announceDetached(agent.sessionId);
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
			const confirmingDetach = this.detachConfirmationTarget === selected?.agent;
			const segments = [theme.fg("accent", "↑↓ select"), theme.fg("accent", "Enter view")];
			if (
				!confirmingDetach &&
				selected?.kind === "running" &&
				isLiveAgent(selected.agent)
			)
				segments.push(theme.fg("accent", "Ctrl+x interrupt"));
			segments.push(
				theme.fg(
					confirmingDetach ? "error" : "accent",
					confirmingDetach ? "d again to confirm" : "d detach",
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
