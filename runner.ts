import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentSessionEvent,
	type AgentSessionServices,
	type Args,
	buildSessionContext,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
	parseArgs,
	resolveCliModel,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AgentValueValidator, parseAgentCommand } from "./command-line.js";
import type {
	AgentCommandName,
	AgentMessage,
	AgentResultMessage,
	AgentSession,
	ExtensionAPI,
	ExtensionCommandContext,
	Model,
	ParsedAgentCommand,
	RunningAgent,
	ThinkingLevel,
} from "./shared.js";
import { errorMessage, formatModel, formatModelLabel, logSteering } from "./shared.js";
import {
	buildAgentResultMessage,
	formatStartNotification,
	reportCommandError,
} from "./transcript.js";
import type { UserAgentWidget } from "./widget.js";

export { parseAgentCommand };

export async function handleAgentCommand(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	isShuttingDown: () => boolean,
	nextAgentNumber: () => number,
	command: AgentCommandName,
	args: string,
	invocation: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		await startUserAgent(
			pi,
			runningAgents,
			widget,
			isShuttingDown,
			nextAgentNumber,
			command,
			args,
			invocation,
			ctx,
		);
	} catch (error) {
		reportCommandError(pi, command, args, ctx, errorMessage(error));
	}
}

async function startUserAgent(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	isShuttingDown: () => boolean,
	nextAgentNumber: () => number,
	command: AgentCommandName,
	args: string,
	invocation: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parsed = parseAgentCommand(args, command);
	const parsedForwardedArgs = parseForwardedArgs(parsed.forwardedArgs);
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const services = await createAgentSessionServices({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		modelRuntime: (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime,
		resourceLoaderOptions: buildChildResourceLoaderOptions(parsedForwardedArgs, ctx.cwd),
	});
	const forwarded = resolveForwardedOptions(parsedForwardedArgs, services.modelRuntime);
	const selectedModel = forwarded.model ?? ctx.model;
	if (!selectedModel) throw new Error("No current model is selected; pass -m MODELNAME");
	const model =
		services.modelRuntime.getModel(selectedModel.provider, selectedModel.id) ?? selectedModel;
	const thinkingLevel = forwarded.thinkingLevel ?? pi.getThinkingLevel();
	const inheritedMessages = parsed.isolate ? [] : buildInheritedMessages(ctx);
	const runningAgent = createRunningAgent(nextAgentNumber(), command, model, parsed, invocation);

	runningAgents.add(runningAgent);
	logSteering(runningAgent.id, "agent-created", { command, taskLength: parsed.task.length });
	if (ctx.hasUI) {
		widget.setUI(ctx.ui);
		for (const warning of parsed.warnings) ctx.ui.notify(warning, "warning");
		ctx.ui.notify(formatStartNotification(runningAgent), "info");
		widget.ensureTimer();
		widget.update();
	}

	runningAgent.finished = runAgentLifecycle(
		pi,
		isShuttingDown,
		parsed.task,
		model,
		thinkingLevel,
		forwarded,
		inheritedMessages,
		services,
		runningAgent,
		widget,
	).finally(() => {
		logSteering(runningAgent.id, "agent-disposed", { status: runningAgent.status });
		runningAgent.session?.dispose();
		runningAgents.delete(runningAgent);
		widget.update();
	});
}

function createRunningAgent(
	sequenceNumber: number,
	command: AgentCommandName,
	model: Model,
	parsed: ParsedAgentCommand,
	invocation: string,
): RunningAgent {
	return {
		id: `user-${sequenceNumber.toString(36)}`,
		command,
		inheritedContext: !parsed.isolate,
		model: formatModel(model),
		modelLabel: formatModelLabel(model),
		task: parsed.task,
		invocation,
		notifyMainAgent: parsed.context,
		mainContextState: parsed.context ? "will-join" : "separate",
		status: "starting",
		startedAt: Date.now(),
		turnStartedAt: Date.now(),
		activeTools: new Map(),
		toolUses: 0,
		turnCount: 0,
		responseText: "",
		inheritedMessageCount: 0,
		finished: Promise.resolve(),
	};
}

function postUserAgentResult(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	notifyMainAgent: boolean,
	message: AgentResultMessage,
): boolean {
	if (isShuttingDown()) return false;
	if (notifyMainAgent) {
		// Steers into a streaming turn, or triggers an immediate response when idle.
		pi.sendMessage(message, { triggerTurn: true });
	} else {
		// TUI-only session entry: renders in the transcript but never enters the main agent's context.
		pi.appendEntry(message.customType, { content: message.content, details: message.details });
	}
	return true;
}

/** Session inputs derived from forwarded pi CLI options, ready to hand to the child session. */
type ChildResourceLoaderOptions = {
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
};

type ForwardedOptions = {
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	noTools?: "all" | "builtin";
};

/** Parse forwarded pi CLI tokens once before model and session resolution. */
export function parseForwardedArgs(forwardedArgs: string[]): Args {
	const parsed = parseArgs(forwardedArgs);
	const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
	return parsed;
}

/**
 * Build editor value validation from the same Pi parser, model resolver, and live catalogs
 * used at submission and session creation.
 */
export function createAgentValueValidator(
	modelRuntime: ModelRuntime,
	getToolNames: () => Iterable<string>,
): AgentValueValidator {
	return (option, value, scan) => {
		if (option.completionDomain === "thinking") {
			return !parseArgs(["--thinking", value]).diagnostics.some(
				(diagnostic) => diagnostic.type === "warning",
			);
		}
		if (option.completionDomain === "provider") {
			return modelRuntime
				.getModels()
				.some((model) => model.provider.toLowerCase() === value.toLowerCase());
		}
		if (option.completionDomain === "tool") {
			const parsed = parseArgs([option.names[0]!, value]);
			const requestedNames = option.semanticId === "tools" ? parsed.tools : parsed.excludeTools;
			const knownNames = new Set(getToolNames());
			return (requestedNames ?? []).every((name) => knownNames.has(name));
		}
		if (option.completionDomain !== "model") return true;
		const parsed = parseArgs(scan.forwardedArgs);
		try {
			resolveForwardedOptions({ ...parsed, model: value }, modelRuntime);
			return true;
		} catch {
			return false;
		}
	};
}

/** Resolve forwarded runtime options against the child session's model runtime. */
export function resolveForwardedOptions(
	parsed: Args,
	modelRuntime: ModelRuntime,
): ForwardedOptions {
	const forwarded: ForwardedOptions = {};
	if (parsed.model) {
		const nameMatch = modelRuntime
			.getModels()
			.find((m) => m.name?.toLowerCase() === parsed.model!.toLowerCase());
		if (nameMatch) {
			forwarded.model = nameMatch;
		} else {
			const resolved = resolveCliModel({
				cliProvider: parsed.provider,
				cliModel: parsed.model,
				cliThinking: parsed.thinking,
				modelRuntime,
			});
			if (resolved.error) throw new Error(resolved.error);
			forwarded.model = resolved.model;
			if (!parsed.thinking && resolved.thinkingLevel)
				forwarded.thinkingLevel = resolved.thinkingLevel;
		}
	}
	if (parsed.thinking) forwarded.thinkingLevel = parsed.thinking;

	if (parsed.noTools) forwarded.noTools = "all";
	else if (parsed.noBuiltinTools) forwarded.noTools = "builtin";
	if (parsed.tools) forwarded.tools = parsed.tools;
	if (parsed.excludeTools) forwarded.excludeTools = parsed.excludeTools;
	return forwarded;
}

export function buildChildResourceLoaderOptions(
	parsed: Args,
	cwd: string,
): ChildResourceLoaderOptions | undefined {
	const options: ChildResourceLoaderOptions = {};
	if (parsed.systemPrompt !== undefined) options.systemPrompt = parsed.systemPrompt;
	if (parsed.appendSystemPrompt) options.appendSystemPrompt = parsed.appendSystemPrompt;
	if (parsed.extensions)
		options.additionalExtensionPaths = resolveResourcePaths(parsed.extensions, cwd);
	if (parsed.skills) options.additionalSkillPaths = resolveResourcePaths(parsed.skills, cwd);
	if (parsed.promptTemplates)
		options.additionalPromptTemplatePaths = resolveResourcePaths(parsed.promptTemplates, cwd);
	if (parsed.noExtensions) options.noExtensions = true;
	if (parsed.noSkills) options.noSkills = true;
	if (parsed.noPromptTemplates) options.noPromptTemplates = true;
	if (parsed.noThemes) options.noThemes = true;
	if (parsed.noContextFiles) options.noContextFiles = true;
	return Object.keys(options).length > 0 ? options : undefined;
}

/** Resolve resource paths to absolute against the session cwd, matching how the CLI hands them to the loader. */
function resolveResourcePaths(values: string[], cwd: string): string[] {
	return values.map((value) => {
		if (value === "~" || value.startsWith("~/")) return path.join(os.homedir(), value.slice(1));
		return path.isAbsolute(value) ? value : path.resolve(cwd, value);
	});
}

function buildInheritedMessages(ctx: ExtensionCommandContext): AgentMessage[] {
	return structuredClone(buildSessionContext(ctx.sessionManager.getBranch()).messages);
}

async function runAgentLifecycle(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	task: string,
	model: Model,
	thinkingLevel: ThinkingLevel,
	forwarded: ForwardedOptions,
	inheritedMessages: AgentMessage[],
	services: AgentSessionServices,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): Promise<void> {
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		session = await createChildSession(
			model,
			thinkingLevel,
			forwarded,
			inheritedMessages,
			services,
			runningAgent,
			widget,
		);
		unsubscribe = subscribeToChildSession(session, runningAgent, widget);
		await runChildTurns(pi, isShuttingDown, task, session, runningAgent, widget);
	} catch (error) {
		if (runningAgent.aborted) {
			logSteering(runningAgent.id, "agent-aborted");
			return;
		}
		const message = errorMessage(error);
		logSteering(runningAgent.id, "agent-error", { error: message });
		runningAgent.status = "error";
		runningAgent.completedAt = Date.now();
		runningAgent.error = message;
		if (runningAgent.notifyMainAgent && isShuttingDown()) {
			runningAgent.mainContextState = "separate";
			return;
		}
		const resultMessage = buildAgentResultMessage(
			runningAgent,
			{ ok: false, error: message },
			{ display: runningAgent.notifyMainAgent },
		);
		widget.addCompleted(runningAgent, resultMessage, { joinable: !runningAgent.notifyMainAgent });
		if (postUserAgentResult(pi, isShuttingDown, runningAgent.notifyMainAgent, resultMessage))
			runningAgent.status = "posted";
	} finally {
		unsubscribe?.();
		if (session) {
			logSteering(runningAgent.id, "session-shutdown", { streaming: session.isStreaming });
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}
	}
}

