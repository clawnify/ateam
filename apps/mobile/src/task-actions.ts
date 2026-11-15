// What a task's swipe offers on Home and the Board (SwipeActions.tsx): Archive
// (or Restore, on an archived one) and Delete. Delete is the desktop's: the
// agent stopped, the worktree and the branch removed, after a confirmation; a
// task with unsaved or unmerged work is refused by its box and asked about again.
import type { AteamApi, TaskDTO } from "@ateam/protocol";
import { Alert } from "react-native";
import type { SwipeAction } from "./SwipeActions";
import { archiveError, needsForce, said } from "./task-refusals";

type Api = Pick<AteamApi, "tasks">;

async function remove(api: Api, task: TaskDTO, gone: (id: string) => void, force = false) {
	try {
		await api.tasks.remove({ id: task.id, deleteBranch: true, ...(force ? { force } : {}) });
		gone(task.id);
	} catch (e) {
		const message = said(e);
		if (force || !needsForce(message)) return Alert.alert("Couldn't delete the task", message);
		Alert.alert(
			"Delete anyway?",
			`"${task.name}" has uncommitted or untracked changes, or a branch that isn't merged. They will be lost.`,
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Delete anyway",
					style: "destructive",
					onPress: () => void remove(api, task, gone, true),
				},
			],
		);
	}
}

/** `gone`: the task left the board (deleted or archived). `changed`: it was
 *  archived or restored, for a list that shows archived tasks. */
export function taskSwipeActions(
	api: Api,
	task: TaskDTO,
	on: { gone: (id: string) => void; changed?: () => void },
): SwipeAction[] {
	const archived = task.archivedAt != null;
	const setArchived = async () => {
		try {
			await api.tasks.setArchived(task.id, !archived);
			if (!archived) on.gone(task.id);
			on.changed?.();
		} catch (e) {
			Alert.alert(
				archived ? "Couldn't restore the task" : "Couldn't archive the task",
				archiveError(said(e)),
			);
		}
	};
	return [
		{
			key: "archive",
			label: archived ? "Restore" : "Archive",
			icon: archived ? "corner-up-left" : "archive",
			hint: archived ? `Restore ${task.name} to the board` : `Archive ${task.name}`,
			onPress: () => void setArchived(),
		},
		{
			key: "delete",
			label: "Delete",
			icon: "trash-2",
			hint: `Delete ${task.name}`,
			danger: true,
			onPress: () =>
				Alert.alert(
					"Delete this task?",
					`"${task.name}": its agent is stopped, and its worktree and branch are removed. This can't be undone.`,
					[
						{ text: "Cancel", style: "cancel" },
						{
							text: "Delete",
							style: "destructive",
							onPress: () => void remove(api, task, on.gone),
						},
					],
				),
		},
	];
}
