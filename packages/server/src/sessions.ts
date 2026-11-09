// Task creation and terminal launch, shared by RPC, the board MCP and Loops.
// Every agent session uses the same launch path as the composer.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentCommand, getAgent, latestSessionInDir, probeAgentBinary } from "@ateam/agents";
import { repo, type Task } from "@ateam/db";
import { createTask as gitCreateTask, seedWorktree } from "@ateam/git-core";
import {
	BOARD_MCP_TOOLS,
	buildAgentEnv,
	claudeModDir,
	codexBoardMcpArgs,
	codexHookArgs,
	ensureBoardMcpConfig,
	ensureClaudeHooks,
	peerToken,
	removeAteamCodexHooks,
} from "./agent-setup";
import { desktopMcpConfig, taskwindowMcpConfig } from "./browser";
import { codexThreadIsConversation, latestCodexThreadInDir } from "./codex-threads";
import { shell } from "./headless";
import { refreshLoginPath } from "./login-env";
import type { Services } from "./services";
import { labelTask } from "./task-labels";
import { askConfiguredTextModel } from "./text-model";
import { clearWaiting, isFiredWait } from "./waits";

// Defined beside the headless runner, which needs it too; re-exported for the
// callers that already import it from here.
export { shell };

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

/** Open a login shell in a task's worktree and announce its new tab. */
export function spawnShellInTask(
	services: Services,
	notifyTaskUpdated: (taskId: string) => void,
	task: Pick<Task, "id" | "worktreePath">,
): { terminalId: string } {
	services.worktreeGuard.assertWritable(task.id);
	const terminalId = randomUUID();
	repo.createSession(services.db, {
		taskId: task.id,
		agentId: "shell",
		terminalId,
		cwd: task.worktreePath,
	});
	services.pty.spawn({
		terminalId,
		shell,
		args: ["-l"],
		cwd: task.worktreePath,
		env: { ...process.env },
	});
	notifyTaskUpdated(task.id);
	return { terminalId };
}

// Reserve capacity while launches await their CLI/config, before their tabs appear.
const creatingSessions = new WeakMap<Services, Map<string, number>>();
export const MAX_MCP_SESSIONS = 10;

/** The board MCP may open tabs only in its live caller's own task. */
export async function createSessionInCallerTask(
	services: Services,
	notifyTaskUpdated: (taskId: string) => void,
	input: { callerTerminalId: string; agent: string; prompt?: string },
): Promise<{ taskId: string; terminalId: string; agent: string }> {
	const caller = repo.getSessionByTerminal(services.db, input.callerTerminalId);
	if (
		!caller ||
		caller.agentId === "shell" ||
		caller.status === "stopped" ||
		caller.exitedAt != null ||
		!services.pty.has(caller.terminalId)
	) {
		throw new Error("only a live agent working in a task can create a session");
	}
	const task = repo.getTask(services.db, caller.taskId);
	if (!task) throw new Error("the calling session's task no longer exists");
	if (task.archivedAt != null) throw new Error("cannot create a session in an archived task");

	let pending = creatingSessions.get(services);
	if (!pending) {
		pending = new Map();
		creatingSessions.set(services, pending);
	}
	const count = pending.get(task.id) ?? 0;
	const sessions = repo.listSessionsByTask(services.db, task.id);
	const live = sessions.filter((s) => services.pty.has(s.terminalId)).length;
	const recent = sessions.filter((s) => (s.startedAt ?? 0) >= Date.now() - 60_000).length;
	if (Math.max(live, recent) + count >= MAX_MCP_SESSIONS) {
		throw new Error(
			`session limit: at most ${MAX_MCP_SESSIONS} live sessions or session starts per minute in this task`,
		);
	}
	pending.set(task.id, count + 1);
	try {
		const result =
			input.agent === "shell"
				? spawnShellInTask(services, notifyTaskUpdated, task)
				: await spawnAgentInTask(services, notifyTaskUpdated, {
						taskId: task.id,
						agentId: input.agent,
						prompt: input.prompt,
					});
		return { taskId: task.id, terminalId: result.terminalId, agent: input.agent };
	} finally {
		const left = (pending.get(task.id) ?? 1) - 1;
		if (left) pending.set(task.id, left);
		else pending.delete(task.id);
	}
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
		/** Nobody typed `name`, so the model's title may replace it once (task-labels.ts). */
		nameAuto?: boolean;
	},
	issue?: { url: string; description: string },
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
		// An issue's task is named after the issue: a name someone chose.
		nameAuto: Boolean(input.nameAuto) && !issue,
		issueUrl: issue?.url ?? null,
		description: issue?.description ?? null,
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
		signal: services.worktreeGuard.seedSignal(row.id),
	})
		.catch(() => {})
		.finally(() => {
			services.pendingSeeds.delete(row.id);
			services.worktreeGuard.seedDone(row.id);
		});
	services.pendingSeeds.set(row.id, seeding);
	return row;
}

