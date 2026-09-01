import { describe, expect, test } from "bun:test";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { contextMeterColor, renderContextMeter } from "../context-meter.ts";
import type {
	AgentMessage,
	AgentResultMessage,
	RebaseDelivery,
	RunningAgent,
	Theme,
	UIContext,
} from "../shared.js";
import { TimedConfirmation } from "../shared.ts";
import { UserAgentWidget } from "../widget.ts";

/** A widget under test that must never rebase. */
const noRebase: RebaseDelivery = {
	canDeliver: () => false,
	deliver: () => {
		throw new Error("Unexpected rebase delivery");
	},
};

const meterTheme = {
	fg: (_color: string, text: string) => text,
} as Pick<Theme, "fg">;

describe("renderContextMeter", () => {
	test("fills from an empty cell to a full block", () => {
		expect(renderContextMeter(0, meterTheme)).toBe(" ");
		expect(renderContextMeter(100, meterTheme)).toBe("█");
	});

	test("matches the custom footer's nine visual levels", () => {
		const meters = [0, 12, 23, 34, 45, 56, 67, 78, 89].map((percent) =>
			renderContextMeter(percent, meterTheme),
		);

		expect(meters).toEqual([" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]);
		expect(renderContextMeter(25, meterTheme)).toBe("▂");
		expect(new Set(meters).size).toBe(9);
		expect(renderContextMeter(null, meterTheme)).toBe("");
		expect(renderContextMeter(undefined, meterTheme)).toBe("");
	});

	test("uses the custom footer's semantic color thresholds", () => {
		expect(contextMeterColor(39.9)).toBe("dim");
		expect(contextMeterColor(40)).toBe("muted");
		expect(contextMeterColor(65)).toBe("warning");
		expect(contextMeterColor(85)).toBe("error");
	});
});

type ContextUsage = ReturnType<NonNullable<RunningAgent["session"]>["getContextUsage"]>;

function renderRunningHeader(
	contextUsage: ContextUsage,
	overrides: Partial<
		Pick<RunningAgent, "startedAt" | "turnStartedAt" | "mainContextState">
	> = {},
): string {
	const now = Date.now();
	const runningAgent = {
		id: "user-1",
		sessionId: "session-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "plan the migration",
		invocation: "/agent plan the migration",
		notifyMainAgent: false,
		dispatchBaseFingerprint: "[]",
		mainContextState: overrides.mainContextState ?? "separate",
		status: "running",
		startedAt: overrides.startedAt ?? now,
		turnStartedAt: overrides.turnStartedAt ?? now,
		activeTools: new Map<string, string>(),
		toolUses: 0,
		turnCount: 0,
		responseText: "",
		conversationMessages: [],
		session:
			contextUsage === undefined
				? undefined
				: ({ getContextUsage: () => contextUsage } as unknown as NonNullable<
						RunningAgent["session"]
					>),
		finished: Promise.resolve(),
	} satisfies RunningAgent;
	const widget = new UserAgentWidget(new Set([runningAgent]), () => undefined, () => undefined, noRebase);
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
		const meter = renderContextMeter(50, meterTheme);

		expect(header.indexOf("/agent")).toBeLessThan(header.indexOf(meter));
		expect(header.indexOf(meter)).toBeLessThan(header.indexOf("plan the migration"));
	});

	test("renders no meter when runtime context usage is unavailable", () => {
		expect(renderRunningHeader(undefined)).not.toMatch(/[▁▂▃▄▅▆▇█]/);
	});
});

