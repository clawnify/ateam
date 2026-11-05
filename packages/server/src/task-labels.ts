// A task's title and tags, from its prompt, shortly after its agent launches,
// or from the agent's first reply when the prompt's words cannot name it.
//
// Fire-and-forget from the launch (sessions.ts): the call takes a second or a
// few, and nothing the user is waiting on depends on it, so the card shows the
// prompt's first words and gains its title and tags shortly after.
//
// The title replaces only a name nobody typed (`nameAuto`), and only ONCE. The
// flag is cleared at the attempt, before the model answers and whatever it
// answers: other agents learn task names (list_peers, the Lead's get_board) and
// address them by name, so a name that changed again later would lose them. The
// branch keeps the first words, so a peer still holding them reaches the task
// through the branch's slug (peer-messages.ts resolveTask). The branch and
// worktree are never renamed: either may already be pushed or have a PR.
//
// Some prompts name nothing: a screenshot alone, or "what's going on?" beside
// one. The model never sees attachments (the user gives Ateam's own models no
// images or documents), only that there were some, so it answers "no title yet"
// and `nameAuto` stays set. The one attempt then happens when the agent's first
// turn ends (`labelFromReply`, from the engine's Stop): the agent has read the
// attachments and put them into words, and those words name the task. The
// 3-minute summaries already send the same reply to the same model.
import { describeAttachments, generateTaskLabels, type TaskLabels } from "@ateam/agents";
import { type AteamDb, type NewTask, repo } from "@ateam/db";

export interface LabelDeps {
	db: AteamDb;
	notifyTaskUpdated: (taskId: string) => void;
	/** One text-model call; null when no model is configured. */
	ask: (prompt: string) => Promise<string | null>;
}

export interface LaunchInput {
	/** The files attached to the launch: only their count and kind reach the model. */
	files?: readonly string[];
	/** A resume brings no new words, so a title waiting for a reply keeps waiting. */
	resume?: boolean;
}

/** The labels a launch's prompt gives, or a title held for the agent's first reply. */
export async function labelTask(
	deps: LabelDeps,
	taskId: string,
	launch: LaunchInput = {},
): Promise<void> {
	const { db } = deps;
	const task = repo.getTask(db, taskId);
	if (!task) return;
	const wantTitle = task.nameAuto && !launch.resume;
	// Only the first launch's prompt says what the task is about; later prompts
	// are follow-ups, and a re-tag would fight a label the model already settled.
	const wantTags = !task.tags;
	// No words at all (an image alone, or a pane opened empty): nothing to read
	// yet. `nameAuto` stays set and the agent's first reply names the task.
	const words = task.description?.trim();
	if (!words || (!wantTitle && !wantTags)) return;
	if (wantTitle) repo.updateTask(db, taskId, { nameAuto: false });
	const startedAt = Date.now();
	const labels = await generateTaskLabels(words, {
		knownTags: knownTags(db, task.projectId),
		attachments: describeAttachments(launch.files ?? []),
		run: deps.ask,
	});
	if (!labels) return;
	// Re-read: the task may have been deleted, or tagged by another launch,
	// while the model was thinking.
	const now = repo.getTask(db, taskId);
	if (!now) return;
	const waits = wantTitle && labels.needsReply === true;
	apply(deps, now, labels, { title: wantTitle && !waits, tags: wantTags });
	if (!waits) return;
	repo.updateTask(db, taskId, { nameAuto: true });
	// The first turn may have ended while the model was answering (a quick
	// reply): its Stop found no title waiting, so name the task from it now.
	const reply = now.lastReply?.trim();
	if (reply && (now.lastReplyAt ?? 0) >= startedAt) await labelFromReply(deps, taskId, reply);
}

/**
 * A turn ended with this reply. For a task whose words could not name it, this
 * is the one title attempt (and the tags, if it has none). Any other task is
 * left alone without a call.
 */
export async function labelFromReply(
	deps: LabelDeps,
	taskId: string,
	reply: string,
): Promise<void> {
	const { db } = deps;
	const task = repo.getTask(db, taskId);
	if (!task?.nameAuto || !reply.trim()) return;
	repo.updateTask(db, taskId, { nameAuto: false });
	const wantTags = !task.tags;
	const labels = await generateTaskLabels(task.description ?? "", {
		knownTags: knownTags(db, task.projectId),
		reply,
		run: deps.ask,
	});
	if (!labels) return;
	const now = repo.getTask(db, taskId);
	if (!now) return;
	apply(deps, now, labels, { title: true, tags: wantTags });
}

/**
 * The project's tags so far, to seed the vocabulary: the model reuses an
 * existing label instead of coining a near-synonym.
 */
function knownTags(db: AteamDb, projectId: string): string[] {
	const known = new Set<string>();
	for (const t of repo.listTasks(db, projectId, { includeArchived: true })) {
		for (const tag of t.tags ?? []) known.add(tag);
	}
	return [...known];
}

function apply(
	deps: LabelDeps,
	now: { id: string; tags: string[] | null },
	labels: TaskLabels,
	want: { title: boolean; tags: boolean },
): void {
	const patch: Partial<NewTask> = {};
	if (want.title && labels.title) patch.name = labels.title;
	if (want.tags && !now.tags && labels.tags) patch.tags = labels.tags;
	if (Object.keys(patch).length === 0) return;
	repo.updateTask(deps.db, now.id, patch);
	deps.notifyTaskUpdated(now.id);
}
