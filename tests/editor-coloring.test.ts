import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { scanAgentCommandLine } from "../command-line.ts";
import { computeAgentColorSpans } from "../editor-coloring.ts";
import { createEditorHarness } from "./editor-harness.ts";

const SGR_OPEN: Record<string, string> = {
	accent: "\x1b[38;5;110m",
	syntaxKeyword: "\x1b[38;5;111m",
	syntaxString: "\x1b[38;5;112m",
	error: "\x1b[38;5;113m",
};
const SGR_CLOSE = "\x1b[39m";
const CURSOR_OPEN = "\x1b[7m";
const CURSOR_CLOSE = "\x1b[0m";

function createMarkingThemeFg(usedColors: Set<string>): (color: string, text: string) => string {
	return (color, text) => {
		const open = SGR_OPEN[color];
		if (open === undefined)
			throw new Error(`Coloring used a color outside the approved theme palette: ${color}`);
		usedColors.add(color);
		return `${open}${text}${SGR_CLOSE}`;
	};
}

function colored(color: keyof typeof SGR_OPEN, text: string): string {
	return `${SGR_OPEN[color]}${text}${SGR_CLOSE}`;
}

function describeTokens(
	line: string,
): { semantic: string; text: string; option: string }[] | undefined {
	return scanAgentCommandLine(line)?.tokens.map((token) => ({
		semantic: token.semantic,
		text: line.slice(token.start, token.end),
		option: token.option.semanticId,
	}));
}

describe("scanAgentCommandLine — shared semantic representation", () => {
	test("classifies leading options and their values with source spans", () => {
		const line = "/agent -m gpt56s --thinking high fix the bug";
		const scan = scanAgentCommandLine(line);
		assert.ok(scan);
		assert.equal(scan.command, "agent");
		assert.equal(scan.commandEnd, "/agent".length);
		assert.deepEqual(describeTokens(line), [
			{ semantic: "option", text: "-m", option: "model" },
			{ semantic: "value", text: "gpt56s", option: "model" },
			{ semantic: "option", text: "--thinking", option: "thinking" },
			{ semantic: "value", text: "high", option: "thinking" },
		]);
	});

	test("classifies options and their values after the prose flip as misplaced", () => {
		assert.deepEqual(describeTokens("/agent fix the bug -m gpt56s soon"), [
			{ semantic: "misplaced-option", text: "-m", option: "model" },
			{ semantic: "misplaced-value", text: "gpt56s", option: "model" },
		]);
	});

	test("a misplaced value that is itself a recognized option gets its own misplaced-option token", () => {
		assert.deepEqual(describeTokens("/agent fix --thinking --offline now"), [
			{ semantic: "misplaced-option", text: "--thinking", option: "thinking" },
			{ semantic: "misplaced-option", text: "--offline", option: "offline" },
		]);
	});

	test("classifies blocked options, including a blocked option's value", () => {
		assert.deepEqual(describeTokens("/agent --continue fix it"), [
			{ semantic: "blocked", text: "--continue", option: "continue" },
		]);
		assert.deepEqual(describeTokens("/agent --theme ./theme.json fix it"), [
			{ semantic: "blocked", text: "--theme", option: "theme" },
			{ semantic: "blocked", text: "./theme.json", option: "theme" },
		]);
	});

	test("a quoted value span keeps its surrounding quotes", () => {
		assert.deepEqual(describeTokens('/agent --system-prompt "be terse" go'), [
			{ semantic: "option", text: "--system-prompt", option: "system-prompt" },
			{ semantic: "value", text: '"be terse"', option: "system-prompt" },
		]);
	});

	test("quoted and escaped prose never produces semantic tokens", () => {
		assert.deepEqual(describeTokens('/agent "do -m x" now'), []);
		assert.deepEqual(describeTokens("/agent \\-m hi"), []);
	});

	test("recognizes only exact agent command lines", () => {
		assert.equal(scanAgentCommandLine("hello -m x"), undefined);
		assert.equal(scanAgentCommandLine("/agents fix it"), undefined);
		assert.equal(scanAgentCommandLine("/agent-isolated fix it"), undefined);
	});
});

