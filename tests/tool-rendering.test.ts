import { describe, expect, test } from "bun:test";
import { getThemeByName } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type {
	Component,
	TUI,
} from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";
import type { AgentMessage, AgentStatus, RunningAgent, Theme, UIContext } from "../shared.js";
import { UserAgentWidget } from "../widget.ts";

/**
 * Historical tool rendering in the agent overlay.
 *
 * Every test drives the real overlay: a child-session transcript goes in, and the
 * strings the user would see come out. Nothing here reaches into the renderer's
 * internals, so the module boundary stays the implementer's choice.
 */

const CSI_PATTERN = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const OSC_HYPERLINK_PATTERN = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RULE_ROW_PATTERN = /^─+$/;

/** Strips colour and hyperlink escapes so assertions read the visible text. */
function plain(text: string): string {
	return text.replace(OSC_HYPERLINK_PATTERN, "").replace(CSI_PATTERN, "");
}

/**
 * Keeps only the transcript rows of the overlay frame, with the border columns
 * removed. The overlay's own header and footer are excluded, so a footer that
 * reads "12 lines" can never be mistaken for a tool result summary.
 */
function transcriptRows(frame: string[]): string[] {
	const rows = frame
		.map(plain)
		.filter((line) => line.startsWith("│"))
		.map((line) => line.slice(2, -2).trimEnd());
	const ruleIndices = rows.flatMap((row, index) => (RULE_ROW_PATTERN.test(row) ? [index] : []));
	const first = ruleIndices.at(0);
	const last = ruleIndices.at(-1);
	if (first === undefined || last === undefined || last <= first)
		throw new Error("Overlay frame did not contain the expected header and footer rules");
	return rows.slice(first + 1, last).filter((row) => row.length > 0);
}

function identityTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

type ToolCallSpec = { id: string; name: string; arguments: Record<string, unknown> };

function assistantCalls(...calls: ToolCallSpec[]): AgentMessage {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", ...call })),
		timestamp: 1,
		stopReason: "toolUse",
	} as unknown as AgentMessage;
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1,
		stopReason: "stop",
	} as unknown as AgentMessage;
}

function toolResult(spec: {
	toolCallId: string;
	toolName: string;
	text: string;
	details?: Record<string, unknown>;
	isError?: boolean;
}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: spec.toolCallId,
		toolName: spec.toolName,
		content: [{ type: "text", text: spec.text }],
		details: spec.details,
		isError: spec.isError ?? false,
		timestamp: 2,
	} as unknown as AgentMessage;
}

type Harness = {
	/** Transcript rows only, ANSI and overlay chrome removed. */
	rows: (width?: number) => string[];
	/** Transcript rows joined, ANSI and overlay chrome removed. */
	text: (width?: number) => string;
	/** The whole overlay frame, ANSI removed, for layout assertions. */
	frame: (width?: number) => string[];
	/** The widget rows under the editor, ANSI removed. */
	widgetText: (width?: number) => string;
	/** The overlay's own count of transcript lines, read from its footer. */
	transcriptLineCount: (width?: number) => number;
};

/**
 * Opens the agent overlay on a child transcript, exactly as the user does:
 * arrow down to select the agent, Enter to open it.
 */
function buildHarness(
	messages: AgentMessage[],
	options: {
		status?: AgentStatus;
		latestFinalizedMessage?: AgentMessage;
		rows?: number;
		theme?: Theme;
	} = {},
): Harness {
	const session = {
		isStreaming: false,
		agent: { state: { messages } },
		steer: async () => undefined,
		abort: async () => undefined,
		getContextUsage: () => undefined,
	} as unknown as NonNullable<RunningAgent["session"]>;
	const agent = {
		id: "user-1",
		command: "agent",
		inheritedContext: true,
		model: "provider/model",
		modelLabel: "model",
		task: "inspect the repository",
		invocation: "/agent inspect the repository",
		notifyMainAgent: false,
		status: options.status ?? "idle",
		startedAt: Date.now() - 1_000,
		turnStartedAt: Date.now() - 1_000,
		completedAt: Date.now(),
		activeTools: new Map<string, string>(),
		toolUses: 1,
		turnCount: 1,
		responseText: "done",
		inheritedMessageCount: 0,
		latestFinalizedMessage: options.latestFinalizedMessage,
		session,
		finished: Promise.resolve(),
	} satisfies RunningAgent;

	const theme = options.theme ?? identityTheme();
	const tui = {
		terminal: { columns: 200, rows: options.rows ?? 400 },
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
			viewer = factory(tui, theme, undefined, () => undefined);
			return new Promise<"hide" | "dispose">(() => undefined);
		},
	} as unknown as UIContext;

	const widget = new UserAgentWidget(new Set([agent]), () => undefined);
	widget.setUI(ui);
	widget.update();

	const openViewer = () => {
		if (viewer) return viewer;
		terminalInput("\x1b[B");
		terminalInput("\r");
		if (!viewer) throw new Error("Agent viewer did not open");
		return viewer;
	};

	return {
		rows: (width = 100) => transcriptRows(openViewer().render(width)),
		text: (width = 100) => transcriptRows(openViewer().render(width)).join("\n"),
		frame: (width = 100) => openViewer().render(width).map(plain),
		widgetText: (width = 120) => {
			if (!widgetComponent) throw new Error("Widget did not render");
			return widgetComponent.render(width).map(plain).join("\n");
		},
		transcriptLineCount: (width = 120) => {
			const frame = openViewer().render(width).map(plain);
			const footer = frame.slice(-3).join(" ");
			const match = footer.match(/(\d+) lines/);
			if (!match) throw new Error(`Overlay footer did not report a line count: ${footer}`);
			return Number.parseInt(match[1]!, 10);
		},
	};
}

