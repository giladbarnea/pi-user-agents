import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run with a throwaway Pi agent directory and project cwd, so session files never touch the real ones. */
export async function withTemporaryAgentDir<T>(run: (cwd: string) => Promise<T>): Promise<T> {
	const agentDirectory = mkdtempSync(join(tmpdir(), "pi-user-agents-agent-dir-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-user-agents-project-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	try {
		return await run(cwd);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDirectory, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}
