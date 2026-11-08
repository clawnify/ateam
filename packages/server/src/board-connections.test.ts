import { afterEach, expect, test } from "bun:test";
import { BoardConnections, boardToolsSentence } from "./board-connections";

const GRACE = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const live = () => true;

let open: BoardConnections[] = [];
afterEach(() => {
	for (const b of open) b.stop();
	open = [];
});

function make() {
	const changes: string[] = [];
	const b = new BoardConnections({ onChange: (id) => changes.push(id), graceMs: GRACE });
	open.push(b);
	return { b, changes };
}

test("an agent that connects is never flagged", async () => {
	const { b, changes } = make();
	b.launched("t1", "task1", "claude");
	b.seen("t1");
	b.up("t1");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toBeNull();
	expect(changes).toEqual([]);
});

test("an agent that is up and never connects is flagged once the grace ends", async () => {
	const { b, changes } = make();
	b.launched("t1", "task1", "codex");
	b.up("t1");
	b.up("t1"); // a second event does not restart the clock
	expect(b.missingIn("task1", live)).toBeNull();
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toEqual({ agentId: "codex", byHand: false });
	expect(changes).toEqual(["task1"]);
});

test("an agent that never shows up is not judged (held at a trust prompt)", async () => {
	const { b } = make();
	b.launched("t1", "task1", "claude");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toBeNull();
});

test("a late connection clears the flag and says so", async () => {
	const { b, changes } = make();
	b.launched("t1", "task1", "opencode");
	b.up("t1");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).not.toBeNull();
	b.seen("t1");
	expect(b.missingIn("task1", live)).toBeNull();
	expect(changes).toEqual(["task1", "task1"]);
});

test("an agent re-run by hand after Ateam's quit is judged as started by hand", async () => {
	const { b } = make();
	b.launched("t1", "task1", "claude");
	b.seen("t1");
	b.up("t1");
	b.quit("t1", "task1", "claude");
	// The shell's own life is not an agent: nothing until a hook fires.
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toBeNull();
	b.up("t1");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toEqual({ agentId: "claude", byHand: true });
});

test("starting the agent again from Ateam takes a started-by-hand note down", async () => {
	const { b } = make();
	b.launched("t1", "task1", "claude");
	b.seen("t1");
	b.up("t1");
	b.quit("t1", "task1", "claude");
	b.up("t1");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toEqual({ agentId: "claude", byHand: true });
	// The note's advice, followed: a fresh launch in a new pane of the same task.
	b.launched("t2", "task1", "claude");
	b.seen("t2");
	expect(b.missingIn("task1", live)).toBeNull();
	// The hand-started agent, if still in use, is judged again when it speaks.
	b.up("t1");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toEqual({ agentId: "claude", byHand: true });
});

test("a listener still polling after its agent quit is not an agent started by hand", async () => {
	const { b } = make();
	b.launched("t1", "task1", "claude");
	b.seen("t1");
	b.up("t1");
	b.quit("t1", "task1", "claude");
	b.up("t1", false);
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toBeNull();
});

test("a listener poll is a sign of life for an agent Ateam launched (OpenCode)", async () => {
	const { b } = make();
	b.launched("t1", "task1", "opencode");
	b.up("t1", false);
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toEqual({ agentId: "opencode", byHand: false });
});

test("quitting clears a flag; a request from the quit agent's pane changes nothing", async () => {
	const { b, changes } = make();
	b.launched("t1", "task1", "codex");
	b.up("t1");
	await sleep(GRACE * 2);
	b.quit("t1", "task1", "codex");
	expect(b.missingIn("task1", live)).toBeNull();
	b.seen("t1");
	expect(changes).toEqual(["task1", "task1"]);
});

test("an agent from before an engine restart is never judged until it quits", async () => {
	const { b } = make();
	b.up("old");
	await sleep(GRACE * 2);
	expect(b.missingIn("task9", live)).toBeNull();
	b.quit("old", "task9", "claude");
	b.up("old");
	await sleep(GRACE * 2);
	expect(b.missingIn("task9", live)).toEqual({ agentId: "claude", byHand: true });
});

test("a relaunch into the same pane starts over, and a gone pane is forgotten", async () => {
	const { b } = make();
	b.launched("t1", "task1", "claude");
	b.up("t1");
	b.launched("t1", "task1", "claude");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toBeNull();
	b.up("t1");
	b.gone("t1");
	await sleep(GRACE * 2);
	expect(b.missingIn("task1", live)).toBeNull();
});

test("the sentence names the likely cause per agent", () => {
	expect(boardToolsSentence({ agentId: "claude", byHand: false }, "Claude Code")).toContain(
		"allowedMcpServers",
	);
	expect(boardToolsSentence({ agentId: "codex", byHand: false }, "Codex")).toContain(
		"An older Codex",
	);
	expect(boardToolsSentence({ agentId: "claude", byHand: true }, "Claude Code")).toContain(
		"started by hand",
	);
});
