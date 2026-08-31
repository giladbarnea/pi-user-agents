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
	test("drops only this extension's own custom messages; everything else the child saw passes through", () => {
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
			{
				role: "custom",
				customType: "another-extension",
				content: "a status message the child acted on",
				display: true,
				timestamp: 5,
			},
			{ role: "compactionSummary", summary: "child compacted", tokensBefore: 90_000, timestamp: 6 },
			{ role: "branchSummary", summary: "a path abandoned", fromId: "e7", timestamp: 7 },
			{
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				timestamp: 8,
				stopReason: "stop",
			},
		] as AgentMessage[];

		const selected = selectRebaseMessages("the task", messages);

		expect(
			selected.map((message) => message.role),
			"Expected the child's history verbatim, minus only this extension's own machinery",
		).toEqual([
			"user",
			"assistant",
			"toolResult",
			"custom",
			"compactionSummary",
			"branchSummary",
			"assistant",
		]);
		expect(selected[3]).toMatchObject({ customType: "another-extension" });
		expect(selected[4]).toBe(messages[5] as AgentMessage);
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

	test("a rebased child compaction becomes main's context boundary: full transcript, compacted LLM context", () => {
		const { sessionManager, sessionDirectory } = seedMainSession();
		try {
			const ctx = {
				sessionManager,
				hasUI: false,
				switchSession: async () => ({ cancelled: false }),
			} as unknown as ExtensionCommandContext;
			const delivery = createRebaseDelivery(
				{ appendEntry: () => undefined } as unknown as ExtensionAPI,
				() => ctx,
			);
			const agent = agentWithBase(mainContextFingerprint(sessionManager));

			delivery.deliver(agent, [
				{ role: "user", content: "the task", timestamp: 3 },
				{
					role: "assistant",
					content: [{ type: "text", text: "long early work" }],
					timestamp: 4,
					stopReason: "stop",
				},
				{
					role: "compactionSummary",
					summary: "the child's own compaction summary",
					tokensBefore: 90_000,
					timestamp: 5,
				},
				{ role: "user", content: "carry on", timestamp: 6 },
				{
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
					timestamp: 7,
					stopReason: "stop",
				},
			] as AgentMessage[]);

			const reopened = SessionManager.open(sessionManager.getSessionFile() as string);
			expect(
				reopened.getEntries().map((entry) => entry.type),
				"Expected the full history persisted, with the compaction as an ordinary entry",
			).toEqual(["message", "message", "message", "message", "compaction", "message", "message"]);
			const contextMessages = reopened.buildSessionContext().messages;
			expect(
				contextMessages.map((message) => message.role),
				"Expected main's LLM context to pick up exactly where the child's compacted context left off",
			).toEqual(["compactionSummary", "user", "assistant"]);
			expect(contextMessages[0]).toMatchObject({
				summary: "the child's own compaction summary",
			});
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
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
			expect(appendedEntries, "Expected a persisted rebase breadcrumb").toHaveLength(1);
			expect(appendedEntries[0]).toMatchObject({
				customType: "pi-user-agents-rebased",
				data: {
					sessionId: "child-session-1",
					stats: { messageCount: 2, compactionCount: 0 },
				},
			});
			const stats = (appendedEntries[0]?.data as { stats: { tokenEstimate: number } }).stats;
			expect(
				stats.tokenEstimate,
				"Expected a positive token estimate for the replayed messages",
			).toBeGreaterThan(0);
			expect(switchedTo, "Expected the host to reload the session from its own file").toEqual([
				sessionFile,
			]);
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});
});
