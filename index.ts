import type {
	MessageEndEvent,
	MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { registerAgentAutocomplete } from "./autocomplete.js";
import { handleAgentCommand } from "./runner.js";
import type {
	AgentCommandDetails,
	DetachedEntryData,
	ExtensionAPI,
	RunningAgent,
} from "./shared.js";
import { DETACHED_ENTRY_TYPE, MESSAGE_TYPE } from "./shared.js";
import { registerUserAgentRenderer } from "./transcript.js";
import { UserAgentWidget } from "./widget.js";

export default function userAgent(pi: ExtensionAPI): void {
	const runningAgents = new Set<RunningAgent>();
	const widget = new UserAgentWidget(
		runningAgents,
		(message) => pi.sendMessage(message, { triggerTurn: true }),
		(sessionId) => pi.appendEntry<DetachedEntryData>(DETACHED_ENTRY_TYPE, { sessionId }),
	);
	let shuttingDown = false;
	let nextAgentNumber = 0;

	registerUserAgentRenderer(pi);
	registerAgentAutocomplete(pi);

	pi.on("message_end", (event) => confirmMainContextJoin(event, widget));

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

export function confirmMainContextJoin(
	event: MessageEndEvent,
	widget: UserAgentWidget,
): MessageEndEventResult | undefined {
	if (event.message.role !== "custom" || event.message.customType !== MESSAGE_TYPE) return;
	const details = event.message.details as AgentCommandDetails | undefined;
	if (!details?.agentId || details.mainContextState !== "will-join") return;
	widget.confirmMainContextJoin(details.agentId);
	details.mainContextState = "joined";
	return {
		message: {
			...event.message,
			details: { ...details, mainContextState: "joined" },
		},
	};
}
