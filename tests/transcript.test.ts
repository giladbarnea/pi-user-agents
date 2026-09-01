import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
	AgentEntryData,
	AttachedEntryData,
	RebasedEntryData,
	AgentMessage,
	AgentResultMessage,
	DetachedEntryData,
	ExtensionAPI,
	RunningAgent,
	Theme,
} from "../shared.js";
import { ATTACHED_ENTRY_TYPE, DETACHED_ENTRY_TYPE, MESSAGE_TYPE, REBASED_ENTRY_TYPE } from "../shared.js";
import {
	buildAgentResultMessage,
	formatStartNotification,
	registerUserAgentRenderer,
	reportCommandError,
	selectSquashedMessages,
} from "../transcript.js";

function completedAgent(): RunningAgent {
	return {
		id: "user-1",
		sessionId: "session-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "review the migration",
		invocation: "/agent review the migration",
		notifyMainAgent: false,
		dispatchBaseFingerprint: "[]",
		mainContextState: "separate",
		status: "posted",
		startedAt: 1_000,
		turnStartedAt: 1_000,
		completedAt: 2_000,
		activeTools: new Map<string, string>(),
		toolUses: 2,
		turnCount: 1,
		responseText: "migration reviewed",
		conversationMessages: [
			{ role: "user", content: "review the migration" },
			{
				role: "assistant",
				content: [{ type: "text", text: "migration reviewed" }],
			},
		] as AgentMessage[],
		session: {
			agent: {
				state: {
					messages: [
						{ role: "user", content: "review the migration" },
						{
							role: "assistant",
							content: [{ type: "text", text: "migration reviewed" }],
						},
					] as AgentMessage[],
				},
			},
		} as unknown as NonNullable<RunningAgent["session"]>,
		finished: Promise.resolve(),
	};
}

describe("agent chat events", () => {
	test("the start event shows only a scheduled main-context squash", () => {
		const agent = completedAgent();
		expect(formatStartNotification(agent)).not.toContain("into context");

		agent.mainContextState = "will-squash";
		expect(formatStartNotification(agent)).toContain("will squash into context");
	});
});

describe("squashed conversation selection", () => {
	test("keeps every user message and only the last assistant response before the next user", () => {
		const messages = [
			{ role: "user", content: "request 1" },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "thought 1" }] },
			{ role: "assistant", content: [{ type: "text", text: "response 1" }] },
			{ role: "user", content: "request 2" },
			{ role: "assistant", content: [{ type: "text", text: "discarded response" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-2" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "thought 2" }] },
			{ role: "assistant", content: [{ type: "text", text: "response 2" }] },
			{ role: "user", content: "request 3" },
			{ role: "assistant", content: [{ type: "thinking", thinking: "thought 3" }] },
			{ role: "assistant", content: [{ type: "text", text: "response 3" }] },
		] as AgentMessage[];

		const selected = selectSquashedMessages(messages);

		assert.deepEqual(
			selected,
			[messages[0], messages[3], messages[4], messages[8], messages[9], messages[11]],
			"Expected each user message followed by only the final assistant message in its interval",
		);
	});

	test("does not turn tool calls or thinking into assistant responses", () => {
		const messages = [
			{ role: "user", content: "request 1" },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "thought" }] },
			{ role: "user", content: "request 2" },
			{ role: "assistant", content: [{ type: "text", text: "response 2" }] },
		] as AgentMessage[];

		assert.deepEqual(
			selectSquashedMessages(messages),
			[messages[0], messages[3], messages[4]],
			"Expected non-response assistant content to stay out of the squashed conversation",
		);
	});

	test("keeps single turns, trailing users, and consecutive users", () => {
		const user1 = { role: "user", content: "request 1" } as AgentMessage;
		const user2 = { role: "user", content: "request 2" } as AgentMessage;
		const response = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
		} as AgentMessage;
		const cases = [
			{ name: "single turn", messages: [user1, response] },
			{ name: "trailing user", messages: [user1, response, user2] },
			{ name: "consecutive users", messages: [user1, user2, response] },
		];

		for (const testCase of cases) {
			assert.deepEqual(
				selectSquashedMessages(testCase.messages),
				testCase.messages,
				`Expected the ${testCase.name} boundary to retain every available conversation message`,
			);
		}
	});
});