/**
 * Resumes under way, per engine, by task and agent. Two callers can decide to
 * bring the same conversation back in the same instant: the peer messenger
 * relaunching an agent to hand it a message, and a client auto-restoring the
 * tab that agent just left (or two windows, or the desktop and the phone).
 * Each one checks for a live terminal first, but a launch spends its first
 * ~200ms in probes before it spawns one, so both checks pass and two agent
 * processes end up on one transcript and one worktree.
 *
 * Keyed by task and agent rather than by conversation, because a resume does
 * not always know its conversation when it is asked for: `resume: true` (an
 * agent that names its own conversations, Codex or OpenCode, before Ateam has
 * heard the id) only learns it from a scan, after an await. So the resumes of
 * one task's agent take turns, and each one, once it knows its conversation,
 * hands back the tab already holding it (liveTabOn). Two resumes of different
 * conversations in one task only wait for each other, which costs the second
 * one the first one's probes. Every probe a launch makes has a timeout
 * (login-env, the agents registry), so a turn always ends.
 *
 * Keyed per engine (a WeakMap on its services) rather than on the Services
 * type, the same way the phone keys its own in-flight launches.
 */
const resuming = new WeakMap<Services, Map<string, Promise<unknown>>>();

const resumeKey = (taskId: string, agentId: string) => `${taskId}\u0000${agentId}`;

/**
 * A resume that carries work found its conversation already open, or coming
 * back in a launch ahead of it.
 */
export class ResumeInFlightError extends Error {
	constructor(conversationId: string) {
		super(
			`conversation ${conversationId} is already open or being resumed; what was meant for it waits for that tab`,
		);
		this.name = "ResumeInFlightError";
	}
}

/** Settles once every resume of this task's agent already under way has. */
export function resumesSettled(services: Services, taskId: string, agentId: string): Promise<void> {
	const last = resuming.get(services)?.get(resumeKey(taskId, agentId));
	return last ? last.then(noop, noop) : Promise.resolve();
}

const noop = () => {};

/**
 * The tab already holding this conversation: a live terminal whose agent has
 * not quit (an agent that quits leaves its pane alive as a shell, `stopped`).
 */
export function liveTabOn(
	services: Services,
	taskId: string,
	conversationId: string,
): { terminalId: string } | undefined {
	const open = repo
		.listSessionsByTask(services.db, taskId)
		.find(
			(s) =>
				s.agentSessionId === conversationId &&
				s.exitedAt == null &&
				s.status !== "stopped" &&
				services.pty.has(s.terminalId),
		);
	return open ? { terminalId: open.terminalId } : undefined;
}

/**
 * An event a Codex tab reported for one of Codex's side threads rather than
 * its conversation: its turn-end `notify` fires for the terminal-title writer,
 * the Guardian reviewer and subagents too, with nothing but the thread id to
 * tell them apart (codexThreadIsConversation). Taken as the tab's own, it would
 * end the card's turn while the agent is still working, let the peer messenger
 * restart it mid-turn, and name the tab after the side thread. Only an id that
 * is not the tab's own conversation is looked up.
 */
export function isCodexSideThreadEvent(
	session: { agentId: string; agentSessionId: string | null },
	reportedId: string | undefined,
	isConversation: (id: string) => boolean | null = codexThreadIsConversation,
): boolean {
	if (session.agentId !== "codex" || !reportedId) return false;
	if (reportedId === session.agentSessionId) return false;
	return isConversation(reportedId) === false;
}

/**
 * Record the conversation an agent says its tab holds, when Ateam could not
 * name it at launch: a harness that names its own (Codex), launched fresh, has
 * no id until its hooks report one, and Codex's first report is its first
 * turn's end. With the id on the row, a restart or a restored tab resumes it by
 * id, and two of them at once meet in spawnAgentInTask instead of putting two
 * agents on it. Never over an id already there: Ateam minted it, or a resume
 * picked it.
 */
