// The Ateam wire contract: plain DTOs, channel names, event payloads, and the
// AteamApi surface. Dependency-free by design so every consumer — the desktop
// renderer, the Electron main process, and the (future) headless @ateam/server
// over SSH — shares one definition without pulling in node/electron/db internals.

import type { GithubAccessDTO, RepoAccessDTO } from "./github-access";

/**
 * Wire-contract version. A client checks it on connect (via `system:hello`) and
 * refuses/warns on mismatch, so a version-skewed remote fails cleanly at the
 * handshake instead of cryptically mid-call ("Unknown method"/corrupt shape).
 * BUMP THIS on any breaking change to CH methods, their args, or DTO shapes.
 * Monotonic integer — deliberately not the npm version (workspaces are 0.0.0 and
 * the daemon is bundled, so package.json is neither meaningful nor readable here).
 */
// v2 (0.1.32): added CH.projectsClone + CH.projectsRemoteUrl. Additive on the wire,
// but the skew that actually happens is NEW CLIENT → OLD SERVER — the desktop
// auto-updates, a box only changes when someone re-runs the installer. Without the
// bump those clients pass the handshake and then fail deep in a feature with a raw
// `Unknown method: projects:clone`; with it they get "update the older side" up front.
// v3: Loops pivot — user-created agent-session loops only + CH.loopsUpdate (edit a
// loop in place). Same skew rationale as v2.
// v4: added CH.searchSessions. Same reasoning again — a new desktop searching an
// older box would otherwise get `Unknown method: search:sessions` from the search
// box instead of "update the older side".
// v5: TaskDTO gained a required `triage` verdict (with the `stalled` bucket) and a
// `tags` field, and CH.tasksMarkRead was added. Same skew again — an old engine
// sends cards with no `triage`, which the board reads on EVERY card, and answers
// markRead with "Unknown method".
// v6: TaskDTO gained `prState`, and CleanupCandidate now carries a whole TaskDTO
// plus a `recommended` flag (it used to be a flat, pre-filtered row). Both are
// shape changes the cleanup dialog reads directly, so an older engine would feed
// it rows with no `task` at all — the handshake must catch that skew first.
// v7: added CH.systemUpdate, so a box can be told to update ITSELF. The phone has
// no SSH and pty:spawnShell needs a taskId, so before this there was no way to fix
// a skewed box from the phone at all. Note what this version can and cannot do: a
// box older than v7 has no such method, so it still takes one update over SSH (or
// by hand) before the phone can ever drive the next one. That bootstrap is not
// avoidable from the client side.
//
// From v7 the mismatch is ADVISORY rather than a refusal: clients hold a skewed
// box, read it through tolerantRpc, and say so in the UI. The bump rule below is
// unchanged, but the reason to obey it shifts: a bump no longer locks old clients
// out, it tells them what to paper over.
// v8: LoopDTO gained `followUp`, an optional extra turn a loop's run takes after
// the agent's first reply. Shape-wise a missing field reads as "no follow-up",
// which is harmless; the damage is on the WRITE side, where a new desktop saves a
// follow-up onto an older box that stores the config key, ignores it at launch,
// and never continues the turn. Since v7 a mismatch no longer refuses, so the
// bump alone does not protect anyone: the `followUps` entry below is what turns
// that silent no-op into a feature the client knows to switch off.
// v9: added CH.projectsRemoteRepos (the repos a box's `gh` can see) and the
// `createRemote` option on projects:register, which gives a brand-new project a
// GitHub origin as it is created. Both are how a client can add a project to a box
// WITHOUT one already being cloned there, which until now took an SSH session. The
// write side needs the same treatment as v8's followUps: an older engine accepts
// `createRemote` and silently ignores it, leaving a repo with no remote — which is
// the one state that can never merge across engines — so `githubProjects` below is
// what turns that silent no-op into a feature the client switches off.
// v10: LoopDTO gained `yolo` — a loop run launches its agent permission-free (the
// composer's Auto mode, now also on loops). Shape-wise a missing field reads as
// "off", which is harmless; the damage is on the WRITE side, where a new desktop
// saves yolo onto an older box that stores the config key and silently launches
// every run permission-PROMPTED — a scheduled, unattended loop then wedges on the
// first permission ask forever. `loopAutoMode` below is what turns that silent
// downgrade into a feature the client knows to switch off.
// v11: projects:issues and tasks:createFromIssue. Older engines reject the new
// methods explicitly; issueUrl on reads is optional for old task DTOs.
// v12: projects:createIssue files a GitHub issue with the client engine's gh login.
// v13: loops can run on a calendar ("every day at 09:00") as well as on an
// interval. LoopDTO gained `cron` + `timeZone` and `cadence` gained "cron";
// loops:create/update accept them. Shape-wise a missing field reads as "no
// calendar schedule", which is harmless; the damage is on the WRITE side. A v12
// engine rejects a create with no interval, which is loud, but on update it
// drops the unknown keys and keeps the old interval while the save looks
// successful. `loopSchedules` below hides the option instead.
// v14: settings `engine.loopsPaused`, the switch that stops every loop. Nothing
// on the wire changed shape, but a v13 engine stores the key and keeps running
// its loops, so `loopsPause` below names such a box as not paused.
// v15: pty:boxShell, the box's own shell outside every project (one per box,
// reopened). A new method, so no gate: a v14 engine answers "Unknown method" and
// the phone points at Update box instead.
// v16: waits. tasks:setWaiting parks a task on an outside party until a date,
// and TaskDTO gained `waitingReason`, `waitingUntil` and `waitingFiredAt`, all
// nullable, so an older engine reads as "nothing is waiting". The new method
// rejects on an older engine, which is loud, so it needs no gate.
// v17: browser:view, the box's browser (noVNC) for the Browser panel. A new
// method, so no gate: a v16 engine answers "Unknown method" and the panel says to
// update the box. Same version, the editor binds loopback and the engine relays
// it onto the tailnet; nothing on the wire changed for it. TaskDTO gained
// `browserUsedAt`, nullable, so an older engine reads as "never used".
// v18: archiving. tasks:list leaves archived tasks out, tasks:listArchived and
// tasks:setArchived are new methods (an older engine rejects them, which fails
// the Archived view alone), and TaskDTO gained `archivedAt`, nullable. Settings
// gained `engine.archiveAfterDays`; a v17 engine stores it and archives nothing,
// which hides nothing, so it needs no gate.
// v19: the Lead chat. tasks:lastReply reads a task's last finished turn and
// peers:sendFromLead messages its agent on the user's behalf. New methods, so
// no gate: a v18 engine answers "Unknown method" and the Lead tells the user
// that box needs an update. Same version, agents can ask the user a question
// (the ask_user board tool): TaskDTO gained `question`, optional, so an older
// engine reads as "nothing asked", and tasks:answerQuestion answers it.
// v20: agent pages (the show_page board tool, and ask_user's `page`). TaskDTO
// gained `page` and TaskQuestionDTO `pageId`, both optional, so an older engine
// reads as "no page"; tasks:page is a new method.
// v21: skills. skills:list answers which skills the agent in a terminal can
// invoke, read from that agent's own folders on the engine's machine; a new
// method, so no gate: a v20 engine answers "Unknown method" and the toolbar
// shows no skills for that box. skills:link always runs on this Mac's engine.
// Settings gained `client.pinnedSkills`, read by the desktop alone.
// v22: proposals. An agent proposes a task or a loop (the propose_task and
// propose_loop board tools) for the user to start from a filled-in dialog.
// TaskDTO gained `proposals`, optional, so an older engine reads as "nothing
// proposed", and tasks:clearProposal is a new method; an older engine never has
// a proposal to clear, so neither needs a gate.
// v23: titles and summaries. tasks:create takes `nameAuto` (an older engine
// ignores it and keeps the six words), TaskDTO gained `summary`, optional, so an
// older engine reads as "no summary yet", and settings gained
// `engine.textModel` / `engine.openRouterTextModel`, which an older engine
// stores and never reads. Nothing needs a gate.
// v24: a box's own Lead, for the phone. The engine answers LEAD_RPC (lead.ts)
// and pushes LEAD_EVENT to a connection that called one. New methods only; the
// phone hides its Lead below this version (FEATURE_MIN_VERSION.lead).
// v25: GitHub access (github-access.ts). githubAccess:status says which GitHub
// credential the box's gh and git use and what kind it is, githubAccess:connect
// hands gh a token without a terminal, and githubAccess:check says per repo
// whether the box can push, only read, or not see it. New methods only: a v24
// engine answers "Unknown method", and clients send the user to the box terminal
// instead (FEATURE_MIN_VERSION.githubAccess).
// v26: browser:install runs install-browser.sh on the box once the user said
// yes, so the Browser button offers the install instead of a command to paste.
// A new method only: a v25 engine answers "Unknown method", and the desktop
// shows the command from that engine's own BROWSER_NOT_INSTALLED_ERROR.
// v27: change steps. tasks:changeSteps tells a task's diff as steps, with the
// agent's reason for each and what its account of the work never mentions. A
// new method only: a v26 engine answers "Unknown method", and the Changes view
// stays the flat list it always was.
// v28: a box's Lead answers lead:react, an emoji answer to an agent's reply,
// for the desktop whose Lead lives on that box (the phone doesn't send it yet).
// A new method only: a v27 box answers "Unknown method", and the desktop hides
// the emoji button there (FEATURE_MIN_VERSION.leadReact). Settings gained
// `client.leadBox`, read by the desktop alone.
// v29: pairing. A box's network port (the WebSocket) can be locked to the devices
// paired with it: a connection then gets no events and may only say hello (with
// its device token) or redeem a one-time code until it is paired. SSH is never
// gated: it authenticates with the user's key. system:hello takes an optional
// `{ token }` and its reply gained `pairing`, optional, so an older engine reads
// as an open box. pairing:* are new methods; an older box answers "Unknown
// method" (FEATURE_MIN_VERSION.pairing).
// v30: cross-box. A box can hold links to other boxes, each a pairing of kind
// "box" on the box it reaches, so its agents list and message tasks there and its
// Lead reaches them. A link sees task updates only and may only read the board
// and send messages. New methods: peers:list, peers:sendFromBox, links:list,
// links:set (an older box answers "Unknown method", FEATURE_MIN_VERSION.crossBox).
// system:hello takes `{ link: true }` from a link, and its reply gained `wsAddr`,
// optional. Settings gained `client.crossBox`, read by the desktop alone.
// v31: OpenAI keys. Credentials gained `openAiApiKey` (credentials:update) and
// `openAi` (the status, optional, so an older engine reads as "no key"), and
// settings gained `engine.decisionModel` and `engine.openAiTextModel` and the
// `openai` text model. An older engine stores the key and the settings and
// never reads them, so a box needs this version to use an OpenAI key.
// v32: voice calls with the Lead. lead:callActive tells a box's Lead that the
// user is on a call with it: while one is, its messages and answers to tasks
// (send_message, answer_question) wait as permission cards for the user's tap,
// since a call's words are transcribed and may not have been meant for it. A new
// method only: a v31 box answers "Unknown method", and the desktop offers no call
// when its Lead lives there (FEATURE_MIN_VERSION.leadCall).
export const PROTOCOL_VERSION = 32;