describe("UserAgentWidget main-context state", () => {
	test("renders a scheduled squash while the response is in flight", () => {
		const header = renderRunningHeader(undefined, { mainContextState: "will-squash" });

		expect(header).toContain("will squash into context");
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
	test("Ctrl+x interrupts, and d d detaches a selected running agent and announces its session", () => {
		let abortCalls = 0;
		const detachedSessionIds: string[] = [];
		const session = {
			isStreaming: true,
			agent: { state: { messages: [] } },
			abort: async () => {
				abortCalls += 1;
			},
			getContextUsage: () => undefined,
		} as unknown as NonNullable<RunningAgent["session"]>;
		const runningAgent = {
			id: "user-1",
			sessionId: "session-1",
			command: "agent",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/agent plan the migration",
			notifyMainAgent: false,
			dispatchBaseFingerprint: "[]",
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			conversationMessages: [],
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const widget = new UserAgentWidget(
			new Set([runningAgent]),
			() => undefined,
			(sessionId) => detachedSessionIds.push(sessionId),
			noRebase,
		);
		let terminalInput = (_data: string): unknown => undefined;
		const ui = {
			onTerminalInput: (handler: typeof terminalInput) => {
				terminalInput = handler;
				return () => undefined;
			},
			getEditorText: () => "",
			setWidget: () => undefined,
		} as unknown as UIContext;

		widget.setUI(ui);
		widget.update();
		terminalInput("\x1b[B");
		terminalInput("\x18");

		expect(abortCalls).toBe(1);
		expect(runningAgent.aborted).toBeUndefined();

		terminalInput("d");
		expect(abortCalls).toBe(1);
		expect(runningAgent.aborted).toBeUndefined();
		terminalInput("d");
		expect(abortCalls).toBe(2);
		expect(runningAgent.aborted).toBe(true);
		expect(
			detachedSessionIds,
			"Expected detaching to announce the child session the user can still resume",
		).toEqual(["session-1"]);
	});

	test("Ctrl+x interrupts, and d d asks the overlay to detach a running agent", () => {
		let abortCalls = 0;
		const session = {
			isStreaming: true,
			agent: { state: { messages: [] } },
			abort: async () => {
				abortCalls += 1;
			},
			getContextUsage: () => undefined,
		} as unknown as NonNullable<RunningAgent["session"]>;
		const runningAgent = {
			id: "user-1",
			sessionId: "session-1",
			command: "agent",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/agent plan the migration",
			notifyMainAgent: false,
			dispatchBaseFingerprint: "[]",
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			conversationMessages: [],
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const widget = new UserAgentWidget(new Set([runningAgent]), () => undefined, () => undefined, noRebase);
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
		let viewerAction: "hide" | "detach" | undefined;
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
					done: (result: "hide" | "detach") => void,
				) => Component,
			) => {
				viewer = factory(tui, theme, undefined, (action) => {
					viewerAction = action;
				});
				return new Promise<"hide" | "detach">(() => undefined);
			},
		} as unknown as UIContext;

		widget.setUI(ui);
		widget.update();
		terminalInput("\x1b[B");
		terminalInput("\r");
		if (!viewer) throw new Error("Agent viewer did not open");

		expect(viewer.render(100).join("\n")).toContain("Ctrl+x interrupt");
		expect(viewer.render(100).join("\n")).toContain("d detach");
		viewer.handleInput?.("\x18");

		expect(abortCalls).toBe(1);
		expect(runningAgent.aborted).toBeUndefined();
		viewer.handleInput?.("d");
		expect(viewerAction).toBeUndefined();
		expect(viewer.render(100).join("\n")).toContain("d again to confirm");
		viewer.handleInput?.("d");
		expect(viewerAction).toBe("detach");
	});

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
			sessionId: "session-1",
			command: "agent",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/agent plan the migration",
			notifyMainAgent: false,
			dispatchBaseFingerprint: "[]",
			status: "running",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "",
			conversationMessages: messages,
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const squashedResults: AgentResultMessage[] = [];
		const widget = new UserAgentWidget(
			new Set([runningAgent]),
			(message) => squashedResults.push(message),
			() => undefined,
			noRebase,
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
		expect(viewer.render(80).join("\n")).not.toContain("s squash");
		viewer.handleInput?.("s");
		expect(runningAgent.notifyMainAgent).toBe(false);
		expect(squashedResults).toEqual([]);

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
	test("keeps the agent on Esc and detaches it on d d, announcing its session", async () => {
		const completedAgent = {
			id: "user-1",
			sessionId: "session-1",
			command: "agent",
			inheritedContext: false,
			model: "provider/model",
			modelLabel: "model",
			task: "finish the task",
			invocation: "/agent -i finish the task",
			notifyMainAgent: false,
			dispatchBaseFingerprint: "[]",
			mainContextState: "separate",
			status: "posted",
			startedAt: Date.now() - 1_000,
			turnStartedAt: Date.now() - 1_000,
			completedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 1,
			responseText: "finished response",
			conversationMessages: [],
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
		const squashedResults: AgentResultMessage[] = [];
		const detachedSessionIds: string[] = [];
		const widget = new UserAgentWidget(
			new Set(),
			(message) => squashedResults.push(message),
			(sessionId) => detachedSessionIds.push(sessionId),
			noRebase,
		);
		widget.addCompleted(completedAgent, resultMessage, { squashable: true });
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
					done: (result: "hide" | "detach") => void,
				) => Component,
			) => {
				return new Promise<"hide" | "detach">((resolve) => {
					viewer = factory(tui, theme, undefined, resolve);
				});
			},
		} as unknown as UIContext;

		widget.setUI(ui);
		widget.update();
		terminalInput("\x1b[B");
		terminalInput("\r");
		if (!viewer || !widgetComponent) throw new Error("Completed agent viewer did not open");

		expect(viewer.render(100).join("\n")).toContain("d detach");
		expect(viewer.render(100).join("\n")).toContain("s squash");
		viewer.handleInput?.("s");
		expect(squashedResults).toEqual([resultMessage]);
		expect(viewer.render(100).join("\n")).not.toContain("s squash");
		viewer.handleInput?.("\x1b");
		await Promise.resolve();
		expect(widgetComponent.render(100).join("\n")).toContain("/agent");

		terminalInput("\r");
		if (!viewer) throw new Error("Completed agent viewer did not reopen");
		viewer.handleInput?.("d");
		expect(viewer.render(100).join("\n")).toContain("d again to confirm");
		expect(widgetComponent.render(100).join("\n")).toContain("/agent");
		expect(detachedSessionIds, "Expected no announcement before the second d").toEqual([]);
		viewer.handleInput?.("d");
		await Promise.resolve();
		expect(widgetComponent.render(100)).toEqual([]);
		expect(
			detachedSessionIds,
			"Expected detaching a completed agent to announce its session, which stays on disk",
		).toEqual(["session-1"]);
	});
});

