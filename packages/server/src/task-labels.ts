// A task's title and tags, from its prompt, shortly after its agent launches.
//
// Fire-and-forget from the launch (sessions.ts): the call takes a second or a
// few, and nothing the user is waiting on depends on it, so the card shows the
// prompt's first words and gains its title and tags shortly after.
//
// The title replaces only a name nobody typed (`nameAuto`), and only ONCE. The
// flag is cleared at the first attempt, before the model answers and whatever it
// answers: other agents learn task names (list_peers, the Lead's get_board) and
// address them by name, so a name that changed later would lose them. The one
// rename happens seconds after launch, and the branch keeps the first words, so
// a peer still holding them reaches the task through the branch's slug
// (peer-messages.ts resolveTask). The branch and worktree are never renamed:
// either may already be pushed or have a PR.
import { generateTaskLabels } from "@ateam/agents";
import { type AteamDb, type NewTask, repo } from "@ateam/db";

export interface LabelDeps {
	db: AteamDb;
	notifyTaskUpdated: (taskId: string) => void;
	/** One text-model call; null when no model is configured. */
	ask: (prompt: string) => Promise<string | null>;
}

export async function labelTask(deps: LabelDeps, taskId: string): Promise<void> {
	const { db } = deps;
	const task = repo.getTask(db, taskId);
	if (!task) return;
	const wantTitle = task.nameAuto;
	if (wantTitle) repo.updateTask(db, taskId, { nameAuto: false });
	// Only the first launch's prompt says what the task is about; later prompts
	// are follow-ups, and a re-tag would fight a label the model already settled.
	const wantTags = !task.tags;
	if (!task.description || (!wantTitle && !wantTags)) return;
	// Seed the vocabulary with what this project already uses, so the model
	// reuses an existing label instead of coining a near-synonym.
	const known = new Set<string>();
	for (const t of repo.listTasks(db, task.projectId, { includeArchived: true })) {
		for (const tag of t.tags ?? []) known.add(tag);
	}
	const labels = await generateTaskLabels(task.description, {
		knownTags: [...known],
		run: deps.ask,
	});
	if (!labels) return;
	// Re-read: the task may have been deleted, or tagged by another launch,
	// while the model was thinking.
	const now = repo.getTask(db, taskId);
	if (!now) return;
	const patch: Partial<NewTask> = {};
	if (wantTitle && labels.title) patch.name = labels.title;
	if (wantTags && !now.tags && labels.tags) patch.tags = labels.tags;
	if (Object.keys(patch).length === 0) return;
	repo.updateTask(db, taskId, patch);
	deps.notifyTaskUpdated(taskId);
}
