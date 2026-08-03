import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager as PiKeybindingsManager,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	KeybindingsManager,
	type SlashCommand,
	type TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import userAgent from "../index.ts";

export type HarnessModel = { provider: string; id: string; name?: string };
export type HarnessTool = { name: string; description: string };
export type HarnessCommand = {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: { path: string };
};

export type EditorHarness = {
	editor: EditorComponent & {
		getCursor(): { line: number; col: number };
		isShowingAutocomplete(): boolean;
	};
	moveCursorLeft(count: number): void;
	press(data: string): void;
	render(): string;
	renderRaw(width?: number): string;
	type(text: string): void;
	waitForAutocomplete(): Promise<void>;
	waitForAutocompleteToRemainHidden(): Promise<void>;
	waitForRender(predicate: (rendered: string) => boolean): Promise<void>;
};

export type EditorHarnessOptions = {
	/** Theme foreground painter observed by the coloring layer; defaults to identity. */
	themeFg?: (color: string, text: string) => string;
};

type SessionStartHandler = (
	event: { type: "session_start"; reason: "startup" },
	ctx: ExtensionContext,
) => Promise<void> | void;
type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export async function createEditorHarness(
	cwd: string = process.cwd(),
	models: readonly HarnessModel[] = [],
	tools: readonly HarnessTool[] = [],
	resourceCommands: readonly HarnessCommand[] = [],
	options: EditorHarnessOptions = {},
): Promise<EditorHarness> {
	const commands: SlashCommand[] = [];
	const sessionStartHandlers: SessionStartHandler[] = [];
	const autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	let editorFactory: EditorFactory | undefined;
	let editor: EditorComponent | undefined;

	const pi = {
		on(event: string, handler: unknown): void {
			if (event === "session_start") sessionStartHandlers.push(handler as SessionStartHandler);
		},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			commands.push({
				name,
				description: options.description,
				getArgumentCompletions: options.getArgumentCompletions,
			});
		},
		registerMessageRenderer(): void {},
		registerEntryRenderer(): void {},
		getAllTools: () => tools,
		getCommands: () => resourceCommands,
	} as unknown as ExtensionAPI;

	userAgent(pi);

	const ui = {
		addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
			autocompleteProviderFactories.push(factory);
		},
		getEditorComponent(): EditorFactory | undefined {
			return editorFactory;
		},
		setEditorComponent(factory: EditorFactory | undefined): void {
			editorFactory = factory;
		},
		getEditorText(): string {
			return editor?.getText() ?? "";
		},
		theme: {
			fg: options.themeFg ?? ((_color: string, text: string) => text),
		},
	} as unknown as ExtensionContext["ui"];
	const modelRuntime = {
		getModels: () => models,
		hasConfiguredAuth: () => true,
	};
	const context = {
		cwd,
		hasUI: true,
		mode: "tui",
		modelRegistry: {
			getAll: () => models,
			getAvailable: async () => models,
			runtime: modelRuntime,
		},
		ui,
	} as unknown as ExtensionContext;

	for (const handler of sessionStartHandlers) {
		await handler({ type: "session_start", reason: "startup" }, context);
	}

	const tui = {
		terminal: { columns: 120, rows: 40 },
		requestRender(): void {},
	} as unknown as TUI;
	const editorTheme: EditorTheme = {
		borderColor: (text) => text,
		selectList: {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		},
	};
	const keybindings = new KeybindingsManager(
		TUI_KEYBINDINGS,
	) as unknown as PiKeybindingsManager;
	editor =
		editorFactory?.(tui, editorTheme, keybindings) ??
		new CustomEditor(tui, editorTheme, keybindings);
	const provider = autocompleteProviderFactories.reduce(
		(current, factory) => factory(current),
		new CombinedAutocompleteProvider(commands, cwd),
	);
	editor.setAutocompleteProvider?.(provider);
	const runtimeEditor = editor as EditorHarness["editor"];

	const render = () => runtimeEditor.render(100).join("\n").replace(ANSI_SEQUENCE, "");
	return {
		editor: runtimeEditor,
		moveCursorLeft(count: number): void {
			for (let step = 0; step < count; step += 1) runtimeEditor.handleInput("\x1b[D");
		},
		press(data: string): void {
			runtimeEditor.handleInput(data);
		},
		render,
		renderRaw(width = 100): string {
			return runtimeEditor.render(width).join("\n");
		},
		type(text: string): void {
			for (const character of text) runtimeEditor.handleInput(character);
		},
		async waitForAutocomplete(): Promise<void> {
			await waitUntil(() => runtimeEditor.isShowingAutocomplete(), 500);
		},
		async waitForAutocompleteToRemainHidden(): Promise<void> {
			const deadline = Date.now() + 50;
			while (Date.now() < deadline) {
				if (runtimeEditor.isShowingAutocomplete())
					throw new Error(`Expected autocomplete to remain hidden.\nRendered editor:\n${render()}`);
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
			}
		},
		async waitForRender(predicate: (rendered: string) => boolean): Promise<void> {
			await waitUntil(() => predicate(render()), 500);
		},
	};
}

async function waitUntil(condition: () => boolean, timeoutMilliseconds: number): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!condition()) {
		if (Date.now() >= deadline)
			throw new Error(`Autocomplete did not become visible within ${timeoutMilliseconds}ms`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}
