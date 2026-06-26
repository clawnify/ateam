import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { agentCommand, getAgent, listAgents } from "@ateam/agents";
import { repo } from "@ateam/db";
import {
	commit,
	detectMerged,
	diff,
	errorMessage,
	fileDiff,
	createTask as gitCreateTask,
	gitFor,
	removeTask as gitRemoveTask,
	initRepository,
	push,
	registerProject,
	trackingStatus,
	updateFromBase,
} from "@ateam/git-core";
import { clipboard, dialog, ipcMain, nativeImage } from "electron";
import {
	CH,
	type CreateLoopInput,
	type GitStatusSnapshot,
	type KanbanColumn,
	type MergeStrategy,
} from "../shared/types";
import { buildAgentEnv, ensureClaudeHooks, ensureCodexHooks } from "./agent-setup";
import type { LoopRunner } from "./loops/runner";
import { LOOP_TEMPLATES } from "./loops/templates";
import type { MergeQueue } from "./merge-queue";
import { type Services, toProjectDTO, toSessionDTO, toTaskDTO } from "./services";

export interface IpcContext {
	services: Services;
	sendTaskUpdated: (taskId: string) => void;
	mergeQueue: MergeQueue;
	loopRunner: LoopRunner;
	/** Push the current loop list to the renderer. */
	sendLoopsUpdated: () => void;
}