type IdleHarness = {
	agent: RunningAgent;
	widget: UserAgentWidget;
	widgetComponent: () => Component;
	viewer: () => Component;
	openViewer: () => void;
	sendWidgetKey: (data: string) => void;
	squashedResults: AgentResultMessage[];
	detachedSessionIds: string[];
	steeredMessages: string[];
	resumedInstructions: string[];
	retireCalls: () => number;
	foregroundCalls: Array<{ color: string; text: string }>;
	settleViewer: () => Promise<void>;
};

function buildIdleHarness(
	contextUsage: ContextUsage = undefined,
	rebaseDelivery: RebaseDelivery = noRebase,
	extraAgents: RunningAgent[] = [],
): IdleHarness {
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
		getContextUsage: () => contextUsage,
	} as unknown as NonNullable<RunningAgent["session"]>;
	const resumedInstructions: string[] = [];
	let retired = 0;
	const pendingSquashMessage: AgentResultMessage = {
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
		sessionId: "session-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "hello how are you?",
		invocation: "/agent hello how are you?",
		notifyMainAgent: false,
		dispatchBaseFingerprint: "[]",
		mainContextState: "separate",
		status: "idle",
		startedAt: Date.now() - 60_000,
		turnStartedAt: Date.now() - 3_000,
		completedAt: Date.now(),
		activeTools: new Map<string, string>(),
		toolUses: 0,
		turnCount: 1,
		responseText: "fine how are you?",
		conversationMessages: messages,
		session,
		pendingSquashMessage,
		resume: (instruction: string) => {
			resumedInstructions.push(instruction);
		},
		retire: () => {
			retired += 1;
		},
		finished: Promise.resolve(),
	} satisfies RunningAgent;
	const squashedResults: AgentResultMessage[] = [];
	const detachedSessionIds: string[] = [];
	const widget = new UserAgentWidget(
		new Set([agent, ...extraAgents]),
		(message) => squashedResults.push(message),
		(sessionId) => detachedSessionIds.push(sessionId),
		rebaseDelivery,
	);
	const foregroundCalls: Array<{ color: string; text: string }> = [];
	const theme = {
		fg: (color: string, text: string) => {
			foregroundCalls.push({ color, text });
			return text;
		},
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
				done: (result: "hide" | "detach") => void,
			) => Component,
		) => {
			viewerDone = new Promise<"hide" | "detach">((resolve) => {
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
		squashedResults,
		detachedSessionIds,
		steeredMessages,
		resumedInstructions,
		retireCalls: () => retired,
		foregroundCalls,
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

	test("overlay shows the idle status distinct from a detached completed snapshot, and the current turn's duration", () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const rendered = harness.viewer().render(100).join("\n");

		expect(rendered).toContain("✓");
		expect(rendered).toContain("idle");
		expect(rendered).not.toContain("completed");
		expect(rendered).toContain("3.0s");
		expect(rendered).not.toContain("1m");
		expect(rendered).not.toContain("into context");
	});

	test("reuses the live context meter as overlay metadata", () => {
		const harness = buildIdleHarness({ tokens: 100_000, contextWindow: 200_000, percent: 50 });
		const meter = renderContextMeter(50, meterTheme);
		const widgetHeader =
			harness.widgetComponent().render(100).find((line) => line.includes("/agent")) ?? "";
		harness.openViewer();
		const overlayHeader =
			harness.viewer().render(100).find((line) => line.includes("/agent")) ?? "";

		expect(widgetHeader.indexOf("/agent")).toBeLessThan(widgetHeader.indexOf(meter));
		expect(widgetHeader.indexOf(meter)).toBeLessThan(
			widgetHeader.indexOf("hello how are you?"),
		);
		expect(overlayHeader).toContain(`model · ${meter} · idle`);
	});

	test("shows the agent's own session id in the overlay header, for /resume after detaching", () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const overlayHeader =
			harness.viewer().render(100).find((line) => line.includes("/agent")) ?? "";

		expect(overlayHeader).toContain(harness.agent.sessionId);
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

	test("s squashes the latest turn result, snapshots the agent, and retires the live session", () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const viewer = harness.viewer();

		expect(viewer.render(100).join("\n")).toContain("s squash");
		viewer.handleInput?.("s");

		expect(harness.squashedResults.map((message) => message.content)).toEqual([
			"<user_agent>fine how are you?</user_agent>",
		]);
		expect(harness.agent.pendingSquashMessage).toBeUndefined();
		expect(harness.agent.status).toBe("posted");
		expect(harness.retireCalls()).toBe(1);
		expect(viewer.render(100).join("\n")).not.toContain("s squash");
		expect(viewer.render(100).join("\n")).toContain("will squash into context");
		let snapshotRow = harness.widgetComponent().render(120).join("\n");
		expect(snapshotRow).toContain("will squash into context");

		expect(harness.widget.confirmMainContextSquash(harness.agent.id)).toBe(true);
		expect(viewer.render(100).join("\n")).toContain("squashed messages into context");
		snapshotRow = harness.widgetComponent().render(120).join("\n");
		expect(snapshotRow).toContain("squashed messages into context");
		expect(snapshotRow).toContain("/agent");
		expect(snapshotRow).toContain("3.0s");
		expect(snapshotRow).not.toContain("1m");
	});

	test("d d in the overlay retires an idle agent instead of leaving it parked", async () => {
		const harness = buildIdleHarness();
		harness.openViewer();
		const viewer = harness.viewer();

		expect(viewer.render(100).join("\n")).toContain("d detach");
		viewer.handleInput?.("d");
		expect(viewer.render(100).join("\n")).toContain("d again to confirm");
		expect(harness.foregroundCalls).toContainEqual({
			color: "error",
			text: "d again to confirm",
		});
		expect(harness.agent.aborted).toBeUndefined();
		viewer.handleInput?.("d");
		await harness.settleViewer();

		expect(harness.agent.aborted).toBe(true);
		expect(harness.retireCalls()).toBe(1);
		expect(harness.detachedSessionIds).toEqual(["session-1"]);
	});

	test("d d at the widget level retires an idle agent", () => {
		const harness = buildIdleHarness();
		expect(harness.widgetComponent().render(120).join("\n")).toContain("/agent");

		harness.sendWidgetKey("\x1b[B");
		harness.sendWidgetKey("d");
		expect(harness.widgetComponent().render(120).join("\n")).toContain("d again to confirm");
		expect(harness.foregroundCalls).toContainEqual({
			color: "error",
			text: "d again to confirm",
		});
		expect(harness.agent.aborted).toBeUndefined();
		harness.sendWidgetKey("d");

		expect(harness.agent.aborted).toBe(true);
		expect(harness.retireCalls()).toBe(1);
		expect(harness.detachedSessionIds).toEqual(["session-1"]);
	});
});