/** Run turns on an initialized child session until it posts, retires, or shuts down. */
export async function runChildTurns(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	task: string,
	session: AgentSession,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): Promise<void> {
	let instruction = `You are running in an ephemeral, forked background process now, concurrently with the main session. ${task}`;
	while (true) {
		const turnMessageStart = session.agent.state.messages.length;
		if (!runningAgent.interruptRequested) {
			logSteering(runningAgent.id, "turn-prompt-started", {
				streaming: session.isStreaming,
				instructionLength: instruction.length,
			});
			await session.prompt(instruction);
		}
		if (runningAgent.interruptRequested) {
			const response = interruptedTurnResponse(session, turnMessageStart);
			runningAgent.interruptRequested = false;
			runningAgent.mainContextState = "separate";
			runningAgent.status = "done-waiting-to-post";
			runningAgent.completedAt = Date.now();
			runningAgent.responseText = response;
			const resultMessage = buildAgentResultMessage(
				runningAgent,
				{ ok: true, response },
				{ display: false },
			);
			postUserAgentResult(pi, isShuttingDown, false, resultMessage);
			runningAgent.pendingJoinMessage = runningAgent.notifyMainAgent
				? undefined
				: resultMessage;
			if (isShuttingDown()) return;
			runningAgent.status = "idle";
			logSteering(runningAgent.id, "turn-interrupted", { turnCount: runningAgent.turnCount });
			widget.update();
			const next = await waitForInstruction(runningAgent, widget);
			if (next === undefined) return;
			instruction = next;
			continue;
		}

		const response = getFinalAssistantText(session);
		logSteering(runningAgent.id, "turn-prompt-resolved", {
			responseLength: response.length,
			messageCount: session.agent.state.messages.length,
		});
		runningAgent.status = "done-waiting-to-post";
		runningAgent.completedAt = Date.now();
		runningAgent.responseText = response;
		const resultMessage = buildAgentResultMessage(
			runningAgent,
			{ ok: true, response },
			{ display: runningAgent.notifyMainAgent },
		);
		if (runningAgent.notifyMainAgent) {
			if (isShuttingDown()) {
				runningAgent.mainContextState = "separate";
				resultMessage.details.mainContextState = "separate";
				return;
			}
			widget.addCompleted(runningAgent, resultMessage, { joinable: false });
			const posted = postUserAgentResult(pi, isShuttingDown, true, resultMessage);
			runningAgent.status = posted ? "posted" : runningAgent.status;
			return;
		}
		postUserAgentResult(pi, isShuttingDown, false, resultMessage);
		runningAgent.pendingJoinMessage = resultMessage;
		if (isShuttingDown()) return;
		runningAgent.status = "idle";
		logSteering(runningAgent.id, "agent-idle", { turnCount: runningAgent.turnCount });
		widget.update();
		const next = await waitForInstruction(runningAgent, widget);
		if (next === undefined) return;
		instruction = next;
	}
}

