// Transport-agnostic request/response dispatcher for the ~26 engine methods
// (everything the renderer's window.ateam calls except the 4 client-native ones
// that need Electron's dialog/clipboard). Lifted verbatim from the desktop's
// ipcMain handlers; the desktop now adapts ipcMain → handle(), and the SSH
// server will adapt a JSON-RPC channel → handle(). One body, many transports.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
import {
	CH,
	type CreateLoopInput,
	type DirEntryDTO,
	type GitStatusSnapshot,
	type KanbanColumn,
	type MergeStrategy,
} from "@ateam/protocol";
import { buildAgentEnv, ensureClaudeHooks, ensureCodexHooks } from "./agent-setup";
import type { Engine } from "./engine";
import { LOOP_TEMPLATES } from "./loops/templates";
import { type Services, toProjectDTO, toSessionDTO, toTaskDTO } from "./services";

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

export interface Dispatcher {
	/** Method names this dispatcher handles (the non-native CH.* channels). */
	readonly methods: string[];
	/** Invoke a method with its positional args; throws on unknown method. */
	handle(method: string, args: unknown[]): Promise<unknown>;
}

export function createDispatcher(engine: Engine): Dispatcher {
	const { services } = engine;
	const { db, mergeQueue, loopRunner } = services;
	const shell = process.env.SHELL || "/bin/zsh";

	// ---- cleanup: remove only merged + idle + clean worktrees ----
	// A task is removable ONLY when it merged, has no live agent session, and its
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
			engine.sendTaskUpdated(task.id);
		} catch {
			/* offline or gh unavailable — retried on a later refresh */
		}
	};

	const handlers = {
		// ---- projects ----
		[CH.projectsRegister]: async (repoPath: string, opts?: { init?: boolean }) => {
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
		},
		[CH.projectsList]: async () =>
			repo
				.listProjects(db)
				.map((p) => toProjectDTO({ ...p, name: readmeTitle(p.repoPath) ?? p.name })),
		[CH.projectsRemove]: async (id: string) => {
			repo.deleteProject(db, id);
		},

		// ---- tasks ----
		[CH.tasksList]: async (projectId: string) => repo.listTasks(db, projectId).map(toTaskDTO),
		[CH.tasksCreate]: async (input: { projectId: string; name: string; baseBranch?: string }) => {
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
		[CH.tasksRemove]: async (input: { id: string; deleteBranch?: boolean; force?: boolean }) => {
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
		[CH.tasksSetColumn]: async (id: string, column: KanbanColumn) => {
			const row = repo.updateTask(db, id, { column });
			// Broadcast so every view (board, sidebar) reflects the move — e.g. the
			// "Done" button under the terminal that sends a review task to merged.
			engine.sendTaskUpdated(id);
			return toTaskDTO(row!);
		},

		// Candidates for the interactive cleanup dialog: every task that isn't
		// actively running. Each carries a live terminalId when its PTY is still
		// around, so the dialog can show the conversation and let the user continue.
		[CH.tasksCleanupCandidates]: async (projectId: string) => {
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
				const live = repo
					.listSessionsByTask(db, task.id)
					.find((s) => services.pty.has(s.terminalId));
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
		},
		[CH.tasksCleanupPreview]: async (projectId: string) => {
			const { removable, kept } = await classifyForCleanup(projectId);
			return {
				removed: removable.map((t) => ({ id: t.id, name: t.name, branch: t.branch })),
				kept: kept.map((k) => ({
					id: k.task.id,
					name: k.task.name,
					branch: k.task.branch,
					reason: k.reason,
				})),
			};
		},
		[CH.tasksCleanup]: async (projectId: string) => {
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
		},

		// ---- git ----
		[CH.gitCommit]: async (taskId: string, message: string) => {
			const task = requireTask(services, taskId);
			return commit({ worktreePath: task.worktreePath, message });
		},
		[CH.gitPush]: async (taskId: string) => {
			const task = requireTask(services, taskId);
			await push({ worktreePath: task.worktreePath, branch: task.branch });
		},
		[CH.gitUpdate]: async (taskId: string) => {
			const task = requireTask(services, taskId);
			const settings = repo.getSettings(db);
			return updateFromBase({
				worktreePath: task.worktreePath,
				baseBranch: task.baseBranch,
				strategy: settings.defaultUpdateStrategy ?? "merge",
			});
		},
		[CH.gitMerge]: async (taskId: string, strategy: MergeStrategy) => {
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
		},
		[CH.gitDiff]: async (taskId: string) => {
			const task = requireTask(services, taskId);
			return diff({ worktreePath: task.worktreePath, baseBranch: task.baseBranch });
		},
		[CH.gitFileDiff]: async (taskId: string, file: string) => {
			const task = requireTask(services, taskId);
			return fileDiff({ worktreePath: task.worktreePath, file, baseBranch: task.baseBranch });
		},
		[CH.gitStatus]: async (taskId: string) => {
			const task = requireTask(services, taskId);
			const snapshot = await computeGitStatus(task.worktreePath, task.baseBranch);
			repo.updateTask(db, task.id, { gitStatus: snapshot });
			if (task.column !== "merged") void detectExternalMerge(task.id);
			return snapshot;
		},

		// ---- agents ----
		[CH.agentsList]: async () => {
			const agents = await listAgents();
			return agents.map((a) => ({
				id: a.id,
				label: a.label,
				description: a.description,
				available: a.available,
			}));
		},

		// ---- fs / util: server-side, remote-native (browse + attach on the
		// engine's machine, not the client's — the SSH client is on another box) ----
		[CH.fsListDir]: async (path?: string) => {
			// The engine runs as the user (over SSH, in the daemon); browsing its own
			// filesystem is the same access the SSH session already has — no new grant.
			const dir = path ? resolve(path) : homedir();
			const entries: DirEntryDTO[] = [];
			for (const d of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, d.name);
				let isDir = d.isDirectory();
				// Follow symlinks-to-dirs (home dirs often symlink project folders);
				// skip broken links rather than fail the whole listing.
				if (!isDir && d.isSymbolicLink()) {
					try {
						isDir = statSync(full).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDir) continue;
				entries.push({ name: d.name, path: full, isRepo: existsSync(join(full, ".git")) });
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
			const parent = dirname(dir);
			return { path: dir, parent: parent === dir ? null : parent, entries };
		},
		[CH.utilWriteImageBytes]: async (base64: string, ext?: string) => {
			const safeExt = (ext ?? "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
			const dir = join(services.userDataDir, "attachments");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			// Random name: an attachment is handed to the agent immediately; the engine
			// prunes this dir on startup so temp images never accumulate unboundedly.
			const file = join(dir, `${randomUUID()}.${safeExt}`);
			writeFileSync(file, Buffer.from(base64, "base64"));
			return file;
		},

		// ---- loops (periodic reconcilers) ----
		[CH.loopsList]: () => loopRunner.describe(),
		[CH.loopsSetEnabled]: (id: string, enabled: boolean) => {
			loopRunner.setEnabled(id, enabled);
			engine.sendLoopsUpdated();
			return loopRunner.describe();
		},
		[CH.loopsRunNow]: async (id: string) => {
			await loopRunner.runNow(id);
			engine.sendLoopsUpdated();
			return loopRunner.describe();
		},
		[CH.loopsTemplates]: () =>
			LOOP_TEMPLATES.map((t) => ({
				id: t.id,
				title: t.title,
				description: t.description,
				params: t.params,
			})),
		[CH.loopsCreate]: (input: CreateLoopInput) => {
			const loops = loopRunner.createUserLoop(input);
			engine.sendLoopsUpdated();
			return loops;
		},
		[CH.loopsDelete]: (id: string) => {
			const loops = loopRunner.deleteUserLoop(id);
			engine.sendLoopsUpdated();
			return loops;
		},

		// ---- pty ----
		[CH.ptySpawnAgent]: async (input: {
			taskId: string;
			agentId: string;
			yolo?: boolean;
			resume?: boolean;
			prompt?: string;
			files?: string[];
		}) => {
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
			let agentCmd = agentCommand(agent, { yolo: input.yolo, resume: input.resume, prompt });
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
			engine.sendTaskUpdated(task.id);
			return { terminalId };
		},
		[CH.ptySpawnShell]: async (input: { taskId: string }) => {
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
		},
		[CH.ptyWrite]: (terminalId: string, data: string) => {
			services.pty.write(terminalId, data);
		},
		[CH.ptyResize]: (terminalId: string, cols: number, rows: number) => {
			services.pty.resize(terminalId, cols, rows);
		},
		[CH.ptyKill]: async (terminalId: string) => {
			services.pty.kill(terminalId);
		},
		[CH.ptySnapshot]: async (terminalId: string) => services.pty.snapshot(terminalId),
		[CH.ptyListForTask]: async (taskId: string) =>
			// Return the task's sessions that still have a live PTY.
			repo
				.listSessionsByTask(db, taskId)
				.filter((s) => services.pty.has(s.terminalId))
				.map(toSessionDTO),
	} satisfies Record<string, (...args: never[]) => unknown>;

	return {
		methods: Object.keys(handlers),
		async handle(method: string, args: unknown[]): Promise<unknown> {
			const h = (handlers as Record<string, (...a: unknown[]) => unknown>)[method];
			if (!h) throw new Error(`Unknown method: ${method}`);
			return await h(...args);
		},
	};
}
