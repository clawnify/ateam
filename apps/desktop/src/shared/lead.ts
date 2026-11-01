// The Lead chat's renderer↔main contract: one conversation with a coordinator
// agent that drives every task on every engine (see main/lead). Its own surface,
// beside window.ateam (one engine's API) and window.ateamHost (choosing
// engines), because the Lead belongs to the desktop, not to any engine.
// Imports nothing, so both the node and web tsconfigs resolve it.

export const LEAD_CH = {
	/** The conversation so far, plus whether a turn is running. */
	snapshot: "lead:snapshot",
	/** Send the user's message (starts the agent on first use). */
	send: "lead:send",
	/** Interrupt the running turn; the conversation stays. */
	interrupt: "lead:interrupt",
	/** Start a new conversation (the old one is archived, not deleted). */
	reset: "lead:reset",
	/** The user replies to a task's agent from the chat (not through the Lead model). */
	reply: "lead:reply",
	/** The user answers a task's question from the chat; the task is then followed. */
	answer: "lead:answer",
	/** The user answers the Lead's own permission prompt (its agent wants a tool). */
	permission: "lead:permission",
	/** Attach files from this Mac (paths, or null for the picker) to the next message. */
	attach: "lead:attach",
	/** Attach a file that has no path here: a pasted screenshot, an image dragged from a page. */
	attachBytes: "lead:attachBytes",
	/** A small preview of an attached image, as a data: URL (the window's CSP allows no files). */
	thumb: "lead:thumb",
	/** The user created or dismissed a task or loop the Lead proposed. */
	proposal: "lead:proposal",
	evtEvent: "evt:lead:event",
} as const;

/** How the Lead links a task in its replies, `[fix login](task:<id>)` (its
 *  prompt says so): the chat draws the link as a chip that opens the task. */
export const TASK_LINK_SCHEME = "task:";

/** A task named in the chat: enough to label it and open it. */
export interface LeadTaskRef {
	taskId: string;
	name: string;
	agentId: string | null;
}

/** A file the user attached in the chat: a copy in the Lead's folder on this Mac. */
export interface LeadFile {
	path: string;
	name: string;
	size: number;
	/** Shown as a thumbnail rather than a chip. */
	image: boolean;
}

/** What attaching gave: the files kept, and why any others were not. */
export interface LeadAttachResult {
	files: LeadFile[];
	failed: string[];
}

/** How the user answered the Lead's permission prompt. */
export type LeadPermissionAnswer = "allow" | "always" | "deny";

/** A task or loop the Lead proposes (propose_task, propose_loop): the fields
 *  of an agent's proposal (TaskProposalDTO), checked by the same rules. */
export interface LeadProposal {
	kind: "task" | "loop";
	name: string;
	prompt: string;
	reason?: string;
	agentId?: string;
	/** Only a suggestion: the dialog shows it and leaves Auto mode off. */
	yolo?: boolean;
	everyMinutes?: number;
	dailyAt?: string;
	followUp?: string;
}

/** What became of a proposal: created from its dialog, dismissed, or
 *  replaced by a later proposal of the same name. */
export type LeadProposalOutcome = "created" | "dismissed" | "replaced";

/** One rendered entry in the chat. A tool entry is updated in place when its result lands. */
export type LeadItem =
	/** The user's words; `to` when they went to a task's agent, not to the Lead. */
	| { kind: "user"; id: string; text: string; at: number; to?: LeadTaskRef; files?: LeadFile[] }
	/** A followed task's agent finished a turn: its reply, shown to the user only
	 *  (never fed to the Lead's model, so following costs nothing). */
	| { kind: "agent"; id: string; task: LeadTaskRef; text: string; at: number }
	/** A followed task's agent showed the user a page (show_page): drawn in the
	 *  thread from the task, so a page replaced since says so. */
	| { kind: "page"; id: string; task: LeadTaskRef; pageId: string; title: string; at: number }
	| { kind: "assistant"; id: string; text: string; at: number }
	| {
			kind: "tool";
			id: string;
			/** The tool's short name, without the mcp__ateam_lead__ prefix. */
			name: string;
			input: Record<string, unknown>;
			/** Absent while the call runs. */
			result?: string;
			isError?: boolean;
			at: number;
	  }
	/** The Lead's agent asks before using a tool, as the user's permission
	 *  settings say it must. Nobody watches its terminal, so it is answered here.
	 *  `answer` is absent while it waits, and "cancelled" once the turn stopped
	 *  or the agent went away. */
	| {
			kind: "permission";
			id: string;
			/** What it wants to do, in markdown (the same words as a task's card). */
			text: string;
			/** Claude offers a rule for "Always allow"; kept in the Lead's own settings. */
			canAlways: boolean;
			/** That rule, like "Bash(npm test *)", when there is one. */
			always: string | null;
			answer?: LeadPermissionAnswer | "cancelled";
			at: number;
	  }
	/** A task or loop the Lead proposes. Nothing exists until the user creates
	 *  it from the New task or New loop dialog, filled in from this. The Lead's
	 *  agent is not told the outcome; the chat shows it. */
	| {
			kind: "proposal";
			id: string;
			/** The project it is for, and its name when proposed. */
			projectId: string;
			projectName: string;
			proposal: LeadProposal;
			/** Files attached in this chat, to start the task with. */
			files?: string[];
			/** Absent while it waits on the user. */
			outcome?: LeadProposalOutcome;
			/** The task created from it, when it was a task. */
			task?: LeadTaskRef;
			at: number;
	  }
	/** Something about the conversation itself: stopped, failed, restarted. */
	| {
			kind: "notice";
			id: string;
			text: string;
			tone: "info" | "error";
			at: number;
			/** The task it is about, when it is about one: the chat offers to open it. */
			task?: LeadTaskRef;
	  };

export interface LeadSnapshot {
	items: LeadItem[];
	/** The assistant text streaming in for the current turn, not yet an item. */
	draft: string;
	/** A turn is running. */
	busy: boolean;
}

/** What main pushes as the conversation moves. `item` adds or replaces by id. */
export type LeadEvent =
	| { type: "item"; item: LeadItem }
	| { type: "draft"; text: string }
	| { type: "busy"; busy: boolean }
	| { type: "reset"; snapshot: LeadSnapshot };

/** window.ateamLead. */
export interface AteamLead {
	snapshot(): Promise<LeadSnapshot>;
	/** `files`: paths of files attached in this chat (from attach or attachBytes). */
	send(text: string, files?: string[]): Promise<void>;
	attach(paths: string[] | null): Promise<LeadAttachResult>;
	attachBytes(name: string, data: Uint8Array): Promise<LeadFile>;
	thumb(path: string): Promise<string | null>;
	interrupt(): Promise<void>;
	reset(): Promise<void>;
	reply(taskId: string, text: string): Promise<void>;
	answer(input: {
		taskId: string;
		questionId: string;
		answer: string | string[] | null;
	}): Promise<void>;
	permission(id: string, answer: LeadPermissionAnswer): Promise<void>;
	/** The user created (`taskId` when it was a task) or dismissed a proposal. */
	proposal(id: string, outcome: "created" | "dismissed", taskId?: string): Promise<void>;
	onEvent(cb: (e: LeadEvent) => void): () => void;
}
