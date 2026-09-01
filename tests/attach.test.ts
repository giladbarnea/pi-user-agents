import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildAttachedAgent,
	handleAttachCommand,
	resolveChildSessionFile,
	runAttachedTurns,
	splitAtDispatchBoundary,
	UNKNOWN_DISPATCH_BASE,
} from "../attach.ts";
import { conversationFingerprint } from "../rebase.ts";
import { DISPATCH_PREAMBLE, persistMessages } from "../runner.ts";
import type {
	AgentMessage,
	AgentResultMessage,
	ExtensionCommandContext,
	Model,
	RebaseDelivery,
	RunningAgent,
} from "../shared.ts";
import { UserAgentWidget } from "../widget.ts";

/** A widget under test that must never rebase. */
const noRebase: RebaseDelivery = {
	canDeliver: () => false,
	deliver: () => {
		throw new Error("Unexpected rebase delivery");
	},
};

describe("splitAtDispatchBoundary — recover a child's own conversation from its resolved context", () => {
	const inherited = [
		{ role: "user", content: "original main prompt", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "original main answer" }],
			timestamp: 2,
			stopReason: "stop",
		},
	] as AgentMessage[];
	const dispatched = [
		{ role: "user", content: `${DISPATCH_PREAMBLE}review the migration`, timestamp: 3 },
		{
			role: "assistant",
			content: [{ type: "text", text: "migration reviewed" }],
			timestamp: 4,
			stopReason: "stop",
		},
	] as AgentMessage[];

	test("splits the inherited base from the conversation at the preambled dispatch message", () => {
		const boundary = splitAtDispatchBoundary([...inherited, ...dispatched]);

		expect(boundary, "Expected the preambled user message to mark the boundary").toBeDefined();
		expect(boundary?.base).toEqual(inherited);
		expect(boundary?.conversation).toEqual(dispatched);
		expect(boundary?.task).toBe("review the migration");
	});

	test("an isolated child starts at the boundary: empty base, whole context as conversation", () => {
		const boundary = splitAtDispatchBoundary(dispatched);

		expect(boundary?.base).toEqual([]);
		expect(boundary?.conversation).toEqual(dispatched);
		expect(boundary?.task).toBe("review the migration");
	});

	test("recognizes the preamble inside parts-array user content", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: `${DISPATCH_PREAMBLE}audit the errors` }],
				timestamp: 1,
			},
		] as AgentMessage[];

		expect(splitAtDispatchBoundary(messages)?.task).toBe("audit the errors");
	});

	test("returns undefined when no user message carries the preamble (a /fork child, or the boundary compacted away)", () => {
		expect(splitAtDispatchBoundary(inherited)).toBeUndefined();
		expect(splitAtDispatchBoundary([])).toBeUndefined();
	});

	test("an assistant message quoting the preamble is not a boundary", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: `${DISPATCH_PREAMBLE}not a dispatch` }],
				timestamp: 1,
				stopReason: "stop",
			},
		] as AgentMessage[];

		expect(splitAtDispatchBoundary(messages)).toBeUndefined();
	});
});

