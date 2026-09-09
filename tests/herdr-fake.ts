import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";

export type FakeHerdrOptions = {
	/** The calling pane as `pane layout` reports it. */
	layout: { paneId: string; width: number; height: number };
	/** The pane id `pane split` returns. */
	paneId: string;
	/** Fail `agent start` with this stderr text (herdr's JSON error or plain text). */
	startStderr?: string;
};

/** Stand in for the herdr CLI at the process boundary; records every argv it receives. */
export function fakeHerdr(options: FakeHerdrOptions): { calls: string[][]; restore(): void } {
	const calls: string[][] = [];
	const respond = (args: string[]): { stdout: string; stderr: string; failed: boolean } => {
		const command = `${args[0]} ${args[1]}`;
		if (command === "pane layout")
			return {
				stdout: JSON.stringify({
					result: {
						layout: {
							panes: [
								{
									pane_id: options.layout.paneId,
									rect: { width: options.layout.width, height: options.layout.height },
								},
							],
						},
					},
				}),
				stderr: "",
				failed: false,
			};
		if (command === "pane split")
			return {
				stdout: JSON.stringify({ result: { pane: { pane_id: options.paneId } } }),
				stderr: "",
				failed: false,
			};
		if (command === "agent start")
			return options.startStderr === undefined
				? { stdout: JSON.stringify({ result: { type: "agent_started" } }), stderr: "", failed: false }
				: { stdout: "", stderr: options.startStderr, failed: true };
		throw new Error(`fakeHerdr: unexpected command ${command}`);
	};
	const spy = spyOn(childProcess, "execFile").mockImplementation(((
		file: string,
		args: string[],
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		if (file !== "herdr") throw new Error(`fakeHerdr: unexpected executable ${file}`);
		calls.push(args);
		const { stdout, stderr, failed } = respond(args);
		callback(failed ? Object.assign(new Error("Command failed: herdr"), { code: 1 }) : null, stdout, stderr);
		return {} as childProcess.ChildProcess;
	}) as typeof childProcess.execFile);
	return { calls, restore: () => spy.mockRestore() };
}

/** Run with HERDR_ENV and HERDR_PANE_ID set as a herdr-managed pane would have them. */
export async function insideFakeHerdrPane<T>(paneId: string, run: () => Promise<T>): Promise<T> {
	const previous = { env: process.env.HERDR_ENV, pane: process.env.HERDR_PANE_ID };
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = paneId;
	try {
		return await run();
	} finally {
		if (previous.env === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previous.env;
		if (previous.pane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previous.pane;
	}
}
