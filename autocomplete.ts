import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
	resolveModelScopeWithDiagnostics,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	decodeKittyPrintable,
	type EditorComponent,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import {
	AGENT_OPTIONS,
	analyzeAgentEditorInput,
	type OptionCursorExpectation,
	type ValueCursorExpectation,
} from "./command-line.js";
import { decorateColoringEditor } from "./editor-coloring.js";
import { createAgentValueValidator } from "./runner.js";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type CompletionModel = { provider: string; id: string; name?: string };
type CompletionTool = { name: string; description: string };
type CompletionResourceCommand = ReturnType<ExtensionAPI["getCommands"]>[number];
type ModelScopeSource = Pick<ExtensionContext["modelRegistry"], "getAvailable">;
type AutocompleteRuntimeEditor = EditorComponent & {
	forceFileAutocomplete?: (explicitTab?: boolean) => void;
	getCursor?: () => { line: number; col: number };
	isShowingAutocomplete?: () => boolean;
	tryTriggerAutocomplete?: (explicitTab?: boolean) => void;
};

const DECORATED_EDITOR = Symbol.for("pi-user-agents:autocomplete-editor");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Pi's resolver only calls getAvailable(), but its SDK type requires the internal ModelRuntime unavailable to extensions.
const resolveExtensionModelScope = resolveModelScopeWithDiagnostics as unknown as (
	patterns: string[],
	modelSource: ModelScopeSource,
) => ReturnType<typeof resolveModelScopeWithDiagnostics>;

type DecoratedEditor = AutocompleteRuntimeEditor & { [DECORATED_EDITOR]?: true };

/** @example getOptionItems(analyzeAgentEditorInput("/agent --thi", 12) as OptionCursorExpectation)[0]?.label // "--thinking <level>" */
export function getOptionItems(expectation: OptionCursorExpectation): AutocompleteItem[] {
	return AGENT_OPTIONS.flatMap((option) => {
		if (!option.autocomplete || expectation.usedSemanticIds.has(option.semanticId)) return [];
		return option.names
			.filter((name) => name.startsWith(expectation.fragment))
			.map((name) => ({
				value: name,
				label: option.arity === "value" ? `${name} <${option.placeholder}>` : name,
				description: option.description,
			}));
	});
}