describe("resolveChildSessionFile — session id (or unique prefix) → session file", () => {
	function sessionDirectoryWith(fileNames: string[]): string {
		const directory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-"));
		for (const name of fileNames) writeFileSync(join(directory, name), "");
		return directory;
	}
	const idA = "0199c4f2-8b1a-7c3d-9e05-6a2f18d7b4ce";
	const idB = "0199d000-1111-7abc-9e05-6a2f18d7b4ce";
	const fileA = `2026-09-01T10-00-00-000Z_${idA}.jsonl`;
	const fileB = `2026-09-01T11-00-00-000Z_${idB}.jsonl`;

	test("resolves an exact session id and a unique prefix", () => {
		const directory = sessionDirectoryWith([fileA, fileB, "notes.txt", "no-underscore.jsonl"]);
		try {
			expect(resolveChildSessionFile(idA, directory)).toBe(join(directory, fileA));
			expect(resolveChildSessionFile("0199d", directory)).toBe(join(directory, fileB));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("errors when nothing matches, including a missing session directory", () => {
		const directory = sessionDirectoryWith([fileA]);
		try {
			expect(() => resolveChildSessionFile("ffff", directory)).toThrow(
				'No agent session matches "ffff"',
			);
			expect(() => resolveChildSessionFile(idA, join(directory, "missing"))).toThrow(
				`No agent session matches "${idA}"`,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("errors on an ambiguous prefix", () => {
		const directory = sessionDirectoryWith([fileA, fileB]);
		try {
			expect(() => resolveChildSessionFile("0199", directory)).toThrow(
				'"0199" matches 2 sessions',
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("buildAttachedAgent — an idle, steerable row rebuilt from the child's session file", () => {
	const model = { provider: "openai-codex", id: "gpt-5.6-luna", name: "luna" } as Model;

	function reopenedChildSession(messages: AgentMessage[]): {
		sessionManager: SessionManager;
		sessionDirectory: string;
	} {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-"));
		const sessionManager = SessionManager.create("/tmp/project", sessionDirectory);
		persistMessages(sessionManager, messages, []);
		const reopened = SessionManager.open(sessionManager.getSessionFile() as string);
		return { sessionManager: reopened, sessionDirectory };
	}

	const inherited = [
		{ role: "user", content: "original main prompt", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "original main answer" }],
			timestamp: 2,
			stopReason: "stop",
		},
	] as AgentMessage[];
	const dispatched = [
		{ role: "user", content: `${DISPATCH_PREAMBLE}review the migration`, timestamp: 3 },
		{
			role: "assistant",
			content: [{ type: "text", text: "migration reviewed" }],
			timestamp: 4,
			stopReason: "stop",
		},
	] as AgentMessage[];

	test("recovers the task, conversation, response, fingerprint, and squashable result from a dispatched child", () => {
		const { sessionManager, sessionDirectory } = reopenedChildSession([
			...inherited,
			...dispatched,
		]);
		try {
			const agent = buildAttachedAgent(7, sessionManager, model, "/agent-attach 0199");

			expect(agent.id).toBe("user-7");
			expect(agent.sessionId).toBe(sessionManager.getSessionId());
			expect(agent).toMatchObject({
				command: "agent",
				status: "idle",
				notifyMainAgent: false,
				mainContextState: "separate",
				inheritedContext: true,
				task: "review the migration",
				modelLabel: "luna",
				responseText: "migration reviewed",
			});
			expect(agent.completedAt, "Expected a frozen turn duration for a parked agent").toBeNumber();
			expect(
				agent.conversationMessages.map((message) => message.role),
				"Expected only the child's own conversation, not the inherited base",
			).toEqual(["user", "assistant"]);
			expect(agent.dispatchBaseFingerprint).toBe(
				conversationFingerprint(
					sessionManager.buildSessionContext().messages.slice(0, inherited.length),
				),
			);
			expect(agent.pendingSquashMessage, "Expected the last response to be squashable").toBeDefined();
			expect(agent.pendingSquashMessage?.display).toBe(false);
			expect(agent.pendingSquashMessage?.details.ok).toBe(true);
			expect(agent.pendingSquashMessage?.content).toContain("review the migration");
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});

	test("a child without a dispatch boundary attaches whole: full context, first prompt as task, no fast-forward base", () => {
		const { sessionManager, sessionDirectory } = reopenedChildSession(inherited);
		try {
			const agent = buildAttachedAgent(2, sessionManager, model, "/agent-attach 0199");

			expect(agent.task).toBe("original main prompt");
			expect(agent.conversationMessages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(agent.responseText).toBe("original main answer");
			expect(
				agent.dispatchBaseFingerprint,
				"Expected a base that can never fingerprint-match a live context",
			).toBe(UNKNOWN_DISPATCH_BASE);
		} finally {
			rmSync(sessionDirectory, { recursive: true, force: true });
		}
	});
});

describe("runAttachedTurns — an attached agent parks first, then behaves like any child", () => {
	type FakeSession = NonNullable<RunningAgent["session"]>;

	function fakeSession(prompts: string[]): FakeSession {
		const messages: Array<Record<string, unknown>> = [];
		return {
			isStreaming: false,
			agent: { state: { messages } },
			prompt: (instruction: string) => {
				prompts.push(instruction);
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: `answer to: ${instruction}` }],
					stopReason: "stop",
				});
				return Promise.resolve();
			},
			extensionRunner: { emit: async () => undefined },
		} as unknown as FakeSession;
	}

	function attachedAgent(session: FakeSession): RunningAgent {
		return {
			id: "user-7",
			sessionId: "child-session-1",
			command: "agent",
			inheritedContext: true,
			model: "openai-codex/gpt-5.6-luna",
			modelLabel: "luna",
			task: "review the migration",
			invocation: "/agent-attach child-session-1",
			notifyMainAgent: false,
			dispatchBaseFingerprint: "[]",
			mainContextState: "separate",
			status: "idle",
			startedAt: Date.now(),
			turnStartedAt: Date.now(),
			completedAt: Date.now(),
			activeTools: new Map<string, string>(),
			toolUses: 0,
			turnCount: 0,
			responseText: "migration reviewed",
			conversationMessages: [],
			session,
			finished: Promise.resolve(),
		} satisfies RunningAgent;
	}

	test("retire ends the parked lifecycle without prompting, and unsubscribes", async () => {
		const prompts: string[] = [];
		const session = fakeSession(prompts);
		const agent = attachedAgent(session);
		let unsubscribed = 0;

		const lifecycle = runAttachedTurns(
			{ appendEntry: () => undefined, sendMessage: () => undefined } as never,
			() => false,
			session,
			agent,
			{ update: () => undefined, addCompleted: () => undefined } as never,
			() => {
				unsubscribed += 1;
			},
		);
		await Promise.resolve();
		if (!agent.retire) throw new Error("retire closure was not assigned while parked");
		agent.retire();
		await lifecycle;

		expect(prompts).toEqual([]);
		expect(unsubscribed).toBe(1);
	});

	test("resume prompts the child with the instruction verbatim and posts a TUI-only result card", async () => {
		const prompts: string[] = [];
		const session = fakeSession(prompts);
		const agent = attachedAgent(session);
		const entries: unknown[] = [];

		const lifecycle = runAttachedTurns(
			{
				appendEntry: (_customType: string, data: unknown) => entries.push(data),
				sendMessage: () => undefined,
			} as never,
			() => false,
			session,
			agent,
			{ update: () => undefined, addCompleted: () => undefined } as never,
			() => undefined,
		);
		await Promise.resolve();
		if (!agent.resume) throw new Error("resume closure was not assigned while parked");
		agent.resume("dig deeper into the flaky test");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(prompts, "Expected no dispatch preamble on a reattached agent's turn").toEqual([
			"dig deeper into the flaky test",
		]);
		expect(agent.status).toBe("idle");
		expect(agent.responseText).toBe("answer to: dig deeper into the flaky test");
		expect(entries, "Expected the turn result as a TUI-only card").toHaveLength(1);

		agent.retire?.();
		await lifecycle;
	});

	test("a turn failure settles through the shared error path: error status and an error card", async () => {
		const session = {
			isStreaming: false,
			agent: { state: { messages: [] } },
			prompt: () => Promise.reject(new Error("provider exploded")),
			extensionRunner: { emit: async () => undefined },
		} as unknown as FakeSession;
		const agent = attachedAgent(session);
		const entries: unknown[] = [];
		const completed: AgentResultMessage[] = [];

		const lifecycle = runAttachedTurns(
			{
				appendEntry: (_customType: string, data: unknown) => entries.push(data),
				sendMessage: () => undefined,
			} as never,
			() => false,
			session,
			agent,
			{
				update: () => undefined,
				addCompleted: (_agent: RunningAgent, message: AgentResultMessage) =>
					completed.push(message),
			} as never,
			() => undefined,
		);
		await Promise.resolve();
		agent.resume?.("go");
		await lifecycle;

		expect(agent.status).toBe("posted");
		expect(agent.error).toBe("provider exploded");
		expect(completed).toHaveLength(1);
		expect(completed[0]?.details.ok).toBe(false);
		expect(entries).toHaveLength(1);
	});
});

describe("handleAttachCommand — the /agent-attach command", () => {
	type Notification = { message: string; level: string };

	function withTemporaryAgentDir<T>(run: (cwd: string) => T): T {
		const agentDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-agent-dir-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-user-agents-project-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		try {
			return run(cwd);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDirectory, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}

	function fakeContext(
		cwd: string,
		mainSessionManager: SessionManager,
		options: { confirmAnswers?: boolean[] } = {},
	): {
		ctx: ExtensionCommandContext;
		notifications: Notification[];
		confirmTitles: string[];
		customCalls: unknown[];
	} {
		const notifications: Notification[] = [];
		const confirmTitles: string[] = [];
		const customCalls: unknown[] = [];
		const confirmAnswers = [...(options.confirmAnswers ?? [])];
		const ctx = {
			hasUI: true,
			cwd,
			sessionManager: mainSessionManager,
			isProjectTrusted: () => false,
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
				confirm: async (title: string) => {
					confirmTitles.push(title);
					return confirmAnswers.shift() ?? false;
				},
				onTerminalInput: () => () => undefined,
				getEditorText: () => "",
				setWidget: () => undefined,
				custom: (...call: unknown[]) => {
					customCalls.push(call);
					return Promise.resolve("hide");
				},
			},
		} as unknown as ExtensionCommandContext;
		return { ctx, notifications, confirmTitles, customCalls };
	}

	const fakePi = { appendEntry: () => undefined, sendMessage: () => undefined } as never;
	const noopWidgetDependencies = [() => undefined, () => undefined] as const;

	function persistedChild(cwd: string, parentSession: string | undefined): SessionManager {
		const child = SessionManager.create(cwd, undefined, { parentSession });
		persistMessages(
			child,
			[
				{ role: "user", content: `${DISPATCH_PREAMBLE}review the migration`, timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "migration reviewed" }],
					timestamp: 2,
					stopReason: "stop",
				},
			] as AgentMessage[],
			[],
		);
		return child;
	}

	test("empty or multi-token arguments are a usage error", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const main = SessionManager.create(cwd);
			const runningAgents = new Set<RunningAgent>();
			const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies, noRebase);
			for (const args of ["", "   ", "one two"]) {
				const { ctx, notifications } = fakeContext(cwd, main);
				await handleAttachCommand(fakePi, runningAgents, widget, () => false, () => 1, args, ctx);
				expect(notifications.at(-1)?.message).toBe("Usage: /agent-attach <child-session-id>");
				expect(notifications.at(-1)?.level).toBe("error");
			}
			expect(runningAgents.size).toBe(0);
		});
	});

	test("an id that matches no session errors", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const main = SessionManager.create(cwd);
			persistedChild(cwd, main.getSessionFile());
			const runningAgents = new Set<RunningAgent>();
			const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies, noRebase);
			const { ctx, notifications } = fakeContext(cwd, main);

			await handleAttachCommand(fakePi, runningAgents, widget, () => false, () => 1, "ffff", ctx);

			expect(notifications.at(-1)?.message).toBe('No agent session matches "ffff"');
			expect(runningAgents.size).toBe(0);
		});
	});

	test("a session that is not a child of this session errors", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const main = SessionManager.create(cwd);
			const stranger = persistedChild(cwd, undefined);
			const runningAgents = new Set<RunningAgent>();
			const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies, noRebase);
			const { ctx, notifications } = fakeContext(cwd, main);

			await handleAttachCommand(
				fakePi,
				runningAgents,
				widget,
				() => false,
				() => 1,
				stranger.getSessionId(),
				ctx,
			);

			expect(notifications.at(-1)?.message).toBe(
				`Session ${stranger.getSessionId()} is not a child session of this session`,
			);
			expect(runningAgents.size).toBe(0);
		});
	});

	test("an already-attached session is idempotent: no new agent, just the View agent? confirmation", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const main = SessionManager.create(cwd);
			const attachedAgent = {
				id: "user-1",
				sessionId: "0199aaaa-8b1a-7c3d-9e05-6a2f18d7b4ce",
				command: "agent",
				inheritedContext: true,
				model: "provider/model",
				modelLabel: "model",
				task: "plan the migration",
				invocation: "/agent plan the migration",
				notifyMainAgent: false,
				dispatchBaseFingerprint: "[]",
				mainContextState: "separate",
				status: "idle",
				startedAt: Date.now(),
				turnStartedAt: Date.now(),
				activeTools: new Map<string, string>(),
				toolUses: 0,
				turnCount: 1,
				responseText: "parked",
				conversationMessages: [],
				finished: Promise.resolve(),
			} satisfies RunningAgent;
			const runningAgents = new Set<RunningAgent>([attachedAgent]);
			const widget = new UserAgentWidget(runningAgents, ...noopWidgetDependencies, noRebase);

			const accepted = fakeContext(cwd, main, { confirmAnswers: [true] });
			await handleAttachCommand(
				fakePi,
				runningAgents,
				widget,
				() => false,
				() => 2,
				"0199aaaa",
				accepted.ctx,
			);
			expect(accepted.confirmTitles).toEqual(["Agent already attached"]);
			expect(accepted.customCalls, "Expected yes to open the agent overlay").toHaveLength(1);
			expect(runningAgents.size).toBe(1);
			expect(accepted.notifications).toEqual([]);

			const declined = fakeContext(cwd, main, { confirmAnswers: [false] });
			await handleAttachCommand(
				fakePi,
				runningAgents,
				widget,
				() => false,
				() => 3,
				attachedAgent.sessionId,
				declined.ctx,
			);
			expect(declined.confirmTitles).toEqual(["Agent already attached"]);
			expect(declined.customCalls, "Expected no to leave the overlay closed").toHaveLength(0);
			expect(runningAgents.size).toBe(1);
		});
	});
});