/** The exact string the overlay prints today, and must never print again. */
function argumentBlob(args: Record<string, unknown>): string {
	return JSON.stringify(args);
}

/**
 * A serialised argument object opens with `{"`, and the overlay truncates long
 * lines, so the head of the blob is the part that always survives. Use this
 * wherever the fixture content cannot contain that sequence on its own.
 */
const JSON_OBJECT_HEAD = '{"';

const APP_PATH = "/Users/giladbarnea/project/src/app.ts";
const READ_ARGS = { path: APP_PATH, offset: 10, limit: 20 };
const READ_CONTENT = Array.from({ length: 12 }, (_, index) => `line ${index + 1} of app.ts`).join(
	"\n",
);

/** A real unified patch, produced by Pi's own edit tool for a one-line change. */
const EDIT_PATCH = [
	"--- src/app.ts",
	"+++ src/app.ts",
	"@@ -1,6 +1,6 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 22;",
	" const c = 3;",
	" const d = 4;",
	" const e = 5;",
	" const f = 6;",
	"",
].join("\n");

const EDIT_DIFF = [
	" 1 const a = 1;",
	"-2 const b = 2;",
	"+2 const b = 22;",
	" 3 const c = 3;",
	" 4 const d = 4;",
	" 5 const e = 5;",
	" 6 const f = 6;",
].join("\n");

const EDIT_DETAILS = { diff: EDIT_DIFF, patch: EDIT_PATCH, firstChangedLine: 2 };

function readTranscript(): AgentMessage[] {
	return [
		assistantCalls({ id: "call-read", name: "read", arguments: READ_ARGS }),
		toolResult({ toolCallId: "call-read", toolName: "read", text: READ_CONTENT }),
	];
}

function editTranscript(path = APP_PATH): AgentMessage[] {
	return [
		assistantCalls({
			id: "call-edit",
			name: "edit",
			arguments: { path, edits: [{ oldText: "const b = 2;", newText: "const b = 22;" }] },
		}),
		toolResult({
			toolCallId: "call-edit",
			toolName: "edit",
			text: "Successfully replaced 1 block(s) in src/app.ts.",
			details: EDIT_DETAILS,
		}),
	];
}

describe("overlay tool rendering — the raw transcript is gone", () => {
	test("renders tool calls with Pi's strict real theme", () => {
		const theme = getThemeByName("dark");
		if (!theme) throw new Error("Pi's built-in dark theme is unavailable");

		expect(() => buildHarness(readTranscript(), { theme }).text()).not.toThrow();
	});

	test("a read call shows the tool and its path instead of a JSON argument blob", () => {
		const rendered = buildHarness(readTranscript()).text();

		expect(rendered).not.toContain(argumentBlob(READ_ARGS));
		expect(rendered).not.toContain(JSON_OBJECT_HEAD);
		expect(rendered.toLowerCase()).toContain("read");
		expect(rendered).toContain("src/app.ts");
	});

	test("the read result is summarised and previewed, not dumped", () => {
		const rendered = buildHarness(readTranscript()).text();

		expect(rendered).toMatch(/12 lines?/);
		expect(rendered).toContain("line 1 of app.ts");
	});

	test("the tool name is not printed twice as a bracketed result label", () => {
		const rendered = buildHarness(readTranscript()).text();

		expect(rendered).not.toContain("[read]");
	});

	test("a call and its result read as one block, with no message separator between them", () => {
		// The transcript separator is its own row, so match the row rather than the glyph:
		// a renderer is free to draw tree connectors and rules inside a block.
		expect(buildHarness(readTranscript()).rows()).not.toContain("───");
	});

	test("the activity row under the editor also drops the JSON blob", () => {
		const args = { pattern: "TODO", path: "src" };
		const call = assistantCalls({ id: "call-grep", name: "grep", arguments: args });
		const widgetText = buildHarness([call], {
			status: "running",
			latestFinalizedMessage: call,
		}).widgetText();

		expect(widgetText).not.toContain(argumentBlob(args));
		expect(widgetText).not.toContain(JSON_OBJECT_HEAD);
		expect(widgetText).toContain("grep");
		expect(widgetText).toContain("TODO");
	});
});

