import type { AgentDefinition, BinaryPresence, SessionScan } from "@ateam/agents";
import { type AgentSession, type AteamDb, type Project, repo, type Task } from "@ateam/db";
import type { ProjectDTO, SessionDTO, TaskDTO } from "@ateam/protocol";
import type { FollowUps } from "./follow-ups";
import type { HookServer } from "./hooks/hook-server";
import type { LoopRunner } from "./loops/runner";
import type { MergeQueue } from "./merge-queue";
import type { PtyClient } from "./pty/pty-client";
import { triageTask } from "./task-triage";

export interface Services {
	db: AteamDb;
	pty: PtyClient;
	hooks: HookServer;
	userDataDir: string;
	hooksDir: string;
	notifyScriptPath: string;
	hookPort: number;
	mergeQueue: MergeQueue;
	loopRunner: LoopRunner;
	/** One-shot follow-up turns, armed at launch and consumed at turn end. */
	followUps: FollowUps;
	/**
	 * Does this machine have an agent's CLI? Asked before every launch, so it is
	 * a seam for the same reason `pty` is: the real one shells out, and a test
	 * would otherwise be asserting which agents happen to be installed on the
	 * machine running it (a CI runner has none). Defaults to the real probe.
	 */
	probeAgent?: (bin: string) => Promise<BinaryPresence>;
	/**
	 * Re-resolve this machine's login PATH, adopting it if it moved; resolves to
	 * whether it changed. A seam for the same reason `probeAgent` is: the real
	 * one runs an interactive login shell. Defaults to the real refresh.
	 */
	refreshPath?: (opts?: { force?: boolean }) => Promise<boolean>;
	/**
	 * The newest conversation an agent holds for a directory, asked before a
	 * resume that would otherwise reach outside it (`latestSessionInDir`). A
	 * seam for the same reason the two above are: the real one shells out to the
	 * agent's CLI. Defaults to the real scan.
	 */
	latestSession?: (agent: AgentDefinition, cwd: string) => Promise<SessionScan>;
	/**
	 * In-flight `seedWorktree` calls by task id. A task's row is created (and its
	 * card announced) as soon as the worktree exists, so its dependencies are
	 * still landing for up to a minute afterwards; anything that needs them —
	 * launching an agent — awaits the entry here. Absent means nothing pending,
	 * so `await map.get(id)` is the whole protocol.
	 */
	pendingSeeds: Map<string, Promise<void>>;
}

export function toProjectDTO(p: Project): ProjectDTO {
	return {
		id: p.id,
		repoPath: p.repoPath,
		name: p.name,
		defaultBranch: p.defaultBranch ?? null,
		githubOwner: p.githubOwner ?? null,
		githubName: p.githubName ?? null,
		color: p.color ?? null,
	};
}

/**
 * The agent behind each of a task's live sessions, oldest first: TaskDTO.agentIds.
 * Liveness is the daemon's word (`pty.has`), never the session row's status —
 * the same rule pty:listForTask follows, so the glyphs a card shows are exactly
 * the tabs its panel would open.
 */
export function liveAgentIds(
	db: AteamDb,
	pty: { has(terminalId: string): boolean },
	taskId: string,
): string[] {
	return repo
		.listSessionsByTask(db, taskId)
		.filter((s) => pty.has(s.terminalId))
		.map((s) => s.agentId)
		.reverse();
}

export function toTaskDTO(t: Task, preparing = false, agentIds: string[] = []): TaskDTO {
	return {
		id: t.id,
		projectId: t.projectId,
		name: t.name,
		description: t.description ?? null,
		slug: t.slug,
		branch: t.branch,
		baseBranch: t.baseBranch,
		worktreePath: t.worktreePath,
		column: t.column,
		agentStatus: t.agentStatus ?? null,
		agentId: t.agentId ?? null,
		agentIds,
		mergeStatus: t.mergeStatus ?? null,
		prNumber: t.prNumber ?? null,
		prUrl: t.prUrl ?? null,
		prState: t.prState ?? null,
		gitStatus: t.gitStatus ?? null,
		lastEventAt: t.lastEventAt ?? t.updatedAt ?? null,
		isUnread: Boolean(t.isUnread),
		preparing,
		tags: t.tags ?? null,
		triage: triageTask(t),
	};
}

export function toSessionDTO(s: AgentSession): SessionDTO {
	return {
		id: s.id,
		taskId: s.taskId,
		agentId: s.agentId,
		terminalId: s.terminalId,
		agentSessionId: s.agentSessionId ?? null,
		status: s.status,
		cwd: s.cwd,
		lastEventAt: s.lastEventAt ?? null,
	};
}
