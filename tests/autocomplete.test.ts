import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditorHarness } from "./editor-harness.ts";

describe("agent command editor autocomplete", () => {
	test("typing /agent - visibly opens the option menu without Tab", async () => {
		const harness = await createEditorHarness();

		harness.type("/agent -");
		await harness.waitForAutocomplete();
		const rendered = harness.render();

		assert.match(
			rendered,
			/-m <model>/,
			`Expected the visible menu to contain -m <model>.\nRendered editor:\n${rendered}`,
		);
		assert.match(
			rendered,
			/--model <model>/,
			`Expected the visible menu to contain --model <model>.\nRendered editor:\n${rendered}`,
		);
	});

	test("rapid repeated dash triggers settle on the current non-empty option menu", async () => {
		const harness = await createEditorHarness();

		harness.type("/agent -");
		for (let attempt = 0; attempt < 10; attempt += 1) {
			harness.press("\x7f");
			harness.type("-");
		}
		await harness.waitForAutocomplete();
		const rendered = harness.render();

		assert.equal(
			harness.editor.getText(),
			"/agent -",
			`Expected rapid edits to retain the current input. Got: ${harness.editor.getText()}`,
		);
		assert.match(
			rendered,
			/-m <model>/,
			`Expected the settled menu to contain model completion.\nRendered editor:\n${rendered}`,
		);
	});

	test("offers and accepts both join option spellings", async () => {
		for (const joinOption of ["-j", "--join"]) {
			const harness = await createEditorHarness();
			harness.type(`/agent ${joinOption}`);
			await harness.waitForRender((rendered) => rendered.includes("Join the completed result"));
			harness.press("\t");

			assert.equal(
				harness.editor.getText(),
				`/agent ${joinOption} `,
				`Expected autocomplete to accept ${joinOption}`,
			);
		}
	});

	test("task prose, quoted dashes, and escaped dashes never reopen option autocomplete", async () => {
		for (const text of ["/agent explain -", '/agent "-"', "/agent \\-"]) {
			const harness = await createEditorHarness();
			harness.type(text);
			await harness.waitForAutocompleteToRemainHidden();

			assert.equal(
				harness.editor.isShowingAutocomplete(),
				false,
				`Expected no option menu for ${JSON.stringify(text)}.`,
			);
		}
	});

	test("blocked options remain absent while an effective option with the same prefix is visible", async () => {
		const harness = await createEditorHarness();

		harness.type("/agent --ex");
		await harness.waitForRender((rendered) => rendered.includes("--exclude-tools <tools>"));
		const rendered = harness.render();

		assert.doesNotMatch(
			rendered,
			/--export/,
			`Expected blocked --export to remain absent.\nRendered editor:\n${rendered}`,
		);
	});

	test("--theme is absent while --no-themes remains completable", async () => {
		const unsupportedHarness = await createEditorHarness();
		unsupportedHarness.type("/agent --the");
		await unsupportedHarness.waitForAutocompleteToRemainHidden();
		assert.equal(
			unsupportedHarness.editor.isShowingAutocomplete(),
			false,
			`Expected no completion for unsupported --theme.\nRendered editor:\n${unsupportedHarness.render()}`,
		);

		const supportedHarness = await createEditorHarness();
		supportedHarness.type("/agent --no-th");
		await supportedHarness.waitForRender((rendered) => rendered.includes("--no-themes"));
		assert.match(
			supportedHarness.render(),
			/--no-themes/,
			"Expected --no-themes to remain available",
		);
	});

	test("mid-line completion replaces only the active fragment and preserves the task suffix", async () => {
		const harness = await createEditorHarness();
		const suffix = " explain it";

		harness.type(`/agent --thi${suffix}`);
		harness.moveCursorLeft(suffix.length);
		harness.press("\t");
		await harness.waitForRender((rendered) => rendered.includes("/agent --thinking explain it"));
		assert.equal(
			harness.editor.getText(),
			"/agent --thinking explain it",
			"Expected Tab to replace the active option fragment",
		);
		await harness.waitForRender((rendered) => rendered.includes("off"));
		harness.press("\t");

		const expected = "/agent --thinking off explain it";
		assert.equal(
			harness.editor.getText(),
			expected,
			`Expected mid-line completion to preserve the suffix. Got: ${harness.editor.getText()}`,
		);
		assert.equal(
			harness.editor.getCursor().col,
			"/agent --thinking off ".length,
			"Expected the cursor before the preserved suffix",
		);
	});

	test("accepting --thinking chains into its value menu and completes with one trailing space", async () => {
		const harness = await createEditorHarness();

		harness.type("/agent --thi");
		await harness.waitForRender(
			(rendered) => rendered.includes("--thinking <level>") && !rendered.includes("-m <model>"),
		);
		harness.press("\t");
		assert.equal(
			harness.editor.getText(),
			"/agent --thinking ",
			`Expected the option edit before value chaining. Got: ${harness.editor.getText()}`,
		);

		await harness.waitForAutocomplete();
		await harness.waitForRender((rendered) => rendered.includes("high"));
		harness.type("high");
		await harness.waitForRender(
			(rendered) => rendered.includes("high") && !rendered.includes("off"),
		);
		harness.press("\t");

		const expected = "/agent --thinking high ";
		assert.equal(
			harness.editor.getText(),
			expected,
			`Expected one trailing space after the thinking value. Got: ${harness.editor.getText()}`,
		);
		assert.equal(
			harness.editor.getCursor().col,
			expected.length,
			`Expected the cursor after the trailing space. Got: ${harness.editor.getCursor().col}`,
		);
	});

	test("Enter accepts an enumerable option and value without submitting the command", async () => {
		const harness = await createEditorHarness();

		harness.type("/agent --thi");
		await harness.waitForRender((rendered) => rendered.includes("--thinking <level>"));
		harness.press("\r");
		await harness.waitForRender((rendered) => rendered.includes("off"));
		harness.press("\r");

		const expected = "/agent --thinking off ";
		assert.equal(
			harness.editor.getText(),
			expected,
			`Expected Enter to accept without submitting. Got: ${harness.editor.getText()}`,
		);
		assert.equal(
			harness.editor.getCursor().col,
			expected.length,
			"Expected the cursor after the trailing separator",
		);
		assert.equal(
			harness.editor.isShowingAutocomplete(),
			false,
			"Expected the value menu to close after acceptance",
		);
	});

	test("a model option chains into the live model catalog and inserts its canonical reference", async () => {
		const harness = await createEditorHarness(process.cwd(), [
			{ provider: "openai-codex", id: "gpt-5.6-sol", name: "gpt56s" },
		]);

		harness.type("/agent -m");
		await harness.waitForRender(
			(rendered) => rendered.includes("-m <model>") && !rendered.includes("--model <model>"),
		);
		harness.press("\t");
		assert.equal(
			harness.editor.getText(),
			"/agent -m ",
			`Expected the model option edit before chaining. Got: ${harness.editor.getText()}`,
		);

		await harness.waitForRender((rendered) => rendered.includes("openai-codex/gpt-5.6-sol"));
		harness.press("\t");
		const expected = "/agent -m openai-codex/gpt-5.6-sol ";
		assert.equal(
			harness.editor.getText(),
			expected,
			`Expected the canonical live model reference. Got: ${harness.editor.getText()}`,
		);
		assert.equal(
			harness.editor.getCursor().col,
			expected.length,
			"Expected the model cursor after one trailing separator",
		);
	});

	test("scoped models lead the unfiltered model menu", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-user-agents-scoped-models-"));
		try {
			await mkdir(join(cwd, ".pi"));
			await writeFile(
				join(cwd, ".pi", "settings.json"),
				JSON.stringify({ enabledModels: ["gpt56s"] }),
			);
			const harness = await createEditorHarness(cwd, [
				{ provider: "anthropic", id: "claude-opus-4-8", name: "opus" },
				{ provider: "openai-codex", id: "gpt-5.6-sol", name: "gpt56s" },
			]);

			harness.type("/agent -m");
			await harness.waitForRender((rendered) => rendered.includes("-m <model>"));
			harness.press("\t");
			await harness.waitForRender(
				(rendered) =>
					rendered.includes("anthropic/claude-opus-4-8") &&
					rendered.includes("openai-codex/gpt-5.6-sol") &&
					rendered.includes("gpt56s"),
			);
			harness.press("\t");

			assert.equal(
				harness.editor.getText(),
				"/agent -m openai-codex/gpt-5.6-sol ",
				"Expected the first unfiltered model completion to use the configured scope order",
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a stronger fuzzy model match outranks scoped menu priority", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-user-agents-fuzzy-models-"));
		try {
			await mkdir(join(cwd, ".pi"));
			await writeFile(
				join(cwd, ".pi", "settings.json"),
				JSON.stringify({ enabledModels: ["long-scoped/gpt"] }),
			);
			const harness = await createEditorHarness(cwd, [
				{ provider: "gpt", id: "other" },
				{ provider: "long-scoped", id: "gpt" },
			]);

			harness.type("/agent -m");
			await harness.waitForRender((rendered) => rendered.includes("-m <model>"));
			harness.press("\t");
			harness.type("gpt");
			await harness.waitForRender(
				(rendered) => rendered.includes("gpt/other") && rendered.includes("long-scoped/gpt"),
			);
			const rendered = harness.render();
			assert.ok(
				rendered.indexOf("gpt/other") < rendered.indexOf("long-scoped/gpt"),
				`Expected fuzzy relevance to determine menu order after the user types a query.\nRendered editor:\n${rendered}`,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("using either model alias suppresses both spellings from the next option menu", async () => {
		for (const modelOption of ["-m", "--model"]) {
			const harness = await createEditorHarness(process.cwd(), [
				{ provider: "openai-codex", id: "gpt-5.6-sol" },
			]);
			harness.type(`/agent ${modelOption}`);
			await harness.waitForRender((rendered) => rendered.includes(`${modelOption} <model>`));
			harness.press("\t");
			await harness.waitForRender((rendered) => rendered.includes("openai-codex/gpt-5.6-sol"));
			harness.press("\t");
			harness.type("-");
			await harness.waitForAutocomplete();

			const rendered = harness.render();
			assert.doesNotMatch(
				rendered,
				/-m <model>/,
				`Expected ${modelOption} to suppress -m.\nRendered editor:\n${rendered}`,
			);
			assert.doesNotMatch(
				rendered,
				/--model <model>/,
				`Expected ${modelOption} to suppress --model.\nRendered editor:\n${rendered}`,
			);
		}
	});

	test("both tool options complete from the live catalog without inserting a separator", async () => {
		for (const option of ["--tools", "--exclude-tools"]) {
			const harness = await createEditorHarness(process.cwd(), [], [
				{ name: "grep", description: "Search file contents" },
				{ name: "read", description: "Read a file" },
			]);

			harness.type(`/agent ${option} `);
			await harness.waitForRender(
				(rendered) => rendered.includes("grep") && rendered.includes("read"),
			);
			harness.type("gr");
			await harness.waitForRender(
				(rendered) => rendered.includes("grep") && !rendered.includes("read"),
			);
			harness.press("\t");

			const expected = `/agent ${option} grep`;
			assert.equal(
				harness.editor.getText(),
				expected,
				`Expected ${option} to insert the selected tool without a space or comma. Got: ${harness.editor.getText()}`,
			);
			assert.equal(
				harness.editor.getCursor().col,
				expected.length,
				`Expected ${option} cursor immediately after the selected tool`,
			);
			assert.equal(
				harness.editor.isShowingAutocomplete(),
				false,
				`Expected ${option} menu to close after accepting the selected tool`,
			);
			harness.type(" ");
			await harness.waitForAutocompleteToRemainHidden();
			assert.equal(
				harness.editor.getText(),
				`${expected} `,
				`Expected ${option} to leave the normal finishing space to the user`,
			);
		}
	});

	test("a typed comma immediately opens the next tool segment without selected tools", async () => {
		for (const option of ["--tools", "--exclude-tools"]) {
			const harness = await createEditorHarness(process.cwd(), [], [
				{ name: "grep", description: "Search file contents" },
				{ name: "read", description: "Read a file" },
			]);
			harness.type(`/agent ${option} gr`);
			await harness.waitForRender((rendered) => rendered.includes("Search file contents"));
			harness.press("\t");
			harness.type(",");
			await harness.waitForAutocomplete();

			const nextSegmentMenu = harness.render();
			assert.match(
				nextSegmentMenu,
				/\n[→ ]+read\s+Read a file/,
				`Expected ${option} comma to offer an unselected tool.\nRendered editor:\n${nextSegmentMenu}`,
			);
			assert.doesNotMatch(
				nextSegmentMenu,
				/\n[→ ]+grep\s+Search file contents/,
				`Expected ${option} comma to exclude the selected tool.\nRendered editor:\n${nextSegmentMenu}`,
			);

			harness.type("re");
			harness.press("\t");
			const expected = `/agent ${option} grep,read`;
			assert.equal(
				harness.editor.getText(),
				expected,
				`Expected ${option} to preserve the prior comma segment. Got: ${harness.editor.getText()}`,
			);
			assert.equal(
				harness.editor.getCursor().col,
				expected.length,
				`Expected ${option} cursor immediately after the next tool`,
			);
			assert.equal(
				harness.editor.isShowingAutocomplete(),
				false,
				`Expected ${option} menu to close after accepting the next tool`,
			);
		}
	});

	test("a live tool added after editor setup completes only the active middle segment", async () => {
		const tools = [
			{ name: "grep", description: "Search file contents" },
			{ name: "read", description: "Read a file" },
		];
		const harness = await createEditorHarness(process.cwd(), [], tools);
		tools.push({ name: "write", description: "Write a file" });
		const suffix = ",read";
		harness.type(`/agent --tools grep,wr${suffix}`);
		harness.moveCursorLeft(suffix.length);
		harness.press("\t");
		await harness.waitForRender((rendered) => rendered.includes("grep,write,read"));

		const expected = "/agent --tools grep,write,read";
		assert.equal(
			harness.editor.getText(),
			expected,
			`Expected live completion to preserve both neighboring segments. Got: ${harness.editor.getText()}`,
		);
		assert.equal(
			harness.editor.getCursor().col,
			"/agent --tools grep,write".length,
			"Expected the cursor immediately after the completed middle segment",
		);
	});

	test("--provider chains into the unique providers from the live model catalog", async () => {
		const harness = await createEditorHarness(process.cwd(), [
			{ provider: "openai-codex", id: "gpt-5.6-sol" },
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "anthropic", id: "claude-opus-4-8" },
		]);

		harness.type("/agent --prov");
		await harness.waitForRender(
			(rendered) =>
				rendered.includes("--provider <provider>") && !rendered.includes("--prompt-template"),
		);
		harness.press("\t");
		await harness.waitForRender(
			(rendered) => rendered.includes("openai-codex") && rendered.includes("anthropic"),
		);
		harness.type("openai");
		await harness.waitForRender(
			(rendered) => rendered.includes("openai-codex") && !rendered.includes("anthropic"),
		);
		harness.press("\t");

		const expected = "/agent --provider openai-codex ";
		assert.equal(
			harness.editor.getText(),
			expected,
			`Expected the selected live provider plus one separator. Got: ${harness.editor.getText()}`,
		);
		assert.equal(
			harness.editor.getCursor().col,
			expected.length,
			"Expected the provider cursor after one trailing separator",
		);
	});

	test("--provider scopes the live model menu for both model option spellings", async () => {
		const models = [
			{ provider: "openai-codex", id: "gpt-5.6-sol" },
			{ provider: "anthropic", id: "claude-opus-4-8" },
		];

		for (const modelOption of ["-m", "--model"]) {
			const harness = await createEditorHarness(process.cwd(), models);
			harness.type(`/agent --provider openai-codex ${modelOption}`);
			await harness.waitForRender((rendered) => rendered.includes(`${modelOption} <model>`));
			harness.press("\t");
			await harness.waitForRender((rendered) => rendered.includes("openai-codex/gpt-5.6-sol"));

			const rendered = harness.render();
			assert.doesNotMatch(
				rendered,
				/anthropic\/claude-opus-4-8/,
				`Expected --provider to scope the ${modelOption} live model menu.\nRendered editor:\n${rendered}`,
			);
		}
	});

	test("a free-form option creates a guarded quoted slot without a fake value menu", async () => {
		const harness = await createEditorHarness();

		harness.type("/agent --sys");
		await harness.waitForRender(
			(rendered) =>
				rendered.includes("--system-prompt <text>") && !rendered.includes("--append-system-prompt"),
		);
		harness.press("\t");

		assert.equal(
			harness.editor.getText(),
			'/agent --system-prompt "" ',
			`Expected a guarded free-form slot. Got: ${harness.editor.getText()}`,
		);
		assert.equal(
			harness.editor.getCursor().col,
			'/agent --system-prompt "'.length,
			"Expected the cursor between the guarded quotes",
		);
		assert.equal(
			harness.editor.isShowingAutocomplete(),
			false,
			"Expected no synthetic picker for a free-form value",
		);

		harness.type("be terse");
		assert.equal(
			harness.editor.getText(),
			'/agent --system-prompt "be terse" ',
			"Expected typed text to remain inside the guarded quotes",
		);
	});

	test("installed skill and prompt shortcuts insert their public source paths beside filesystem fallback", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-user-agents-resource-shortcuts-"));
		try {
			await mkdir(join(cwd, "installed-skill"));
			const skillPath = join(cwd, "installed-skill", "SKILL.md");
			const promptPath = join(cwd, "installed-prompt.md");
			await writeFile(skillPath, "---\nname: deploy\n---\n");
			await writeFile(promptPath, "Deploy prompt\n");
			const extensionPath = join(cwd, "installed-extension.ts");
			await writeFile(extensionPath, "export default () => undefined;\n");
			await writeFile(join(cwd, "manual-resource.txt"), "Filesystem fallback\n");
			const resourceCommands = [
				{
					name: "skill:deploy",
					description: "Deploy skill",
					source: "skill" as const,
					sourceInfo: { path: skillPath },
				},
				{
					name: "deploy-prompt",
					description: "Deploy prompt",
					source: "prompt" as const,
					sourceInfo: { path: promptPath },
				},
				{
					name: "extension-command",
					description: "Extension command",
					source: "extension" as const,
					sourceInfo: { path: extensionPath },
				},
			];

			for (const { option, shortcut, unrelated, expectedPath } of [
				{
					option: "--skill",
					shortcut: "skill:deploy",
					unrelated: "deploy-prompt",
					expectedPath: skillPath,
				},
				{
					option: "--prompt-template",
					shortcut: "deploy-prompt",
					unrelated: "skill:deploy",
					expectedPath: promptPath,
				},
			]) {
				const harness = await createEditorHarness(cwd, [], [], resourceCommands);
				harness.type(`/agent ${option} `);
				await harness.waitForRender(
					(rendered) => rendered.includes(shortcut) && rendered.includes("manual-resource.txt"),
				);
				const rendered = harness.render();
				assert.doesNotMatch(
					rendered,
					new RegExp(`\\n[→ ]+${unrelated.replace(":", "\\:")}\\s`),
					`Expected ${option} to omit shortcuts from the other resource domain.\nRendered editor:\n${rendered}`,
				);
				assert.doesNotMatch(
					rendered,
					/\n[→ ]+extension-command\s/,
					`Expected ${option} to omit extension commands.\nRendered editor:\n${rendered}`,
				);

				harness.press("\t");
				const expected = `/agent ${option} ${expectedPath} `;
				assert.equal(
					harness.editor.getText(),
					expected,
					`Expected ${option} shortcut to insert sourceInfo.path. Got: ${harness.editor.getText()}`,
				);
				assert.equal(
					harness.editor.getCursor().col,
					expected.length,
					`Expected ${option} shortcut cursor after one trailing separator`,
				);
			}

			const extensionHarness = await createEditorHarness(cwd, [], [], resourceCommands);
			extensionHarness.type("/agent --extension ");
			await extensionHarness.waitForRender((rendered) => rendered.includes("installed-extension.ts"));
			assert.doesNotMatch(
				extensionHarness.render(),
				/\n[→ ]+extension-command\s/,
				`Expected --extension to remain filesystem-only.\nRendered editor:\n${extensionHarness.render()}`,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("a named shortcut replaces a guarded fragment with one quoted source path", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-user-agents-guarded-shortcut-"));
		try {
			await mkdir(join(cwd, "installed skills"));
			const skillPath = join(cwd, "installed skills", "SKILL.md");
			await writeFile(skillPath, "---\nname: deploy\n---\n");
			const harness = await createEditorHarness(cwd, [], [], [
				{
					name: "skill:deploy",
					description: "Deploy skill",
					source: "skill",
					sourceInfo: { path: skillPath },
				},
			]);

			harness.type("/agent --ski");
			await harness.waitForRender((rendered) => rendered.includes("--skill <path>"));
			harness.press("\t");
			await harness.waitForRender((rendered) => rendered.includes("skill:deploy"));
			harness.type("deploy");
			await harness.waitForRender(
				(rendered) => rendered.includes("skill:deploy") && !rendered.includes("installed skills/"),
			);
			harness.press("\t");

			const expected = `/agent --skill "${skillPath}" `;
			assert.equal(
				harness.editor.getText(),
				expected,
				`Expected the guarded shortcut to insert one quoted source path. Got: ${harness.editor.getText()}`,
			);
			assert.equal(
				harness.editor.getCursor().col,
				expected.length,
				"Expected the guarded shortcut cursor after the outer separator",
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("manually typing every path option eagerly opens native filesystem completion", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-user-agents-path-options-"));
		try {
			await writeFile(join(cwd, "extension-fixture.ts"), "export default () => undefined;\n");
			await mkdir(join(cwd, "skill-fixture"));
			await writeFile(join(cwd, "skill-fixture", "SKILL.md"), "---\nname: fixture\n---\n");
			await writeFile(join(cwd, "prompt-fixture.md"), "Prompt fixture\n");

			for (const { option, fixture } of [
				{ option: "-e", fixture: "extension-fixture.ts" },
				{ option: "--extension", fixture: "extension-fixture.ts" },
				{ option: "--skill", fixture: "skill-fixture/" },
				{ option: "--prompt-template", fixture: "prompt-fixture.md" },
			]) {
				const harness = await createEditorHarness(cwd);
				harness.type(`/agent ${option} `);
				await harness.waitForRender((rendered) => rendered.includes(fixture));

				assert.equal(
					harness.editor.isShowingAutocomplete(),
					true,
					`Expected manually typed ${option} and its value boundary to open filesystem completion.\nRendered editor:\n${harness.render()}`,
				);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("path completion traverses inside guarded quotes and finishes after the outer space", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-user-agents-autocomplete-"));
		try {
			await mkdir(join(cwd, "skill-fixture"));
			await writeFile(join(cwd, "skill-fixture", "SKILL.md"), "---\nname: fixture\n---\n");
			const harness = await createEditorHarness(cwd);

			harness.type("/agent --ski");
			await harness.waitForRender(
				(rendered) => rendered.includes("--skill <path>") && !rendered.includes("-m <model>"),
			);
			harness.press("\t");
			assert.equal(
				harness.editor.getText(),
				'/agent --skill "" ',
				`Expected a guarded path slot. Got: ${harness.editor.getText()}`,
			);
			assert.equal(
				harness.editor.getCursor().col,
				'/agent --skill "'.length,
				"Expected the cursor inside the guarded path slot",
			);

			await harness.waitForRender((rendered) => rendered.includes("skill-fixture/"));
			harness.press("\t");
			assert.equal(
				harness.editor.getText(),
				'/agent --skill "skill-fixture/" ',
				`Expected directory traversal to preserve the guarded slot. Got: ${harness.editor.getText()}`,
			);
			assert.equal(
				harness.editor.getCursor().col,
				'/agent --skill "skill-fixture/'.length,
				"Expected the directory cursor before the closing quote",
			);

			await harness.waitForRender((rendered) => rendered.includes("SKILL.md"));
			harness.press("\t");
			const expected = '/agent --skill "skill-fixture/SKILL.md" ';
			assert.equal(
				harness.editor.getText(),
				expected,
				`Expected the completed quoted path plus one separator. Got: ${harness.editor.getText()}`,
			);
			assert.equal(
				harness.editor.getCursor().col,
				expected.length,
				"Expected the completed-file cursor after the outer separator",
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
