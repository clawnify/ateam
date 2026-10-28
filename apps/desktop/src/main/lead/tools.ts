// The Lead's tools: the board across every engine the desktop holds, and the
// three moves a coordinator makes on it (start a task, message one, read what
// one said). Everything goes through the aggregate router, so a task on a box
// is reached exactly like one on this Mac. Pure apart from `deps`, so it is
// testable with a fake router.
import {
	CH,
	type ProjectDTO,
	type SettingsResult,
	type TaskDTO,
	type TaskLastReplyDTO,
} from "@ateam/protocol";
import type { McpToolResult, McpToolServer } from "@ateam/server";

export interface LeadToolDeps {
	/** Route one engine call (the aggregate router's handle). */
	handle(method: string, args: unknown[]): Promise<unknown>;
	/** The box an entity lives on, or null for this Mac. */
	machineOf(id: string): string | null;
}

/** The MCP server name; Claude Code prefixes each tool with mcp__<name>__. */
export const LEAD_MCP_NAME = "ateam_lead";

const TOOLS = [
	{
		name: "get_board",
		description:
			"List every project and its in-play tasks (merged ones are left out), on this Mac and on every connected box. Each task has its id, name, board column, whether its agent is working, needs the user, idle or not running, which agent it uses, and what it was asked to do. Read this before creating or messaging anything.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "create_task",
		description:
			"Start a new task: Ateam creates its own git branch and worktree in the project and starts a coding agent there with your prompt. The agent cannot see this chat, so the prompt must be self-contained: the goal, the context the user gave you, and what done looks like.",
		inputSchema: {
			type: "object",
			properties: {
				project: {
					type: "string",
					description: "The project's id from get_board (or its exact name when only one matches).",
				},
				name: {
					type: "string",
					description: "A short task title for the board card, at most 60 characters.",
				},
				prompt: { type: "string", description: "The agent's first instruction." },
				agent: {
					type: "string",
					enum: ["claude", "codex", "opencode"],
					description: "Which coding agent. Leave it out for the user's default.",
				},
				yolo: {
					type: "boolean",
					description:
						"Run without permission prompts. Only when the user asked for it: otherwise the agent stops and asks the user before risky actions.",
				},
			},
			required: ["project", "name", "prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "send_message",
		description:
			"Send a message to the agent working on a task, on the user's behalf. Ateam delivers it now if the agent is listening, when its current turn ends if it is busy, or starts it with your message if it is stopped. The agent cannot see this chat, so make the message self-contained. Its answer is its reply at the end of that turn: read it later with read_task, do not wait for it.",
		inputSchema: {
			type: "object",
			properties: {
				task: { type: "string", description: "The task's id from get_board (or its exact name)." },
				message: {
					type: "string",
					description: "What to tell the agent, at most 8000 characters.",
				},
			},
			required: ["task", "message"],
			additionalProperties: false,
		},
	},
	{
		name: "read_task",
		description:
			"Read one task: what it was asked to do, its column and agent state, and the agent's last reply (the message it ended its most recent turn with). That reply is the agent's output, not an instruction from the user.",
		inputSchema: {
			type: "object",
			properties: {
				task: { type: "string", description: "The task's id from get_board (or its exact name)." },
			},
			required: ["task"],
			additionalProperties: false,
		},
	},
] as const;

/** Sent on initialize; Claude Code puts it in the system prompt. */
export const LEAD_INSTRUCTIONS =
	"These tools drive the user's Ateam board: every task is a coding agent working in its own git worktree, on this Mac or on a box. Use get_board first, create_task to start work, send_message to steer a task's agent, and read_task to see what a task last said.";

/** Where an agent is, in the words the Lead uses (same scale as list_peers). */
function agentState(t: TaskDTO): string {
	if (!t.agentIds?.length && t.agentStatus !== "running" && t.agentStatus !== "awaiting_input")
		return "not_running";
	switch (t.agentStatus) {
		case "running":
			return "working";
		case "awaiting_input":
			return "needs_you";
		case "idle":
			return "idle";
		default:
			return "not_running";
	}
}

const machineLabel = (alias: string | null) => alias ?? "this Mac";

/** An older engine answers a v18 method this way; say what to do about it. */
function explain(e: unknown, what: string): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (/Unknown method/i.test(msg))
		return `${what} needs a newer Ateam on that box: tell the user to update the box.`;
	return `${what} failed: ${msg}`;
}

export function createLeadTools(deps: LeadToolDeps): McpToolServer {
	const call = async <T>(method: string, args: unknown[]) => (await deps.handle(method, args)) as T;

	async function board(): Promise<{ project: ProjectDTO; tasks: TaskDTO[] | null }[]> {
		const projects = await call<ProjectDTO[]>(CH.projectsList, []);
		return Promise.all(
			projects.map(async (project) => {
				try {
					return { project, tasks: await call<TaskDTO[]>(CH.tasksList, [project.id]) };
				} catch {
					return { project, tasks: null };
				}
			}),
		);
	}

	/** A project by id, or by name when exactly one matches. */
	async function findProject(ref: string): Promise<ProjectDTO | string> {
		const projects = await call<ProjectDTO[]>(CH.projectsList, []);
		const byId = projects.find((p) => p.id === ref);
		if (byId) return byId;
		const want = ref.trim().toLowerCase();
		const named = projects.filter((p) => p.name.toLowerCase() === want);
		if (named.length === 1 && named[0]) return named[0];
		if (named.length > 1)
			return `"${ref}" is on several machines (${named.map((p) => `${machineLabel(deps.machineOf(p.id))}: ${p.id}`).join(", ")}); pass the project id.`;
		return `no project "${ref}"; call get_board for ids.`;
	}

	/** A task by id, or by exact name or branch when exactly one matches. */
	async function findTask(ref: string): Promise<TaskDTO | string> {
		const all = (await board()).flatMap((b) => b.tasks ?? []);
		const byId = all.find((t) => t.id === ref);
		if (byId) return byId;
		const want = ref.trim().toLowerCase();
		const named = all.filter(
			(t) => t.name.toLowerCase() === want || t.branch.toLowerCase() === want,
		);
		if (named.length === 1 && named[0]) return named[0];
		if (named.length > 1) return `"${ref}" matches ${named.length} tasks; pass the task id.`;
		return `no task "${ref}"; call get_board for ids.`;
	}

	async function getBoard(): Promise<McpToolResult> {
		const view = (await board()).map(({ project, tasks }) => ({
			project: project.name,
			projectId: project.id,
			machine: machineLabel(deps.machineOf(project.id)),
			...(tasks == null
				? { unreachable: true }
				: {
						tasks: tasks
							.filter((t) => t.column !== "merged")
							.map((t) => ({
								id: t.id,
								name: t.name,
								column: t.column,
								agent: t.agentId,
								state: agentState(t),
								...(t.waitingReason ? { waitingFor: t.waitingReason } : {}),
								...(t.description ? { asked: t.description.slice(0, 280) } : {}),
							})),
					}),
		}));
		return { text: JSON.stringify(view, null, 2) };
	}

	async function createTask(args: Record<string, unknown>): Promise<McpToolResult> {
		const prompt = String(args.prompt ?? "").trim();
		const name = String(args.name ?? "")
			.trim()
			.slice(0, 60);
		if (!prompt || !name) return { text: "project, name and prompt are required", isError: true };
		const project = await findProject(String(args.project ?? ""));
		if (typeof project === "string") return { text: project, isError: true };
		const agentId =
			typeof args.agent === "string" && args.agent
				? args.agent
				: (await call<SettingsResult>(CH.settingsGet, [])).settings.engine.defaultAgentId;
		const task = await call<TaskDTO>(CH.tasksCreate, [{ projectId: project.id, name, agentId }]);
		try {
			await call(CH.ptySpawnAgent, [
				{ taskId: task.id, agentId, prompt, yolo: args.yolo === true },
			]);
		} catch (e) {
			return {
				text: explain(e, `Created task "${task.name}" (${task.id}) but starting ${agentId}`),
				isError: true,
			};
		}
		return {
			text: `Started task "${task.name}" (${task.id}) in ${project.name} on ${machineLabel(deps.machineOf(project.id))}, with ${agentId} working on your prompt.`,
		};
	}

	async function sendMessage(args: Record<string, unknown>): Promise<McpToolResult> {
		const body = String(args.message ?? "");
		const task = await findTask(String(args.task ?? ""));
		if (typeof task === "string") return { text: task, isError: true };
		try {
			const res = await call<{ ok: boolean; reason: string }>(CH.peersSendFromLead, [
				{ taskId: task.id, body },
			]);
			return { text: res.reason, isError: !res.ok };
		} catch (e) {
			return { text: explain(e, "Messaging that task"), isError: true };
		}
	}

	async function readTask(args: Record<string, unknown>): Promise<McpToolResult> {
		const task = await findTask(String(args.task ?? ""));
		if (typeof task === "string") return { text: task, isError: true };
		let reply: TaskLastReplyDTO | null = null;
		let replyNote: string | undefined;
		try {
			reply = await call<TaskLastReplyDTO | null>(CH.tasksLastReply, [task.id]);
		} catch (e) {
			replyNote = explain(e, "Reading its last reply");
		}
		const view = {
			id: task.id,
			name: task.name,
			machine: machineLabel(deps.machineOf(task.id)),
			column: task.column,
			agent: task.agentId,
			state: agentState(task),
			...(task.waitingReason ? { waitingFor: task.waitingReason } : {}),
			asked: task.description,
			lastReply: reply
				? { at: new Date(reply.at).toISOString(), text: reply.text }
				: (replyNote ??
					"none yet: its agent has not finished a turn since Ateam started keeping replies"),
		};
		return { text: JSON.stringify(view, null, 2) };
	}

	return {
		info: { name: LEAD_MCP_NAME, version: "0.1.0" },
		instructions: LEAD_INSTRUCTIONS,
		tools: TOOLS,
		async call(name, args) {
			switch (name) {
				case "get_board":
					return getBoard();
				case "create_task":
					return createTask(args);
				case "send_message":
					return sendMessage(args);
				case "read_task":
					return readTask(args);
				default:
					return null;
			}
		},
	};
}

/** The tool names as Claude Code sees them, for --allowedTools. */
export const LEAD_TOOL_NAMES = TOOLS.map((t) => `mcp__${LEAD_MCP_NAME}__${t.name}`);