/**
 * A decision an agent is waiting on (ask_user). Answered from any client with
 * tasks:answerQuestion; the answer reaches the agent as a message from the user.
 */
export interface TaskQuestionDTO {
	/** An answer names the question it answers, so it can't land on a newer one. */
	id: string;
	text: string;
	/** The choices' labels, always filled: a client that knows nothing of
	 *  `choices`, `select` or `blocks` still offers these as buttons. */
	options: string[];
	/** Whether a typed answer is accepted (always, when there are no options). */
	allowText: boolean;
	askedAt: number;
	/** The options with what the agent knows about each, same order as `options`.
	 *  Absent when the agent gave plain labels. */
	choices?: QuestionChoiceDTO[];
	/** "many": a checklist, answered with the labels the user left ticked.
	 *  Absent means "one". */
	select?: "one" | "many";
	/** "permission": not something the agent asked with ask_user but Claude Code
	 *  asking to use a tool (permissions.ts). Answered the same way, with its
	 *  options; it can also be answered in the task's terminal, which wins if
	 *  that comes first.
	 *  "askUserQuestion": Claude Code's own question tool, held the same way and
	 *  shown as the question it is, one card per question of the call; a
	 *  client with no special handling draws it like an ask_user question. */
	kind?: "permission" | "askUserQuestion";
	/** The task's page (TaskDTO.page) drawn with this question: the agent laid
	 *  the decision out in HTML, and the page's own buttons can answer. Only
	 *  while TaskDTO.page still has this id; a newer page replaces it. */
	pageId?: string;
}

/**
 * A task or loop an agent proposed for the user to start (the propose_task and
 * propose_loop board tools). Nothing is created until the user confirms it in
 * the New task or New loop dialog, filled in from these fields and editable.
 * Cleared with tasks:clearProposal once created or dismissed; the agent is not
 * told either way. While any is pending the card is held in Needs You.
 */
export interface TaskProposalDTO {
	/** Names the proposal to clear, so a click can't clear a newer one. */
	id: string;
	kind: "task" | "loop";
	/** The task's (or loop's) name. */
	name: string;
	/** The new agent's first instruction; for a loop, what every run does. */
	prompt: string;
	/** Why the agent proposes it, in a line or two, shown with the dialog. */
	reason?: string;
	/** Which coding agent; absent leaves it to the dialog's default. */
	agentId?: string;
	/** The agent suggests Auto mode. Only a suggestion: clients show it and
	 *  leave the toggle off, since an agent's input is not the user's word. */
	yolo?: boolean;
	/** A loop's schedule: every so many minutes, or every day at `dailyAt`
	 *  ("HH:MM", the user's local time). Exactly one is set on a loop. */
	everyMinutes?: number;
	dailyAt?: string;
	/** A loop's follow-up, sent once after each run's first reply. */
	followUp?: string;
	proposedAt: number;
}

/**
 * An HTML page an agent made for the user (show_page, or ask_user's `page`):
 * a dashboard, a comparison, a report. One per task; a new one replaces it.
 * The HTML itself is read with tasks:page, so the board's task list stays small.
 */
export interface TaskPageDTO {
	id: string;
	title: string;
	at: number;
	/** Came with an ask_user question (its `page`), not from show_page: the
	 *  question's card draws it, and once the question ends it is history, so
	 *  the task panel never opens it by itself. Absent from engines before it. */
	fromQuestion?: boolean;
}

/** tasks:page: the task's page with its HTML, as the agent wrote it. */
export interface TaskPageContentDTO extends TaskPageDTO {
	html: string;
}

/** One option of a question, as a card (select one) or a checklist row (many). */
export interface QuestionChoiceDTO {
	label: string;
	/** What it means or what happens: the consequence, in a line or two. */
	description?: string;
	pros?: string[];
	cons?: string[];
	risk?: "low" | "medium" | "high";
	/** The agent's pick; at most one. */
	recommended?: boolean;
	/** For a checklist: ticked to begin with. */
	checked?: boolean;
}

/** A task's last finished turn, as the Lead chat reads it (tasks:lastReply). */
/** A diff with fewer files reads fine as a flat list, so the Changes view
 *  doesn't offer steps for it (the median PR on Ateam's own repo is 4 files). */
export const CHANGE_STEPS_MIN_FILES = 8;

/** One step of a task's change: a reason, and the files that carry it out. */
export interface ChangeStepDTO {
	title: string;
	/** Why the step was needed, from the agent's own account of the work. */
	why: string;
	files: { path: string; note: string }[];
}

/**
 * A task's diff told as steps (tasks:changeSteps). An index into the diff, never
 * a copy of it: every path opens the same live file diff the flat list does.
 */
export interface ChangeStepsDTO {
	/** The last steps written, or null before the first. They may describe an
	 *  older diff: see `current`. */
	steps: ChangeStepDTO[] | null;
	/** Changes the agent's account of the work never mentions. */
	unexplained: { path: string; note: string }[];
	/** Whether the steps describe the diff as it is now. */
	current: boolean;
	madeAt: number | null;
	/** New steps are being written; ask again for them. */
	working: boolean;
	/**
	 * Why none will be written for the diff as it is now: `small`, too few files
	 * for steps to help; `agent`, the task's agent can't write them (OpenCode);
	 * `failed`, the last try gave nothing usable, a missing agent CLI included
	 * (tried again after a while, or once the diff changes).
	 */
	unavailable: "small" | "agent" | "failed" | null;
}

export interface TaskLastReplyDTO {
	text: string;
	at: number;
}

/**
 * The engine version each SHAPE-SENSITIVE feature needs, and the reason why.
 *
 * A skewed box is held rather than refused, so something has to decide what a
 * client may still ask of it. Two kinds of change need two answers, and only one
 * of them belongs here:
 *
 *   a NEW METHOD needs nothing. An older engine answers "Unknown method", which
 *   rejects that one call and fails that one feature. v2, v3 and v4 were all of
 *   this kind, which is why they need no entry.
 *
 *   a CHANGED SHAPE on a method that still exists is the dangerous one. The call
 *   succeeds and returns something the client misreads, and no default can paper
 *   over it: a client cannot invent a field the engine never computed. Those get
 *   an entry, and the feature is switched OFF below that version.
 *
 * Adding a shape change means adding a line here. That is the point: the version
 * history below already describes what each bump broke, in prose no code reads,
 * so nothing forced a bump to answer "what stops working under this?". Now it does.
 */
export const FEATURE_MIN_VERSION = {
	/** v6 turned CleanupCandidate from a flat row into `{ task: TaskDTO, recommended }`.
	 *  The dialog dereferences `.task` on every row, so a v5 engine's reply is not a
	 *  degraded dialog, it is a thrown TypeError. */
	cleanup: 6,
	/** v8 added LoopDTO.followUp AND the turn-end delivery behind it. A v7 engine
	 *  accepts the config key and silently never acts on it, so the honest move is
	 *  to hide the field rather than let it look saved. */
	followUps: 8,
	/** v9 added the repo list AND `register({ createRemote })`. A v8 box answers the
	 *  first with "Unknown method" and swallows the second, so both halves of "add a
	 *  project from GitHub" are hidden rather than half-working. */
	githubProjects: 9,
	/** v10 added LoopDTO.yolo — a loop run launching its agent permission-free. A v9
	 *  engine stores the config key and silently launches permission-prompted, which
	 *  for an unattended scheduled loop means it wedges on the first permission ask.
	 *  Hide the toggle rather than let it look saved. */
	loopAutoMode: 10,
	/** v13 added calendar schedules (LoopDTO.cron + timeZone). A v12 engine ignores
	 *  them on update and keeps the old interval, so the save would look applied and
	 *  not be. Hide "Every day at" rather than let it look saved. */
	loopSchedules: 13,
	/** v14 added `engine.loopsPaused`. A v13 engine takes the settings push and
	 *  keeps starting loops, so the Loops banner names it as not paused rather
	 *  than let "All loops are paused" cover it. */
	loopsPause: 14,
	/** v24 added the box's own Lead chat (LEAD_RPC). An older box answers every
	 *  call "Unknown method", so the phone offers to update the box instead. */
	lead: 24,
	/** v28 added lead:react to a box's Lead. An older box answers "Unknown
	 *  method", so the desktop hides the emoji answer when its Lead lives there. */
	leadReact: 28,
	/** v32 added lead:callActive, which holds a box Lead's messages to tasks for
	 *  the user's tap during a call. An older box would act on them unasked, so
	 *  the desktop offers no call when its Lead lives there. */
	leadCall: 32,
	/** v29 added pairing:* and the lock on a box's network port. An older box is
	 *  always open: clients say so instead of offering to lock it. */
	pairing: 29,
	/** v30 added links between boxes (links:*, peers:list, peers:sendFromBox). An
	 *  older box is left out of them until it is updated. */
	crossBox: 30,
	/** v25 added githubAccess:*. An older box answers "Unknown method", so clients
	 *  point at its terminal (gh auth login) and at Update box instead. */
	githubAccess: 25,
} as const;