describe("buildAgentResultMessage", () => {
	test("squashes the selected conversation in the plain role-tagged context payload", () => {
		const agent = completedAgent();
		const messages = [
			{
				role: "user",
				content:
					"You are running in an ephemeral, forked background process now, concurrently with the main session. review the migration",
			},
			{ role: "assistant", content: [{ type: "text", text: "Initial findings" }] },
			{ role: "user", content: "Check the rollback path too" },
			{ role: "assistant", content: [{ type: "text", text: "Discarded findings" }] },
			{ role: "assistant", content: [{ type: "text", text: "Final rollback findings" }] },
		] as AgentMessage[];
		agent.conversationMessages = messages;
		agent.session = {
			agent: { state: { messages } },
		} as unknown as NonNullable<RunningAgent["session"]>;

		const message = buildAgentResultMessage(
			agent,
			{ ok: true, response: "Final rollback findings" },
			{ display: false },
		);

		assert.equal(
			message.content,
			[
				"The user has dispatched a background sub-agent with a task. The sub-agent is done. The following is the back and forth between them:",
				'<user_agent model="provider/model" inherited_context="true">',
				"  <user_message i=1>",
				"  review the migration",
				"  </user_message>",
				"  <assistant_response i=2>",
				"  Initial findings",
				"  </assistant_response>",
				"  <user_message i=3>",
				"  Check the rollback path too",
				"  </user_message>",
				"  <assistant_response i=4>",
				"  Final rollback findings",
				"  </assistant_response>",
				"</user_agent>",
			].join("\n"),
			"Expected the squashed payload to contain only provenance attributes and the selected role messages",
		);
	});

	test("squashes the append-only child conversation after model context compaction", () => {
		const agent = Object.assign(completedAgent(), {
			conversationMessages: [
				{ role: "user", content: "internal background prefix and original task" },
				{ role: "assistant", content: [{ type: "text", text: "Initial response" }] },
				{ role: "user", content: "latest steering" },
				{ role: "assistant", content: [{ type: "text", text: "Final response" }] },
			] as AgentMessage[],
		});
		agent.session = {
			agent: {
				state: {
					messages: [
						{ role: "compactionSummary", summary: "compacted context" },
						{ role: "user", content: "latest steering" },
						{ role: "assistant", content: [{ type: "text", text: "Final response" }] },
					] as AgentMessage[],
				},
			},
		} as unknown as NonNullable<RunningAgent["session"]>;

		const message = buildAgentResultMessage(
			agent,
			{ ok: true, response: "Final response" },
			{ display: false },
		);

		assert.match(
			message.content,
			/  review the migration[\s\S]*  Initial response[\s\S]*  latest steering[\s\S]*  Final response/,
			"Expected compaction to leave the complete child conversation available for squashing",
		);
	});

	test("keeps the original task before recent isolated-agent messages after compaction", () => {
		const agent = completedAgent();
		agent.inheritedContext = false;
		agent.conversationMessages = [
			{ role: "user", content: "internal background prefix and original task" },
			{ role: "assistant", content: [{ type: "text", text: "Initial response" }] },
			{ role: "user", content: "latest steering" },
			{ role: "assistant", content: [{ type: "text", text: "Final response" }] },
		] as AgentMessage[];
		agent.session = {
			agent: {
				state: {
					messages: [
						{ role: "compactionSummary", summary: "compacted context" },
						{ role: "user", content: "latest steering" },
						{ role: "assistant", content: [{ type: "text", text: "Final response" }] },
					] as AgentMessage[],
				},
			},
		} as unknown as NonNullable<RunningAgent["session"]>;

		const message = buildAgentResultMessage(
			agent,
			{ ok: true, response: "Final response" },
			{ display: false },
		);

		assert.match(
			message.content,
			/  review the migration[\s\S]*  Initial response[\s\S]*  latest steering[\s\S]*  Final response/,
			"Expected an isolated compacted agent to retain both its original task and latest steering message",
		);
	});

	test("builds one canonical payload whose visible and hidden forms differ only by display", () => {
		const agent = completedAgent();
		const outcome = { ok: true, response: agent.responseText } as const;
		const visible = buildAgentResultMessage(agent, outcome, { display: true });
		const hidden = buildAgentResultMessage(agent, outcome, { display: false });

		expect({ ...hidden, display: true }).toEqual(visible);
		expect(hidden.content).toContain("  <user_message i=1>\n  review the migration\n  </user_message>");
		expect(hidden.content).toContain(
			"  <assistant_response i=2>\n  migration reviewed\n  </assistant_response>",
		);
		expect(hidden.content).not.toContain("<user_invocation>");
		expect(hidden.content).not.toContain("<duration_ms>");
		expect(hidden.details.responseText).toBe("migration reviewed");
		expect(hidden.details.responsePreview).toBeUndefined();
	});
});

