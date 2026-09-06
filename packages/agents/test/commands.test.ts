import { describe, expect, it } from "bun:test";
import { agentCommand, getAgent } from "../src/registry";

const claude = getAgent("claude");
const codex = getAgent("codex");
const opencode = getAgent("opencode");
if (!claude || !codex || !opencode) throw new Error("registry lost an agent");

describe("agentCommand", () => {
	// The whole point of minting the id: every tab in a task shares one worktree,
	// so without it `--continue` is the only way back and it can only ever reach
	// whichever conversation was newest.
	it("pins a fresh Claude launch to the id we minted", () => {
		expect(agentCommand(claude, { sessionId: "abc-123" })).toBe("claude --session-id 'abc-123'");
	});

	it("keeps the id alongside YOLO and the prompt", () => {
		expect(agentCommand(claude, { sessionId: "abc-123", yolo: true, prompt: "go" })).toBe(
			"claude --permission-mode auto --session-id 'abc-123' 'go'",
		);
	});

	// A resumed conversation already has an id; handing it a second one would
	// either be refused or fork the conversation in two.
	it("never pins an id onto a resume", () => {
		expect(agentCommand(claude, { sessionId: "abc-123", resume: true })).toBe("claude --continue");
		expect(agentCommand(claude, { sessionId: "abc-123", resumeSessionId: "old-1" })).toBe(
			"claude --resume 'old-1'",
		);
	});

	it("resumes one named conversation ahead of the cwd's newest", () => {
		expect(agentCommand(claude, { resume: true, resumeSessionId: "old-1" })).toBe(
			"claude --resume 'old-1'",
		);
		expect(agentCommand(codex, { resumeSessionId: "old-1" })).toBe("codex resume 'old-1'");
		expect(agentCommand(opencode, { resumeSessionId: "old-1" })).toBe("opencode --session 'old-1'");
	});

	// Neither CLI has a flag to hand it an id for a NEW conversation, so a tab of
	// theirs stays unrestorable rather than recording an id that is a guess.
	it("ignores a minted id for a harness that mints its own", () => {
		expect(agentCommand(codex, { sessionId: "abc-123" })).toBe("codex");
		expect(agentCommand(opencode, { sessionId: "abc-123" })).toBe("opencode");
	});

	// Every registered agent must actually have a bypass flag: the Auto toggle
	// renders for all of them, and an omission here turns it into a silent
	// no-op — the launch is safe, the toggle was a lie.
	it("makes Auto mode real for every agent, opencode included", () => {
		expect(agentCommand(opencode, { yolo: true, prompt: "go" })).toBe(
			"opencode --auto --prompt 'go'",
		);
	});

	it("leaves agent mode alone — a board is not a conversation", () => {
		expect(agentCommand(claude, { sessionId: "abc-123", agentMode: true, cwd: "/w" })).toBe(
			"claude agents --cwd '/w'",
		);
	});

	it("quotes an id the way it quotes a prompt", () => {
		expect(agentCommand(claude, { resumeSessionId: "it's" })).toBe(`claude --resume 'it'\\''s'`);
	});
});
