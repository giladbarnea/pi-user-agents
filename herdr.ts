import * as childProcess from "node:child_process";

/** Whether this Pi runs inside a herdr pane, so new panes can be split from it. */
export function insideHerdr(): boolean {
	return process.env.HERDR_ENV === "1";
}

/**
 * The herdr agent name for a child session. Herdr names must be unique among live agents and
 * match [a-z][a-z0-9_-]{0,31}; the first 13 characters of a v7 session id hold its complete
 * millisecond timestamp, so two children never share one.
 *
 * @example herdrAgentName("0199c4f2-8b1a-7c3d-9e05-6a2f18d7b4ce") // "agent-0199c4f2-8b1a"
 */
export function herdrAgentName(sessionId: string): string {
	return `agent-${sessionId.slice(0, 13)}`;
}

/** Split the calling pane and start `pi <piArgs>` in the new pane; resolves with the pane id once pi is ready. */
export async function openPiInHerdrPane(
	cwd: string,
	agentName: string,
	piArgs: readonly string[],
): Promise<string> {
	const paneId = await splitPane(cwd);
	await startPi(paneId, agentName, piArgs);
	return paneId;
}

/** Split the calling pane without taking the user's focus; resolves with the new pane's id. */
export async function splitPane(cwd: string): Promise<string> {
	const direction = await splitDirection();
	const split = (await herdr([
		"pane",
		"split",
		"--current",
		"--direction",
		direction,
		"--cwd",
		cwd,
		"--no-focus",
	])) as { pane: { pane_id: string } };
	return split.pane.pane_id;
}

/** Start `pi <piArgs>` in a shell pane as a named herdr agent; resolves once pi is ready for input. */
export async function startPi(
	paneId: string,
	agentName: string,
	piArgs: readonly string[],
): Promise<void> {
	await herdr(["agent", "start", agentName, "--kind", "pi", "--pane", paneId, "--", ...piArgs]);
}

type PaneLayout = {
	panes: Array<{ pane_id: string; rect: { width: number; height: number } }>;
};

/** A wide pane splits to the right and a narrow or tall one down, so neither half turns unusable. */
async function splitDirection(): Promise<"right" | "down"> {
	const { layout } = (await herdr(["pane", "layout", "--current"])) as { layout: PaneLayout };
	const callerRect = layout.panes.find((pane) => pane.pane_id === process.env.HERDR_PANE_ID)?.rect;
	if (!callerRect) return "right";
	return callerRect.width >= callerRect.height * 2 ? "right" : "down";
}

/** Run one herdr CLI command and return its JSON `result`. Rejects with herdr's own message. */
function herdr(args: readonly string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		childProcess.execFile("herdr", [...args], (error, stdout, stderr) => {
			if (error) {
				reject(new Error(herdrFailureMessage(error, stdout, stderr)));
				return;
			}
			try {
				resolve((JSON.parse(stdout) as { result: unknown }).result);
			} catch (parseError) {
				reject(parseError);
			}
		});
	});
}

/** Herdr reports server errors as JSON on stderr and usage errors as plain text. */
function herdrFailureMessage(error: Error, stdout: string, stderr: string): string {
	const text = (stderr || stdout || error.message).trim();
	try {
		return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
	} catch {
		return text;
	}
}
