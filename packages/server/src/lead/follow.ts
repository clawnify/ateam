// The tasks the user touched from the Lead chat (started, messaged, answered)
// talk back into it: each reply their agent finishes a turn with lands in the
// thread with a reply box, and a stop at a terminal prompt is said out loud, so
// the user can keep going without opening the session.
//
// These items are the user's, not the Lead model's: they are recorded beside
// the conversation (LeadSession.record) and never sent to the agent, so
// following a task costs no tokens. The one exception is a message the Lead
// sent that never reached the task's agent (TaskDTO.undelivered): the user sees
// it in the thread, and the agent hears it with the user's next message
// (LeadSession.note), so it stops promising an answer that cannot come. A task is followed from the reply it had
// when touched, read from the task itself rather than this Mac's clock, so a
// box whose clock runs behind cannot make a reply look old.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CH,
	type LeadItem,
	type LeadTaskRef,
	TASK_LINK_SCHEME,
	type TaskDTO,
	type TaskLastReplyDTO,
	type TaskUndeliveredDTO,
	undeliveredText,
} from "@ateam/protocol";

/** The most recently touched tasks; older ones stop reporting back. */
export const MAX_FOLLOWED = 50;

interface Followed {
	ref: LeadTaskRef;
	/** The newest reply already shown (or skipped as older than the follow). */
	lastReplyAt: number;
	agentStatus: string | null;
	/** The page already shown (or there when followed); absent in older files. */
	pageId?: string | null;
	pageAt?: number;
	/** The undelivered message already told (or there when followed). */
	undeliveredAt?: number;
}

export interface FollowerOptions {
	dir: string;
	handle(method: string, args: unknown[]): Promise<unknown>;
	record(item: LeadItem): void;
	/** Tell the Lead's agent with the user's next message (LeadSession.note). */
	note?(line: string): void;
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
			pageId: task.page?.id ?? null,
			pageAt: task.page?.at,
			undeliveredAt: Math.max(prev?.undeliveredAt ?? 0, task.undelivered?.at ?? 0),
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
		const missed = task.undelivered;
		if (missed && missed.at > (f.undeliveredAt ?? 0)) {
			f.undeliveredAt = missed.at;
			this.save();
			this.tellUndelivered(f.ref, missed);
		}
		// A new page or revision: drawn in the thread, unless it belongs to a question, whose
		// card (below the thread) draws it.
		if (task.page && (task.page.id !== (f.pageId ?? null) || task.page.at !== f.pageAt)) {
			f.pageId = task.page.id;
			f.pageAt = task.page.at;
			this.save();
			if (task.question?.pageId !== task.page.id)
				this.o.record({
					kind: "page",
					id: randomUUID(),
					task: f.ref,
					pageId: task.page.id,
					title: task.page.title,
					at: task.page.at,
				});
		}
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

	/** A message to a followed task that did not reach its agent: said in the
	 *  thread, and to the Lead's agent when it was the Lead's. A box's Lead and
	 *  the Mac's both send as the Lead, so either may hear of the other's. */
	private tellUndelivered(ref: LeadTaskRef, u: TaskUndeliveredDTO): void {
		this.o.record({
			kind: "notice",
			id: randomUUID(),
			text: undeliveredText(u, ref.name),
			tone: u.state === "failed" ? "error" : "info",
			at: Date.now(),
			task: ref,
		});
		if (!u.from.includes("lead")) return;
		const link = `[${ref.name.replace(/[[\]\n]/g, " ")}](${TASK_LINK_SCHEME}${ref.taskId})`;
		const yours = `your message to ${link} that begins ${JSON.stringify(u.opening)}`;
		this.o.note?.(
			u.state === "failed"
				? `${yours} did not reach its agent: ${u.why}. No answer to it will come; the user saw this in the chat.`
				: `${yours} has not reached its agent yet: ${u.why}. It goes in once the user answers that prompt.`,
		);
	}

	private save(): void {
		writeFileSync(this.file, JSON.stringify([...this.followed.values()]));
	}
}