describe("UserAgentWidget rebase", () => {
	test("r rebases the child conversation onto the main session, retires it, and closes the overlay", async () => {
		const delivered: Array<{ agentId: string; roles: string[]; firstContent: unknown }> = [];
		const harness = buildIdleHarness(undefined, {
			canDeliver: () => true,
			deliver: (agent, messages) =>
				delivered.push({
					agentId: agent.id,
					roles: messages.map((message) => message.role),
					firstContent: messages[0]?.content,
				}),
		});
		harness.openViewer();
		const viewer = harness.viewer();

		expect(viewer.render(100).join("\n")).toContain("r rebase");
		viewer.handleInput?.("r");
		await harness.settleViewer();

		expect(delivered, "Expected one rebase delivery of the raw child conversation").toEqual([
			{
				agentId: "user-1",
				roles: ["user", "assistant"],
				firstContent: "hello how are you?",
			},
		]);
		expect(harness.squashedResults, "Expected rebase to bypass the squash channel").toEqual([]);
		expect(harness.agent.pendingSquashMessage).toBeUndefined();
		expect(harness.agent.status).toBe("posted");
		expect(harness.agent.mainContextState).toBe("rebased");
		expect(harness.retireCalls()).toBe(1);
		expect(harness.widgetComponent().render(120).join("\n")).toContain("rebased into context");
	});

	test("r is withheld while the main session has drifted, leaving squash available", () => {
		const delivered: unknown[] = [];
		const harness = buildIdleHarness(undefined, {
			canDeliver: () => false,
			deliver: (...args) => delivered.push(args),
		});
		harness.openViewer();
		const viewer = harness.viewer();

		expect(viewer.render(100).join("\n")).not.toContain("r rebase");
		expect(viewer.render(100).join("\n")).toContain("s squash");
		viewer.handleInput?.("r");

		expect(delivered).toEqual([]);
		expect(harness.agent.pendingSquashMessage).toBeDefined();
		expect(harness.agent.status).toBe("idle");
	});
});

