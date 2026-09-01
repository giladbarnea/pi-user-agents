import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type {
	AgentSession,
	buildSessionContext,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export type { AgentSession, ExtensionAPI, ExtensionCommandContext };

export type AgentMessage = ReturnType<typeof buildSessionContext>["messages"][number];
export type Model = NonNullable<ExtensionCommandContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export type Theme = ExtensionCommandContext["ui"]["theme"];
export type UIContext = ExtensionCommandContext["ui"];

export type AgentCommandName = "agent" | "agent-attach";
export type MainContextState = "separate" | "will-squash" | "squashed" | "rebased";
export type AgentStatus =
	| "starting"
	| "running"
	| "done-waiting-to-post"
	| "idle"
	| "posted"
	| "error";

export type ParsedAgentCommand = {
	isolate: boolean;
	squash: boolean;
	/** Leading pi CLI tokens (minus the extension's own options) to forward to the child, e.g. ["--thinking", "high"]. */
	forwardedArgs: string[];
	task: string;
	/** Advisory messages surfaced to the user (e.g. a recognized option was typed inside the prose body). */
	warnings: string[];
};

export type AgentEntryData = {
	content: string;
	details: AgentCommandDetails;
};

export type DetachedEntryData = {
	sessionId: string;
};

export type RebaseStats = {
	messageCount: number;
	tokenEstimate: number;
	compactionCount: number;
};

export type RebasedEntryData = {
	sessionId: string;
	/** Absent on entries persisted before stats existed. */
	stats?: RebaseStats;
};

/**
 * A child compaction captured from its compaction_end event. keptTailCount records how many
 * messages the compaction kept verbatim, so a rebase replay can restore the exact boundary.
 */
export type ChildCompactionMessage = Extract<AgentMessage, { role: "compactionSummary" }> & {
	keptTailCount?: number;
};

export type AgentResultMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: AgentCommandDetails;
};

export type AgentCommandDetails = {
	agentId?: string;
	command: AgentCommandName;
	mainContextState?: MainContextState;
	inheritedContext: boolean;
	model: string;
	modelLabel: string;
	task: string;
	ok: boolean;
	durationMs?: number;
	toolUses?: number;
	turnCount?: number;
	responseText?: string;
	/** Retained for completed entries written before responseText was persisted. */
	responsePreview?: string;
	error?: string;
};

export type RunningAgent = {
	id: string;
	/** The child's own Pi session, resumable with `/resume <sessionId>` after the agent is detached. */
	sessionId: string;
	command: AgentCommandName;
	inheritedContext: boolean;
	model: string;
	modelLabel: string;
	task: string;
	/** The slash command line as the user typed it, e.g. `/agent -s fix the bug`. */
	invocation: string;
	/** -s/--squash: post invocation+result to the main agent and trigger its turn, instead of waiting quietly for the next user prompt. */
	notifyMainAgent: boolean;
	/** Fingerprint of the main context the child was dispatched from ("[]" for -i); the rebase fast-forward base. */
	dispatchBaseFingerprint: string;
	mainContextState: MainContextState;
	status: AgentStatus;
	startedAt: number;
	/** Start of the current turn — equals startedAt until the user resumes an idle agent. */
	turnStartedAt: number;
	completedAt?: number;
	activeTools: Map<string, string>;
	toolUses: number;
	turnCount: number;
	responseText: string;
	/** Append-only child conversation, independent from model context compaction. */
	conversationMessages: AgentMessage[];
	latestFinalizedMessage?: AgentMessage;
	error?: string;
	session?: AgentSession;
	/** Latest completed turn's result message, deliverable to the main agent via the overlay's squash action. */
	pendingSquashMessage?: AgentResultMessage;
	/** Starts another turn on an idle agent; assigned while the lifecycle loop awaits the next instruction. */
	resume?: (instruction: string) => void;
	/** Ends an idle agent's lifecycle without another turn; assigned alongside resume. */
	retire?: () => void;
	finished: Promise<void>;
	/** Set when the user closes an in-flight agent from the widget — suppresses the error entry and transcript post. */
	aborted?: boolean;
	/** Set when the user interrupts only the active turn, leaving the child session alive. */
	interruptRequested?: boolean;
};

