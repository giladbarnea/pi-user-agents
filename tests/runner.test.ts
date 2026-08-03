import { beforeAll, describe, expect, test } from "bun:test";
import { ModelRuntime } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import {
	buildChildResourceLoaderOptions,
	parseAgentCommand,
	parseForwardedArgs,
	resolveForwardedOptions,
	waitForInstruction,
} from "../runner.ts";
import type { RunningAgent } from "../shared.ts";

/** The slice of RunningAgent that waitForInstruction reads and writes. */
type RunningAgentForTest = Pick<
	RunningAgent,
	"id" | "status" | "startedAt" | "turnStartedAt" | "completedAt" | "resume" | "retire"
>;

const base = {
	isolate: false,
	context: false,
	forwardedArgs: [] as string[],
	warnings: [] as string[],
};

/** Build the single prose-body advisory exactly as the parser emits it (§5). */
function warning(
	command: "agent" | "agent-isolated",
	optionWithValue: string,
	firstProseWord: string,
): string {
	return `${optionWithValue} was included in the prompt body. To specify an argument or an option, place it at the beginning of the command input: /${command} ${optionWithValue} ${firstProseWord} …`;
}

describe("parseAgentCommand — args → prose one-way flip (§2, §4)", () => {
	test("a leading non-dash word flips the whole input to prose", () => {
		expect(parseAgentCommand("do the thing now", "agent")).toEqual({
			...base,
			task: "do the thing now",
		});
	});

	test("consumes leading options then flips at the first prose word", () => {
		expect(parseAgentCommand("--thinking high do the thing", "agent")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "high"],
			task: "do the thing",
		});
	});

	test("never returns to args mode: a recognized option after the flip stays in the prose", () => {
		expect(parseAgentCommand("-m gpt56s hello --thinking high world", "agent")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56s"],
			task: "hello --thinking high world",
			warnings: [warning("agent", "--thinking high", "hello")],
		});
	});

	test("preserves leading whitespace when the very first token is prose", () => {
		expect(parseAgentCommand("   go now", "agent")).toEqual({ ...base, task: "   go now" });
	});

	test("skips leading whitespace to reach the first option (Pi passes command args untrimmed — a stray space must not drop flags)", () => {
		expect(parseAgentCommand(" --thinking high fix it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "high"],
			task: "fix it",
		});
		expect(parseAgentCommand("   -i do the thing", "agent")).toEqual({
			...base,
			isolate: true,
			task: "do the thing",
		});
	});
});

describe("parseAgentCommand — extension options (§3a)", () => {
	test("normalizes -m to Pi's --model option", () => {
		expect(parseAgentCommand("-m gpt56t Explain it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56t"],
			task: "Explain it",
		});
	});

	test("consumes -i / --isolate", () => {
		expect(parseAgentCommand("-i do the thing", "agent")).toEqual({
			...base,
			isolate: true,
			task: "do the thing",
		});
		expect(parseAgentCommand("--isolate do the thing", "agent")).toEqual({
			...base,
			isolate: true,
			task: "do the thing",
		});
	});

	test("consumes -j / --join", () => {
		expect(parseAgentCommand("-j do the thing", "agent")).toEqual({
			...base,
			context: true,
			task: "do the thing",
		});
		expect(parseAgentCommand("--join do the thing", "agent")).toEqual({
			...base,
			context: true,
			task: "do the thing",
		});
	});

	test("consumes leading options in any order", () => {
		const expected = {
			...base,
			forwardedArgs: ["--model", "gpt56t"],
			isolate: true,
			context: true,
			task: "do the thing",
		};
		expect(parseAgentCommand("-j -i -m gpt56t do the thing", "agent")).toEqual(expected);
		expect(parseAgentCommand("-m gpt56t -i --join do the thing", "agent")).toEqual(expected);
	});

	test("the previous --context option is no longer recognized", () => {
		expect(parseAgentCommand("--context do the thing", "agent")).toEqual({
			...base,
			task: "--context do the thing",
		});
	});

	test("bare -m without a model name remains a usage error", () => {
		expect(() => parseAgentCommand("-m", "agent")).toThrow(/Usage/);
		expect(() => parseAgentCommand("-m   ", "agent")).toThrow(/Usage/);
		expect(() => parseAgentCommand("-i -m", "agent")).toThrow(/Usage/);
	});

	test("an empty task after consuming options is a usage error", () => {
		expect(() => parseAgentCommand("-i", "agent")).toThrow(/Usage/);
		expect(() => parseAgentCommand("--thinking high", "agent")).toThrow(/Usage/);
	});
});

