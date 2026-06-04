export { GitCoreError, errorMessage } from "./errors";
export type { GitCoreErrorCode } from "./errors";
export { gitFor, safeRaw, refExists } from "./git-client";
export type { GitClient } from "./types";
export {
	defaultWorktreesRoot,
	normalizeWorktreeBaseDir,
	worktreesRootFor,
	safeResolveWorktreePath,
} from "./worktree-paths";
export {
	parseWorktreeList,
	listGitWorktrees,
	normalizeWorktreePath,
} from "./worktree-list";
export type { WorktreeRecord } from "./worktree-list";
export { slugify } from "./util";

export { initRepository, registerProject, detectDefaultBranch } from "./project";
export type { ProjectInfo, GithubRepo } from "./project";

export { createTask, removeTask } from "./task";
export type {
	CreateTaskInput,
	TaskInfo,
	RemoveTaskInput,
	RemoveTaskResult,
} from "./task";

export { commit, push, trackingStatus, updateFromBase } from "./sync";
export type {
	CommitInput,
	PushInput,
	TrackingStatus,
	UpdateFromBaseInput,
	UpdateResult,
} from "./sync";

export { detectMerged, mergeViaPR, updateLocalMain } from "./merge";
export type {
	DetectMergedResult,
	MergeStrategy,
	MergeViaPRInput,
	MergeResult,
	LocalMainResult,
	LocalMainStrategy,
} from "./merge";

export { diff, fileDiff } from "./diff";
export type { DiffFile, DiffResult, DiffInput, FileDiffInput } from "./diff";