function interruptedTurnResponse(session: AgentSession, turnMessageStart: number): string {
	const assistantMessages = session.agent.state.messages
		.slice(turnMessageStart)
		.filter((message) => message.role === "assistant");
	const lastAssistantMessage = assistantMessages.at(-1);
	const partialResponse = lastAssistantMessage ? assistantText(lastAssistantMessage).trim() : "";
	if (!partialResponse) return "Interrupted by user.";
	return `Interrupted by user.\n\n${partialResponse}`;
}

async function createChildSession(
	model: Model,
	thinkingLevel: ThinkingLevel,
	forwarded: ForwardedOptions,
	inheritedMessages: AgentMessage[],
	services: AgentSessionServices,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): Promise<AgentSession> {
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(services.cwd),
		model,
		thinkingLevel,
		tools: forwarded.tools,
		excludeTools: forwarded.excludeTools,
		noTools: forwarded.noTools,
	});

	runningAgent.session = session;
	runningAgent.status = "running";
	logSteering(runningAgent.id, "session-created", { streaming: session.isStreaming });
	if (runningAgent.aborted) void session.abort();
	widget.update();

	await session.bindExtensions({ mode: "print" });
	logSteering(runningAgent.id, "session-bound", { streaming: session.isStreaming });
	if (inheritedMessages.length > 0) {
		session.agent.state.messages = inheritedMessages;
		runningAgent.inheritedMessageCount = inheritedMessages.length;
		logSteering(runningAgent.id, "context-inherited", { messageCount: inheritedMessages.length });
	}
	return session;
}

