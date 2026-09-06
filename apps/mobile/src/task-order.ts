import type { KanbanColumn, TaskDTO } from "@ateam/protocol";

export type TaskSort = "status" | "updated";

// Status order: what needs the user's eyes first (mirrors the desktop sidebar).
const STATUS_RANK: Record<KanbanColumn, number> = {
	review: 0,
	needs_attention: 1,
	running: 2,
	todo: 3,
	merged: 4,
};

export function sortTasks(tasks: TaskDTO[], mode: TaskSort): TaskDTO[] {
	const list = [...tasks];
	if (mode === "status") list.sort((a, b) => STATUS_RANK[a.column] - STATUS_RANK[b.column]);
	else list.sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
	return list;
}