export function adoptReportedConversation(
	db: Services["db"],
	session: { id: string; agentId: string; agentSessionId: string | null },
	reportedId: string | undefined,
): void {
	if (!reportedId || session.agentSessionId) return;
	if (getAgent(session.agentId)?.sessionIdFlag) return;
	repo.updateSession(db, session.id, { agentSessionId: reportedId });
}

/**
 * Launch a coding agent in a task's worktree and record the session.
 *
 * A resume never puts a second agent on a conversation that already has one.
 * Resumes of one task's agent run one after another (see `resuming`), and each
 * one checks for a tab already holding its conversation once it knows which
 * conversation that is. Without work of its own (a restored tab) it gets that
 * tab back. With work (a prompt or files) it is refused with
 * ResumeInFlightError rather than silently dropping the work: the peer
 * messenger leaves its messages pending, and that tab's listener takes them,
 * or the messenger's next sweep restarts it with them. Queued before anything
 * is awaited, which is the whole point.
 */
export function spawnAgentInTask(
	services: Services,
	notifyTaskUpdated: (taskId: string) => void,
	input: SpawnAgentInput,
): Promise<{ terminalId: string }> {
	// Tracked, so deleting the task waits for a launch already under way instead
	// of racing it (see worktree-guard.ts).
	const launch = () =>
		services.worktreeGuard.launch(input.taskId, () =>
			launchAgent(services, notifyTaskUpdated, input),
		);
	// A fresh launch starts a conversation of its own: nothing to collide with.
	if (!input.resume && !input.resumeSessionId) return launch();
	let queues = resuming.get(services);
	if (!queues) {
		queues = new Map();
		resuming.set(services, queues);
	}
	const key = resumeKey(input.taskId, input.agentId);
	const ahead = queues.get(key);
	const started = ahead ? ahead.then(launch, launch) : launch();
	queues.set(key, started);
	const settle = () => {
		if (queues.get(key) === started) queues.delete(key);
	};
	started.then(settle, settle);
	return started;
}

