import type { BinaryPresence } from "@ateam/agents";
import type { AgentSession, AteamDb, Project, Task } from "@ateam/db";
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

export function toTaskDTO(t: Task, preparing = false): TaskDTO {
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