export type GatedFeature = keyof typeof FEATURE_MIN_VERSION;

/** Whether an engine on `engineVersion` can serve `feature` in a shape this client reads. */
export function boxSupports(feature: GatedFeature, engineVersion: number): boolean {
	return engineVersion >= FEATURE_MIN_VERSION[feature];
}

export type KanbanColumn = "todo" | "running" | "needs_attention" | "review" | "merged";

export type AgentStatus = "idle" | "running" | "awaiting_input" | "stopped";

/** State of the branch's pull request, when one exists. */
export type PrState = "open" | "merged" | "closed";

/**
 * Why a task is where it is, in urgency order — the done-vs-ongoing judgment
 * from worktree-triage. Lives here (not in @ateam/server) because it rides on
 * every TaskDTO: the classifier is server-side, but desktop, mobile, and any
 * client on the far end of the RPC all render it.
 */
export type TriageBucket =
	| "active"
	| "stalled"
	| "uncommitted"
	| "open_pr"
	| "unmerged_no_pr"
	| "merged_unfinished"
	| "merged_done"
	| "orphan"
	| "not_started";

/** One task's triage verdict, computed from its row on every DTO mapping. */
export interface TaskTriage {
	bucket: TriageBucket;
	/** Is this task actually finished? */
	done: boolean;
	/** Human-readable justification, shown on the card. */
	reason: string;
}

/** Position of a task in the merge queue; null when not queued. */
export type MergeStatus = "queued" | "updating" | "merging" | "conflict";

export interface ProjectDTO {
	id: string;
	repoPath: string;
	name: string;
	defaultBranch: string | null;
	githubOwner: string | null;
	githubName: string | null;
	color: string | null;
}

/** The repo a project is a clone of, as an agent reads it: GitHub's `owner/name`
 *  when the project has a GitHub remote, else the clone's path on its machine.
 *  A project's name can differ from its repo's, so the name alone does not say. */
export function projectRepo(
	p: Pick<ProjectDTO, "repoPath" | "githubOwner" | "githubName">,
): string {
	return p.githubOwner && p.githubName ? `${p.githubOwner}/${p.githubName}` : p.repoPath;
}

/**
 * A GitHub repo the engine's `gh` can reach, for picking one to add as a project.
 * Deliberately thin: what a picker renders, plus the URL to clone. `fullName` is
 * `owner/name`, which is also the cross-engine identity a project is merged by.
 */
export interface RemoteRepoDTO {
	fullName: string;
	cloneUrl: string;
	private: boolean;
	/** ISO 8601. The list arrives most-recently-pushed first, which is the order a
	 *  picker wants: the repo you were last working in is the one you want next. */
	pushedAt: string;
}

/** Options for projects:register. */
export interface RegisterProjectOptions {
	/** Run `git init` + an initial commit first (after asking). */
	init?: boolean;
	/** Create a GitHub repo for it and set it as `origin`, so a project born on one
	 *  engine can reach another. Only meaningful with `init`; ignored by a pre-v9
	 *  engine, so gate it on FEATURE_MIN_VERSION.githubProjects. */
	createRemote?: { name: string; private: boolean };
}

export interface GitStatusSnapshot {
	ahead: number;
	behind: number;
	/** Files in the task's diff against its base that haven't landed there:
	 *  committed work included, so NOT an uncommitted count. */
	dirty: number;
	/** What `git status` lists: work that only exists in the worktree. Untracked
	 *  leftovers (agent-tool folders, screenshots, scratch) don't count. Absent
	 *  from a snapshot written before it existed, which reads as "not known"
	 *  (never as clean or dirty). A read-only addition, so no protocol bump. */
	uncommitted?: number;
	/** Lines added and removed across the `dirty` files: the size of the work,
	 *  the task's `+N -M`. Absent from a snapshot written before these fields
	 *  existed (stored rows, older engines), which reads as "not known yet": a
	 *  read-only addition, so no protocol bump. */
	additions?: number;
	deletions?: number;
	updatedAt: number;
}

export interface GithubIssueDTO {
	number: number;
	title: string;
	body: string;
	url: string;
	author: string;
	labels: string[];
}

export interface GithubIssuesDTO {
	issues: GithubIssueDTO[];
	syncedAt: number | null;
	error: string | null;
}

export interface CreateGithubIssueInput {
	title: string;
	body: string;
	/** Images uploaded to GitHub's attachment store with the issue. The body refers
	 * to one as `![alt](./<name>)`, which is rewritten to its asset URL; one it never
	 * mentions is appended. Optional: issues route to the desktop's own local engine,
	 * so no older engine can receive this and silently drop it. */
	images?: GithubIssueImage[];
}

export interface GithubIssueImage {
	/** File name the body refers to, e.g. "image-2.png". */
	name: string;
	base64: string;
}

export interface CreateIssueTaskInput {
	projectId: string;
	name: string;
	issueNumber: number;
	description: string;
	agentId?: string;
}

export interface TaskDTO {
	/** Canonical source issue URL; absent on older engines. */
	issueUrl?: string | null;
	id: string;
	projectId: string;
	name: string;
	description: string | null;
	slug: string;
	branch: string;
	baseBranch: string;
	worktreePath: string;
	column: KanbanColumn;
	agentStatus: AgentStatus | null;
	agentId: string | null;
	/**
	 * The agent behind each session that is live in this task right now, oldest
	 * first — "shell" for a plain terminal. `agentId` above is the last agent
	 * launched here and outlives its session; this is what is actually running,
	 * so a task holding two agents and a shell shows all three. Empty when
	 * nothing runs. Absent from an engine older than this field, which reads
	 * the same as empty — a read-only addition, so no protocol bump.
	 */
	agentIds?: string[];
	/** Merge-queue position; null when the task is not queued to merge. */
	mergeStatus: MergeStatus | null;
	prNumber: number | null;
	prUrl: string | null;
	/** open / merged / closed, or null when the branch has no PR. */
	prState: PrState | null;
	gitStatus: GitStatusSnapshot | null;
	/** Last agent/lifecycle activity (falls back to row update time). */
	lastEventAt: number | null;
	isUnread: boolean;
	/**
	 * The worktree's dependencies are still being copied in. Ephemeral and
	 * runtime-only — derived from the engine's in-flight seed map, never stored,
	 * so a crash mid-seed cannot leave a task permanently "preparing".
	 */
	preparing: boolean;
	/** Model-assigned topic tags; null when none were generated (the client
	 *  falls back to deriving them from the task's text). */
	tags: string[] | null;
	/**
	 * Parked on an outside party. Both null when not waiting. While `waitingUntil`
	 * is in the future the card sinks; once it passes, the engine files the card
	 * in Needs You and it outranks everything until someone acts. Nullable on
	 * purpose: an older engine simply omits them (see tolerate.ts).
	 */
	waitingReason: string | null;
	waitingUntil: number | null;
	/** When the wait resurfaced the card; null while pending. A client notifies
	 *  once per (task, waitingFiredAt). */
	waitingFiredAt: number | null;
	/** When the task's agent first drove the box's browser; null while it never
	 *  has, and on an engine older than v17. Clients show the browser beside the
	 *  task's terminal only once it is set. */
	browserUsedAt: number | null;
	/** When the task was archived; null while it is on the board, and on an
	 *  engine older than v18. tasks:list never returns an archived task. */
	archivedAt: number | null;
	/** What the task's agent asked the user (the ask_user board tool) and is
	 *  waiting on; null when nothing is pending. Absent on an engine older than
	 *  v19, which reads the same. */
	question?: TaskQuestionDTO | null;
	/** When the agent last finished a turn with a reply (read it with
	 *  tasks:lastReply); null until one has. Absent on an engine older than v19. */
	lastReplyAt?: number | null;
	/** The page the task's agent made for the user (show_page); null when none.
	 *  Absent on an engine older than v20. */
	page?: TaskPageDTO | null;
	/** Tasks and loops the task's agent proposed and the user has not yet
	 *  created or dismissed, oldest first; null or empty when none. Absent on an
	 *  engine older than v22. */
	proposals?: TaskProposalDTO[] | null;
	/** A sentence or two on what the task is about and where it stands, written
	 *  a few minutes after its agent goes quiet; null until the first one, and
	 *  absent on an engine older than v23. */
	summary?: string | null;
	/** Done-vs-ongoing verdict, derived from this row (no git/gh calls). */
	triage: TaskTriage;
}

/** The outcome of installing an agent CLI on an engine's machine. */
export interface InstallAgentDTO {
	agentId: string;
	/** Whether the binary is now on the login PATH the engine spawns from. */
	available: boolean;
	/** The one-time OAuth the user runs themselves, when the agent has one. */
	loginCommand?: string;
}
/** What a task waits for and until when; null clears the wait. */
export type TaskWait = { reason: string; until: number } | null;

export interface AgentDTO {
	id: string;
	label: string;
	description: string;
	available: boolean;
}

