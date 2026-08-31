import { describe, test } from "bun:test";
import assert from "node:assert/strict";
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