describe("parseAgentCommand — known pi option arity from the static table (§3b)", () => {
	test("a value option consumes the next token", () => {
		expect(parseAgentCommand("--thinking high do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "high"],
			task: "do it",
		});
	});

	test("a boolean option consumes no value", () => {
		expect(parseAgentCommand("--offline do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--offline"],
			task: "do it",
		});
	});

	test("models --print / -p as boolean so the optional-value form cannot eat the next prose word", () => {
		expect(parseAgentCommand("--print do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--print"],
			task: "do it",
		});
		expect(parseAgentCommand("-p do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["-p"],
			task: "do it",
		});
	});

	test("a value option swallows a following option-looking token as its verbatim value", () => {
		expect(parseAgentCommand("--thinking --offline do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "--offline"],
			task: "do it",
		});
	});

	test("a value option swallows even an extension option as its value", () => {
		expect(parseAgentCommand("--thinking -i do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "-i"],
			task: "do it",
		});
	});

	test("recognizes short-form value options", () => {
		expect(parseAgentCommand("-t read,edit do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["-t", "read,edit"],
			task: "do it",
		});
		expect(parseAgentCommand("-e ./ext do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["-e", "./ext"],
			task: "do it",
		});
	});

	test("recognizes short-form boolean options", () => {
		expect(parseAgentCommand("-nt do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["-nt"],
			task: "do it",
		});
		expect(parseAgentCommand("-nbt do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["-nbt"],
			task: "do it",
		});
	});

	test("accumulates a repeated multi-value option in input order", () => {
		expect(
			parseAgentCommand("--append-system-prompt a --append-system-prompt b do it", "agent"),
		).toEqual({
			...base,
			forwardedArgs: ["--append-system-prompt", "a", "--append-system-prompt", "b"],
			task: "do it",
		});
	});

	test("a value option with no following token does not crash (empty task → usage error)", () => {
		expect(() => parseAgentCommand("--thinking", "agent")).toThrow(/Usage/);
	});
});

describe("parseAgentCommand — reading a quoted option value (§3b)", () => {
	test("strips the surrounding quotes and spans internal whitespace into one forwardedArgs element", () => {
		expect(parseAgentCommand('--system-prompt "I am psyched" do it', "agent")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "I am psyched"],
			task: "do it",
		});
	});

	test("strips the quotes even when the value has no internal whitespace", () => {
		expect(parseAgentCommand('--system-prompt "Psych" do it', "agent")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "Psych"],
			task: "do it",
		});
	});

	test("reads and dequotes a quoted value for the -m alias", () => {
		expect(parseAgentCommand('-m "gpt56s" go', "agent")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56s"],
			task: "go",
		});
	});

	test("treats an option-looking quoted value as literal — no inner parsing, no spurious warning", () => {
		expect(parseAgentCommand('--system-prompt "talk about -m modelname arg" go', "agent")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "talk about -m modelname arg"],
			task: "go",
		});
	});

	test("keeps a backslash inside a quoted value verbatim (no recursion)", () => {
		expect(parseAgentCommand('--system-prompt "talk about \\-m arg" go', "agent")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "talk about \\-m arg"],
			task: "go",
		});
	});

	test("falls back to the whitespace-delimited token when a value opens a quote with no matching close", () => {
		expect(parseAgentCommand('--system-prompt "foo bar', "agent")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", '"foo'],
			task: "bar",
		});
	});
});