export type CompletedAgent = {
	id: string;
	sessionId: string;
	command: AgentCommandName;
	modelLabel: string;
	task: string;
	dispatchBaseFingerprint: string;
	mainContextState: MainContextState;
	pendingSquashMessage?: AgentResultMessage;
	ok: boolean;
	responseText: string;
	messages: AgentMessage[];
	error?: string;
	startedAt: number;
	durationMs: number;
	toolUses: number;
	turnCount: number;
	contextPercent?: number;
};

/** The mechanism that fast-forwards a child conversation onto the main session, injected into the widget. */
export type RebaseDelivery = {
	/** Whether the main session's live context still equals this agent's dispatch base. */
	canDeliver(agent: RunningAgent | CompletedAgent): boolean;
	/** Append the processed child conversation onto the main session. */
	deliver(agent: RunningAgent | CompletedAgent, messages: AgentMessage[]): void;
};

/** How long a confirmation stays armed, and how long a transient footer notice shows. */
export const CONFIRMATION_WINDOW_MS = 4000;

/**
 * A two-press confirmation with a timeout: the first press arms it, a repeat press on the
 * same target within the window confirms. A press on another target re-arms, cancel or
 * expiry disarms. One instance serves every confirmable action on a surface.
 */
export class TimedConfirmation<Target> {
	private armedOn: Target | undefined;
	private expiry: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly onExpire: () => void,
		private readonly windowMs: number = CONFIRMATION_WINDOW_MS,
	) {}

	/** One press of the action key: true means confirmed, false means armed and waiting. */
	press(target: Target): boolean {
		if (this.armedOn === target) {
			this.cancel();
			return true;
		}
		this.armedOn = target;
		if (this.expiry) clearTimeout(this.expiry);
		this.expiry = setTimeout(() => {
			this.armedOn = undefined;
			this.expiry = undefined;
			this.onExpire();
		}, this.windowMs);
		return false;
	}

	cancel(): void {
		this.armedOn = undefined;
		if (this.expiry) clearTimeout(this.expiry);
		this.expiry = undefined;
	}

	isArmedOn(target: Target): boolean {
		return this.armedOn !== undefined && this.armedOn === target;
	}
}

export const MESSAGE_TYPE = "pi-user-agents";
export const DETACHED_ENTRY_TYPE = "pi-user-agents-detached";
export const REBASED_ENTRY_TYPE = "pi-user-agents-rebased";
export const WIDGET_KEY = "pi-user-agents";
export const STEERING_LOG_PATH = `${tmpdir()}/pi-user-agents-steer.log`;

export function logSteering(
	agentId: string,
	event: string,
	details: Record<string, unknown> = {},
): void {
	void appendFile(
		STEERING_LOG_PATH,
		`${new Date().toISOString()} ${JSON.stringify({ agentId, event, ...details })}\n`,
	).catch(() => undefined);
}
export const MAX_WIDGET_LINES = 9;
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

export function formatModel(model: Model): string {
	return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`;
}

export function formatModelLabel(model: Model): string {
	return model.name && model.name !== model.id ? model.name : model.id;
}

export function contextLabel(inheritedContext: boolean): string {
	return inheritedContext ? "inherited context" : "isolated";
}

export function mainContextLabel(state: MainContextState | undefined): string | undefined {
	if (state === "will-squash") return "will squash into context";
	if (state === "squashed") return "squashed messages into context";
	if (state === "rebased") return "rebased into context";
	return undefined;
}

export function formatTurns(turnCount: number): string {
	return `↻${turnCount}`;
}

export function formatToolUses(toolUses: number): string {
	return `${toolUses} tool use${toolUses === 1 ? "" : "s"}`;
}

export function formatMs(ms: number): string {
	if (!Number.isFinite(ms)) return "0.0s";
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

export function truncatePlain(text: string, length: number): string {
	const line =
		text
			.split("\n")
			.find((part) => part.trim())
			?.trim() ?? "";
	if (line.length <= length) return line;
	return `${line.slice(0, Math.max(0, length - 1))}…`;
}

export function extractTag(
	content: string,
	tag: "task" | "response" | "error" | "duration_ms",
): string | undefined {
	const match = content.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`));
	return match?.[1]?.trim();
}

export function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
