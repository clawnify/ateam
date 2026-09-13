import type { AteamApi, TaskDTO } from "@ateam/protocol";

// A tile can be expanded while its restore is still in flight. Share that
// launch with the new view, even before the server reports its PTY as live.
const launches = new WeakMap<AteamApi, Map<string, Promise<string>>>();

async function launchOnce(
	api: AteamApi,
	taskId: string,
	launch: () => Promise<{ terminalId: string }>,
) {
	let pending = launches.get(api);
	if (!pending) {
		pending = new Map();
		launches.set(api, pending);
	}
	const existing = pending.get(taskId);
	if (existing) return existing;
	const result = launch().then((s) => s.terminalId);
	pending.set(taskId, result);
	try {
		return await result;
	} finally {
		pending.delete(taskId);
	}
}

/** Prefer the coding conversation over auxiliary shells, including shells an
 * older mobile client opened in place of restoring the agent. Lists are newest-first. */
export async function resolveTaskPty(
	api: AteamApi,
	task: Pick<TaskDTO, "id" | "agentId">,
	spawnIfNone: boolean,
	cancelled: () => boolean = () => false,
): Promise<string | null> {
	let live = await api.pty.listForTask(task.id);
	const agent = live.find((s) => s.agentId !== "shell");
	if (cancelled()) return null;
	if (agent) return agent.terminalId;

	const restorable = await api.pty.listRestorable(task.id);
	if (cancelled()) return null;
	// A different viewer may have restored it while the history was loading.
	live = await api.pty.listForTask(task.id);
	if (cancelled()) return null;
	const survivor = live.find((s) => s.agentId !== "shell");
	if (survivor) return survivor.terminalId;
	const saved = restorable.find((s) => s.agentId !== "shell");
	if (saved) {
		return launchOnce(api, task.id, () =>
			api.pty.restoreSession({ taskId: task.id, terminalId: saved.terminalId }),
		);
	}
	// A normally exited session has no restorable tab; resume its last conversation.
	if (task.agentId && task.agentId !== "shell") {
		const agentId = task.agentId;
		return launchOnce(api, task.id, () =>
			api.pty.spawnAgent({ taskId: task.id, agentId, resume: true }),
		);
	}
	if (live[0]) return live[0].terminalId;
	if (!spawnIfNone) return null;
	return launchOnce(api, task.id, () => api.pty.spawnShell({ taskId: task.id }));
}
