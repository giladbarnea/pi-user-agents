import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { analyzeAgentEditorInput, scanAgentCommandLine } from "../command-line.ts";
import { parseAgentCommand } from "../runner.ts";

describe("theme option policy", () => {
	test("--theme is rejected while --no-themes remains supported", () => {
		assert.throws(
			() => parseAgentCommand("--theme ./theme.json do it", "agent"),
			/\/agent does not support --theme/,
			"Expected /agent to reject Pi's singular --theme option",
		);
		assert.deepEqual(
			parseAgentCommand("--no-themes do it", "agent"),
			{
				isolate: false,
				squash: false,
				forwardedArgs: ["--no-themes"],
				task: "do it",
				warnings: [],
			},
			"Expected /agent to continue forwarding --no-themes",
		);
	});

	test("a prose-mode --theme advisory retains its path value", () => {
		const parsed = parseAgentCommand("do it --theme ./theme.json", "agent");
		assert.deepEqual(
			parsed,
			{
				isolate: false,
				squash: false,
				forwardedArgs: [],
				task: "do it --theme ./theme.json",
				warnings: [
					"--theme ./theme.json was included in the prompt body. To specify an argument or an option, place it at the beginning of the command input: /agent --theme ./theme.json do …",
				],
			},
			`Expected the unsupported theme advisory to retain its path. Got: ${JSON.stringify(parsed)}`,
		);
	});
});

describe("/agent-attach stays outside the /agent editor machinery", () => {
	test("neither the semantic scan nor cursor analysis recognizes an /agent-attach line", () => {
		assert.equal(
			scanAgentCommandLine("/agent-attach 0199c4f2"),
			undefined,
			"Expected /agent coloring to ignore /agent-attach lines",
		);
		assert.equal(
			analyzeAgentEditorInput("/agent-attach -", "/agent-attach -".length),
			undefined,
			"Expected /agent autocomplete to ignore /agent-attach lines",
		);
	});
});