describe("overlay tool rendering — first-class tools", () => {
	test("grep reports its match count and says so plainly when there are none", () => {
		const matched = buildHarness([
			assistantCalls({ id: "c", name: "grep", arguments: { pattern: "TODO", path: "src" } }),
			toolResult({
				toolCallId: "c",
				toolName: "grep",
				text: "src/app.ts:12: // TODO one\nsrc/app.ts:40: // TODO two\nsrc/cli.ts:3: // TODO three",
			}),
		]).text();

		expect(matched).toContain("TODO");
		expect(matched).toMatch(/3 match(es)?/);

		const empty = buildHarness([
			assistantCalls({ id: "c", name: "grep", arguments: { pattern: "NOPE", path: "src" } }),
			toolResult({ toolCallId: "c", toolName: "grep", text: "" }),
		]).text();

		expect(empty).toMatch(/no matches/i);
	});

	test("find counts files and ls counts entries", () => {
		const found = buildHarness([
			assistantCalls({ id: "c", name: "find", arguments: { pattern: "*.ts", path: "src" } }),
			toolResult({ toolCallId: "c", toolName: "find", text: "src/app.ts\nsrc/cli.ts" }),
		]).text();

		expect(found).toMatch(/2 files?/);

		const listed = buildHarness([
			assistantCalls({ id: "c", name: "ls", arguments: { path: "src" } }),
			toolResult({ toolCallId: "c", toolName: "ls", text: "app.ts\ncli.ts\nlib/" }),
		]).text();

		expect(listed).toMatch(/3 entries/);
	});

	test("edit renders the applied diff from the stored patch, for a path that no longer exists", () => {
		const rendered = buildHarness(
			editTranscript("/Users/giladbarnea/project-that-never-existed/src/app.ts"),
		).text();

		expect(rendered).toContain("src/app.ts");
		expect(rendered).toContain("const b = 22;");
		expect(rendered).toContain("const b = 2;");
	});

	test("write shows the target path and the content it wrote", () => {
		const args = {
			path: APP_PATH,
			content: "export const answer = 42;\nexport default answer;\n",
		};
		const rendered = buildHarness([
			assistantCalls({ id: "c", name: "write", arguments: args }),
			toolResult({ toolCallId: "c", toolName: "write", text: "Wrote src/app.ts" }),
		]).text();

		expect(rendered).not.toContain(argumentBlob(args));
		expect(rendered).not.toContain(JSON_OBJECT_HEAD);
		expect(rendered).toContain("src/app.ts");
		expect(rendered).toContain("export const answer = 42;");
	});

	test("bash shows the command and its output", () => {
		const rendered = buildHarness([
			assistantCalls({ id: "c", name: "bash", arguments: { command: 'rg -n "TODO" src' } }),
			toolResult({ toolCallId: "c", toolName: "bash", text: "src/app.ts:12: // TODO one" }),
		]).text();

		expect(rendered).toContain('rg -n "TODO" src');
		expect(rendered).toContain("src/app.ts:12: // TODO one");
	});
});

