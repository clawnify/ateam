// Transport-agnostic request/response dispatcher for the ~26 engine methods
// (everything the renderer's window.ateam calls except the 4 client-native ones
// that need Electron's dialog/clipboard). Lifted verbatim from the desktop's
// ipcMain handlers; the desktop now adapts ipcMain → handle(), and the SSH
// server will adapt a JSON-RPC channel → handle(). One body, many transports.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { listAgents } from "@ateam/agents";
import { repo, type Task } from "@ateam/db";
import {
	cloneRepo,
	commit,
	detectMerged,
	diff,
	errorMessage,
	fileDiff,
	getOriginUrl,
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
	type BoxUpdateStarted,
	type CleanupCandidate,
	type CreateLoopInput,
	type DirEntryDTO,
	type GitStatusSnapshot,
	type KanbanColumn,
	type MergeStrategy,
	PROTOCOL_VERSION,
	type UpdateLoopInput,
} from "@ateam/protocol";
import { createEditorHost, installCodeServer } from "./editor";
import type { Engine } from "./engine";
import { LOOP_TEMPLATES } from "./loops/templates";
import { type Services, toProjectDTO, toSessionDTO, toTaskDTO } from "./services";
import { searchSessions } from "./session-search";
import { createTaskInProject, type SpawnAgentInput, shell, spawnAgentInTask } from "./sessions";

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

/** Where install.sh is fetched from, matching the documented one-liner and the
 *  desktop's own SSH install: raw `main`, so a box always runs the current script
 *  even when its own dist is months old. */
const INSTALL_URL =
	"https://raw.githubusercontent.com/clawnify/ateam/main/packages/server/scripts/install.sh";

/** An update is in flight in THIS process (see CH.systemUpdate). */
let updating = false;

export interface Dispatcher {
	/** Method names this dispatcher handles (the non-native CH.* channels). */
	readonly methods: string[];
	/** Invoke a method with its positional args; throws on unknown method. */
	handle(method: string, args: unknown[]): Promise<unknown>;
}