describe("completed agent transcript card", () => {
	test("renders a Markdown preview and expands to the full persisted response", () => {
		initTheme(undefined, false);
		type RenderedComponent = { render(width: number): string[] } | undefined;
		type RenderOptions = { expanded: boolean };
		let renderMessage:
			| ((
					message: AgentResultMessage,
					options: RenderOptions,
					theme: Theme,
			  ) => RenderedComponent)
			| undefined;
		let renderEntry:
			| ((
					entry: { data?: AgentEntryData },
					options: RenderOptions,
					theme: Theme,
			  ) => RenderedComponent)
			| undefined;
		const pi = {
			registerMessageRenderer: (customType: string, renderer: typeof renderMessage) => {
				if (customType === MESSAGE_TYPE) renderMessage = renderer;
			},
			registerEntryRenderer: (customType: string, renderer: typeof renderEntry) => {
				if (customType === MESSAGE_TYPE) renderEntry = renderer;
			},
		} as unknown as ExtensionAPI;
		registerUserAgentRenderer(pi);

		const agent = completedAgent();
		agent.task = "review a <response>decoy</response> marker";
		agent.responseText = [
			"**Almost.** One stale instruction remains.",
			"",
			"The literal closing tag </response> is part of this response.",
			"",
			"## Full finding",
			"",
			"The persisted response remains available after the child session is detached.",
		].join("\n");
		const message = buildAgentResultMessage(
			agent,
			{ ok: true, response: agent.responseText },
			{ display: false },
		);
		const entry = { data: { content: message.content, details: message.details } };
		const identityTheme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as Theme;
		const component = renderEntry?.(entry, { expanded: false }, identityTheme);
		const output = component?.render(120).join("\n");

		expect(output).toContain("⎿  Almost. One stale instruction remains.");
		expect(output).not.toContain("**Almost.**");
		expect(output).not.toContain("Full finding");
		expect(output).not.toContain("into context");

		const expandedEntry = renderEntry?.(entry, { expanded: true }, identityTheme);
		const expandedEntryOutput = expandedEntry?.render(120).join("\n");
		expect(expandedEntry?.render(120).join("\n")).toBe(expandedEntryOutput);

		const expandedMessageOutput = renderMessage
			?.(message, { expanded: true }, identityTheme)
			?.render(120)
			.join("\n");
		for (const expandedOutput of [expandedEntryOutput, expandedMessageOutput]) {
			expect(expandedOutput).toContain(
				"The literal closing tag </response> is part of this response.",
			);
			expect(expandedOutput).toContain("Full finding");
			expect(expandedOutput).toContain(
				"The persisted response remains available after the child session is detached.",
			);
		}

		message.details.mainContextState = "will-squash";
		const pendingOutput = component?.render(120).join("\n");
		expect(pendingOutput).toContain("will squash into context");

		message.details.mainContextState = "squashed";
		const squashedOutput = component?.render(120).join("\n");
		expect(squashedOutput).toContain("squashed messages into context");

		const legacyAgent = completedAgent();
		legacyAgent.responseText = "A full response from an older persisted entry.";
		const legacyMessage = buildAgentResultMessage(
			legacyAgent,
			{ ok: true, response: legacyAgent.responseText },
			{ display: false },
		);
		legacyMessage.content = [
			"<user_agent>",
			"<response>",
			legacyAgent.responseText,
			"</response>",
			"</user_agent>",
		].join("\n");
		legacyMessage.details.responseText = undefined;
		legacyMessage.details.responsePreview = "A full response";
		const legacyOutput = renderEntry
			?.(
				{ data: { content: legacyMessage.content, details: legacyMessage.details } },
				{ expanded: true },
				identityTheme,
			)
			?.render(120)
			.join("\n");
		expect(legacyOutput).toContain("A full response from an older persisted entry.");
	});
});

