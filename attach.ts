import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { conversationFingerprint } from "./rebase.js";
import {
	assistantText,
	DISPATCH_PREAMBLE,
	reportAgentFailure,
	runChildTurns,
	subscribeToChildSession,
	waitForInstruction,
} from "./runner.js";
import type {
	AgentMessage,
	AgentSession,
	ExtensionAPI,
	ExtensionCommandContext,
	Model,
	RunningAgent,
} from "./shared.js";
import { errorMessage, formatModel, formatModelLabel, logSteering } from "./shared.js";
import { buildAgentResultMessage, reportCommandError } from "./transcript.js";
import type { UserAgentWidget } from "./widget.js";

/** A dispatch base that can never fingerprint-match a live context, so rebase stays withheld. */
export const UNKNOWN_DISPATCH_BASE = "unknown-dispatch-base";

export type DispatchBoundary = {
	/** The main-session context the child inherited at dispatch — the rebase fast-forward base. */
	base: AgentMessage[];
	/** The child's own conversation, starting at the preambled dispatch message. */
	conversation: AgentMessage[];
	/** The dispatch task, preamble stripped. */
	task: string;
};

/**
 * Split a child's resolved context at its dispatch boundary — the first user message carrying
 * the dispatch preamble. Undefined when no message carries it (a /fork child, or a child whose
 * own compaction summarized the boundary away).
 */
export function splitAtDispatchBoundary(
	messages: readonly AgentMessage[],
): DispatchBoundary | undefined {
	for (const [index, message] of messages.entries()) {
		if (message.role !== "user") continue;
		const text = userMessageText(message);
		if (!text.startsWith(DISPATCH_PREAMBLE)) continue;
		return {
			base: messages.slice(0, index),
			conversation: messages.slice(index),
			task: text.slice(DISPATCH_PREAMBLE.length),
		};
	}
	return undefined;
}

function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
}

/**
 * Resolve a session id, or a unique prefix of one, to its file in a session directory.
 * Pi names session files `<timestamp>_<session-id>.jsonl`, so resolution reads names only.
 * Raises an error when nothing matches or the prefix is ambiguous.
 */
export function resolveChildSessionFile(query: string, sessionDirectory: string): string {
	const fileNames = existsSync(sessionDirectory) ? readdirSync(sessionDirectory) : [];
	const matches = fileNames.filter((name) => {
		const sessionId = sessionIdFromFileName(name);
		return sessionId !== undefined && (sessionId === query || sessionId.startsWith(query));
	});
	if (matches.length === 0) throw new Error(`No agent session matches "${query}"`);
	if (matches.length > 1)
		throw new Error(`"${query}" matches ${matches.length} sessions; use more characters`);
	return join(sessionDirectory, matches[0]!);
}

function sessionIdFromFileName(fileName: string): string | undefined {
	if (!fileName.endsWith(".jsonl")) return undefined;
	const separator = fileName.indexOf("_");
	if (separator === -1) return undefined;
	return fileName.slice(separator + 1, -".jsonl".length);
}

/**
 * Rebuild an idle, steerable RunningAgent from a reopened child session and its resolved model.
 * The child's own conversation, task, latest response, and rebase base all come from the file;
 * with no recognizable dispatch boundary the whole context attaches and rebase stays withheld.
 */
export function buildAttachedAgent(
	sequenceNumber: number,
	childSessionManager: SessionManager,
	model: Model,
	invocation: string,
): RunningAgent {
	const contextMessages = childSessionManager.buildSessionContext().messages;
	const boundary = splitAtDispatchBoundary(contextMessages);
	const conversationMessages = structuredClone(boundary?.conversation ?? contextMessages);
	const firstUserMessage = contextMessages.find((message) => message.role === "user");
	const lastAssistantMessage = conversationMessages.findLast(
		(message): message is Extract<AgentMessage, { role: "assistant" }> =>
			message.role === "assistant",
	);
	const responseText = lastAssistantMessage ? assistantText(lastAssistantMessage).trim() : "";
	const now = Date.now();
	const agent: RunningAgent = {
		id: `user-${sequenceNumber.toString(36)}`,
		sessionId: childSessionManager.getSessionId(),
		command: "agent",
		inheritedContext: boundary ? boundary.base.length > 0 : true,
		model: formatModel(model),
		modelLabel: formatModelLabel(model),
		task:
			boundary?.task ??
			(firstUserMessage === undefined ? "(no messages)" : userMessageText(firstUserMessage)),
		invocation,
		notifyMainAgent: false,
		dispatchBaseFingerprint: boundary
			? conversationFingerprint(boundary.base)
			: UNKNOWN_DISPATCH_BASE,
		mainContextState: "separate",
		status: "idle",
		startedAt: now,
		turnStartedAt: now,
		completedAt: now,
		activeTools: new Map(),
		toolUses: 0,
		turnCount: 0,
		responseText,
		conversationMessages,
		finished: Promise.resolve(),
	};
	if (responseText)
		agent.pendingSquashMessage = buildAgentResultMessage(
			agent,
			{ ok: true, response: responseText },
			{ display: false },
		);
	return agent;
}

