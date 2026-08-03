import { registerAgentAutocomplete } from "./autocomplete.js";
import { handleAgentCommand } from "./runner.js";
import type { ExtensionAPI, RunningAgent } from "./shared.js";
import { registerUserAgentRenderer } from "./transcript.js";
import { UserAgentWidget } from "./widget.js";

export default function userAgent(pi: ExtensionAPI): void {
	const runningAgents = new Set<RunningAgent>();
	const widget = new UserAgentWidget(runningAgents, (message) =>
		pi.sendMessage(message, { triggerTurn: true }),
	);
	let shuttingDown = false;
	let nextAgentNumber = 0;

	registerUserAgentRenderer(pi);
	registerAgentAutocomplete(pi);

	pi.registerCommand("agent", {
		description:
			"Run a background SDK agent with current session context; forwards pi CLI options like --thinking (-i/--isolate for none)",
		handler: async (args, ctx) => {
			await handleAgentCommand(
				pi,
				runningAgents,
				widget,
				() => shuttingDown,
				() => ++nextAgentNumber,
				"agent",
				args,
				`/agent ${args}`.trim(),
				ctx,
			);
		},
	});

	pi.registerCommand("agent-isolated", {
		description: "Alias for /agent -i: run without current session context",
		handler: async (args, ctx) => {
			await handleAgentCommand(
				pi,
				runningAgents,
				widget,
				() => shuttingDown,
				() => ++nextAgentNumber,
				"agent-isolated",
				`-i ${args}`,
				`/agent-isolated ${args}`.trim(),
				ctx,
			);
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		widget.dispose();
		const agents = [...runningAgents];
		for (const agent of agents) {
			void agent.session?.abort();
			agent.retire?.();
		}
		await Promise.allSettled(agents.map((agent) => agent.finished));
		for (const agent of agents) {
			agent.session?.dispose();
		}
		runningAgents.clear();
	});
}
