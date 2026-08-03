import { describe, expect, test } from "bun:test";
import type { RunningAgent } from "../shared.js";
import { buildAgentResultMessage } from "../transcript.js";

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
		status: "posted",
		startedAt: 1_000,
		completedAt: 2_000,
		activeTools: new Map<string, string>(),
		toolUses: 2,
		turnCount: 1,
		responseText: "migration reviewed",
		inheritedMessageCount: 0,
		finished: Promise.resolve(),
	};
}

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