describe("parseAgentCommand — blocked pi options (§3c, §9)", () => {
	test("rejects -c / --continue for both agent commands", () => {
		for (const command of ["agent", "agent-isolated"] as const) {
			expect(() => parseAgentCommand("-c do it", command)).toThrow(/does not support -c/);
			expect(() => parseAgentCommand("--continue do it", command)).toThrow(
				/does not support --continue/,
			);
		}
	});

	test("rejects a leading blocked option with a hard error", () => {
		expect(() => parseAgentCommand("--export out.html do it", "agent")).toThrow(
			/does not support --export/,
		);
		expect(() => parseAgentCommand("--models a,b do it", "agent")).toThrow(
			/does not support --models/,
		);
		expect(() => parseAgentCommand("--list-models do it", "agent")).toThrow(
			/does not support --list-models/,
		);
		expect(() => parseAgentCommand("--help", "agent")).toThrow(/does not support --help/);
		expect(() => parseAgentCommand("-h", "agent")).toThrow(/does not support -h/);
		expect(() => parseAgentCommand("-v", "agent")).toThrow(/does not support -v/);
		expect(() => parseAgentCommand("--version", "agent")).toThrow(/does not support --version/);
	});

	test("a blocked option in the prose body warns instead of erroring", () => {
		expect(parseAgentCommand("do it --export out.html", "agent")).toEqual({
			...base,
			task: "do it --export out.html",
			warnings: [warning("agent", "--export", "do")],
		});
	});

	test("a blocked option consumed as a value option's value is taken verbatim, not rejected (§3b/§4)", () => {
		expect(parseAgentCommand("--thinking --help do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "--help"],
			task: "do it",
		});
		expect(parseAgentCommand("--thinking --export do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--thinking", "--export"],
			task: "do it",
		});
	});
});

describe("parseAgentCommand — prose-body warnings (§5)", () => {
	test("warns when a value option is typed in the prose body", () => {
		expect(parseAgentCommand("hello world -m gpt56s", "agent")).toEqual({
			...base,
			task: "hello world -m gpt56s",
			warnings: [warning("agent", "-m gpt56s", "hello")],
		});
	});

	test("emits one warning per recognized option occurrence, in order", () => {
		expect(parseAgentCommand("do the thing --offline --verbose", "agent")).toEqual({
			...base,
			task: "do the thing --offline --verbose",
			warnings: [warning("agent", "--offline", "do"), warning("agent", "--verbose", "do")],
		});
	});

	test("a value option in prose warns with the following option as its value AND that option warns again on its own (§9)", () => {
		expect(parseAgentCommand("go --thinking --offline now", "agent")).toEqual({
			...base,
			task: "go --thinking --offline now",
			warnings: [
				warning("agent", "--thinking --offline", "go"),
				warning("agent", "--offline", "go"),
			],
		});
	});

	test("renders the actual command name in the warning", () => {
		expect(parseAgentCommand("hello -m x", "agent-isolated")).toEqual({
			...base,
			task: "hello -m x",
			warnings: [warning("agent-isolated", "-m x", "hello")],
		});
	});

	test("does not warn on unknown arg-looking tokens (leading or in prose)", () => {
		expect(parseAgentCommand("-g badflagname hello world", "agent")).toEqual({
			...base,
			task: "-g badflagname hello world",
		});
		expect(parseAgentCommand("hello world -g badflagname", "agent")).toEqual({
			...base,
			task: "hello world -g badflagname",
		});
		expect(parseAgentCommand("--doesnotexist this is my message", "agent")).toEqual({
			...base,
			task: "--doesnotexist this is my message",
		});
	});

	test("does not recognize an =-form option (recognition is exact-token): flips to prose with no warning", () => {
		expect(parseAgentCommand("--thinking=high do it", "agent")).toEqual({
			...base,
			task: "--thinking=high do it",
		});
	});

	test("does not warn on quoted option-looking tokens", () => {
		expect(parseAgentCommand('summarize "-m gpt56"', "agent")).toEqual({
			...base,
			task: 'summarize "-m gpt56"',
		});
	});

	test("does not warn on backslash-escaped option-looking tokens", () => {
		expect(parseAgentCommand("tell me about \\-m please", "agent")).toEqual({
			...base,
			task: "tell me about -m please",
		});
	});

	test("uses the unescaped first prose word in the suggested rewrite", () => {
		expect(parseAgentCommand("\\-i --thinking high do it", "agent")).toEqual({
			...base,
			task: "-i --thinking high do it",
			warnings: [warning("agent", "--thinking high", "-i")],
		});
	});
});

