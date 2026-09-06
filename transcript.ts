import { type Component, Text } from "@earendil-works/pi-tui";
import type {
	AgentCommandDetails,
	AgentCommandName,
	AgentEntryData,
	AgentMessage,
	AgentResultMessage,
	AttachedEntryData,
	DetachedEntryData,
	ExtensionAPI,
	ExtensionCommandContext,
	RebasedEntryData,
	RunningAgent,
} from "./shared.js";
import {
	ATTACHED_ENTRY_TYPE,
	contextLabel,
	DETACHED_ENTRY_TYPE,
	escapeAttribute,
	mainContextLabel,
	MESSAGE_TYPE,
	REBASED_ENTRY_TYPE,
} from "./shared.js";

export function reportCommandError(
	pi: ExtensionAPI,
	command: AgentCommandName,
	args: string,
	ctx: ExtensionCommandContext,
	message: string,
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, "error");
		return;
	}
	pi.sendMessage<AgentCommandDetails>({
		customType: MESSAGE_TYPE,
		content: formatCommandErrorMessage(command, args, message),
		display: true,
		details: {
			command,
			model: "",
			modelLabel: "",
			task: args.trim(),
			ok: false,
			error: message,
		},
	});
}

/**
 * Select the squashed role messages from a child transcript.
 *
 * @example selectSquashedMessages([{ role: "user", content: "hello", timestamp: 0 }]).length // 1
 */
type SquashedMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;

export function selectSquashedMessages(messages: readonly AgentMessage[]): SquashedMessage[] {
	const selected: SquashedMessage[] = [];
	let latestAssistant: Extract<AgentMessage, { role: "assistant" }> | undefined;
	for (const message of messages) {
		if (message.role === "assistant" && roleMessageText(message).trim()) {
			latestAssistant = message;
			continue;
		}
		if (message.role !== "user") continue;
		if (latestAssistant) selected.push(latestAssistant);
		latestAssistant = undefined;
		selected.push(message);
	}
	if (latestAssistant) selected.push(latestAssistant);
	return selected;
}

export function buildMessageDetails(agent: RunningAgent, ok: boolean): AgentCommandDetails {
	return {
		agentId: agent.id,
		command: agent.command,
		mainContextState: agent.mainContextState,
		inheritedContext: agent.inheritedContext,
		model: agent.model,
		modelLabel: agent.modelLabel,
		task: agent.task,
		ok,
		durationMs: (agent.completedAt ?? Date.now()) - agent.turnStartedAt,
		toolUses: agent.toolUses,
		turnCount: agent.turnCount,
		responseText: ok ? agent.responseText : undefined,
		error: ok ? undefined : agent.error,
	};
}

/** Build the canonical parent-session message used by immediate and late result delivery. */
export function buildAgentResultMessage(
	agent: RunningAgent,
	outcome: { ok: true; response: string } | { ok: false; error: string },
	options: { display: boolean },
): AgentResultMessage {
	return {
		customType: MESSAGE_TYPE,
		content: outcome.ok
			? formatResultMessage(agent)
			: formatErrorMessage(agent, outcome.error),
		display: options.display,
		details: buildMessageDetails(agent, outcome.ok),
	};
}

const SQUASHED_CONVERSATION_PREFACE =
	"The user has dispatched a background sub-agent with a task. The sub-agent is done. The following is the back and forth between them:";

export function formatResultMessage(agent: RunningAgent): string {
	const messages = selectSquashedMessages(agent.conversationMessages);
	const lines = [
		SQUASHED_CONVERSATION_PREFACE,
		`<user_agent model="${escapeAttribute(agent.model)}" inherited_context="${agent.inheritedContext}">`,
	];
	let firstUserMessage = true;
	for (const [index, message] of messages.entries()) {
		const tag = message.role === "user" ? "user_message" : "assistant_response";
		const content =
			message.role === "user" && firstUserMessage ? agent.task : roleMessageText(message);
		if (message.role === "user") firstUserMessage = false;
		lines.push(
			`  <${tag} i=${index + 1}>`,
			...content.split("\n").map((line) => `  ${line}`),
			`  </${tag}>`,
		);
	}
	lines.push("</user_agent>");
	return lines.join("\n");
}