/**
 * The attached agent's lifecycle: park until the user steers or retires it, then run turns
 * exactly like a dispatched child. Ends by shutting the child session's extensions down.
 */
export async function runAttachedTurns(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	session: AgentSession,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
	unsubscribe: () => void,
): Promise<void> {
	try {
		const instruction = await waitForInstruction(runningAgent, widget);
		if (instruction !== undefined)
			await runChildTurns(pi, isShuttingDown, instruction, session, runningAgent, widget);
	} catch (error) {
		reportAgentFailure(pi, isShuttingDown, runningAgent, widget, error);
	} finally {
		unsubscribe();
		logSteering(runningAgent.id, "session-shutdown", { streaming: session.isStreaming });
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	}
}

export async function handleAttachCommand(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	isShuttingDown: () => boolean,
	nextAgentNumber: () => number,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		await attachUserAgent(pi, runningAgents, widget, isShuttingDown, nextAgentNumber, args, ctx);
	} catch (error) {
		reportCommandError(pi, "agent-attach", args, ctx, errorMessage(error));
	}
}

/**
 * Reattach a detached child session as a live, parked agent row. Idempotent for a session
 * that already has a row; errors for anything that is not a child session of this session.
 * Both success states end by offering to open the agent's overlay.
 */
async function attachUserAgent(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	isShuttingDown: () => boolean,
	nextAgentNumber: () => number,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const query = args.trim();
	if (!query || /\s/.test(query)) throw new Error("Usage: /agent-attach <child-session-id>");
	if (ctx.hasUI) widget.setUI(ctx.ui);

	const attachedIds = widget.matchAttachedSessionIds(query);
	if (attachedIds.length > 1)
		throw new Error(
			`"${query}" matches ${attachedIds.length} attached agent sessions; use more characters`,
		);
	if (attachedIds.length === 1) {
		await confirmViewAgent(ctx, widget, attachedIds[0]!, "Agent already attached");
		return;
	}

	const mainSessionFile = ctx.sessionManager.getSessionFile();
	if (!mainSessionFile)
		throw new Error("This session has no file; only a persisted session can attach agents");
	// Dispatch creates children in pi's default session directory for the cwd; look there.
	const childSessionDirectory = SessionManager.create(ctx.cwd).getSessionDir();
	const childSessionFile = resolveChildSessionFile(query, childSessionDirectory);
	const childSessionManager = SessionManager.open(childSessionFile);
	if (childSessionManager.getHeader()?.parentSession !== mainSessionFile)
		throw new Error(
			`Session ${childSessionManager.getSessionId()} is not a child session of this session`,
		);

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const services = await createAgentSessionServices({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		modelRuntime: (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime,
	});
	// A non-empty session manager takes pi's resume path: messages, model, and thinking level
	// are restored from the child's own file.
	const { session, modelFallbackMessage } = await createAgentSessionFromServices({
		services,
		sessionManager: childSessionManager,
	});
	const model = session.agent.state.model as Model | undefined;
	if (!model) {
		session.dispose();
		throw new Error(modelFallbackMessage ?? "No model is available for the attached session");
	}
	if (modelFallbackMessage && ctx.hasUI) ctx.ui.notify(modelFallbackMessage, "warning");

	const runningAgent = buildAttachedAgent(
		nextAgentNumber(),
		childSessionManager,
		model,
		`/agent-attach ${query}`,
	);
	runningAgent.session = session;
	runningAgents.add(runningAgent);
	logSteering(runningAgent.id, "agent-attached", { sessionId: runningAgent.sessionId });
	if (ctx.hasUI) {
		widget.ensureTimer();
		widget.update();
	}
	await session.bindExtensions({ mode: "print" });
	const unsubscribe = subscribeToChildSession(session, runningAgent, widget);
	runningAgent.finished = runAttachedTurns(
		pi,
		isShuttingDown,
		session,
		runningAgent,
		widget,
		unsubscribe,
	).finally(() => {
		logSteering(runningAgent.id, "agent-disposed", { status: runningAgent.status });
		runningAgent.session?.dispose();
		runningAgents.delete(runningAgent);
		widget.update();
	});
	await confirmViewAgent(ctx, widget, runningAgent.sessionId, "Agent attached");
}

/** The follow-up both success states share: offer to open the agent's overlay. */
async function confirmViewAgent(
	ctx: ExtensionCommandContext,
	widget: UserAgentWidget,
	sessionId: string,
	title: string,
): Promise<void> {
	if (!ctx.hasUI) return;
	const view = await ctx.ui.confirm(title, "View agent?");
	if (view) widget.openViewer(sessionId);
}
