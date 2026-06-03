import type {
	AgentSession,
	GroveDb,
	Project,
	Task,
} from "@ateam/db";
import type { HookServer } from "./hooks/hook-server";
import type { PtyClient } from "./pty/pty-client";
import type {
	ProjectDTO,
	SessionDTO,
	TaskDTO,
} from "../shared/types";

export interface Services {
	db: GroveDb;
	pty: PtyClient;
	hooks: HookServer;
	userDataDir: string;
	hooksDir: string;
	notifyScriptPath: string;
	hookPort: number;
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

export function toTaskDTO(t: Task): TaskDTO {
	return {
		id: t.id,
		projectId: t.projectId,
		name: t.name,
		slug: t.slug,
		branch: t.branch,
		baseBranch: t.baseBranch,
		worktreePath: t.worktreePath,
		column: t.column,
		agentStatus: t.agentStatus ?? null,
		agentId: t.agentId ?? null,
		prNumber: t.prNumber ?? null,
		prUrl: t.prUrl ?? null,
		gitStatus: t.gitStatus ?? null,
		isUnread: Boolean(t.isUnread),
	};
}

export function toSessionDTO(s: AgentSession): SessionDTO {
	return {
		id: s.id,
		taskId: s.taskId,
		agentId: s.agentId,
		terminalId: s.terminalId,
		status: s.status,
		cwd: s.cwd,
	};
}
