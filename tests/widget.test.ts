import { describe, expect, test } from "bun:test";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type {
	AgentMessage,
	AgentResultMessage,
	RunningAgent,
	Theme,
	UIContext,
} from "../shared.js";
import { renderContextMeter, UserAgentWidget } from "../widget.ts";

describe("renderContextMeter", () => {
	test("fills from the shortest white block to a full red block", () => {
		expect(renderContextMeter(0)).toBe("\x1b[38;2;255;255;255m▁\x1b[39m");
		expect(renderContextMeter(100)).toBe("\x1b[38;2;255;0;0m█\x1b[39m");
	});

	test("maps context usage into exactly eight visible percentage bins", () => {
		const meters = Array.from({ length: 8 }, (_, index) => renderContextMeter(index * 12.5));
		const symbols = meters.map((meter) => meter.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(symbols).toEqual(["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]);
		expect(new Set(meters).size).toBe(8);
		expect(renderContextMeter(null)).toBe("");
		expect(renderContextMeter(undefined)).toBe("");
	});
});

type ContextUsage = ReturnType<NonNullable<RunningAgent["session"]>["getContextUsage"]>;

function renderRunningHeader(
	contextUsage: ContextUsage,
	overrides: Partial<Pick<RunningAgent, "startedAt" | "turnStartedAt">> = {},
): string {
	const now = Date.now();
	const runningAgent = {
		id: "user-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "plan the migration",
		invocation: "/agent plan the migration",
		notifyMainAgent: false,
		status: "running",
		startedAt: overrides.startedAt ?? now,
		turnStartedAt: overrides.turnStartedAt ?? now,
		activeTools: new Map<string, string>(),
		toolUses: 0,
		turnCount: 0,
		responseText: "",
		inheritedMessageCount: 0,
		session:
			contextUsage === undefined
				? undefined
				: ({ getContextUsage: () => contextUsage } as unknown as NonNullable<
						RunningAgent["session"]
					>),
		finished: Promise.resolve(),
	} satisfies RunningAgent;
	const widget = new UserAgentWidget(new Set([runningAgent]), () => undefined);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
	const tui = { requestRender: () => undefined } as unknown as TUI;
	let component: Component | undefined;
	const ui = {
		onTerminalInput: () => () => undefined,
		getEditorText: () => "",
		setWidget: (_key: string, content: unknown) => {
			if (typeof content === "function") component = content(tui, theme);
		},
	} as unknown as UIContext;

	widget.setUI(ui);
	widget.update();
	return component?.render(120).find((line) => line.includes("/agent")) ?? "";
}

describe("UserAgentWidget context meter", () => {
	test("renders live SDK context usage between the command and user prompt", () => {
		const header = renderRunningHeader({ tokens: 100_000, contextWindow: 200_000, percent: 50 });
		const meter = renderContextMeter(50);

		expect(header.indexOf("/agent")).toBeLessThan(header.indexOf(meter));
		expect(header.indexOf(meter)).toBeLessThan(header.indexOf("plan the migration"));
	});

	test("renders no meter when runtime context usage is unavailable", () => {
		expect(renderRunningHeader(undefined)).not.toMatch(/[▁▂▃▄▅▆▇█]/);
	});
});

describe("UserAgentWidget per-turn duration", () => {
	test("reports the current turn's duration, not the whole session lifetime, for a resumed running agent", () => {
		const now = Date.now();
		const header = renderRunningHeader(undefined, {
			startedAt: now - 60_000,
			turnStartedAt: now - 3_000,
		});

		expect(header).toContain("3.0s");
		expect(header).not.toContain("1m");
	});
});

describe("UserAgentWidget steering", () => {
	test("resumes following the transcript tail when steering is committed", () => {
		const messages = Array.from({ length: 12 }, (_, index) => ({
			role: "user",
			content: [{ type: "text", text: `message ${index}` }],
			timestamp: index,
		})) as AgentMessage[];
		const steeredMessages: string[] = [];
		const session = {
			isStreaming: true,
			agent: { state: { messages } },
			steer: async (message: string) => {
				steeredMessages.push(message);
			},
			getContextUsage: () => undefined,
		} as unknown as NonNullable<RunningAgent["session"]>;
		const runningAgent = {
			id: "user-1",
			command: "agent",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/agent plan the migration",
			notifyMainAgent: false,
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			inheritedMessageCount: 0,
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const joinedResults: AgentResultMessage[] = [];
		const widget = new UserAgentWidget(new Set([runningAgent]), (message) =>
			joinedResults.push(message),
		);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
			underline: (text: string) => text,
			strikethrough: (text: string) => text,
		} as unknown as Theme;
		const tui = {
			terminal: { columns: 120, rows: 20 },
			requestRender: () => undefined,
		} as unknown as TUI;
		let terminalInput = (_data: string): unknown => undefined;
		let viewer: Component | undefined;
		const ui = {
			onTerminalInput: (handler: typeof terminalInput) => {
				terminalInput = handler;
				return () => undefined;
			},
			getEditorText: () => "",
			setWidget: () => undefined,
			custom: (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: unknown,
					done: (result: undefined) => void,
				) => Component,
			) => {
				viewer = factory(tui, theme, undefined, () => undefined);
				return new Promise<undefined>(() => undefined);
			},
		} as unknown as UIContext;

		widget.setUI(ui);
		widget.update();
		terminalInput("\x1b[B");
		terminalInput("\r");
		if (!viewer) throw new Error("Agent viewer did not open");

		expect(viewer.render(80).join("\n")).toContain("message 11");
		expect(viewer.render(80).join("\n")).not.toContain("j join");
		viewer.handleInput?.("j");
		expect(runningAgent.notifyMainAgent).toBe(false);
		expect(joinedResults).toEqual([]);

		viewer.handleInput?.("\x1b[H");
		expect(viewer.render(80).join("\n")).toContain("message 0");
		viewer.handleInput?.("\r");
		for (const character of "focus on tests") viewer.handleInput?.(character);
		viewer.handleInput?.("\r");

		expect(steeredMessages).toEqual(["focus on tests"]);
		const rendered = viewer.render(80).join("\n");
		expect(rendered).toContain("message 11");
		expect(rendered).not.toContain("message 0");
	});
});

describe("UserAgentWidget completed overlay", () => {
	test("keeps the agent on Esc and disposes it on x", async () => {
		const completedAgent = {
			id: "user-1",
			command: "agent",
			inheritedContext: false,
			model: "provider/model",
			modelLabel: "model",
			task: "finish the task",
			invocation: "/agent-isolated finish the task",
			notifyMainAgent: false,
			status: "posted",
			startedAt: Date.now() - 1_000,
			turnStartedAt: Date.now() - 1_000,
			completedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 1,
			responseText: "finished response",
			inheritedMessageCount: 0,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const resultMessage: AgentResultMessage = {
			customType: "pi-user-agents",
			content: "<user_agent>finished response</user_agent>",
			display: false,
			details: {
				command: "agent",
				inheritedContext: false,
				model: "provider/model",
				modelLabel: "model",
				task: "finish the task",
				ok: true,
			},
		};
		const joinedResults: AgentResultMessage[] = [];
		const widget = new UserAgentWidget(new Set(), (message) => joinedResults.push(message));
		widget.addCompleted(completedAgent, resultMessage, { joinable: true });
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
			underline: (text: string) => text,
			strikethrough: (text: string) => text,
		} as unknown as Theme;
		const tui = {
			terminal: { columns: 120, rows: 20 },
			requestRender: () => undefined,
		} as unknown as TUI;
		let terminalInput = (_data: string): unknown => undefined;
		let widgetComponent: Component | undefined;
		let viewer: Component | undefined;
		const ui = {
			onTerminalInput: (handler: typeof terminalInput) => {
				terminalInput = handler;
				return () => undefined;
			},
			getEditorText: () => "",
			setWidget: (_key: string, content: unknown) => {
				if (typeof content === "function") widgetComponent = content(tui, theme);
			},
			custom: (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: unknown,
					done: (result: "hide" | "dispose") => void,
				) => Component,
			) => {
				return new Promise<"hide" | "dispose">((resolve) => {
					viewer = factory(tui, theme, undefined, resolve);
				});
			},
		} as unknown as UIContext;

		widget.setUI(ui);
		widget.update();
		terminalInput("\x1b[B");
		terminalInput("\r");
		if (!viewer || !widgetComponent) throw new Error("Completed agent viewer did not open");

		expect(viewer.render(100).join("\n")).toContain("x dispose");
		expect(viewer.render(100).join("\n")).toContain("j join");
		viewer.handleInput?.("j");
		expect(joinedResults).toEqual([resultMessage]);
		expect(viewer.render(100).join("\n")).not.toContain("j join");
		viewer.handleInput?.("\x1b");
		await Promise.resolve();
		expect(widgetComponent.render(100).join("\n")).toContain("/agent");

		terminalInput("\r");
		if (!viewer) throw new Error("Completed agent viewer did not reopen");
		viewer.handleInput?.("x");
		await Promise.resolve();
		expect(widgetComponent.render(100)).toEqual([]);
	});
});

type IdleHarness = {
	agent: RunningAgent;
	widget: UserAgentWidget;
	widgetComponent: () => Component;
	viewer: () => Component;
	openViewer: () => void;
	sendWidgetKey: (data: string) => void;
	joinedResults: AgentResultMessage[];
	steeredMessages: string[];
	resumedInstructions: string[];
	retireCalls: () => number;
	settleViewer: () => Promise<void>;
};

function buildIdleHarness(): IdleHarness {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hello how are you?" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "fine how are you?" }],
			timestamp: 2,
			stopReason: "stop",
		},
	] as AgentMessage[];
	const steeredMessages: string[] = [];
	const session = {
		isStreaming: false,
		agent: { state: { messages } },
		steer: async (message: string) => {
			steeredMessages.push(message);
		},
		abort: async () => undefined,
		getContextUsage: () => undefined,
	} as unknown as NonNullable<RunningAgent["session"]>;
	const resumedInstructions: string[] = [];
	let retired = 0;
	const pendingJoinMessage: AgentResultMessage = {
		customType: "pi-user-agents",
		content: "<user_agent>fine how are you?</user_agent>",
		display: false,
		details: {
			command: "agent",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "hello how are you?",
			ok: true,
		},
	};
	const agent = {
		id: "user-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "hello how are you?",
		invocation: "/agent hello how are you?",
		notifyMainAgent: false,
		status: "idle",
		startedAt: Date.now() - 60_000,
		turnStartedAt: Date.now() - 3_000,
		completedAt: Date.now(),
		activeTools: new Map<string, string>(),
		toolUses: 0,
		turnCount: 1,
		responseText: "fine how are you?",
		inheritedMessageCount: 0,
		session,
		pendingJoinMessage,
		resume: (instruction: string) => {
			resumedInstructions.push(instruction);
		},
		retire: () => {
			retired += 1;
		},
		finished: Promise.resolve(),
	} satisfies RunningAgent;
	const joinedResults: AgentResultMessage[] = [];
	const widget = new UserAgentWidget(new Set([agent]), (message) => joinedResults.push(message));
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
	const tui = {
		terminal: { columns: 120, rows: 20 },
		requestRender: () => undefined,
	} as unknown as TUI;
	let terminalInput = (_data: string): unknown => undefined;
	let widgetComponent: Component | undefined;
	let viewer: Component | undefined;
	let viewerDone: Promise<unknown> = Promise.resolve();
	const ui = {
		onTerminalInput: (handler: typeof terminalInput) => {
			terminalInput = handler;
			return () => undefined;
		},
		getEditorText: () => "",
		setWidget: (_key: string, content: unknown) => {
			if (typeof content === "function") widgetComponent = content(tui, theme);
		},
		custom: (
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: unknown,
				done: (result: "hide" | "dispose") => void,
			) => Component,
		) => {
			viewerDone = new Promise<"hide" | "dispose">((resolve) => {
				viewer = factory(tui, theme, undefined, resolve);
			});
			return viewerDone;
		},
	} as unknown as UIContext;

	widget.setUI(ui);
	widget.update();
	return {
		agent,
		widget,
		widgetComponent: () => {
			if (!widgetComponent) throw new Error("Widget did not render");
			return widgetComponent;
		},
		viewer: () => {
			if (!viewer) throw new Error("Agent viewer did not open");
			return viewer;
		},
		openViewer: () => {
			terminalInput("\x1b[B");
			terminalInput("\r");
		},
		sendWidgetKey: (data: string) => {
			terminalInput(data);
		},
		joinedResults,
		steeredMessages,
		resumedInstructions,
		retireCalls: () => retired,
		settleViewer: async () => {
			await viewerDone;
		},
	};
}

