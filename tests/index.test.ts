import { describe, expect, test } from "bun:test";
import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { confirmMainContextJoin } from "../index.ts";
import type { AgentResultMessage, RebaseDelivery, RunningAgent } from "../shared.js";
import { UserAgentWidget } from "../widget.ts";

/** A widget under test that must never rebase. */
const noRebase: RebaseDelivery = {
	canDeliver: () => false,
	deliver: () => {
		throw new Error("Unexpected rebase delivery");
	},
};

function completedJoin(): {
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
		invocation: "/agent -j review the migration",
		notifyMainAgent: true,
		dispatchBaseFingerprint: "[]",
		mainContextState: "will-join",
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
	widget.addCompleted(agent, message, { joinable: false });
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
	test("only this extension's result message confirms a scheduled join", () => {
		const { widget, message } = completedJoin();
		const unrelated = messageEnd(message, message.details, "another-extension");

		expect(confirmMainContextJoin(unrelated, widget)).toBeUndefined();
		const result = confirmMainContextJoin(messageEnd(message), widget);

		expect(result?.message?.role).toBe("custom");
		if (result?.message?.role !== "custom") throw new Error("Expected a custom result message");
		expect(result.message.details).toMatchObject({
			agentId: "user-1",
			mainContextState: "joined",
		});
		expect(message.details.mainContextState).toBe("joined");
		expect(confirmMainContextJoin(messageEnd(message), widget)).toBeUndefined();
	});

	test("confirms the chat event after its widget row was removed", () => {
		const { message } = completedJoin();
		const emptyWidget = new UserAgentWidget(new Set(), () => undefined, () => undefined, noRebase);

		const result = confirmMainContextJoin(messageEnd(message), emptyWidget);

		expect(result?.message?.role).toBe("custom");
		expect(message.details.mainContextState).toBe("joined");
	});

	test("ignores a separate result even when its agent id matches", () => {
		const { widget, message } = completedJoin();
		const separate = messageEnd(message, {
			...message.details,
			mainContextState: "separate",
		});

		expect(confirmMainContextJoin(separate, widget)).toBeUndefined();
	});
});