describe("overlay tool rendering — pairing calls with results", () => {
	test("results pair by tool call id even when they arrive in the opposite order", () => {
		const rows = buildHarness([
			assistantCalls(
				{ id: "call-alpha", name: "read", arguments: { path: "/tmp/project/alpha.ts" } },
				{ id: "call-beta", name: "read", arguments: { path: "/tmp/project/beta.ts" } },
			),
			toolResult({
				toolCallId: "call-beta",
				toolName: "read",
				text: Array.from({ length: 3 }, (_, index) => `beta line ${index + 1}`).join("\n"),
			}),
			toolResult({
				toolCallId: "call-alpha",
				toolName: "read",
				text: Array.from({ length: 7 }, (_, index) => `alpha line ${index + 1}`).join("\n"),
			}),
		]).rows();

		const alphaIndex = rows.findIndex((row) => row.includes("alpha.ts"));
		const betaIndex = rows.findIndex((row) => row.includes("beta.ts"));
		expect(alphaIndex).toBeGreaterThanOrEqual(0);
		expect(betaIndex).toBeGreaterThanOrEqual(0);

		const boundary = Math.max(alphaIndex, betaIndex);
		const firstBlock = rows.slice(Math.min(alphaIndex, betaIndex), boundary).join("\n");
		const secondBlock = rows.slice(boundary).join("\n");
		const alphaBlock = alphaIndex < betaIndex ? firstBlock : secondBlock;
		const betaBlock = betaIndex < alphaIndex ? firstBlock : secondBlock;

		expect(alphaBlock).toMatch(/7 lines?/);
		expect(alphaBlock).not.toMatch(/3 lines?/);
		expect(betaBlock).toMatch(/3 lines?/);
		expect(betaBlock).not.toMatch(/7 lines?/);
	});

	test("a call that never produced a result still renders, without inventing one", () => {
		const rendered = buildHarness([
			assistantCalls({ id: "call-gamma", name: "read", arguments: { path: "/tmp/gamma.ts" } }),
		]).text();

		expect(rendered).toContain("gamma.ts");
		expect(rendered).not.toMatch(/\d+ lines?/);
	});
});

describe("overlay tool rendering — the overlay's width is the only width", () => {
	test("a diff stays inside the overlay even when the terminal is far wider", () => {
		const originalColumns = process.stdout.columns;
		const originalEnv = process.env.COLUMNS;
		process.stdout.columns = 400;
		process.env.COLUMNS = "400";
		try {
			const rendered = buildHarness(editTranscript()).text(80);
			expect(rendered).toContain("const b = 22;");
		} finally {
			process.stdout.columns = originalColumns;
			if (originalEnv === undefined) delete process.env.COLUMNS;
			else process.env.COLUMNS = originalEnv;
		}
	});

	test("no rendered line overflows the overlay frame", () => {
		const frame = buildHarness([
			...readTranscript(),
			assistantCalls({ id: "c", name: "bash", arguments: { command: `echo ${"x".repeat(300)}` } }),
			toolResult({ toolCallId: "c", toolName: "bash", text: "y".repeat(500) }),
		]).frame(72);

		for (const line of frame) expect(line.length).toBeLessThanOrEqual(72);
	});
});

describe("overlay tool rendering — unknown tools degrade gracefully", () => {
	test("an MCP tool with nested arguments renders its name and result without a JSON blob", () => {
		const args = {
			filters: { state: ["open", "in_progress"], assignee: null },
			limit: 25,
			query: "overlay rendering",
		};
		const rendered = buildHarness([
			assistantCalls({ id: "c", name: "mcp__linear__list_issues", arguments: args }),
			toolResult({
				toolCallId: "c",
				toolName: "mcp__linear__list_issues",
				text: "PI-14 Overlay tool rendering\nPI-15 Diff width",
			}),
		]).text();

		expect(rendered).not.toContain(argumentBlob(args));
		expect(rendered).not.toContain('{"filters"');
		expect(rendered).toContain("list_issues");
		expect(rendered).toContain("PI-14 Overlay tool rendering");
	});

	test("a custom tool shows its scalar arguments in readable form", () => {
		const args = { environment: "staging", replicas: 3 };
		const rendered = buildHarness([
			assistantCalls({ id: "c", name: "deploy_service", arguments: args }),
			toolResult({ toolCallId: "c", toolName: "deploy_service", text: "deployed" }),
		]).text();

		expect(rendered).not.toContain(argumentBlob(args));
		expect(rendered).not.toContain(JSON_OBJECT_HEAD);
		expect(rendered).toContain("deploy_service");
		expect(rendered).toContain("staging");
		expect(rendered).toContain("3");
		expect(rendered).toContain("deployed");
	});

	test("hostile argument shapes do not break rendering", () => {
		const harness = buildHarness([
			assistantCalls(
				{ id: "a", name: "weird_tool", arguments: {} },
				{ id: "b", name: "weird_tool", arguments: { nested: { deep: { deeper: [1, [2, [3]]] } } } },
				{ id: "c", name: "weird_tool", arguments: { blob: "z".repeat(5_000), nothing: null } },
			),
			toolResult({ toolCallId: "b", toolName: "weird_tool", text: "" }),
		]);

		expect(() => harness.text(64)).not.toThrow();
		expect(harness.text(64)).toContain("weird_tool");
	});
});