function roleMessageText(message: SquashedMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
}

export function formatErrorMessage(agent: RunningAgent, message: string): string {
	return [
		`<user_agent_error command="/${agent.command}" model="${escapeAttribute(agent.model)}" inherited_context="${agent.inheritedContext}">`,
		...invocationLines(agent),
		"<task>",
		agent.task,
		"</task>",
		"<error>",
		message,
		"</error>",
		"<duration_ms>",
		String((agent.completedAt ?? Date.now()) - agent.turnStartedAt),
		"</duration_ms>",
		"</user_agent_error>",
	].join("\n");
}

function invocationLines(agent: RunningAgent): string[] {
	return ["<user_invocation>", agent.invocation, "</user_invocation>"];
}

export function formatCommandErrorMessage(
	command: AgentCommandName,
	args: string,
	message: string,
): string {
	return [
		`<user_agent_error command="/${command}">`,
		"<task>",
		args.trim(),
		"</task>",
		"<error>",
		message,
		"</error>",
		"</user_agent_error>",
	].join("\n");
}

export function formatStartNotification(agent: RunningAgent): string {
	return [
		`Started /${agent.command}`,
		agent.modelLabel,
		contextLabel(agent.inheritedContext),
		mainContextLabel(agent.mainContextState),
	]
		.filter(Boolean)
		.join(" · ");
}

export function registerUserAgentRenderer(pi: ExtensionAPI): void {
	const hiddenResult: Component = { render: () => [], invalidate: () => undefined };
	pi.registerMessageRenderer<AgentCommandDetails>(MESSAGE_TYPE, (message, _state, theme) => {
		const details = message.details;
		if (!details || details.agentId || details.inheritedContext !== undefined || details.ok)
			return hiddenResult;
		return new Text(theme.fg("error", `/${details.command}: ${details.error}`), 1, 0);
	});
	pi.registerEntryRenderer<AgentEntryData>(MESSAGE_TYPE, () => hiddenResult);
	// Pi's chat container does not pad renderer components; its own chat lines self-pad with paddingX 1.
	pi.registerEntryRenderer<DetachedEntryData>(DETACHED_ENTRY_TYPE, (entry, _state, theme) =>
		entry.data
			? new Text(theme.fg("dim", `Detached session ${entry.data.sessionId}`), 1, 0)
			: undefined,
	);
	pi.registerEntryRenderer<AttachedEntryData>(ATTACHED_ENTRY_TYPE, (entry, _state, theme) =>
		entry.data
			? new Text(theme.fg("dim", `Attached session ${entry.data.sessionId}`), 1, 0)
			: undefined,
	);
	pi.registerEntryRenderer<RebasedEntryData>(REBASED_ENTRY_TYPE, (entry, _state, theme) =>
		entry.data ? new Text(theme.fg("dim", formatRebasedLine(entry.data)), 1, 0) : undefined,
	);
}

function formatRebasedLine(data: RebasedEntryData): string {
	const base = `Rebased session ${data.sessionId} into this conversation`;
	if (!data.stats) return base;
	const parts = [
		`added ${data.stats.messageCount} message${data.stats.messageCount === 1 ? "" : "s"}`,
		`~${formatTokenCount(data.stats.tokenEstimate)} tokens`,
	];
	if (data.stats.compactionCount > 0)
		parts.push(
			`${data.stats.compactionCount} compaction event${data.stats.compactionCount === 1 ? "" : "s"}`,
		);
	return `${base} (${parts.join(", ")})`;
}

/**
 * @example formatTokenCount(135_264) // "135K"
 * @example formatTokenCount(12) // "12"
 */
function formatTokenCount(tokens: number): string {
	return tokens < 1000 ? `${tokens}` : `${Math.round(tokens / 1000)}K`;
}

