import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Text } from "@earendil-works/pi-tui";
import type {
	AgentCommandDetails,
	AgentCommandName,
	AgentEntryData,
	AgentResultMessage,
	ExtensionAPI,
	ExtensionCommandContext,
	RunningAgent,
	Theme,
} from "./shared.js";
import {
	contextLabel,
	escapeAttribute,
	extractTag,
	formatMs,
	formatToolUses,
	formatTurns,
	mainContextLabel,
	MESSAGE_TYPE,
	truncatePlain,
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
			inheritedContext: command === "agent",
			model: "",
			modelLabel: "",
			task: args.trim(),
			ok: false,
			error: message,
		},
	});
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
			? formatResultMessage(agent, outcome.response)
			: formatErrorMessage(agent, outcome.error),
		display: options.display,
		details: buildMessageDetails(agent, outcome.ok),
	};
}

export function formatResultMessage(agent: RunningAgent, response: string): string {
	return [
		`<user_agent command="/${agent.command}" model="${escapeAttribute(agent.model)}" inherited_context="${agent.inheritedContext}">`,
		...invocationLines(agent),
		"<task>",
		agent.task,
		"</task>",
		"<response>",
		response,
		"</response>",
		"<duration_ms>",
		String((agent.completedAt ?? Date.now()) - agent.turnStartedAt),
		"</duration_ms>",
		"</user_agent>",
	].join("\n");
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
	pi.registerMessageRenderer<AgentCommandDetails>(
		MESSAGE_TYPE,
		(message, { expanded }, theme) =>
			liveAgentCard(
				() => customMessageContentText(message.content),
				() => message.details,
				expanded,
				theme,
			),
	);
	pi.registerEntryRenderer<AgentEntryData>(
		MESSAGE_TYPE,
		(entry, { expanded }, theme) =>
			entry.data
				? liveAgentCard(
						() => entry.data!.content,
						() => entry.data!.details,
						expanded,
						theme,
					)
				: undefined,
	);
}

function liveAgentCard(
	content: () => string,
	details: () => AgentCommandDetails | undefined,
	expanded: boolean,
	theme: Theme,
): Component {
	const body = renderAgentCardBody(content(), details(), expanded, theme);
	return {
		render: (width) => renderAgentCard(content(), details(), body, theme).render(width),
		invalidate: () => body.invalidate(),
	};
}

function renderAgentCard(
	content: string,
	details: AgentCommandDetails | undefined,
	body: Component,
	theme: Theme,
): Container {
	const ok = details?.ok ?? !content.includes("<user_agent_error");
	const command = details ? `/${details.command}` : "/agent";
	const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const statusText = ok ? theme.fg("dim", "completed") : theme.fg("error", "failed");
	const parts = buildRendererParts(content, details);
	const task = details?.task ?? extractTag(content, "task");

	let text = `${icon} ${theme.bold(command)} ${statusText}`;
	if (parts.length > 0) text += ` ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}`;
	if (task) text += `\n  ${theme.fg("dim", `task: ${truncatePlain(task, 88)}`)}`;
	const card = new Container();
	card.addChild(new Text(text, 0, 0));
	card.addChild(body);
	return card;
}

function renderAgentCardBody(
	content: string,
	details: AgentCommandDetails | undefined,
	expanded: boolean,
	theme: Theme,
): Component {
	const ok = details?.ok ?? !content.includes("<user_agent_error");
	const output =
		details?.responseText ??
		details?.error ??
		extractTag(content, ok ? "response" : "error") ??
		"No output.";
	if (expanded)
		return ok
			? new Markdown(output, 2, 0, getMarkdownTheme())
			: new Text(theme.fg("error", output), 2, 0);

	const previewText = `⎿  ${truncatePlain(details?.responsePreview ?? output, 110)}`;
	if (!ok) return new Text(`  ${theme.fg("error", previewText)}`, 0, 0);
	return new Markdown(previewText, 2, 0, getMarkdownTheme(), {
		color: (value) => theme.fg("dim", value),
	});
}

function customMessageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function buildRendererParts(content: string, details: AgentCommandDetails | undefined): string[] {
	const parts: string[] = [];
	if (details?.modelLabel) parts.push(details.modelLabel);
	else if (details?.model) parts.push(details.model);
	if (details) parts.push(contextLabel(details.inheritedContext));
	const mainContext = mainContextLabel(details?.mainContextState);
	if (mainContext) parts.push(mainContext);
	if (details?.turnCount) parts.push(formatTurns(details.turnCount));
	if (details?.toolUses) parts.push(formatToolUses(details.toolUses));
	if (details?.durationMs !== undefined) parts.push(formatMs(details.durationMs));
	else {
		const duration = extractTag(content, "duration_ms");
		if (duration) parts.push(formatMs(Number(duration)));
	}
	return parts;
}