export function createDispatcher(engine: Engine): Dispatcher {
	const { services } = engine;
	const { db, mergeQueue, loopRunner } = services;
	// Lazy: no code-server process exists until the first editor:open.
	const editorHost = createEditorHost();

	// ---- cleanup: merged + idle + clean is a RECOMMENDATION, not a filter ----
	// The rule below (merged, no live agent session, clean working tree) is the
	// only thing the unattended sweep will delete. The interactive dialog no
	// longer hides everything that fails it: it lists every task and shows this
	// verdict as advice, because whether a worktree is worth keeping turns on
	// factors only the user weighs — how stale it is, whether its PR landed,
	// whether the leftover dirt matters.
	async function cleanupVerdict(
		task: Task,
	): Promise<{ recommended: boolean; reason: string; live: boolean }> {
		const live = repo.listSessionsByTask(db, task.id).some((s) => services.pty.has(s.terminalId));
		const isMerged = task.column === "merged" || task.prState === "merged";
		if (!isMerged) return { recommended: false, reason: "not merged", live };
		if (live) return { recommended: false, reason: "agent still active", live };
		// Only merged + idle tasks reach the subprocess, so listing everything
		// costs no more git calls than the old pre-filtered list did. The whole
		// probe is guarded, not just the command: `gitFor` itself throws when the
		// worktree directory is gone (deleted by hand, or pruned elsewhere), and
		// an unguarded throw here would fail the entire candidate listing. A
		// vanished tree has nothing left to lose, so it stays sweepable.
		let dirty = false;
		try {
			dirty = (await gitFor(task.worktreePath).raw(["status", "--porcelain"])).trim() !== "";
		} catch {
			dirty = false;
		}
		if (dirty) return { recommended: false, reason: "uncommitted/untracked changes", live };
		return { recommended: true, reason: "merged, clean, no live session", live };
	}

	// A task is removable by the unattended sweep ONLY when `cleanupVerdict`
	// recommends it — never deleting unmerged work or a task an agent still uses.
	async function classifyForCleanup(projectId: string) {
		const allTasks = repo.listTasks(db, projectId);
		const removable: typeof allTasks = [];
		const kept: { task: (typeof allTasks)[number]; reason: string }[] = [];
		for (const task of allTasks) {
			const v = await cleanupVerdict(task);
			if (v.recommended) removable.push(task);
			else kept.push({ task, reason: v.reason });
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

	/** Open a login shell in a task's worktree and record the session. */
	const spawnShellInTask = (task: { id: string; worktreePath: string }) => {
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
		// A new session IS a change to the task — say so, exactly as the agent
		// spawn does. Without this, a shell opened in one window is invisible to
		// every other client until something else touches the task.
		engine.sendTaskUpdated(task.id);
		return { terminalId };
	};

	const handlers = {
		// ---- projects ----
		[CH.projectsRegister]: async (repoPath: string, opts?: { init?: boolean }) => {
			// "Create a repository here instead" (GitHub-Desktop-style), after the client
			// asked the user. When the folder doesn't exist yet, create it first — a
			// brand-new project from a client with no native folder dialog (the phone).
			// Mirrors the clone handler below, which creates its dest before registering.
			if (opts?.init) {
				if (!existsSync(repoPath)) mkdirSync(repoPath);
				await initRepository(repoPath);
			}
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
		[CH.projectsClone]: async (input: { cloneUrl: string }) => {
			// Provision a repo onto THIS engine's machine (from its remote URL) so a task
			// can run here. Dest ~/<repo-name> (derived from the URL); if it already
			// exists, treat it as the repo (cloned before) and just register —
			// upsertProject dedupes by repoPath, so a repeat provision is idempotent.
			const name = basename(input.cloneUrl).replace(/\.git$/, "") || "repo";
			const dest = join(homedir(), name);
			if (!existsSync(dest)) {
				await cloneRepo(input.cloneUrl, dest);
			}
			const info = await registerProject(dest);
			const row = repo.upsertProject(db, {
				repoPath: info.repoPath,
				name: readmeTitle(info.repoPath) ?? basename(info.repoPath),
				defaultBranch: info.defaultBranch,
				githubOwner: info.githubRepo?.owner ?? null,
				githubName: info.githubRepo?.name ?? null,
			});
			return toProjectDTO(row!);
		},
		[CH.projectsRemoteUrl]: async (projectId: string) => {
			const project = requireProjectFor(services, projectId);
			return getOriginUrl(project.repoPath);
		},
		[CH.projectsList]: async () =>
			repo
				.listProjects(db)
				.map((p) => toProjectDTO({ ...p, name: readmeTitle(p.repoPath) ?? p.name })),
		[CH.projectsRemove]: async (id: string) => {
			repo.deleteProject(db, id);
		},

		// ---- tasks ----
		[CH.tasksList]: async (projectId: string) =>
			repo
				.listTasks(db, projectId)
				.map((t) => toTaskDTO(t, services.pendingSeeds.has(t.id))),
		[CH.tasksCreate]: async (input: {
			projectId: string;
			name: string;
			baseBranch?: string;
			agentId?: string;
		}) => {
			const row = await createTaskInProject(services, engine.sendTaskUpdated, input);
			return toTaskDTO(row, services.pendingSeeds.has(row.id));
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
			// Drop the card from every window (not just the caller's).
			engine.sendTaskRemoved(task.id);
		},
		// The user has actually looked at the task, so it is no longer news. Only
		// the hooks set `isUnread` (on Stop / PermissionRequest); nothing cleared
		// it before, which is why the flag was never worth rendering.
		[CH.tasksMarkRead]: async (id: string) => {
			const row = repo.updateTask(db, id, { isUnread: false });
			engine.sendTaskUpdated(id);
			return toTaskDTO(row!);
		},
		[CH.tasksSetColumn]: async (id: string, column: KanbanColumn) => {
			const row = repo.updateTask(db, id, { column });
			// Broadcast so every view (board, sidebar) reflects the move — e.g. the
			// "Done" button under the terminal that sends a review task to merged.
			engine.sendTaskUpdated(id);
			return toTaskDTO(row!);
		},

		// Candidates for the interactive cleanup dialog: EVERY task in the project,
		// each with the sweep's verdict as advice (`recommended`) and the whole
		// task DTO, so the dialog can lay out the factors the user decides on —
		// last activity, PR state, ahead/dirty counts, triage. A live terminalId
		// rides along when the PTY is still around, so the conversation is there
		// to read before deciding, and "Keep & continue" lands back in it.
		[CH.tasksCleanupCandidates]: async (projectId: string): Promise<CleanupCandidate[]> => {
			const out: CleanupCandidate[] = [];
			for (const task of repo.listTasks(db, projectId)) {
				const v = await cleanupVerdict(task);
				const live = repo
					.listSessionsByTask(db, task.id)
					.find((s) => services.pty.has(s.terminalId));
				out.push({
					task: toTaskDTO(task),
					terminalId: live?.terminalId ?? null,
					recommended: v.recommended,
					reason: v.reason,
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
					engine.sendTaskRemoved(task.id);
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

		// ---- session search ----
		// "Which session was I working on X?" answered here instead of in a new
		// agent session. Engine-side on purpose: the transcripts live on the
		// machine that ran the agent, so a box searches its own history.
		[CH.searchSessions]: async (input: { projectId: string; query: string; ai?: boolean }) =>
			searchSessions(services, input),

		// ---- system: connect-time handshake ----
		// The client calls this first over a fresh transport and checks
		// protocolVersion before trusting the rest of the surface (see serverHandshake).
		[CH.systemHello]: async () => {
			const agents = await listAgents();
			return {
				protocolVersion: PROTOCOL_VERSION,
				agents: agents.filter((a) => a.available).map((a) => a.id),
			};
		},

		// ---- system: replace this engine with the current release ----
		// The phone's only route to a stale box. There is no SSH there, and
		// pty:spawnShell needs a taskId, so nothing without a shell could reach the
		// installer. Every detail below is load-bearing:
		//
		//   detached  the installer STOPS this daemon partway through (that is what
		//             makes an upgrade take effect). As a plain child it would be in
		//             this process's group and die with it, leaving the box on a half
		//             installed dist. setsid is what lets it outlive its own trigger.
		//   log file  for the same reason there is nobody left to stream output to, so
		//             it goes somewhere a human can read afterwards.
		//   clean env the installer must NOT inherit this process's ambient ATEAM_*.
		//             A daemon that install-remote.sh started carries ATEAM_TARBALL
		//             pointing at a dev build in /tmp, and an inherited spawn then
		//             reinstalls that stale tarball and reports success, which is an
		//             update that updates nothing. Observed on a real box, not theory.
		//             A stale ATEAM_VERSION pin would stick the same way.
		//   WS addr   left in place when this process has it. install.sh already carries
		//             an existing unit's address forward when the variable is unset, so
		//             that inheritance (not this) is what usually keeps the phone's
		//             listener alive; this only covers a box with no unit written yet.
		//   --service because a box reachable by phone is one under systemd; that is
		//             what restarts it after an OOM kill.
		[CH.systemUpdate]: async (): Promise<BoxUpdateStarted> => {
			// Same expression cli.ts resolves the socket with, so the log lands beside the
			// daemon's own even when ATEAM_RPC_SOCK moves it off the default path.
			const dataDir = dirname(process.env.ATEAM_RPC_SOCK ?? join(homedir(), ".ateam", "rpc.sock"));
			const logPath = join(dataDir, "update.log");
			// One at a time. The flag dies with this process a few seconds from now, so
			// it guards the window that matters: a double tap, or two clients at once.
			if (updating) return { started: false, logPath };
			updating = true;
			if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
			const log = openSync(logPath, "a");
			const env = { ...process.env };
			delete env.ATEAM_TARBALL;
			delete env.ATEAM_VERSION;
			spawn("bash", ["-lc", `curl -fsSL ${INSTALL_URL} | bash -s -- --service`], {
				detached: true,
				stdio: ["ignore", log, log],
				env,
			}).unref();
			return { started: true, logPath };
		},

		// ---- editor: the engine-side half of the in-app editor (code-server on
		// THIS machine). taskId scopes it to an engine (and routes it there); the
		// worktree itself is picked client-side via the URL's ?folder= param. ----
		[CH.editorOpen]: async (taskId: string) => {
			requireTask(services, taskId);
			return editorHost.ensure();
		},
		// Consent-gated: clients call this only after the user said yes to a
		// needsInstall answer. Long-running (a ~200MB download); RPC calls have no
		// per-call timeout, so the client just awaits it.
		[CH.editorInstall]: async (taskId: string) => {
			requireTask(services, taskId);
			await installCodeServer();
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
			// Stage in the OS temp dir (like Termius): transient, OS-cleaned, and readable
			// by the agent running on this box. The engine also prunes it on startup.
			const dir = join(tmpdir(), "ateam-attachments");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			// Random name: an attachment is handed to the agent immediately; the engine
			// prunes this dir on startup so temp images never accumulate unboundedly.
			const file = join(dir, `${randomUUID()}.${safeExt}`);
			writeFileSync(file, Buffer.from(base64, "base64"));
			return file;
		},

		// ---- loops (user-scheduled agent sessions) ----
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
			// A loop is a user-scheduled agent session: it needs a prompt, a project
			// on THIS engine (that's what makes it local or remote), and an interval.
			const prompt = typeof input.config?.prompt === "string" ? input.config.prompt.trim() : "";
			if (!prompt) throw new Error("A loop needs a prompt");
			if (!input.projectId) throw new Error("A loop needs a project");
			requireProjectFor(services, input.projectId);
			if (!input.intervalMs || input.intervalMs < 60_000) {
				throw new Error("Loop interval must be at least 1 minute");
			}
			const loops = loopRunner.createUserLoop({ ...input, cadenceMode: "fixed" });
			engine.sendLoopsUpdated();
			return loops;
		},
		[CH.loopsUpdate]: (input: UpdateLoopInput) => {
			// Same rules as create, applied to whichever fields are being changed.
			if (input.config && "prompt" in input.config) {
				const prompt = typeof input.config.prompt === "string" ? input.config.prompt.trim() : "";
				if (!prompt) throw new Error("A loop needs a prompt");
			}
			if (input.intervalMs != null && input.intervalMs < 60_000) {
				throw new Error("Loop interval must be at least 1 minute");
			}
			const loops = loopRunner.updateUserLoop(input);
			engine.sendLoopsUpdated();
			return loops;
		},
		[CH.loopsDelete]: (id: string) => {
			const loops = loopRunner.deleteUserLoop(id);
			engine.sendLoopsUpdated();
			return loops;
		},

		// ---- pty ----
		[CH.ptySpawnAgent]: async (input: SpawnAgentInput) =>
			spawnAgentInTask(services, engine.sendTaskUpdated, input),
		[CH.ptySpawnShell]: async (input: { taskId: string }) =>
			spawnShellInTask(requireTask(services, input.taskId)),
		[CH.ptyWrite]: (terminalId: string, data: string) => {
			services.pty.write(terminalId, data);
		},
		[CH.ptyResize]: (terminalId: string, cols: number, rows: number) => {
			services.pty.resize(terminalId, cols, rows);
		},
		[CH.ptyKill]: async (terminalId: string) => {
			// Stamp WHY before the exit lands: closing a tab is the one ending that
			// means "I am done with this", so it must not come back as a restorable
			// tab the way an app or machine going down does. The exit handler reads
			// this back rather than assuming (engine.ts).
			const session = repo.getSessionByTerminal(db, terminalId);
			if (session && session.exitedAt == null) {
				repo.updateSession(db, session.id, { exitReason: "closed" });
			}
			services.pty.kill(terminalId);
		},
		[CH.ptySnapshot]: async (terminalId: string) => services.pty.snapshot(terminalId),
		[CH.ptyListForTask]: async (taskId: string) =>
			// Return the task's sessions that still have a live PTY.
			repo
				.listSessionsByTask(db, taskId)
				.filter((s) => services.pty.has(s.terminalId))
				.map(toSessionDTO),
		// Deliberately a separate call from listForTask rather than a widening of
		// it: every existing caller (the panel's tab fallback, Mission Control,
		// the CLI) asks "what is alive here?" and would have to re-filter a mixed
		// list. Restorable tabs are a second, smaller question, asked only by the
		// panel that draws them.
		[CH.ptyListRestorable]: async (taskId: string) =>
			repo.listRestorableSessions(db, taskId).map(toSessionDTO),
		[CH.ptyRestoreSession]: async (input: { taskId: string; terminalId: string }) => {
			const task = requireTask(services, input.taskId);
			const dead = repo.getSessionByTerminal(db, input.terminalId);
			if (!dead || dead.taskId !== task.id) {
				throw new Error(`Session not found: ${input.terminalId}`);
			}
			// Someone got here first — a second window auto-restoring the same task,
			// or a double click. "Bring this conversation back" is already true, so
			// hand back the tab it is living in rather than erroring or opening a
			// second terminal onto the same conversation.
			if (dead.agentSessionId) {
				const open = repo
					.listSessionsByTask(db, task.id)
					.find((s) => s.agentSessionId === dead.agentSessionId && services.pty.has(s.terminalId));
				if (open) return { terminalId: open.terminalId };
			}
			// Both endings mean "this tab is coming back if you ask": the app went
			// down under it, or the app reclaimed its idle process.
			if (dead.exitReason !== "stranded" && dead.exitReason !== "reaped") {
				throw new Error("That session is not restorable");
			}
			// A shell holds no conversation — restoring one means opening a fresh
			// shell where it stood, which is all it ever was.
			if (dead.agentId === "shell") {
				repo.updateSession(db, dead.id, { exitReason: "restored" });
				return spawnShellInTask(task);
			}
			// With a known conversation, resume THAT one. Without (a harness that
			// mints its own ids, or a tab that started life as a `--continue`),
			// fall back to the newest conversation in the worktree — the same best
			// effort the app made before, now at least aimed at the right task.
			// Retire the old tab only once the new one is actually up. `restored`
			// is a one-way door — the strip lists `stranded`/`reaped` and nothing
			// else (repo.listRestorableSessions) — and a launch really can fail
			// here: spawnAgentInTask refuses when the agent's CLI has gone missing
			// from this machine. Stamping first would then retire the conversation
			// with no tab to show for it, and no way back to it.
			const spawned = await spawnAgentInTask(services, engine.sendTaskUpdated, {
				taskId: task.id,
				agentId: dead.agentId,
				...(dead.agentSessionId ? { resumeSessionId: dead.agentSessionId } : { resume: true }),
			});
			repo.updateSession(db, dead.id, { exitReason: "restored" });
			return spawned;
		},
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