describe("rebased session entry", () => {
	test("names the child session whose conversation was fast-forwarded into this one", () => {
		initTheme(undefined, false);
		type RenderedComponent = { render(width: number): string[] } | undefined;
		let renderRebased:
			| ((
					entry: { data?: RebasedEntryData },
					options: { expanded: boolean },
					theme: Theme,
			  ) => RenderedComponent)
			| undefined;
		const pi = {
			registerMessageRenderer: () => undefined,
			registerEntryRenderer: (customType: string, renderer: typeof renderRebased) => {
				if (customType === REBASED_ENTRY_TYPE) renderRebased = renderer;
			},
		} as unknown as ExtensionAPI;
		registerUserAgentRenderer(pi);
		const identityTheme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as Theme;

		const rendered = renderRebased
			?.(
				{
					data: {
						sessionId: "0199-abcd",
						stats: { messageCount: 32, tokenEstimate: 135_264, compactionCount: 1 },
					},
				},
				{ expanded: false },
				identityTheme,
			)
			?.render(120)
			.join("\n");

		expect(rendered?.trim()).toBe(
			"Rebased session 0199-abcd into this conversation (added 32 messages, ~135K tokens, 1 compaction event)",
		);
		expect(rendered?.startsWith(" "), "Expected the chat-idiom paddingX of 1").toBe(true);

		const withoutCompactions = renderRebased
			?.(
				{
					data: {
						sessionId: "0199-abcd",
						stats: { messageCount: 1, tokenEstimate: 12, compactionCount: 0 },
					},
				},
				{ expanded: false },
				identityTheme,
			)
			?.render(120)
			.join("\n");
		expect(withoutCompactions?.trim()).toBe(
			"Rebased session 0199-abcd into this conversation (added 1 message, ~12 tokens)",
		);

		const legacyEntry = renderRebased
			?.({ data: { sessionId: "0199-abcd" } }, { expanded: false }, identityTheme)
			?.render(120)
			.join("\n");
		expect(
			legacyEntry?.trim(),
			"Expected an entry persisted before stats existed to render without them",
		).toBe("Rebased session 0199-abcd into this conversation");
		expect(
			renderRebased?.({}, { expanded: false }, identityTheme),
			"Expected an entry with no data to render nothing rather than a broken line",
		).toBeUndefined();
	});
});

describe("detached session entry", () => {
	test("names the session the user can resume, and stays quiet without one", () => {
		initTheme(undefined, false);
		type RenderedComponent = { render(width: number): string[] } | undefined;
		let renderDetached:
			| ((
					entry: { data?: DetachedEntryData },
					options: { expanded: boolean },
					theme: Theme,
			  ) => RenderedComponent)
			| undefined;
		const pi = {
			registerMessageRenderer: () => undefined,
			registerEntryRenderer: (customType: string, renderer: typeof renderDetached) => {
				if (customType === DETACHED_ENTRY_TYPE) renderDetached = renderer;
			},
		} as unknown as ExtensionAPI;
		registerUserAgentRenderer(pi);
		const identityTheme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as Theme;

		const rendered = renderDetached
			?.({ data: { sessionId: "0199-abcd" } }, { expanded: false }, identityTheme)
			?.render(120)
			.join("\n");

		expect(rendered?.trim()).toBe("Detached session 0199-abcd");
		expect(
			renderDetached?.({}, { expanded: false }, identityTheme),
			"Expected an entry with no data to render nothing rather than a broken line",
		).toBeUndefined();
	});
});

describe("attached session entry", () => {
	test("names the session that came back, and stays quiet without one", () => {
		initTheme(undefined, false);
		type RenderedComponent = { render(width: number): string[] } | undefined;
		let renderAttached:
			| ((
					entry: { data?: AttachedEntryData },
					options: { expanded: boolean },
					theme: Theme,
			  ) => RenderedComponent)
			| undefined;
		const pi = {
			registerMessageRenderer: () => undefined,
			registerEntryRenderer: (customType: string, renderer: typeof renderAttached) => {
				if (customType === ATTACHED_ENTRY_TYPE) renderAttached = renderer;
			},
		} as unknown as ExtensionAPI;
		registerUserAgentRenderer(pi);
		const identityTheme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as Theme;

		const rendered = renderAttached
			?.({ data: { sessionId: "0199-abcd" } }, { expanded: false }, identityTheme)
			?.render(120)
			.join("\n");

		expect(rendered?.trim()).toBe("Attached session 0199-abcd");
		expect(
			renderAttached?.({}, { expanded: false }, identityTheme),
			"Expected an entry with no data to render nothing rather than a broken line",
		).toBeUndefined();
	});
});

describe("command error cards", () => {
	test("carry no context label: a command error has no inherited-or-isolated notion", () => {
		const sent: Array<{ details?: { inheritedContext?: boolean } }> = [];
		const pi = {
			sendMessage: (message: { details?: { inheritedContext?: boolean } }) => sent.push(message),
		} as unknown as ExtensionAPI;
		const headlessContext = { hasUI: false } as never;

		reportCommandError(pi, "agent-attach", "ffff", headlessContext, "No agent session matches");
		reportCommandError(pi, "agent", "-m", headlessContext, "Usage");

		expect(sent).toHaveLength(2);
		for (const message of sent) {
			expect(
				message.details?.inheritedContext,
				"Expected no isolated/inherited-context claim on an error card",
			).toBeUndefined();
		}
	});
});