export interface SessionDTO {
	id: string;
	taskId: string;
	agentId: string;
	terminalId: string;
	/**
	 * The agent harness's own conversation id, when it is known — the handle
	 * `pty.restoreSession` resumes by. Null for a shell, and for a conversation
	 * whose id the harness never told us.
	 */
	agentSessionId: string | null;
	status: AgentStatus;
	cwd: string;
	/**
	 * When this session last reported a hook event, i.e. when it last did
	 * something. Lets a view with several of a task's sessions in hand open on
	 * the one that just moved rather than merely the newest one.
	 *
	 * Optional, and deliberately NOT a protocol bump: a box that predates the
	 * field simply omits it, and a client that sees none falls back to the
	 * newest session — exactly what every client did before. There is no
	 * feature to gate off, only a nicety that quietly doesn't apply, and
	 * marking every older box skewed over a tab default would cost more than
	 * it tells anyone.
	 */
	lastEventAt?: number | null;
}

export interface DiffFileDTO {
	path: string;
	additions: number;
	deletions: number;
	binary: boolean;
	untracked: boolean;
}

export interface DiffResultDTO {
	baseBranch: string | null;
	files: DiffFileDTO[];
}

export interface UpdateResultDTO {
	status: "clean" | "conflicts";
	conflicts: string[];
}

export interface MergeResultDTO {
	prNumber: number | null;
	prUrl: string | null;
	localMainUpdated: boolean;
	localMainStrategy: "direct-ref" | "ff-worktree" | "skipped";
	reason?: string;
}

export type MergeStrategy = "merge" | "squash" | "rebase";
export type UpdateStrategy = "merge" | "rebase";

/**
 * User settings: `~/.ateam/settings.json`, hand-editable (server/settings-file.ts).
 * One schema, two readers. `client` is read by the desktop on the machine
 * running it; `engine` by whichever engine runs the work, so a box reads its
 * own file; `box` by that one box's engine, never synced from a Mac. Only keys
 * with a reader exist — a setting nothing reads is a lie.
 */
export interface EngineSettings {
	/** Agent a new task launches with when the composer doesn't say. */
	defaultAgentId: string;
	/** How "Merge via PR" lands the branch. */
	defaultMergeStrategy: MergeStrategy;
	/** How "Update from base branch" brings the base in. */
	defaultUpdateStrategy: UpdateStrategy;
	/** Delete the remote branch once its PR has merged. */
	deleteRemoteBranchOnMerge: boolean;
	/**
	 * Every loop's schedule on this engine is off: a scheduled tick is skipped,
	 * but Run now still runs. Read on every tick, so a hand edit takes effect at
	 * the next one.
	 */
	loopsPaused: boolean;
	/**
	 * Let the box sleep once nobody has used it for this many minutes (an agent
	 * working, typing in a terminal, its Lead chat); 0 never does. Only an engine on a provider that can put its box to sleep reads
	 * it (packages/server/src/sleep), so a Mac or a plain VPS ignores it. A sleeping
	 * box keeps its sessions, and the next connection wakes it.
	 */
	idleSleepMinutes: number;
	/**
	 * Archive a task that is still open once nothing has happened in it for this
	 * many days; 0 never does. Archived tasks leave every task list but keep their
	 * worktree, and any activity in one brings it back. See server/archive.ts.
	 */
	archiveAfterDays: number;
	/**
	 * What writes the title of a task started without a name, its tags, and the
	 * summary of where each task stands once its agent goes quiet. `auto`: an
	 * OpenRouter model when that key is set, else an OpenAI model when that key
	 * is, otherwise Claude Code (Haiku, headless, on the user's own
	 * subscription). `openrouter` and `openai` need their key; `off` writes none
	 * of them. See server/text-model.ts.
	 */
	textModel: TextModelChoice;
	/** The OpenRouter model id used whenever OpenRouter writes that text. */
	openRouterTextModel: string;
	/** The OpenAI model id used whenever OpenAI writes that text. */
	openAiTextModel: string;
	/**
	 * Which decision model answers the board's and the grammar filter's yes/no
	 * questions. `auto`: Jev on OpenRouter when that key is set, else Luna on
	 * OpenAI when that key is. `openrouter` and `openai` need their key; `off`
	 * asks neither, and a finished turn always goes to Review. See
	 * server/decision-model.ts.
	 */
	decisionModel: DecisionModelChoice;
}
export type TextModelChoice = "auto" | "openrouter" | "openai" | "claude" | "off";
export type DecisionModelChoice = "auto" | "openrouter" | "openai" | "off";
/** `engine.openRouterTextModel` out of the box, and whenever it is left empty. */
export const DEFAULT_OPENROUTER_TEXT_MODEL = "anthropic/claude-haiku-5.5";
/** `engine.openAiTextModel` out of the box, and whenever it is left empty:
 *  OpenAI's small model, priced as Haiku 5.5 is. */
export const DEFAULT_OPENAI_TEXT_MODEL = "gpt-6-luna";
export interface ClientSettings {
	/** Fetch an update in the background instead of asking first. */
	autoDownloadUpdates: boolean;
	/**
	 * This Mac's `engine.*` is the source of truth: pushed to every box as it
	 * connects and again on every change, so a fresh box inherits your choices.
	 * Off: each machine keeps its own file and the page edits whichever
	 * environment is selected. `client.*` never syncs either way.
	 */
	syncEngineSettingsToBoxes: boolean;
	/**
	 * With a decision model (`engine.decisionModel`: Jev on OpenRouter or Luna
	 * on OpenAI), it decides which of the grammar check's issues are real
	 * mistakes and hides the rest. Sends the draft prompt to that provider while
	 * you type. No key: every issue shows, as with it off. The name predates
	 * OpenAI and stays, so a saved choice keeps applying.
	 */
	filterGrammarWithJev: boolean;
	/**
	 * Skills shown as buttons on each agent terminal's toolbar, by name
	 * (`research-topic`, `greybeard:pressure-test`), in order. A name the
	 * terminal's agent can't see is skipped there. Null until first chosen:
	 * the desktop then fills it from the skills you type most and saves it,
	 * so the buttons stay put rather than following usage.
	 */
	pinnedSkills: string[] | null;
	/**
	 * The desktop's colours. Read and written by the desktop's main process on
	 * this Mac only (never routed to a box, never synced), so every window
	 * opens in it before its first paint.
	 */
	theme: ThemeId;
	/**
	 * Where the desktop's main Lead chat lives: a box's alias, whose own Lead
	 * (the one the phone talks to when it picks that box) is then the chat, or
	 * null for this Mac. Set from Settings → Boxes; cleared when that box is
	 * forgotten.
	 */
	leadBox: string | null;
	/**
	 * Whether the boxes this Mac holds reach each other (cross-box, v30): each
	 * pair gets a link, a pairing of kind "box", that reads the board and sends
	 * messages. Off until the user turns it on in Settings → Boxes.
	 */
	crossBox: boolean;
}
export type ThemeId = "dark" | "light" | "classic";

/** Where a skill came from, in the order its agent prefers them. */
export type SkillScope = "personal" | "project" | "plugin" | "command" | "system";

/** One skill the agent in a terminal can invoke (skills:list). */
export interface SkillDTO {
	/** As the agent knows it: `research-topic`, `greybeard:pressure-test`. */
	name: string;
	/** What to type to run it in that agent: `/name` (Claude, OpenCode), `$name` (Codex). */
	command: string;
	description: string;
	scope: SkillScope;
	/** The SKILL.md (or command file) it was read from, on the engine's machine. */
	path: string;
	/** Times typed in the last 30 days, from the agent's own prompt history. Orders the menu. */
	uses: number;
	/**
	 * Times sent in this terminal's own agent conversation, from its transcript:
	 * so you can see you already ran it here. 0 when the conversation's
	 * transcript can't be found (OpenCode, or an id the agent never reported).
	 */
	sessionUses: number;
}

/** skills:link's answer: each agent folder the skill was (or would be) linked into. */
export interface SkillLinkResult {
	name: string;
	/** The skill folder the links point at. */
	source: string;
	description: string;
	links: {
		/** The link itself, e.g. ~/.claude/skills/<name>. */
		path: string;
		/** Where its folder really is: a dotfiles repo when ~/.claude/skills is a link. */
		realDir: string;
		/** `exists`: already linked to this same skill, so nothing to write. */
		status: "create" | "exists";
	}[];
}
/** What one box is, set on that box (from the phone's box form or the desktop's box
 *  page) and never pushed by a Mac's settings sync, which carries `engine` only. */
export interface BoxSettings {
	/**
	 * Never let this box sleep: it stays up and billed around the clock, and nothing
	 * needs a provider key to wake it. Off, it sleeps after `engine.idleSleepMinutes`
	 * like any other. Only an engine on a provider that sleeps boxes reads it.
	 */
	alwaysOn: boolean;
}
export interface AteamSettings {
	version: number;
	client: ClientSettings;
	engine: EngineSettings;
	box: BoxSettings;
}
export interface SettingsPatch {
	client?: Partial<ClientSettings>;
	engine?: Partial<EngineSettings>;
	box?: Partial<BoxSettings>;
}
/**
 * `settings:get`'s answer: what is in force, where it came from, and a warning
 * when the file could not be used as written (it was set aside as `.bad` and
 * the defaults apply) — surfaced, never swallowed, so a hand edit cannot
 * vanish without a trace.
 */
export interface SettingsResult {
	settings: AteamSettings;
	path: string;
	warning?: string;
	/**
	 * Filled in by the desktop, which alone knows the boxes. `machine` is whose
	 * file this is (null = this Mac); `syncedTo` lists the boxes that took this
	 * Mac's `engine.*` just now, present only while sync is on.
	 */
	machine?: string | null;
	syncedTo?: string[];
	/**
	 * Connected boxes whose LAST push of `engine.*` failed, with why — an
	 * engine older than settings sync being the ordinary reason. Reported so
	 * "synced" is never claimed for a box that did not take it.
	 */
	syncFailed?: { alias: string; reason: string }[];
}

