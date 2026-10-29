// The tasks the user touched from the Lead chat (started, messaged, answered)
// talk back into it: each reply their agent finishes a turn with lands in the
// thread with a reply box, and a stop at a terminal prompt is said out loud, so
// the user can keep going without opening the session.
//
// These items are the user's, not the Lead model's: they are recorded beside
// the conversation (LeadSession.record) and never sent to the agent, so
// following a task costs no tokens. A task is followed from the reply it had
// when touched, read from the task itself rather than this Mac's clock, so a
// box whose clock runs behind cannot make a reply look old.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CH, type TaskDTO, type TaskLastReplyDTO } from "@ateam/protocol";
import type { LeadItem, LeadTaskRef } from "../../shared/lead";

/** The most recently touched tasks; older ones stop reporting back. */
export const MAX_FOLLOWED = 50;

interface Followed {
	ref: LeadTaskRef;
	/** The newest reply already shown (or skipped as older than the follow). */
	lastReplyAt: number;
	agentStatus: string | null;
}

export interface FollowerOptions {
	dir: string;
	handle(method: string, args: unknown[]): Promise<unknown>;
	record(item: LeadItem): void;
}

export const refOf = (t: TaskDTO): LeadTaskRef => ({
	taskId: t.id,
	name: t.name,
	agentId: t.agentId,
});

export class Follower {
	private followed = new Map<string, Followed>();
	private readonly file: string;

	constructor(private o: FollowerOptions) {
		this.file = join(o.dir, "follow.json");
		try {
			for (const f of JSON.parse(readFileSync(this.file, "utf8")) as Followed[])
				this.followed.set(f.ref.taskId, f);
		} catch {
			/* nothing followed yet */
		}
	}

	/** Start (or refresh) following a task the user just touched. */
	follow(task: TaskDTO): void {
		const prev = this.followed.get(task.id);
		this.followed.delete(task.id);
		this.followed.set(task.id, {
			ref: refOf(task),
			lastReplyAt: Math.max(prev?.lastReplyAt ?? 0, task.lastReplyAt ?? 0),
			agentStatus: task.agentStatus,
		});
		while (this.followed.size > MAX_FOLLOWED) {
			const oldest = this.followed.keys().next().value;
			if (oldest === undefined) break;
			this.followed.delete(oldest);
		}
		this.save();
	}

	/** Every engine's taskUpdated passes through here. */
	async onTaskUpdated(task: TaskDTO): Promise<void> {
		const f = this.followed.get(task.id);
		if (!f) return;
		f.ref = refOf(task);
		// Stopped at a prompt in its terminal (a permission, a dialog): it can only
		// be answered there for now, so say so once and offer to open it.
		if (
			task.agentStatus === "awaiting_input" &&
			f.agentStatus !== "awaiting_input" &&
			!task.question
		)
			this.o.record({
				kind: "notice",
				id: randomUUID(),
				text: `${task.name} is waiting on a prompt in its terminal.`,
				tone: "info",
				at: Date.now(),
				task: f.ref,
			});
		f.agentStatus = task.agentStatus;
		const at = task.lastReplyAt ?? 0;
		if (at <= f.lastReplyAt) return;
		// Claimed before the read, so a second update for the same turn can't show it twice.
		f.lastReplyAt = at;
		this.save();
		// A turn that ended by asking (ask_user) says no more than "I asked": the
		// question's own card, right below the thread, is the message.
		if (task.question) return;
		try {
			const reply = (await this.o.handle(CH.tasksLastReply, [task.id])) as TaskLastReplyDTO | null;
			if (reply)
				this.o.record({
					kind: "agent",
					id: randomUUID(),
					task: f.ref,
					text: reply.text,
					at: reply.at,
				});
		} catch {
			/* the box went away or predates v18: the card on the board still has it */
		}
	}

	private save(): void {
		writeFileSync(this.file, JSON.stringify([...this.followed.values()]));
	}
}
