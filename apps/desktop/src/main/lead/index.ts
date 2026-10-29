// The Lead chat: one coordinator conversation over every engine the desktop
// holds. Its agent runs here in main (session.ts) and reaches the board through
// an MCP server that routes like the renderer does (tools.ts, mcp-http.ts). The
// tasks the user touches from the chat report back into it (follow.ts).
import { randomUUID } from "node:crypto";
import { CH, type TaskDTO } from "@ateam/protocol";
import { ipcMain } from "electron";
import { LEAD_CH, type LeadEvent, type LeadPermissionAnswer } from "../../shared/lead";
import type { Router } from "../backend";
import { Follower, refOf } from "./follow";
import { startLeadMcpServer } from "./mcp-http";
import { LeadSession } from "./session";
import { createLeadTools, LEAD_TOOL_NAMES } from "./tools";

export interface LeadDeps {
	router: Router;
	/** The box an entity lives on, or null for this Mac (host.origins). */
	machineOf(id: string): string | null;
	/** userData/lead: transcript, session id, MCP config, followed tasks. */
	dir: string;
	broadcast(channel: string, e: LeadEvent): void;
}

export interface Lead {
	/** Feed every engine's taskUpdated here: followed tasks report back. */
	onTaskUpdated(task: TaskDTO): void;
	dispose(): void;
}

/** An IPC rejection carries only the message; keep the engine's own words. */
const fail = (reason: string): never => {
	throw new Error(reason);
};

export async function startLead(deps: LeadDeps): Promise<Lead> {
	const handle = async (method: string, args: unknown[]) => deps.router.handle(method, args);
	// The session is created below; the follower records into it through this.
	let session: LeadSession | null = null;
	const follower = new Follower({ dir: deps.dir, handle, record: (item) => session?.record(item) });
	const tools = createLeadTools({
		handle,
		machineOf: deps.machineOf,
		onTouch: (task) => follower.follow(task),
	});
	const mcp = await startLeadMcpServer(tools);
	session = new LeadSession({
		dir: deps.dir,
		mcp,
		allowedTools: LEAD_TOOL_NAMES,
		emit: (e) => deps.broadcast(LEAD_CH.evtEvent, e),
	});
	const lead = session;
	ipcMain.handle(LEAD_CH.snapshot, () => lead.snapshot());
	ipcMain.handle(LEAD_CH.send, (_e, text: string) => lead.send(String(text)));
	ipcMain.handle(LEAD_CH.interrupt, () => lead.interrupt());
	ipcMain.handle(LEAD_CH.reset, () => lead.reset());
	ipcMain.handle(LEAD_CH.permission, (_e, id: string, answer: LeadPermissionAnswer) =>
		lead.answerPermission(String(id), answer),
	);

	// The user talking to a task's agent straight from the chat: delivered as
	// from the user, shown in the thread, and the task followed for its reply.
	ipcMain.handle(LEAD_CH.reply, async (_e, taskId: string, text: string) => {
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
	});
	ipcMain.handle(
		LEAD_CH.answer,
		async (_e, input: { taskId: string; questionId: string; answer: string | string[] | null }) => {
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
	);
	return {
		onTaskUpdated: (task) => void follower.onTaskUpdated(task),
		dispose() {
			lead.dispose();
			mcp.close();
		},
	};
}
