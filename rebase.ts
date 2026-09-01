import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ExtensionCommandContext } from "./shared.js";
import { MESSAGE_TYPE } from "./shared.js";

type MainSessionManager = ExtensionCommandContext["sessionManager"];

/**
 * Fingerprint a context snapshot for the rebase fast-forward precondition: the main session's
 * live context must still fingerprint-equal the base the child was dispatched from.
 *
 * Compares content, not file bookkeeping: rebuilding custom, compaction, and branch summaries
 * from a session file re-stamps their timestamps (and a branch summary's fromId), so a base
 * round-tripped through a child's file would never equal main's live context otherwise.
 *
 * @example conversationFingerprint([]) === conversationFingerprint([]) // true
 */
export function conversationFingerprint(messages: readonly AgentMessage[]): string {
	return JSON.stringify(messages.map(fingerprintedMessage));
}

function fingerprintedMessage(message: AgentMessage): Omit<AgentMessage, "timestamp"> {
	const { timestamp: _timestamp, ...content } = message;
	if (content.role !== "branchSummary") return content;
	const { fromId: _fromId, ...branchContent } = content;
	return branchContent;
}

/** Rebuilding a session-sized context string is only worth doing when the branch tip moved. */
const contextFingerprintCache = new WeakMap<object, { leafId: string | null; fingerprint: string }>();

/** Fingerprint of the main session's current LLM context, cached by branch leaf. */
export function mainContextFingerprint(sessionManager: MainSessionManager): string {
	const leafId = sessionManager.getLeafId();
	const cached = contextFingerprintCache.get(sessionManager);
	if (cached && cached.leafId === leafId) return cached.fingerprint;
	const fingerprint = conversationFingerprint(
		buildSessionContext(sessionManager.getBranch()).messages,
	);
	contextFingerprintCache.set(sessionManager, { leafId, fingerprint });
	return fingerprint;
}

/**
 * Select the child conversation messages to rebase onto the main session, so the record reads
 * as if the user prompted the main session directly. The child's history passes through
 * verbatim — compactions included, so main inherits the child's context boundary — except the
 * first user message, which carries the extension's internal background-process prefix and is
 * replaced by the plain task, and this extension's own custom messages, which are the one
 * trace of the user-agents machinery.
 */
export function selectRebaseMessages(
	task: string,
	messages: readonly AgentMessage[],
): AgentMessage[] {
	let firstUserMessage = true;
	const selected: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "custom" && message.customType === MESSAGE_TYPE) continue;
		if (message.role === "user" && firstUserMessage) {
			firstUserMessage = false;
			selected.push({ ...message, content: task });
			continue;
		}
		selected.push(message);
	}
	return selected;
}