describe("overlay tool rendering — awkward transcripts", () => {
	test("assistant prose and a tool call in one message both survive", () => {
		const rendered = buildHarness([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me look at the entry point." },
					{ type: "toolCall", id: "call-read", name: "read", arguments: READ_ARGS },
				],
				timestamp: 1,
				stopReason: "toolUse",
			} as unknown as AgentMessage,
			toolResult({ toolCallId: "call-read", toolName: "read", text: READ_CONTENT }),
		]).text();

		expect(rendered).toContain("Let me look at the entry point.");
		expect(rendered).toContain("src/app.ts");
		expect(rendered).not.toContain(JSON_OBJECT_HEAD);
	});

	test("an image result never leaks its base64 payload into the transcript", () => {
		const payload = `iVBORw0KGgoAAAANSUhEUg${"A".repeat(2_000)}`;
		const rendered = buildHarness([
			assistantCalls({
				id: "c",
				name: "read",
				arguments: { path: "/Users/giladbarnea/project/diagram.png" },
			}),
			{
				role: "toolResult",
				toolCallId: "c",
				toolName: "read",
				content: [{ type: "image", data: payload, mimeType: "image/png" }],
				isError: false,
				timestamp: 2,
			} as unknown as AgentMessage,
		]).text();

		expect(rendered).not.toContain("iVBORw0KGgo");
		expect(rendered).toContain("diagram.png");
	});

	test("a result whose call is not in the transcript is still shown, not dropped", () => {
		const rendered = buildHarness([
			toolResult({
				toolCallId: "call-from-an-earlier-slice",
				toolName: "grep",
				text: "src/app.ts:12: // TODO one",
			}),
		]).text();

		expect(rendered).toContain("grep");
		expect(rendered).toContain("src/app.ts:12: // TODO one");
	});
});

describe("overlay tool rendering — failures read as failures", () => {
	test("a failed edit shows the error instead of a success summary", () => {
		const rendered = buildHarness([
			assistantCalls({
				id: "c",
				name: "edit",
				arguments: { path: APP_PATH, edits: [{ oldText: "missing", newText: "replacement" }] },
			}),
			toolResult({
				toolCallId: "c",
				toolName: "edit",
				text: "oldText not found in src/app.ts",
				isError: true,
			}),
		]).text();

		expect(rendered).toContain("oldText not found");
		expect(rendered).not.toContain("applied");
	});
});

describe("overlay tool rendering — bounded and stable", () => {
	test("a huge result does not become a huge transcript", () => {
		const hugeOutput = Array.from({ length: 5_000 }, (_, index) => `output line ${index}`).join(
			"\n",
		);
		const count = buildHarness([
			assistantCalls({ id: "c", name: "bash", arguments: { command: "yes | head -5000" } }),
			toolResult({ toolCallId: "c", toolName: "bash", text: hugeOutput }),
		]).transcriptLineCount();

		expect(count).toBeLessThan(400);
	});

	test("the output cap counts the rows drawn, not the lines stored", () => {
		// Long lines wrap inside the framed output block. A cap that counts stored lines
		// lets a command like `cat` on a minified file blow straight through it.
		const longLines = Array.from(
			{ length: 500 },
			(_, index) => `line ${index} ${"x".repeat(880)}`,
		).join("\n");
		const count = buildHarness([
			assistantCalls({ id: "c", name: "bash", arguments: { command: "cat bundle.min.js" } }),
			toolResult({ toolCallId: "c", toolName: "bash", text: longLines }),
		]).transcriptLineCount();

		expect(count).toBeLessThan(100);
	});

	test("a huge diff does not become a huge transcript", () => {
		const before = Array.from({ length: 3_000 }, (_, index) => `line ${index}`);
		const after = before.map((line) => `${line} changed`);
		const patch = [
			"--- src/big.ts",
			"+++ src/big.ts",
			`@@ -1,${before.length} +1,${after.length} @@`,
			...before.flatMap((line, index) => [`-${line}`, `+${after[index]}`]),
			"",
		].join("\n");
		const count = buildHarness([
			assistantCalls({
				id: "c",
				name: "edit",
				arguments: { path: "/Users/giladbarnea/project/src/big.ts", edits: [] },
			}),
			toolResult({
				toolCallId: "c",
				toolName: "edit",
				text: "Successfully replaced 3000 block(s) in src/big.ts.",
				details: { diff: "", patch, firstChangedLine: 1 },
			}),
		]).transcriptLineCount();

		expect(count).toBeLessThan(400);
	});

	test("rendering a finished agent twice produces identical output", async () => {
		const harness = buildHarness([assistantText("Here is what I found."), ...readTranscript()]);
		const first = harness.frame();
		await new Promise((resolve) => setTimeout(resolve, 550));
		const second = harness.frame();

		expect(second).toEqual(first);
	});
});
