import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
	AgentEntryData,
	AgentResultMessage,
	ExtensionAPI,
	RunningAgent,
	Theme,
} from "../shared.js";
import {
	buildAgentResultMessage,
	formatStartNotification,
	registerUserAgentRenderer,
} from "../transcript.js";

function completedAgent(): RunningAgent {
	return {
		id: "user-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "review the migration",
		invocation: "/agent review the migration",
		notifyMainAgent: false,
		mainContextState: "separate",
		status: "posted",
		startedAt: 1_000,
		turnStartedAt: 1_000,
		completedAt: 2_000,
		activeTools: new Map<string, string>(),
		toolUses: 2,
		turnCount: 1,
		responseText: "migration reviewed",
		inheritedMessageCount: 0,
		finished: Promise.resolve(),
	};
}

describe("agent chat events", () => {
	test("the start event shows only a scheduled main-context join", () => {
		const agent = completedAgent();
		expect(formatStartNotification(agent)).not.toContain("join context");

		agent.mainContextState = "will-join";
		expect(formatStartNotification(agent)).toContain("will join context");
	});
});

describe("buildAgentResultMessage", () => {
	test("builds one canonical payload whose visible and hidden forms differ only by display", () => {
		const agent = completedAgent();
		const outcome = { ok: true, response: agent.responseText } as const;
		const visible = buildAgentResultMessage(agent, outcome, { display: true });
		const hidden = buildAgentResultMessage(agent, outcome, { display: false });

		expect({ ...hidden, display: true }).toEqual(visible);
		expect(hidden.content).toContain("<user_invocation>\n/agent review the migration\n</user_invocation>");
		expect(hidden.content).toContain("<task>\nreview the migration\n</task>");
		expect(hidden.content).toContain("<response>\nmigration reviewed\n</response>");
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
			registerMessageRenderer: (_customType: string, renderer: typeof renderMessage) => {
				renderMessage = renderer;
			},
			registerEntryRenderer: (_customType: string, renderer: typeof renderEntry) => {
				renderEntry = renderer;
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
			"The persisted response remains available after the child session is disposed.",
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
		expect(output).not.toContain("join context");

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
				"The persisted response remains available after the child session is disposed.",
			);
		}

		message.details.mainContextState = "will-join";
		const pendingOutput = component?.render(120).join("\n");
		expect(pendingOutput).toContain("will join context");

		message.details.mainContextState = "joined";
		const joinedOutput = component?.render(120).join("\n");
		expect(joinedOutput).toContain("joined context");

		const legacyAgent = completedAgent();
		legacyAgent.responseText = "A full response from an older persisted entry.";
		const legacyMessage = buildAgentResultMessage(
			legacyAgent,
			{ ok: true, response: legacyAgent.responseText },
			{ display: false },
		);
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