async function launchAgent(
	services: Services,
	notifyTaskUpdated: (taskId: string) => void,
	input: SpawnAgentInput,
): Promise<{ terminalId: string }> {
	const task = repo.getTask(services.db, input.taskId);
	if (!task) throw new Error(`Task not found: ${input.taskId}`);
	const agent = getAgent(input.agentId);
	if (!agent) throw new Error(`Unknown agent: ${input.agentId}`);

	// The agent's CLI must exist on THIS machine before anything is written
	// down. Without this the launch line (`<agent>; exec $SHELL -l` below) turns
	// a missing binary into one line of shell output inside a pane that then
	// sits there looking healthy: the card is filed `running`, a loop tick
	// reports `run N started`, and nothing anywhere says the agent never ran.
	// The check belongs HERE, ahead of the session row and the hooks, because
	// this is the one path every launch takes — composer, relaunch, restored
	// tab, phone, loop tick.
	//
	// A toolchain is not static: this fires for an agent that was installed
	// yesterday and is gone today (a reboot, an uninstall, a PATH that moved),
	// which no availability list captured at connect time can catch.
	//
	// Only a definite "absent" refuses. An unanswerable probe spawns anyway:
	// blocking work on a shell that failed to reply would be a worse bug than
	// the one this prevents.
	const probe = services.probeAgent ?? ((bin: string) => probeAgentBinary(bin, shell));
	const refresh = services.refreshPath ?? (() => refreshLoginPath({ db: services.db }));
	let presence = await probe(agent.bin);
	if (presence === "absent") {
		// Before refusing, consider that this process's PATH is a snapshot taken
		// when the engine started (login-env.ts). An agent installed since then is
		// invisible to it, and a loop tick is exactly the caller that never opens
		// the picker that would otherwise have re-resolved it. Re-resolve, and
		// only re-probe if the PATH actually moved — rate-limited inside, so a
		// genuinely missing agent doesn't pay for a login shell on every attempt.
		if (await refresh()) presence = await probe(agent.bin);
	}
	if (presence === "absent") {
		const install = agent.install ? ` Install it with: ${agent.install}` : "";
		throw new Error(
			`${agent.label} isn't installed here — \`${agent.bin}\` is not on PATH.${install}`,
		);
	}

	// Deliberately NOT awaiting services.pendingSeeds here. Dependencies land
	// under the agent while it works: seedNodeModules stages each tree outside
	// the worktree and renames it in, so the worktree only ever shows an absent
	// or a complete `node_modules`, never a half-copied one. That was the whole
	// reason to block, and blocking cost ~25s of dead time before the terminal
	// even appeared on a large monorepo. The card reports `preparing` while the
	// copy is in flight, so the wait is visible instead of mysterious.

	// "Resume the last conversation" is only ever aimed at THIS task, but not
	// every CLI reads it that way. Claude files its transcripts by cwd, so
	// `--continue` is already worktree-scoped; OpenCode files them by PROJECT
	// and counts every git worktree of a repo as one project, so its
	// `--continue` returns the newest conversation in ANY of them — reliably a
	// sibling task's, since the newest one in this repo is whichever task ran
	// last. That is a resume landing in the wrong branch's transcript, in a pane
	// cd'd into the right one. Codex's `resume --last` reaches across worktrees
	// the same way (codex-threads.ts). So for those CLIs the id is picked here,
	// from the conversations that actually belong to this worktree.
	//
	// A scan that could not run (`ok: false`) falls through to `--continue`: an
	// imperfect resume beats silently starting a new conversation over one the
	// user asked to come back to. A scan that ran and found nothing means this
	// worktree has no conversation yet, so a fresh launch is the honest answer.
	let resumeSessionId = input.resumeSessionId;
	let resumeNewest = Boolean(input.resume);
	const scopesResume = Boolean(agent.sessionListArgs) || agent.id === "codex";
	if (resumeNewest && !resumeSessionId && scopesResume) {
		const scan = services.latestSession
			? await services.latestSession(agent, task.worktreePath)
			: agent.id === "codex"
				? latestCodexThreadInDir(task.worktreePath)
				: await latestSessionInDir(agent, task.worktreePath, shell);
		if (scan.ok) {
			resumeSessionId = scan.id ?? undefined;
			resumeNewest = false;
		}
	}

	// A resume normally carries no prompt; one woken by a peer message does
	// (peer-messages.ts), and that is work starting like any fresh launch.
	const hasWork = Boolean(input.prompt?.trim() || input.files?.length);

	// The conversation is known now, however it was asked for, and every resume
	// of this agent ahead of this one has finished (spawnAgentInTask): one of
	// them may already have brought it back.
	if (resumeSessionId) {
		const open = liveTabOn(services, task.id, resumeSessionId);
		if (open) {
			if (hasWork) throw new ResumeInFlightError(resumeSessionId);
			return open;
		}
	}

	// A delete may have begun during the probes above; it is waiting on this
	// launch, so stop before writing anything rather than start an agent it
	// would kill a moment later.
	services.worktreeGuard.assertWritable(task.id);

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
	const agentSessionId = resumeSessionId ?? (mintsId ? terminalId : null);
	const isResume = Boolean(input.resume || input.resumeSessionId);
	repo.createSession(services.db, {
		taskId: task.id,
		agentId: agent.id,
		terminalId,
		agentSessionId,
		cwd: task.worktreePath,
		// A launch with something to do is work from the moment it spawns, which is
		// what lets its box stay awake for it (isWorking). A resume, or a pane with
		// nothing to do, sits idle at the prompt until someone types.
		status: hasWork ? "running" : "idle",
	});
	// The tab this one is picking up is no longer waiting to be restored.
	if (resumeSessionId) {
		for (const prior of repo.listRestorableSessions(services.db, task.id)) {
			if (prior.agentSessionId === resumeSessionId) {
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
	if (input.prompt?.trim() && !task.description && !isResume) {
		repo.updateTask(services.db, task.id, { description: input.prompt.trim() });
	}

	if (agent.id === "claude") {
		await ensureClaudeHooks(task.worktreePath, services.notifyScriptPath);
	} else if (agent.id === "codex") {
		// Its hooks ride the launch line now (codexHookArgs below).
		await removeAteamCodexHooks(task.worktreePath);
	}

	// A fresh launch on a task whose wait already resurfaced means someone is
	// acting on it again, so that wait is over. A pending wait survives, and so
	// does any wait across a resume: opening a stopped task auto-resumes it, and
	// looking is not acting. See waits.ts.
	const freshLaunch = !input.resume && !input.resumeSessionId && !input.agentMode;
	if (freshLaunch && isFiredWait(task) && clearWaiting(services.db, task)) {
		notifyTaskUpdated(task.id);
	}

	const token = peerToken(services.peerSecret, terminalId);
	const desktop = desktopMcpConfig(services.userDataDir);
	const taskwindow = taskwindowMcpConfig(services.userDataDir);
	const env = buildAgentEnv({
		desktop,
		taskwindow,
		terminalId,
		agentId: agent.id,
		hookPort: services.hookPort,
		hooksDir: services.hooksDir,
		token,
	});
	// Run the agent in a login shell, then drop to an interactive shell so
	// the pane stays usable after the agent exits. Auto appends the agent's
	// automatic-mode flag; resume relaunches its most recent conversation here.
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
		resume: resumeNewest,
		agentMode: input.agentMode,
		cwd: task.worktreePath,
		prompt,
		sessionId: agentSessionId ?? undefined,
		resumeSessionId,
	});
	if (agent.id === "codex") {
		// `notify` invokes a program with a JSON payload on turn completion; our
		// script maps it to Stop. It runs whether or not the user has approved
		// the hooks (codexHookArgs), so a turn's end is never missed. Injected
		// per-launch via -c so the user's ~/.codex/config.toml is untouched.
		const codexNotify = join(services.hooksDir, "codex-notify.sh");
		// The board MCP server and the hooks ride the same way.
		agentCmd = agentCmd.replace(
			/^codex/,
			`codex -c 'notify=["sh","${codexNotify}"]' ${codexHookArgs(services.notifyScriptPath)} ${codexBoardMcpArgs(services.hookPort, desktop, taskwindow)}`,
		);
	} else if (agent.id === "claude" && !input.agentMode) {
		// The board tools (get_board / set_status / set_waiting), served by the
		// hook server and keyed to this terminal so the session can only touch
		// its own card. Pre-allowed: they are guarded server-side, so a
		// permission prompt would only add noise. Both flags are variadic
		// (`<configs...>`, `<tools...>`) and would swallow a positional prompt
		// that followed them, so they go AFTER everything agentCommand built.
		const mcpConfig = await ensureBoardMcpConfig({
			desktop,
			taskwindow,
			hooksDir: services.hooksDir,
			hookPort: services.hookPort,
			terminalId,
			token,
		});
		const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
		// Ateam's Claude mod, which brings the user's own words in as their prompt
		// (agent-setup, peer-messages.ts). One path per flag, so it swallows
		// nothing; a Claude Code without mods (before 2.1.287, or mods turned off)
		// loads nothing, and those words go in by a restart instead.
		agentCmd = `${agentCmd} --plugin-dir ${sq(claudeModDir(services.hooksDir))} --mcp-config ${sq(mcpConfig)} --allowedTools ${sq(BOARD_MCP_TOOLS.join(","))}`;
	}
	// The pane outlives the agent (the `exec` keeps it usable as a shell), so the
	// agent's own exit is otherwise invisible: no PTY exit fires, and the session
	// would claim running / awaiting_input for as long as the shell stays open.
	// One more call to the same notify script says it quit (pty/agent-quit.ts,
	// AgentExit). Quoted: on macOS the script lives under "Application Support".
	const notify = `'${services.notifyScriptPath.replace(/'/g, `'\\''`)}'`;
	const command = `${agentCmd}; sh ${notify} AgentExit; exec ${shell} -l`;
	// Watch for the board tools reaching it (board-connections.ts), from before
	// the agent can possibly connect. Agent mode carries none by design.
	if (!(agent.id === "claude" && input.agentMode)) {
		services.boardConnections?.launched(terminalId, task.id, agent.id);
	}
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
	repo.updateTask(services.db, task.id, {
		...(isResume && !hasWork ? {} : { column: "running", agentStatus: "running" }),
		agentId: agent.id,
	});
	notifyTaskUpdated(task.id);
	void labelTask(
		{
			db: services.db,
			notifyTaskUpdated,
			ask: (prompt) => askConfiguredTextModel(prompt, { maxTokens: 120, timeoutMs: 30_000 }),
		},
		task.id,
		{ files: input.files, resume: isResume },
	);
	return { terminalId };
}
