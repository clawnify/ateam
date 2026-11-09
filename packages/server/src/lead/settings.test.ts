import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { readSettings, updateSettings } from "../settings-file";
import { LeadSession } from "./session";
import { chatPreferences } from "./settings";

function setup(auto = false) {
	const dir = mkdtempSync(join(tmpdir(), "chat-settings-test-"));
	const path = join(dir, "settings.json");
	writeFileSync(join(dir, "state.json"), JSON.stringify({ auto, sessionId: "claude-old" }));
	const prefs = chatPreferences(dir, path, async (bin) => bin !== "opencode");
	return { dir, path, prefs };
}
class Claude extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;
	kill() {
		this.killed = true;
		return true;
	}
	say(m: unknown) {
		this.stdout.write(`${JSON.stringify(m)}\n`);
	}
}
function session(dir: string, prefs: ReturnType<typeof chatPreferences>, proc = new Claude()) {
	return {
		proc,
		chat: new LeadSession({
			dir,
			preferences: prefs,
			mcp: { url: "http://127.0.0.1:1/mcp", token: "test" },
			allowedTools: [],
			emit: () => {},
			spawnClaude: () => proc as unknown as ChildProcess,
		}),
	};
}

describe("machine Chat settings", () => {
	it("migrates the main chat's Auto choice and survives engine settings sync", async () => {
		const f = setup(true);
		expect(f.prefs.get()).toEqual({ agent: "claude", auto: true });
		await f.prefs.update({ agent: "codex" });
		updateSettings({ engine: { defaultAgentId: "opencode" } }, f.path);
		expect(readSettings(f.path).settings.chat).toEqual({ agent: "codex", auto: true });
		expect(chatPreferences(f.dir, f.path).get()).toEqual({ agent: "codex", auto: true });
	});
	it("does not change another machine", async () => {
		const a = setup(),
			b = setup();
		await a.prefs.update({ auto: true, agent: "codex" });
		expect(b.prefs.get()).toEqual({ agent: "claude", auto: false });
	});
	it("rejects unavailable agents and invalid network patches without writing", async () => {
		const f = setup();
		await expect(f.prefs.update({ agent: "opencode" })).rejects.toThrow("Install");
		await expect(f.prefs.update({ auto: "yes" } as never)).rejects.toThrow("Auto");
		await expect(f.prefs.update({ unknown: true } as never)).rejects.toThrow("Invalid");
		await expect(f.prefs.update({ agent: "other" } as never)).rejects.toThrow("Unknown");
		expect(f.prefs.get()).toEqual({ agent: "claude", auto: false });
	});
	it("applies Auto to main and project sessions through the one machine owner", async () => {
		const f = setup();
		const a = session(f.dir, f.prefs);
		const b = session(join(f.dir, "project"), f.prefs);
		await f.prefs.update({ auto: true });
		expect(a.chat.snapshot().auto).toBe(true);
		expect(b.chat.snapshot().auto).toBe(true);
		await f.prefs.update({ auto: false });
		expect(a.chat.snapshot().auto).toBe(false);
		expect(b.chat.snapshot().auto).toBe(false);
		a.chat.dispose();
		b.chat.dispose();
	});
	it("defers an agent change until the turn ends and never reuses the other agent's session id", async () => {
		const f = setup();
		const { chat, proc } = session(f.dir, f.prefs);
		chat.send("hello");
		proc.say({ type: "system", subtype: "init", session_id: "claude-live" });
		await f.prefs.update({ agent: "codex" });
		expect(chat.agent()).toBe("claude");
		expect(proc.killed).toBe(false);
		proc.say({ type: "result", subtype: "success" });
		// The next preference reconciliation occurs before any native send.
		await f.prefs.update({ agent: "codex" });
		expect(chat.agent()).toBe("codex");
		expect(proc.killed).toBe(true);
		const state = JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8"));
		expect(state.sessionId).toBeUndefined();
		expect(state.handoff).toBe(true);
		expect(chat.snapshot().items.some((i) => i.kind === "user" && i.text === "hello")).toBe(true);
		chat.dispose();
	});
});