describe("computeAgentColorSpans — theme-variable palette", () => {
	test("maps semantic tokens onto theme colors", () => {
		assert.deepEqual(computeAgentColorSpans("/agent -m gpt56s fix"), [
			{ start: 0, end: 6, color: "accent" },
			{ start: 7, end: 9, color: "syntaxKeyword" },
			{ start: 10, end: 16, color: "syntaxString" },
		]);
	});

	test("returns undefined for non-agent lines", () => {
		assert.equal(computeAgentColorSpans("write -m fix"), undefined);
	});
});

describe("editor semantic coloring", () => {
	test("paints command, option, and value tokens and keeps prose plain", async () => {
		const usedColors = new Set<string>();
		const harness = await createEditorHarness(undefined, [], [], [], {
			themeFg: createMarkingThemeFg(usedColors),
		});
		harness.type("/agent --thinking high fix it");
		const rendered = harness.renderRaw();
		const expected = `${colored("accent", "/agent")} ${colored("syntaxKeyword", "--thinking")} ${colored("syntaxString", "high")} fix it${CURSOR_OPEN} ${CURSOR_CLOSE}`;
		assert.ok(
			rendered.includes(expected),
			`Expected semantic coloring with plain prose.\nRendered:\n${JSON.stringify(rendered)}`,
		);
		assert.equal(harness.editor.getText(), "/agent --thinking high fix it");
	});

	test("paints options and values typed after the prose flip as errors", async () => {
		const harness = await createEditorHarness(undefined, [], [], [], {
			themeFg: createMarkingThemeFg(new Set()),
		});
		harness.type("/agent fix -m gpt56s then");
		const rendered = harness.renderRaw();
		const expected = `${colored("accent", "/agent")} fix ${colored("error", "-m")} ${colored("error", "gpt56s")} then`;
		assert.ok(
			rendered.includes(expected),
			`Expected misplaced option and value to render as errors.\nRendered:\n${JSON.stringify(rendered)}`,
		);
	});

	test("paints both spellings of the blacklisted continue option as errors", async () => {
		for (const option of ["-c", "--continue"]) {
			const harness = await createEditorHarness(undefined, [], [], [], {
				themeFg: createMarkingThemeFg(new Set()),
			});
			harness.type(`/agent ${option} fix`);
			assert.ok(harness.renderRaw().includes(`${colored("error", option)} fix`));
		}
	});

	test("uses canonical model resolution to accept IDs and aliases and reject unknown values", async () => {
		const models = [{ provider: "openai-codex", id: "gpt-5.6-sol", name: "gpt56s" }];
		for (const value of ["openai-codex/gpt-5.6-sol", "gpt56s"]) {
			const harness = await createEditorHarness(undefined, models, [], [], {
				themeFg: createMarkingThemeFg(new Set()),
			});
			harness.type(`/agent -m ${value} fix`);
			assert.ok(harness.renderRaw().includes(`${colored("syntaxString", value)} fix`));
		}

		const harness = await createEditorHarness(undefined, models, [], [], {
			themeFg: createMarkingThemeFg(new Set()),
		});
		harness.type("/agent -m no-such-model fix");
		assert.ok(harness.renderRaw().includes(`${colored("error", "no-such-model")} fix`));
	});

	test("uses Pi's canonical thinking-level parser to reject invalid values", async () => {
		const harness = await createEditorHarness(undefined, [], [], [], {
			themeFg: createMarkingThemeFg(new Set()),
		});
		harness.type("/agent --thinking ultra fix");
		assert.ok(harness.renderRaw().includes(`${colored("error", "ultra")} fix`));
	});

	test("validates provider and tool values against their live catalogs", async () => {
		const models = [{ provider: "openai-codex", id: "gpt-5.6-sol" }];
		const tools = [{ name: "read", description: "Read files" }];
		for (const { input, value, color } of [
			{ input: "--provider openai-codex", value: "openai-codex", color: "syntaxString" },
			{ input: "--provider unknown", value: "unknown", color: "error" },
			{ input: "--tools read", value: "read", color: "syntaxString" },
			{ input: "--tools read,missing", value: "read,missing", color: "error" },
		] as const) {
			const harness = await createEditorHarness(undefined, models, tools, [], {
				themeFg: createMarkingThemeFg(new Set()),
			});
			harness.type(`/agent ${input} fix`);
			assert.ok(harness.renderRaw().includes(`${colored(color, value)} fix`));
		}
	});

	test("paints a quoted value with its quotes", async () => {
		const harness = await createEditorHarness(undefined, [], [], [], {
			themeFg: createMarkingThemeFg(new Set()),
		});
		harness.type('/agent --system-prompt "be terse" go');
		assert.ok(harness.renderRaw().includes(`${colored("syntaxString", '"be terse"')} go`));
	});

	test("keeps the inverse-video cursor intact inside a colored token", async () => {
		const harness = await createEditorHarness(undefined, [], [], [], {
			themeFg: createMarkingThemeFg(new Set()),
		});
		harness.type("/agent --thinking");
		harness.moveCursorLeft(3);
		const rendered = harness.renderRaw();
		const expected = `${colored("syntaxKeyword", "--think")}${CURSOR_OPEN}i${CURSOR_CLOSE}${colored("syntaxKeyword", "ng")}`;
		assert.ok(
			rendered.includes(expected),
			`Expected the colored token to split cleanly around the cursor.\nRendered:\n${JSON.stringify(rendered)}`,
		);
	});

	test("keeps coloring across word-wrapped layout chunks", async () => {
		const harness = await createEditorHarness(undefined, [], [], [], {
			themeFg: createMarkingThemeFg(new Set()),
		});
		harness.type("/agent --system-prompt averyveryverylongpromptvalue123456 fix it");
		const rendered = harness.renderRaw(24);
		const valueFragments = rendered.split(SGR_OPEN.syntaxString).length - 1;
		assert.ok(
			valueFragments >= 2,
			`Expected the wrapped value to stay colored on every visual line.\nRendered:\n${JSON.stringify(rendered)}`,
		);
	});

	test("leaves non-agent input completely unstyled", async () => {
		const harness = await createEditorHarness(undefined, [], [], [], {
			themeFg: createMarkingThemeFg(new Set()),
		});
		harness.type("hello -m x");
		assert.ok(!harness.renderRaw().includes("\x1b[38;5;"));
	});

	test("uses only the approved theme variables", async () => {
		const usedColors = new Set<string>();
		const harness = await createEditorHarness(
			undefined,
			[{ provider: "openai-codex", id: "gpt-5.6-sol", name: "gpt56s" }],
			[],
			[],
			{ themeFg: createMarkingThemeFg(usedColors) },
		);
		harness.type("/agent --continue -m gpt56s fix -t x");
		harness.renderRaw();
		assert.deepEqual([...usedColors].sort(), ["accent", "error", "syntaxKeyword", "syntaxString"]);
	});

	test("autocomplete still opens and applies completions over colored input", async () => {
		const harness = await createEditorHarness(
			undefined,
			[{ provider: "prov", id: "gpt56s" }],
			[],
			[],
			{ themeFg: createMarkingThemeFg(new Set()) },
		);
		harness.type("/agent -");
		await harness.waitForAutocomplete();
		harness.press("\t");
		assert.equal(harness.editor.getText(), "/agent -m ");
		assert.ok(harness.renderRaw().includes(colored("syntaxKeyword", "-m")));
	});
});