/**
 * Secrets live apart from settings: `~/.ateam/credentials.json` (0600) on the
 * engine's machine (server/credentials-file.ts). `settings.json` is meant to be
 * shared and `settings:get` hands the whole file to every client; a key must
 * never travel either way. So the wire carries whether a key is set and its
 * last four characters, never the key.
 */
export interface CredentialStatus {
	set: boolean;
	/** Last four characters, for recognising which key it is. */
	hint?: string;
	/** `env` when an environment variable supplies it, which the file cannot override. */
	source?: "file" | "env";
}
export interface CredentialsResult {
	openRouter: CredentialStatus;
	/** Absent from an engine older than v31, which can't use an OpenAI key. */
	openAi?: CredentialStatus;
	path: string;
	/** As SettingsResult: filled in by the desktop while sync is on. */
	syncedTo?: string[];
	syncFailed?: { alias: string; reason: string }[];
}
/** A key to store, or null to remove it. */
export interface CredentialsPatch {
	openRouterApiKey?: string | null;
	openAiApiKey?: string | null;
}

/**
 * Result of enqueuing a merge. The merge runs serialized per base branch, so
 * the call resolves only once this task's turn completes (or it parks on a
 * genuine conflict / busy / error).
 */
export type MergeEnqueueDTO =
	| { ok: true; prNumber: number | null; prUrl: string | null }
	| { ok: false; reason: "conflict"; conflicts: string[] }
	| { ok: false; reason: "busy" }
	| { ok: false; reason: "not-mergeable"; message: string }
	| { ok: false; reason: "error"; message: string };

/**
 * One human- and agent-readable line (or a few) for a merge outcome. The gh
 * shim prints it into the agent's terminal and the desktop shows it as a toast,
 * so a merge that did not happen is never silent on either surface.
 */
export function describeMergeResult(r: MergeEnqueueDTO): string {
	if (r.ok) return r.prNumber != null ? `Ateam: merged PR #${r.prNumber}.` : "Ateam: merged.";
	switch (r.reason) {
		case "conflict":
			return [
				"Ateam: not merged. Absorbing the latest base branch hit conflicts in:",
				...r.conflicts.map((f) => `  ${f}`),
				"The merge (or rebase) is left in progress in this worktree. Resolve the conflicts, finish it (git add + git commit --no-edit, or git rebase --continue), then run 'gh pr merge' again.",
			].join("\n");
		case "busy":
			return "Ateam: this task's merge is already queued or running; the board shows its status. Do not re-run 'gh pr merge'.";
		case "not-mergeable":
			return `Ateam: not merged: ${r.message}.`;
		case "error":
			return `Ateam: merge failed: ${r.message}`;
	}
}

/** A Loop (periodic reconciler) as shown in the Loops panel. */
export interface LoopDTO {
	id: string;
	definitionId: string;
	title: string;
	description: string;
	scope: "global" | "per_task";
	scopeKey: string | null;
	/** "builtin" loops are code-defined; "user" loops are template instances. */
	kind: "builtin" | "user";
	templateId: string | null;
	projectId: string | null;
	enabled: boolean;
	/** "fixed" runs every `intervalMs`; "cron" runs on the `cron` calendar in `timeZone`. */
	cadence: "fixed" | "self_paced" | "cron";
	/** The prompt each run hands the agent (agent-session loops). */
	prompt: string | null;
	/** Which coding agent each run launches (agent-session loops). */
	agentId: string | null;
	/** Optional second turn, sent once after the agent's first reply. */
	followUp: string | null;
	/** Whether each run launches its agent permission-free (the composer's Auto mode). */
	yolo: boolean | null;
	/** The loop's one persistent task — every run is a fresh session in it. */
	taskId: string | null;
	intervalMs: number | null;
	/** 5-field cron, for `cadence: "cron"` (see dailyCron). Null otherwise. */
	cron: string | null;
	/** IANA zone the cron is read in: whoever set it, so a UTC box still fires at their 9:00. */
	timeZone: string | null;
	lastRunAt: number | null;
	nextRunAt: number | null;
	lastStatus: "ok" | "error" | "done" | null;
	lastSummary: string | null;
	lastError: string | null;
	runs: number;
}

/** The cron a "daily at HH:MM" schedule is stored as: "09:30" -> "30 9 * * *". */
export function dailyCron(time: string): string {
	const [h, m] = time.split(":").map(Number);
	return `${m} ${h} * * *`;
}

/** "HH:MM" when `cron` is a daily schedule (the only calendar the UI writes), else null. */
export function dailyTimeOf(cron: string | null): string | null {
	const m = cron?.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
	if (!m) return null;
	const [, min = "", hour = ""] = m;
	return `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
}

/**
 * How a loop's schedule reads: "every 15m", "every 2h", "daily 09:00". The zone is
 * named only when it is not the viewer's own, since a bare 09:00 means "yours".
 */
export function loopScheduleLabel(
	loop: Pick<LoopDTO, "intervalMs" | "cron" | "timeZone">,
	viewerTimeZone?: string,
): string {
	if (loop.cron) {
		const at = dailyTimeOf(loop.cron);
		const zone = loop.timeZone && loop.timeZone !== viewerTimeZone ? ` ${loop.timeZone}` : "";
		return at ? `daily ${at}${zone}` : `cron ${loop.cron}${zone}`;
	}
	if (loop.intervalMs == null) return "";
	const min = Math.round(loop.intervalMs / 60_000);
	return min < 60 || min % 60 !== 0 ? `every ${min}m` : `every ${min / 60}h`;
}

/** A loop template the user can instantiate, with its configurable params. */
export interface LoopTemplateParamDTO {
	key: string;
	label: string;
	type: "number" | "boolean" | "string";
	default: number | boolean | string;
	help?: string;
}
export interface LoopTemplateDTO {
	id: string;
	title: string;
	description: string;
	params: LoopTemplateParamDTO[];
}

/** Input for creating a user loop from a template. */
export interface CreateLoopInput {
	templateId: string;
	name: string;
	projectId?: string;
	config?: Record<string, unknown>;
	/** Run every this many ms. Give this OR `cron`. */
	intervalMs?: number;
	/** Run on this 5-field cron, read in `timeZone` (required with it). Needs v13. */
	cron?: string;
	timeZone?: string;
	enabled?: boolean;
}

/**
 * Input for editing an existing user loop in place. Only the given fields
 * change; `config` is merged over the stored config (so runtime keys like
 * lastTaskId survive). The loop's project — and with it its environment — is
 * fixed at creation: moving engines means delete + recreate. No projectId here
 * also keeps the aggregate routing this call by the loop's own id.
 */
export interface UpdateLoopInput {
	id: string;
	name?: string;
	/** Switch to (or re-time) an interval schedule. Give this OR `cron`; neither keeps the schedule. */
	intervalMs?: number;
	/** Switch to (or re-time) a calendar schedule, with `timeZone`. Needs v13. */
	cron?: string;
	timeZone?: string;
	config?: Record<string, unknown>;
}

export interface CleanupItem {
	id: string;
	name: string;
	branch: string;
}
export interface CleanupSkip extends CleanupItem {
	reason: string;
}
export interface CleanupReport {
	removed: CleanupItem[];
	kept: CleanupSkip[];
}

/**
 * The connect-time handshake reply (`system:hello`): the engine's protocol
 * version for the compatibility check, and which agents its box actually has.
 */
export interface SystemInfo {
	protocolVersion: number;
	/** Ids of agents installed + available on the engine's machine. */
	agents: string[];
	/** The Ateam release the engine was built from ("0.1.80"). Absent from engines
	 *  before it was reported, null from one run from source. A release can change
	 *  the engine without a protocol bump, so clients compare this to offer updates. */
	release?: string | null;
	/** How this connection may use the box (v29; absent from an older engine,
	 *  which is always open). */
	pairing?: PairingState;
	/** The address the box's network port listens on (`<host>:<port>`), or null
	 *  when it has none (v30; absent before). What other boxes link to. */
	wsAddr?: string | null;
	/** The provider that puts this box to sleep, the box's name there, and whether it
	 *  lets the box sleep now; null on a box no provider sleeps. Absent from engines
	 *  before it was reported, and while the engine is still finding out. A client that
	 *  saved the box by its address alone (a pairing QR, the IP typed in) fills in what
	 *  to wake it through (wake.ts reportedWake), instead of dialling a sleeping box
	 *  until it times out. */
	provider?: ProviderReport | null;
}

/** A connection's standing with a box's lock (pairing:*, v29).
 *  - trusted: over SSH, which authenticated with the user's key.
 *  - paired: a paired device's token was given.
 *  - open: the box isn't locked, so anyone who can reach its port may use it.
 *  - needed: the box is locked and this connection isn't paired: it gets no
 *    events and every call but hello and pairing:redeem is refused. */
export interface PairingState {
	state: "trusted" | "paired" | "open" | "needed";
	/** The paired device this connection is, when it is one. */
	device?: string;
}

/** The refusal a locked box gives an unpaired connection. Clients match it to
 *  offer pairing instead of showing it as an error. */
export const NEEDS_PAIRING = "This box needs pairing.";

/** One device paired with a box. */
export interface PairedDeviceDTO {
	id: string;
	/** What the user called it ("iPhone", "MacBook Pro"). */
	label: string;
	kind: "desktop" | "phone" | "box";
	createdAt: number;
	lastUsedAt: number | null;
}

/** pairing:status: whether the box is locked, and who is paired. */
export interface PairingStatusDTO {
	locked: boolean;
	devices: PairedDeviceDTO[];
	/** The device the asking connection is, if any. */
	you: string | null;
}

/** A one-time code a new device redeems for its token (pairing:invite). */
export interface PairingInviteDTO {
	code: string;
	expiresAt: number;
}

/** What redeeming a code (or locking an open box) gives the device: its own
 *  token, to keep and send with every hello from now on. */
export interface PairingGrantDTO {
	token: string;
	device: PairedDeviceDTO;
}

/** One link a box holds to another box (links:list, cross-box v30). */
export interface BoxLinkDTO {
	/** What the Mac calls the other box (its alias). */
	name: string;
	/** Where it is reached: `ws://<host>:<port>`. */
	url: string;
	/** connected; connecting (or retrying); unreachable (down, asleep, off the
	 *  tailnet); refused (locked to devices and this link isn't one of them). */
	state: "connected" | "connecting" | "unreachable" | "refused";
	/** Why it isn't connected, in a sentence. */
	reason?: string;
	/** This link's device on the other box, when it is paired there. */
	device: string | null;
}

