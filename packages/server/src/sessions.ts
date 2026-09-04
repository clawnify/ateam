// Task creation + agent launch, shared by the RPC dispatcher (composer, board)
// and the Loops runner — a loop tick starts an agent session through the exact
// same path as typing a prompt in the composer. Lifted verbatim from the
// dispatcher's tasksCreate / ptySpawnAgent handlers.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentCommand, generateTaskTags, getAgent } from "@ateam/agents";
import { repo, type Task } from "@ateam/db";
import { createTask as gitCreateTask, seedWorktree } from "@ateam/git-core";
import { buildAgentEnv, ensureClaudeHooks, ensureCodexHooks } from "./agent-setup";
import type { Services } from "./services";

export const shell = process.env.SHELL || "/bin/zsh";

export interface SpawnAgentInput {
	taskId: string;
	agentId: string;
	yolo?: boolean;
	resume?: boolean;
	agentMode?: boolean;
	prompt?: string;
	files?: string[];
	/**
	 * Pick THIS conversation back up rather than starting a new one — the handle
	 * a restored tab carries (`agent_sessions.agent_session_id`). Beats `resume`,
	 * which can only ever reach the newest conversation in the worktree.
	 */
	resumeSessionId?: string;
	/**
	 * One extra turn to take right after the first response, delivered through
	 * the agent's own turn-end hook (see `follow-ups.ts`). A slash command and a
	 * plain sentence are both just text here.
	 */
	followUp?: string;
}

/** Create a task (branch + worktree + row) in a project and announce it. */
export async function createTaskInProject(
	services: Services,
	notifyTaskUpdated: (taskId: string) => void,
	input: {
		projectId: string;
		name: string;
		baseBranch?: string;
		/**
		 * The agent the composer already chose. Recorded with the row rather than
		 * waiting for the launch to write it: the card renders `agentId ? agent
		 * icon : icon-guessed-from-the-name`, and spawnAgentInTask only sets it
		 * after the worktree finishes seeding. That gap used to be invisible
		 * because the card itself did not exist until then; now the card comes
		 * first, so leaving this null shows a keyword icon (Sparkles for a name
		 * containing "add"/"new"/"create", GitBranch otherwise) that visibly
		 * flips to the agent's icon later. The choice is known here, so there is
		 * nothing to guess.
		 */
		agentId?: string;
	},
): Promise<Task> {
	const project = repo.getProject(services.db, input.projectId);
	if (!project) throw new Error(`Project not found: ${input.projectId}`);
	const created = await gitCreateTask({
		repoPath: project.repoPath,
		name: input.name,
		baseBranch: input.baseBranch ?? project.defaultBranch ?? undefined,
		worktreesRoot: project.worktreesRoot ?? undefined,
	});
	const row = repo.createTask(services.db, {
		projectId: project.id,
		name: input.name,
		slug: created.slug,
		branch: created.branch,
		baseBranch: created.baseBranch,
		worktreePath: created.worktreePath,
		agentId: input.agentId ?? null,
	});
	// Broadcast so any other window showing this project gains the new card
	// (renderers upsert). The caller also gets it — an idempotent upsert.
	notifyTaskUpdated(row.id);
	// Only NOW carry the gitignored state across. It is by far the slowest part
	// of making a task (~52s against ~2s for the worktree itself on a large
	// monorepo), and nothing above needs it, so blocking the row on it bought
	// nothing and cost the user every signal that their click had registered.
	// The promise is parked for `spawnAgentInTask` to await; failures are
	// already swallowed inside seedWorktree, and the catch here only keeps a
	// rejection from escaping as unhandled.
	const seeding = seedWorktree({
		repoPath: project.repoPath,
		worktreePath: created.worktreePath,
	})
		.catch(() => {})
		.finally(() => services.pendingSeeds.delete(row.id));
	services.pendingSeeds.set(row.id, seeding);
	return row;
}