function secondaryAgent(
	sequence: number,
	status: RunningAgent["status"],
	retirements: string[],
): RunningAgent {
	return {
		id: `user-${sequence}`,
		sessionId: `session-${sequence}`,
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: `secondary task ${sequence}`,
		invocation: `/agent secondary task ${sequence}`,
		notifyMainAgent: false,
		dispatchBaseFingerprint: "[]",
		mainContextState: "separate",
		status,
		startedAt: Date.now(),
		turnStartedAt: Date.now(),
		activeTools: new Map<string, string>(),
		toolUses: 0,
		turnCount: status === "idle" ? 1 : 0,
		responseText: status === "idle" ? "parked response" : "",
		conversationMessages: [],
		retire: () => {
			retirements.push(`user-${sequence}`);
		},
		finished: Promise.resolve(),
	};
}

describe("UserAgentWidget rebase alongside other agents", () => {
	test("r is withheld while any agent is mid-turn", () => {
		const delivered: unknown[] = [];
		const harness = buildIdleHarness(
			undefined,
			{ canDeliver: () => true, deliver: (...args) => delivered.push(args) },
			[secondaryAgent(2, "running", [])],
		);
		harness.openViewer();
		const viewer = harness.viewer();

		expect(
			viewer.render(100).join("\n"),
			"Expected no rebase offer while a sibling agent is mid-turn: the reload would abort it",
		).not.toContain("r rebase");
		viewer.handleInput?.("r");

		expect(delivered).toEqual([]);
		expect(harness.agent.status).toBe("idle");
	});

	test("r detaches the other parked agents with breadcrumbs before the reload", async () => {
		const delivered: string[] = [];
		const retirements: string[] = [];
		const parked = secondaryAgent(2, "idle", retirements);
		const harness = buildIdleHarness(
			undefined,
			{ canDeliver: () => true, deliver: (agent) => delivered.push(agent.id) },
			[parked],
		);
		harness.openViewer();
		const viewer = harness.viewer();

		viewer.handleInput?.("r");
		expect(
			viewer.render(100).join("\n"),
			"Expected a confirmation before detaching sibling sessions",
		).toContain("Rebase will detach 1 other agent session. r again to confirm");
		expect(delivered).toEqual([]);
		expect(harness.detachedSessionIds).toEqual([]);

		viewer.handleInput?.("\x1b[B");
		viewer.handleInput?.("r");
		expect(delivered, "Expected another key to cancel the pending confirmation").toEqual([]);
		expect(
			viewer.render(100).join("\n"),
			"Expected the cancelled confirmation to be offered again",
		).toContain("r again to confirm");

		viewer.handleInput?.("r");
		await harness.settleViewer();

		expect(delivered, "Expected only the target agent's conversation to be delivered").toEqual([
			"user-1",
		]);
		expect(
			harness.detachedSessionIds,
			"Expected the parked sibling to leave a resumable-session breadcrumb",
		).toEqual(["session-2"]);
		expect(parked.aborted).toBe(true);
		expect(retirements).toEqual(["user-2"]);
		expect(harness.agent.mainContextState).toBe("rebased");
	});
});