/** links:set: every link a box should hold, replacing what it held. A link it
 *  holds already (the same url) is kept; a new one, or one given a code, pairs
 *  with that code first (none: an open box, used as it is). */
export interface BoxLinksSetDTO {
	/** What the Mac calls this box: how its agents are named on the others. */
	self: string;
	links: { name: string; url: string; code?: string | null }[];
}

/** An agent on another box, as a message from it names it (peers:sendFromBox). */
export interface RemoteSenderDTO {
	box: string;
	taskId: string;
	name: string;
	/** The agent's label ("Claude Code"). */
	agent: string;
	/** The Lead chat on that box rather than a task's agent. Through a link it is
	 *  weighed as a colleague's request, never as the user's own words. */
	lead?: boolean;
}

/** What `system:update` reports back before the engine goes down to be replaced. */
export interface BoxUpdateStarted {
	/** False when an update was already running: the caller double-tapped, or another
	 *  client got there first. Nothing new was launched. */
	started: boolean;
	/** Where the installer's output is going on the box, so a human can read why it
	 *  failed after the fact. The engine that could have streamed it is the thing
	 *  being replaced, so a file is the only place that survives the restart. */
	logPath: string;
}

// A subdirectory in a remote-fs listing (the repo picker over RPC).
export interface DirEntryDTO {
	name: string;
	/** Absolute path on the engine's machine. */
	path: string;
	/** True when the directory holds a `.git` (a git repo root). */
	isRepo: boolean;
}
/** One directory's worth of subdirectories, for navigating the engine's fs. */
export interface DirListingDTO {
	/** The resolved absolute directory that was listed. */
	path: string;
	/** Its parent directory, or null at the filesystem root. */
	parent: string | null;
	/** Subdirectories, sorted by name. */
	entries: DirEntryDTO[];
}

/**
 * A row in the connections list: an ssh_config alias enriched with Ateam's own
 * last-known metadata for that host. Rendered by the client's connection picker;
 * produced by `@ateam/server`'s `listConnections`. A boundary DTO (server writes,
 * renderer reads), so it lives here rather than in the server package — the
 * ssh_config parse-shape (`SshHost`) and write-shape (`ConnectionRecord`) stay
 * server-internal.
 */
/**
 * How a client opens a connection to a box.
 *
 *   ssh  spawn `ssh <alias> ateam attach --stdio` — OpenSSH owns auth, and the
 *        alias resolves in ~/.ssh/config. The default, and what a box exposes
 *        with no extra listener.
 *   ws   a WebSocket to the box's opt-in listener on its Tailscale address. The
 *        socket carries no auth of its own — the tailnet is the boundary — so it
 *        requires a Tailscale ACL scoping who may reach the port.
 */
export type HostTransport = "ssh" | "ws";

export interface ConnectionDTO {
	/** For `ssh`, the ~/.ssh/config alias. For `ws`, the `host:port` endpoint itself. */
	alias: string;
	transport: HostTransport;
	hostName: string | null;
	serverVersion: string | null;
	/** The engine's release when last reached (SystemInfo.release); null if it didn't say. */
	engineRelease?: string | null;
	agentsAvailable: string[] | null;
	lastSeen: number | null;
	/** Present in ~/.ssh/config right now (vs a saved record since removed from it). */
	inSshConfig: boolean;
	/** We've recorded at least one successful connection (has a saved record). */
	known: boolean;
	/**
	 * A box this app found asleep at launch and so left alone: holding
	 * it would have woken it. Connecting (picking it, or starting a task there)
	 * wakes it. Set only by the desktop, and only until that connect.
	 */
	asleep?: boolean;
	/** Whether the box last said it sleeps when idle (SystemInfo.provider.sleeps);
	 *  false while it's always on, null until it says. */
	sleeps?: boolean | null;
	/** A `ws` box a provider puts to sleep: the provider that wakes it before a
	 *  connect, and the machine's inputs there (see providers.ts). */
	wake?: BoxWake | null;
}

/** Which provider wakes a box, and the box's own inputs for it (its machine name). */
export interface BoxWake {
	id: string;
	box: Record<string, string>;
}

/** What a box says about its provider in system:hello (SystemInfo.provider). */
export interface ProviderReport extends BoxWake {
	/** Whether the engine lets the box sleep when it's idle, right now: false while its
	 *  idle sleep is off (`engine.idleSleepMinutes` 0), when it's always on and a client
	 *  has nothing to wake. Read when the client connects, so it follows the setting. */
	sleeps: boolean;
}

/**
 * One worktree in the cleanup dialog. EVERY task in the project is listed —
 * the old rule (merged + no live session + clean tree) no longer filters the
 * list, it only advises through `recommended`, so the call stays with the user
 * and is made on the factors the whole task carries: last activity, PR state,
 * ahead/dirty counts, triage verdict.
 */
export interface CleanupCandidate {
	/** The task itself, so the dialog can show every deciding factor. */
	task: TaskDTO;
	/** A live PTY session to show/continue, or null if the session ended. */
	terminalId: string | null;
	/** The conservative rule's verdict: safe to sweep. */
	recommended: boolean;
	/** Why it is — or is not — recommended. */
	reason: string;
}

/**
 * One hit from session search: a past agent session that matched, joined back
 * to the task it ran in. `terminalId` is present only when that session's tab
 * is still live, which is what decides whether a click can focus the exact
 * terminal or only open the task.
 */
export interface SessionHitDTO {
	/** The harness's own session id — the handle its resume command takes. */
	sessionId: string;
	agentId: string;
	taskId: string;
	taskName: string;
	branch: string | null;
	terminalId: string | null;
	startedAt: number | null;
	endedAt: number | null;
	/** The user's own words from the matching part of the session. */
	excerpt: string;
	/** The model's one-line reason, when the AI pass ran. */
	why: string | null;
}

// ---- IPC channel names (their own module: see channels.ts) ----
export { CH } from "./channels";

// ---- event payloads ----
export interface PtyDataEvent {
	terminalId: string;
	data: string;
	/**
	 * Monotonic per-session sequence number for this chunk. The snapshot reply
	 * carries the seq of the last chunk it already includes, so a freshly-mounted
	 * view can replay the snapshot first and then apply only the live chunks that
	 * came *after* it — never double-applying bytes the snapshot already has.
	 */
	seq: number;
}
/** A serialized terminal state plus the seq of the last chunk it reflects. */
export interface PtySnapshot {
	data: string;
	seq: number;
}
export interface PtyExitEvent {
	terminalId: string;
	exitCode: number;
}

/**
 * How the host delivered an image attach (utils.attachImages / attachClipboardImage):
 * "ctrlv" — a bitmap is staged on the client clipboard; forward a Ctrl+V so the
 * local agent reads the pixels itself. "paths" — TYPE these paths into the PTY
 * (escaped keystrokes, not a paste) so the agent's typed-path detection attaches
 * them; for a remote agent they are box-side temp files. "none" — nothing to do
 * (cancelled picker, empty clipboard, or no file survived the transfer).
 */
export type AttachDelivery =
	| { mode: "ctrlv" }
	| { mode: "paths"; paths: string[] }
	| { mode: "none" };

/**
 * Outcome of handing a worktree to the user's own editor. `ok: false` carries a
 * reason to show — the editor isn't installed, or the task's engine is reached by
 * a `host:port` endpoint that Remote-SSH can't resolve.
 */
export type OpenInEditorResult = { ok: true } | { ok: false; reason: string };

/**
 * Outcome of bringing up the browser an agent drives. Same shape as
 * `OpenInEditorResult` and deliberately its own name: the reasons differ (no
 * Chrome on this Mac, or a task whose browser lives on a box), and one type
 * named for the editor would read as a copy-paste rather than a decision.
 */
export type OpenBrowserResult = { ok: true } | { ok: false; reason: string };

/**
 * The in-app editor's default port on the engine's machine (code-server). Shared
 * between the engine (which binds it) and the desktop's SSH forward (which is
 * opened at connect time, before the engine is asked) — so both sides must agree.
 * shortcut: a box overriding ATEAM_EDITOR_PORT breaks the ssh path; carry the
 * port in system:hello if that override ever matters.
 */
export const DEFAULT_EDITOR_PORT = 8390;

/**
 * Where a box's browser view (noVNC, from scripts/install-browser.sh) answers, on
 * the box's loopback. Shared for the same reason as DEFAULT_EDITOR_PORT: the
 * desktop's ssh forward to it is opened before the box is asked.
 */
export const DEFAULT_BROWSER_VIEW_PORT = 6080;

/**
 * What a launch into a task that is mid-delete throws. Shared because the
 * desktop drops it silently: the delete kills the task's agent, the open panel
 * auto-resumes it, and the engine refuses — expected, not something to show.
 * An error crosses IPC as its message only, so the text is the contract.
 */
export const TASK_REMOVING_ERROR = "This task is being deleted";

/**
 * What browser:view throws on a box where install-browser.sh never ran. The
 * desktop matches it to offer browser:install. Every engine since the Browser
 * panel opens its message with this text, so it also matches an engine too old
 * to install.
 */
