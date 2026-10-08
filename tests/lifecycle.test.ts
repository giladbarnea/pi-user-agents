import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { reportAgentFailure, runChildTurns, subscribeToChildSession } from "../runner.ts";
import type { AgentResultMessage, ExtensionAPI, RunningAgent, UIContext } from "../shared.ts";
import { UserAgentWidget } from "../widget.ts";

async function createHarness(
	extension: ExtensionFactory = () => undefined,
	responseError: (requestNumber: number) => string | undefined = () => undefined,
) {
	const directory = mkdtempSync(join(tmpdir(), "pi-user-agents-lifecycle-"));
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false, maxRetries: 1, baseDelayMs: 1 },
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: join(directory, "models-cache.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("lifecycle-test", {
		api: "openai-completions",
		apiKey: "test-only",
		baseUrl: "http://unused.invalid",
		models: [{
			id: "test",
			name: "test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1000,
		}],
	});
	const model = modelRuntime.getModel("lifecycle-test", "test");
	if (!model) throw new Error("Test provider did not register its model");
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [extension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader,
		settingsManager,
		modelRuntime,
		model,
		sessionManager: SessionManager.inMemory(directory),
		noTools: "all",
	});
	let responseCount = 0;
	session.agent.streamFunction = () => {
		responseCount += 1;
		const errorMessage = responseError(responseCount);
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: `Answer ${responseCount}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: errorMessage ? "error" : "stop",
			errorMessage,
			timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		stream.push(errorMessage
			? { type: "error", reason: "error", error: message }
			: { type: "done", reason: "stop", message });
		return stream;
	};
	await session.bindExtensions({ mode: "print" });
	const agent: RunningAgent = {
		id: "test-agent", sessionId: session.sessionId, command: "agent",
		inheritedContext: false, model: "lifecycle-test/test", modelLabel: "test",
		task: "do the task", invocation: "/agent -s do the task", notifyMainAgent: true,
		dispatchBaseFingerprint: "[]", mainContextState: "will-squash", status: "running",
		startedAt: Date.now(), turnStartedAt: Date.now(), activeTools: new Map(),
		toolUses: 0, turnCount: 0, responseText: "", conversationMessages: [],
		session, finished: Promise.resolve(),
	};
	const deliveries: AgentResultMessage[] = [];
	const settlements: boolean[] = [];
	const idle = Promise.withResolvers<void>();
	const widget = {
		update: () => { if (agent.status === "idle") idle.resolve(); },
		addCompleted: () => undefined,
	} as unknown as UserAgentWidget;
	const pi = { sendMessage: (message: AgentResultMessage) => deliveries.push(message) } as unknown as ExtensionAPI;
	const unsubscribe = subscribeToChildSession(session, agent, widget);
	session.subscribe((event) => {
		if (event.type === "agent_settled") settlements.push(event.aborted);
	});
	return {
		agent, deliveries, settlements, session,
		start() {
			agent.finished = runChildTurns(pi, () => false, agent.task, session, agent, widget)
				.catch((error: unknown) => reportAgentFailure(pi, () => false, agent, widget, error));
			return Promise.race([agent.finished, idle.promise]);
		},
		async dispose() {
			agent.retire?.();
			await agent.finished;
			unsubscribe();
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

test("an abort after a successful response stays separate and the retained child can resume", async () => {
	let firstRun = true;
	const harness = await createHarness((pi) => {
		pi.on("agent_before_settle", (_event, ctx) => {
			if (!firstRun) return;
			firstRun = false;
			ctx.abort();
		});
	});
	try {
		await harness.start();
		expect(harness.settlements, "The real session must report cancellation after a successful response").toEqual([true]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(harness.deliveries, "A cancelled run must not auto-squash its successful-looking response").toEqual([]);
		expect(harness.agent.status).toBe("idle");
		expect(harness.agent.mainContextState).toBe("separate");
		expect(harness.agent.responseText).toBe("Run cancelled.\n\nAnswer 1");
		expect(harness.agent.resume).toBeFunction();
		harness.agent.resume!("finish the task");
		await harness.agent.finished;
		expect(harness.settlements).toEqual([true, false]);
		expect(harness.deliveries).toHaveLength(1);
		expect(harness.deliveries[0]?.details).toMatchObject({ ok: true, responseText: "Answer 2" });
	} finally {
		await harness.dispose();
	}
});

test.each([false, true])("detaching during post-response work ends the child without delivery or parking (squash=%s)", async (squash) => {
	let input: (data: string) => unknown;
	const harness = await createHarness((pi) => {
		pi.on("agent_before_settle", () => {
			input("\x1b[B");
			input("d");
			input("d");
		});
	});
	harness.agent.notifyMainAgent = squash;
	const detached: string[] = [];
	const widget = new UserAgentWidget(
		new Set([harness.agent]),
		(message) => harness.deliveries.push(message),
		(sessionId) => detached.push(sessionId),
		{ canDeliver: () => false, deliver: () => undefined },
		{ available: () => false, split: async () => { throw new Error("No pane in this test"); } },
	);
	widget.setUI({
		onTerminalInput: (handler: (data: string) => unknown) => { input = handler; return () => undefined; },
		getEditorText: () => "",
		setWidget: () => undefined,
	} as unknown as UIContext);
	try {
		await harness.start();
		expect(detached).toEqual([harness.session.sessionId]);
		expect(harness.settlements).toEqual([true]);
		expect(harness.deliveries).toEqual([]);
		expect(harness.agent.status, "A detached child must retire instead of parking for another instruction").not.toBe("idle");
		await harness.agent.finished;
		expect(harness.agent.resume).toBeUndefined();
	} finally {
		widget.dispose();
		await harness.dispose();
	}
});

test.each([false, true])("a successful run squashes once after all retries settle (retry=%s)", async (retry) => {
	const harness = await createHarness(undefined, (requestNumber) =>
		retry && requestNumber === 1 ? "429 rate limit exceeded" : undefined,
	);
	harness.session.setAutoRetryEnabled(retry);
	const deliveriesAtAgentEnd: number[] = [];
	harness.session.subscribe((event) => {
		if (event.type === "agent_end") deliveriesAtAgentEnd.push(harness.deliveries.length);
	});
	try {
		await harness.start();
		expect(deliveriesAtAgentEnd, "Low-level run endings must never deliver before settlement").toEqual(retry ? [0, 0] : [0]);
		expect(harness.settlements).toEqual([false]);
		expect(harness.deliveries).toHaveLength(1);
		expect(harness.deliveries[0]?.details).toMatchObject({ ok: true, responseText: retry ? "Answer 2" : "Answer 1" });
	} finally {
		await harness.dispose();
	}
});

test("queued follow-up work completes before one final delivery", async () => {
	let queued = false;
	const harness = await createHarness((pi) => {
		pi.on("agent_end", () => {
			if (queued) return;
			queued = true;
			pi.sendUserMessage("also check the follow-up", { deliverAs: "followUp" });
		});
	});
	try {
		await harness.start();
		expect(harness.settlements).toEqual([false]);
		expect(harness.agent.turnCount).toBe(2);
		expect(harness.deliveries).toHaveLength(1);
		expect(harness.deliveries[0]?.details).toMatchObject({ ok: true, responseText: "Answer 2" });
		expect(harness.deliveries[0]?.content).toContain("also check the follow-up");
	} finally {
		await harness.dispose();
	}
});

test("a non-cancelled error is not mistaken for successful settlement", async () => {
	const harness = await createHarness(undefined, () => "Invalid request");
	try {
		await harness.start();
		expect(harness.settlements).toEqual([false]);
		expect(harness.deliveries).toHaveLength(1);
		expect(harness.deliveries[0]?.details).toMatchObject({ ok: false, error: "Invalid request" });
	} finally {
		await harness.dispose();
	}
});

test("a pre-start interruption prevents the prompt and leaves the child available", async () => {
	const harness = await createHarness();
	harness.agent.interruptRequested = true;
	try {
		await harness.start();
		expect(harness.settlements).toEqual([]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.deliveries).toEqual([]);
		expect(harness.agent.status).toBe("idle");
		expect(harness.agent.responseText).toBe("Interrupted by user.");
		harness.agent.resume!("start now");
		await harness.agent.finished;
		expect(harness.settlements).toEqual([false]);
		expect(harness.deliveries).toHaveLength(1);
	} finally {
		await harness.dispose();
	}
});

test("a pre-start detach ends without starting a prompt or parking", async () => {
	const harness = await createHarness();
	harness.agent.aborted = true;
	try {
		await harness.start();
		await harness.agent.finished;
		expect(harness.settlements).toEqual([]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.deliveries).toEqual([]);
		expect(harness.agent.resume).toBeUndefined();
	} finally {
		await harness.dispose();
	}
});
