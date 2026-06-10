export type { DiffFile, DiffInput, DiffResult, FileDiffInput } from "./diff";
export { diff, fileDiff } from "./diff";
export type { GitCoreErrorCode } from "./errors";
export { errorMessage, GitCoreError } from "./errors";
export { gitFor, refExists, safeRaw } from "./git-client";
export type {
	DetectMergedResult,
	LocalMainResult,
	LocalMainStrategy,
	MergeResult,
	MergeStrategy,
	MergeViaPRInput,
	PrStatus,
} from "./merge";
export { detectMerged, mergeViaPR, prStatus, updateLocalMain } from "./merge";
export type { GithubRepo, ProjectInfo } from "./project";

export { detectDefaultBranch, initRepository, registerProject } from "./project";
export { SerialQueue } from "./serial-queue";
export type {
	CommitInput,
	PushInput,
	TrackingStatus,
	UpdateFromBaseInput,
	UpdateResult,
} from "./sync";
export { commit, push, trackingStatus, updateFromBase } from "./sync";
export type {
	CreateTaskInput,
	RemoveTaskInput,
	RemoveTaskResult,
	TaskInfo,
} from "./task";
export { createTask, removeTask } from "./task";
export type { GitClient } from "./types";
export { slugify } from "./util";
export type { WorktreeRecord } from "./worktree-list";
export {
	listGitWorktrees,
	normalizeWorktreePath,
	parseWorktreeList,
} from "./worktree-list";
export {
	defaultWorktreesRoot,
	normalizeWorktreeBaseDir,
	safeResolveWorktreePath,
	worktreesRootFor,
} from "./worktree-paths";
