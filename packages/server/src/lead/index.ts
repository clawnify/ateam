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
	type TaskDTO,
} from "@ateam/protocol";
import { LeadAttachments } from "./attachments";
import { Follower, refOf } from "./follow";
import { startLeadMcpServer } from "./mcp-http";
import { type LeadPlace, LeadSession, type LeadSessionOptions } from "./session";
import { createLeadTools, LEAD_TOOL_NAMES } from "./tools";

export type { LeadPlace } from "./session";

export interface LeadDeps {
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
}

/** What a host's transport calls. A refusal throws with words for the user. */
export interface Lead {
	readonly attachments: LeadAttachments;
	snapshot(): LeadSnapshot;
	/** The user's message; `paths` are files attached in this chat. Starts the
	 *  agent on first use. */
	send(text: string, paths?: string[]): void;
	/** A file with no path on the Lead's machine: a pasted screenshot, a photo. */
	attachBytes(name: string, data: Uint8Array): LeadFile;
	interrupt(): void;
	/** A new conversation; the old one is archived, not deleted. */
	reset(): void;
	permission(id: string, answer: LeadPermissionAnswer): void;
	/** Auto mode on or off: Claude's own auto mode, applied to the running agent. */
	setAuto(on: boolean): void;
	/** The user created (`taskId` when it was a task) or dismissed a proposal. */
	proposal(id: string, outcome: "created" | "dismissed", taskId?: string): Promise<void>;
	/** The user talks to a task's agent straight from the chat. */
	reply(taskId: string, text: string): Promise<void>;
	/** The user answers (or with null dismisses) a task's question from the chat. */
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
	/** Feed every engine's taskUpdated here: followed tasks report back. */
	onTaskUpdated(task: TaskDTO): void;
	dispose(): void;
}

const fail = (reason: string): never => {
	throw new Error(reason);
};

export async function startLead(deps: LeadDeps): Promise<Lead> {
	const { handle } = deps;
	// The session is created below; the follower records into it through this.
	let session: LeadSession | null = null;
	const follower = new Follower({ dir: deps.dir, handle, record: (item) => session?.record(item) });
	const attachments = new LeadAttachments(deps.dir);
	attachments.prune();
	const tools = createLeadTools({
		place: deps.place,
		handle,
		machineOf: deps.machineOf,
		onTouch: (task) => follower.follow(task),
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
	});
	const mcp = await startLeadMcpServer(tools);
	session = new LeadSession({
		dir: deps.dir,
		place: deps.place,
		mcp,
		allowedTools: LEAD_TOOL_NAMES,
		emit: deps.emit,
		...(deps.spawnClaude ? { spawnClaude: deps.spawnClaude } : {}),
	});
	const lead = session;

	return {
		attachments,
		snapshot: () => lead.snapshot(),
		send(text, paths) {
			const files = paths?.length ? attachments.resolve(paths.map(String)) : [];
			if (typeof files === "string") fail(files);
			else lead.send(String(text), files);
		},
		attachBytes: (name, data) => attachments.addBytes(String(name), data),
		interrupt: () => lead.interrupt(),
		reset: () => lead.reset(),
		permission: (id, answer) => lead.answerPermission(String(id), answer),
		setAuto: (on) => lead.setAuto(on),
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
			const decided: LeadItem = {
				...item,
				outcome: outcome === "created" ? "created" : "dismissed",
				...(task ? { task: refOf(task) } : {}),
			};
			lead.record(decided);
		},
		// Delivered as from the user, shown in the thread, and the task followed
		// for its reply.
		async reply(taskId, text) {
			const body = String(text).trim();
			if (!body) return;
			const task = (await handle(CH.tasksGet, [taskId])) as TaskDTO;
			const res = (await handle(CH.tasksMessage, [{ taskId, body }])) as {
				ok: boolean;
				reason: string;
			};
			if (!res.ok) fail(res.reason);
			follower.follow(task);
			lead.record({ kind: "user", id: randomUUID(), text: body, at: Date.now(), to: refOf(task) });
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
			lead.record({ kind: "user", id: randomUUID(), text, at: Date.now(), to: refOf(before) });
		},
		onTaskUpdated: (task) => void follower.onTaskUpdated(task),
		dispose() {
			lead.dispose();
			mcp.close();
		},
	};
}