describe("UserAgentWidget idle (turn-complete, alive) agents", () => {
	test("renders an idle agent as a green-checked turn-complete entry with its response preview", () => {
		const harness = buildIdleHarness();
		const lines = harness.widgetComponent().render(120);

		expect(lines[0]).toContain("✓ User agents");
		const header = lines.find((line) => line.includes("/agent")) ?? "";
		expect(header).toContain("✓");
		expect(header).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		expect(header).toContain("3.0s");
		expect(header).not.toContain("1m");
		expect(lines.join("\n")).toContain("fine how are you?");
	});

	test("overlay shows the idle status distinct from a disposed completed snapshot, and the current turn's duration", () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const rendered = harness.viewer().render(100).join("\n");

		expect(rendered).toContain("✓");
		expect(rendered).toContain("idle");
		expect(rendered).not.toContain("completed");
		expect(rendered).toContain("3.0s");
		expect(rendered).not.toContain("1m");
	});

	test("Enter in the overlay steers an idle agent by resuming a new turn, not by queueing into the session", () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const viewer = harness.viewer();

		expect(viewer.render(100).join("\n")).toContain("Enter steer");
		viewer.handleInput?.("\r");
		for (const character of "now translate it") viewer.handleInput?.(character);
		viewer.handleInput?.("\r");

		expect(harness.resumedInstructions).toEqual(["now translate it"]);
		expect(harness.steeredMessages).toEqual([]);
	});

	test("j joins the latest turn result, snapshots the agent, and retires the live session", () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const viewer = harness.viewer();

		expect(viewer.render(100).join("\n")).toContain("j join");
		viewer.handleInput?.("j");

		expect(harness.joinedResults.map((message) => message.content)).toEqual([
			"<user_agent>fine how are you?</user_agent>",
		]);
		expect(harness.agent.pendingJoinMessage).toBeUndefined();
		expect(harness.agent.status).toBe("posted");
		expect(harness.retireCalls()).toBe(1);
		expect(viewer.render(100).join("\n")).not.toContain("j join");
		const snapshotRow = harness.widgetComponent().render(120).join("\n");
		expect(snapshotRow).toContain("/agent");
		expect(snapshotRow).toContain("3.0s");
		expect(snapshotRow).not.toContain("1m");
	});

	test("x in the overlay retires an idle agent instead of leaving it parked", async () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const viewer = harness.viewer();

		expect(viewer.render(100).join("\n")).toContain("x dispose");
		viewer.handleInput?.("x");
		await harness.settleViewer();

		expect(harness.agent.aborted).toBe(true);
		expect(harness.retireCalls()).toBe(1);
	});

	test("x at the widget level retires an idle agent", () => {
		const harness = buildIdleHarness();
		expect(harness.widgetComponent().render(120).join("\n")).toContain("/agent");

		harness.sendWidgetKey("\x1b[B");
		harness.sendWidgetKey("x");

		expect(harness.agent.aborted).toBe(true);
		expect(harness.retireCalls()).toBe(1);
	});
});
