// The Lead chat: one coordinator conversation over the board. Its agent is a
// headless Claude Code (session.ts) that reaches the board through an MCP
// server on loopback (tools.ts, mcp-http.ts). The tasks the user touches from
// the chat report back into it (follow.ts). Tasks and loops the Lead proposes
// wait in the chat until the user acts on them.
//
// Two hosts run this, each wiring it to its own transport:
// - the desktop, in main, over every engine it holds (apps/desktop main/lead),
//   answering the renderer over Electron IPC;
// - a box's engine, over that box alone, for the phone (engine-lead.ts),
//   answering over the engine's RPC.
import { randomUUID } from "node:crypto";
import {
	CH,
	type LeadEvent,
	type LeadFile,
	type LeadItem,
	type LeadPermissionAnswer,
	type LeadSnapshot,
	TASK_LINK_SCHEME,
	type TaskDTO,
} from "@ateam/protocol";
import { LeadAttachments } from "./attachments";
import { Follower, refOf } from "./follow";
import { startLeadMcpServer } from "./mcp-http";
import { type LeadPlace, LeadSession, type LeadSessionOptions } from "./session";
import { createLeadTools, LEAD_TOOL_NAMES } from "./tools";

export type { LeadPlace } from "./session";

export interface LeadDeps {
	preferences?: LeadSessionOptions["preferences"];
	/** Where it runs, for the words its agent and tools use. */
	place: LeadPlace;
	/** Its folder: transcript, session id, MCP config, followed tasks, attachments.
	 *  Also the agent's working folder. */
	dir: string;
	/** One engine call: the desktop's aggregate router, or a box's dispatcher. */
	handle(method: string, args: unknown[]): Promise<unknown>;
	/** The box an entity lives on, or null for the machine the Lead runs on. */
	machineOf(id: string): string | null;
	/** Get attached files to the machine the task `ownerId` is on, and say at
	 *  which paths its agent reads them. */
	deliver(ownerId: string, paths: string[]): Promise<{ paths: string[] } | { error: string }>;
	emit(e: LeadEvent): void;
	/** How to start `claude` (tests); default: through the login shell. */
	spawnClaude?: LeadSessionOptions["spawnClaude"];
	/** Stop the agent after this long idle (a box's Lead); see LeadSessionOptions. */
	idleStopMs?: number;
	/** The agent's working folder when not `dir` (LeadSessionOptions.cwd). */
	cwd?: string;
	/** A project window's chat: the project it is about (LeadToolDeps.home). */
	home?: string;
	/** A home chat messaged a task in another project: a line for the main
	 *  chat's note(), which its agent reads with the user's next message there. */
	onElsewhere?(line: string): void;
}

/** What a host's transport calls. A refusal throws with words for the user. */
export interface Lead {
	readonly attachments: LeadAttachments;
	/** `tail`: only the last that many items (a phone's first load). */
	snapshot(tail?: number): LeadSnapshot;
	/** Up to `limit` items before `beforeId`, oldest first. */
	older(beforeId: string, limit: number): { items: LeadItem[]; more: boolean };
	/** Mid-turn, and not waiting on the user to answer a permission prompt. */
	working(): boolean;
	/** The user's message; `paths` are files attached in this chat. Starts the
	 *  agent on first use. */
	send(text: string, paths?: string[]): void;
	/** A file with no path on the Lead's machine: a pasted screenshot, a photo. */
	attachBytes(name: string, data: Uint8Array): LeadFile;
	interrupt(): void;
	/** A new conversation; the old one is archived, not deleted. */
	reset(): void;
	/** Claude's own prompt, or a message or answer held during a call (below). */
	permission(id: string, answer: LeadPermissionAnswer): void | Promise<void>;
	/** Machine-owned Auto mode, applied through the selected agent runtime. */
	setAuto(on: boolean): void | Promise<unknown>;
	/** The user is on a voice call with this chat (true, repeated while it
	 *  lasts; it lapses after CALL_GUARD_MS without one) or hung up. While a
	 *  call is on, the Lead's messages and answers to tasks wait as permission
	 *  cards for the user's tap: a call's words are transcribed, and may have
	 *  been misheard or said to someone else in the room. */
	setCall(on: boolean): void;
	/** The user created (`taskId` when it was a task) or dismissed a proposal. */
	proposal(id: string, outcome: "created" | "dismissed", taskId?: string): Promise<void>;
	/** The user talks to a task's agent straight from the chat. */
	reply(taskId: string, text: string): Promise<void>;
	/** The user answers an agent's reply (`id`, an agent item) with an emoji:
	 *  sent like a reply, and drawn on that reply's card. */
	react(id: string, emoji: string): Promise<void>;
	/** The user answers (or with null dismisses) a task's question from the chat. */
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
	/** Feed every engine's taskUpdated here: followed tasks report back. */
	onTaskUpdated(task: TaskDTO): void;
	/** Tell the agent something with the user's next message (LeadSession.note). */
	note(line: string): void;
	dispose(): void;
}

