import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand, getAgent, skipsAskingByDefault } from "../src/registry";

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

	it("keeps the id alongside Auto mode and the prompt", () => {
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

	// Every registered agent must actually have an Auto flag: the Auto toggle
	// renders for all of them, and an omission here turns it into a silent
	// no-op — the launch is safe, the toggle was a lie.
	it("makes Auto mode real for every agent, opencode included", () => {
		expect(agentCommand(opencode, { yolo: true, prompt: "go" })).toBe(
			"opencode --auto --prompt 'go'",
		);
	});

	it("uses Codex automatic approval review for a fresh Auto launch", () => {
		expect(agentCommand(codex, { yolo: true, prompt: "go" })).toBe("codex --approve-for-me 'go'");
		expect(agentCommand(codex, { yolo: false, prompt: "go" })).toBe("codex 'go'");
	});

	it("keeps Codex automatic approval review when resuming", () => {
		expect(agentCommand(codex, { yolo: true, resume: true })).toBe(
			"codex resume --last --approve-for-me",
		);
		expect(agentCommand(codex, { yolo: true, resume: true, resumeSessionId: "old-1" })).toBe(
			"codex resume 'old-1' --approve-for-me",
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

// A box whose Claude settings default to bypassPermissions (one of our Sprites)
// would make Auto off the loosest launch there is. Pinning the asking mode keeps
// Auto off asking and Auto on in auto mode, on every way a pane starts.
describe("agentCommand with Auto off on a machine that would skip every check", () => {
	it("pins the asking mode on a fresh launch", () => {
		expect(agentCommand(claude, { pinAsk: true, sessionId: "abc-123", prompt: "go" })).toBe(
			"claude --permission-mode default --session-id 'abc-123' 'go'",
		);
	});

	it("lets Auto win: Auto on is auto mode, never the asking mode", () => {
		expect(agentCommand(claude, { pinAsk: true, yolo: true, prompt: "go" })).toBe(
			"claude --permission-mode auto 'go'",
		);
	});

	it("pins it on a resume and in agent mode too", () => {
		expect(agentCommand(claude, { pinAsk: true, resume: true })).toBe(
			"claude --continue --permission-mode default",
		);
		expect(agentCommand(claude, { pinAsk: true, resumeSessionId: "old-1" })).toBe(
			"claude --resume 'old-1' --permission-mode default",
		);
		expect(agentCommand(claude, { pinAsk: true, agentMode: true, cwd: "/w" })).toBe(
			"claude agents --cwd '/w' --permission-mode default",
		);
	});

	it("leaves an agent with no asking flag as it was", () => {
		expect(agentCommand(codex, { pinAsk: true, prompt: "go" })).toBe("codex 'go'");
		expect(agentCommand(opencode, { pinAsk: true, prompt: "go" })).toBe("opencode --prompt 'go'");
	});
});

describe("skipsAskingByDefault", () => {
	const configWith = (settings: string) => {
		const dir = mkdtempSync(join(tmpdir(), "ateam-claude-config-"));
		writeFileSync(join(dir, "settings.json"), settings);
		return dir;
	};

	it("is true when Claude's user settings default to bypassPermissions", async () => {
		const dir = configWith('{"permissions":{"defaultMode":"bypassPermissions"}}');
		expect(await skipsAskingByDefault(claude, dir)).toBe(true);
	});

	it("is false for a default the user chose that still checks", async () => {
		for (const mode of ["auto", "acceptEdits", "plan", "default"]) {
			const dir = configWith(`{"permissions":{"defaultMode":"${mode}"}}`);
			expect(await skipsAskingByDefault(claude, dir)).toBe(false);
		}
	});

	it("is false when the settings are missing or unreadable", async () => {
		expect(await skipsAskingByDefault(claude, mkdtempSync(join(tmpdir(), "ateam-none-")))).toBe(
			false,
		);
		expect(await skipsAskingByDefault(claude, configWith("{not json"))).toBe(false);
		expect(await skipsAskingByDefault(claude, configWith("null"))).toBe(false);
	});

	it("only reads Claude's settings", async () => {
		const dir = configWith('{"permissions":{"defaultMode":"bypassPermissions"}}');
		expect(await skipsAskingByDefault(codex, dir)).toBe(false);
	});
});