export const BROWSER_NOT_INSTALLED_ERROR = "This box has no browser yet";

/** Where the engine's embedded editor (code-server) answers, on ITS machine. */
export interface EditorEndpointDTO {
	port: number;
}

/**
 * editor:open's answer: the endpoint, or "code-server isn't installed here" —
 * a state, not an error, so clients can front the install with a consent dialog
 * instead of parsing an exception.
 */
export type EditorOpenResult = EditorEndpointDTO | { needsInstall: true };

/** Where a box's browser view answers, on ITS machine, and the VNC password. */
export interface BrowserViewDTO {
	port: number;
	password: string;
}

// ---- the API surface exposed on window.ateam ----
export interface AteamApi {
	projects: {
		pick(): Promise<string | null>;
		/** `init: true` runs `git init` + initial commit first (after asking); add
		 *  `createRemote` to give that new repo a GitHub origin at the same time. */
		register(repoPath: string, opts?: RegisterProjectOptions): Promise<ProjectDTO>;
		// NB: projects:remoteRepos is NOT here either, for the same reason as clone:
		// "which engine's gh?" has no answer on a client holding several. The phone
		// holds exactly one box, so it reaches both through its Connection.
		// NB: projects:clone (CH.projectsClone) is deliberately NOT on this surface —
		// it must target a specific box, so it's driven by ateamHost.provision →
		// backend.handle(CH.projectsClone) directly, never the id-routed aggregate.
		/** The project's `origin` remote URL, or null if local-only. Decides whether a
		 *  task can run on a box (needs a remote to clone). id-routed to the owner. */
		remoteUrl(projectId: string): Promise<string | null>;
		/** Uses the client engine's gh login, including repos that run on a box. */
		issues(repository: string, refresh?: boolean): Promise<GithubIssuesDTO>;
		/** Same routing as `issues`: the repository string never names a box. */
		createIssue(repository: string, input: CreateGithubIssueInput): Promise<GithubIssueDTO>;
		list(): Promise<ProjectDTO[]>;
		remove(id: string): Promise<void>;
	};
	tasks: {
		createFromIssue(input: CreateIssueTaskInput): Promise<{ task: TaskDTO; created: boolean }>;
		list(projectId: string): Promise<TaskDTO[]>;
		create(input: {
			projectId: string;
			name: string;
			baseBranch?: string;
			/** The agent chosen in the composer, recorded up front so the card shows it. */
			agentId?: string;
			/**
			 * Nobody typed `name`: the client filled it from the prompt's first words,
			 * so the model's title may replace it once, shortly after launch. An
			 * engine older than v23 ignores it and keeps the name.
			 */
			nameAuto?: boolean;
		}): Promise<TaskDTO>;
		remove(input: { id: string; deleteBranch?: boolean; force?: boolean }): Promise<void>;
		setColumn(id: string, column: KanbanColumn): Promise<TaskDTO>;
		/** Clear the unread flag once the user has actually looked at the task. */
		markRead(id: string): Promise<TaskDTO>;
		/** Park the task on an outside party until a date, or clear it (null). */
		setWaiting(id: string, wait: TaskWait): Promise<TaskDTO>;
		/** Answer the question the task's agent asked (ask_user), or dismiss it
		 *  with null. `questionId` must be the pending one; a stale answer throws. */
		answerQuestion(input: {
			taskId: string;
			questionId: string;
			/** A label or typed text; for a checklist, the ticked labels. */
			answer: string | string[] | null;
			/** The Lead chat passing on the user's answer (see questions.ts). */
			via?: "lead";
		}): Promise<TaskDTO>;
		/** Drop a proposal the task's agent made, once the user created what it
		 *  proposed or dismissed it. A proposal already gone is not an error. */
		clearProposal(input: { taskId: string; proposalId: string }): Promise<TaskDTO>;
		/** Preview which tasks a cleanup would remove vs keep (and why). */
		cleanupPreview(projectId: string): Promise<CleanupReport>;
		/** Worktrees advised for cleanup (idle/finished), with their terminals. */
		cleanupCandidates(projectId: string): Promise<CleanupCandidate[]>;
		/** Remove merged + idle worktrees. Never deletes unmerged/active/dirty. */
		cleanup(projectId: string): Promise<CleanupReport>;
		/** The project's archived tasks, most recently archived first. */
		listArchived(projectId: string): Promise<TaskDTO[]>;
		/** Archive a task (off every list, worktree kept) or bring it back. */
		setArchived(id: string, archived: boolean): Promise<TaskDTO>;
		/** The task's diff told as steps. Asking starts writing new ones when the
		 *  diff moved on; the answer says so (`working`) and the caller asks again. */
		changeSteps(taskId: string): Promise<ChangeStepsDTO>;
	};
	git: {
		commit(taskId: string, message: string): Promise<{ sha: string }>;
		push(taskId: string): Promise<void>;
		update(taskId: string): Promise<UpdateResultDTO>;
		/**
		 * Enqueue a merge. Merges serialize per base branch, so this resolves only
		 * when this task's turn completes — or parks on a conflict/busy/error.
		 */
		merge(taskId: string, strategy: MergeStrategy): Promise<MergeEnqueueDTO>;
		diff(taskId: string): Promise<DiffResultDTO>;
		fileDiff(taskId: string, file: string): Promise<string>;
		status(taskId: string): Promise<GitStatusSnapshot>;
	};
	agents: {
		list(): Promise<AgentDTO[]>;
		/**
		 * Run this agent's official installer on the machine the engine is on, and
		 * report what the machine looks like afterwards. `projectId` only says WHICH
		 * engine (the same routing `loops.create` uses); the install is not scoped
		 * to that project. Resolves once the CLI is on the login PATH, so a caller
		 * can offer it immediately; rejects with the installer's own last words.
		 */
		install(input: { projectId: string; agentId: string }): Promise<InstallAgentDTO>;
	};
	search: {
		/**
		 * Find past agent sessions in this project by describing the work — the
		 * question you would otherwise open a new session to ask. Without `ai`
		 * it is an instant local rank; with it, the configured agent re-ranks
		 * the shortlist and says why each one matched.
		 */
		sessions(input: { projectId: string; query: string; ai?: boolean }): Promise<SessionHitDTO[]>;
	};
	editor: {
		/**
		 * Start (or reuse) the in-app editor for this task's engine and resolve the
		 * URL THIS client should load — tunneled for an SSH box, direct for a
		 * Tailscale endpoint, localhost for the local engine. The page is VS Code
		 * (code-server) on the task's machine; callers append ?folder=<worktree>.
		 */
		open(taskId: string): Promise<{ url: string } | { needsInstall: true }>;
		/**
		 * Install code-server on the task's engine (one-time, user-space, pinned
		 * version). Call only after the user consented to a needsInstall answer.
		 * Resolves when installed; a following open() starts it.
		 */
		install(taskId: string): Promise<void>;
	};
	browser: {
		/**
		 * Resolve the URL of the browser on this task's box: its Chrome's desktop in
		 * noVNC, connected and signed in, for THIS client to load. Rejects with the
		 * reason for a task on this Mac (its browser is your own Chrome) and, with
		 * BROWSER_NOT_INSTALLED_ERROR, for a box with no browser installed.
		 */
		view(taskId: string): Promise<{ url: string }>;
		/**
		 * Install the browser on the task's box (install-browser.sh: apt packages,
		 * Chrome, TaskWindow, noVNC). Call only after the user said yes to a
		 * BROWSER_NOT_INSTALLED_ERROR. Takes minutes; resolves when installed, and a
		 * following view() opens it.
		 */
		install(taskId: string): Promise<void>;
	};
	skills: {
		/**
		 * The skills the agent in this terminal can invoke, most typed first. Read on
		 * the machine the terminal runs on, from that agent's own skill folders, so
		 * a box lists the box's skills. Empty for a shell.
		 */
		list(terminalId: string): Promise<SkillDTO[]>;
		/**
		 * Link a skill folder (or its SKILL.md) into this Mac's agent skill folders
		 * (~/.claude/skills and ~/.agents/skills) as symlinks, so edits at the source
		 * reach every agent. `dryRun` returns the plan without writing. Refuses a
		 * name another skill already holds.
		 */
		link(input: { path: string; dryRun?: boolean }): Promise<SkillLinkResult>;
		/** Native picker for a skill folder or SKILL.md; null when cancelled. */
		pick(): Promise<string | null>;
	};
	fs: {
		/**
		 * Browse a directory on the *engine's* machine (the server, when remote) to
		 * pick a repo — the transport-native replacement for the local folder dialog,
		 * which would browse the wrong machine over SSH. Defaults to the engine's home
		 * dir; entries are subdirectories, each flagged when it holds a `.git`.
		 */
		listDir(path?: string): Promise<DirListingDTO>;
	};
	loops: {
		list(): Promise<LoopDTO[]>;
		setEnabled(id: string, enabled: boolean): Promise<LoopDTO[]>;
		runNow(id: string): Promise<LoopDTO[]>;
		templates(): Promise<LoopTemplateDTO[]>;
		create(input: CreateLoopInput): Promise<LoopDTO[]>;
		update(input: UpdateLoopInput): Promise<LoopDTO[]>;
		remove(id: string): Promise<LoopDTO[]>;
		onUpdated(cb: (loops: LoopDTO[]) => void): () => void;
	};
	pty: {
		spawnAgent(input: {
			taskId: string;
			agentId: string;
			yolo?: boolean;
			resume?: boolean;
			/** Launch the agent's own multi-agent board (e.g. `claude agents`) in the worktree. */
			agentMode?: boolean;
			/** Initial instruction handed to the agent at launch. */
			prompt?: string;
			/** Absolute paths to attach — appended to the prompt for the agent to read. */
			files?: string[];
			/** Those of `files` already on the task's machine (attached in the chat of
			 *  a Lead on that box): the desktop passes them on as they are rather than
			 *  send them there. Never reaches the engine. */
			keepFiles?: string[];
			/** Resume this exact conversation instead of starting a new one. */
			resumeSessionId?: string;
		}): Promise<{ terminalId: string }>;
		spawnShell(input: { taskId: string }): Promise<{ terminalId: string }>;
		/** The box's own shell, in its home folder and outside every project: the one
		 *  already running, else a new one. One per box; it runs until it exits. */
		boxShell(): Promise<{ terminalId: string }>;
		write(terminalId: string, data: string): void;
		resize(terminalId: string, cols: number, rows: number): void;
		kill(terminalId: string): void;
		snapshot(terminalId: string): Promise<PtySnapshot>;
		listForTask(taskId: string): Promise<SessionDTO[]>;
		/** Tabs this task had open when the app last went down, newest first. */
		listRestorable(taskId: string): Promise<SessionDTO[]>;
		/** Bring one of those back — same conversation, new terminal. */
		restoreSession(input: { taskId: string; terminalId: string }): Promise<{ terminalId: string }>;
		onData(cb: (e: PtyDataEvent) => void): () => void;
		onExit(cb: (e: PtyExitEvent) => void): () => void;
	};
	events: {
		/** A task was created or changed — upsert it (add if new, replace if known). */
		onTaskUpdated(cb: (task: TaskDTO) => void): () => void;
		/** A task was removed (delete or cleanup) — drop it from every window. */
		onTaskRemoved(cb: (taskId: string) => void): () => void;
		/**
		 * The app menu's Settings… (⌘,) — show the settings page in this window.
		 * Optional: a client without an app menu (the phone) never receives it.
		 */
		onOpenSettings?(cb: () => void): () => void;
		/**
		 * A notification for this task was clicked (a wait came due): open it.
		 * Optional: only the desktop posts OS notifications from its main process.
		 */
		onOpenTask?(cb: (task: TaskDTO) => void): () => void;
	};
	window: {
		/**
		 * Detach a project into its own OS window (to spread projects across
		 * desktops/Spaces). If a window is already bound to this project it's
		 * focused instead of duplicated.
		 */
		openProject(projectId: string): Promise<void>;
		/**
		 * The project this window is pinned to, or null for the main multi-project
		 * dashboard. Read once at boot from the window's launch URL.
		 */
		boundProjectId(): string | null;
	};
	settings: {
		/** The settings in force on this task's engine's machine. */
		get(): Promise<SettingsResult>;
		/** Patch one or more keys; answers with the full result, like `get`. */
		update(patch: SettingsPatch): Promise<SettingsResult>;
	};
	credentials: {
		/** Which keys are set on the engine's machine; never the keys themselves. */
		get(): Promise<CredentialsResult>;
		/** Store or remove a key; answers like `get`. */
		update(patch: CredentialsPatch): Promise<CredentialsResult>;
	};
	/** GitHub access on the engine's machine (v25). The token never travels back. */
	githubAccess: {
		/** Which credential gh and git use there, its kind and whose it is. */
		status(): Promise<GithubAccessDTO>;
		/**
		 * Check a token with GitHub, hand it to gh on stdin, let git use it, and
		 * answer the new status. Rejects with a sentence a person can act on.
		 */
		connect(token: string): Promise<GithubAccessDTO>;
		/**
		 * Per repository (`owner/name`): can this machine push, only read, or not see
		 * it? With none given, the engine's own projects.
		 */
		check(repos?: string[]): Promise<RepoAccessDTO[]>;
	};
	utils: {
		/**
		 * Absolute filesystem path for a File from a drop or paste (Electron
		 * webUtils). Returns "" for a File with no backing path — e.g. a raw
		 * clipboard bitmap (screenshot) Chromium synthesizes into a File.
		 */
		pathForFile(file: File): string;
		/** Native open dialog; resolves to the chosen paths ([] on cancel). */
		pickFiles(): Promise<string[]>;
		/**
		 * Attach image files to the terminal's agent, wherever that agent runs.
		 * `paths` are client-local image files (from a drop/paste); null opens a
		 * multi-select image picker instead. The host decides the delivery: for a
		 * local agent one image is staged on the clipboard as a real bitmap
		 * ("ctrlv" — the caller forwards a Ctrl+V so the agent reads pixels, not a
		 * Finder file-icon), while several images — or an agent on a box, which
		 * can't see this machine's clipboard or files — come back as "paths" for
		 * the caller to TYPE into the PTY (box-side temp paths when remote).
		 */
		attachImages(terminalId: string, paths: string[] | null): Promise<AttachDelivery>;
		/**
		 * Attach the raw bitmap currently on the client's clipboard (a copied
		 * screenshot — no backing file). Local agents read the clipboard themselves
		 * ("ctrlv"); for an agent on a box the bitmap is shipped over and comes
		 * back as a box-side path to type. "none" when the clipboard has no image.
		 */
		attachClipboardImage(terminalId: string): Promise<AttachDelivery>;
		/**
		 * Write raw image bytes (base64) to a temp file on the *engine's* machine and
		 * return its absolute path. The remote counterpart of clipboard staging: a
		 * headless server has no GUI clipboard, so an attached/pasted image is handed
		 * to the agent as a file path (typed into the PTY or appended to its prompt)
		 * instead of a bitmap on the clipboard. `ext` sets the extension (default "png").
		 */
		writeImageBytes(base64: string, ext?: string): Promise<string>;
		/**
		 * Open a task's worktree in the user's own editor, on THIS machine. Client-native
		 * (the editor is a desktop app, not something the engine can launch), so it never
		 * routes to the engine: a task on a box is opened over VS Code's Remote-SSH using
		 * the same ssh_config alias Ateam connects with. Optional — a client with no
		 * desktop editor to hand off to (the phone) simply omits it, and callers hide the
		 * affordance rather than offering one that can't work.
		 */
		openInEditor?(worktreePath: string, alias: string | null): Promise<OpenInEditorResult>;
		/**
		 * Bring up the browser the agents drive — the user's OWN Chrome, on THIS
		 * machine, so every session it holds is already signed in and the agent
		 * never faces a login wall. Client-native for the same reason
		 * `openInEditor` is: a browser is a desktop app, not something the engine
		 * can launch, and unlike the editor there is no Remote-SSH equivalent —
		 * a task on a box needs a browser ON the box (`browser.view`), so that
		 * case reports a reason instead of silently raising this Mac's.
		 */
		openBrowser?(alias: string | null): Promise<OpenBrowserResult>;
	};
}