const fail = (reason: string): never => {
	throw new Error(reason);
};

/** A call's "on" lapses this long after the window last said so: a window that
 *  crashed mid-call stops holding the Lead's messages soon after. */
export const CALL_GUARD_MS = 90_000;

/** What the Lead hears when a message or answer is held for the user's tap. */
const HELD_FOR_TAP =
	"Held for the user's OK: Ateam shows this as a card in the chat and nothing goes to the task until they tap Allow. Tell them in a few words that it is waiting for their OK. Do not send it again; you hear what they decided with their next message.";

export async function startLead(deps: LeadDeps): Promise<Lead> {
	const { handle } = deps;
	// The session is created below; the follower records into it through this.
	let session: LeadSession | null = null;
	const follower = new Follower({ dir: deps.dir, handle, record: (item) => session?.record(item) });
	const attachments = new LeadAttachments(deps.dir);
	attachments.prune();
	// A voice call: until when it is on, and the messages and answers held for
	// the user's tap, by the id of the permission card that shows each. Held in
	// memory: a restart cancels the cards (session.ts marks unanswered ones).
	let callUntil = 0;
	type HeldAction = { text: string; run: () => Promise<{ text: string; isError?: boolean }> };
	const held = new Map<string, HeldAction>();
	const tools = createLeadTools({
		place: deps.place,
		handle,
		machineOf: deps.machineOf,
		onTouch: (task) => follower.follow(task),
		hold: (r) => {
			if (!session || (Date.now() >= callUntil && !(r.required && session.agent() !== "claude")))
				return null;
			const id = randomUUID();
			held.set(id, r);
			session.record({
				kind: "permission",
				id,
				text: r.text,
				canAlways: false,
				always: null,
				at: Date.now(),
			});
			return HELD_FOR_TAP;
		},
		propose: (p) => {
			if (!session) return;
			// The same name again is the Lead revising its proposal: the earlier
			// card stops offering to open it.
			for (const it of session.snapshot().items)
				if (
					it.kind === "proposal" &&
					!it.outcome &&
					it.proposal.kind === p.proposal.kind &&
					it.proposal.name === p.proposal.name
				)
					session.record({ ...it, outcome: "replaced" });
			session.record({ kind: "proposal", id: randomUUID(), at: Date.now(), ...p });
		},
		files: {
			resolve: (paths) => {
				const files = attachments.resolve(paths);
				return typeof files === "string" ? files : files.map((f) => f.path);
			},
			deliver: deps.deliver,
		},
		...(deps.home ? { home: deps.home } : {}),
		...(deps.onElsewhere
			? {
					onElsewhere: ({ task, projectName, homeName, body }) => {
						const said = body.replace(/\s+/g, " ").trim();
						deps.onElsewhere?.(
							`messaged [${task.name.replace(/[[\]\n]/g, " ")}](${TASK_LINK_SCHEME}${task.id}) in ${projectName} from ${homeName}'s own Lead chat: ${JSON.stringify(said.length > 200 ? `${said.slice(0, 200)}…` : said)}`,
						);
					},
				}
			: {}),
	});
	const mcp = await startLeadMcpServer(tools);
	session = new LeadSession({
		preferences: deps.preferences,
		dir: deps.dir,
		place: deps.place,
		mcp,
		allowedTools: LEAD_TOOL_NAMES,
		emit: deps.emit,
		describe: (tool, input) => tools.describe(tool, input),
		...(deps.cwd ? { cwd: deps.cwd } : {}),
		...(deps.spawnClaude ? { spawnClaude: deps.spawnClaude } : {}),
		...(deps.idleStopMs ? { idleStopMs: deps.idleStopMs } : {}),
	});
	const lead = session;

	/** The user's words to a task's agent, delivered as from the user, and the
	 *  task followed for its reply. */
	const message = async (taskId: string, body: string): Promise<TaskDTO> => {
		const task = (await handle(CH.tasksGet, [taskId])) as TaskDTO;
		const res = (await handle(CH.tasksMessage, [{ taskId, body }])) as {
			ok: boolean;
			reason: string;
		};
		if (!res.ok) fail(res.reason);
		follower.follow(task);
		return task;
	};

	return {
		attachments,
		snapshot: (tail) => lead.snapshot(tail),
		older: (beforeId, limit) => lead.older(String(beforeId), limit),
		working: () => lead.working(),
		send(text, paths) {
			const files = paths?.length ? attachments.resolve(paths.map(String)) : [];
			if (typeof files === "string") fail(files);
			else lead.send(String(text), files);
		},
		attachBytes: (name, data) => attachments.addBytes(String(name), data),
		interrupt: () => lead.interrupt(),
		reset: () => lead.reset(),
		async permission(id, answer) {
			const action = held.get(String(id));
			if (!action) return lead.answerPermission(String(id), answer);
			held.delete(String(id));
			const card = lead.item(String(id));
			const what = action.text.split("\n")[0]?.replace(/\*\*/g, "") ?? "your held message";
			if (answer === "deny") {
				if (card?.kind === "permission") lead.record({ ...card, answer: "deny" });
				lead.note(`the user said no to ${JSON.stringify(what)}: it was not sent`);
				return;
			}
			const res = await action.run();
			if (card?.kind === "permission") lead.record({ ...card, answer: "allow" });
			lead.note(
				res.isError
					? `the user allowed ${JSON.stringify(what)}, but it failed: ${res.text}`
					: `the user allowed ${JSON.stringify(what)}: ${res.text}`,
			);
			if (res.isError) throw new Error(res.text);
		},
		setAuto: (on) => (deps.preferences ? deps.preferences.update({ auto: on }) : lead.setAuto(on)),
		setCall(on) {
			callUntil = on ? Date.now() + CALL_GUARD_MS : 0;
		},
		// A task made from a proposal is followed, as one the Lead messaged is:
		// its replies come here.
		async proposal(id, outcome, taskId) {
			const item = lead.item(String(id));
			// Decided already (from another window, or a later one replaced it).
			if (item?.kind !== "proposal" || item.outcome) return;
			let task: TaskDTO | null = null;
			if (outcome === "created" && taskId) {
				try {
					task = (await handle(CH.tasksGet, [String(taskId)])) as TaskDTO;
					follower.follow(task);
				} catch {
					/* created on a box that just went away: the outcome still stands */
				}
			}
			// Decided from elsewhere, or a new conversation began, while it was read.
			const now = lead.item(item.id);
			if (now?.kind !== "proposal" || now.outcome) return;
			const decided: LeadItem = {
				...item,
				outcome: outcome === "created" ? "created" : "dismissed",
				...(task ? { task: refOf(task) } : {}),
			};
			lead.record(decided);
			// The agent hears it with the user's next message, so it steers the
			// task it made rather than proposing it again.
			const what = `your proposed ${item.proposal.kind} ${JSON.stringify(item.proposal.name)}`;
			lead.note(
				outcome !== "created"
					? `dismissed ${what}`
					: task
						? `created ${what} as [${task.name.replace(/[[\]\n]/g, " ")}](${TASK_LINK_SCHEME}${task.id})`
						: `created ${what}`,
			);
		},
		// Shown in the thread as the user's message.
		async reply(taskId, text) {
			const body = String(text).trim();
			if (!body) return;
			const task = await message(taskId, body);
			lead.record({ kind: "user", id: randomUUID(), text: body, at: Date.now(), to: refOf(task) });
		},
		// Shown on the reply it answers, in place of a message of its own. A
		// second emoji is sent too, and takes the first one's place.
		async react(id, emoji) {
			const body = String(emoji).trim();
			if (!body) return;
			const item = lead.item(String(id));
			if (item?.kind !== "agent") throw new Error("That reply is no longer in the chat.");
			await message(item.task.taskId, body);
			// Not into a new conversation started while it was on its way.
			if (lead.item(item.id)) lead.record({ ...item, reaction: body });
		},
		async answer(input) {
			const before = (await handle(CH.tasksGet, [input.taskId])) as TaskDTO;
			await handle(CH.tasksAnswerQuestion, [input]);
			if (input.answer == null) return;
			follower.follow(before);
			const text = Array.isArray(input.answer)
				? input.answer.length
					? `Ticked: ${input.answer.join(", ")}`
					: "Ticked nothing"
				: input.answer;
			lead.record({
				kind: "user",
				id: randomUUID(),
				text,
				at: Date.now(),
				to: refOf(before),
				...(before.question ? { question: before.question.text } : {}),
			});
		},
		onTaskUpdated: (task) => void follower.onTaskUpdated(task),
		note: (line) => lead.note(String(line)),
		dispose() {
			lead.dispose();
			mcp.close();
		},
	};
}
