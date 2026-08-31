/**
 * One-shot follow-ups — a second turn the agent takes by itself, right after
 * the first response of a run (the "run /check once you've analysed it" move).
 *
 * Delivery is the agent's OWN continuation contract, never keystrokes. When a
 * turn ends, the status hook already pings the hook server; if that terminal
 * has a follow-up armed, the reply is `{"decision":"block","reason":"<text>"}`,
 * which the hook script hands back on stdout and the agent acts on. Verified
 * against Claude Code 2.1.251, where `decision: "block"` is the documented Stop
 * output and both a slash command and a plain sentence travel this path
 * identically. This is what keeps Ateam out of typing into a live TUI — see
 * `loops/agent-loops.design.md`, "zero PTY injection".
 *
 * Two properties this module owns:
 *
 *   - **Only a real turn end fires it.** `Stop` alone qualifies. A permission
 *     prompt reports `PermissionRequest`, so a follow-up can never be delivered
 *     into a pending question.
 *   - **Consume-once.** The entry is dropped the instant it is handed out, so a
 *     run can never continue itself twice. The agent's own `stop_hook_active`
 *     backstop sits underneath that, but it is not what we rely on.
 */
export class FollowUps {
	private pending = new Map<string, string>();

	/** Arm the follow-up for a terminal, at launch. Blank text arms nothing. */
	arm(terminalId: string, text: string | undefined): void {
		const trimmed = text?.trim();
		if (trimmed) this.pending.set(terminalId, trimmed);
	}

	/** Hand out this terminal's follow-up, once, and only at a real turn end. */
	take(terminalId: string, eventType: string): string | undefined {
		if (eventType !== "Stop") return undefined;
		const text = this.pending.get(terminalId);
		if (text !== undefined) this.pending.delete(terminalId);
		return text;
	}

	/** Forget an unused follow-up — the pane died before any turn ended. */
	discard(terminalId: string): void {
		this.pending.delete(terminalId);
	}

	/** Armed count, for tests. */
	get size(): number {
		return this.pending.size;
	}
}