describe("parseAgentCommand — quotes never stripped, suppress parsing (§6a)", () => {
	test("keeps quotes verbatim and never parses inside a matched span", () => {
		expect(parseAgentCommand('summarize "war and peace"', "agent")).toEqual({
			...base,
			task: 'summarize "war and peace"',
		});
	});

	test("a leading quoted span flips to prose and suppresses parsing", () => {
		expect(parseAgentCommand('"-m gpt56" now', "agent")).toEqual({
			...base,
			task: '"-m gpt56" now',
		});
	});

	test("an unmatched quote is a literal char with no protective effect", () => {
		expect(parseAgentCommand("hello 'world -m gpt56s", "agent")).toEqual({
			...base,
			task: "hello 'world -m gpt56s",
			warnings: [warning("agent", "-m gpt56s", "hello")],
		});
	});

	test("a backslash inside a matched quote span is not processed", () => {
		expect(parseAgentCommand('"\\-m gpt56 hello"', "agent")).toEqual({
			...base,
			task: '"\\-m gpt56 hello"',
		});
	});
});

describe("parseAgentCommand — non-straight quote pairs (§6a)", () => {
	test("reads a curly-double-quoted option value (closing quote differs from opening)", () => {
		expect(parseAgentCommand("--system-prompt “I am psyched” do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "I am psyched"],
			task: "do it",
		});
	});

	test("reads a curly-single-quoted option value (closing quote differs from opening)", () => {
		expect(parseAgentCommand("-m ‘gpt56s’ go", "agent")).toEqual({
			...base,
			forwardedArgs: ["--model", "gpt56s"],
			task: "go",
		});
	});

	test("reads a backtick-quoted option value", () => {
		expect(parseAgentCommand("--system-prompt `be terse` do it", "agent")).toEqual({
			...base,
			forwardedArgs: ["--system-prompt", "be terse"],
			task: "do it",
		});
	});

	test("a curly-quoted span in prose masks a bare recognized option inside it (no warning)", () => {
		expect(parseAgentCommand("summarize “do -m now”", "agent")).toEqual({
			...base,
			task: "summarize “do -m now”",
		});
	});

	test("a backtick-quoted span in prose masks a bare recognized option inside it (no warning)", () => {
		expect(parseAgentCommand("summarize `do -m now`", "agent")).toEqual({
			...base,
			task: "summarize `do -m now`",
		});
	});
});

describe("parseAgentCommand — backslash-before-dash removed, never recurses (§6b)", () => {
	test("removes a leading backslash before a dash", () => {
		expect(parseAgentCommand("\\-m hello", "agent")).toEqual({ ...base, task: "-m hello" });
		expect(parseAgentCommand("\\--thinking high", "agent")).toEqual({
			...base,
			task: "--thinking high",
		});
	});

	test("collapses the overly-cautious double form \\-\\- to --", () => {
		expect(parseAgentCommand("\\-\\-thinking high", "agent")).toEqual({
			...base,
			task: "--thinking high",
		});
		expect(parseAgentCommand("\\--word here", "agent")).toEqual({ ...base, task: "--word here" });
	});

	test("does not recurse beyond the double form", () => {
		expect(parseAgentCommand("\\-\\-\\-word here", "agent")).toEqual({
			...base,
			task: "--\\-word here",
		});
	});

	test("leaves a backslash that is not at a word-start before a dash literal", () => {
		expect(parseAgentCommand("\\backslash and foo\\-bar", "agent")).toEqual({
			...base,
			task: "\\backslash and foo\\-bar",
		});
	});

	test("processes a backslash-escaped dash already in prose, with no warning", () => {
		expect(parseAgentCommand("hello \\-m world", "agent")).toEqual({
			...base,
			task: "hello -m world",
		});
	});

	test("an escaped leading flag does not resurrect arg parsing", () => {
		expect(parseAgentCommand("\\-i do the thing", "agent")).toEqual({
			...base,
			task: "-i do the thing",
		});
	});

	test("applies the spec's mixed escape/quote worked examples", () => {
		expect(parseAgentCommand('hello agent, \\-m "gpt56s" how are you?', "agent")).toEqual({
			...base,
			task: 'hello agent, -m "gpt56s" how are you?',
		});
		expect(parseAgentCommand('hello agent, \\--thi"nking" high', "agent")).toEqual({
			...base,
			task: 'hello agent, --thi"nking" high',
		});
	});
});

