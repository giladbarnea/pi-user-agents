import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildAttachedAgent,
	handleAttachCommand,
	matchChildSessionFiles,
	readDispatchRecord,
	restoreDispatchOptions,
	runAttachedTurns,
	splitAtDispatchBoundary,
	UNKNOWN_DISPATCH_BASE,
} from "../attach.ts";
import { conversationFingerprint, mainContextFingerprint } from "../rebase.ts";
import { DISPATCH_PREAMBLE, persistMessages } from "../runner.ts";
import type {
	AgentMessage,
	AgentResultMessage,
	DispatchRecordData,
	ExtensionCommandContext,
	Model,
	RebaseDelivery,
	RunningAgent,
} from "../shared.ts";
import { DISPATCH_ENTRY_TYPE } from "../shared.ts";
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

describe("matchChildSessionFiles — session ids on disk matching an id or prefix", () => {
	function sessionDirectoryWith(fileNames: string[]): string {
		const directory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-"));
		for (const name of fileNames) writeFileSync(join(directory, name), "");
		return directory;
	}
	const idA = "0199c4f2-8b1a-7c3d-9e05-6a2f18d7b4ce";
	const idB = "0199d000-1111-7abc-9e05-6a2f18d7b4ce";
	const fileA = `2026-09-01T10-00-00-000Z_${idA}.jsonl`;
	const fileB = `2026-09-01T11-00-00-000Z_${idB}.jsonl`;

	test("matches an exact session id and a prefix, ignoring non-session files", () => {
		const directory = sessionDirectoryWith([fileA, fileB, "notes.txt", "no-underscore.jsonl"]);
		try {
			expect(matchChildSessionFiles(idA, directory)).toEqual([
				{ sessionId: idA, file: join(directory, fileA) },
			]);
			expect(matchChildSessionFiles("0199d", directory)).toEqual([
				{ sessionId: idB, file: join(directory, fileB) },
			]);
			expect(matchChildSessionFiles("0199", directory)).toHaveLength(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("returns nothing for an unmatched query or a missing session directory", () => {
		const directory = sessionDirectoryWith([fileA]);
		try {
			expect(matchChildSessionFiles("ffff", directory)).toEqual([]);
			expect(matchChildSessionFiles(idA, join(directory, "missing"))).toEqual([]);
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

	test("an agent detached before its lifecycle starts settles immediately instead of parking", async () => {
		const prompts: string[] = [];
		const session = fakeSession(prompts);
		const agent = attachedAgent(session);
		agent.aborted = true;

		const lifecycle = runAttachedTurns(
			{ appendEntry: () => undefined, sendMessage: () => undefined } as never,
			() => false,
			session,
			agent,
			{ update: () => undefined, addCompleted: () => undefined } as never,
			() => undefined,
		);
		const outcome = await Promise.race([
			lifecycle.then(() => "settled"),
			new Promise((resolve) => setTimeout(() => resolve("still parked"), 100)),
		]);

		expect(outcome, "Expected the aborted lifecycle to end without waiting for a steer").toBe(
			"settled",
		);
		expect(prompts).toEqual([]);
	});

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

	function persistedChild(
		cwd: string,
		parentSession: string | undefined,
		id?: string,
	): SessionManager {
		const child = SessionManager.create(cwd, undefined, { parentSession, id });
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

	test("a prefix ambiguous across an attached row and a detached file errors instead of answering for the row", async () => {
		await withTemporaryAgentDir(async (cwd) => {
			const main = SessionManager.create(cwd);
			persistedChild(cwd, main.getSessionFile(), "0199cccc-2222-7abc-9e05-6a2f18d7b4ce");
			const attachedAgent = {
				id: "user-1",
				sessionId: "0199bbbb-1111-7abc-9e05-6a2f18d7b4ce",
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
			const { ctx, notifications, confirmTitles } = fakeContext(cwd, main);

			await handleAttachCommand(fakePi, runningAgents, widget, () => false, () => 2, "0199", ctx);

			expect(
				notifications.at(-1)?.message,
				"Expected the prefix to be judged against rows AND files together",
			).toBe('"0199" matches 2 sessions; use more characters');
			expect(confirmTitles).toEqual([]);
			expect(runningAgents.size).toBe(1);
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

describe("attach re-arms the rebase fast-forward — the round-tripped base fingerprints equal to main", () => {
	test("a base with a compaction summary and a custom message survives the child-file round trip", async () => {
		const mainDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-main-"));
		const childDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-child-"));
		try {
			const main = SessionManager.create("/tmp/project", mainDirectory);
			main.appendMessage({ role: "user", content: "first ask", timestamp: 1 } as never);
			const keptEntryId = main.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "early answer" }],
				timestamp: 2,
				stopReason: "stop",
			} as never);
			main.appendCompaction("everything before the kept tail", keptEntryId, 50_000);
			main.appendCustomMessageEntry(
				"another-extension",
				"a status message main acted on",
				true,
				{ key: "value" },
			);
			const mainFingerprint = mainContextFingerprint(main);
			const inherited = structuredClone(main.buildSessionContext().messages);
			expect(
				inherited.map((message) => message.role),
				"Fixture check: the base must exercise the synthetic-rebuild roles",
			).toEqual(["compactionSummary", "assistant", "custom"]);

			// The child writes its entries later than main wrote its own; entry timestamps differ.
			await new Promise((resolve) => setTimeout(resolve, 5));
			const child = SessionManager.create("/tmp/project", childDirectory);
			persistMessages(
				child,
				[
					...inherited,
					{ role: "user", content: `${DISPATCH_PREAMBLE}review the migration`, timestamp: 10 },
					{
						role: "assistant",
						content: [{ type: "text", text: "migration reviewed" }],
						timestamp: 11,
						stopReason: "stop",
					},
				] as AgentMessage[],
				[],
			);
			const reopened = SessionManager.open(child.getSessionFile() as string);
			const model = { provider: "openai-codex", id: "gpt-5.6-luna", name: "luna" } as Model;

			const agent = buildAttachedAgent(1, reopened, model, "/agent-attach x");

			expect(
				agent.dispatchBaseFingerprint,
				"Expected the round-tripped base to fingerprint-equal main's live context, or r stays falsely withheld",
			).toBe(mainFingerprint);
		} finally {
			rmSync(mainDirectory, { recursive: true, force: true });
			rmSync(childDirectory, { recursive: true, force: true });
		}
	});

	test("the fingerprint ignores rebuild bookkeeping but not content", () => {
		const summary = [
			{ role: "branchSummary", summary: "the path we abandoned", fromId: "main-e7", timestamp: 1 },
		] as AgentMessage[];
		const restamped = [
			{ role: "branchSummary", summary: "the path we abandoned", fromId: "child-e2", timestamp: 9 },
		] as AgentMessage[];
		const edited = [
			{ role: "branchSummary", summary: "a different summary", fromId: "main-e7", timestamp: 1 },
		] as AgentMessage[];

		expect(conversationFingerprint(restamped)).toBe(conversationFingerprint(summary));
		expect(conversationFingerprint(edited)).not.toBe(conversationFingerprint(summary));
	});
});

describe("dispatch record — the dispatch-time facts attach cannot read from messages alone", () => {
	test("round-trips through the child session file", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-record-"));
		try {
			const child = SessionManager.create("/tmp/project", directory);
			const record: DispatchRecordData = {
				forwardedArgs: ["--tools", "read,grep", "--no-extensions"],
				task: "audit the migration",
				isolate: false,
			};
			child.appendCustomEntry(DISPATCH_ENTRY_TYPE, record);
			persistMessages(
				child,
				[
					{ role: "user", content: `${DISPATCH_PREAMBLE}audit the migration`, timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "audited" }],
						timestamp: 2,
						stopReason: "stop",
					},
				] as AgentMessage[],
				[],
			);
			const reopened = SessionManager.open(child.getSessionFile() as string);

			expect(readDispatchRecord(reopened)).toEqual(record);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("is absent on a child dispatched before the record existed", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-record-"));
		try {
			const child = SessionManager.create("/tmp/project", directory);
			persistMessages(
				child,
				[
					{
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						timestamp: 1,
						stopReason: "stop",
					},
				] as AgentMessage[],
				[],
			);
			const reopened = SessionManager.open(child.getSessionFile() as string);

			expect(readDispatchRecord(reopened)).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("restoreDispatchOptions re-applies tool and resource restrictions; no record restores nothing", () => {
		const restored = restoreDispatchOptions(
			{
				forwardedArgs: [
					"--tools",
					"read,grep",
					"--no-extensions",
					"--system-prompt",
					"be terse",
				],
				task: "audit the migration",
				isolate: false,
			},
			"/tmp/project",
		);

		expect(restored).toEqual({
			resourceLoaderOptions: { noExtensions: true, systemPrompt: "be terse" },
			tools: ["read", "grep"],
		});
		expect(restoreDispatchOptions(undefined, "/tmp/project")).toEqual({});
	});

	test("buildAttachedAgent trusts the record over boundary sniffing for the task and context flag", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-user-agents-attach-record-"));
		try {
			const child = SessionManager.create("/tmp/project", directory);
			// No preamble anywhere: without the record, the task would fall back to the first prompt.
			persistMessages(
				child,
				[
					{ role: "user", content: "raw first prompt", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "answered" }],
						timestamp: 2,
						stopReason: "stop",
					},
				] as AgentMessage[],
				[],
			);
			const reopened = SessionManager.open(child.getSessionFile() as string);
			const model = { provider: "openai-codex", id: "gpt-5.6-luna", name: "luna" } as Model;

			const agent = buildAttachedAgent(3, reopened, model, "/agent-attach x", {
				forwardedArgs: [],
				task: "the stored task",
				isolate: true,
			});

			expect(agent.task).toBe("the stored task");
			expect(agent.inheritedContext).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
