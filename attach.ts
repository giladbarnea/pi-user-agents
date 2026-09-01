import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { conversationFingerprint } from "./rebase.js";
import {
	assistantText,
	buildChildResourceLoaderOptions,
	createChildServices,
	DISPATCH_PREAMBLE,
	parseForwardedArgs,
	reportAgentFailure,
	resolveToolOptions,
	runChildTurns,
	subscribeToChildSession,
	waitForInstruction,
} from "./runner.js";
import type {
	AgentMessage,
	AgentSession,
	AttachedEntryData,
	DispatchRecordData,
	ExtensionAPI,
	ExtensionCommandContext,
	Model,
	RunningAgent,
} from "./shared.js";
import {
	ATTACHED_ENTRY_TYPE,
	DISPATCH_ENTRY_TYPE,
	errorMessage,
	formatModel,
	formatModelLabel,
	logSteering,
} from "./shared.js";
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

export type ChildSessionFileMatch = { sessionId: string; file: string };

/**
 * The session files in a directory whose id matches the query exactly or by prefix.
 * Pi names session files `<timestamp>_<session-id>.jsonl`, so matching reads names only.
 */
export function matchChildSessionFiles(
	query: string,
	sessionDirectory: string,
): ChildSessionFileMatch[] {
	const fileNames = existsSync(sessionDirectory) ? readdirSync(sessionDirectory) : [];
	return fileNames.flatMap((name) => {
		const sessionId = sessionIdFromFileName(name);
		if (sessionId === undefined || !sessionId.startsWith(query)) return [];
		return [{ sessionId, file: join(sessionDirectory, name) }];
	});
}

function sessionIdFromFileName(fileName: string): string | undefined {
	if (!fileName.endsWith(".jsonl")) return undefined;
	const separator = fileName.indexOf("_");
	if (separator === -1) return undefined;
	return fileName.slice(separator + 1, -".jsonl".length);
}

/** The dispatch record persisted in the child's file, or undefined for pre-record and /fork children. */
export function readDispatchRecord(
	childSessionManager: SessionManager,
): DispatchRecordData | undefined {
	for (const entry of childSessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === DISPATCH_ENTRY_TYPE)
			return entry.data as DispatchRecordData | undefined;
	}
	return undefined;
}

/**
 * Rebuild an idle, steerable RunningAgent from a reopened child session and its resolved model.
 * The child's own conversation, task, latest response, and rebase base all come from the file;
 * the dispatch record refines the task and context flag, and with no recognizable dispatch
 * boundary the whole context attaches and rebase stays withheld.
 */
export function buildAttachedAgent(
	sequenceNumber: number,
	childSessionManager: SessionManager,
	model: Model,
	invocation: string,
	record?: DispatchRecordData,
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
		inheritedContext: record
			? !record.isolate
			: boundary
				? boundary.base.length > 0
				: true,
		model: formatModel(model),
		modelLabel: formatModelLabel(model),
		task:
			record?.task ??
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
 * The attached agent's lifecycle: bind the child's extensions, park until the user steers or
 * retires it, then run turns exactly like a dispatched child. Every failure — the bind's
 * included — settles through the shared error path, and the end shuts the child's extensions
 * down.
 */
export async function runAttachedTurns(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	session: AgentSession,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): Promise<void> {
	let unsubscribe: (() => void) | undefined;
	try {
		await session.bindExtensions({ mode: "print" });
		unsubscribe = subscribeToChildSession(session, runningAgent, widget);
		// The user can detach during the extension bind, before this lifecycle parks.
		if (runningAgent.aborted) return;
		const instruction = await waitForInstruction(runningAgent, widget);
		if (instruction !== undefined)
			await runChildTurns(pi, isShuttingDown, instruction, session, runningAgent, widget);
	} catch (error) {
		reportAgentFailure(pi, isShuttingDown, runningAgent, widget, error);
	} finally {
		unsubscribe?.();
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

	// One resolution over the whole universe — attached rows and files on disk together — so a
	// prefix unique among rows cannot mask an ambiguity with a detached session, and a live row
	// whose file is not written yet still resolves. Dispatch creates children in pi's default
	// session directory for the cwd; that is where the files are.
	const attachedIds = widget.matchAttachedSessionIds(query);
	const childSessionDirectory = SessionManager.create(ctx.cwd).getSessionDir();
	const fileMatches = matchChildSessionFiles(query, childSessionDirectory);
	const matchedSessionIds = [
		...new Set([...attachedIds, ...fileMatches.map((match) => match.sessionId)]),
	];
	if (matchedSessionIds.length === 0) throw new Error(`No agent session matches "${query}"`);
	if (matchedSessionIds.length > 1)
		throw new Error(`"${query}" matches ${matchedSessionIds.length} sessions; use more characters`);
	const sessionId = matchedSessionIds[0]!;

	if (attachedIds.includes(sessionId)) {
		await confirmViewAgent(ctx, widget, sessionId, "Agent already attached");
		return;
	}

	const mainSessionFile = ctx.sessionManager.getSessionFile();
	if (!mainSessionFile)
		throw new Error("This session has no file; only a persisted session can attach agents");
	const childSessionFile = fileMatches.find((match) => match.sessionId === sessionId)!.file;
	const childSessionManager = SessionManager.open(childSessionFile);
	if (childSessionManager.getHeader()?.parentSession !== mainSessionFile)
		throw new Error(
			`Session ${childSessionManager.getSessionId()} is not a child session of this session`,
		);

	// The record replays through the same projections dispatch uses; a record-less child (an old
	// dispatch, or a /fork) restores pi defaults.
	const record = readDispatchRecord(childSessionManager);
	const dispatchArgs = parseForwardedArgs(record?.forwardedArgs ?? []);
	const services = await createChildServices(
		ctx,
		buildChildResourceLoaderOptions(dispatchArgs, ctx.cwd),
	);
	// A non-empty session manager takes pi's resume path: messages, model, and thinking level
	// are restored from the child's own file; tools and resources come from the dispatch record.
	const { session, modelFallbackMessage } = await createAgentSessionFromServices({
		services,
		sessionManager: childSessionManager,
		...resolveToolOptions(dispatchArgs),
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
		record,
	);
	runningAgent.session = session;
	runningAgents.add(runningAgent);
	logSteering(runningAgent.id, "agent-attached", { sessionId: runningAgent.sessionId });
	if (ctx.hasUI) {
		widget.ensureTimer();
		widget.update();
	}
	// No awaits between the add above and this assignment: every later failure settles inside
	// the lifecycle, so the row can never outlive its own removal hook.
	runningAgent.finished = runAttachedTurns(
		pi,
		isShuttingDown,
		session,
		runningAgent,
		widget,
	).finally(() => {
		logSteering(runningAgent.id, "agent-disposed", { status: runningAgent.status });
		runningAgent.session?.dispose();
		runningAgents.delete(runningAgent);
		widget.update();
	});
	// The detach breadcrumb's counterpart: after a reload the transcript still tells the truth.
	pi.appendEntry<AttachedEntryData>(ATTACHED_ENTRY_TYPE, { sessionId: runningAgent.sessionId });
	if (runningAgent.aborted) return;
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