describe("resolveForwardedOptions — static-arity forwarding (§7)", () => {
	let modelRuntime: ModelRuntime;
	beforeAll(async () => {
		modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
	});
	const resolve = (args: string[]) =>
		resolveForwardedOptions(parseForwardedArgs(args), modelRuntime);

	test("returns nothing for no forwarded args", () => {
		expect(resolve([])).toEqual({});
	});

	test("drops --provider when --model is absent (matches pi: provider-only is a no-op)", () => {
		expect(resolve(["--provider", "openai"])).toEqual({});
	});

	test("maps --thinking to the child thinking level", () => {
		expect(resolve(["--thinking", "high"])).toEqual({ thinkingLevel: "high" });
	});

	test("resolves --model through ModelRuntime", () => {
		const model = resolve(["--model", "openai-codex/gpt-5.6-luna"]).model;
		expect(model && `${model.provider}/${model.id}`).toBe("openai-codex/gpt-5.6-luna");
	});

	test("maps tool options", () => {
		expect(resolve(["--exclude-tools", "ask_question", "--no-builtin-tools"])).toEqual({
			noTools: "builtin",
			excludeTools: ["ask_question"],
		});
	});

	test("maps supported resource paths and keeps --no-themes", () => {
		expect(
			buildChildResourceLoaderOptions(
				parseForwardedArgs([
					"--no-context-files",
					"--no-themes",
					"--extension",
					"./extensions/foo.ts",
					"--skill",
					"./skills/foo",
					"--prompt-template",
					"./prompts/foo.md",
					"--append-system-prompt",
					"be terse",
				]),
				"/tmp/project",
			),
		).toEqual({
			noContextFiles: true,
			noThemes: true,
			additionalExtensionPaths: ["/tmp/project/extensions/foo.ts"],
			additionalSkillPaths: ["/tmp/project/skills/foo"],
			additionalPromptTemplatePaths: ["/tmp/project/prompts/foo.md"],
			appendSystemPrompt: ["be terse"],
		});
	});

	test("throws on a pi parser error", () => {
		expect(() => parseForwardedArgs(["--name"])).toThrow(/--name/);
	});
});

describe("waitForInstruction — idle lifecycle parking", () => {
	function idleAgent(): RunningAgentForTest {
		return {
			id: "user-1",
			status: "idle",
			startedAt: Date.now() - 5_000,
			turnStartedAt: Date.now() - 5_000,
			completedAt: Date.now() - 1_000,
		};
	}

	test("resume starts another turn: resolves with the instruction, resets turn timing, clears both closures", async () => {
		const agent = idleAgent();
		const updates: number[] = [];
		const parked = waitForInstruction(agent as never, { update: () => updates.push(1) });
		if (!agent.resume) throw new Error("resume closure was not assigned");

		const before = Date.now();
		agent.resume("now do the follow-up");

		await expect(parked).resolves.toBe("now do the follow-up");
		expect(agent.status).toBe("running");
		expect(agent.turnStartedAt).toBeGreaterThanOrEqual(before);
		expect(agent.completedAt).toBeUndefined();
		expect(agent.resume).toBeUndefined();
		expect(agent.retire).toBeUndefined();
		expect(updates).toEqual([1]);
	});

	test("retire ends the lifecycle: resolves undefined and clears both closures", async () => {
		const agent = idleAgent();
		const parked = waitForInstruction(agent as never, { update: () => undefined });
		if (!agent.retire) throw new Error("retire closure was not assigned");

		agent.retire();

		await expect(parked).resolves.toBeUndefined();
		expect(agent.status).toBe("idle");
		expect(agent.resume).toBeUndefined();
		expect(agent.retire).toBeUndefined();
	});

	test("a second wake after settling is a no-op (closures are cleared before resolution)", async () => {
		const agent = idleAgent();
		const parked = waitForInstruction(agent as never, { update: () => undefined });
		const resume = agent.resume;
		if (!resume) throw new Error("resume closure was not assigned");

		resume("first");
		agent.resume?.("second");
		agent.retire?.();

		await expect(parked).resolves.toBe("first");
	});
});