/** Project display name from the repo's README H1 (md or HTML), if present. */
function readmeTitle(repoPath: string): string | null {
	const clean = (s: string) =>
		s
			.replace(/<[^>]+>/g, "")
			.replace(/[*_`#]/g, "")
			.trim()
			.slice(0, 60);
	for (const f of ["README.md", "readme.md", "Readme.md"]) {
		try {
			const txt = readFileSync(join(repoPath, f), "utf8").slice(0, 4000);
			const md = txt.match(/^#\s+(.+?)\s*$/m);
			if (md?.[1]) return clean(md[1]) || null;
			const html = txt.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
			if (html?.[1]) return clean(html[1]) || null;
		} catch {
			/* no readme at this casing */
		}
	}
	return null;
}

function requireTask(services: Services, taskId: string) {
	const task = repo.getTask(services.db, taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);
	return task;
}

function requireProjectFor(services: Services, projectId: string) {
	const project = repo.getProject(services.db, projectId);
	if (!project) throw new Error(`Project not found: ${projectId}`);
	return project;
}

async function computeGitStatus(
	worktreePath: string,
	baseBranch: string,
): Promise<GitStatusSnapshot> {
	const tracking = await trackingStatus(worktreePath);
	const d = await diff({ worktreePath, baseBranch });
	return {
		ahead: tracking?.ahead ?? 0,
		behind: tracking?.behind ?? 0,
		dirty: d.files.length,
		updatedAt: Date.now(),
	};
}

export function registerIpc(ctx: IpcContext): void {
	const { services, sendTaskUpdated, mergeQueue, loopRunner, sendLoopsUpdated } = ctx;
	const { db } = services;

	// ---- projects ----
	ipcMain.handle(CH.projectsPick, async () => {
		const res = await dialog.showOpenDialog({
			properties: ["openDirectory"],
			title: "Select a git repository",
		});
		return res.canceled ? null : (res.filePaths[0] ?? null);
	});

	ipcMain.handle(CH.projectsRegister, async (_e, repoPath: string, opts?: { init?: boolean }) => {
		// "Create a repository here instead" (GitHub-Desktop-style), after the
		// renderer asked the user.
		if (opts?.init) await initRepository(repoPath);
		const info = await registerProject(repoPath);
		const row = repo.upsertProject(db, {
			repoPath: info.repoPath,
			name: readmeTitle(info.repoPath) ?? basename(info.repoPath),
			defaultBranch: info.defaultBranch,
			githubOwner: info.githubRepo?.owner ?? null,
			githubName: info.githubRepo?.name ?? null,
		});
		return toProjectDTO(row!);
	});

	ipcMain.handle(CH.projectsList, async () =>
		repo
			.listProjects(db)
			.map((p) => toProjectDTO({ ...p, name: readmeTitle(p.repoPath) ?? p.name })),
	);

	ipcMain.handle(CH.projectsRemove, async (_e, id: string) => {
		repo.deleteProject(db, id);
	});

	// ---- tasks ----
	ipcMain.handle(CH.tasksList, async (_e, projectId: string) =>
		repo.listTasks(db, projectId).map(toTaskDTO),
	);

	ipcMain.handle(
		CH.tasksCreate,
		async (_e, input: { projectId: string; name: string; baseBranch?: string }) => {
			const project = requireProjectFor(services, input.projectId);
			const created = await gitCreateTask({
				repoPath: project.repoPath,
				name: input.name,
				baseBranch: input.baseBranch ?? project.defaultBranch ?? undefined,
				worktreesRoot: project.worktreesRoot ?? undefined,
			});
			const row = repo.createTask(db, {
				projectId: project.id,
				name: input.name,
				slug: created.slug,
				branch: created.branch,
				baseBranch: created.baseBranch,
				worktreePath: created.worktreePath,
			});
			return toTaskDTO(row);
		},
	);

	ipcMain.handle(
		CH.tasksRemove,
		async (_e, input: { id: string; deleteBranch?: boolean; force?: boolean }) => {
			const task = requireTask(services, input.id);
			const project = requireProjectFor(services, task.projectId);
			// Tear down any live agent/shell sessions in this worktree first.
			for (const s of repo.listSessionsByTask(db, task.id)) {
				services.pty.kill(s.terminalId);
			}
			await gitRemoveTask({
				repoPath: project.repoPath,
				worktreePath: task.worktreePath,
				branch: task.branch,
				deleteBranch: input.deleteBranch,
				force: input.force,
			});
			repo.deleteTask(db, task.id);
		},
	);

	ipcMain.handle(CH.tasksSetColumn, async (_e, id: string, column: KanbanColumn) => {
		const row = repo.updateTask(db, id, { column });
		return toTaskDTO(row!);
	});

	// ---- cleanup: remove only merged + idle + clean worktrees ----
	// Classify a project's tasks into removable vs kept (with a reason). A task
	// is removable ONLY when it merged, has no live agent session, and its
	// working tree is clean. Everything else is kept — never deleting unmerged
	// work or a task an agent is still using.
	async function classifyForCleanup(projectId: string) {
		const allTasks = repo.listTasks(db, projectId);
		const removable: typeof allTasks = [];
		const kept: { task: (typeof allTasks)[number]; reason: string }[] = [];
		for (const task of allTasks) {
			const isMerged = task.column === "merged" || task.prState === "merged";
			if (!isMerged) {
				kept.push({ task, reason: "not merged" });
				continue;
			}
			const live = repo.listSessionsByTask(db, task.id).some((s) => services.pty.has(s.terminalId));
			if (live) {
				kept.push({ task, reason: "agent still active" });
				continue;
			}
			const dirty =
				(
					await gitFor(task.worktreePath)
						.raw(["status", "--porcelain"])
						.catch(() => "")
				).trim() !== "";
			if (dirty) {
				kept.push({ task, reason: "uncommitted/untracked changes" });
				continue;
			}
			removable.push(task);
		}
		return { removable, kept };
	}

	// Candidates for the interactive cleanup dialog: every task that isn't
	// actively running (idle / stopped / merged / no activity). Each carries a
	// live terminalId when its PTY is still around, so the dialog can show the
	// conversation and let the user continue it instead of deleting.
	ipcMain.handle(CH.tasksCleanupCandidates, async (_e, projectId: string) => {
		const out: {
			id: string;
			name: string;
			branch: string;
			worktreePath: string;
			reason: string;
			terminalId: string | null;
			agentStatus: string | null;
		}[] = [];
		for (const task of repo.listTasks(db, projectId)) {
			const busy = task.agentStatus === "running" || task.agentStatus === "awaiting_input";
			// Done tasks are always proposed — merged work is cleanup material
			// even when its agent session is technically still alive.
			if (busy && task.column !== "merged") continue;
			const live = repo.listSessionsByTask(db, task.id).find((s) => services.pty.has(s.terminalId));
			const reason =
				task.column === "merged"
					? "merged"
					: task.agentStatus === "idle" || task.agentStatus === "stopped"
						? "agent idle"
						: "no recent activity";
			out.push({
				id: task.id,
				name: task.name,
				branch: task.branch,
				worktreePath: task.worktreePath,
				reason,
				terminalId: live?.terminalId ?? null,
				agentStatus: task.agentStatus ?? null,
			});
		}
		return out;
	});

	ipcMain.handle(CH.tasksCleanupPreview, async (_e, projectId: string) => {
		const { removable, kept } = await classifyForCleanup(projectId);
		return {
			removed: removable.map((t) => ({
				id: t.id,
				name: t.name,
				branch: t.branch,
			})),
			kept: kept.map((k) => ({
				id: k.task.id,
				name: k.task.name,
				branch: k.task.branch,
				reason: k.reason,
			})),
		};
	});

	ipcMain.handle(CH.tasksCleanup, async (_e, projectId: string) => {
		const project = requireProjectFor(services, projectId);
		const { removable, kept } = await classifyForCleanup(projectId);
		const removed: { id: string; name: string; branch: string }[] = [];
		for (const task of removable) {
			try {
				// force:false → git refuses if the tree somehow became dirty between
				// classify and now; deleteBranch:true (branch -d refuses unmerged).
				await gitRemoveTask({
					repoPath: project.repoPath,
					worktreePath: task.worktreePath,
					branch: task.branch,
					deleteBranch: true,
					force: false,
				});
				repo.deleteTask(db, task.id);
				removed.push({ id: task.id, name: task.name, branch: task.branch });
			} catch (err) {
				kept.push({ task, reason: errorMessage(err) });
			}
		}
		return {
			removed,
			kept: kept.map((k) => ({
				id: k.task.id,
				name: k.task.name,
				branch: k.task.branch,
				reason: k.reason,
			})),
		};
	});

	// ---- git ----
	ipcMain.handle(CH.gitCommit, async (_e, taskId: string, message: string) => {
		const task = requireTask(services, taskId);
		return commit({ worktreePath: task.worktreePath, message });
	});

	ipcMain.handle(CH.gitPush, async (_e, taskId: string) => {
		const task = requireTask(services, taskId);
		await push({ worktreePath: task.worktreePath, branch: task.branch });
	});

	ipcMain.handle(CH.gitUpdate, async (_e, taskId: string) => {
		const task = requireTask(services, taskId);
		const settings = repo.getSettings(db);
		const result = await updateFromBase({
			worktreePath: task.worktreePath,
			baseBranch: task.baseBranch,
			strategy: settings.defaultUpdateStrategy ?? "merge",
		});
		return result;
	});

	ipcMain.handle(CH.gitMerge, async (_e, taskId: string, strategy: MergeStrategy) => {
		const task = requireTask(services, taskId);
		const project = requireProjectFor(services, task.projectId);
		const settings = repo.getSettings(db);
		// Serialize through the merge queue: two branches targeting the same
		// base never race; each absorbs the freshly-merged base before merging.
		return mergeQueue.enqueue({
			task,
			repoPath: project.repoPath,
			strategy,
			updateStrategy: settings.defaultUpdateStrategy ?? "merge",
			deleteRemoteBranch: settings.deleteRemoteBranchOnMerge ?? false,
		});
	});

	ipcMain.handle(CH.gitDiff, async (_e, taskId: string) => {
		const task = requireTask(services, taskId);
		return diff({ worktreePath: task.worktreePath, baseBranch: task.baseBranch });
	});

	ipcMain.handle(CH.gitFileDiff, async (_e, taskId: string, file: string) => {
		const task = requireTask(services, taskId);
		return fileDiff({
			worktreePath: task.worktreePath,
			file,
			baseBranch: task.baseBranch,
		});
	});

	// Detect merges done OUTSIDE Ateam (the agent ran `gh pr merge` in its
	// terminal, or the PR was merged on github.com) and move the task to Done.
	// Throttled per task; fire-and-forget so status replies stay fast.
	const mergeCheckedAt = new Map<string, number>();
	const detectExternalMerge = async (taskId: string): Promise<void> => {
		if (Date.now() - (mergeCheckedAt.get(taskId) ?? 0) < 60_000) return;
		mergeCheckedAt.set(taskId, Date.now());
		const task = repo.getTask(db, taskId);
		if (!task || task.column === "merged") return;
		// Done only when the conversation ended on a plain text reply: the agent
		// fired Stop (idle/stopped) and is not waiting on a question/permission.
		// A merge mid-conversation must NOT yank the card to Done.
		const finished =
			task.agentStatus == null || task.agentStatus === "idle" || task.agentStatus === "stopped";
		if (!finished || task.column === "needs_attention") return;
		try {
			const res = await detectMerged({
				worktreePath: task.worktreePath,
				branch: task.branch,
				baseBranch: task.baseBranch,
			});
			if (!res.merged) return;
			repo.updateTask(db, task.id, {
				column: "merged",
				prState: "merged",
				prNumber: res.prNumber ?? task.prNumber ?? null,
				prUrl: res.prUrl ?? task.prUrl ?? null,
			});
			sendTaskUpdated(task.id);
		} catch {
			/* offline or gh unavailable — retried on a later refresh */
		}
	};

	ipcMain.handle(CH.gitStatus, async (_e, taskId: string) => {
		const task = requireTask(services, taskId);
		const snapshot = await computeGitStatus(task.worktreePath, task.baseBranch);
		repo.updateTask(db, task.id, { gitStatus: snapshot });
		if (task.column !== "merged") void detectExternalMerge(task.id);
		return snapshot;
	});

	// Native file picker for the terminal toolbar's "+ → Files…" action; the
	// renderer types the chosen paths into the PTY like a drag-and-drop would.
	ipcMain.handle(CH.utilPickFiles, async () => {
		const res = await dialog.showOpenDialog({
			properties: ["openFile", "multiSelections"],
			title: "Add files to terminal",
		});
		return res.canceled ? [] : res.filePaths;
	});

	// "+ → Attach image": open a picker, then stage the chosen image as a real
	// bitmap on the clipboard so the renderer's following Ctrl+V hands the agent
	// pixels, not a path or a file-icon.
	//
	// Always a picker — deliberately never sourced from the clipboard. Staging
	// writes the image *to* the clipboard, so reading it back here would skip the
	// picker on the next attach and re-stage the same image (you could never add a
	// second, different one). Copied screenshots/images are attached via ⌘V paste,
	// handled separately in the renderer's paste handler.
	ipcMain.handle(CH.utilStageImage, async () => {
		const res = await dialog.showOpenDialog({
			properties: ["openFile"],
			title: "Attach image",
			filters: [
				{
					name: "Images",
					extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic", "avif"],
				},
			],
		});
		const picked = res.canceled ? null : (res.filePaths[0] ?? null);
		if (!picked) return false;
		const img = nativeImage.createFromPath(picked);
		if (img.isEmpty()) return false;
		clipboard.writeImage(img);
		return true;
	});

	// ---- agents ----
	ipcMain.handle(CH.agentsList, async () => {
		const agents = await listAgents();
		return agents.map((a) => ({
			id: a.id,
			label: a.label,
			description: a.description,
			available: a.available,
		}));
	});

	// ---- loops (periodic reconcilers) ----
	ipcMain.handle(CH.loopsList, () => loopRunner.describe());
	ipcMain.handle(CH.loopsSetEnabled, (_e, id: string, enabled: boolean) => {
		loopRunner.setEnabled(id, enabled);
		sendLoopsUpdated();
		return loopRunner.describe();
	});
	ipcMain.handle(CH.loopsRunNow, async (_e, id: string) => {
		await loopRunner.runNow(id);
		sendLoopsUpdated();
		return loopRunner.describe();
	});
	ipcMain.handle(CH.loopsTemplates, () =>
		LOOP_TEMPLATES.map((t) => ({
			id: t.id,
			title: t.title,
			description: t.description,
			params: t.params,
		})),
	);
	ipcMain.handle(CH.loopsCreate, (_e, input: CreateLoopInput) => {
		const loops = loopRunner.createUserLoop(input);
		sendLoopsUpdated();
		return loops;
	});
	ipcMain.handle(CH.loopsDelete, (_e, id: string) => {
		const loops = loopRunner.deleteUserLoop(id);
		sendLoopsUpdated();
		return loops;
	});

	// ---- pty ----
	const shell = process.env.SHELL || "/bin/zsh";

	ipcMain.handle(
		CH.ptySpawnAgent,
		async (
			_e,
			input: {
				taskId: string;
				agentId: string;
				yolo?: boolean;
				resume?: boolean;
				prompt?: string;
				files?: string[];
			},
		) => {
			const task = requireTask(services, input.taskId);
			const agent = getAgent(input.agentId);
			if (!agent) throw new Error(`Unknown agent: ${input.agentId}`);

			const terminalId = randomUUID();
			repo.createSession(db, {
				taskId: task.id,
				agentId: agent.id,
				terminalId,
				cwd: task.worktreePath,
			});

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
				prompt,
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

			repo.updateTask(db, task.id, {
				column: "running",
				agentStatus: "running",
				agentId: agent.id,
			});
			sendTaskUpdated(task.id);
			return { terminalId };
		},
	);

	ipcMain.handle(CH.ptySpawnShell, async (_e, input: { taskId: string }) => {
		const task = requireTask(services, input.taskId);
		const terminalId = randomUUID();
		repo.createSession(db, {
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
		return { terminalId };
	});

	ipcMain.on(CH.ptyWrite, (_e, terminalId: string, data: string) => {
		services.pty.write(terminalId, data);
	});

	ipcMain.on(CH.ptyResize, (_e, terminalId: string, cols: number, rows: number) => {
		services.pty.resize(terminalId, cols, rows);
	});

	ipcMain.handle(CH.ptyKill, async (_e, terminalId: string) => {
		services.pty.kill(terminalId);
	});

	ipcMain.handle(CH.ptySnapshot, async (_e, terminalId: string) =>
		services.pty.snapshot(terminalId),
	);

	ipcMain.handle(CH.ptyListForTask, async (_e, taskId: string) => {
		// Return the task's sessions that still have a live PTY.
		return repo
			.listSessionsByTask(db, taskId)
			.filter((s) => services.pty.has(s.terminalId))
			.map(toSessionDTO);
	});
}