// Routing one board across several engines (the desktop's Mac + boxes, the phone's boxes).
export {
	type Aggregate,
	type AggregateBackend,
	candidateId,
	createAggregate,
} from "./aggregate";
// A box's board as last seen, served while the box isn't held.
export {
	asSnapshot,
	type BoxSnapshot,
	OFFLINE_ERROR,
	offlineHandle,
	takeSnapshot,
} from "./board-snapshot";
// The URL every client loads for a box's browser view (noVNC).
export { browserViewUrl } from "./browser-view";
export type { NativeClientApi } from "./client-api";
// Client-side binding of the AteamApi surface over an RpcClient.
export {
	buildAteamApi,
	leadClient,
	linksClient,
	pairingClient,
	requestBoxUpdate,
	serverHandshake,
} from "./client-api";
// WebSocket ClientTransport over the platform-global WebSocket (browser / RN / Bun).
export {
	activeLabel,
	beginStep,
	type ConnectStep,
	failActive,
	RECONNECT_DELAYS_MS,
	reconnectDelay,
	relabelActive,
	type StepStatus,
	WOKEN_CONNECT_MS,
	WOKEN_RETRY_GAP_MS,
	waitingLabel,
} from "./connect-steps";
// GitHub access on a box (v25): its DTOs and the wording both clients share.
export * from "./github-access";
// The Lead chat: its items and events, the desktop's IPC channels and the
// engine's RPC for a box's own Lead (v24).
export * from "./lead";
export * from "./lead-view";
// Box providers as data: what a client asks the user for to wake a sleeping box.
export {
	PROVIDERS,
	type ProviderDefinition,
	type ProviderInput,
	providerById,
} from "./providers";
// How recently a task last changed, for the board and the Lead's get_board.
export { byLatestActivity, relativeAge } from "./recency";
// Transport-agnostic RPC framing + client (shared by every transport).
export * from "./rpc";
// Derived task tags (pure), shared by every client; icons are per-client.
export {
	MAX_TAGS,
	matchesTagQuery,
	TASK_TAG_RULES,
	type TaskTagRule,
	tagsFor,
	taskTag,
	taskTags,
} from "./task-tags";
// A cap for a promise that can't be left to wait forever (an RPC has none of its own).
export {
	type BoxProvider,
	buildCloudInit,
	type CreatedServer,
	type CreateServerInput,
	HETZNER_LOCATIONS,
	HETZNER_SIZES,
	hetznerProvider,
	INSTALL_SH_URL,
	orderableServerTypes,
	type ProviderOptions,
} from "./provision";
export { withTimeout } from "./timeout";
// Reading an engine older than this client (the version gate is advisory now).
export { NO_TRIAGE, tolerantRpc } from "./tolerate";
// One card per repo across engines (the same GitHub repo on two machines).
export {
	type Alias,
	aliasLabel,
	type EngineMember,
	type UnifiedProject,
	unifyProjects,
} from "./unify";
export {
	filled,
	type InputValues,
	inputsAt,
	reportedWake,
	WAKE_PROVIDERS,
	type WakeAdapter,
	wakeAdapter,
	wakeMachineName,
} from "./wake";
export type { WsClient } from "./ws";
export { wsClientTransport } from "./ws";
