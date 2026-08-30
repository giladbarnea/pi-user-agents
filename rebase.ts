import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ExtensionCommandContext } from "./shared.js";

type MainSessionManager = ExtensionCommandContext["sessionManager"];

/**
 * Fingerprint a context snapshot for the rebase fast-forward precondition: the main session's
 * live context must still fingerprint-equal the base the child was dispatched from.
 *
 * @example conversationFingerprint([]) === conversationFingerprint([]) // true
 */
export function conversationFingerprint(messages: readonly AgentMessage[]): string {
	return JSON.stringify(messages);
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
 * as if the user prompted the main session directly. The first user message carries the
 * extension's internal background-process prefix; it is replaced by the plain task.
 */
export function selectRebaseMessages(
	task: string,
	messages: readonly AgentMessage[],
): AgentMessage[] {
	let firstUserMessage = true;
	const selected: AgentMessage[] = [];
	for (const message of messages) {
		if (
			message.role === "custom" ||
			message.role === "compactionSummary" ||
			message.role === "branchSummary"
		)
			continue;
		if (message.role === "user" && firstUserMessage) {
			firstUserMessage = false;
			selected.push({ ...message, content: task });
			continue;
		}
		selected.push(message);
	}
	return selected;
}