export function createAgentAutocompleteProvider(
	current: AutocompleteProvider,
	getModels: () => readonly CompletionModel[] = () => [],
	getTools: () => readonly CompletionTool[] = () => [],
	getCommands: () => readonly CompletionResourceCommand[] = () => [],
	getScopedModels: () => readonly CompletionModel[] = () => [],
): AutocompleteProvider {
	return {
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			if (cursorLine !== 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const expectation = analyzeAgentEditorInput(lines[0] ?? "", cursorCol);
			if (expectation?.kind === "option") {
				const items = getOptionItems(expectation);
				return items.length === 0 ? null : { items, prefix: expectation.fragment };
			}
			if (expectation?.kind === "value" && expectation.option.completionDomain === "thinking") {
				const items = THINKING_LEVELS.filter((level) => level.startsWith(expectation.fragment)).map(
					(level) => ({ value: level, label: level }),
				);
				return items.length === 0 ? null : { items, prefix: expectation.fragment };
			}
			if (expectation?.kind === "value" && expectation.option.completionDomain === "model") {
				const items = getModelItems(
					expectation.fragment,
					getModels(),
					getScopedModels(),
					expectation.parsedProvider,
				);
				return items.length === 0 ? null : { items, prefix: expectation.fragment };
			}
			if (expectation?.kind === "value" && expectation.option.completionDomain === "provider") {
				const items = getProviderItems(expectation.fragment, getModels());
				return items.length === 0 ? null : { items, prefix: expectation.fragment };
			}
			if (expectation?.kind === "value" && expectation.option.completionDomain === "tool") {
				const segment = getToolSegment(expectation, lines[0] ?? "", cursorCol);
				const items = getToolItems(segment.fragment, getTools(), segment.selectedNames);
				return items.length === 0 ? null : { items, prefix: segment.fragment };
			}
			if (expectation?.kind === "value" && expectation.option.completionDomain === "path") {
				const shortcuts = getResourceShortcutItems(expectation, getCommands());
				if (shortcuts.length === 0)
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				const filesystem = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				return {
					items: [...shortcuts, ...(filesystem?.items ?? [])],
					prefix: filesystem?.prefix ?? expectation.fragment,
				};
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (cursorLine !== 0)
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const expectation = analyzeAgentEditorInput(lines[0] ?? "", cursorCol);
			if (
				expectation?.kind === "option" &&
				getOptionItems(expectation).some((candidate) => candidate.value === item.value)
			) {
				const option = AGENT_OPTIONS.find((candidate) => candidate.names.includes(item.value));
				if (
					option?.arity === "value" &&
					(option.completionDomain === "path" || option.completionDomain === undefined)
				) {
					return applyGuardedOptionEdit(
						lines,
						expectation.replacementStart,
						expectation.replacementEnd,
						item.value,
					);
				}
				return applyCompletionEdit(
					lines,
					expectation.replacementStart,
					expectation.replacementEnd,
					item.value,
				);
			}
			const thinkingValue =
				expectation?.kind === "value" &&
				expectation.option.completionDomain === "thinking" &&
				THINKING_LEVELS.some((level) => level === item.value);
			if (thinkingValue && expectation.kind === "value") {
				return applyCompletionEdit(
					lines,
					expectation.replacementStart,
					expectation.replacementEnd,
					item.value,
				);
			}
			const modelValue =
				expectation?.kind === "value" &&
				expectation.option.completionDomain === "model" &&
				getModelItems(
					expectation.fragment,
					getModels(),
					getScopedModels(),
					expectation.parsedProvider,
				).some((model) => model.value === item.value);
			if (modelValue && expectation.kind === "value") {
				return applyCompletionEdit(
					lines,
					expectation.replacementStart,
					expectation.replacementEnd,
					item.value,
				);
			}
			const providerValue =
				expectation?.kind === "value" &&
				expectation.option.completionDomain === "provider" &&
				getProviderItems(expectation.fragment, getModels()).some(
					(provider) => provider.value === item.value,
				);
			if (providerValue && expectation.kind === "value") {
				return applyCompletionEdit(
					lines,
					expectation.replacementStart,
					expectation.replacementEnd,
					item.value,
				);
			}
			if (expectation?.kind === "value" && expectation.option.completionDomain === "tool") {
				const segment = getToolSegment(expectation, lines[0] ?? "", cursorCol);
				const toolValue = getToolItems(segment.fragment, getTools(), segment.selectedNames).some(
					(tool) => tool.value === item.value,
				);
				if (toolValue) return applyToolCompletionEdit(lines, segment, item.value);
			}
			if (expectation?.kind === "value" && expectation.option.completionDomain === "path") {
				const resourceShortcut = getResourceShortcutItems(expectation, getCommands()).some(
					(candidate) => candidate.value === item.value && candidate.label === item.label,
				);
				if (resourceShortcut) return applyResourceShortcutEdit(lines, expectation, item.value);
				const result = current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				if (item.label.endsWith("/")) return result;
				const completedLine = result.lines[result.cursorLine] ?? "";
				const cursorAfterSeparator = /\s/.test(completedLine[result.cursorCol] ?? "")
					? result.cursorCol + 1
					: result.cursorCol;
				return { ...result, cursorCol: cursorAfterSeparator };
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export function registerAgentAutocomplete(pi: ExtensionAPI): void {
	let autocompleteEditorFactory: EditorFactory | undefined;

	function installEditorBridge(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const previousEditorFactory = ctx.ui.getEditorComponent();
		if (autocompleteEditorFactory && previousEditorFactory === autocompleteEditorFactory) return;

		const modelRuntime = (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
		const isValueValid = createAgentValueValidator(modelRuntime, () =>
			pi.getAllTools().map((tool) => tool.name),
		);
		autocompleteEditorFactory = (tui, theme, keybindings) => {
			const editor =
				previousEditorFactory?.(tui, theme, keybindings) ??
				new CustomEditor(tui, theme, keybindings);
			const autocompleteEditor = decorateAutocompleteEditor(
				editor,
				(data) =>
					keybindings.matches(data, "tui.input.tab") ||
					keybindings.matches(data, "tui.select.confirm"),
			);
			return decorateColoringEditor(autocompleteEditor, () => ctx.ui.theme, isValueValid);
		};
		ctx.ui.setEditorComponent(autocompleteEditorFactory);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const settingsManager = SettingsManager.create(ctx.cwd);
		const { scopedModels } = await resolveExtensionModelScope(
			settingsManager.getEnabledModels() ?? [],
			ctx.modelRegistry,
		);
		ctx.ui.addAutocompleteProvider((current) => {
			installEditorBridge(ctx);
			return createAgentAutocompleteProvider(
				current,
				() => ctx.modelRegistry.getAll(),
				() => pi.getAllTools(),
				() => pi.getCommands(),
				() => scopedModels.map(({ model }) => model),
			);
		});
		installEditorBridge(ctx);
	});
}

function getModelItems(
	fragment: string,
	models: readonly CompletionModel[],
	scopedModels: readonly CompletionModel[],
	provider?: string,
): AutocompleteItem[] {
	const providerModels = models.filter(
		(model) => provider === undefined || model.provider === provider,
	);
	return fuzzyFilter(
		scopedModelsFirst(providerModels, scopedModels),
		fragment,
		(model) => `${model.provider}/${model.id} ${model.name ?? ""}`,
	).map((model) => {
		const reference = `${model.provider}/${model.id}`;
		return {
			value: reference,
			label: reference,
			description: model.name && model.name !== model.id ? model.name : undefined,
		};
	});
}

/** @example scopedModelsFirst([{ provider: "all", id: "first" }, { provider: "scope", id: "second" }], [{ provider: "scope", id: "second" }])[0]?.provider // "scope" */
function scopedModelsFirst(
	models: readonly CompletionModel[],
	scopedModels: readonly CompletionModel[],
): CompletionModel[] {
	const scopedReferences = new Set(scopedModels.map((model) => `${model.provider}/${model.id}`));
	return [
		...models.filter((model) => scopedReferences.has(`${model.provider}/${model.id}`)),
		...models.filter((model) => !scopedReferences.has(`${model.provider}/${model.id}`)),
	];
}

function getProviderItems(
	fragment: string,
	models: readonly CompletionModel[],
): AutocompleteItem[] {
	const query = fragment.toLowerCase();
	return [...new Set(models.map((model) => model.provider))]
		.filter((provider) => provider.toLowerCase().includes(query))
		.map((provider) => ({ value: provider, label: provider }));
}

type ToolSegment = {
	fragment: string;
	replacementStart: number;
	replacementEnd: number;
	selectedNames: ReadonlySet<string>;
};

function getToolSegment(
	expectation: ValueCursorExpectation,
	line: string,
	cursorCol: number,
): ToolSegment {
	const value = line.slice(expectation.replacementStart, expectation.replacementEnd);
	const cursorOffset = cursorCol - expectation.replacementStart;
	const segmentStart = value.lastIndexOf(",", cursorOffset - 1) + 1;
	const nextComma = value.indexOf(",", cursorOffset);
	const segmentEnd = nextComma === -1 ? value.length : nextComma;
	const selectedNames = new Set(
		value
			.split(",")
			.filter((_name, index) => index !== value.slice(0, segmentStart).split(",").length - 1),
	);
	return {
		fragment: value.slice(segmentStart, cursorOffset),
		replacementStart: expectation.replacementStart + segmentStart,
		replacementEnd: expectation.replacementStart + segmentEnd,
		selectedNames,
	};
}

function getToolItems(
	fragment: string,
	tools: readonly CompletionTool[],
	selectedNames: ReadonlySet<string>,
): AutocompleteItem[] {
	const query = fragment.toLowerCase();
	return tools
		.filter((tool) => !selectedNames.has(tool.name))
		.filter((tool) => tool.name.toLowerCase().includes(query))
		.map((tool) => ({ value: tool.name, label: tool.name, description: tool.description }));
}

function getResourceShortcutItems(
	expectation: ValueCursorExpectation,
	commands: readonly CompletionResourceCommand[],
): AutocompleteItem[] {
	const source =
		expectation.option.semanticId === "skill"
			? "skill"
			: expectation.option.semanticId === "prompt-template"
				? "prompt"
				: undefined;
	if (source === undefined) return [];
	const query = expectation.fragment.toLowerCase();
	return commands
		.filter((command) => command.source === source)
		.filter((command) => command.name.toLowerCase().includes(query))
		.map((command) => ({
			value: command.sourceInfo.path,
			label: command.name,
			description: command.description,
		}));
}

function applyCompletionEdit(
	lines: string[],
	replacementStart: number,
	replacementEnd: number,
	value: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[0] ?? "";
	const before = line.slice(0, replacementStart);
	const after = line.slice(replacementEnd).replace(/^\s+/, "");
	const insertion = `${value} `;
	const nextLines = [...lines];
	nextLines[0] = `${before}${insertion}${after}`;
	return { lines: nextLines, cursorLine: 0, cursorCol: before.length + insertion.length };
}

function applyResourceShortcutEdit(
	lines: string[],
	expectation: ValueCursorExpectation,
	path: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	if (!expectation.quoted) {
		const value = /\s/.test(path) ? `"${path}"` : path;
		return applyCompletionEdit(
			lines,
			expectation.replacementStart,
			expectation.replacementEnd,
			value,
		);
	}
	const line = lines[0] ?? "";
	const before = line.slice(0, expectation.replacementStart);
	const afterValue = line.slice(expectation.replacementEnd);
	const insertion = `${path}${afterValue[0] ?? ""} `;
	const nextLines = [...lines];
	nextLines[0] = `${before}${insertion}${afterValue.slice(1).replace(/^\s+/, "")}`;
	return { lines: nextLines, cursorLine: 0, cursorCol: before.length + insertion.length };
}

function applyToolCompletionEdit(
	lines: string[],
	segment: ToolSegment,
	value: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[0] ?? "";
	const nextLines = [...lines];
	nextLines[0] = `${line.slice(0, segment.replacementStart)}${value}${line.slice(segment.replacementEnd)}`;
	return { lines: nextLines, cursorLine: 0, cursorCol: segment.replacementStart + value.length };
}

function applyGuardedOptionEdit(
	lines: string[],
	replacementStart: number,
	replacementEnd: number,
	optionName: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[0] ?? "";
	const before = line.slice(0, replacementStart);
	const after = line.slice(replacementEnd).replace(/^\s+/, "");
	const insertion = `${optionName} "" `;
	const nextLines = [...lines];
	nextLines[0] = `${before}${insertion}${after}`;
	return { lines: nextLines, cursorLine: 0, cursorCol: before.length + optionName.length + 2 };
}

function decorateAutocompleteEditor<T extends EditorComponent>(
	editor: T,
	isCompletionAcceptance: (data: string) => boolean,
): T {
	const runtimeEditor = editor as DecoratedEditor;
	if (runtimeEditor[DECORATED_EDITOR]) return editor;
	const handleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data) => {
		const getCursor = runtimeEditor.getCursor;
		if (typeof getCursor !== "function")
			throw new Error("pi-user-agents autocomplete requires editor.getCursor()");
		const beforeCursor = getCursor.call(editor);
		const beforeExpectation =
			beforeCursor.line === 0
				? analyzeAgentEditorInput(editor.getText(), beforeCursor.col)
				: undefined;
		const wasShowingAutocomplete = runtimeEditor.isShowingAutocomplete?.call(editor) ?? false;
		const printableCharacter =
			decodeKittyPrintable(data) ??
			(data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		handleInput(data);

		const cursor = getCursor.call(editor);
		if (cursor.line !== 0) return;
		const expectation = analyzeAgentEditorInput(editor.getText(), cursor.col);
		const typedOptionDash = printableCharacter === "-" && expectation?.kind === "option";
		const completionAcceptance = isCompletionAcceptance(data);
		const typedEagerValueBoundary =
			printableCharacter === " " &&
			beforeExpectation?.kind === "option" &&
			expectation?.kind === "value" &&
			(expectation.option.completionDomain === "tool" ||
				expectation.option.completionDomain === "path");
		const typedToolComma =
			printableCharacter === "," &&
			beforeExpectation?.kind === "value" &&
			beforeExpectation.option.completionDomain === "tool" &&
			expectation?.kind === "value" &&
			expectation.option.completionDomain === "tool";
		const acceptedChainedOption =
			wasShowingAutocomplete &&
			completionAcceptance &&
			beforeExpectation?.kind === "option" &&
			expectation?.kind === "value" &&
			expectation.option.completionDomain !== undefined;
		const acceptedPathDirectory =
			wasShowingAutocomplete &&
			completionAcceptance &&
			beforeExpectation?.kind === "value" &&
			beforeExpectation.option.completionDomain === "path" &&
			expectation?.kind === "value" &&
			expectation.option.completionDomain === "path";
		const optionItems =
			beforeExpectation?.kind === "option" ? getOptionItems(beforeExpectation) : [];
		const onlyOption =
			optionItems.length === 1
				? AGENT_OPTIONS.find((option) => option.names.includes(optionItems[0]?.value ?? ""))
				: undefined;
		const pendingChainedOption =
			!wasShowingAutocomplete &&
			completionAcceptance &&
			expectation?.kind === "option" &&
			onlyOption?.completionDomain !== undefined;
		if (pendingChainedOption) {
			observeChainedOptionEdit(editor, runtimeEditor, onlyOption.semanticId);
			return;
		}
		if (
			!typedOptionDash &&
			!typedEagerValueBoundary &&
			!typedToolComma &&
			!acceptedChainedOption &&
			!acceptedPathDirectory
		)
			return;

		if (typedEagerValueBoundary || typedToolComma) {
			triggerValueAutocomplete(editor, runtimeEditor, expectation);
			return;
		}
		if (acceptedPathDirectory) {
			triggerValueAutocomplete(editor, runtimeEditor, expectation);
			return;
		}
		if (acceptedChainedOption) {
			triggerValueAutocomplete(editor, runtimeEditor, expectation);
			return;
		}
		const triggerAutocomplete = runtimeEditor.tryTriggerAutocomplete;
		if (typeof triggerAutocomplete !== "function")
			throw new Error("pi-user-agents autocomplete requires editor.tryTriggerAutocomplete()");
		triggerAutocomplete.call(editor, false);
	};
	runtimeEditor[DECORATED_EDITOR] = true;
	return editor;
}

function observeChainedOptionEdit(
	editor: EditorComponent,
	runtimeEditor: AutocompleteRuntimeEditor,
	semanticId: string,
): void {
	const deadline = Date.now() + 500;
	const observe = (): void => {
		const cursor = runtimeEditor.getCursor?.call(editor);
		const expectation =
			cursor?.line === 0 ? analyzeAgentEditorInput(editor.getText(), cursor.col) : undefined;
		if (
			expectation?.kind === "value" &&
			expectation.option.semanticId === semanticId &&
			expectation.option.completionDomain !== undefined
		) {
			triggerValueAutocomplete(editor, runtimeEditor, expectation);
			return;
		}
		if (runtimeEditor.isShowingAutocomplete?.call(editor) || Date.now() >= deadline) return;
		setTimeout(observe, 5);
	};
	setTimeout(observe, 0);
}

function triggerValueAutocomplete(
	editor: EditorComponent,
	runtimeEditor: AutocompleteRuntimeEditor,
	expectation: ValueCursorExpectation,
): void {
	if (expectation.option.completionDomain === "path") {
		const forceFileAutocomplete = runtimeEditor.forceFileAutocomplete;
		if (typeof forceFileAutocomplete !== "function")
			throw new Error("pi-user-agents autocomplete requires editor.forceFileAutocomplete()");
		forceFileAutocomplete.call(editor, false);
		return;
	}
	const triggerAutocomplete = runtimeEditor.tryTriggerAutocomplete;
	if (typeof triggerAutocomplete !== "function")
		throw new Error("pi-user-agents autocomplete requires editor.tryTriggerAutocomplete()");
	triggerAutocomplete.call(editor, false);
}
