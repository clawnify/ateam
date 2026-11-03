import type { DragEvent } from "react";

// A task dragged out of the Lead chat (a task pill) toward Mission Control,
// which places it on the grid. A drag's payload can't be read until the drop,
// yet Mission Control has to know during the drag whether the task is one it
// can take, so the id also sits here while the drag lasts. One window holds
// one drag at a time.
export const TASK_DRAG_MIME = "application/x-ateam-task";

let dragged: string | null = null;

/** The dragged task's id, when the drag over `e` is a task pill. */
export const draggedTaskId = (e: DragEvent): string | null =>
	e.dataTransfer.types.includes(TASK_DRAG_MIME) ? dragged : null;

/** Makes an element a handle that drags this task; none for no task. */
export function taskDragProps(taskId: string | null | undefined) {
	if (!taskId) return {};
	return {
		draggable: true,
		onDragStart: (e: DragEvent) => {
			dragged = taskId;
			e.dataTransfer.setData(TASK_DRAG_MIME, taskId);
			e.dataTransfer.effectAllowed = "move";
		},
		onDragEnd: () => {
			dragged = null;
		},
	};
}
