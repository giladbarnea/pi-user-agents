import { describe, expect, test } from "bun:test";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { confirmMainContextSquash } from "../index.ts";
import type { AgentResultMessage, RebaseDelivery, RunningAgent } from "../shared.js";
import { UserAgentWidget } from "../widget.ts";

/** A widget under test that must never rebase. */
const noRebase: RebaseDelivery = {
	canDeliver: () => false,
	deliver: () => {
		throw new Error("Unexpected rebase delivery");
	},
};

function completedSquash(): {
	widget: UserAgentWidget;
	message: AgentResultMessage;
} {
	const agent = {
		id: "user-1",
		sessionId: "session-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "review the migration",
		invocation: "/agent -s review the migration",
		notifyMainAgent: true,
		dispatchBaseFingerprint: "[]",
		mainContextState: "will-squash",
		status: "posted",
		startedAt: 1_000,
		turnStartedAt: 1_000,
		completedAt: 2_000,
		activeTools: new Map<string, string>(),
		toolUses: 0,
		turnCount: 1,
		responseText: "done",
		conversationMessages: [],
		finished: Promise.resolve(),
	} satisfies RunningAgent;
	const message: AgentResultMessage = {
		customType: "pi-user-agents",
		content: "<user_agent>done</user_agent>",
		display: true,
		details: {
			agentId: agent.id,
			command: agent.command,
			mainContextState: agent.mainContextState,
			inheritedContext: true,
			model: agent.model,
			modelLabel: agent.modelLabel,
			task: agent.task,
			ok: true,
		},
	};
	const widget = new UserAgentWidget(new Set(), () => undefined, () => undefined, noRebase);
	widget.addCompleted(agent, message, { squashable: false });
	return { widget, message };
}

function messageEnd(
	message: AgentResultMessage,
	details = message.details,
	customType = message.customType,
): MessageEndEvent {
	return {
		type: "message_end",
		message: {
			role: "custom",
			customType,
			content: message.content,
			display: message.display,
			details,
			timestamp: Date.now(),
		},
	};
}

describe("parent main-context confirmation", () => {
	test("only this extension's result message confirms a scheduled squash", () => {
		const { widget, message } = completedSquash();
		const unrelated = messageEnd(message, message.details, "another-extension");

		expect(confirmMainContextSquash(unrelated, widget)).toBeUndefined();
		const result = confirmMainContextSquash(messageEnd(message), widget);

		expect(result?.message?.role).toBe("custom");
		if (result?.message?.role !== "custom") throw new Error("Expected a custom result message");
		expect(result.message.details).toMatchObject({
			agentId: "user-1",
			mainContextState: "squashed",
		});
		expect(message.details.mainContextState).toBe("squashed");
		expect(confirmMainContextSquash(messageEnd(message), widget)).toBeUndefined();
	});

	test("confirms the chat event after its widget row was removed", () => {
		const { message } = completedSquash();
		const emptyWidget = new UserAgentWidget(new Set(), () => undefined, () => undefined, noRebase);

		const result = confirmMainContextSquash(messageEnd(message), emptyWidget);

		expect(result?.message?.role).toBe("custom");
		expect(message.details.mainContextState).toBe("squashed");
	});

	test("ignores a separate result even when its agent id matches", () => {
		const { widget, message } = completedSquash();
		const separate = messageEnd(message, {
			...message.details,
			mainContextState: "separate",
		});

		expect(confirmMainContextSquash(separate, widget)).toBeUndefined();
	});
});
