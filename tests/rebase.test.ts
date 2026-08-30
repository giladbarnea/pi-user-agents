import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRebaseDelivery } from "../runner.ts";
import {
	conversationFingerprint,
	mainContextFingerprint,
	selectRebaseMessages,
} from "../rebase.ts";
import type {
	AgentMessage,
	CompletedAgent,
	ExtensionAPI,
	ExtensionCommandContext,
} from "../shared.ts";

describe("selectRebaseMessages — the child conversation, as if it happened in the main session", () => {
	test("drops custom messages and child-internal summaries, keeping the raw conversation", () => {
		const messages = [
			{ role: "user", content: "prefixed task", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
				timestamp: 2,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 3,
			},
			{
				role: "custom",
				customType: "pi-user-agents",
				content: "<user_agent>a result card</user_agent>",
				display: false,
				timestamp: 4,
			},
			{ role: "compactionSummary", summary: "child compacted", tokensBefore: 90_000, timestamp: 5 },
			{ role: "branchSummary", summary: "a path abandoned", fromId: "e7", timestamp: 6 },
			{
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				timestamp: 7,
				stopReason: "stop",
			},
		] as AgentMessage[];

		const selected = selectRebaseMessages("the task", messages);

		expect(
			selected.map((message) => message.role),
			"Expected only raw conversation roles, in order, with no user-agents-world traces",
		).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(selected[1]).toBe(messages[1] as AgentMessage);
		expect(selected[2]).toBe(messages[2] as AgentMessage);
	});

	test("replaces the first user message's prefixed instruction with the plain task", () => {
		const messages = [
			{
				role: "user",
				content:
					"You are running in an ephemeral, forked background process now, concurrently with the main session. review the migration",
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "migration reviewed" }],
				timestamp: 2,
				stopReason: "stop",
			},
		] as AgentMessage[];

		const selected = selectRebaseMessages("review the migration", messages);

		expect(selected).toHaveLength(2);
		expect(selected[0], "Expected the first user message to carry only the task").toMatchObject({
			role: "user",
			content: "review the migration",
			timestamp: 1,
		});
		expect(selected[1], "Expected the assistant response to pass through verbatim").toBe(
			messages[1] as AgentMessage,
		);
	});
});

describe("conversationFingerprint — the fast-forward precondition", () => {
	const base = [
		{ role: "user", content: "hello", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			timestamp: 2,
			stopReason: "stop",
		},
	] as AgentMessage[];

	test("a structured clone of the same conversation is fast-forwardable", () => {
		expect(conversationFingerprint(structuredClone(base))).toBe(conversationFingerprint(base));
	});

	test("empty against empty is fast-forwardable (an isolated agent in a fresh main session)", () => {
		expect(conversationFingerprint([])).toBe(conversationFingerprint([]));
	});

	test("any drift — a new message or an edited one — blocks the rebase", () => {
		const grown = [...structuredClone(base), { role: "user", content: "and then", timestamp: 3 }];
		const edited = structuredClone(base);
		(edited[0] as { content: string }).content = "hello there";

		expect(conversationFingerprint(grown as AgentMessage[])).not.toBe(
			conversationFingerprint(base),
		);
		expect(conversationFingerprint(edited)).not.toBe(conversationFingerprint(base));
		expect(conversationFingerprint([])).not.toBe(conversationFingerprint(base));
	});
});

describe("createRebaseDelivery — fast-forward onto the dispatching session", () => {
	function seedMainSession(): {
		sessionManager: SessionManager;
		sessionDirectory: string;
	} {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-rebase-"));
		const sessionManager = SessionManager.create("/tmp/project", sessionDirectory);
		sessionManager.appendMessage({ role: "user", content: "original prompt", timestamp: 1 } as never);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "original answer" }],
			timestamp: 2,
			stopReason: "stop",
		} as never);
		return { sessionManager, sessionDirectory };
	}

	function agentWithBase(dispatchBaseFingerprint: string): CompletedAgent {
		return {
			id: "user-1",
			sessionId: "child-session-1",
			command: "agent",
			modelLabel: "model",
			task: "the task",
			dispatchBaseFingerprint,
			mainContextState: "separate",
			ok: true,
			responseText: "final answer",
			messages: [],
			startedAt: 1_000,
			durationMs: 1_000,
			toolUses: 0,
			turnCount: 1,
		};
	}

	test("canDeliver only while the main context still equals the dispatch base", () => {
		const { sessionManager, sessionDirectory } = seedMainSession();
		try {
			const ctx = { sessionManager, hasUI: false } as unknown as ExtensionCommandContext;
			const delivery = createRebaseDelivery(
				{ appendEntry: () => undefined } as unknown as ExtensionAPI,
				() => ctx,
			);
			const agent = agentWithBase(mainContextFingerprint(sessionManager));

			expect(
				delivery.canDeliver(agent),
				"Expected an undrifted main session to be fast-forwardable",
			).toBe(true);

			sessionManager.appendMessage({ role: "user", content: "drift", timestamp: 3 } as never);
			expect(
				delivery.canDeliver(agent),
				"Expected any new main-session message to block the rebase",
			).toBe(false);
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});

	test("canDeliver is false before any dispatch captured a session context", () => {
		const delivery = createRebaseDelivery(
			{ appendEntry: () => undefined } as unknown as ExtensionAPI,
			() => undefined,
		);

		expect(delivery.canDeliver(agentWithBase("[]"))).toBe(false);
	});

	test("deliver appends the conversation and breadcrumb, then reloads the session from its file", async () => {
		const { sessionManager, sessionDirectory } = seedMainSession();
		try {
			const appendedEntries: Array<{ customType: string; data: unknown }> = [];
			const switchedTo: string[] = [];
			const ctx = {
				sessionManager,
				hasUI: false,
				switchSession: async (sessionPath: string) => {
					switchedTo.push(sessionPath);
					return { cancelled: false };
				},
			} as unknown as ExtensionCommandContext;
			const delivery = createRebaseDelivery(
				{
					appendEntry: (customType: string, data: unknown) =>
						appendedEntries.push({ customType, data }),
				} as unknown as ExtensionAPI,
				() => ctx,
			);
			const agent = agentWithBase(mainContextFingerprint(sessionManager));

			delivery.deliver(agent, [
				{ role: "user", content: "the task", timestamp: 3 },
				{
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
					timestamp: 4,
					stopReason: "stop",
				},
			] as AgentMessage[]);
			await Promise.resolve();

			const sessionFile = sessionManager.getSessionFile();
			expect(sessionFile).toBeString();
			const reopened = SessionManager.open(sessionFile as string).buildSessionContext().messages;
			expect(
				reopened.map((message) => message.role),
				"Expected the child conversation appended after the original context",
			).toEqual(["user", "assistant", "user", "assistant"]);
			expect(reopened[2]).toMatchObject({ role: "user", content: "the task" });
			expect(appendedEntries, "Expected a persisted rebase breadcrumb").toEqual([
				{ customType: "pi-user-agents-rebased", data: { sessionId: "child-session-1" } },
			]);
			expect(switchedTo, "Expected the host to reload the session from its own file").toEqual([
				sessionFile,
			]);
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});
});