describe("UserAgentWidget rebase refusal warning", () => {
	test("r on a drifted main session shows a transient warning instead of doing nothing", () => {
		const delivered: unknown[] = [];
		const harness = buildIdleHarness(undefined, {
			canDeliver: () => false,
			deliver: (...args) => delivered.push(args),
		});
		harness.openViewer();
		const viewer = harness.viewer();

		viewer.handleInput?.("r");

		expect(delivered).toEqual([]);
		expect(viewer.render(100).join("\n")).toContain(
			"Can't rebase: the main session has drifted since dispatch",
		);
	});

	test("r while a sibling is mid-turn names the sibling as the reason", () => {
		const harness = buildIdleHarness(
			undefined,
			{ canDeliver: () => true, deliver: () => undefined },
			[secondaryAgent(2, "running", [])],
		);
		harness.openViewer();
		const viewer = harness.viewer();

		viewer.handleInput?.("r");

		expect(viewer.render(100).join("\n")).toContain("Can't rebase: another agent is mid-turn");
	});

	test("r with nothing deliverable stays silent", () => {
		const harness = buildIdleHarness(undefined, { canDeliver: () => true, deliver: () => undefined });
		harness.agent.pendingSquashMessage = undefined;
		harness.openViewer();
		const viewer = harness.viewer();

		viewer.handleInput?.("r");

		expect(viewer.render(100).join("\n")).not.toContain("Can't rebase");
	});
});

