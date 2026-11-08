import { describe, expect, it } from "bun:test";
import { queueCodexMessage, type RunShell } from "../src/codex-queue";

describe("queueCodexMessage", () => {
	// The command line goes through a login shell: whatever the message holds
	// must reach Codex as one argument, exactly.
	it("passes the thread and the message to `codex queue` intact", async () => {
		let line = "";
		const run: RunShell = async (command) => {
			line = command;
			return { ok: true, stdout: "Queued message m-1 for thread th-1.\n" };
		};
		const text = `[Ateam] Message from "a" (it's not the user):\nline two $HOME \`x\` \\ end\0`;
		expect(await queueCodexMessage("th-1", text, "/w", run)).toBe(true);
		const proc = Bun.spawn(["sh", "-c", `codex() { printf '%s\\0' "$@"; }; ${line}`], {
			stdout: "pipe",
		});
		const args = (await new Response(proc.stdout).text()).split("\0").slice(0, -1);
		expect(args).toEqual(["queue", "--thread", "th-1", "--message", text.replaceAll("\0", "")]);
	});

	it("is false unless Codex says it queued it", async () => {
		const answer =
			(ok: boolean, stdout: string): RunShell =>
			async () => ({ ok, stdout });
		expect(
			await queueCodexMessage("t", "m", "/w", answer(true, "Queued message x for thread t.")),
		).toBe(true);
		// A Codex without the subcommand: clap's error, exit 2.
		expect(await queueCodexMessage("t", "m", "/w", answer(false, ""))).toBe(false);
		expect(await queueCodexMessage("t", "m", "/w", answer(true, "something else"))).toBe(false);
	});
});
