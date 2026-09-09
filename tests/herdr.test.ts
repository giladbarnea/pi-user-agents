import { describe, expect, test } from "bun:test";
import { herdrAgentName, insideHerdr, openPiInHerdrPane } from "../herdr.ts";
import { fakeHerdr, insideFakeHerdrPane } from "./herdr-fake.ts";

describe("herdrAgentName", () => {
	test("is unique per child and valid for herdr: 'agent-' plus the session id's millisecond prefix", () => {
		expect(herdrAgentName("0199c4f2-8b1a-7c3d-9e05-6a2f18d7b4ce")).toBe("agent-0199c4f2-8b1a");
		expect(herdrAgentName("0199c4f2-8b1a-7c3d-9e05-6a2f18d7b4ce")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
		expect(
			herdrAgentName("0199c4f2-8b1a-7c3d-9e05-6a2f18d7b4ce"),
			"Expected two children a minute apart to get different names",
		).not.toBe(herdrAgentName("0199c4f2-9c2b-7c3d-9e05-6a2f18d7b4ce"));
	});
});

describe("insideHerdr", () => {
	test("is true only under a herdr-managed pane's environment", async () => {
		const outside = { ...process.env };
		delete process.env.HERDR_ENV;
		expect(insideHerdr()).toBe(false);
		process.env.HERDR_ENV = outside.HERDR_ENV ?? "";
		if (outside.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
		await insideFakeHerdrPane("w1:p1", async () => expect(insideHerdr()).toBe(true));
	});
});

describe("openPiInHerdrPane", () => {
	test("splits a wide caller pane to the right, unfocused, in the given cwd, then starts pi there with the args", async () => {
		const fake = fakeHerdr({ layout: { paneId: "w1:p1", width: 120, height: 40 }, paneId: "w1:p2" });
		try {
			const paneId = await insideFakeHerdrPane("w1:p1", () =>
				openPiInHerdrPane("/repo", "agent-x", ["--session", "/s.jsonl", "say hi there"]),
			);

			expect(paneId).toBe("w1:p2");
			expect(fake.calls).toEqual([
				["pane", "layout", "--current"],
				["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--no-focus"],
				["agent", "start", "agent-x", "--kind", "pi", "--pane", "w1:p2", "--", "--session", "/s.jsonl", "say hi there"],
			]);
		} finally {
			fake.restore();
		}
	});

	test("splits a tall or narrow caller pane down", async () => {
		const fake = fakeHerdr({ layout: { paneId: "w1:p1", width: 60, height: 40 }, paneId: "w1:p2" });
		try {
			await insideFakeHerdrPane("w1:p1", () => openPiInHerdrPane("/repo", "agent-x", []));
			expect(fake.calls[1]).toContain("down");
		} finally {
			fake.restore();
		}
	});

	test("splits right when the caller pane is not in the layout (a moved pane keeps its launch-time id)", async () => {
		const fake = fakeHerdr({ layout: { paneId: "w9:p9", width: 60, height: 40 }, paneId: "w1:p2" });
		try {
			await insideFakeHerdrPane("w1:p1", () => openPiInHerdrPane("/repo", "agent-x", []));
			expect(fake.calls[1]).toContain("right");
		} finally {
			fake.restore();
		}
	});

	test("rejects with herdr's own message from its JSON error, or with the raw text otherwise", async () => {
		const json = fakeHerdr({
			layout: { paneId: "w1:p1", width: 120, height: 40 },
			paneId: "w1:p2",
			startStderr: '{"error":{"code":"agent_name_taken","message":"agent name agent-x is already used"},"id":"cli:agent:start"}',
		});
		try {
			await expect(
				insideFakeHerdrPane("w1:p1", () => openPiInHerdrPane("/repo", "agent-x", [])),
			).rejects.toThrow("agent name agent-x is already used");
		} finally {
			json.restore();
		}
		const text = fakeHerdr({
			layout: { paneId: "w1:p1", width: 120, height: 40 },
			paneId: "w1:p2",
			startStderr: "--current requires HERDR_PANE_ID\n",
		});
		try {
			await expect(
				insideFakeHerdrPane("w1:p1", () => openPiInHerdrPane("/repo", "agent-x", [])),
			).rejects.toThrow("--current requires HERDR_PANE_ID");
		} finally {
			text.restore();
		}
	});
});