describe("TimedConfirmation", () => {
	test("arms on first press, confirms on repeat, re-arms on a new target, cancels, expires", async () => {
		let expirations = 0;
		const confirmation = new TimedConfirmation<string>(() => {
			expirations += 1;
		}, 20);

		expect(confirmation.press("detach"), "Expected the first press to arm, not confirm").toBe(false);
		expect(confirmation.isArmedOn("detach")).toBe(true);
		expect(confirmation.press("rebase"), "Expected a different target to re-arm, not confirm").toBe(
			false,
		);
		expect(confirmation.press("rebase")).toBe(true);
		expect(confirmation.isArmedOn("rebase"), "Expected confirming to disarm").toBe(false);

		confirmation.press("detach");
		confirmation.cancel();
		expect(confirmation.press("detach"), "Expected cancel to disarm").toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(confirmation.isArmedOn("detach"), "Expected the window to expire").toBe(false);
		expect(expirations).toBe(1);
	});
});

describe("UserAgentWidget attach queries", () => {
	function widgetWithRows(): {
		widget: UserAgentWidget;
		customCalls: unknown[];
	} {
		const runningAgent = {
			id: "user-1",
			sessionId: "0199aaaa-8b1a-7c3d-9e05-6a2f18d7b4ce",
			command: "agent",
			inheritedContext: true,
			model: "provider/model",
			modelLabel: "model",
			task: "plan the migration",
			invocation: "/agent plan the migration",
			notifyMainAgent: false,
			dispatchBaseFingerprint: "[]",
			mainContextState: "separate",
			status: "idle",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 1,
			responseText: "parked",
			conversationMessages: [],
			finished: Promise.resolve(),
		} satisfies RunningAgent;
		const completedSeed = {
			...runningAgent,
			id: "user-2",
			sessionId: "0199bbbb-1111-7abc-9e05-6a2f18d7b4ce",
			status: "posted",
		} satisfies RunningAgent;
		const widget = new UserAgentWidget(
			new Set([runningAgent]),
			() => undefined,
			() => undefined,
			noRebase,
		);
		widget.addCompleted(
			completedSeed,
			{
				customType: "pi-user-agents",
				content: "<user_agent>done</user_agent>",
				display: false,
				details: {
					agentId: "user-2",
					command: "agent",
					inheritedContext: true,
					model: "provider/model",
					modelLabel: "model",
					task: "audit the errors",
					ok: true,
				},
			},
			{ squashable: true },
		);
		const customCalls: unknown[] = [];
		const ui = {
			onTerminalInput: () => () => undefined,
			getEditorText: () => "",
			setWidget: () => undefined,
			custom: (...call: unknown[]) => {
				customCalls.push(call);
				return Promise.resolve("hide");
			},
		} as unknown as UIContext;
		widget.setUI(ui);
		return { widget, customCalls };
	}

	test("matchAttachedSessionIds matches live rows and completed cards by exact id or prefix", () => {
		const { widget } = widgetWithRows();

		expect(widget.matchAttachedSessionIds("0199aaaa-8b1a-7c3d-9e05-6a2f18d7b4ce")).toEqual([
			"0199aaaa-8b1a-7c3d-9e05-6a2f18d7b4ce",
		]);
		expect(widget.matchAttachedSessionIds("0199bbbb")).toEqual([
			"0199bbbb-1111-7abc-9e05-6a2f18d7b4ce",
		]);
		expect(widget.matchAttachedSessionIds("0199").sort()).toEqual([
			"0199aaaa-8b1a-7c3d-9e05-6a2f18d7b4ce",
			"0199bbbb-1111-7abc-9e05-6a2f18d7b4ce",
		]);
		expect(widget.matchAttachedSessionIds("ffff")).toEqual([]);
	});

	test("openViewer opens the overlay for a live row or a completed card, and refuses unknown ids", () => {
		const { widget, customCalls } = widgetWithRows();

		expect(widget.openViewer("0199aaaa-8b1a-7c3d-9e05-6a2f18d7b4ce")).toBe(true);
		expect(customCalls).toHaveLength(1);
		expect(widget.openViewer("0199bbbb-1111-7abc-9e05-6a2f18d7b4ce")).toBe(true);
		expect(customCalls).toHaveLength(2);
		expect(widget.openViewer("ffff")).toBe(false);
		expect(customCalls).toHaveLength(2);
	});
});
