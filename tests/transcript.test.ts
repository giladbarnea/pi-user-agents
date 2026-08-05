import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
	AgentEntryData,
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
	});
});

describe("completed agent transcript card", () => {
	test("renders the response preview with Pi Markdown", () => {
		initTheme(undefined, false);
		let renderEntry:
			| ((
					entry: { data?: AgentEntryData },
					options: unknown,
					theme: Theme,
			  ) => { render(width: number): string[] } | undefined)
			| undefined;
		const pi = {
			registerMessageRenderer: () => undefined,
			registerEntryRenderer: (_customType: string, renderer: typeof renderEntry) => {
				renderEntry = renderer;
			},
		} as unknown as ExtensionAPI;
		registerUserAgentRenderer(pi);

		const agent = completedAgent();
		agent.responseText = "**Almost.** One stale instruction remains.";
		const message = buildAgentResultMessage(
			agent,
			{ ok: true, response: agent.responseText },
			{ display: false },
		);
		const identityTheme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as Theme;
		const component = renderEntry?.(
			{ data: { content: message.content, details: message.details } },
			{},
			identityTheme,
		);
		const output = component?.render(120).join("\n");

		expect(output).toContain("⎿  Almost. One stale instruction remains.");
		expect(output).not.toContain("**Almost.**");
		expect(output).not.toContain("join context");

		message.details.mainContextState = "will-join";
		const pendingOutput = component?.render(120).join("\n");
		expect(pendingOutput).toContain("will join context");

		message.details.mainContextState = "joined";
		const joinedOutput = component?.render(120).join("\n");
		expect(joinedOutput).toContain("joined context");
	});
});
