import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { parseAgentCommand } from "../runner.ts";

describe("theme option policy", () => {
	test("--theme is rejected while --no-themes remains supported for both agent commands", () => {
		const runtimeCases = [
			{ command: "agent", prefix: "", isolate: false },
			{ command: "agent-isolated", prefix: "-i ", isolate: true },
		] as const;
		for (const { command, prefix, isolate } of runtimeCases) {
			assert.throws(
				() => parseAgentCommand(`${prefix}--theme ./theme.json do it`, command),
				new RegExp(`/${command} does not support --theme`),
				`Expected /${command} to reject Pi's singular --theme option`,
			);
			assert.deepEqual(
				parseAgentCommand(`${prefix}--no-themes do it`, command),
				{
					isolate,
					context: false,
					forwardedArgs: ["--no-themes"],
					task: "do it",
					warnings: [],
				},
				`Expected /${command} to continue forwarding --no-themes`,
			);
		}
	});

	test("a prose-mode --theme advisory retains its path value", () => {
		const parsed = parseAgentCommand("do it --theme ./theme.json", "agent");
		assert.deepEqual(
			parsed,
			{
				isolate: false,
				context: false,
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
