import { describe, expect, it } from "bun:test";
import { agentCommand, getAgent } from "../src/registry";

const claude = getAgent("claude");
const codex = getAgent("codex");
const opencode = getAgent("opencode");
if (!claude || !codex || !opencode) throw new Error("registry lost an agent");

// Spelled out rather than read from the registry, so a typo there fails here.
const G = `--settings '{"permissions":{"disableBypassPermissionsMode":"disable"}}'`;

describe("agentCommand", () => {
	// The whole point of minting the id: every tab in a task shares one worktree,
	// so without it `--continue` is the only way back and it can only ever reach
	// whichever conversation was newest.
	it("pins a fresh Claude launch to the id we minted", () => {
		expect(agentCommand(claude, { sessionId: "abc-123" })).toBe(
			`claude ${G} --session-id 'abc-123'`,
		);
	});

	it("keeps the id alongside Auto mode and the prompt", () => {
		expect(agentCommand(claude, { sessionId: "abc-123", yolo: true, prompt: "go" })).toBe(
			`claude --permission-mode auto ${G} --session-id 'abc-123' 'go'`,
		);
	});

	// A resumed conversation already has an id; handing it a second one would
	// either be refused or fork the conversation in two.
	it("never pins an id onto a resume", () => {
		expect(agentCommand(claude, { sessionId: "abc-123", resume: true })).toBe(
			`claude --continue ${G}`,
		);
		expect(agentCommand(claude, { sessionId: "abc-123", resumeSessionId: "old-1" })).toBe(
			`claude --resume 'old-1' ${G}`,
		);
	});

	it("resumes one named conversation ahead of the cwd's newest", () => {
		expect(agentCommand(claude, { resume: true, resumeSessionId: "old-1" })).toBe(
			`claude --resume 'old-1' ${G}`,
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
			`claude agents --cwd '/w' ${G}`,
		);
	});

	it("quotes an id the way it quotes a prompt", () => {
		expect(agentCommand(claude, { resumeSessionId: "it's" })).toBe(
			`claude --resume 'it'\\''s' ${G}`,
		);
	});
});

// Fly's Sprite image defaults Claude to bypassPermissions, which made a task with
// Auto off skip every check. The guard turns bypass off on every launch; Claude
// then starts in whatever else the user's settings ask for.
describe("the no-bypass guard on Claude launches", () => {
	it("rides on Auto off and Auto on alike", () => {
		expect(agentCommand(claude, { prompt: "go" })).toBe(`claude ${G} 'go'`);
		expect(agentCommand(claude, { yolo: true, prompt: "go" })).toBe(
			`claude --permission-mode auto ${G} 'go'`,
		);
	});

	// A misspelled key or broken JSON would not turn bypass off, so pin the
	// exact settings the shell hands Claude.
	it("hands Claude valid settings JSON", () => {
		const json = /--settings '([^']+)'/.exec(claude.guardFlag ?? "")?.[1] ?? "";
		expect(JSON.parse(json)).toEqual({ permissions: { disableBypassPermissionsMode: "disable" } });
	});

	it("leaves the other agents' command lines alone", () => {
		expect(agentCommand(codex, { prompt: "go" })).toBe("codex 'go'");
		expect(agentCommand(opencode, { prompt: "go" })).toBe("opencode --prompt 'go'");
	});
});
