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

export type AgentCommandName = "agent" | "agent-isolated";
export type MainContextState = "separate" | "will-join" | "joined";
export type AgentStatus =
	| "starting"
	| "running"
	| "done-waiting-to-post"
	| "idle"
	| "posted"
	| "error";

export type ParsedAgentCommand = {
	isolate: boolean;
	context: boolean;
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
	command: AgentCommandName;
	inheritedContext: boolean;
	model: string;
	modelLabel: string;
	task: string;
	/** The slash command line as the user typed it, e.g. `/agent -j fix the bug`. */
	invocation: string;
	/** -j/--join: post invocation+result to the main agent and trigger its turn, instead of waiting quietly for the next user prompt. */
	notifyMainAgent: boolean;
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
	/** How many messages at the head of the child session were cloned from the parent — the transcript viewer skips them. */
	inheritedMessageCount: number;
	latestFinalizedMessage?: AgentMessage;
	error?: string;
	session?: AgentSession;
	/** Latest completed turn's result message, deliverable to the main agent via the overlay's join action. */
	pendingJoinMessage?: AgentResultMessage;
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
	command: AgentCommandName;
	modelLabel: string;
	task: string;
	mainContextState: MainContextState;
	pendingJoinMessage?: AgentResultMessage;
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

export const MESSAGE_TYPE = "pi-user-agents";
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
	if (state === "will-join") return "will join context";
	if (state === "joined") return "joined context";
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