/** Launch a coding agent in a task's worktree and record the session. */
export async function spawnAgentInTask(
	services: Services,
	notifyTaskUpdated: (taskId: string) => void,
	input: SpawnAgentInput,
): Promise<{ terminalId: string }> {
	const task = repo.getTask(services.db, input.taskId);
	if (!task) throw new Error(`Task not found: ${input.taskId}`);
	const agent = getAgent(input.agentId);
	if (!agent) throw new Error(`Unknown agent: ${input.agentId}`);

	// Deliberately NOT awaiting services.pendingSeeds here. Dependencies land
	// under the agent while it works: seedNodeModules stages each tree outside
	// the worktree and renames it in, so the worktree only ever shows an absent
	// or a complete `node_modules`, never a half-copied one. That was the whole
	// reason to block, and blocking cost ~25s of dead time before the terminal
	// even appeared on a large monorepo. The card reports `preparing` while the
	// copy is in flight, so the wait is visible instead of mysterious.

	const terminalId = randomUUID();
	// The conversation this tab holds. On a fresh launch we mint it — the
	// terminal id doubles as the agent's session id, so the tab can be resumed
	// by name later. A restore carries the id it was handed: the PTY is new, the
	// conversation is the same one.
	//
	// Null when we genuinely cannot know it: a harness that mints its own id, a
	// `--continue` (which lands on whatever conversation the worktree saw last),
	// or agent mode (a board, not a conversation). Recording the terminal id
	// there would be a lie the restore then acts on.
	const mintsId = Boolean(agent.sessionIdFlag) && !input.resume && !input.agentMode;
	const agentSessionId = input.resumeSessionId ?? (mintsId ? terminalId : null);
	repo.createSession(services.db, {
		taskId: task.id,
		agentId: agent.id,
		terminalId,
		agentSessionId,
		cwd: task.worktreePath,
	});
	// The tab this one is picking up is no longer waiting to be restored.
	if (input.resumeSessionId) {
		for (const prior of repo.listRestorableSessions(services.db, task.id)) {
			if (prior.agentSessionId === input.resumeSessionId) {
				repo.updateSession(services.db, prior.id, { exitReason: "restored" });
			}
		}
	}

	// Keep the prompt that started this task. It is the only full-sentence record
	// of intent anywhere: `name` is a slug of its first six words, and the column
	// it goes in was previously written by nothing, so every task in the db has a
	// null description and the search-by-description path could never match. Only
	// the FIRST launch writes it — later prompts are follow-ups in a conversation,
	// not what the task is about — and a resume carries no prompt at all.
	if (input.prompt?.trim() && !task.description) {
		repo.updateTask(services.db, task.id, { description: input.prompt.trim() });
	}

	if (agent.id === "claude") {
		await ensureClaudeHooks(task.worktreePath, services.notifyScriptPath);
	} else if (agent.id === "codex") {
		await ensureCodexHooks(task.worktreePath, services.notifyScriptPath);
	}

	const env = buildAgentEnv({
		terminalId,
		agentId: agent.id,
		hookPort: services.hookPort,
		hooksDir: services.hooksDir,
	});
	// Run the agent in a login shell, then drop to an interactive shell so
	// the pane stays usable after the agent exits. YOLO appends the bypass
	// flag; resume relaunches the agent's most recent conversation here.
	// Attached files ride along in the prompt as absolute paths under a
	// header — the agent reads them with its own Read tool (nothing is
	// copied into the worktree). Skip on resume, which ignores the prompt.
	let prompt = input.prompt;
	if (input.files?.length) {
		const list = input.files.map((f) => `- ${f}`).join("\n");
		prompt = prompt ? `${prompt}\n\nAttached files:\n${list}` : `Attached files:\n${list}`;
	}
	let agentCmd = agentCommand(agent, {
		yolo: input.yolo,
		resume: input.resume,
		agentMode: input.agentMode,
		cwd: task.worktreePath,
		prompt,
		sessionId: agentSessionId ?? undefined,
		resumeSessionId: input.resumeSessionId,
	});
	if (agent.id === "codex") {
		// Codex has no hooks, but `notify` invokes a program with a JSON
		// payload on turn completion — our script maps it to Stop. Injected
		// per-launch via -c so the user's ~/.codex/config.toml is untouched.
		const codexNotify = join(services.hooksDir, "codex-notify.sh");
		agentCmd = agentCmd.replace(/^codex/, `codex -c 'notify=["sh","${codexNotify}"]'`);
	}
	const command = `${agentCmd}; exec ${shell} -l`;
	services.pty.spawn({
		terminalId,
		shell,
		args: ["-l", "-c", command],
		cwd: task.worktreePath,
		env,
	});

	// Arm before the first turn can possibly end. The entry is consumed by the
	// turn-end hook, or dropped if the pane dies first.
	services.followUps.arm(terminalId, input.followUp);

	// A resume is not activity. It brings a conversation back to an idle
	// prompt: nothing runs until the user types (UserPromptSubmit → UserReply
	// moves the card then). Opening a stopped task auto-resumes it, so writing
	// "running" here would file every task you merely looked at as in-flight,
	// and the stall rule would later demote it as silent work. Leave the card
	// where it was; only a launch that carries a prompt is work starting.
	const isResume = Boolean(input.resume || input.resumeSessionId);
	repo.updateTask(services.db, task.id, {
		...(isResume ? {} : { column: "running", agentStatus: "running" }),
		agentId: agent.id,
	});
	notifyTaskUpdated(task.id);
	void tagTaskInBackground(services, notifyTaskUpdated, task.id);
	return { terminalId };
}

/**
 * Label the task from its prompt, after the agent is already running.
 *
 * Deliberately fire-and-forget: the call takes a few seconds, and nothing the
 * user is waiting on depends on it, so the card simply gains chips shortly
 * after it appears. Only the first launch tags (later prompts are follow-ups,
 * and a re-tag would fight a label the model already settled on), and a null
 * result leaves `tags` unset so the client keeps its keyword fallback.
 */
async function tagTaskInBackground(
	services: Services,
	notifyTaskUpdated: (taskId: string) => void,
	taskId: string,
): Promise<void> {
	const task = repo.getTask(services.db, taskId);
	if (!task?.description || task.tags) return;
	// Seed the vocabulary with what this project already uses, so the model
	// reuses an existing label instead of coining a near-synonym.
	const known = new Set<string>();
	for (const t of repo.listTasks(services.db, task.projectId)) {
		for (const tag of t.tags ?? []) known.add(tag);
	}
	const tags = await generateTaskTags(task.description, { knownTags: [...known] });
	if (!tags) return;
	// Re-read: the task may have been deleted while the model was thinking.
	if (!repo.getTask(services.db, taskId)) return;
	repo.updateTask(services.db, taskId, { tags });
	notifyTaskUpdated(taskId);
}