/** Parks an idle agent until the user resumes it with another instruction (resolves with it) or retires it (resolves undefined). */
export function waitForInstruction(
	agent: RunningAgent,
	widget: { update(): void },
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const settle = (instruction: string | undefined) => {
			agent.resume = undefined;
			agent.retire = undefined;
			resolve(instruction);
		};
		agent.resume = (instruction) => {
			logSteering(agent.id, "agent-resumed", { instructionLength: instruction.length });
			agent.mainContextState = agent.notifyMainAgent ? "will-join" : "separate";
			agent.status = "running";
			agent.turnStartedAt = Date.now();
			agent.completedAt = undefined;
			settle(instruction);
			widget.update();
		};
		agent.retire = () => {
			logSteering(agent.id, "agent-retired", { status: agent.status });
			settle(undefined);
		};
	});
}

function subscribeToChildSession(
	session: AgentSession,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): () => void {
	return session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "agent_start")
			logSteering(runningAgent.id, "child-agent-started", { streaming: session.isStreaming });
		if (event.type === "agent_end")
			logSteering(runningAgent.id, "child-agent-ended", {
				streaming: session.isStreaming,
				messageCount: event.messages.length,
			});
		if (event.type === "agent_settled")
			logSteering(runningAgent.id, "child-agent-settled", { streaming: session.isStreaming });
		if (event.type === "turn_start")
			logSteering(runningAgent.id, "turn-started", { streaming: session.isStreaming });
		if (event.type === "turn_end")
			logSteering(runningAgent.id, "turn-ended", { streaming: session.isStreaming });
		if (event.type === "message_start")
			logSteering(runningAgent.id, "message-started", {
				role: event.message.role,
				streaming: session.isStreaming,
			});
		const finalizedMessageUpdate =
			event.type === "message_update" && event.assistantMessageEvent.type.endsWith("_end");
		if (finalizedMessageUpdate || event.type === "message_end")
			runningAgent.latestFinalizedMessage = structuredClone(event.message);
		if (
			finalizedMessageUpdate &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "text_end"
		) {
			runningAgent.responseText = assistantText(event.message);
		}
		if (event.type === "message_end" && event.message.role === "assistant")
			runningAgent.responseText = assistantText(event.message);
		if (event.type === "tool_execution_start") {
			runningAgent.activeTools.set(event.toolCallId, event.toolName);
		}
		if (event.type === "tool_execution_end") {
			runningAgent.activeTools.delete(event.toolCallId);
			runningAgent.toolUses += 1;
		}
		if (event.type === "turn_end") {
			runningAgent.turnCount += 1;
		}
		if (event.type === "message_update" && !finalizedMessageUpdate) return;
		widget.update();
	});
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function getFinalAssistantText(session: AgentSession): string {
	const assistantMessages = session.agent.state.messages.filter(
		(message) => message.role === "assistant",
	);
	const lastMessage = assistantMessages.at(-1);
	if (!lastMessage) throw new Error("User agent finished without an assistant message");
	if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
		throw new Error(lastMessage.errorMessage ?? `User agent ${lastMessage.stopReason}`);
	}

	const text = assistantText(lastMessage).trim();
	if (!text) throw new Error("User agent returned no text response");
	return text;
}
